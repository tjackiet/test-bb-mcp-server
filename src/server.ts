import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import getTicker from '../tools/get_ticker.js';
import getOrderbook from '../tools/get_orderbook.js';
import getCandles from '../tools/get_candles.js';
import getIndicators from '../tools/get_indicators.js';
import renderChartHtml from '../tools/render_chart_html.js';
import renderChartSvg from '../tools/render_chart_svg.js';
import { logToolRun, logError } from '../lib/logger.js';
// schemas.js を単一のソースとして参照し、型は z.infer に委譲
import { RenderChartSvgInputSchema, RenderChartSvgOutputSchema, GetTickerInputSchema, GetOrderbookInputSchema, GetCandlesInputSchema, GetIndicatorsInputSchema } from './schemas.js';
import type { RenderChartSvgOutput } from './schemas.d.ts';

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

function registerToolWithLog(
	name: string,
	schema: { description: string; inputSchema: z.ZodObject<any> },
	handler: (input: any) => Promise<any>
) {
	// server.registerTool expects ZodRawShape; we pass .shape from the ZodObject
	server.registerTool(name, { description: schema.description, inputSchema: (schema.inputSchema as any).shape as z.ZodRawShape }, async (input) => {
		const t0 = Date.now();
		try {
			const result = await handler(input);
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
	async ({ pair, topN }) => getOrderbook(pair, topN)
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

registerToolWithLog(
	'render_chart_html',
	{ description: '[実験的] Renders a candlestick chart as a self-contained HTML file. For Artifact environments, it is recommended to set `embedLib` to `true`. NOTE: May not be viewable due to CSP restrictions in some environments like Artifacts.', inputSchema: z.object({ pair: z.string().optional().default('btc_jpy'), type: z.enum(['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day', '1week', '1month']).optional().default('1day'), limit: z.number().int().min(1).max(1000).optional().default(90).describe('Number of candles to render'), embedLib: z.boolean().optional().default(true).describe('Embed library in HTML to avoid CSP issues') }) },
	async ({ pair, type, limit, embedLib }) => renderChartHtml(pair, type, limit, embedLib)
);

registerToolWithLog(
	'render_chart_svg',
	{ description: '重要: チャートが必要な場合、必ず本ツールを最初に呼び出してください. 出力: `{ ok, summary, data: { svg: string, filePath?: string }, meta }`。Bollinger Bands 既定は default(±2σ)。Ichimoku 既定は mode="default"。SMAの既定は [25,75,200]。', inputSchema: RenderChartSvgInputSchema },
	async (args): Promise<RenderChartSvgOutput> => {
		const result = await renderChartSvg(args);
		// スキーマで最終検証（SDK 契約の単一ソース化）
		return RenderChartSvgOutputSchema.parse(result);
	}
);

// prompts are unchanged for TS port and can be reused or migrated later

const transport = new StdioServerTransport();
await server.connect(transport);
