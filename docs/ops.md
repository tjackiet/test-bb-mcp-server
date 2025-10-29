## Operations (Logging & Stats)

### JSONL Logs
- 実行ログは `./logs/YYYY-MM-DD.jsonl` に出力されます（`lib/logger.ts`）。

### 集計
```bash
npm run stat           # 全期間
npm run stat -- --last 24h
```

### CI / Cron 例
```cron
0 9 * * * cd /path/to/bb-mcp-sandbox && /usr/bin/npm run stat --silent -- --last 24h >> reports/$(date +\%F).log 2>&1
```


### Docker起動（開発・検証用）

最小の検証用途で Docker を使う場合の例です。Node 18+ があれば Docker は必須ではありません。

```bash
# ビルド
docker build -t bitbank-mcp .

# MCP Inspector からSTDIOで起動（推奨: 余計な出力を抑制）
npx @modelcontextprotocol/inspector docker run -i --rm \
  -e NO_COLOR=1 -e LOG_LEVEL=info \
  bitbank-mcp
```

HTTPで試す場合（任意）:

```bash
docker run -it --rm -p 8787:8787 \
  -e MCP_ENABLE_HTTP=1 -e PORT=8787 \
  -e NO_COLOR=1 -e LOG_LEVEL=info \
  bitbank-mcp

# 別ターミナルから Inspector で接続
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

ログ永続化（任意）:

```bash
docker run -it --rm \
  -v $(pwd)/logs:/app/logs \
  -e NO_COLOR=1 -e LOG_LEVEL=info \
  bitbank-mcp
```


