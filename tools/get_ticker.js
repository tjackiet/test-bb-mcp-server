// get_ticker.js
// 使い方: node get_ticker.js btc_jpy

const ALLOWED = new Set([
  // よく使う例。必要に応じて増やしてください
  'btc_jpy',
  'eth_jpy',
  'xrp_jpy',
  'ltc_jpy',
  'bcc_jpy',
]);

function normalizePair(raw) {
  if (!raw) return null;
  const s = String(raw)
    .trim()
    .toLowerCase()
    .replace('/', '_')
    .replace('-', '_');
  return s;
}

function ms(ts) {
  const d = new Date(Number(ts));
  return isNaN(d) ? null : d.toISOString();
}

async function getTicker(pair, { timeoutMs = 2500 } = {}) {
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

  const url = `https://public.bitbank.cc/${normalized}/ticker`;

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

    // 想定レスポンス: { success: 1, data: { buy, sell, last, vol, timestamp, ... } }
    const d = json?.data ?? {};
    const summary = `pair=${normalized} last=${d.last ?? 'N/A'} buy=${
      d.buy ?? 'N/A'
    } sell=${d.sell ?? 'N/A'} ts=${ms(d.timestamp) ?? 'N/A'}`;

    return {
      ok: true,
      summary,
      data: {
        raw: json,
        normalized: {
          pair: normalized,
          last: d.last ? Number(d.last) : null,
          buy: d.buy ? Number(d.buy) : null,
          sell: d.sell ? Number(d.sell) : null,
          volume: d.vol ? Number(d.vol) : null,
          timestamp: d.timestamp ? Number(d.timestamp) : null,
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
  getTicker(pair).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });
}

export default getTicker;
