---
name: multi_factor_signal
description: 上がりそう？系の比較・意思決定で、相対強度スコアを算出・説明する。トリガー: 銘柄の強弱や「上がりそう？」に言及がある時。
tags: [signal, trading, market]
---

## Overview
複数指標（Flow/Volatility/Indicators/SMA）を合成して相対強度スコアを返す。SKILL.md は概要のみ。詳細は [reference.md](reference.md)、入出力例は [examples.md](examples.md) を参照。

## When to use
- 「上がりそう？」「買い時？」といった意思決定系の質問
- 銘柄が未指定なら `pair=btc_jpy` を既定に（明示があればそれを使用）

## Tool order (MANDATORY)
1. `bitbank-mcp:analyze_market_signal(pair, type='1day', windows=[14,20,30])`
   - returns: `score` (−1..+1), `recommendation` (bullish/bearish/neutral), `metrics` (aggressorRatio, cvdSlope, rv_std_ann, RSI)
2. If user asks for more evidence only:
   - `bitbank-mcp:get_flow_metrics(pair, limit≈300, bucketMs=60000)` → buy ratio / CVD
   - `bitbank-mcp:get_volatility_metrics(pair, type='1day', windows=[14,20,30], annualize=true)` → annualized RV
   - `bitbank-mcp:get_indicators(pair, type='1day', limit≈120)` → RSI / SMA / Ichimoku snapshot
3. Render chart only on explicit request:
   - `bitbank-mcp:render_chart_svg({ pair, type:'1day', limit:60, withBB:false, withSMA:[], withIchimoku:false })`

## Output style
1) 結論（先出し）: `合成スコア=0.31 → bullish（上昇バイアス）`
2) 数値タグ: `buy% 0.58 | CVD slope +0.12 | RV_ann 0.32 | RSI 48`
3) 短い根拠: ツール名＋主要値のみを引用（冗長な再説明はしない）
4) スコア内訳（トップ2）: 例 `top: buy+0.18, sma+0.07`

### Output template (strict)
必ず以下の構造で返す（自由記述は最後に）:

```json
{
  "pair": "<pair>",
  "score": <number>,
  "recommendation": "bullish|neutral|bearish",
  "breakdown": {
    "buyPressure": { "rawValue": <number>, "weight": 0.35, "contribution": <number>, "interpretation": "weak|moderate|strong|neutral" },
    "cvdTrend": { "rawValue": <number>, "weight": 0.25, "contribution": <number>, "interpretation": "weak|moderate|strong|neutral" },
    "momentum": { "rawValue": <number>, "weight": 0.15, "contribution": <number>, "interpretation": "weak|moderate|strong|neutral" },
    "volatility": { "rawValue": <number>, "weight": 0.10, "contribution": <number>, "interpretation": "weak|moderate|strong|neutral" },
    "smaTrend": { "rawValue": <number>, "weight": 0.15, "contribution": <number>, "interpretation": "weak|moderate|strong|neutral" }
  },
  "topContributors": ["<factor>", "<factor>"]
}
```

## Guardrails
- 既定でチャートは描画しない（ユーザーが明示した場合のみ）。
- 同じ会話内で無闇に再取得しない（直近1分はキャッシュ優先）。
- 描画時は必ず `render_chart_svg` を使い、独自SVG/JSを生成しない。

## Terminology (SMA)
**SMA配置トレンド（定性的・構造）**: SMA25/75/200 と価格の位置・整列で判定（例: 25>75>200 → 上昇／25<75<200 → 下降／どちらでもなければ横ばい。過熱時はRSIで上書き）。

**短期SMA変化スコア（定量・勢い）**: `smaTrend` の寄与。25/75の整列ボーナス（±0.6）と、SMA200乖離（±0.4を±5%で正規化）を合成し −1..+1 にクランプ。構造が横ばいでも、短期が上向くとプラスになる。

レポートでは「SMA配置トレンド」を主トレンドとして表示し、「短期SMA変化スコア」は補足として数値で示す。

## Workflow (checklist)
コピーして進捗を管理:

```
Signal Workflow:
- [ ] Step 1: bitbank-mcp:analyze_market_signal を実行（pair/type/windowsを確定）
- [ ] Step 2: 追加根拠が求められた時のみ flow/vol/indicators を取得
- [ ] Step 3: チャート要求があれば render_chart_svg（既定はオフのまま）
- [ ] Step 4: Output template どおりに式・内訳・topContributors を提示
- [ ] Step 5: 整合性チェック（推奨と内訳の符号が矛盾→閾値/期間を見直す）
```

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

## Scoring formula (for transparency)

- 合成式: `score = 0.35*buyPressure + 0.25*cvdTrend + 0.15*momentum + 0.10*volatility + 0.15*smaTrend`
- しきい値: `bullish ≥ 0.25`, `bearish ≤ -0.25`（運用で調整可）
- 出力には `formula / weights / contributions` を同梱（各要素の寄与を確認可能）

### smaTrend の定義
- 整列ボーナス: `close > SMA25 > SMA75` なら +0.6、`close < SMA25 < SMA75` なら −0.6
- SMA200 乖離: `(close − SMA200)/SMA200` を ±5% で正規化し、±0.4 にクリップ
- 合算後に −1..+1 にクランプ

## Notes
- `recommendation` は `bullish / neutral / bearish`。必要に応じて期間（type）や窓（windows）を明示して再評価。
- 閾値の初期値: score ≥ 0.25 → bullish / ≤ −0.25 → bearish（調整可）。

---

See also: [reference.md](reference.md)（詳細仕様） / [examples.md](examples.md)（入出力例）


