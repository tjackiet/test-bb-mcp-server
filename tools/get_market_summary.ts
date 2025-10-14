import getTickers from './get_tickers.js';
import getVolatilityMetrics from './get_volatility_metrics.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { ALLOWED_PAIRS } from '../lib/validate.js';
import { GetMarketSummaryOutputSchema } from '../src/schemas.js';

type Market = 'all' | 'jpy';

const CACHE_TTL_MS = 3000;
let cache: { key: string; fetchedAt: number; data: any } | null = null;

function pickPairs(market: Market): string[] {
  const all = Array.from(ALLOWED_PAIRS.values());
  if (market === 'jpy') return all.filter((p) => p.endsWith('_jpy'));
  return all;
}

function bucketVol(rvStdAnn: number | null | undefined): 'low' | 'mid' | 'high' | null {
  if (rvStdAnn == null || !Number.isFinite(rvStdAnn)) return null;
  if (rvStdAnn < 0.25) return 'low';
  if (rvStdAnn <= 0.5) return 'mid';
  return 'high';
}

async function withConcurrency<T>(items: string[], worker: (p: string) => Promise<T>, concurrency = 4): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, run);
  await Promise.all(workers);
  return results;
}

export default async function getMarketSummary(
  market: Market = 'all',
  opts: { window?: number; ann?: boolean } = {}
) {
  const window = Math.max(2, Math.min(opts.window ?? 30, 180));
  const ann = opts.ann ?? true;

  const now = Date.now();
  const key = `${market}|${window}|${ann ? 'ann' : 'noann'}`;
  if (cache && cache.key === key && now - cache.fetchedAt <= CACHE_TTL_MS) {
    return GetMarketSummaryOutputSchema.parse(cache.data);
  }

  try {
    const tickersRes: any = await getTickers(market);
    if (!tickersRes?.ok) return GetMarketSummaryOutputSchema.parse(fail(tickersRes?.summary || 'tickers failed', (tickersRes?.meta as any)?.errorType || 'internal')) as any;
    const tickerItems: Array<{ pair: string; last: number | null; volume: number | null; change24hPct?: number | null }> = tickersRes?.data?.items || [];

    const pairs = pickPairs(market);

    const volResults = await withConcurrency(pairs, async (pair) => {
      try {
        const res: any = await getVolatilityMetrics(pair, '1day', 200, [window], { annualize: ann });
        if (!res?.ok) return { pair, ok: false, reason: res?.summary || 'vol failed' };
        const roll = res?.data?.rolling?.find((r: any) => r.window === window);
        const rvStdAnn = (roll?.rv_std_ann ?? res?.data?.aggregates?.rv_std_ann) as number | undefined;
        return { pair, ok: true, rv_std_ann: rvStdAnn ?? null };
      } catch (e: any) {
        return { pair, ok: false, reason: e?.message || 'vol error' };
      }
    }, 6);

    const volMap = new Map<string, number | null>();
    const errors: Array<{ pair: string; reason: string }> = [];
    for (const v of volResults as any[]) {
      if (v?.ok) volMap.set(v.pair, v.rv_std_ann ?? null);
      else errors.push({ pair: v.pair, reason: String(v?.reason || 'unknown') });
    }

    const items = tickerItems.map((t) => {
      const rv = volMap.get(t.pair) ?? null;
      const vol_bucket = bucketVol(rv);
      const tags: string[] = [];
      if ((t.volume ?? 0) > 100) tags.push('liquid');
      if (vol_bucket === 'high') tags.push('high_vol');
      if (vol_bucket === 'mid') tags.push('mid_vol');
      return {
        pair: t.pair,
        last: t.last,
        change24hPct: t.change24hPct ?? null,
        vol24h: t.volume ?? null,
        rv_std_ann: rv,
        vol_bucket,
        tags,
      };
    });

    // Ranks
    const gainers = [...items].filter((x) => x.change24hPct != null).sort((a, b) => (b.change24hPct as number) - (a.change24hPct as number)).slice(0, 5).map((x) => ({ pair: x.pair, change24hPct: x.change24hPct }));
    const losers = [...items].filter((x) => x.change24hPct != null).sort((a, b) => (a.change24hPct as number) - (b.change24hPct as number)).slice(0, 5).map((x) => ({ pair: x.pair, change24hPct: x.change24hPct }));
    const topVol = [...items].filter((x) => x.rv_std_ann != null).sort((a, b) => (b.rv_std_ann as number) - (a.rv_std_ann as number)).slice(0, 5).map((x) => ({ pair: x.pair, rv_std_ann: x.rv_std_ann }));

    const summary = formatSummary({ pair: 'multi', latest: undefined, extra: `count=${items.length} window=${window}${ann ? ' ann' : ''}` });
    const outOk = ok(
      summary,
      { items, ranks: { topGainers: gainers, topLosers: losers, topVolatility: topVol }, errors },
      { market, window, ann, fetchedAt: new Date().toISOString() }
    );
    const parsed = GetMarketSummaryOutputSchema.parse(outOk) as any;
    cache = { key, fetchedAt: now, data: parsed };
    return parsed;
  } catch (e: any) {
    return GetMarketSummaryOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


