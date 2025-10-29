# bitbank-mcp-server

本サーバーは MCP (Model Context Protocol) 対応のクライアント（例: Claude, MCP Inspector）から直接呼び出すことで、bitbank API のデータ取得やテクニカル分析を行えるツールです。

> Note: AIの動作ポリシーは `.cursorrules`（開発メモ）と `.mcphostrules`（MCPホスト向けメモ）に記載しています。既定は常に default（標準）。extended はユーザーが明示した場合のみ許可します。ツールとプロンプトの正規仕様は `description.json` / `prompts.json` にもエクスポートしています。

## 主な機能

- **リアルタイムデータ取得**: ティッカー（現在価格）、オーダーブック（板情報）
- **履歴データ取得**: ローソク足（1分足〜月足）
- **テクニカル分析**:
  - 移動平均線 (SMA: 25, 75, 200)
  - 相対力指数 (RSI: 14)
  - ボリンジャーバンド
  - 一目均衡表
  - 自動トレンド分析
  - **チャート描画**:
    - `render_chart_svg`: ローソク足/折れ線チャートを静的なSVG画像として生成します。

### チャート描画のガイドライン（推奨）

- **人が利用する際のおすすめ**: チャート表示は `tools/render_chart_svg.js`（Node API: `renderChartSvg(options)`）の出力SVGをそのまま使うのが最も安定です。
  - アプリやドキュメントでは、ツールが返す `data.svg` または `filePath` のSVGを直接表示する運用を推奨します。
  - JSライブラリでの再描画よりも、再現性・メンテナンス性・安全性（CSP等）でメリットがあります。
  - 独自の描画実装（D3/Canvas/Chartライブラリ等）も可能ですが、描画方法や成果物は MCP クライアントの実装に依存するため、安定した表示を保証できません。
- **Bollinger Bands の描画仕様**
- 既定: ±2σ を描画（bbMode=`default`）。
- 拡張（オプション）: ±1σ, ±2σ, ±3σ を描画（bbMode=`extended`）。
- **一目均衡表の描画仕様**
  - 標準: 転換線・基準線・雲（先行スパンA/B）。
  - 拡張: 上記に加え遅行スパン（`ichimoku.mode=extended` または `ichimoku.withChikou=true`）。
- **SMA の描画仕様**
  - 既定: 描画しない（必要な場合のみ `--sma=…` または `withSMA` を明示）。
  - 一目均衡表を描画する場合（withIchimoku=true）は、SMAとBBは強制的にオフ（実装で排他制御）。

#### パターン検出時の推奨

- パターン検出（`detect_patterns`）と併用する場合、チャートは原則として折れ線スタイルを優先してください。
  - 指定方法: `style: 'line'`（CLI: `--style=line`）。
  - 目的: ローソク足よりも情報量が絞られ、パターンの形状が視認しやすく、出力サイズも抑えられます。
  - 追加インジケータ（SMA/BB/一目）は必要時のみ。既定ではオフのままで構いません。

CLI 例: `./node_modules/.bin/tsx tools/render_chart_svg_cli.ts <pair> <type> <limit> --bb-mode=default` / `--bb-mode=extended`
  - 折れ線スタイル: `--style=line`（デフォルトは `candles`）。折れ線時も、指定があればBB/SMA/一目を重ね描画可能です。

### 最小サンプル（CLI）

```bash
# 日足チャートをSVGとして出力（折れ線・軽量）
./node_modules/.bin/tsx tools/render_chart_svg_cli.ts btc_jpy 1day 60 --style=line --no-bb --no-sma > chart.svg
```

### 参考画像

- ボリンジャーバンド（±2σ）
![Sample Chart](assets/bb_light.svg)

- 一目均衡表
![Ichimoku Sample Chart](assets/ichimoku_sample.svg)


## render_chart_svg

### 返却形式

```json
{
  "ok": true,
  "summary": "BTC/JPY 1day chart rendered",
  "data": {
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\">...",
    "filePath": null,
    "legend": {
      "BB2": "Bollinger Bands ±2σ",
      "SMA_25": "SMA 25"
    }
  },
  "meta": {
    "pair": "btc_jpy",
    "type": "1day",
    "limit": 60,
    "indicators": ["BB2", "SMA_25"],
    "range": {
      "start": "2025-09-01T00:00:00.000Z",
      "end": "2025-10-26T00:00:00.000Z"
    },
    "sizeBytes": 34567
  }
}
```

LLM は `data.svg` があればそのまま image/svg+xml のアーティファクトとして出力し、`data.svg` が null の場合は `data.filePath` を file_read で読み取って表示します。

### detect_patterns との連携例

```ts
// 1. パターン検出
const patterns = await detect_patterns({ pair: 'btc_jpy', type: '1day', limit: 90 });

// 2. overlays を取得
const overlays = patterns.data.overlays;

// 3. チャートに描画
const chart = await render_chart_svg({
  pair: 'btc_jpy',
  type: '1day',
  limit: 90,
  overlays
});

// 4. SVG出力
console.log(chart.data.svg);
```

overlays の構造（例）:

```json
{
  "ranges": [
    { "start": "2025-10-01", "end": "2025-10-10", "label": "ダブルトップ", "color": "#ff000030" }
  ],
  "annotations": [
    { "isoTime": "2025-10-12T00:00:00Z", "text": "ブレイクアウト" }
  ],
  "depth_zones": [
    { "low": 12000000, "high": 12500000, "label": "強い抵抗帯", "color": "#ff000030" }
  ]
}
```

### サイズ制限

- `maxSvgBytes` を未指定: `data.svg` に完全なSVGを返却
- `maxSvgBytes` を指定し超過: `data.svg = null`, `data.filePath` に保存
- `preferFile = true`: 常に `data.filePath` のみ（inline返却は行わない）

### プロンプトとCLIの対応表（抜粋）

| Prompt 名 | 概要 | 対応CLIフラグ例 |
|---|---|---|
| `bb_default_chart` | BB既定（±2σ） | `--bb-mode=default` |
| `bb_extended_chart` | BB拡張（±1/±2/±3σ） | `--bb-mode=extended` |
| `candles_only_chart` | ローソク足のみ（追加指標なし） | `--candles-only` |
| `ichimoku_default_chart` | 一目 標準（遅行なし） | `--with-ichimoku --ichimoku-mode=default` |
| `ichimoku_extended_chart` | 一目 拡張（遅行スパン含む） | `--with-ichimoku --ichimoku-mode=extended` |

より詳しい仕様は `description.json`（ツール）と `prompts.json`（プロンプト）を参照してください。開発者向け手順は `CONTRIBUTING.md`、運用は `docs/ops.md` を参照。

#### Depth（板情報）
- ツール: `get_depth`（bids/asks 最大200レベル、簡易サマリ＋推定ゾーンを返却）
- チャート: `render_chart_svg` の `style: 'depth'`（累積ステップライン）。CLI例: `--style=depth --depth-levels=200`

## 注意事項

Claude（MCPホスト）経由でローソク足チャートを描画する場合、出力サイズの制限により **30〜40本程度** が安定動作の目安です。長期データは CLI で SVG を出力する運用をおすすめします。

## Setup

1.  **環境変数を設定してください**  
   `.env.example` をコピーして `.env` ファイルを作成します。
   ```bash
   cp .env.example .env
   ```
   必要に応じて `.env` ファイル内の値を調整してください。
   - `PORT`: サーバーのポート番号（注: 現在の実装では `stdio` 通信のため使用されません）
   - `LOG_DIR`: ログファイルを保存するディレクトリ
   - `LOG_LEVEL`: ログの出力レベル（`info`, `debug` など）

## サーバーの起動方法

### Docker を利用する場合（推奨）

```bash
# Build
docker build -t bitbank-mcp .
# Run via Inspector（npx経由でコンテナ起動）
npx @modelcontextprotocol/inspector docker run -i --rm -e NO_COLOR=1 -e LOG_LEVEL=info bitbank-mcp
```

### ローカル環境で直接実行する場合

```bash
npm install
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

### MCP Inspector での検証ポイント（簡易）

- bbMode と ichimoku.mode の切替が SVG に反映されること
- パターン検出結果の `data.overlays.ranges` を `render_chart_svg.overlays` に渡すと帯が描画されること

補足リンク:
- bbMode / ichimoku.mode の仕様は本ドキュメント上部「チャート描画の重要ポリシー（必読）」を参照。

トラブル時のヒント:
- タイムアウト時はリトライ、あるいはツールの `timeoutMs` を一時的に延長
- ネットワーク（VPN/Proxy/CSP）影響を確認
  - 実装では `lib/http.ts` の `fetchJson` がデフォルト `timeoutMs`（既定 2500ms）を使用します。`tools/get_ticker.ts` / `tools/get_orderbook.ts` / `tools/get_candles.ts` では呼び出し側で上書きしている箇所があります。
  - 環境によって遅延が大きい場合は、該当ツールの `timeoutMs` を増やして再実行してください（例: `get_candles` は 5000ms を使用）。

### Claude（実対話確認）

- 既存プロンプト（例: `bb_light_chart`, `ichimoku_default_chart`）を使い、`render_chart_svg` がツール呼び出しされることを確認
- もし自前描画が発生する場合は、プロンプトを修正し「必ずツールを使う」指示を強化

> 注意: 全体把握には `analyze_market_signal` を、詳細には `get_flow_metrics` / `get_volatility_metrics` / `get_indicators` を併用してください。

## CLIツールとしての使用方法

各ツールは、サーバーを起動せずに直接コマンドラインから実行することも可能です。

### ローソク足データ取得（TSX）
```bash
# 1時間足データ（YYYYMMDD形式）
./node_modules/.bin/tsx tools/get_candles_cli.ts btc_jpy 1hour 20240511
```

### インジケーター計算（TSX）
```bash
# 日足データでインジケーター計算
./node_modules/.bin/tsx tools/get_indicators_cli.ts btc_jpy 1day
```

### SVGチャート生成（TSX）
```bash
# 日足チャートをSVGファイルとして出力
./node_modules/.bin/tsx tools/render_chart_svg_cli.ts btc_jpy 1day 45 --candles-only > chart.svg
```

> **Note:** 移動平均線や一目均衡表などのインジケータを完全に描画するには、その計算に必要な期間（例: SMA75なら75本以上）を含んだ十分なローソク足の本数 (`limit`) を指定する必要があります。本数が不足する場合、インジケータはチャートの途中から描画されます。

### get_candles の日付指定について
- `type=1month` の場合のみ `YYYY` を指定（例: 2024）
- それ以外（例: `1day`, `1hour` など）は `YYYYMMDD`（例: 20240511）

// 初心者向け解説についての記述は割愛します。以後は **`get_indicators` の返却値（SMA・RSI・一目均衡表など）を基にプロンプトで整形** してください。これにより、分析ロジックの一貫性が保たれ、Claude からも安定した出力が得られます。

インジケータの表示を制御するには、以下のフラグを利用します。

- `--with-ichimoku`: 一目均衡表を描画（デフォルト: オフ）
- `--bb-mode=default|extended`: ボリンジャーバンドのモード指定（default=±2σ / extended=±1/±2/±3σ）
- `--sma=5,20,50`: SMAを明示指定（デフォルト: オフ。指定しなければ描画しません）
- `--sma-only` / `--bb-only` / `--ichimoku-only`: 該当インジケータのみを描画するショートカット
- `--no-bb`: ボリンジャーバンドを非表示（デフォルト: 表示）

**実行例：一目均衡表のみを100日分描画（TSX）**
```bash
./node_modules/.bin/tsx tools/render_chart_svg_cli.ts btc_jpy 1day 100 --with-ichimoku --no-bb --no-sma > assets/ichimoku_sample.svg
```

## JPY建てティッカー（軽量スナップショット）

### get_tickers_jpy（TSX）
```bash
# 単発取得
./node_modules/.bin/tsx tools/get_tickers_jpy_cli.ts

# ネットが不安定な環境向け（タイムアウト/リトライ調整）
TICKERS_JPY_TIMEOUT_MS=3000 TICKERS_JPY_RETRIES=2 TICKERS_JPY_RETRY_WAIT_MS=500 ./node_modules/.bin/tsx tools/get_tickers_jpy_cli.ts
```

返却例（短縮）:
```json
{
  "ok": true,
  "summary": "tickers_jpy fetched in 197ms (47 items, 7506 bytes)",
  "data": [ { "pair": "btc_jpy", "sell": "16330854", "buy": "16330853", "last": "16330854", "timestamp": 1761026224875 } ],
  "meta": { "cache": { "hit": false, "key": "tickers_jpy" }, "ts": "...", "latencyMs": 197, "payloadBytes": 7506 }
}
```

備考:
- `sell`/`buy` が取引停止・薄商い時に `null` となることがあります（上流仕様）。
- キャッシュ: TTL=10s。検証や連続呼び出しの際はヒットします。
- テスト用にバイパス可能: コードから `getTickersJpy({ bypassCache: true })` を呼ぶと常に上流を叩きます。

## スキーマと型の一元管理（Zod → 型生成 → CI）

- **単一ソース**: 契約は `src/schemas.ts` の Zod 定義が唯一のソースです。
- **生成型**: `npm run gen:types` で `src/types/schemas.generated.d.ts` を生成します（TSX: `tools/gen_types.ts`）。
- **CI**: GitHub Actions で `gen:types` → `typecheck` を実行し、Zod と TS 型のズレを検出します。
- **戻り値の保証**: 各ツール（`get_ticker`, `get_orderbook`, `get_candles`, `get_indicators`, `render_chart_svg`）は、返却直前に OutputSchema で検証されます。
  - ツールは `ok()/fail()` の結果を `...OutputSchema.parse(...)` して返却。
  - `server.ts` では `render_chart_svg` の戻りも `RenderChartSvgOutputSchema.parse(...)` で最終検証。

### 開発フロー（推奨）
1. `src/schemas.ts` を更新（入力・出力ともに Zod を単一ソース化）
2. `npm run gen:types` で型を再生成
3. ツール/サーバー実装を更新（戻り値は OutputSchema に準拠）
4. `npm run typecheck` で検証（CI も同じ流れ）

> これにより、スキーマと実装・型定義のドリフトを防止し、MCP SDK 導入時も差分ゼロで移行可能です。

### スキーマ同期について

`description.json` と `prompts.json` は手動で編集せず、必ず以下のスクリプトで `src/schemas.ts` から自動生成してください。

```bash
npm run sync:manifest
npm run sync:prompts
```

これにより `src/schemas.ts` が唯一のソースとなり、定義の「差分ゼロ」運用を保証します。

#### 非破壊拡張の原則（重要）

- 既存スキーマは壊さずに拡張します（後方互換）。
- 既存フィールドの型や意味は変更しません。新規は以下いずれかで追加します。
  - 追加情報: `meta.*` に拡張（例: `meta.source`, `meta.updatedAt`）
  - 詳細拡張: サフィックス `_ex` の新オブジェクトで提供（例: `aggregates_ex`）
- 既存ツールの返却は `...OutputSchema` で検証してから返します。拡張時は OutputSchema を先に更新してください。

## コントリビュート手順（チェックリスト）

PR を送る前に、以下を順に実行してください。

```bash
npm run sync:manifest   # schemas.ts → description.json
npm run sync:prompts    # server.ts の登録内容 → prompts.json
npm run gen:types       # Zod → 型生成（schemas.generated.d.ts）
npm run typecheck       # 型チェック（CI も同じ）
```

- `description.json` と `prompts.json` は直接編集しないでください。必ず同期スクリプトを実行します。
- ツールの戻り値は OutputSchema で検証されるため、JSON 構造が変わる場合は `src/schemas.ts` を先に更新してください。
注意: 上記4コマンドは PR 作成前の必須手順です。差分や型ズレがある場合はレビュー前に解消してください。

## 検証手順（Inspector / Claude）

### MCP Inspector（手動確認）

1) サーバ起動
```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```
2) 以下をUIで確認
- `render_chart_svg` の `bbMode`（light↔full）切替が SVG に反映
- `ichimoku.mode`（default↔extended）切替が反映
- 自前描画は禁止。返却 `svg` をそのまま表示

トラブル時のヒント:
- タイムアウト時はリトライ、あるいはツールの `timeoutMs` を一時的に延長
- ネットワーク（VPN/Proxy/CSP）影響を確認

### Claude（実対話確認）

- 既存プロンプト（例: `bb_light_chart`, `ichimoku_default_chart`）を使い、`render_chart_svg` がツール呼び出しされることを確認
- もし自前描画が発生する場合は、プロンプトを修正し「必ずツールを使う」指示を強化

### Claude 用 MCP サーバー設定例（絶対パス推奨 / npx 回避）

Claude の Developer Settings > MCP Servers に以下のように登録してください。

推奨（tsx を直接呼び出し、ANSI無効化）:
```json
{
  "command": "/Users/yourname/path/to/bb-mcp-sandbox/node_modules/.bin/tsx",
  "args": ["/Users/yourname/path/to/bb-mcp-sandbox/src/server.ts"],
  "workingDirectory": "/Users/yourname/path/to/bb-mcp-sandbox",
  "env": { "LOG_LEVEL": "info", "NO_COLOR": "1" }
}
```

代替（tsx を node 経由で実行する。shebang 相性回避用）:
```json
{
  "command": "node",
  "args": [
    "/Users/yourname/path/to/bb-mcp-sandbox/node_modules/tsx/dist/cli.mjs",
    "/Users/yourname/path/to/bb-mcp-sandbox/src/server.ts"
  ],
  "workingDirectory": "/Users/yourname/path/to/bb-mcp-sandbox",
  "env": { "LOG_LEVEL": "info", "NO_COLOR": "1" }
}
```

注意:
- `npx` は標準出力に余分なメッセージを出す場合があり、MCP の stdio ハンドシェイクが失敗する原因になります。
- `command` / `args` は双方とも絶対パスで指定してください（相対パス解決の差分を排除）。
- Node 18+ を推奨。既存サーバープロセスが残っていると接続できない場合は停止してください。

## Skills の運用（Claude Skills と MCP の役割分担）

- Claude Skills は「どう動くか（手順・判断）」を定義する知識層、MCP は「外部データに安全にアクセスする実行層」です。競合ではなく階層分担です。
- 本リポジトリでは Skills を `skills/<skill_name>/SKILL.md` に置きます。MCP からは参照されません。Claude で使うにはローカルの `~/.claude/skills/<skill_name>/SKILL.md` に配置してください。

### Skills の同期（フォルダごと）

```bash
npm run sync:skills
```

- `skills/<name>/` フォルダ全体を `~/.claude/skills/<name>/` に同期します（`SKILL.md` に加え、参照ドキュメントやスクリプトも含む）。
- `SKILL.md` の frontmatter に `name:` があればそれを採用。なければフォルダ名を技能名として同期します。

### 推奨アーキテクチャ

```
User Prompt
  ↓
Claude
  ├── (Skill) multi_factor_signal → 分析手順・判断ルール
  │        ↓
  └── (MCP) bitbank-mcp → 実データ取得・チャート生成
```

### 参考 Skills

- `skills/multi_factor_signal/SKILL.md`: 指標合成で結論先出し、必要時のみ深掘り
- `skills/charting_rules/SKILL.md`: チャート描画のプロジェクト規約（必ず `render_chart_svg` を使用）

<!-- InspectorのUI詳細手順はボリュームのため省略。必要時は issue/Docs を参照 -->

## 運用・監視（JSONL ログ集計 / 失敗率・タイムアウト監視）

- 本サーバは `lib/logger.ts` により、ツール実行ログを JSONL として `./logs/YYYY-MM-DD.jsonl` に出力します。
- 集計には `tools/stat.ts` を使用できます。

使用例:

```bash
# 全期間の集計
npm run stat

# 直近24時間の集計
npm run stat -- --last 24h
```

出力指標:
- Total Runs / Success / Failure / Error Rate
- Error Types（timeout, network など）
- Cache Hit Rate（将来拡張用）
- Processing Time（Average/Min/Max）

CI / Cron への統合案:
- GitHub Actions のスケジュール実行で `npm run stat -- --last 24h` を実行し、閾値超過（例: 失敗率 > 5% や Max > 10s）でジョブを失敗させ通知。
- もしくはサーバで cron を設定して日次集計を Slack/Webhook に送付。

cron 例（毎朝09:00に直近24時間を集計しファイルに追記）:
```cron
0 9 * * * cd /path/to/bb-mcp-sandbox && /usr/bin/npm run stat --silent -- --last 24h >> reports/$(date +\%F).log 2>&1
```