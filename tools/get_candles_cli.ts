import getCandles from './get_candles.js';

async function main() {
  const [pair, type, date, limitStr] = process.argv.slice(2);

  if (!pair || !type) {
    console.error('Usage: tsx tools/get_candles_cli.ts <pair> <type> [date:YYYY|YYYYMMDD] [limit]');
    console.error('Example: tsx tools/get_candles_cli.ts btc_jpy 1hour 20240511');
    console.error('Example: tsx tools/get_candles_cli.ts btc_jpy 1month 2024');
    process.exit(1);
  }

  try {
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const result = await getCandles(pair, type as any, date as any, limit as any);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error fetching candles:', error);
    process.exit(1);
  }
}

main();


