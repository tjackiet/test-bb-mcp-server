import { ensurePair, createMeta } from '../lib/validate.js';
import { fetchJson } from '../lib/http.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { GetDepthOutputSchema } from '../src/schemas.js';

export interface GetDepthOptions { timeoutMs?: number; maxLevels?: number }

export default async function getDepth(
  pair: string,
  { timeoutMs = 3000, maxLevels = 200 }: GetDepthOptions = {}
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/depth`;
  try {
    const json: any = await fetchJson(url, { timeoutMs, retries: 2 });
    const d = json?.data ?? {};
    const asks = Array.isArray(d.asks) ? d.asks.slice(0, maxLevels) : [];
    const bids = Array.isArray(d.bids) ? d.bids.slice(0, maxLevels) : [];

    // 簡易サマリ（最良気配と件数）
    const bestAsk = asks[0]?.[0] ?? null;
    const bestBid = bids[0]?.[0] ?? null;
    const summary = formatSummary({
      pair: chk.pair,
      latest: bestBid && bestAsk ? Number(((Number(bestBid) + Number(bestAsk)) / 2).toFixed(2)) : undefined,
      extra: `levels: bids=${bids.length} asks=${asks.length}`,
    });

    const data = {
      asks,
      bids,
      asks_over: d.asks_over,
      asks_under: d.asks_under,
      bids_over: d.bids_over,
      bids_under: d.bids_under,
      ask_market: d.ask_market,
      bid_market: d.bid_market,
      timestamp: Number(d.timestamp ?? d.timestamp_ms ?? Date.now()),
      sequenceId:
        d.sequenceId != null ? Number(d.sequenceId) :
        d.sequence_id != null ? Number(d.sequence_id) :
        undefined,
    };
    const meta = createMeta(chk.pair);
    return GetDepthOutputSchema.parse(ok(summary, data as any, meta as any));
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError';
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : err?.message || 'ネットワークエラー';
    return GetDepthOutputSchema.parse(fail(message, isAbort ? 'timeout' : 'network')) as any;
  }
}


