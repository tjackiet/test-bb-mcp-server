import getFlowMetrics from './get_flow_metrics.js';
import getVolatilityMetrics from './get_volatility_metrics.js';
import getIndicators from './get_indicators.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { AnalyzeMarketSignalOutputSchema } from '../src/schemas.js';

type AnalyzeOpts = {
  type?: string;
  flowLimit?: number;
  bucketMs?: number;
  windows?: number[];
  horizonBuckets?: number;
};

function clamp(x: number, min: number, max: number) { return Math.max(min, Math.min(max, x)); }

export default async function analyzeMarketSignal(
  pair: string = 'btc_jpy',
  opts: AnalyzeOpts = {}
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return AnalyzeMarketSignalOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  const type = opts.type || '1day';
  const flowLimit = Math.max(50, Math.min(opts.flowLimit ?? 300, 2000));
  const bucketMs = Math.max(1_000, Math.min(opts.bucketMs ?? 60_000, 3_600_000));
  const windows = (opts.windows && opts.windows.length ? opts.windows : [14, 20, 30]).slice(0, 3);
  const horizon = Math.max(5, Math.min(opts.horizonBuckets ?? 10, 100));

  try {
    const [flowRes, volRes, indRes] = await Promise.all([
      getFlowMetrics(chk.pair, flowLimit, undefined as any, bucketMs) as any,
      getVolatilityMetrics(chk.pair, type, 200, windows, { annualize: true }) as any,
      // SMA25/75/200 を扱うため十分な本数を取得（最低200+バッファ）
      getIndicators(chk.pair, type, 220) as any,
    ]);

    if (!flowRes?.ok) return AnalyzeMarketSignalOutputSchema.parse(fail(flowRes?.summary || 'flow failed', (flowRes?.meta as any)?.errorType || 'internal')) as any;
    if (!volRes?.ok) return AnalyzeMarketSignalOutputSchema.parse(fail(volRes?.summary || 'vol failed', (volRes?.meta as any)?.errorType || 'internal')) as any;
    if (!indRes?.ok) return AnalyzeMarketSignalOutputSchema.parse(fail(indRes?.summary || 'indicators failed', (indRes?.meta as any)?.errorType || 'internal')) as any;

    // Flow metrics
    const agg = flowRes.data.aggregates || {};
    const buckets = (flowRes.data.series?.buckets || []) as Array<{ cvd: number }>;
    const cvdSeries = buckets.map(b => b.cvd);
    const cvdSlice = cvdSeries.slice(-horizon);
    const cvdSlope = cvdSlice.length >= 2 ? (cvdSlice[cvdSlice.length - 1] - cvdSlice[0]) : 0;
    const cvdNormBase = Math.max(1, Math.max(...cvdSlice.map(v => Math.abs(v))) || 1);
    const cvdTrend = clamp(cvdSlope / cvdNormBase, -1, 1);
    const buyRatio = typeof agg.aggressorRatio === 'number' ? agg.aggressorRatio : 0.5;
    const buyPressure = clamp((buyRatio - 0.5) * 2, -1, 1);

    // Volatility
    const rv = volRes?.data?.aggregates?.rv_std_ann ?? volRes?.data?.aggregates?.rv_std;
    const rvNum = typeof rv === 'number' ? rv : 0.5; // typical range ~0.2-0.8
    const volatilityFactor = clamp((0.5 - rvNum) / 0.5, -1, 1); // 低ボラほど +

    // Indicators
    const rsi = indRes?.data?.indicators?.RSI_14 as number | null;
    const momentumFactor = rsi == null ? 0 : clamp(((rsi - 50) / 50), -1, 1);
    // SMA trend factor: price vs SMA25/75 alignment and distance to SMA200
    const latestClose = indRes?.data?.normalized?.at(-1)?.close as number | undefined;
    const sma25 = indRes?.data?.indicators?.SMA_25 as number | null | undefined;
    const sma75 = indRes?.data?.indicators?.SMA_75 as number | null | undefined;
    const sma200 = indRes?.data?.indicators?.SMA_200 as number | null | undefined;
    let smaTrendFactor = 0;
    if (latestClose != null && sma25 != null && sma75 != null) {
      // alignment bonus
      const alignedUp = latestClose > sma25 && (sma25 as number) > (sma75 as number);
      const alignedDown = latestClose < sma25 && (sma25 as number) < (sma75 as number);
      if (alignedUp) smaTrendFactor += 0.6; else if (alignedDown) smaTrendFactor -= 0.6;
      // distance to SMA200 (above -> positive, below -> negative), normalized by 5% band
      if (sma200 != null) {
        const dist = (latestClose - (sma200 as number)) / (sma200 as number);
        smaTrendFactor += clamp(dist / 0.05, -0.4, 0.4);
      }
      smaTrendFactor = clamp(smaTrendFactor, -1, 1);
    }

    // Composite score
    const weights = { buyPressure: 0.35, cvdTrend: 0.25, momentum: 0.15, volatility: 0.1, smaTrend: 0.15 } as const;
    const contribution_buy = buyPressure * weights.buyPressure;
    const contribution_cvd = cvdTrend * weights.cvdTrend;
    const contribution_mom = momentumFactor * weights.momentum;
    const contribution_vol = volatilityFactor * weights.volatility;
    const contribution_sma = smaTrendFactor * weights.smaTrend;
    const score = Number((
      contribution_buy +
      contribution_cvd +
      contribution_mom +
      contribution_vol +
      contribution_sma
    ).toFixed(3));

    const recommendation = score >= 0.25 ? 'bullish' : score <= -0.25 ? 'bearish' : 'neutral';
    const tags: string[] = [];
    if (buyPressure > 0.2) tags.push('buy_pressure');
    if (cvdTrend > 0.2) tags.push('positive_cvd');
    if (volatilityFactor > 0.2) tags.push('low_vol');
    if (rsi != null && rsi < 35) tags.push('oversold_bias');
    if (rsi != null && rsi > 65) tags.push('overbought_risk');

    // compact contributions summary (top 2 by absolute value)
    const contribPairs: Array<[string, number]> = [
      ['buy', contribution_buy],
      ['cvd', contribution_cvd],
      ['sma', contribution_sma],
      ['mom', contribution_mom],
      ['vol', contribution_vol],
    ];
    const top2 = contribPairs
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 2)
      .map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${Number(v.toFixed(2))}`)
      .join(', ');

    const summary = formatSummary({
      pair: chk.pair,
      latest: indRes?.data?.normalized?.at(-1)?.close,
      extra: `score=${score} rec=${recommendation} (top: ${top2})`,
    });

    const data = {
      score,
      recommendation,
      tags,
      formula: 'score = 0.35*buyPressure + 0.25*cvdTrend + 0.15*momentum + 0.10*volatility + 0.15*smaTrend',
      weights: { buyPressure: 0.35, cvdTrend: 0.25, momentum: 0.15, volatility: 0.10, smaTrend: 0.15 },
      contributions: {
        buyPressure: Number(contribution_buy.toFixed(3)),
        cvdTrend: Number(contribution_cvd.toFixed(3)),
        momentum: Number(contribution_mom.toFixed(3)),
        volatility: Number(contribution_vol.toFixed(3)),
        smaTrend: Number(contribution_sma.toFixed(3)),
      },
      breakdown: {
        buyPressure: { rawValue: Number(buyPressure.toFixed(3)), weight: 0.35, contribution: Number(contribution_buy.toFixed(3)), interpretation: buyPressure >= 0.4 ? 'strong' : buyPressure >= 0.15 ? 'moderate' : buyPressure <= -0.15 ? 'weak' : 'neutral' },
        cvdTrend: { rawValue: Number(cvdTrend.toFixed(3)), weight: 0.25, contribution: Number(contribution_cvd.toFixed(3)), interpretation: cvdTrend >= 0.4 ? 'strong' : cvdTrend >= 0.15 ? 'moderate' : cvdTrend <= -0.15 ? 'weak' : 'neutral' },
        momentum: { rawValue: Number(momentumFactor.toFixed(3)), weight: 0.15, contribution: Number(contribution_mom.toFixed(3)), interpretation: momentumFactor >= 0.35 ? 'strong' : momentumFactor >= 0.1 ? 'moderate' : momentumFactor <= -0.1 ? 'weak' : 'neutral' },
        volatility: { rawValue: Number(volatilityFactor.toFixed(3)), weight: 0.10, contribution: Number(contribution_vol.toFixed(3)), interpretation: volatilityFactor >= 0.35 ? 'strong' : volatilityFactor >= 0.1 ? 'moderate' : volatilityFactor <= -0.1 ? 'weak' : 'neutral' },
        smaTrend: { rawValue: Number(smaTrendFactor.toFixed(3)), weight: 0.15, contribution: Number(contribution_sma.toFixed(3)), interpretation: smaTrendFactor >= 0.35 ? 'strong' : smaTrendFactor >= 0.1 ? 'moderate' : smaTrendFactor <= -0.1 ? 'weak' : 'neutral' },
      },
      topContributors: ['buyPressure', 'cvdTrend', 'smaTrend', 'momentum', 'volatility']
        .map((k) => [k, { buyPressure: contribution_buy, cvdTrend: contribution_cvd, smaTrend: contribution_sma, momentum: contribution_mom, volatility: contribution_vol }[k as 'buyPressure'] as number])
        .sort((a, b) => Math.abs((b[1] as number)) - Math.abs((a[1] as number)))
        .slice(0, 2)
        .map((x) => x[0]) as Array<'buyPressure' | 'cvdTrend' | 'momentum' | 'volatility' | 'smaTrend'>,
      thresholds: { bullish: 0.25, bearish: -0.25 },
      metrics: {
        buyPressure,
        cvdTrend,
        momentumFactor,
        volatilityFactor,
        smaTrendFactor,
        rsi: rsi ?? null,
        rv_std_ann: rvNum,
        aggressorRatio: buyRatio,
        cvdSlope,
        horizon,
      },
      refs: {
        flow: { aggregates: flowRes.data.aggregates, lastBuckets: buckets.slice(-Math.min(5, buckets.length)) },
        volatility: { aggregates: volRes.data.aggregates },
        indicators: { latest: indRes.data.indicators, trend: indRes.data.trend },
      },
    };

    const meta = createMeta(chk.pair, { type, windows, bucketMs, flowLimit });
    return AnalyzeMarketSignalOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: any) {
    return AnalyzeMarketSignalOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


