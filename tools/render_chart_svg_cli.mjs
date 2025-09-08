// tools/render_chart_svg_cli.mjs
import renderChartSvg from './render_chart_svg.js';

async function main() {
  const pair = process.argv[2] || 'btc_jpy';
  const type = process.argv[3] || '1day';
  const limit = process.argv[4] ? parseInt(process.argv[4], 10) : 60;

  const result = await renderChartSvg({ pair, type, limit });

  if (result.ok) {
    // SVGデータを標準出力に書き出す
    console.log(result.data.svg);
  } else {
    console.error('Failed to generate chart:', result.error.message);
    process.exit(1);
  }
}

main();
