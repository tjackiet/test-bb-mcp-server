// lib/formatter.js
export function formatPair(pair) {
  return (pair || '').toUpperCase().replace('_', '/'); // btc_jpy -> BTC/JPY
}

export function formatSummary({ pair, timeframe, latest, extra } = {}) {
  const p = formatPair(pair);
  const tf = timeframe ? ` [${timeframe}]` : '';
  const price =
    typeof latest === 'number'
      ? ` close=${latest.toLocaleString('ja-JP')}`
      : '';
  const tail = extra ? ` ${extra}` : '';
  return `${p}${tf}${price}${tail}`.trim();
}
