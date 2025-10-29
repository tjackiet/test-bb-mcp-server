# bitbank-mcp-server

> bitbank API のデータを使った暗号資産市場分析を、Claude（LLM）から簡単に実行できる MCP サーバーです。

## 本 MCP サーバーについて
この MCP サーバーは、bitbank の公開 API から価格・取引データを取得し、LLM が安定して質の高い分析を行えるよう最適化された「分析ツール」を提供します。生データをそのまま LLM に渡すだけではなく、指標の計算・統合・可視化を「分析ツール」も備えています。各ツールの description では「いつ使うべきか」「他ツールとの使い分け」を明示し、LLM が適切なツールを自律的に選択できるよう設計しています。

## 概要
bitbank の公開 API から価格・板情報・約定履歴・ローソク足データを取得し、以下の分析を実行できます。
→ 全ツールの一覧と使い分けは [docs/tools.md](docs/tools.md) を参照。

#### 取得できる生データ
- リアルタイム価格（ティッカー）
- 板情報（オーダーブック）
- 約定履歴（売買方向・時刻）
- ローソク足（1分足〜月足）

#### 実行できる分析
- テクニカル指標（SMA/RSI/ボリンジャーバンド/一目均衡表/MACD）
- フロー分析（買い/売りの勢い・CVD・スパイク検出）
- ボラティリティ分析（RV/ATR）
- 板の圧力分析（価格帯ごとの買い/売り圧力）
- パターン検出（ダブルトップ/ヘッドアンドショルダーズ等）
- 総合スコア判定（複数指標を統合した強弱判定）

#### 視覚化
- ローソク足・一目均衡表・ボリンジャーバンド等のチャートを SVG 形式で生成
  ※現状 LM が自力でローソク足とインジケーターを重ねたチャートを描画するのは難しいため、完成した SVG を提供することで可視化をサポートしています。

## クイックスタート（3 ステップ）

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
  - Docker の起動手順は docs/ops.md の「Docker起動（開発・検証用）」を参照してください。

### 3. 使ってみる
Claude にそのまま話しかけます:
```
BTCの今の市場状況を分析して
```

## 使用例（会話の型）
- 「今、BTC は買いですか？」→ `analyze_market_signal`: 総合スコア + 寄与度・根拠
- 「直近で MACD クロスした銘柄は？」→ `detect_macd_cross`: スクリーニング結果
- 「ここ 30 日のボラ推移を見たい」→ `get_volatility_metrics` + `render_chart_svg`

## チャート表示（SVG）
- MCP クライアント（Claude）では、アーティファクトとして `data.svg` を表示するようにお願いしてください。
  - Claude で LLM がうまくアーティファクトを出力できない場合は、以下のプロンプトを加えるのがおすすめです。
    - 「identifier と title を追加して、アーティファクトとして表示して」 

## 詳細ドキュメント
- ツール一覧と使い分け: [docs/tools.md](docs/tools.md)
- 開発者向けガイド（スキーマ同期・型生成・CI など）: [CONTRIBUTING.md](CONTRIBUTING.md)
- 運用・監視（ログ集計／Docker起動 ほか）: [docs/ops.md](docs/ops.md)

## よくある質問（FAQ）
**Q. Docker は必須？** いいえ。Node 18+ でローカル実行できます（最短は Claude Desktop 登録）。

**Q. API キーは必要？** いいえ。現状 bitbank の公開 API のみ使用します。

**Q. どのツールを使えばよい？** まず `analyze_market_signal` で全体を把握 → 必要に応じて各専門ツールへ。

**Q. MCP Inspector でも試せる？** はい。開発時は次で実行できます。
```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

---

> 補足: HTTP サーバは既定で無効です（STDIO 汚染を避けるため）。HTTP を使う場合のみ `MCP_ENABLE_HTTP=1 PORT=8787` を設定し、`npx @modelcontextprotocol/inspector http://localhost:8787/mcp` で接続してください。