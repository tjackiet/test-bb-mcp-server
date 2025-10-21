---
name: charting_rules
description: チャート描画のプロジェクト規約（必ず render_chart_svg を使用し、既定で描画しない）。
tags: [chart, policy]
---

## Policy
- チャート描画は必ず `render_chart_svg` を使う。独自のSVG/Canvas/JS生成は禁止。
- 既定は描画しない。ユーザーが明示したときのみ描画する。
- 保存に失敗した場合でも `data.svg` をそのままArtifact表示すればよい（ユーザー向けエラー文言は出さない）。

### Ichimoku に関する重要ガイド
- 一目均衡表の分析は「視覚的主張」を避け、数値スナップショットで評価する。
- 具体的には `bitbank-mcp:analyze_ichimoku_snapshot` を使用し、以下のように数値を根拠として示す。
  - 例: `転換線366.5が基準線370.2を下回り（-3.7）、価格370.3は雲下（spanB=385.0より-14.7）`
- チャートの提示が明示要求された場合のみ `render_chart_svg` を呼ぶ（分析は snapshot の数値に限定）。

## Workflow（チェックリスト）
```
Charting Workflow:
- [ ] Step 1: 要件確認（表示の有無・指標）
- [ ] Step 2: 分析が目的 → 数値ツールを使用（例: analyze_ichimoku_snapshot / get_indicators）
- [ ] Step 3: ユーザーが明示した場合のみ render_chart_svg を実行
- [ ] Step 4: 出力は「数値根拠 → 簡潔な結論」。SVGの見た目の断定は行わない
```

## Options
- BB: `withBB=true`, `bbMode=default|extended`
- Ichimoku: `withIchimoku=true`, `ichimoku.mode=default|extended`
- SMA: 既定はなし。必要時のみ `withSMA=[25,75,200]` 等。

## Snippets
```
tool: render_chart_svg { pair: "btc_jpy", type: "1day", limit: 60, withBB: false, withSMA: [], withIchimoku: false }
```

数値スナップショット例:
```
tool: analyze_ichimoku_snapshot { pair: "btc_jpy", type: "1day" }
```


