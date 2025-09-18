// 使い方: node tools/get_candles_cli.mjs btc_jpy 1day 20240510 | jq '.data.normalized.items'
// type: 1min,5min,15min,30min,1hour,4hour,8hour,12hour,1day,1week,1month
// date: typeにより YYYYMMDD または YYYY（1month）

import { fetchJson } from '../lib/http.js';
import {
  ensurePair,
  validateLimit,
  validateDate,
  createMeta,
} from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';

const TYPES = new Set([
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

function todayYyyymmdd() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
}

const toIso = (ms) => {
  const d = new Date(Number(ms));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
};

/**
 * @param {string} pair
 * @param {import('../src/types/domain.d').CandleType | string} [type='1day']
 * @param {string} [date]
 * @param {number} [limit=200]
 * @returns {Promise<import('../src/types/domain.d').Result<import('../src/types/domain.d').GetCandlesData, import('../src/types/domain.d').GetCandlesMeta>>}
 */
export default async function getCandles(
  pair,
  type = '1day',
  date = todayYyyymmdd(),
  limit = 200
) {
  // 入力バリデーション
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  if (!TYPES.has(type)) {
    return fail(
      `type は ${[...TYPES].join(', ')} から選択してください（指定値: ${type}）`,
      'user'
    );
  }

  // 日付バリデーション
  const dateCheck = validateDate(date, type);
  if (!dateCheck.ok) return fail(dateCheck.error.message, dateCheck.error.type);

  // limitバリデーション
  const limitCheck = validateLimit(limit, 1, 1000);
  if (!limitCheck.ok) return fail(limitCheck.error.message, limitCheck.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/candlestick/${type}/${dateCheck.value}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 3000, retries: 2 });
    // 期待形:
    // { success:1, data:{ candlestick:[{ type, ohlcv:[[open,high,low,close,volume,timestamp], ...] }], timestamp } }
    const cs = json?.data?.candlestick?.[0];
    const ohlcvs = cs?.ohlcv ?? [];

    if (ohlcvs.length === 0) {
      return fail(
        `ローソク足データが見つかりません (${chk.pair} / ${type} / ${dateCheck.value})`,
        'user'
      );
    }

    // 最新に近い側を limit 件抽出（配列末尾側が新しい想定）
    const rows = ohlcvs.slice(-limitCheck.value);

    const normalized = rows.map(([o, h, l, c, v, ts]) => ({
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
      isoTime: toIso(ts),
    }));

    const summary = formatSummary({
      pair: chk.pair,
      timeframe: type,
      latest: normalized.at(-1)?.close,
    });

    const result = ok(
      summary,
      { raw: json, normalized },
      createMeta(chk.pair, { type, count: normalized.length })
    );
    return result;
  } catch (e) {
    return fail(e?.message || 'ネットワークエラー', 'network');
  }
}
