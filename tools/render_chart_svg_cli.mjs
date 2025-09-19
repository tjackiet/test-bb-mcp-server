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
  const noSma = flagArgs.has('--no-sma');
  const noBb = flagArgs.has('--no-bb');
  const smaOnly = flagArgs.has('--sma-only');
  const bbOnly = flagArgs.has('--bb-only');
  const ichimokuOnly = flagArgs.has('--ichimoku-only');
  
  // デフォルト（軽量版）: SMA 25/75/200
  // オプション: --sma=5,20,50 など指定時のみ追加描画
  const options = {
    pair,
    type,
    limit,
    // 既定はSMA描画なし（--sma-only や --sma= 指定で有効化）
    withSMA: noSma ? [] : [],
    withBB: !noBb,
    withIchimoku: withIchimoku,
  };
  
  // Ichimoku モード
  const modeFlag = args.find(a => a.startsWith('--ichimoku-mode='));
  if (modeFlag) {
    const mode = modeFlag.split('=')[1];
    options.ichimoku = { mode };
    options.withIchimoku = true; // モード指定時は自動で有効化
  }

  // BollingerBands モード: --bb-mode=default|extended（後方互換で light/full も受け付け）
  const bbModeFlag = args.find(a => a.startsWith('--bb-mode='));
  if (bbModeFlag) {
    const bbMode = bbModeFlag.split('=')[1];
    const normalized = bbMode === 'light' ? 'default' : bbMode === 'full' ? 'extended' : bbMode;
    if (normalized === 'default' || normalized === 'extended') {
      options.bbMode = normalized;
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

  // --- Heuristics: 単独表示を優先 ---
  // 明示フラグ
  if (smaOnly) {
    options.withBB = false;
    options.withIchimoku = false;
  }
  if (bbOnly) {
    options.withBB = true;
    options.withSMA = [];
    options.withIchimoku = false;
  }
  if (ichimokuOnly) {
    options.withIchimoku = true;
    options.withBB = false;
    options.withSMA = [];
    if (!options.ichimoku) options.ichimoku = { mode: 'default' };
  }

  // 自動判定
  const hasSmaFlag = Boolean(smaFlag);
  const hasBbMode = Boolean(bbModeFlag);
  if (options.withIchimoku) {
    // 実装側でも排他するが、CLIでも明示
    options.withBB = false;
    options.withSMA = [];
  } else if (hasBbMode) {
    // BBモード指定時はSMAを自動でオフ（ユーザーが--smaや--no-smaを明示した場合は尊重）
    if (!hasSmaFlag && !noSma) {
      options.withSMA = [];
    }
    options.withBB = true;
  } else if (hasSmaFlag && !noBb) {
    // SMAを明示指定し、BB指定が無い場合はBBを自動オフ
    options.withBB = false;
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
