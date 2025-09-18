import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import getTicker from '../tools/get_ticker.js';
import getOrderbook from '../tools/get_orderbook.js';
import getCandles from '../tools/get_candles.js';
import getIndicators from '../tools/get_indicators.js';
import renderChartSvg from '../tools/render_chart_svg.js';
import { logToolRun, logError } from '../lib/logger.js';
// schemas.ts を単一のソースとして参照し、型は z.infer に委譲
import { RenderChartSvgInputSchema, RenderChartSvgOutputSchema, GetTickerInputSchema, GetOrderbookInputSchema, GetCandlesInputSchema, GetIndicatorsInputSchema } from './schemas.js';

const server = new McpServer({ name: 'bitbank-mcp', version: '0.3.0' });

type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> };
type ToolReturn = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const respond = (result: unknown): ToolReturn => ({
	content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
	...(isPlainObject(result) ? { structuredContent: result } : {}),
});

function registerToolWithLog<S extends z.ZodTypeAny, R = unknown>(
	name: string,
	schema: { description: string; inputSchema: S },
	handler: (input: z.infer<S>) => Promise<R>
) {
	// server.registerTool expects ZodRawShape; extract shape from ZodObject or ZodEffects<ZodObject>
	const getRawShape = (s: z.ZodTypeAny): z.ZodRawShape => {
		const anySchema: any = s as any;
		if (anySchema?.shape) return anySchema.shape as z.ZodRawShape;
		const inner = anySchema?._def?.schema;
		if (inner?.shape) return inner.shape as z.ZodRawShape;
		throw new Error('inputSchema must be ZodObject or ZodEffects<ZodObject>');
	};
	server.registerTool(name, { description: schema.description, inputSchema: getRawShape(schema.inputSchema) }, async (input) => {
		const t0 = Date.now();
		try {
			const result = await handler(input as z.infer<S>);
			const ms = Date.now() - t0;
			logToolRun({ tool: name, input, result, ms });
			return respond(result);
		} catch (err: any) {
			const ms = Date.now() - t0;
			logError(name, err, input);
			return {
				content: [{ type: 'text', text: `internal error: ${err?.message || 'unknown error'}` }],
				structuredContent: {
					ok: false,
					summary: `internal error: ${err?.message || 'unknown error'}`,
					meta: { ms, errorType: 'internal' },
				},
			};
		}
	});
}

registerToolWithLog(
	'get_ticker',
	{ description: 'Get ticker for a pair (e.g., btc_jpy)', inputSchema: GetTickerInputSchema },
	async ({ pair }) => getTicker(pair)
);

registerToolWithLog(
	'get_orderbook',
	{ description: 'Get orderbook topN for a pair', inputSchema: GetOrderbookInputSchema },
	async ({ pair, topN }: any) => getOrderbook(pair, topN)
);

registerToolWithLog(
	'get_candles',
	{ description: 'Get candles. date: 1month → YYYY, others → YYYYMMDD', inputSchema: GetCandlesInputSchema },
	async ({ pair, type, date, limit, view }) => {
		const result = await getCandles(pair, type, date, limit);
		if (view === 'items') {
			const items = result?.data?.normalized ?? [];
			return {
				content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
				// structuredContent は Record<string, unknown> が期待されるため、配列は直接渡さない
				structuredContent: { items } as Record<string, unknown>,
			};
		}
		return result;
	}
);

registerToolWithLog(
	'get_indicators',
	{ description: 'Get technical indicators for a pair. For meaningful results, use a sufficient `limit` (e.g., 200 for daily candles). If `limit` is omitted, an appropriate default value will be used.', inputSchema: GetIndicatorsInputSchema },
	async ({ pair, type, limit }) => getIndicators(pair, type, limit)
);

// render_chart_html は当面サポート外のため未登録

registerToolWithLog(
	'render_chart_svg',
	{ description: '重要: チャートが必要な場合、必ず本ツールを最初に呼び出してください. 出力: `{ ok, summary, data: { svg: string, filePath?: string }, meta }`。Bollinger Bands 既定は default(±2σ)。Ichimoku 既定は mode="default"。SMAの既定は [25,75,200]。', inputSchema: RenderChartSvgInputSchema },
	async (args: any) => {
		const result = await renderChartSvg(args as any);
		// スキーマで最終検証（SDK 契約の単一ソース化）
		return RenderChartSvgOutputSchema.parse(result);
	}
);

// prompts are unchanged for TS port and can be reused or migrated later

// 接続は全登録完了後に実行する（tools/prompts の後）

// === Register prompts (SDK 形式に寄せた最小導入) ===
function registerPromptSafe(name: string, def: { description: string; messages: any[] }) {
	const s: any = server as any;
	if (typeof s.registerPrompt === 'function') {
		s.registerPrompt(name, def);
	} else {
		// no-op if SDK doesn't support prompts in this version
	}
}

registerPromptSafe('bb_light_chart', {
	description: 'Render chart with Bollinger Bands light (±2σ).',
	messages: [
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'light', withSMA: [] },
				},
			],
		},
	],
});

registerPromptSafe('bb_full_chart', {
	description: 'Render chart with Bollinger Bands full (±1/±2/±3σ). Use only if user explicitly requests full.',
	messages: [
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'full', withSMA: [] },
				},
			],
		},
	],
});

registerPromptSafe('ichimoku_default_chart', {
	description: 'Render chart with Ichimoku default (Tenkan/Kijun/Cloud only).',
	messages: [
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withIchimoku: true, ichimoku: { mode: 'default' }, withSMA: [] },
				},
			],
		},
	],
});

registerPromptSafe('ichimoku_extended_chart', {
	description: 'Render chart with Ichimoku extended (includes Chikou). Use only if user explicitly requests extended.',
	messages: [
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withIchimoku: true, ichimoku: { mode: 'extended' }, withSMA: [] },
				},
			],
		},
	],
});

// === stdio 接続（最後に実行） ===
const transport = new StdioServerTransport();
await server.connect(transport);
