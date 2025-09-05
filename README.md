# bitbank-mcp-server

本サーバーは MCP (Model Context Protocol) 対応のクライアント（例: Claude, MCP Inspector）から直接呼び出すことで、bitbank API のデータ取得やテクニカル分析を行えるツールです。

## 主な機能

- **リアルタイムデータ取得**: ティッカー（現在価格）、オーダーブック（板情報）
- **履歴データ取得**: ローソク足（1分足〜月足）
- **テクニカル分析**:
  - 移動平均線 (SMA: 25, 75, 200)
  - 相対力指数 (RSI: 14)
  - ボリンジャーバンド
  - 一目均衡表
  - 自動トレンド分析

## サーバーの起動方法

### Docker を利用する場合（推奨）

Docker環境があれば、以下の手順でサーバーの起動とMCP Inspectorでの動作確認を行えます。

1.  **Dockerイメージをビルド**
    ```bash
    docker build -t bitbank-mcp .
    ```

2.  **コンテナを起動し、Inspectorに接続**
    ```bash
    npx @modelcontextprotocol/inspector docker run -i --rm bitbank-mcp
    ```

### ローカル環境で直接実行する場合

1.  **依存パッケージのインストール**
    ```bash
    npm install
    ```

2.  **Inspector に接続してサーバーを起動**
    ```bash
    npx @modelcontextprotocol/inspector node src/server.mjs
    ```
    このコマンドを実行すると、サーバーが起動し、自動的にMCP Inspectorが開いて接続されます。

## CLIツールとしての使用方法

各ツールは、サーバーを起動せずに直接コマンドラインから実行することも可能です。

### ローソク足データ取得
```bash
# 1時間足データ（YYYYMMDD形式）
node tools/get_candles_cli.mjs btc_jpy 1hour 20240511
```

### インジケーター計算
```bash
# 日足データでインジケーター計算
node tools/get_indicators_cli.mjs btc_jpy 1day
```

### ティッカーデータ取得
```bash
node tools/get_ticker.js btc_jpy
```

### 板データ取得
```bash
node tools/get_orderbook.js btc_jpy 5
```
