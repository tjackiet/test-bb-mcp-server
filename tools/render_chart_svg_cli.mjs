// tools/render_chart_svg_cli.mjs
import renderChartSvg from './render_chart_svg.js';

async function main() {
  const args = process.argv.slice(2);
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
  const flagArgs = new Set(args.filter((arg) => arg.startsWith('--')));

  const pair = positionalArgs[0] || 'btc_jpy';
  const type = positionalArgs[1] || '1day';
  const limit = positionalArgs[2] ? parseInt(positionalArgs[2], 10) : 60;

  const options = {
    pair,
    type,
    limit,
    withSMA: flagArgs.has('--no-sma') ? [] : [25, 75],
    withBB: !flagArgs.has('--no-bb'),
    withIchimoku: flagArgs.has('--with-ichimoku'),
  };

  const result = await renderChartSvg(options);

  if (result.ok) {
    // SVGデータを標準出力に書き出す
    console.log(result.data.svg);
  } else {
    console.error('Failed to generate chart:', result.summary);
    process.exit(1);
  }
}

main();
