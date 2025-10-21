import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { AnalyzeIchimokuSnapshotOutputSchema } from '../src/schemas.js';

export default async function analyzeIchimokuSnapshot(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 120
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return AnalyzeIchimokuSnapshotOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  try {
    const indRes: any = await getIndicators(chk.pair, type as any, Math.max(100, limit));
    if (!indRes?.ok) return AnalyzeIchimokuSnapshotOutputSchema.parse(fail(indRes?.summary || 'indicators failed', (indRes?.meta as any)?.errorType || 'internal')) as any;

    const latest = indRes.data.indicators;
    const close = indRes.data.normalized.at(-1)?.close ?? null;
    const tenkan = latest.ICHIMOKU_conversion ?? null;
    const kijun = latest.ICHIMOKU_base ?? null;
    const spanA = latest.ICHIMOKU_spanA ?? null;
    const spanB = latest.ICHIMOKU_spanB ?? null;

    const cloudTop = spanA != null && spanB != null ? Math.max(spanA, spanB) : null;
    const cloudBottom = spanA != null && spanB != null ? Math.min(spanA, spanB) : null;

    // Assessments without visual claims
    let pricePosition: 'above_cloud' | 'in_cloud' | 'below_cloud' | 'unknown' = 'unknown';
    if (close != null && cloudTop != null && cloudBottom != null) {
      if (close > cloudTop) pricePosition = 'above_cloud';
      else if (close < cloudBottom) pricePosition = 'below_cloud';
      else pricePosition = 'in_cloud';
    }

    let tenkanKijun: 'bullish' | 'bearish' | 'neutral' | 'unknown' = 'unknown';
    if (tenkan != null && kijun != null) {
      if (tenkan > kijun) tenkanKijun = 'bullish';
      else if (tenkan < kijun) tenkanKijun = 'bearish';
      else tenkanKijun = 'neutral';
    }

    // Slope of cloud via last two spanA/spanB points when available
    let cloudSlope: 'rising' | 'falling' | 'flat' | 'unknown' = 'unknown';
    const series = indRes.data.indicators.ichi_series;
    if (series && Array.isArray(series.spanA) && Array.isArray(series.spanB)) {
      const a1 = series.spanA.at(-1), a2 = series.spanA.at(-2);
      const b1 = series.spanB.at(-1), b2 = series.spanB.at(-2);
      if (a1 != null && a2 != null && b1 != null && b2 != null) {
        const d = (a1 as number - (a2 as number)) + (b1 as number - (b2 as number));
        if (Math.abs(d) < 1e-6) cloudSlope = 'flat';
        else cloudSlope = d > 0 ? 'rising' : 'falling';
      }
    }

    const tags: string[] = [];
    if (pricePosition === 'above_cloud') tags.push('price_above_cloud');
    if (pricePosition === 'below_cloud') tags.push('price_below_cloud');
    if (tenkanKijun === 'bullish') tags.push('tk_bullish');
    if (tenkanKijun === 'bearish') tags.push('tk_bearish');
    if (cloudSlope === 'rising') tags.push('cloud_rising');
    if (cloudSlope === 'falling') tags.push('cloud_falling');

    const summary = formatSummary({
      pair: chk.pair,
      latest: close ?? undefined,
      extra: `pos=${pricePosition} tk=${tenkanKijun} cloud=${cloudSlope}`,
    });

    const data = {
      latest: { close, tenkan, kijun, spanA, spanB, cloudTop, cloudBottom },
      assessment: { pricePosition, tenkanKijun, cloudSlope },
      tags,
    };

    const meta = createMeta(chk.pair, { type, count: indRes.data.normalized.length });
    return AnalyzeIchimokuSnapshotOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: any) {
    return AnalyzeIchimokuSnapshotOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


