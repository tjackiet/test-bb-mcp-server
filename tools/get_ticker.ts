import { ensurePair, createMeta } from '../lib/validate.js';
import { fetchJson } from '../lib/http.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { GetTickerOutputSchema } from '../src/schemas.js';
import type { Result, GetTickerData, GetTickerMeta } from '../src/types/domain.d.ts';

export interface GetTickerOptions {
  timeoutMs?: number;
}

function toIsoTime(ts: unknown): string | null {
  const d = new Date(Number(ts));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

export default async function getTicker(
  pair: string,
  { timeoutMs = 5000 }: GetTickerOptions = {}
): Promise<Result<GetTickerData, GetTickerMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/ticker`;

  try {
    const json: any = await fetchJson(url, { timeoutMs, retries: 2 });

    const d = json?.data ?? {};
    const summary = formatSummary({
      pair: chk.pair,
      latest: d.last != null ? Number(d.last) : undefined,
      extra: `buy=${d.buy ?? 'N/A'} sell=${d.sell ?? 'N/A'}`,
    });

    const data: GetTickerData = {
      raw: json,
      normalized: {
        pair: chk.pair,
        last: d.last != null ? Number(d.last) : null,
        buy: d.buy != null ? Number(d.buy) : null,
        sell: d.sell != null ? Number(d.sell) : null,
        volume: d.vol != null ? Number(d.vol) : null,
        timestamp: d.timestamp != null ? Number(d.timestamp) : null,
        isoTime: toIsoTime(d.timestamp),
      },
    };

    return GetTickerOutputSchema.parse(ok(summary, data, createMeta(chk.pair))) as unknown as Result<GetTickerData, GetTickerMeta>;
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError';
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : err?.message || 'ネットワークエラー';
    return GetTickerOutputSchema.parse(fail(message, isAbort ? 'timeout' : 'network')) as unknown as Result<GetTickerData, GetTickerMeta>;
  }
}


