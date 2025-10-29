# bitbank-mcp-server

> bitbank API のデータを使った暗号資産市場分析を、Claude（LLM）から簡単に実行できる MCP サーバーです。

## これは何？
この MCP サーバーは、bitbank のリアルタイム/履歴データを使い、LLM が安定して質の高い分析を行えるよう最適化された「分析ツール」を提供します。単なる生データではなく、指標の計算や統合、可視化までをツールとして提供することで、毎回の回答ブレや冗長なやり取りを抑えます。

### なぜ「生データ」ではなく「分析ツール」なのか？
- 生データだけでは解釈がぶれて、結論が一貫しにくい
- RSI だけ等、浅い分析に偏りがち（誤検出/見落とし）
- 不要な再取得や説明でトークンを浪費しやすい

→ 複数指標を統合した「用途別ツール」を用意することで、LLM が短手数で正確・再現性の高い分析を実行できます。

## できること（概要）
- 初動トリアージ: `analyze_market_signal`（総合スコアで強弱を即判定）
- 詳細分析: `get_flow_metrics`（フロー）, `get_volatility_metrics`（ボラ）, `detect_macd_cross`（直近クロス）, `detect_patterns`（形状検出）ほか
- 視覚化: `render_chart_svg`（ローソク/一目/BB/SMA/Depth の SVG）

→ 全ツールの一覧と使い分けは「docs/tools.md」を参照。

## クイックスタート（3ステップ）

### 1. インストール
```bash
git clone https://github.com/your-repo/bitbank-mcp-server.git
cd bitbank-mcp-server
npm install
```

### 2. Claude Desktop に登録（最短）
`~/Library/Application Support/Claude/claude_desktop_config.json` に以下を追加（絶対パス推奨）:
```json
{
  "mcpServers": {
    "bitbank": {
      "command": "/ABS/PATH/to/node_modules/.bin/tsx",
      "args": ["/ABS/PATH/to/src/server.ts"],
      "env": { "LOG_LEVEL": "info", "NO_COLOR": "1" }
    }
  }
}
```
- 追加後、Claude Desktop を再起動してください
- Node.js 18+ があれば Docker は不要です

### 3. 使ってみる
Claude にそのまま話しかけます:
```
BTCの今の市場状況を分析して
```
- まず `analyze_market_signal` で要約 → 必要に応じて深掘りツールを自動呼び出し
- チャートが必要なときは `render_chart_svg` を使用（自前描画は行いません）

## 使用例（会話の型）
- 「今、BTC は買いですか？」→ `analyze_market_signal`: 総合スコア + 寄与度・根拠
- 「直近で MACD クロスした銘柄は？」→ `detect_macd_cross`: スクリーニング結果
- 「ここ 30 日のボラ推移を見たい」→ `get_volatility_metrics` + `render_chart_svg`

## 表示（SVG）
- 生成 SVG は `preserveAspectRatio="xMidYMid meet"` と `max-width:100%; height:auto;` を付与済み
- MCP クライアントでは `type: "image/svg+xml"` のアーティファクトとして `data.svg` をそのまま表示してください

## 詳細ドキュメント
- ツール一覧と使い分け: [docs/tools.md](docs/tools.md)
- 開発者向けガイド（スキーマ同期・型生成・CI など）: [CONTRIBUTING.md](CONTRIBUTING.md)
- 運用・監視（ログ集計など）: [docs/ops.md](docs/ops.md)

## よくある質問（FAQ）
**Q. Docker は必須？** いいえ。Node 18+ でローカル実行できます（最短は Claude Desktop 登録）。

**Q. API キーは必要？** いいえ。bitbank の公開 API のみ使用します。

**Q. どのツールを使えばよい？** まず `analyze_market_signal` で全体を把握 → 必要に応じて各専門ツールへ。

**Q. MCP Inspector でも試せる？** はい。開発時は次で実行できます。
```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

---

> 補足: HTTP サーバは既定で無効です（STDIO 汚染を避けるため）。HTTP を使う場合のみ `MCP_ENABLE_HTTP=1 PORT=8787` を設定し、`npx @modelcontextprotocol/inspector http://localhost:8787/mcp` で接続してください。