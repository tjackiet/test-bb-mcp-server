import analyzeIndicators from './analyze_indicators.js';
import { ALLOWED_PAIRS, normalizePair } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { getErrorMessage } from '../lib/error.js';
// removed unused GetMarketSummaryOutputSchema import

export default async function detectMacdCross(
  market: 'all' | 'jpy' = 'all',
  lookback: number = 3,
  pairs?: string[],
  view: 'summary' | 'detailed' = 'summary',
  screen?: {
    minHistogramDelta?: number;
    maxBarsAgo?: number;
    minReturnPct?: number;
    maxReturnPct?: number;
    crossType?: 'golden' | 'dead' | 'both';
    sortBy?: 'date' | 'histogram' | 'return' | 'barsAgo';
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    withPrice?: boolean;
  }
) {
  try {
    const universe = pairs && pairs.length
      ? (pairs.map(normalizePair).filter((p): p is any => !!p && ALLOWED_PAIRS.has(p as any)) as string[])
      : Array.from(ALLOWED_PAIRS.values()).filter(p => market === 'jpy' ? p.endsWith('_jpy') : true);
    const results: Array<{ pair: string; type: 'golden' | 'dead'; macd: number; signal: number; isoTime?: string | null }> = [];
    const resultsDetailed: Array<{
      pair: string;
      type: 'golden' | 'dead';
      crossIndex: number;
      crossDate: string | null;
      barsAgo: number;
      macdAtCross: number | null;
      signalAtCross: number | null;
      histogramPrev: number | null;
      histogramCurr: number | null;
      histogramDelta: number | null;
      prevCross: { type: 'golden' | 'dead'; barsAgo: number; date: string | null } | null;
      priceAtCross: number | null;
      currentPrice: number | null;
      returnSinceCrossPct: number | null;
    }> = [];
    await Promise.all(universe.map(async (pair) => {
      try {
        const ind = await analyzeIndicators(pair, '1day', 120);
        if (!ind?.ok) return;
        const macdSeries = (ind.data?.indicators as { macd_series?: { line: number[]; signal: number[] } })?.macd_series;
        const line = macdSeries?.line || [];
        const signal = macdSeries?.signal || [];
        const candles = (ind.data?.normalized || []) as Array<{ isoTime?: string | null; close?: number | null }>;
        const n = line.length;
        if (n < 2) return;
        const end = n - 1;
        const start = Math.max(1, n - lookback);
        for (let i = start; i <= end; i++) {
          const prevDiff = (line[i - 1] ?? null) != null && (signal[i - 1] ?? null) != null ? (line[i - 1] as number) - (signal[i - 1] as number) : null;
          const currDiff = (line[i] ?? null) != null && (signal[i] ?? null) != null ? (line[i] as number) - (signal[i] as number) : null;
          if (prevDiff == null || currDiff == null) continue;
          if (prevDiff <= 0 && currDiff > 0) {
            results.push({ pair: pair as string, type: 'golden', macd: line[i] as number, signal: signal[i] as number, isoTime: candles[i]?.isoTime ?? null });
            // detailed info
            const currentPrice = (candles.at(-1)?.close ?? null) as number | null;
            const priceAtCross = (candles[i]?.close ?? null) as number | null;
            const retPct = priceAtCross && currentPrice != null ? Number((((currentPrice - priceAtCross) / priceAtCross) * 100).toFixed(2)) : null;
            // previous cross lookup
            let prevIdx: number | null = null;
            let prevType: 'golden' | 'dead' | null = null;
            for (let j = i - 1; j >= 1; j--) {
              const pd = (line[j - 1] ?? null) != null && (signal[j - 1] ?? null) != null ? (line[j - 1] as number) - (signal[j - 1] as number) : null;
              const cd = (line[j] ?? null) != null && (signal[j] ?? null) != null ? (line[j] as number) - (signal[j] as number) : null;
              if (pd == null || cd == null) continue;
              if (pd <= 0 && cd > 0) { prevIdx = j; prevType = 'golden'; break; }
              if (pd >= 0 && cd < 0) { prevIdx = j; prevType = 'dead'; break; }
            }
            resultsDetailed.push({
              pair: pair as string,
              type: 'golden',
              crossIndex: i,
              crossDate: candles[i]?.isoTime ?? null,
              barsAgo: (n - 1) - i,
              macdAtCross: (line[i] ?? null) as number | null,
              signalAtCross: (signal[i] ?? null) as number | null,
              histogramPrev: prevDiff,
              histogramCurr: currDiff,
              histogramDelta: (currDiff != null && prevDiff != null) ? Number((currDiff - prevDiff).toFixed(4)) : null,
              prevCross: prevIdx != null ? { type: prevType as any, barsAgo: i - prevIdx, date: candles[prevIdx]?.isoTime ?? null } : null,
              priceAtCross,
              currentPrice,
              returnSinceCrossPct: retPct,
            });
            break;
          }
          if (prevDiff >= 0 && currDiff < 0) {
            results.push({ pair: pair as string, type: 'dead', macd: line[i] as number, signal: signal[i] as number, isoTime: candles[i]?.isoTime ?? null });
            const currentPrice = (candles.at(-1)?.close ?? null) as number | null;
            const priceAtCross = (candles[i]?.close ?? null) as number | null;
            const retPct = priceAtCross && currentPrice != null ? Number((((currentPrice - priceAtCross) / priceAtCross) * 100).toFixed(2)) : null;
            let prevIdx: number | null = null;
            let prevType: 'golden' | 'dead' | null = null;
            for (let j = i - 1; j >= 1; j--) {
              const pd = (line[j - 1] ?? null) != null && (signal[j - 1] ?? null) != null ? (line[j - 1] as number) - (signal[j - 1] as number) : null;
              const cd = (line[j] ?? null) != null && (signal[j] ?? null) != null ? (line[j] as number) - (signal[j] as number) : null;
              if (pd == null || cd == null) continue;
              if (pd <= 0 && cd > 0) { prevIdx = j; prevType = 'golden'; break; }
              if (pd >= 0 && cd < 0) { prevIdx = j; prevType = 'dead'; break; }
            }
            resultsDetailed.push({
              pair: pair as string,
              type: 'dead',
              crossIndex: i,
              crossDate: candles[i]?.isoTime ?? null,
              barsAgo: (n - 1) - i,
              macdAtCross: (line[i] ?? null) as number | null,
              signalAtCross: (signal[i] ?? null) as number | null,
              histogramPrev: prevDiff,
              histogramCurr: currDiff,
              histogramDelta: (currDiff != null && prevDiff != null) ? Number((currDiff - prevDiff).toFixed(4)) : null,
              prevCross: prevIdx != null ? { type: prevType as any, barsAgo: i - prevIdx, date: candles[prevIdx]?.isoTime ?? null } : null,
              priceAtCross,
              currentPrice,
              returnSinceCrossPct: retPct,
            });
            break;
          }
        }
      } catch { }
    }));

    // screening (applies to summary and detailed when provided)
    const opts = screen || {};
    const crossType = (opts.crossType || 'both');
    const totalFound = resultsDetailed.length;
    let filtered = resultsDetailed.slice();
    filtered = filtered.filter(r => {
      if (crossType !== 'both' && r.type !== crossType) return false;
      if (opts.minHistogramDelta != null && r.histogramDelta != null && Math.abs(r.histogramDelta) < opts.minHistogramDelta) return false;
      if (opts.maxBarsAgo != null && r.barsAgo != null && r.barsAgo > opts.maxBarsAgo) return false;
      if (opts.minReturnPct != null && !(r.returnSinceCrossPct != null && r.returnSinceCrossPct >= opts.minReturnPct)) return false;
      if (opts.maxReturnPct != null && !(r.returnSinceCrossPct != null && r.returnSinceCrossPct <= opts.maxReturnPct)) return false;
      return true;
    });
    // sort
    const sortBy = opts.sortBy || 'date';
    const order = (opts.sortOrder || 'desc') === 'desc' ? -1 : 1;
    const safeNum = (v: unknown, def = 0) => (v == null || Number.isNaN(Number(v)) ? def : Number(v));
    const projReturn = (v: unknown) => (v == null ? Number.NEGATIVE_INFINITY : Number(v));
    filtered.sort((a, b) => {
      if (sortBy === 'histogram') {
        const aa = Math.abs(safeNum(a.histogramDelta));
        const bb = Math.abs(safeNum(b.histogramDelta));
        return (bb - aa) * (order === -1 ? 1 : -1);
      }
      if (sortBy === 'return') {
        const ar = projReturn(a.returnSinceCrossPct);
        const br = projReturn(b.returnSinceCrossPct);
        return ((br - ar) * (order === -1 ? 1 : -1));
      }
      if (sortBy === 'barsAgo') {
        return ((safeNum(a.barsAgo) - safeNum(b.barsAgo)) * (order === -1 ? 1 : -1));
      }
      // date (newer first when desc): smaller barsAgo first
      return (((safeNum(a.barsAgo) - safeNum(b.barsAgo))) * (order === -1 ? 1 : -1));
    });
    if (opts.limit != null && opts.limit > 0) filtered = filtered.slice(0, opts.limit);

    const resultsScreened = filtered.map(r => ({ pair: r.pair, type: r.type, macd: r.macdAtCross as number, signal: r.signalAtCross as number, isoTime: r.crossDate }));
    const brief = resultsScreened.slice(0, 6).map(r => `${r.pair}:${r.type}${r.isoTime ? '@' + String(r.isoTime).slice(0, 10) : ''}`).join(', ');
    // human-readable screen conditions
    const conds: string[] = [];
    if (crossType && crossType !== 'both') conds.push(crossType);
    if (opts.minHistogramDelta != null) conds.push(`ヒストグラム≥${opts.minHistogramDelta}`);
    if (opts.maxBarsAgo != null) conds.push(`bars≤${opts.maxBarsAgo}`);
    if (opts.minReturnPct != null) conds.push(`return≥${opts.minReturnPct}%`);
    if (opts.maxReturnPct != null) conds.push(`return≤${opts.maxReturnPct}%`);
    if (opts.limit != null) conds.push(`top${opts.limit}`);
    const condStr = conds.length ? ` (全${totalFound}件中, 条件: ${conds.join(', ')})` : '';
    const summary = formatSummary({ pair: 'multi', latest: undefined, extra: `crosses=${resultsScreened.length}${condStr}${brief ? ' [' + brief + ']' : ''}` });
    const data: Record<string, unknown> = { results: resultsScreened };
    if (view === 'detailed') {
      data.resultsDetailed = resultsDetailed;
      data.screenedDetailed = filtered;
    }
    return ok(summary, data, { market, lookback, pairs: universe, view, screen: { ...opts, crossType, sortBy, sortOrder: opts.sortOrder || 'desc' } });
  } catch (e: unknown) {
    return fail(getErrorMessage(e) || 'internal error', 'internal');
  }
}


