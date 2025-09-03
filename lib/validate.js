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

// 共通バリデーション関数
export function validateLimit(limit, min = 1, max = 1000, paramName = 'limit') {
  const num = Number(limit);
  if (!Number.isInteger(num) || num < min || num > max) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `${paramName} は ${min}〜${max} の整数で指定してください（指定値: ${limit}）`,
      },
    };
  }
  return { ok: true, value: num };
}

export function validateDate(date, type = null) {
  // typeが指定されている場合の日付形式チェック
  if (type) {
    const TYPES_REQUIRE_YYYYMMDD = new Set([
      '1min', '5min', '15min', '30min',
      '1hour', '4hour', '8hour', '12hour'
    ]);
    
    if (TYPES_REQUIRE_YYYYMMDD.has(type)) {
      if (!/^\d{8}$/.test(date)) {
        return {
          ok: false,
          error: {
            type: 'user',
            message: `${type} の場合、date は YYYYMMDD 形式で指定してください（指定値: ${date}）`,
          },
        };
      }
      return { ok: true, value: date };
    } else {
      // YYYYMMDD形式が与えられてもYYYYに変換
      if (!/^\d{4,8}$/.test(date)) {
        return {
          ok: false,
          error: {
            type: 'user',
            message: `date は YYYY または YYYYMMDD 形式で指定してください（指定値: ${date}）`,
          },
        };
      }
      return { ok: true, value: String(date).substring(0, 4) };
    }
  }
  
  // typeが指定されていない場合の一般的な日付チェック
  if (!/^\d{4,8}$/.test(date)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `date は YYYY または YYYYMMDD 形式で指定してください（指定値: ${date}）`,
      },
    };
  }
  return { ok: true, value: date };
}

// 共通のメタ情報生成
export function createMeta(pair, additional = {}) {
  return {
    pair,
    fetchedAt: new Date().toISOString(),
    ...additional
  };
}
