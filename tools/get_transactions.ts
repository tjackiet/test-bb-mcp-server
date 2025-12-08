import { fetchJson } from '../lib/http.js';
import { ensurePair, validateLimit, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { toIsoMs } from '../lib/datetime.js';
import { getErrorMessage } from '../lib/error.js';
import { GetTransactionsOutputSchema } from '../src/schemas.js';

type TxnRaw = Record<string, unknown>;

function toMs(input: unknown): number | null {
  if (input == null) return null;
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  // 秒とミリ秒の曖昧性に対応
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

function normalizeSide(v: unknown): 'buy' | 'sell' | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'buy') return 'buy';
  if (s === 'sell') return 'sell';
  return null;
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

  // latest（直近） or 指定日
  const url = date && /\d{8}/.test(String(date))
    ? `https://public.bitbank.cc/${chk.pair}/transactions/${date}`
    : `https://public.bitbank.cc/${chk.pair}/transactions`;

  try {
    const json: any = await fetchJson(url, { timeoutMs: 4000, retries: 2 });
    const arr: TxnRaw[] = (json?.data?.transactions ?? []) as TxnRaw[];

    const items = arr
      .map((t) => {
        const price = Number(t.price);
        const amount = Number(t.amount ?? t.size);
        const side = normalizeSide(t.side);
        const ms = toMs(t.executed_at ?? t.timestamp ?? t.date); // フィールド名の差異を吸収
        const isoTime = toIsoMs(ms);
        if (!Number.isFinite(price) || !Number.isFinite(amount) || side == null || isoTime == null) return null;
        return { price, amount, side, timestampMs: ms as number, isoTime };
      })
      .filter(Boolean) as Array<{ price: number; amount: number; side: 'buy' | 'sell'; timestampMs: number; isoTime: string }>;

    // 時系列昇順に整えてから直近 limit 件
    const sorted = items.sort((a, b) => a.timestampMs - b.timestampMs);
    const latest = sorted.slice(-lim.value);

    const buys = latest.filter((t) => t.side === 'buy').length;
    const sells = latest.filter((t) => t.side === 'sell').length;
    const summary = formatSummary({ pair: chk.pair, latest: latest.at(-1)?.price, extra: `trades=${latest.length} buy=${buys} sell=${sells}` });

    const data = { raw: json, normalized: latest };
    const meta = createMeta(chk.pair, { count: latest.length, source: date ? 'by_date' : 'latest' });
    return GetTransactionsOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: unknown) {
    return GetTransactionsOutputSchema.parse(fail(getErrorMessage(e) || 'ネットワークエラー', 'network')) as any;
  }
}



