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

### ティッカーデータ取得
```bash
node tools/get_ticker.js btc_jpy
```

### 板データ取得
```bash
node tools/get_orderbook.js btc_jpy 5
```

## エラーメッセージの一貫性

すべてのツールで統一されたエラーメッセージ形式を使用しています：
- パラメータ名と指定値を明示
- 期待される形式を具体的に提示
- 日本語での分かりやすい説明
