import { ensurePair, validateLimit, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { fetchJson } from '../lib/http.js';
import { GetOrderbookOutputSchema } from '../src/schemas.js';
import type { Result, GetOrderbookData, GetOrderbookMeta, OrderbookLevelWithCum } from '../src/types/domain.d.ts';

export interface GetOrderbookOptions {
  timeoutMs?: number;
}

function toIsoTime(ts: unknown): string | null {
  const d = new Date(Number(ts));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

function toLevels(arr: any[], n: number): OrderbookLevelWithCum[] {
  const out = (arr || []).slice(0, n).map(([p, s]: [unknown, unknown]) => ({
    price: Number(p),
    size: Number(s),
    cumSize: 0,
  }));
  let cum = 0;
  for (const lvl of out) {
    cum += Number.isFinite(lvl.size) ? lvl.size : 0;
    lvl.cumSize = Number(cum.toFixed(8));
  }
  return out;
}

export default async function getOrderbook(
  pair: string,
  topN: number = 5,
  { timeoutMs = 2500 }: GetOrderbookOptions = {}
): Promise<Result<GetOrderbookData, GetOrderbookMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const limitCheck = validateLimit(topN, 1, 200, 'opN');
  if (!limitCheck.ok) return fail(limitCheck.error.message, limitCheck.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/depth`;

  try {
    const json: any = await fetchJson(url, { timeoutMs, retries: 2 });
    const d = json?.data ?? {};
    const asks = toLevels(d.asks, limitCheck.value);
    const bids = toLevels(d.bids, limitCheck.value);

    const bestAsk = asks[0]?.price ?? null;
    const bestBid = bids[0]?.price ?? null;
    const spread = bestAsk != null && bestBid != null ? Number((bestAsk - bestBid).toFixed(0)) : null;
    const mid = bestAsk != null && bestBid != null ? Number(((bestAsk + bestBid) / 2).toFixed(2)) : null;

    const summary = formatSummary({
      pair: chk.pair,
      latest: mid ?? undefined,
      extra: `bid=${bestBid ?? 'N/A'} ask=${bestAsk ?? 'N/A'} spread=${spread ?? 'N/A'}`,
    });

    const data: GetOrderbookData = {
      raw: json,
      normalized: {
        pair: chk.pair,
        bestBid,
        bestAsk,
        spread,
        mid,
        bids,
        asks,
        timestamp: d.timestamp ?? null,
        isoTime: toIsoTime(d.timestamp),
      },
    };
    const meta: GetOrderbookMeta = createMeta(chk.pair, {
      topN: limitCheck.value,
      count: asks.length + bids.length,
    }) as GetOrderbookMeta;

    return GetOrderbookOutputSchema.parse(ok(summary, data, meta)) as unknown as Result<GetOrderbookData, GetOrderbookMeta>;
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError';
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : err?.message || 'ネットワークエラー';
    return GetOrderbookOutputSchema.parse(fail(message, isAbort ? 'timeout' : 'network')) as unknown as Result<GetOrderbookData, GetOrderbookMeta>;
  }
}


