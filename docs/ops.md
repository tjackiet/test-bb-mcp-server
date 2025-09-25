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


