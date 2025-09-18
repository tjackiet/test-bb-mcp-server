// get_orderbook.js
// 使い方: node get_orderbook.js btc_jpy 5   ← topN=5（省略可）

import { ensurePair, validateLimit, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';

function ms(ts) {
  const d = new Date(Number(ts));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

function toLevels(arr, n) {
  // arr = [["price","size"], ...]
  const out = (arr || []).slice(0, n).map(([p, s]) => ({
    price: Number(p),
    size: Number(s),
  }));
  // 累積数量も付与（見やすさ用）
  let cum = 0;
  for (const lvl of out) {
    cum += Number.isFinite(lvl.size) ? lvl.size : 0;
    lvl.cumSize = Number(cum.toFixed(8));
  }
  return out;
}

/**
 * @typedef {object} GetOrderbookOptions
 * @property {number} [timeoutMs=2500]
 */
/**
 * @param {string} pair
 * @param {number} [topN=5]
 * @param {GetOrderbookOptions} [options]
 * @returns {Promise<import('../src/types/domain.d').Result<import('../src/types/domain.d').GetOrderbookData, import('../src/types/domain.d').GetOrderbookMeta>>}
 */
async function getOrderbook(pair, topN = 5, { timeoutMs = 2500 } = {}) {
  // ペアバリデーション
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  // topNバリデーション
  const limitCheck = validateLimit(topN, 1, 50, 'topN');
  if (!limitCheck.ok) return fail(limitCheck.error.message, limitCheck.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/depth`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      return fail(`HTTP ${res.status} ${res.statusText}`, 'service');
    }
    const json = await res.json();
    // 期待形: { success: 1, data: { asks: [["p","s"],...], bids:[...], timestamp } }
    const d = json?.data ?? {};
    const asks = toLevels(d.asks, limitCheck.value); // 売り板（安い→高い 順に来る想定）
    const bids = toLevels(d.bids, limitCheck.value); // 買い板（高い→安い 順に来る想定）

    const bestAsk = asks[0]?.price ?? null;
    const bestBid = bids[0]?.price ?? null;
    const spread =
      bestAsk != null && bestBid != null
        ? Number((bestAsk - bestBid).toFixed(0))
        : null;
    const mid =
      bestAsk != null && bestBid != null
        ? Number(((bestAsk + bestBid) / 2).toFixed(2))
        : null;

    const summary = formatSummary({
      pair: chk.pair,
      latest: mid,
      extra: `bid=${bestBid ?? 'N/A'} ask=${bestAsk ?? 'N/A'} spread=${
        spread ?? 'N/A'
      }`,
    });

    const data = {
      raw: json,
      normalized: {
        pair: chk.pair,
        bestBid,
        bestAsk,
        spread,
        mid,
        bids,
        asks,
        timestamp: d.timestamp ?? null,
        isoTime: ms(d.timestamp),
      },
    };
    const meta = createMeta(chk.pair, {
      topN: limitCheck.value,
      count: asks.length + bids.length,
    });

    return ok(summary, data, meta);
  } catch (err) {
    clearTimeout(t);
    const isAbort = err?.name === 'AbortError';
    const message = isAbort
      ? `タイムアウト (${timeoutMs}ms)`
      : err?.message || 'ネットワークエラー';
    return fail(message, isAbort ? 'timeout' : 'network');
  }
}

// CLI 実行
if (import.meta.url === `file://${process.argv[1]}`) {
  const pair = process.argv[2] || 'btc_jpy';
  const topN = process.argv[3] ? Number(process.argv[3]) : 5;
  getOrderbook(pair, topN).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });
}

export default getOrderbook;
