// get_ticker.js
// 使い方: node get_ticker.js btc_jpy

import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';

function ms(ts) {
  const d = new Date(Number(ts));
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

/**
 * @typedef {object} GetTickerOptions
 * @property {number} [timeoutMs=2500]
 */
/**
 * @param {string} pair
 * @param {GetTickerOptions} [options]
 * @returns {Promise<import('../src/types/domain.d').Result<import('../src/types/domain.d').GetTickerData, import('../src/types/domain.d').GetTickerMeta>>}
 */
async function getTicker(pair, { timeoutMs = 2500 } = {}) {
  // ペアバリデーション
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const url = `https://public.bitbank.cc/${chk.pair}/ticker`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      return fail(`HTTP ${res.status} ${res.statusText}`, 'service');
    }
    const json = await res.json();

    // 想定レスポンス: { success: 1, data: { buy, sell, last, vol, timestamp, ... } }
    const d = json?.data ?? {};
    const summary = formatSummary({
      pair: chk.pair,
      latest: d.last ? Number(d.last) : null,
      extra: `buy=${d.buy ?? 'N/A'} sell=${d.sell ?? 'N/A'}`,
    });

    const data = {
      raw: json,
      normalized: {
        pair: chk.pair,
        last: d.last ? Number(d.last) : null,
        buy: d.buy ? Number(d.buy) : null,
        sell: d.sell ? Number(d.sell) : null,
        volume: d.vol ? Number(d.vol) : null,
        timestamp: d.timestamp ? Number(d.timestamp) : null,
        isoTime: ms(d.timestamp),
      },
    };

    return ok(summary, data, createMeta(chk.pair));
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
  getTicker(pair).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });
}

export default getTicker;
