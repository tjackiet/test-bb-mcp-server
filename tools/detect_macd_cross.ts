import getTickers from './get_tickers.js';
import getIndicators from './get_indicators.js';
import { ALLOWED_PAIRS, normalizePair } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { GetMarketSummaryOutputSchema } from '../src/schemas.js';

export default async function detectMacdCross(market: 'all' | 'jpy' = 'all', lookback: number = 3, pairs?: string[]) {
  try {
    const universe = pairs && pairs.length
      ? (pairs.map(normalizePair).filter((p): p is any => !!p && ALLOWED_PAIRS.has(p as any)) as string[])
      : Array.from(ALLOWED_PAIRS.values()).filter(p => market === 'jpy' ? p.endsWith('_jpy') : true);
    const results: Array<{ pair: string; type: 'golden' | 'dead'; macd: number; signal: number; isoTime?: string | null }> = [];
    await Promise.all(universe.map(async (pair) => {
      try {
        const ind: any = await getIndicators(pair, '1day', 120);
        if (!ind?.ok) return;
        const macdSeries = ind.data?.indicators?.macd_series;
        const line = macdSeries?.line || [];
        const signal = macdSeries?.signal || [];
        const candles = (ind.data?.normalized || []) as Array<{ isoTime?: string | null }>;
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
            break;
          }
          if (prevDiff >= 0 && currDiff < 0) {
            results.push({ pair: pair as string, type: 'dead', macd: line[i] as number, signal: signal[i] as number, isoTime: candles[i]?.isoTime ?? null });
            break;
          }
        }
      } catch { }
    }));

    const brief = results.slice(0, 6).map(r => `${r.pair}:${r.type}${r.isoTime ? '@' + String(r.isoTime).slice(0, 10) : ''}`).join(', ');
    const summary = formatSummary({ pair: 'multi', latest: undefined, extra: `crosses=${results.length}${brief ? ' [' + brief + ']' : ''}` });
    return ok(summary, { results }, { market, lookback, pairs: universe });
  } catch (e: any) {
    return fail(e?.message || 'internal error', 'internal');
  }
}


