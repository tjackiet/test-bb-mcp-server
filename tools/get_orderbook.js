// get_orderbook.js
// 使い方: node get_orderbook.js btc_jpy 5   ← topN=5（省略可）

import { ensurePair, validateLimit, createMeta } from '../lib/validate.js';

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

async function getOrderbook(pair, topN = 5, { timeoutMs = 2500 } = {}) {
  // ペアバリデーション
  const chk = ensurePair(pair);
  if (!chk.ok) return chk;

  // topNバリデーション
  const limitCheck = validateLimit(topN, 1, 50, 'topN');
  if (!limitCheck.ok) return limitCheck;

  const url = `https://public.bitbank.cc/${chk.pair}/depth`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      return {
        ok: false,
        error: {
          type: 'service',
          message: `HTTP ${res.status} ${res.statusText}`,
        },
      };
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

    const summary =
      `pair=${chk.pair} bid=${bestBid ?? 'N/A'} ask=${bestAsk ?? 'N/A'} ` +
      `spread=${spread ?? 'N/A'} levels=${limitCheck.value} ts=${ms(d.timestamp) ?? 'N/A'}`;

    return {
      ok: true,
      summary,
      data: {
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
      },
      meta: createMeta(chk.pair, { topN: limitCheck.value, count: asks.length + bids.length }),
    };
  } catch (err) {
    clearTimeout(t);
    const isAbort = err?.name === 'AbortError';
    return {
      ok: false,
      error: {
        type: isAbort ? 'timeout' : 'network',
        message: isAbort
          ? `タイムアウト (${timeoutMs}ms)`
          : err?.message || 'ネットワークエラー',
      },
    };
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
