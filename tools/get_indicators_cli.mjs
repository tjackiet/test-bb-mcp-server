import getIndicators from './get_indicators.js';

async function main() {
  const [pair, type, limit] = process.argv.slice(2);

  if (!pair) {
    console.error('Usage: node tools/get_indicators_cli.mjs <pair> [type] [limit]');
    console.error('Example: node tools/get_indicators_cli.mjs btc_jpy 1day');
    console.error('Example: node tools/get_indicators_cli.mjs btc_jpy 1hour 200');
    process.exit(1);
  }

  try {
    const result = await getIndicators(pair, type, limit);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error calculating indicators:', error);
    process.exit(1);
  }
}

main();

// 実行例:
// bash
// node tools/get_indicators_cli.mjs btc_jpy 1day 90 | jq '.data.indicators'

