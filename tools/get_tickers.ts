import { fetchJson } from '../lib/http.js';
import { ALLOWED_PAIRS, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { GetTickersOutputSchema } from '../src/schemas.js';

type Market = 'all' | 'jpy';

type TickerRaw = { data?: Record<string, unknown> };

function toIsoTime(ts: unknown): string | null {
  const d = new Date(Number(ts));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

const CACHE_TTL_MS = 3000; // 短期キャッシュで負荷軽減
let cache: { market: Market; fetchedAt: number; items: Array<{ pair: string; last: number | null; buy: number | null; sell: number | null; volume: number | null; timestamp: number | null; isoTime: string | null; change24hPct?: number | null }> } | null = null;

async function fetchTickerForPair(pair: string, timeoutMs = 4000): Promise<{ pair: string; last: number | null; buy: number | null; sell: number | null; volume: number | null; timestamp: number | null; isoTime: string | null; change24hPct?: number | null }> {
  const url = `https://public.bitbank.cc/${pair}/ticker`;
  try {
    const json = (await fetchJson(url, { timeoutMs, retries: 2 })) as TickerRaw;
    const d: any = json?.data ?? {};
    return {
      pair,
      last: d.last != null ? Number(d.last) : null,
      buy: d.buy != null ? Number(d.buy) : null,
      sell: d.sell != null ? Number(d.sell) : null,
      volume: d.vol != null ? Number(d.vol) : null,
      timestamp: d.timestamp != null ? Number(d.timestamp) : null,
      isoTime: toIsoTime(d.timestamp),
      // 公開APIに24h変化率が無いため、当面はnull（将来、軽量取得手段があれば差し替え）
      change24hPct: null,
    };
  } catch {
    return { pair, last: null, buy: null, sell: null, volume: null, timestamp: null, isoTime: null, change24hPct: null };
  }
}

function pickPairs(market: Market): string[] {
  const all = Array.from(ALLOWED_PAIRS.values());
  if (market === 'jpy') return all.filter((p) => p.endsWith('_jpy'));
  return all;
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

export default async function getTickers(market: Market = 'all') {
  // 短期キャッシュ
  const now = Date.now();
  if (cache && cache.market === market && now - cache.fetchedAt <= CACHE_TTL_MS) {
    const summary = formatSummary({ pair: 'multi', latest: undefined, extra: `count=${cache.items.length} (cached)` });
    return GetTickersOutputSchema.parse(
      ok(
        summary,
        { items: cache.items },
        { market, fetchedAt: new Date(cache.fetchedAt).toISOString(), count: cache.items.length }
      )
    ) as any;
  }

  try {
    const pairs = pickPairs(market);
    const items = await withConcurrency(pairs, (p) => fetchTickerForPair(p));
    // summary: 上位数銘柄を示唆
    const nonNull = items.filter((x) => x.last != null) as Array<typeof items[number]>;
    const summary = formatSummary({ pair: 'multi', latest: undefined, extra: `count=${items.length} ok=${nonNull.length}` });
    const fetchedAt = Date.now();
    cache = { market, fetchedAt, items };
    return GetTickersOutputSchema.parse(
      ok(
        summary,
        { items },
        { market, fetchedAt: new Date(fetchedAt).toISOString(), count: items.length }
      )
    ) as any;
  } catch (e: any) {
    return GetTickersOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


