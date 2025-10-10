import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { GetCircuitBreakInfoOutputSchema } from '../src/schemas.js';

function toIso(ts: unknown): string | null {
  const n = Number(ts);
  const d = new Date(n);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

export default async function getCircuitBreakInfo(pair: string = 'btc_jpy') {
  const chk = ensurePair(pair);
  if (!chk.ok) return GetCircuitBreakInfoOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  // 公開APIの有無が不明なため、暫定のnull埋めスキーマを返す
  const info = {
    mode: 'unknown' as 'unknown',
    estimated_itayose_price: null,
    estimated_itayose_amount: null,
    reopen_timestamp: null,
    reopen_isoTime: null,
  };

  const summary = formatSummary({ pair: chk.pair, latest: undefined, extra: 'circuit-break info: unavailable (placeholder)' });
  const meta = createMeta(chk.pair, { source: 'none' });

  return GetCircuitBreakInfoOutputSchema.parse(ok(summary, { info } as any, meta as any)) as any;
}


