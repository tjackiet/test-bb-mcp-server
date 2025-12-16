import { ensurePair, createMeta } from '../lib/validate.js';
import { fetchJson, BITBANK_API_BASE } from '../lib/http.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';
import { toIsoTime } from '../lib/datetime.js';
import { getErrorMessage, isAbortError } from '../lib/error.js';
import { GetTickerOutputSchema } from '../src/schemas.js';
import type { Result, GetTickerData, GetTickerMeta } from '../src/types/domain.d.ts';

export interface GetTickerOptions {
  timeoutMs?: number;
}

/**
 * ticker データから content 用のサマリ文字列を生成
 */
function formatTickerSummary(pair: string, d: Record<string, unknown>): string {
  const pairDisplay = formatPair(pair);
  const isJpy = pair.toLowerCase().includes('jpy');

  const last = d.last != null ? Number(d.last) : null;
  const open = d.open != null ? Number(d.open) : null;
  const high = d.high != null ? Number(d.high) : null;
  const low = d.low != null ? Number(d.low) : null;
  const buy = d.buy != null ? Number(d.buy) : null;
  const sell = d.sell != null ? Number(d.sell) : null;
  const vol = d.vol != null ? Number(d.vol) : null;

  // 通貨単位
  const baseCurrency = pair.split('_')[0]?.toUpperCase() ?? '';

  // 価格フォーマット
  const formatPrice = (price: number | null): string => {
    if (price === null) return 'N/A';
    if (isJpy) {
      return `¥${price.toLocaleString('ja-JP')}`;
    }
    return price.toLocaleString('ja-JP');
  };

  // 変動率計算
  let changeStr = '';
  if (last !== null && open !== null && open !== 0) {
    const changePct = ((last - open) / open) * 100;
    const sign = changePct >= 0 ? '+' : '';
    changeStr = `${sign}${changePct.toFixed(2)}%`;
  }

  // スプレッド計算
  let spreadStr = '';
  if (buy !== null && sell !== null) {
    const spread = sell - buy;
    spreadStr = isJpy ? `¥${spread.toLocaleString('ja-JP')}` : spread.toLocaleString('ja-JP');
  }

  // 出来高フォーマット
  const formatVolume = (v: number | null): string => {
    if (v === null) return 'N/A';
    if (v >= 1000) {
      return `${(v / 1000).toFixed(2)}K ${baseCurrency}`;
    }
    return `${v.toFixed(4)} ${baseCurrency}`;
  };

  // サマリ構築
  const lines: string[] = [];
  lines.push(`${pairDisplay} 現在値: ${formatPrice(last)}`);
  lines.push(`24h: 始値 ${formatPrice(open)} / 高値 ${formatPrice(high)} / 安値 ${formatPrice(low)}`);
  if (changeStr) {
    lines.push(`24h変動: ${changeStr}`);
  }
  lines.push(`出来高: ${formatVolume(vol)}`);
  lines.push(`Bid: ${formatPrice(buy)} / Ask: ${formatPrice(sell)}${spreadStr ? `（スプレッド: ${spreadStr}）` : ''}`);

  return lines.join('\n');
}

export default async function getTicker(
  pair: string,
  { timeoutMs = 5000 }: GetTickerOptions = {}
): Promise<Result<GetTickerData, GetTickerMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const url = `${BITBANK_API_BASE}/${chk.pair}/ticker`;

  try {
    const json: unknown = await fetchJson(url, { timeoutMs, retries: 2 });
    const jsonObj = json as { data?: Record<string, unknown> };

    const d = jsonObj?.data ?? {};
    const summary = formatTickerSummary(chk.pair, d);

    const data: GetTickerData = {
      raw: json,
      normalized: {
        pair: chk.pair,
        last: d.last != null ? Number(d.last) : null,
        buy: d.buy != null ? Number(d.buy) : null,
        sell: d.sell != null ? Number(d.sell) : null,
        open: d.open != null ? Number(d.open) : null,
        high: d.high != null ? Number(d.high) : null,
        low: d.low != null ? Number(d.low) : null,
        volume: d.vol != null ? Number(d.vol) : null,
        timestamp: d.timestamp != null ? Number(d.timestamp) : null,
        isoTime: toIsoTime(d.timestamp),
      },
    };

    return GetTickerOutputSchema.parse(ok(summary, data, createMeta(chk.pair))) as unknown as Result<GetTickerData, GetTickerMeta>;
  } catch (err: unknown) {
    const isAbort = isAbortError(err);
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : getErrorMessage(err) || 'ネットワークエラー';
    return GetTickerOutputSchema.parse(fail(message, isAbort ? 'timeout' : 'network')) as unknown as Result<GetTickerData, GetTickerMeta>;
  }
}


