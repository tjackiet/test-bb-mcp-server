import analyzeIndicators from './analyze_indicators.js';

async function main() {
  const [pair, type, limitStr] = process.argv.slice(2);

  if (!pair) {
    console.error('Usage: tsx tools/get_indicators_cli.ts <pair> [type] [limit]');
    console.error('Example: tsx tools/get_indicators_cli.ts btc_jpy 1day');
    console.error('Example: tsx tools/get_indicators_cli.ts btc_jpy 1hour 200');
    process.exit(1);
  }

  try {
    const result = await analyzeIndicators(pair, (type as any) || '1day', limitStr ? parseInt(limitStr, 10) : undefined);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error fetching indicators:', error);
    process.exit(1);
  }
}

main();


