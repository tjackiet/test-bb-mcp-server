## Contributing

開発者向けの最小ルールです。詳細は `src/schemas.ts` を単一ソースに保つ点だけ覚えておけばOKです。

### 開発フロー
1. `src/schemas.ts` を更新（入力・出力ともに Zod を単一ソース化）
2. 型生成: `npm run gen:types`
3. 実装更新: ツール/サーバーの戻りを OutputSchema で検証
4. 型チェック: `npm run typecheck`

### スキーマ同期
- ツール定義とプロンプトは自動生成します。
```bash
npm run sync:manifest   # schemas.ts → description.json
npm run sync:prompts    # server.ts の登録内容 → prompts.json
```

### PR 前チェック
```bash
npm run sync:manifest
npm run sync:prompts
npm run gen:types
npm run typecheck
```


