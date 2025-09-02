// get_orderbook.js
// 使い方: node get_orderbook.js btc_jpy 5   ← topN=5（省略可）

const ALLOWED = new Set([
  'btc_jpy',
  'eth_jpy',
  'xrp_jpy',
  'ltc_jpy',
  'bcc_jpy',
]);

function normalizePair(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase().replace(/[\/-]/g, '_');
}
function ms(ts) {
  const d = new Date(Number(ts));
  return isNaN(d) ? null : d.toISOString();
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
    cum += isFinite(lvl.size) ? lvl.size : 0;
    lvl.cumSize = Number(cum.toFixed(8));
  }
  return out;
}

async function getOrderbook(pair, topN = 5, { timeoutMs = 2500 } = {}) {
  const normalized = normalizePair(pair);
  if (!normalized || !/^[a-z0-9]+_[a-z0-9]+$/.test(normalized)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `pair '${pair}' が不正です（例: btc_jpy）`,
      },
    };
  }
  if (!ALLOWED.has(normalized)) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `未対応のpairです: '${normalized}'（対応例: ${[
          ...ALLOWED,
        ].join(', ')})`,
      },
    };
  }
  const n = Number(topN);
  if (!Number.isInteger(n) || n <= 0 || n > 50) {
    return {
      ok: false,
      error: {
        type: 'user',
        message: `topN は 1〜50 の整数で指定してください（指定値: ${topN}）`,
      },
    };
  }

  const url = `https://public.bitbank.cc/${normalized}/depth`;

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
    const asks = toLevels(d.asks, n); // 売り板（安い→高い 順に来る想定）
    const bids = toLevels(d.bids, n); // 買い板（高い→安い 順に来る想定）

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
      `pair=${normalized} bid=${bestBid ?? 'N/A'} ask=${bestAsk ?? 'N/A'} ` +
      `spread=${spread ?? 'N/A'} levels=${n} ts=${ms(d.timestamp) ?? 'N/A'}`;

    return {
      ok: true,
      summary,
      data: {
        raw: json,
        normalized: {
          pair: normalized,
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
      meta: { pair: normalized, ts: new Date().toISOString() },
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
