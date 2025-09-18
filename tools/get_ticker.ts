import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
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
  { timeoutMs = 2500 }: GetTickerOptions = {}
): Promise<Result<GetTickerData, GetTickerMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/ticker`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      return fail(`HTTP ${res.status} ${res.statusText}`, 'service');
    }
    const json: any = await res.json();

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

    return ok(summary, data, createMeta(chk.pair));
  } catch (err: any) {
    clearTimeout(t);
    const isAbort = err?.name === 'AbortError';
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : err?.message || 'ネットワークエラー';
    return fail(message, isAbort ? 'timeout' : 'network');
  }
}


