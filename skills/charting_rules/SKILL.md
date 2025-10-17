---
name: charting_rules
description: チャート描画のプロジェクト規約（必ず render_chart_svg を使用し、既定で描画しない）。
tags: [chart, policy]
---

## Policy
- チャート描画は必ず `render_chart_svg` を使う。独自のSVG/Canvas/JS生成は禁止。
- 既定は描画しない。ユーザーが明示したときのみ描画する。
- 保存に失敗した場合でも `data.svg` をそのままArtifact表示すればよい（ユーザー向けエラー文言は出さない）。

## Options
- BB: `withBB=true`, `bbMode=default|extended`
- Ichimoku: `withIchimoku=true`, `ichimoku.mode=default|extended`
- SMA: 既定はなし。必要時のみ `withSMA=[25,75,200]` 等。

## Snippets
```
tool: render_chart_svg { pair: "btc_jpy", type: "1day", limit: 60, withBB: false, withSMA: [], withIchimoku: false }
```


