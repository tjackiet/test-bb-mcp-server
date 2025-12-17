import { fetchJson, BITBANK_API_BASE } from '../lib/http.js';
import { ensurePair, validateLimit, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';
import { toIsoMs } from '../lib/datetime.js';
import { getErrorMessage } from '../lib/error.js';
import { GetTransactionsOutputSchema } from '../src/schemas.js';

type TxnRaw = Record<string, unknown>;

function toMs(input: unknown): number | null {
  if (input == null) return null;
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

function normalizeSide(v: unknown): 'buy' | 'sell' | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'buy') return 'buy';
  if (s === 'sell') return 'sell';
  return null;
}

type NormalizedTxn = { price: number; amount: number; side: 'buy' | 'sell'; timestampMs: number; isoTime: string };

/**
 * 取引サマリを生成
 */
function formatTransactionsSummary(
  pair: string,
  transactions: NormalizedTxn[],
  buys: number,
  sells: number
): string {
  const pairDisplay = formatPair(pair);
  const isJpy = pair.toLowerCase().includes('jpy');
  const baseCurrency = pair.split('_')[0]?.toUpperCase() ?? '';
  const lines: string[] = [];

  const formatPrice = (price: number): string => {
    return isJpy ? `¥${price.toLocaleString('ja-JP')}` : price.toLocaleString('ja-JP');
  };

  const formatTime = (ms: number): string => {
    const d = new Date(ms);
    return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  lines.push(`${pairDisplay} 直近取引 ${transactions.length}件`);

  if (transactions.length > 0) {
    const latestTxn = transactions[transactions.length - 1];
    lines.push(`最新約定: ${formatPrice(latestTxn.price)}`);

    // 買い/売り比率
    const total = buys + sells;
    const buyRatio = total > 0 ? Math.round((buys / total) * 100) : 0;
    const sellRatio = 100 - buyRatio;
    const dominant = buyRatio >= 60 ? '買い優勢' : buyRatio <= 40 ? '売り優勢' : '拮抗';
    const dominantRatio = buyRatio >= 60 ? buyRatio : buyRatio <= 40 ? sellRatio : buyRatio;
    lines.push(`買い: ${buys}件 / 売り: ${sells}件（${dominant} ${dominantRatio}%）`);

    // 出来高合計
    const totalVolume = transactions.reduce((sum, t) => sum + t.amount, 0);
    const volStr = totalVolume >= 1 ? totalVolume.toFixed(4) : totalVolume.toFixed(6);
    lines.push(`出来高: ${volStr} ${baseCurrency}`);

    // 期間
    const oldest = transactions[0];
    const newest = transactions[transactions.length - 1];
    lines.push(`期間: ${formatTime(oldest.timestampMs)}〜${formatTime(newest.timestampMs)}`);
  }

  return lines.join('\n');
}

export default async function getTransactions(
  pair: string = 'btc_jpy',
  limit: number = 100,
  date?: string
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return GetTransactionsOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  const lim = validateLimit(limit, 1, 1000);
  if (!lim.ok) return GetTransactionsOutputSchema.parse(fail(lim.error.message, lim.error.type)) as any;

  const url = date && /\d{8}/.test(String(date))
    ? `${BITBANK_API_BASE}/${chk.pair}/transactions/${date}`
    : `${BITBANK_API_BASE}/${chk.pair}/transactions`;

  try {
    const json: unknown = await fetchJson(url, { timeoutMs: 4000, retries: 2 });
    const jsonObj = json as { data?: { transactions?: TxnRaw[] } };
    const arr: TxnRaw[] = (jsonObj?.data?.transactions ?? []) as TxnRaw[];

    const items = arr
      .map((t) => {
        const price = Number(t.price);
        const amount = Number(t.amount ?? t.size);
        const side = normalizeSide(t.side);
        const ms = toMs(t.executed_at ?? t.timestamp ?? t.date);
        const isoTime = toIsoMs(ms);
        if (!Number.isFinite(price) || !Number.isFinite(amount) || side == null || isoTime == null) return null;
        return { price, amount, side, timestampMs: ms as number, isoTime };
      })
      .filter(Boolean) as NormalizedTxn[];

    const sorted = items.sort((a, b) => a.timestampMs - b.timestampMs);
    const latest = sorted.slice(-lim.value);

    const buys = latest.filter((t) => t.side === 'buy').length;
    const sells = latest.filter((t) => t.side === 'sell').length;
    const summary = formatTransactionsSummary(chk.pair, latest, buys, sells);

    const data = { raw: json, normalized: latest };
    const meta = createMeta(chk.pair, { count: latest.length, source: date ? 'by_date' : 'latest' });
    return GetTransactionsOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: unknown) {
    return GetTransactionsOutputSchema.parse(fail(getErrorMessage(e) || 'ネットワークエラー', 'network')) as any;
  }
}



