import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.PORT ?? 8787);
const ENDPOINT = '/mcp';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ngrok Free のブラウザ警告回避用ヘッダ
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', '1');
  next();
});

// 簡易ヘルスチェック
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
// 最低限の /mcp ルート（メタ確認用）
app.get(ENDPOINT, (_req, res) => {
  res.json({
    version: '1.0',
    actions: [
      {
        name: 'ping',
        description: 'Health check action',
        parameters: { type: 'object', properties: { message: { type: 'string', description: 'Any message' } } },
      },
    ],
  });
});

// 最小サーバ（必要に応じて既存の登録ロジックに差し替え可）
const server = new McpServer({ name: 'bb-mcp', version: '1.0.0' });
server.registerTool(
  'ping',
  { description: 'Return a ping response', inputSchema: ({} as any) },
  async (args: any) => ({ content: [{ type: 'text', text: `pong: ${args?.message ?? ''}` }] })
);

// Streamable HTTP transport
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,*.ngrok-free.dev')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const transport: any = new (StreamableHTTPServerTransport as any)({
  path: ENDPOINT, // 一部SDKは endpoint ではなく path を使用
  sessionIdGenerator: () => randomUUID(),
  enableDnsRebindingProtection: true,
  ...(allowedHosts.length ? { allowedHosts } : {}),
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
} as any);
await server.connect(transport as any);

const mw = typeof transport.expressMiddleware === 'function' ? transport.expressMiddleware() : (_req: any, _res: any, next: any) => next();
app.use(ENDPOINT, mw);

app.listen(PORT, '::', () => {
  // eslint-disable-next-line no-console
  console.log(`MCP HTTP listening on http://localhost:${PORT}${ENDPOINT}`);
});


