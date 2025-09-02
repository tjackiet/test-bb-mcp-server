// tools/get_candles.js
import { fetchJson } from '../lib/http.js';
import { ensurePair } from '../lib/validate.js';

const TYPES = new Set([
  '1min','5min','15min','30min',
  '1hour','4hour','8hour','12hour',
  '1day','1week','1month',
]);

// 1month は YYYY、その他は YYYYMMDD
const isMonthBased = (type) => type === '1month';

const todayYyyymmdd = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
};

const toIso = (ms) => {
  const d = new Date(Number(ms));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
};

/**
 * Get candles
 * @param {string} pair - e.g. "btc_jpy"
 * @param {string} type - 1min..1month
 * @param {string} date - 1month→YYYY, others→YYYYMMDD
 * @param {number} limit - 1..1000
 */
export default async function getCandles(
  pair,
  type = '1day',
  date = todayYyyymmdd(),
  limit = 200
) {
  // pair 正規化
  const chk = ensurePair(pair);
  if (!chk.ok) return chk;

  // type
  if (!TYPES.has(type)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `type は ${[...TYPES].join(', ')} から選択（指定: ${type}）`,
      },
    };
  }

  // date
  if (isMonthBased(type)) {
    if (!/^\d{4}$/.test(date)) {
      return { ok:false, error:{ type:'user', message:`${type} の date は YYYY（例: 2025）` } };
    }
  } else {
    if (!/^\d{8}$/.test(date)) {
      return { ok:false, error:{ type:'user', message:`${type} の date は YYYYMMDD（例: 20250902）` } };
    }
  }

  // limit
  const lim = Number(limit);
  if (!Number.isInteger(lim) || lim < 1 || lim > 1000) {
    return {
      ok: false,
      error: { type: 'user', message: `limit は 1〜1000 の整数（指定: ${limit}）` },
    };
  }

  const url = `https://public.bitbank.cc/${chk.pair}/candlestick/${type}/${date}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 3000, retries: 2 });
    // 期待: { success:1, data:{ candlestick:[{ type, ohlcv:[[o,h,l,c,v,ts],...]}], timestamp } }
    const cs = json?.data?.candlestick?.[0];
    const ohlcvs = Array.isArray(cs?.ohlcv) ? cs.ohlcv : [];

    // 末尾（新しい方）から limit 件
    const rows = ohlcvs.slice(-lim);

    const items = rows.map(([o, h, l, c, v, ts]) => ({
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
      timestamp: Number(ts),
      isoTime: toIso(ts),
    }));

    const summary = `pair=${chk.pair} type=${type} bars=${items.length} from=${items[0]?.isoTime ?? 'N/A'} to=${items.at(-1)?.isoTime ?? 'N/A'}`;

    return {
      ok: true,
      summary,
      data: {
        raw: json,
        normalized: { pair: chk.pair, type, items },
      },
      meta: { pair: chk.pair, ts: new Date().toISOString() },
    };
  } catch (e) {
    return {
      ok: false,
      error: { type: 'network', message: e?.message || 'ネットワークエラー' },
    };
  }
}
