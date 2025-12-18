import analyzeIndicators from './analyze_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { getErrorMessage } from '../lib/error.js';
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
    const indRes = await analyzeIndicators(chk.pair, type, Math.max(60, limit));
    if (!indRes?.ok) return AnalyzeBbSnapshotOutputSchema.parse(fail(indRes?.summary || 'indicators failed', (indRes?.meta as { errorType?: string })?.errorType || 'internal')) as ReturnType<typeof fail>;

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

    const summaryBase = formatSummary({ pair: chk.pair, latest: close ?? undefined, extra: `z=${zScore?.toFixed(2) ?? 'n/a'} bw=${bandWidthPct?.toFixed(2) ?? 'n/a'}%` });
    // Build helper timeseries (last 30)
    const candles = indRes?.data?.normalized as Array<{ isoTime?: string; close: number }> | undefined;
    const bbSeries = (indRes?.data?.indicators as { bb2_series?: { upper: number[]; middle: number[]; lower: number[] } })?.bb2_series;
    const timeseries = (() => {
      try {
        if (!candles || !bbSeries) return null;
        const n = Math.min(30, candles.length, bbSeries.middle.length, bbSeries.upper.length, bbSeries.lower.length);
        const arr: Array<{ time: string; zScore: number | null; bandWidthPct: number | null }> = [];
        for (let i = n; i >= 1; i--) {
          const idx = candles.length - i;
          const t = candles[idx]?.isoTime || '';
          const m = bbSeries.middle[idx];
          const u = bbSeries.upper[idx];
          const l = bbSeries.lower[idx];
          const c = candles[idx]?.close;
          const half = (u - l) / 2;
          const z = m != null && half > 0 ? (c - m) / half : null;
          const bw = m ? ((u - l) / m) * 100 : null;
          arr.push({ time: t, zScore: z == null ? null : Number(z.toFixed(2)), bandWidthPct: bw == null ? null : Number(bw.toFixed(2)) });
        }
        return arr;
      } catch { return null; }
    })();

    if (mode === 'default') {
      const position = zScore == null ? null : (Math.abs(zScore) < 0.3 ? 'near_middle' : (zScore >= 1.8 ? 'at_upper' : (zScore <= -1.8 ? 'at_lower' : (zScore > 0 ? 'upper_zone' : 'lower_zone'))));
      const bw = bandWidthPct ?? 0;
      const bandwidth_state = bw <= 8 ? 'squeeze' : (bw <= 18 ? 'normal' : (bw <= 30 ? 'expanding' : 'wide'));
      // 統計情報の計算（過去30本のバンド幅から）
      const context = (() => {
        if (!timeseries || timeseries.length === 0 || bandWidthPct == null) {
          return {
            bandWidthPct_30d_avg: null as number | null,
            bandWidthPct_percentile: null as number | null,
            current_vs_avg: null as string | null,
          };
        }

        const bandWidths = timeseries
          .map(t => t.bandWidthPct)
          .filter((bw): bw is number => bw != null);

        if (bandWidths.length === 0) {
          return {
            bandWidthPct_30d_avg: null as number | null,
            bandWidthPct_percentile: null as number | null,
            current_vs_avg: null as string | null,
          };
        }

        const avg = bandWidths.reduce((a, b) => a + b, 0) / bandWidths.length;
        const sorted = [...bandWidths].sort((a, b) => a - b);
        const below = sorted.filter(bw => bw <= (bandWidthPct as number)).length;
        const percentile = Math.round((below / sorted.length) * 100);
        const diffPct = ((bandWidthPct as number) - avg) / avg * 100;
        const current_vs_avg = `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;

        return {
          bandWidthPct_30d_avg: Number(avg.toFixed(2)),
          bandWidthPct_percentile: percentile,
          current_vs_avg,
        };
      })();

      // ボラティリティトレンドの判定（直近5本 vs それ以前）
      const volatility_trend = (() => {
        if (!timeseries || timeseries.length < 10) return 'stable' as const;
        const recent5 = timeseries.slice(-5).map(t => t.bandWidthPct).filter((bw): bw is number => bw != null);
        const prev5 = timeseries.slice(-10, -5).map(t => t.bandWidthPct).filter((bw): bw is number => bw != null);
        if (recent5.length === 0 || prev5.length === 0) return 'stable' as const;
        const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
        const prevAvg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
        const change = (recentAvg - prevAvg) / prevAvg;
        if (change > 0.1) return 'increasing' as const;
        if (change < -0.1) return 'decreasing' as const;
        return 'stable' as const;
      })();

      const interpretation = { position, bandwidth_state, volatility_trend } as const;

      const signals: string[] = [];
      if (position === 'near_middle') signals.push('Price consolidating near middle band');
      if (bandwidth_state === 'normal') signals.push('Band width around typical levels');

      // 統計情報を使った追加シグナル
      if (context.bandWidthPct_30d_avg != null && context.current_vs_avg != null) {
        if (context.bandWidthPct_percentile != null) {
          if (context.bandWidthPct_percentile < 20) {
            signals.push(`Band width compressed (${context.bandWidthPct_percentile}th percentile) - potential breakout setup`);
          } else if (context.bandWidthPct_percentile > 80) {
            signals.push(`Band width expanded (${context.bandWidthPct_percentile}th percentile) - high volatility phase`);
          }
        }
        signals.push(`Band width ${context.current_vs_avg} vs 30-day average`);
      }

      if (volatility_trend === 'increasing') {
        signals.push('Volatility increasing in recent periods');
      } else if (volatility_trend === 'decreasing') {
        signals.push('Volatility decreasing - potential squeeze forming');
      }

      if (!signals.length) signals.push('No extreme positioning detected');
      const next_steps = {
        if_need_detail: "Use mode='extended' for ±1σ/±3σ analysis",
        if_need_visualization: 'Use render_chart_svg with withBB=true',
        if_extreme_detected: 'Consider get_volatility_metrics for deeper analysis',
      };
      const data = { mode, price: close ?? null, bb: { middle: mid, upper, lower, zScore, bandWidthPct }, interpretation, context, signals, next_steps } as any;
      // content 強化用: LLM が本文だけ見ても要点が掴めるように複数行の要約を生成
      const summaryLines = [
        String(summaryBase),
        '',
        `Position: ${interpretation.position ?? 'n/a'}`,
        `Band State: ${interpretation.bandwidth_state ?? 'n/a'}`,
        `Volatility Trend: ${interpretation.volatility_trend ?? 'n/a'}`,
        ...(context.bandWidthPct_percentile != null ? [
          `Band Width Percentile: ${context.bandWidthPct_percentile}th (${context.current_vs_avg} vs avg)`
        ] : []),
        '',
        'Signals:',
        ...(signals && signals.length ? signals.map((s) => `- ${s}`) : ['- None']),
        '',
        'Next Steps:',
        `- ${next_steps.if_need_detail}`,
        `- ${next_steps.if_need_visualization}`,
      ].join('\n');
      const meta = createMeta(chk.pair, { type, count: indRes.data.normalized.length, mode, extra: { timeseries: timeseries ? { last_30_candles: timeseries } : undefined, metadata: { calculation_params: { period: 20, std_dev_multiplier: 2 }, data_quality: 'complete', last_updated: new Date().toISOString() } } });
      return AnalyzeBbSnapshotOutputSchema.parse(ok(summaryLines, data, meta as any)) as any;
    }

    // extended mode
    const bbBands: any = { '+3σ': null, '+2σ': upper, '+1σ': null, '-1σ': null, '-2σ': lower, '-3σ': null };
    const bandWidthAll: any = { '±1σ': null, '±2σ': bandWidthPct, '±3σ': null };
    const current_zone = zScore == null ? null : (Math.abs(zScore) <= 1 ? 'within_1σ' : (Math.abs(zScore) <= 2 ? '1σ_to_2σ' : (Math.abs(zScore) <= 3 ? 'beyond_2σ' : 'beyond_3σ')));
    const data = { mode, price: close ?? null, bb: { middle: mid, bands: bbBands, zScore, bandWidthPct: bandWidthAll }, position_analysis: { current_zone }, extreme_events: { 'touches_3σ_last_30d': null, 'touches_2σ_last_30d': null, band_walk_detected: null, squeeze_percentile: null }, interpretation: { volatility_state: null, extreme_risk: null, mean_reversion_potential: null }, tags } as any;
    const meta = createMeta(chk.pair, { type, count: indRes.data.normalized.length, mode, extra: { timeseries: timeseries ? { last_30_candles: timeseries } : undefined, metadata: { calculation_params: { period: 20, std_dev_multiplier: 2 }, data_quality: 'complete', last_updated: new Date().toISOString() } } });
    return AnalyzeBbSnapshotOutputSchema.parse(ok(summaryBase, data as any, meta as any)) as any;
  } catch (e: unknown) {
    return AnalyzeBbSnapshotOutputSchema.parse(fail(getErrorMessage(e) || 'internal error', 'internal')) as any;
  }
}


