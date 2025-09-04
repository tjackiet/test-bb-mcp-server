# test-bb-mcp-server
本サーバーは MCP 対応のクライアント（例: Claude）から直接呼び出すことで、bitbank API のデータ取得を行えます。

## 使用方法

### ローソク足データ取得
```bash
# 1時間足データ（YYYYMMDD形式）
node tools/get_candles_cli.mjs btc_jpy 1hour 20240511

# 月足データ（YYYY形式）
node tools/get_candles_cli.mjs btc_jpy 1month 2024

# デフォルト（日足、今日の日付、200件）
node tools/get_candles_cli.mjs btc_jpy 1day
```

### インジケーター計算
```bash
# 日足データでインジケーター計算（SMA25/75/200, RSI14）
node tools/get_indicators_cli.mjs btc_jpy 1day

# 1時間足データでインジケーター計算
node tools/get_indicators_cli.mjs btc_jpy 1hour 200

# カスタム件数で計算
node tools/get_indicators_cli.mjs btc_jpy 1day 500
```

### ティッカーデータ取得
```bash
node tools/get_ticker.js btc_jpy
```

### 板データ取得
```bash
node tools/get_orderbook.js btc_jpy 5
```

## インジケーター機能

### 対応インジケーター
- **SMA (Simple Moving Average)**
  - SMA25: 短期移動平均
  - SMA75: 中期移動平均  
  - SMA200: 長期移動平均（スイングトレード・中長期ホルダー向け）

- **RSI (Relative Strength Index)**
  - RSI14: 14日相対力指数

### トレンド分析
自動的に以下のトレンドを判定：
- `strong_uptrend`: 強烈な上昇トレンド
- `uptrend`: 上昇トレンド
- `sideways`: 横ばい
- `downtrend`: 下降トレンド
- `strong_downtrend`: 強烈な下降トレンド
- `overbought`: 過買い
- `oversold`: 過売り

## エラーメッセージの一貫性

すべてのツールで統一されたエラーメッセージ形式を使用しています：
- パラメータ名と指定値を明示
- 期待される形式を具体的に提示
- 日本語での分かりやすい説明
