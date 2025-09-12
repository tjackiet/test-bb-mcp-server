// tools/render_chart_svg_cli.mjs
import renderChartSvg from './render_chart_svg.js';

async function main() {
  const args = process.argv.slice(2);
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
  const flagArgs = new Set(args.filter((arg) => arg.startsWith('--')));

  const pair = positionalArgs[0] || 'btc_jpy';
  const type = positionalArgs[1] || '1day';
  const limit = positionalArgs[2] ? parseInt(positionalArgs[2], 10) : 60;

  const withIchimoku = flagArgs.has('--with-ichimoku');
  
  // デフォルト（軽量版）: SMA 25/75/200
  // オプション: --sma=5,20,50 など指定時のみ追加描画
  const options = {
    pair,
    type,
    limit,
    withSMA: flagArgs.has('--no-sma') ? [] : [25, 75, 200],
    withBB: !flagArgs.has('--no-bb'),
    withIchimoku: withIchimoku,
  };
  
  // Ichimoku モード
  const modeFlag = args.find(a => a.startsWith('--ichimoku-mode='));
  if (modeFlag) {
    const mode = modeFlag.split('=')[1];
    options.ichimoku = { mode };
    options.withIchimoku = true; // モード指定時は自動で有効化
  }

  // BollingerBands モード: --bb-mode=light|full
  const bbModeFlag = args.find(a => a.startsWith('--bb-mode='));
  if (bbModeFlag) {
    const bbMode = bbModeFlag.split('=')[1];
    if (bbMode === 'light' || bbMode === 'full') {
      options.bbMode = bbMode;
    }
  }

  // --- New: SMA periods ---
  const smaFlag = args.find(a => a.startsWith('--sma='));
  if (smaFlag) {
    const list = smaFlag.split('=')[1];
    if (list && list.length > 0) {
      const periods = list.split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
      if (periods.length > 0) {
        options.withSMA = periods;
      }
    }
  }

  const result = await renderChartSvg(options);

  if (result.ok) {
    // 出力の安定化
    if (result.data.filePath) {
      console.error(`Chart saved to ${result.data.filePath}`);
    }
    console.log(result.data.svg);
  } else {
    console.error('Failed to generate chart:', result.summary);
    process.exit(1);
  }
}

main();
