// 使い方: node tools/get_candles_cli.mjs btc_jpy 1day 20240510 | jq '.data.normalized.items'
// type: 1min,5min,15min,30min,1hour,4hour,8hour,12hour,1day,1week,1month
// date: typeにより YYYYMMDD または YYYY（1month）

import { fetchJson } from '../lib/http.js';
import { ensurePair } from '../lib/validate.js';

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

const TYPES_REQUIRE_YYYYMMDD = new Set([
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '12hour',
]);

function todayYyyymmdd() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
}
// ...TYPES 定義などはそのまま...

const toIso = (ms) => {
  const d = new Date(Number(ms));
  return isNaN(d) ? null : d.toISOString();
};

export default async function getCandles(
  pair,
  type = '1day',
  date = todayYyyymmdd(),
  limit = 200
) {
  // 入力バリデーション
  const chk = ensurePair(pair);
  if (!chk.ok) return chk;

  if (!TYPES.has(type)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `type は ${[...TYPES].join(', ')} から選択（指定: ${type}）`,
      },
    };
  }

  // APIに渡す日付文字列を決定
  let dateForApi;
  if (TYPES_REQUIRE_YYYYMMDD.has(type)) {
    if (!/^\d{8}$/.test(date)) {
      return {
        ok: false,
        error: {
          type: 'user',
          message: `${type} の場合、date は YYYYMMDD 形式で指定（指定: ${date}）`,
        },
      };
    }
    dateForApi = date;
  } else {
    // YYYYMMDD形式が与えられてもYYYYに変換
    if (!/^\d{4,8}$/.test(date)) {
      return {
        ok: false,
        error: {
          type: 'user',
          message: `date は YYYY または YYYYMMDD 形式で指定（指定: ${date}）`,
        },
      };
    }
    dateForApi = String(date).substring(0, 4);
  }

  const lim = Number(limit);
  if (!Number.isInteger(lim) || lim <= 0 || lim > 1000) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `limit は 1〜1000 の整数（指定: ${limit}）`,
      },
    };
  }

  const url = `https://public.bitbank.cc/${chk.pair}/candlestick/${type}/${dateForApi}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 3000, retries: 2 });
    // 期待形:
    // { success:1, data:{ candlestick:[{ type, ohlcv:[[open,high,low,close,volume,timestamp], ...] }], timestamp } }
    const cs = json?.data?.candlestick?.[0];
    const ohlcvs = cs?.ohlcv ?? [];

    // 最新に近い側を limit 件抽出（配列末尾側が新しい想定）
    const rows = ohlcvs.slice(-lim);

    const normalized = rows.map(([o, h, l, c, v, ts]) => ({
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
      isoTime: toIso(ts),
    }));

    const latestClose = normalized.at(-1)?.close ?? 'N/A';
    const summary = `${chk.pair} ${type} candles (latest close=${latestClose})`;

    return {
      ok: true,
      summary,
      data: { raw: json, normalized },
      meta: {},
    };
  } catch (e) {
    return {
      ok: false,
      error: { type: 'network', message: e?.message || 'ネットワークエラー' },
    };
  }
}
