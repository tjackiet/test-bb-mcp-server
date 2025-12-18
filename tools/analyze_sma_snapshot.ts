import analyzeIndicators from './analyze_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { getErrorMessage } from '../lib/error.js';
import { AnalyzeSmaSnapshotOutputSchema } from '../src/schemas.js';

export default async function analyzeSmaSnapshot(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 220,
  periods: number[] = [25, 75, 200]
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return AnalyzeSmaSnapshotOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;
  try {
    const indRes: any = await analyzeIndicators(chk.pair, type as any, Math.max(Math.max(...periods, 200), limit));
    if (!indRes?.ok) return AnalyzeSmaSnapshotOutputSchema.parse(fail(indRes?.summary || 'indicators failed', (indRes?.meta as any)?.errorType || 'internal')) as any;

    const close = indRes.data.normalized.at(-1)?.close ?? null;
    const map: Record<string, number | null> = {};
    const get = (p: number) => (indRes.data.indicators as any)[`SMA_${p}`] ?? null;
    for (const p of periods) map[`SMA_${p}`] = get(p);

    // Series for slopes/crosses (prefer chart.indicators for complete arrays)
    const chartInd: any = indRes?.data?.chart?.indicators || {};
    const candles: Array<{ isoTime?: string }> = Array.isArray(indRes?.data?.chart?.candles) ? indRes.data.chart.candles : (Array.isArray(indRes?.data?.normalized) ? indRes.data.normalized : []);
    const lastIdx = Math.max(0, candles.length - 1);

    // Crosses status (current delta sign) and recent cross detection (last 30 bars)
    const crosses: Array<{ a: string; b: string; type: 'golden' | 'dead'; delta: number }> = [];
    const crossPairs: Array<[number, number]> = [];
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) crossPairs.push([periods[i], periods[j]]);
    }
    for (const [a, b] of crossPairs) {
      const va = map[`SMA_${a}`];
      const vb = map[`SMA_${b}`];
      if (va != null && vb != null) {
        const delta = (va as number) - (vb as number);
        crosses.push({ a: `SMA_${a}`, b: `SMA_${b}`, type: delta >= 0 ? 'golden' : 'dead', delta: Number(delta.toFixed(2)) });
      }
    }

    const lookback = 30;
    type RecentCross = { type: 'golden_cross' | 'dead_cross'; pair: [number, number]; barsAgo: number; date: string };
    const recentCrosses: RecentCross[] = [];
    for (const [a, b] of crossPairs) {
      const sa: Array<number | null> = Array.isArray(chartInd?.[`SMA_${a}`]) ? chartInd[`SMA_${a}`] : [];
      const sb: Array<number | null> = Array.isArray(chartInd?.[`SMA_${b}`]) ? chartInd[`SMA_${b}`] : [];
      const n = Math.min(sa.length, sb.length, candles.length);
      if (n < 2) continue;
      const start = Math.max(1, n - lookback);
      for (let i = start; i < n; i++) {
        const prevA = sa[i - 1];
        const prevB = sb[i - 1];
        const curA = sa[i];
        const curB = sb[i];
        if (prevA == null || prevB == null || curA == null || curB == null) continue;
        const prev = prevA - prevB;
        const curr = curA - curB;
        if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) {
          const type = curr > 0 ? 'golden_cross' : 'dead_cross';
          const barsAgo = (n - 1) - i;
          const date = String(candles[i]?.isoTime || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
          recentCrosses.push({ type, pair: [a, b], barsAgo, date });
        }
      }
    }

    let alignment: 'bullish' | 'bearish' | 'mixed' | 'unknown' = 'unknown';
    const v25 = map['SMA_25'];
    const v75 = map['SMA_75'];
    const v200 = map['SMA_200'];
    if (v25 != null && v75 != null && v200 != null) {
      if (v25 > v75 && v75 > v200) alignment = 'bullish';
      else if (v25 < v75 && v75 < v200) alignment = 'bearish';
      else alignment = 'mixed';
    }

    const tags: string[] = [];
    if (alignment === 'bullish') tags.push('sma_bullish_alignment');
    if (alignment === 'bearish') tags.push('sma_bearish_alignment');

    // Position vs all SMAs
    const smaVals = periods.map((p) => map[`SMA_${p}`]).filter((v): v is number => v != null);
    let position: 'above_all' | 'below_all' | 'between' | 'unknown' = 'unknown';
    if (close != null && smaVals.length) {
      const minS = Math.min(...smaVals);
      const maxS = Math.max(...smaVals);
      if (close > maxS) position = 'above_all';
      else if (close < minS) position = 'below_all';
      else position = 'between';
    }

    // Slopes per SMA (use last ~6 bars delta percentage with 0.2% deadband)
    function slopeOfLabel(period: number): 'rising' | 'falling' | 'flat' {
      const s: Array<number | null> = Array.isArray(chartInd?.[`SMA_${period}`]) ? chartInd[`SMA_${period}`] : [];
      const n = s.length;
      if (n < 6) return 'flat';
      // find valid current and 5 bars ago
      let curIdx = n - 1;
      while (curIdx >= 0 && s[curIdx] == null) curIdx--;
      let prevIdx = curIdx - 5;
      while (prevIdx >= 0 && s[prevIdx] == null) prevIdx--;
      if (curIdx < 0 || prevIdx < 0) return 'flat';
      const cur = s[curIdx] as number;
      const prev = s[prevIdx] as number;
      if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return 'flat';
      const pct = (cur - prev) / Math.abs(prev);
      if (pct > 0.002) return 'rising';
      if (pct < -0.002) return 'falling';
      return 'flat';
    }

    // Numeric slope rate (total % over window and %/bar)
    function slopeRates(period: number): { pctTotal: number | null; pctPerBar: number | null; barsWindow: number | null } {
      const s: Array<number | null> = Array.isArray(chartInd?.[`SMA_${period}`]) ? chartInd[`SMA_${period}`] : [];
      const n = s.length;
      if (n < 6) return { pctTotal: null, pctPerBar: null, barsWindow: null };
      let curIdx = n - 1;
      while (curIdx >= 0 && s[curIdx] == null) curIdx--;
      let prevIdx = curIdx - 5;
      while (prevIdx >= 0 && s[prevIdx] == null) prevIdx--;
      if (curIdx < 0 || prevIdx < 0) return { pctTotal: null, pctPerBar: null, barsWindow: null };
      const cur = s[curIdx] as number;
      const prev = s[prevIdx] as number;
      const bars = curIdx - prevIdx;
      if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0 || bars <= 0) return { pctTotal: null, pctPerBar: null, barsWindow: null };
      const pctTotal = ((cur - prev) / Math.abs(prev)) * 100;
      const pctPerBar = pctTotal / bars;
      return { pctTotal, pctPerBar, barsWindow: bars };
    }

    // Extended smas object with distancePct/Abs and slope metrics
    const smasExt: Record<string, { value: number | null; distancePct: number | null; distanceAbs: number | null; slope: 'rising' | 'falling' | 'flat'; slopePctPerBar: number | null; slopePctTotal: number | null; barsWindow: number | null; slopePctPerDay?: number | null; pricePosition?: 'above' | 'below' | 'equal' }> = {};
    for (const p of periods) {
      const val = map[`SMA_${p}`];
      const distancePct = (close != null && val != null && val !== 0) ? Number((((close - val) / val) * 100).toFixed(2)) : null;
      const distanceAbs = (close != null && val != null) ? Number((close - val).toFixed(2)) : null;
      const slope = slopeOfLabel(p);
      const rates = slopeRates(p);
      const slopePctPerBar = rates.pctPerBar != null ? Number(rates.pctPerBar.toFixed(3)) : null;
      const slopePctTotal = rates.pctTotal != null ? Number(rates.pctTotal.toFixed(2)) : null;
      const barsWindow = rates.barsWindow;
      const entry: any = { value: val, distancePct, distanceAbs, slope, slopePctPerBar, slopePctTotal, barsWindow };
      if (type === '1day') entry.slopePctPerDay = slopePctPerBar;
      if (close != null && val != null) entry.pricePosition = close > val ? 'above' : close < val ? 'below' : 'equal';
      smasExt[String(p)] = entry;
    }

    // Multi-line content summary
    const topPeriods = Array.from(new Set(periods)).sort((a, b) => a - b);
    const distanceLines = topPeriods.map(p => {
      const it = smasExt[String(p)];
      const valStr = it?.value != null ? it.value : 'n/a';
      const pctStr = it.distancePct != null ? `${it.distancePct >= 0 ? '+' : ''}${it.distancePct}%` : 'n/a';
      const absStr = it.distanceAbs != null ? `${it.distanceAbs >= 0 ? '+' : ''}${Number(it.distanceAbs).toLocaleString()}円` : 'n/a';
      const slopeRate = it?.slopePctPerBar != null ? `${it.slopePctPerBar >= 0 ? '+' : ''}${it.slopePctPerBar}%/${type === '1day' ? 'day' : 'bar'}` : null;
      const pos = it?.pricePosition ? (it.pricePosition === 'above' ? '（価格は上）' : it.pricePosition === 'below' ? '（価格は下）' : '（同水準）') : '';
      return `SMA(${p}): ${valStr} (${pctStr}, ${absStr}) slope=${it?.slope}${slopeRate ? ` (${slopeRate})` : ''}${pos}`;
    });
    const recentLines = recentCrosses.slice(-3).reverse().map(rc => `${rc.type} ${rc.pair.join('/')} - ${rc.barsAgo} bars ago (${rc.date})`);
    const summaryText = [
      formatSummary({ pair: chk.pair, latest: close ?? undefined, extra: `align=${alignment} pos=${position}` }),
      '',
      ...distanceLines,
      ...(recentLines.length ? ['', 'Recent Crosses:', ...recentLines] : []),
    ].filter(Boolean).join('\n');

    const data = {
      latest: { close },
      sma: map,
      crosses,
      alignment,
      tags,
      // Extended block (kept backward-compatible)
      summary: { close, align: alignment, position },
      smas: smasExt,
      recentCrosses,
    } as any;
    const meta = createMeta(chk.pair, { type, count: indRes.data.normalized.length, periods });
    return AnalyzeSmaSnapshotOutputSchema.parse(ok(summaryText, data as any, meta as any)) as any;
  } catch (e: unknown) {
    return AnalyzeSmaSnapshotOutputSchema.parse(fail(getErrorMessage(e) || 'internal error', 'internal')) as any;
  }
}


