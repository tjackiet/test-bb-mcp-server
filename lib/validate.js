// ペアのバリデーション
export const ALLOWED_PAIRS = new Set([
  'btc_jpy',
  'eth_jpy',
  'xrp_jpy',
  'ltc_jpy',
  'bcc_jpy',
]);

export function normalizePair(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase().replace(/[\/-]/g, '_');
}

export function ensurePair(pair) {
  const norm = normalizePair(pair);
  if (!norm || !/^[a-z0-9]+_[a-z0-9]+$/.test(norm)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `pair '${pair}' が不正です（例: btc_jpy）`,
      },
    };
  }
  if (!ALLOWED_PAIRS.has(norm)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `未対応のpair: '${norm}'（対応例: ${[...ALLOWED_PAIRS].join(
          ', '
        )})`,
      },
    };
  }
  return { ok: true, pair: norm };
}
