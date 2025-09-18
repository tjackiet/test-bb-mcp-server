import { fetchJson } from '../lib/http.js';
import { ensurePair, validateLimit, validateDate, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { GetCandlesOutputSchema } from '../src/schemas.js';
import { formatSummary } from '../lib/formatter.js';
import type { Result, GetCandlesData, GetCandlesMeta, CandleType } from '../src/types/domain.d.ts';

const TYPES: Set<CandleType | string> = new Set([
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '12hour',
  '1day',
  '1week',
  '1month',
]);

function todayYyyymmdd(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
}

function toIso(ms: unknown): string | null {
  const n = Number(ms);
  const d = new Date(n);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

export default async function getCandles(
  pair: string,
  type: CandleType | string = '1day',
  date: string = todayYyyymmdd(),
  limit: number = 200
): Promise<Result<GetCandlesData, GetCandlesMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  if (!TYPES.has(type)) {
    return fail(`type は ${[...TYPES].join(', ')} から選択してください（指定値: ${String(type)}）`, 'user');
  }

  const dateCheck = validateDate(date, String(type));
  if (!dateCheck.ok) return fail(dateCheck.error.message, dateCheck.error.type);

  const limitCheck = validateLimit(limit, 1, 1000);
  if (!limitCheck.ok) return fail(limitCheck.error.message, limitCheck.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/candlestick/${type}/${dateCheck.value}`;

  try {
    const json: any = await fetchJson(url, { timeoutMs: 5000, retries: 2 });
    const cs = json?.data?.candlestick?.[0];
    const ohlcvs: unknown[] = cs?.ohlcv ?? [];

    if (ohlcvs.length === 0) {
      return fail(`ローソク足データが見つかりません (${chk.pair} / ${type} / ${dateCheck.value})`, 'user');
    }

    const rows = (ohlcvs as any[]).slice(-limitCheck.value);

    const normalized = rows.map(([o, h, l, c, v, ts]) => ({
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
      isoTime: toIso(ts) ?? undefined,
    }));

    const summary = formatSummary({
      pair: chk.pair,
      timeframe: String(type),
      latest: normalized.at(-1)?.close,
    });

    const result = ok<GetCandlesData, GetCandlesMeta>(
      summary,
      { raw: json, normalized } as GetCandlesData,
      createMeta(chk.pair, { type, count: normalized.length }) as GetCandlesMeta
    );
    return GetCandlesOutputSchema.parse(result) as unknown as Result<GetCandlesData, GetCandlesMeta>;
  } catch (e: any) {
    return GetCandlesOutputSchema.parse(fail(e?.message || 'ネットワークエラー', 'network')) as unknown as Result<GetCandlesData, GetCandlesMeta>;
  }
}


