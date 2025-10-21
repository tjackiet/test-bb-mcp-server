import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { AnalyzeBbSnapshotOutputSchema } from '../src/schemas.js';

export default async function analyzeBbSnapshot(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 120,
  mode: 'default' | 'extended' = 'default'
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return AnalyzeBbSnapshotOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;
  try {
    const indRes: any = await getIndicators(chk.pair, type as any, Math.max(60, limit));
    if (!indRes?.ok) return AnalyzeBbSnapshotOutputSchema.parse(fail(indRes?.summary || 'indicators failed', (indRes?.meta as any)?.errorType || 'internal')) as any;

    const close = indRes.data.normalized.at(-1)?.close ?? null;
    const mid = indRes.data.indicators.BB2_middle ?? indRes.data.indicators.BB_middle ?? null;
    const upper = indRes.data.indicators.BB2_upper ?? indRes.data.indicators.BB_upper ?? null;
    const lower = indRes.data.indicators.BB2_lower ?? indRes.data.indicators.BB_lower ?? null;

    let zScore: number | null = null;
    if (close != null && mid != null && upper != null && lower != null) {
      const halfWidth = (upper - lower) / 2;
      if (halfWidth > 0) zScore = (close - mid) / halfWidth;
    }
    let bandWidthPct: number | null = null;
    if (upper != null && lower != null && mid != null && mid !== 0) bandWidthPct = ((upper - lower) / mid) * 100;

    const tags: string[] = [];
    if (zScore != null && zScore > 1) tags.push('above_upper_band_risk');
    if (zScore != null && zScore < -1) tags.push('below_lower_band_risk');

    const summary = formatSummary({ pair: chk.pair, latest: close ?? undefined, extra: `z=${zScore?.toFixed(2) ?? 'n/a'} bw=${bandWidthPct?.toFixed(2) ?? 'n/a'}%` });
    const data = { latest: { close, middle: mid, upper, lower }, zScore: zScore ?? null, bandWidthPct: bandWidthPct ?? null, tags };
    const meta = createMeta(chk.pair, { type, count: indRes.data.normalized.length, mode });
    return AnalyzeBbSnapshotOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: any) {
    return AnalyzeBbSnapshotOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


