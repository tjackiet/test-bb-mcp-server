---
name: multi_factor_signal
description: 上がりそう？系の質問に対する既定ルート。需給・CVDトレンド・ボラ・モメンタムを合成したスコアで結論を先に返す。
tags: [signal, trading, market]
---

## Overview
複数指標を合成したスコアで素早く結論を出す。必要なときだけ詳細を深掘りする。

## When to use
- 「上がりそう？」「買い時？」といった意思決定系の質問
- 銘柄が未指定なら `pair=btc_jpy` を既定に（明示があればそれを使用）

## Tool order (MANDATORY)
1. `analyze_market_signal(pair, type='1day', windows=[14,20,30])`
   - returns: `score` (−1..+1), `recommendation` (bullish/bearish/neutral), `metrics` (aggressorRatio, cvdSlope, rv_std_ann, RSI)
2. If user asks for more evidence only:
   - `get_flow_metrics(pair, limit≈300, bucketMs=60000)` → buy ratio / CVD
   - `get_volatility_metrics(pair, type='1day', windows=[14,20,30], annualize=true)` → annualized RV
   - `get_indicators(pair, type='1day', limit≈120)` → RSI / SMA / Ichimoku snapshot
3. Render chart only on explicit request:
   - `render_chart_svg({ pair, type:'1day', limit:60, withBB:false, withSMA:[], withIchimoku:false })`

## Output style
1) 結論（先出し）: `合成スコア=0.31 → bullish（上昇バイアス）`
2) 数値タグ: `buy% 0.58 | CVD slope +0.12 | RV_ann 0.32 | RSI 48`
3) 短い根拠: ツール名＋主要値のみを引用（冗長な再説明はしない）

## Guardrails
- 既定でチャートは描画しない（ユーザーが明示した場合のみ）。
- 同じ会話内で無闇に再取得しない（直近1分はキャッシュ優先）。
- 描画時は必ず `render_chart_svg` を使い、独自SVG/JSを生成しない。

## Quick start (tool_code snippets)
```
# 1) 結論を素早く
tool: analyze_market_signal { pair: "btc_jpy", type: "1day" }

# 2) 追加の根拠（必要時のみ）
tool: get_flow_metrics { pair: "btc_jpy", limit: 300, bucketMs: 60000 }
tool: get_volatility_metrics { pair: "btc_jpy", type: "1day", windows: [14,20,30], annualize: true }
tool: get_indicators { pair: "btc_jpy", type: "1day", limit: 120 }

# 3) チャート要求があったら
tool: render_chart_svg { pair: "btc_jpy", type: "1day", limit: 60, withBB: false, withSMA: [], withIchimoku: false }
```

## Notes
- `recommendation` は `bullish / neutral / bearish`。必要に応じて期間（type）や窓（windows）を明示して再評価。
- 閾値の初期値: score ≥ 0.25 → bullish / ≤ −0.25 → bearish（調整可）。


