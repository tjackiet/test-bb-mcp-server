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

  // 現時点では bitbank Public API にサーキットブレイク相当の情報源がありません
  // LLMやユーザーが誤って呼ばないよう、常に ok=false で未対応を明示します
  const summary = 'Error: circuit break info is not available (unsupported)';
  return GetCircuitBreakInfoOutputSchema.parse(fail(summary.replace('Error: ', ''), 'user', { reason: 'unsupported', available: false })) as any;
}


