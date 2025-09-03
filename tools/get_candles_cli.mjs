import getCandles from './get_candles.js';

async function main() {
  const [pair, type, date, limit] = process.argv.slice(2);

  if (!pair || !type) {
    console.error('Usage: node tools/get_candles_cli.mjs <pair> <type> [date:YYYY|YYYYMMDD] [limit]');
    console.error('Example: node tools/get_candles_cli.mjs btc_jpy 1hour 20240511');
    console.error('Example: node tools/get_candles_cli.mjs btc_jpy 1month 2024');
    process.exit(1);
  }

  try {
    const result = await getCandles(pair, type, date, limit);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error fetching candles:', error);
    process.exit(1);
  }
}

main();
