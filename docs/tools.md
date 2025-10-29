# ツール一覧と使い分け
基本的に自由にプロンプトを投げてもらって構いません。

## 相場の全体像分析
- analyze_market_signal: 市場の総合スコア（-100〜+100）で強弱を即判定（寄与度・式付き）
- detect_macd_cross: 直近の MACD クロス銘柄をスクリーニング（短期転換の把握）

## 詳細分析（深掘り）
- get_flow_metrics: CVD / アグレッサー比 / スパイク検知でフロー優勢度を把握
- get_volatility_metrics: RV/ATR などのボラティリティ算出・比較
- detect_patterns: ダブルトップ等の完成パターン検出（事後の値動き評価）
- detect_forming_chart_patterns: 形成中パターン検出（初動の兆し）
- analyze_macd_pattern: MACD 形成状況と過去統計
- analyze_ichimoku_snapshot: 一目の状態をスナップショット（判定フラグ付）
- analyze_bb_snapshot: BB の広がりと終値位置（z 値等）
- analyze_sma_snapshot: SMA 整列/クロス分析（bullish/bearish/mixed）
- orderbook_statistics: 板の厚み・流動性分布・偏りの統計
- get_orderbook_pressure: 価格帯ごとの買い/売り圧力比

## データ取得（I/O レイヤ）
- get_ticker: 単一ペアの最新価格・出来高（ティッカー）
- get_tickers: 全ペアのスナップショット（価格・出来高・変化率）
- get_tickers_jpy: JPY 建てペアの軽量スナップショット（高速）
- get_candles: ローソク足（OHLCV; 任意本数）
- get_orderbook: 板（上位 N）。詳細モードで統計付き
- get_transactions: 約定履歴（サイド/アグレッサー）
- get_depth: 板の生データ（全層）— 差分・圧力の元

## 視覚化（最終提示）
- render_chart_svg: ローソク/折れ線/一目/BB/SMA/Depth を SVG で描画
  - 返却 `data.svg` を `image/svg+xml` としてそのまま表示（自前描画は不可）
  - Claude で LLM がうまくアーティファクトを出力できない場合は、以下のプロンプトを加えるのがおすすめです。
    - 「identifier と title を追加して、アーティファクトとして表示して」 

---

## 一覧（詳細）

| # | カテゴリ | ツール | 概要 | 備考 |
|---|---|---|---|---|
| 1 | 取得 | get_ticker | 単一ペアの最新価格・出来高 | 単発確認 |
| 2 | 取得 | get_tickers | 全ペアのスナップショット（価格・出来高・変化率） | 比較・ランキング |
| 3 | 取得 | get_tickers_jpy | JPY 建てペアの軽量スナップショット | 高速 |
| 4 | 取得 | get_orderbook | 板（上位 N）と統計（詳細モード） | 板の詳細把握 |
| 5 | 取得 | get_transactions | 約定履歴（サイド/アグレッサー） | CVD 素材 |
| 6 | 取得 | get_candles | ローソク足（OHLCV; 最新 N 本） | 時間軸/本数指定 |
| 7 | 取得 | get_depth | 板の生データ（全層） | 差分・圧力の元 |
| 8 | 分析 | get_indicators | 指標: SMA/RSI/BB/一目 | まとめ計算 |
| 9 | 分析 | get_flow_metrics | CVD/アグレッサー比/スパイク | 流れ把握 |
| 10 | 分析 | get_volatility_metrics | RV/ATR など | 銘柄比較 |
| 11 | 分析 | orderbook_statistics | 板の厚み・流動性分布・偏り | 安定度評価 |
| 12 | 分析 | detect_whale_events | 大口取引イベント推定 | 影響把握 |
| 13 | 分析 | get_orderbook_pressure | 価格帯ごとの買い/売り圧力比 | バランス可視化 |
| 14 | 分析 | detect_patterns | 完成パターン検出 | 事後の値動き把握 |
| 15 | 分析 | detect_forming_chart_patterns | 形成中パターン検出（MACD 除く） | 早期兆候 |
| 16 | 分析 | analyze_market_signal | 総合スコア＋寄与度/式 | 強弱判定 |
| 17 | 分析 | analyze_ichimoku_snapshot | 一目スナップショット | 判定フラグ |
| 18 | 分析 | analyze_bb_snapshot | BB の状態分析 | ボラ強弱 |
| 19 | 分析 | analyze_sma_snapshot | SMA 整列/クロス分析 | 方向判定 |
| 20 | 分析 | detect_macd_cross | 直近 MACD クロス検出 | 短期転換 |
| 21 | 分析 | analyze_macd_pattern | MACD 形成状況・過去統計 | 確度評価 |
| 22 | 表示 | render_chart_svg | チャート SVG 描画（指標対応） | 一目/SMA/BB/Depth |

---

## ヒント（参考）
- `analyze_market_signal` で全体を把握 → 必要に応じて各専門ツールへ
- チャートは必ず `render_chart_svg` の `data.svg` をそのまま表示（自前描画はしない）
- データ点が多い/レイヤ多い場合は `maxSvgBytes` や `--force-layers` で調整可能
