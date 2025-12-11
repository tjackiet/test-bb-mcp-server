# Cursor Rules for bitbank-mcp-server

## チャート生成に関するAI利用ポリシー

- 重要: チャート描画は必ず `tools/render_chart_svg.ts` を使用すること。
  - AI（Claude/GPT）は独自に可視化コード（D3/Chart.js/Canvas/SVG等）を生成してはいけない。
  - Artifact は「ツールの出力（SVG文字列）」をそのまま表示する用途に限定する。
  - インタラクティブ可視化や独自JSの生成は本プロジェクトでは禁止。

## ボリンジャーバンドの描画仕様

- 軽量版（デフォルト）: BB ±2σ のみ描画。
  - CLI例: `npx tsx tools/render_chart_svg_cli.ts <pair> <type> <limit> --bb-mode=default`
- 完全版（オプション）: BB ±1σ, ±2σ, ±3σ を描画。
  - CLI例: `npx tsx tools/render_chart_svg_cli.ts <pair> <type> <limit> --bb-mode=extended`
- `--no-bb` 指定時はボリンジャーバンドを描画しない。
- 後方互換: `--bb-mode=light` は `default`、`--bb-mode=full` は `extended` として扱われる。

## 一目均衡表の描画仕様

- 標準（default）: 転換線・基準線・雲（先行スパンA/B）のみ。
- 拡張（extended）: 上記に加えて遅行スパンも描画（`--ichimoku-mode=extended`）。
- 指定がない場合、`withIchimoku` はオフ。

## SMA の描画仕様

- デフォルト: SMAは描画しない。
- オプション: `--sma=5,20,50` 等で明示的に指定した場合のみ描画する。
- 利用可能な期間: 5, 20, 25, 50, 75, 200

## 実装原則

- AI は「チャートを出す」要求に対し、内部実装や独自レンダラではなく、必ず以下の関数/CLIを呼ぶこと:
  - Node API: `renderChartSvg(options)`
  - CLI: `npx tsx tools/render_chart_svg_cli.ts <pair> <type> <limit> [--flags]`
- Artifact の内容は `renderChartSvg` の返す `data.svg` をそのまま表示すること。
- 大きな変更を行う場合は README の該当箇所も更新すること。

## 参考

- BBサンプル: `assets/bb_light.svg`
- 一目均衡表サンプル: `assets/ichimoku_sample.svg`
- ローソク足パターンサンプル: `assets/candle_pattern_test.svg`

## メンテナンスルール

- `.cursorrules` と `.claude/CLAUDE.md` は同じ内容を維持すること。
- 片方を編集した場合は、もう一方も必ず更新する。
  - 同期コマンド: `cp .cursorrules .claude/CLAUDE.md`
