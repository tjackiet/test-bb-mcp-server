import { ensurePair, validateLimit, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary, formatTimestampJST } from '../lib/formatter.js';
import { toIsoTime } from '../lib/datetime.js';
import { fetchJson } from '../lib/http.js';
import { getErrorMessage, isAbortError } from '../lib/error.js';
import { GetOrderbookOutputSchema } from '../src/schemas.js';
import type { Result, GetOrderbookData, GetOrderbookMeta, OrderbookLevelWithCum } from '../src/types/domain.d.ts';

export interface GetOrderbookOptions {
  timeoutMs?: number;
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
    const timestamp = d.timestamp ?? Date.now();

    const summary = formatSummary({
      pair: chk.pair,
      latest: mid ?? undefined,
      extra: `bid=${bestBid ?? 'N/A'} ask=${bestAsk ?? 'N/A'} spread=${spread ?? 'N/A'}`,
    });

    // タイムスタンプ付きテキスト出力
    const text = [
      `📸 ${formatTimestampJST(timestamp)}`,
      '',
      summary,
      '',
      `📊 板情報 (上位${limitCheck.value}層):`,
      `中値: ${mid?.toLocaleString() ?? 'N/A'}円`,
      `スプレッド: ${spread?.toLocaleString() ?? 'N/A'}円`,
      '',
      `🟢 買い板 (Bids): ${bids.length}層`,
      ...bids.slice(0, 5).map((b, i) => `  ${i + 1}. ${b.price.toLocaleString()}円 ${b.size.toFixed(4)} BTC (累計: ${b.cumSize.toFixed(4)} BTC)`),
      bids.length > 5 ? `  ... 他 ${bids.length - 5}層` : '',
      '',
      `🔴 売り板 (Asks): ${asks.length}層`,
      ...asks.slice(0, 5).map((a, i) => `  ${i + 1}. ${a.price.toLocaleString()}円 ${a.size.toFixed(4)} BTC (累計: ${a.cumSize.toFixed(4)} BTC)`),
      asks.length > 5 ? `  ... 他 ${asks.length - 5}層` : '',
    ].filter(Boolean).join('\n');

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

    return GetOrderbookOutputSchema.parse(ok(text, data, meta)) as unknown as Result<GetOrderbookData, GetOrderbookMeta>;
  } catch (err: unknown) {
    const isAbort = isAbortError(err);
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : getErrorMessage(err) || 'ネットワークエラー';
    return GetOrderbookOutputSchema.parse(fail(message, isAbort ? 'timeout' : 'network')) as unknown as Result<GetOrderbookData, GetOrderbookMeta>;
  }
}


