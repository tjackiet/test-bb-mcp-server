import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import getTicker from '../tools/get_ticker.js';
import getOrderbook from '../tools/get_orderbook.js';
import getCandles from '../tools/get_candles.js';
import getIndicators from '../tools/get_indicators.js';
import renderChartSvg from '../tools/render_chart_svg.js';
import detectPatterns from '../tools/detect_patterns.js';
import getDepth from '../tools/get_depth.js';
import { logToolRun, logError } from '../lib/logger.js';
// schemas.ts を単一のソースとして参照し、型は z.infer に委譲
import { RenderChartSvgInputSchema, RenderChartSvgOutputSchema, GetTickerInputSchema, GetOrderbookInputSchema, GetCandlesInputSchema, GetIndicatorsInputSchema } from './schemas.js';
import { GetDepthInputSchema } from './schemas.js';
import { GetVolMetricsInputSchema, GetVolMetricsOutputSchema } from './schemas.js';
// removed GetMarketSummary schemas
import { GetTickersInputSchema } from './schemas.js';
import { GetTransactionsInputSchema, GetFlowMetricsInputSchema } from './schemas.js';
import { GetOrderbookPressureInputSchema } from './schemas.js';
import { GetCircuitBreakInfoInputSchema } from './schemas.js';
import getTransactions from '../tools/get_transactions.js';
import getFlowMetrics from '../tools/get_flow_metrics.js';
import getTickers from '../tools/get_tickers.js';
// get_depth_diff removed in favor of get_orderbook_statistics
import getOrderbookPressure from '../tools/get_orderbook_pressure.js';
import getOrderbookStatistics from '../tools/orderbook_statistics.js';
import getVolatilityMetrics from '../tools/get_volatility_metrics.js';
// removed get_market_summary tool
import analyzeMarketSignal from '../tools/analyze_market_signal.js';
import analyzeIchimokuSnapshot from '../tools/analyze_ichimoku_snapshot.js';
import analyzeBbSnapshot from '../tools/analyze_bb_snapshot.js';
import analyzeSmaSnapshot from '../tools/analyze_sma_snapshot.js';
import getTickersJpy from '../tools/get_tickers_jpy.js';
import detectMacdCross from '../tools/detect_macd_cross.js';
import detectWhaleEvents from '../tools/detect_whale_events.js';
import detectFormingPatterns from '../tools/detect_forming_patterns.js';
import analyzeMacdPattern from './handlers/analyzeMacdPattern.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema } from './schemas.js';
import getCircuitBreakInfo from '../tools/get_circuit_break_info.js';
import { AnalyzeMarketSignalInputSchema, AnalyzeMarketSignalOutputSchema } from './schemas.js';

const server = new McpServer({ name: 'bitbank-mcp', version: '0.3.0' });
// Explicit registries for tools/prompts to improve STDIO inspector compatibility
const registeredTools: Array<{ name: string; description: string; inputSchema: any }> = [];
const registeredPrompts: Array<{ name: string; description: string }> = [];

type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> };
type ToolReturn = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const respond = (result: unknown): ToolReturn => {
	// 優先順位: custom content > summary > safe JSON fallback
	let text = '';
	if (isPlainObject(result)) {
		const r: any = result as any;
		// ツールが content を提供している場合（配列 or 文字列）を優先
		if (Array.isArray(r.content)) {
			const first = r.content.find((c: any) => c && c.type === 'text' && typeof c.text === 'string');
			if (first) {
				text = String(first.text);
			}
		} else if (typeof r.content === 'string') {
			text = String(r.content);
		}
		// 上記で未決定なら summary を採用
		if (!text && typeof r.summary === 'string') {
			text = String(r.summary);
		}
	}
	// それでも空の場合は安全な短縮JSONにフォールバック
	if (!text) {
		try {
			const json = JSON.stringify(result, (_key, value) => {
				if (typeof value === 'string' && value.length > 2000) return `…omitted (${value.length} chars)`;
				return value;
			}, 2);
			text = json.length > 4000 ? json.slice(0, 4000) + '\n…(truncated)…' : json;
		} catch {
			text = String(result);
		}
	}
	return {
		content: [{ type: 'text', text }],
		...(isPlainObject(result) ? { structuredContent: result } : {}),
	};
};

// === In-memory lightweight tracking buffer for depth_diff (per pair) ===
type TrackedOrder = { id: string; side: 'bid' | 'ask'; price: number; size: number; firstTs: number; lastTs: number };
const depthTrackByPair: Map<string, { nextId: number; active: TrackedOrder[] }> = new Map();

function registerToolWithLog<S extends z.ZodTypeAny, R = unknown>(
	name: string,
	schema: { description: string; inputSchema: S },
	handler: (input: z.infer<S>) => Promise<R>
) {
	// Convert Zod schema → JSON Schema (subset) for MCP inspector
	const unwrapZod = (s: any): any => {
		let cur = s;
		for (let i = 0; i < 6; i++) {
			const def = cur?._def;
			if (!def) break;
			if (def?.schema) { cur = def.schema; continue; }
			if (def?.innerType) { cur = def.innerType; continue; }
			break;
		}
		return cur;
	};
	const toJsonSchema = (s: any): any => {
		s = unwrapZod(s);
		const t = s?._def?.typeName;
		switch (t) {
			case 'ZodString': {
				const out: any = { type: 'string' };
				const checks = s?._def?.checks || [];
				const rex = checks.find((c: any) => c.kind === 'regex')?.regex;
				if (rex) out.pattern = String(rex.source);
				return out;
			}
			case 'ZodNumber': {
				const out: any = { type: 'number' };
				const checks = s?._def?.checks || [];
				const min = checks.find((c: any) => c.kind === 'min')?.value;
				const max = checks.find((c: any) => c.kind === 'max')?.value;
				if (Number.isFinite(min)) out.minimum = min;
				if (Number.isFinite(max)) out.maximum = max;
				return out;
			}
			case 'ZodBoolean': return { type: 'boolean' };
			case 'ZodEnum': return { type: 'string', enum: [...(s?._def?.values || [])] };
			case 'ZodArray': return { type: 'array', items: toJsonSchema(s?._def?.type) };
			case 'ZodTuple': {
				const items = (s?._def?.items || []).map((it: any) => toJsonSchema(it));
				return { type: 'array', items, minItems: items.length, maxItems: items.length };
			}
			case 'ZodRecord': return { type: 'object', additionalProperties: toJsonSchema(s?._def?.valueType) };
			case 'ZodObject': {
				const shape = (s as any).shape || (typeof s?._def?.shape === 'function' ? s._def.shape() : undefined) || {};
				const properties: Record<string, any> = {};
				const required: string[] = [];
				for (const [key, zodProp] of Object.entries(shape)) {
					// detect defaults and optional
					let defVal: any = undefined;
					let isOptional = false;
					let cur: any = zodProp as any;
					for (let i = 0; i < 6; i++) {
						const def = cur?._def;
						if (!def) break;
						if (def.typeName === 'ZodDefault') {
							try { defVal = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue; } catch { }
							cur = def.innerType; continue;
						}
						if (def.typeName === 'ZodOptional') { isOptional = true; cur = def.innerType; continue; }
						if (def?.schema) { cur = def.schema; continue; }
						if (def?.innerType) { cur = def.innerType; continue; }
						break;
					}
					properties[key] = toJsonSchema(cur);
					if (defVal !== undefined) properties[key].default = defVal;
					if (!isOptional && defVal === undefined) required.push(key);
				}
				const obj: any = { type: 'object', properties };
				if (required.length) obj.required = required;
				return obj;
			}
			default: return {};
		}
	};

	// Build JSON Schema for listing
	const inputSchemaJson = toJsonSchema(schema.inputSchema) || { type: 'object', properties: {} };
	registeredTools.push({ name, description: schema.description, inputSchema: inputSchemaJson });

	// For actual registration, the SDK expects a Zod raw shape (not JSON schema)
	const getRawShape = (s: z.ZodTypeAny): z.ZodRawShape => {
		let cur: any = s as any;
		for (let i = 0; i < 6; i++) {
			if (cur?.shape) break;
			const def = cur?._def;
			if (!def) break;
			if (def?.schema) { cur = def.schema; continue; }
			if (def?.innerType) { cur = def.innerType; continue; }
			break;
		}
		if (cur?.shape) return cur.shape as z.ZodRawShape;
		throw new Error('inputSchema must be or wrap a ZodObject');
	};

	server.registerTool(name, { description: schema.description, inputSchema: getRawShape(schema.inputSchema) } as any, async (input: any) => {
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
	'get_tickers',
	{ description: 'Get snapshot of tickers across pairs. market=all or jpy. view=items でアイテム一覧をテキスト表示。', inputSchema: GetTickersInputSchema },
	async ({ market, view }: any) => {
		const result: any = await getTickers(market);
		if (view === 'items') {
			const items = result?.data?.items ?? [];
			const text = JSON.stringify(items, null, 2);
			return { content: [{ type: 'text', text }], structuredContent: { items } as Record<string, unknown> };
		}
		return result;
	}
);

registerToolWithLog(
	'get_orderbook',
	{ description: 'Get orderbook opN(1-200) for a pair. view=summary|detailed|full。detailed以上でトップNの板明細と統計を本文に出します。', inputSchema: GetOrderbookInputSchema },
	async ({ pair, opN, view }: any) => {
		const res: any = await getOrderbook(pair, opN);
		if (!res?.ok) return res;
		if (view === 'summary') return res;
		const ob = res?.data?.normalized;
		const top = (levels: any[], n: number) => levels.slice(0, n).map((l) => `${l.price}: ${l.size}`).join('\n');
		const sum = (levels: any[], n: number) => levels.slice(0, n).reduce((a, b) => a + (b.size || 0), 0);
		const n = Number(opN ?? res?.meta?.topN ?? 10);
		const bidVol = sum(ob?.bids ?? [], n);
		const askVol = sum(ob?.asks ?? [], n);
		const ratio = askVol > 0 ? (bidVol / askVol).toFixed(2) : '∞';
		let text = `${String(pair).toUpperCase()} Orderbook (top ${n})\nBest Bid: ${ob?.bestBid} | Best Ask: ${ob?.bestAsk} | Spread: ${ob?.spread}`;
		text += `\n\nTop ${n} Bids:\n${top(ob?.bids ?? [], n)}`;
		text += `\n\nTop ${n} Asks:\n${top(ob?.asks ?? [], n)}`;
		text += `\n\nTotals: bid=${bidVol.toFixed(4)} ask=${askVol.toFixed(4)} | Buy/Sell Ratio=${ratio}`;
		if (view === 'full') {
			const full = `\n\n--- FULL BIDS ---\n${(ob?.bids ?? []).map((l: any) => `${l.price}: ${l.size} (cum ${l.cumSize})`).join('\n')}\n\n--- FULL ASKS ---\n${(ob?.asks ?? []).map((l: any) => `${l.price}: ${l.size} (cum ${l.cumSize})`).join('\n')}`;
			text += full;
		}
		return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
	}
);

registerToolWithLog(
	'get_candles',
	{ description: "Get candles. date: '1month' → YYYY, others → YYYYMMDD. view=full (default) includes first 5 items sample in text (full array in structuredContent.data.normalized). Date is inclusive: fetch {limit} most recent candles up to and including the specified date. Example item: { isoTime, open, high, low, close, volume }. Error handling: Returns errorType='user' for invalid pair/type/date/limit, errorType='network' for network errors.", inputSchema: GetCandlesInputSchema },
	async ({ pair, type, date, limit, view }) => {
		const result: any = await getCandles(pair, type, date, limit);
		if (view === 'items') {
			const items = result?.data?.normalized ?? [];
			return {
				content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
				// structuredContent は Record<string, unknown> が期待されるため、配列は直接渡さない
				structuredContent: { items } as Record<string, unknown>,
			};
		}
		// view=full でもサンプル（先頭5件）を本文に含める
		try {
			const items = Array.isArray(result?.data?.normalized) ? result.data.normalized : [];
			const sample = items.slice(0, 5);
			const header = String(result?.summary ?? `${String(pair).toUpperCase()} [${String(type)}]`);
			const text = `${header}\nSample (first ${sample.length}/${items.length}):\n${JSON.stringify(sample, null, 2)}`;
			return { content: [{ type: 'text', text }], structuredContent: result as Record<string, unknown> };
		} catch {
			return result;
		}
	}
);

registerToolWithLog(
	'get_indicators',
	{ description: 'Get technical indicators (SMA/RSI/BB/Ichimoku/MACD). content には主要指標の要点サマリーを表示します（詳細は structuredContent.data.indicators / chart に含まれます）。分析には十分な `limit` を指定してください（例: 日足は200本）。', inputSchema: GetIndicatorsInputSchema },
	async ({ pair, type, limit }) => {
		const res: any = await getIndicators(pair, type, limit);
		if (!res?.ok) return res;
		const ind: any = res?.data?.indicators ?? {};
		const candles: any[] = Array.isArray(res?.data?.normalized) ? res.data.normalized : [];
		const close = candles.at(-1)?.close ?? null;
		const rsi = ind.RSI_14 ?? null;
		const sma25 = ind.SMA_25 ?? null;
		const sma75 = ind.SMA_75 ?? null;
		const sma200 = ind.SMA_200 ?? null;
		const bbMid = ind.BB_middle ?? ind.BB2_middle ?? null;
		const bbUp = ind.BB_upper ?? ind.BB2_upper ?? null;
		const bbLo = ind.BB_lower ?? ind.BB2_lower ?? null;
		const sigmaZ = (close != null && bbMid != null && bbUp != null && (bbUp - bbMid) !== 0)
			? Number((2 * (close - bbMid) / (bbUp - bbMid)).toFixed(2))
			: null;
		const bandWidthPct = (bbUp != null && bbLo != null && bbMid)
			? Number((((bbUp - bbLo) / bbMid) * 100).toFixed(2))
			: null;
		const macdLine = ind.MACD_line ?? null;
		const macdSignal = ind.MACD_signal ?? null;
		const macdHist = ind.MACD_hist ?? null;
		const spanA = ind.ICHIMOKU_spanA ?? null;
		const spanB = ind.ICHIMOKU_spanB ?? null;
		const cloudTop = (spanA != null && spanB != null) ? Math.max(spanA, spanB) : null;
		const cloudBot = (spanA != null && spanB != null) ? Math.min(spanA, spanB) : null;
		const cloudPos = (close != null && cloudTop != null && cloudBot != null)
			? (close > cloudTop ? 'above_cloud' : (close < cloudBot ? 'below_cloud' : 'in_cloud'))
			: 'unknown';
		const trend = res?.data?.trend ?? 'unknown';
		const count = res?.meta?.count ?? candles.length ?? 0;

		const lines: string[] = [];
		lines.push(`${String(pair).toUpperCase()} [${String(type)}] close=${close ?? 'n/a'} RSI=${rsi ?? 'n/a'} trend=${trend} (count=${count})`);
		lines.push('');
		lines.push('【モメンタム】');
		lines.push(`  RSI(14): ${rsi ?? 'n/a'}`);
		lines.push(`  MACD: line=${macdLine ?? 'n/a'} signal=${macdSignal ?? 'n/a'} hist=${macdHist ?? 'n/a'}`);
		lines.push('');
		lines.push('【トレンド】');
		lines.push(`  SMA(25/75/200): ${sma25 ?? 'n/a'} / ${sma75 ?? 'n/a'} / ${sma200 ?? 'n/a'}`);
		lines.push('');
		lines.push('【ボラティリティ（BB±2σ）】');
		lines.push(`  middle=${bbMid ?? 'n/a'} upper=${bbUp ?? 'n/a'} lower=${bbLo ?? 'n/a'}`);
		lines.push(`  bandWidth=${bandWidthPct != null ? bandWidthPct + '%' : 'n/a'} position=${sigmaZ != null ? sigmaZ + 'σ' : 'n/a'}`);
		// 軽い解釈（1行）: analyze_* の領域を侵さない簡易ヒント
		if (sigmaZ != null) {
			let hint = '';
			if (sigmaZ <= -1) hint = '現在価格は下限付近、反発の可能性';
			else if (sigmaZ >= 1) hint = '現在価格は上限付近、反落の可能性';
			else hint = 'バンド中央付近で方向感弱い';
			const bwHint = bandWidthPct != null ? (bandWidthPct < 8 ? '（収縮気味）' : (bandWidthPct > 20 ? '（拡大型）' : '')) : '';
			lines.push(`  ${hint}${bwHint}`);
		}
		lines.push('');
		lines.push('【一目均衡表】');
		lines.push(`  spanA=${spanA ?? 'n/a'} spanB=${spanB ?? 'n/a'} cloud=${cloudPos}`);
		lines.push('');
		lines.push('詳細は structuredContent.data.indicators / chart を参照。必要に応じて: analyze_bb_snapshot / analyze_ichimoku_snapshot / analyze_sma_snapshot / analyze_market_signal');
		const text = lines.join('\n');
		return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
	}
);

registerToolWithLog(
	'get_depth',
	{ description: 'Get raw orderbook depth. view=summary|sample|full. sample/full outputs top levels into content for LLM analysis; full may be long. Use sampleN to control count (default 10). sample shows totals and bestBid/bestAsk spread.', inputSchema: GetDepthInputSchema },
	async ({ pair, view, sampleN }: any) => {
		const res: any = await getDepth(pair);
		if (!res?.ok) return res;
		if (view === 'summary') return res;
		const asks: any[] = Array.isArray(res?.data?.asks) ? res.data.asks : [];
		const bids: any[] = Array.isArray(res?.data?.bids) ? res.data.bids : [];
		const n = Number(sampleN ?? 10);
		const fmt = (levels: any[]) => levels.map(([p, s]) => `${Number(p).toLocaleString()} : ${Number(s)}`).join('\n');
		const topAsks = view === 'sample' ? asks.slice(0, n) : asks;
		const topBids = view === 'sample' ? bids.slice(0, n) : bids;
		const sumQty = (levels: any[]) => levels.reduce((a, b) => a + Number(b?.[1] ?? 0), 0);
		const bestAsk = topAsks[0]?.[0] != null ? Number(topAsks[0][0]) : null;
		const bestBid = topBids[0]?.[0] != null ? Number(topBids[0][0]) : null;
		const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
		let text = `${String(pair).toUpperCase()} Depth`;
		if (view === 'sample') {
			text += `\nBest Bid: ${bestBid ?? 'n/a'} | Best Ask: ${bestAsk ?? 'n/a'}${spread != null ? ` | Spread: ${spread}` : ''}`;
			text += `\nTotals (top ${n}): bids=${sumQty(topBids).toFixed(4)} asks=${sumQty(topAsks).toFixed(4)}`;
		}
		text += `\n\nTop ${view === 'sample' ? n : topBids.length} Bids:\n${fmt(topBids)}`;
		text += `\n\nTop ${view === 'sample' ? n : topAsks.length} Asks:\n${fmt(topAsks)}`;
		return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
	}
);

// render_chart_html は当面サポート外のため未登録

registerToolWithLog(
	'get_transactions',
	{ description: 'Get recent transactions (trades). view=summary|items。minAmount/minPrice等でフィルタ、itemsで配列本文出力。', inputSchema: GetTransactionsInputSchema },
	async ({ pair, limit, date, minAmount, maxAmount, minPrice, maxPrice, view }: any) => {
		const res: any = await getTransactions(pair, limit, date);
		if (!res?.ok) return res;
		// filter on normalized
		const items = (res?.data?.normalized ?? []).filter((t: any) => (
			(minAmount == null || t.amount >= minAmount) &&
			(maxAmount == null || t.amount <= maxAmount) &&
			(minPrice == null || t.price >= minPrice) &&
			(maxPrice == null || t.price <= maxPrice)
		));
		// recompute summary based on filtered items
		const latestPrice = items.at(-1)?.price;
		const buys = items.filter((t: any) => t.side === 'buy').length;
		const sells = items.filter((t: any) => t.side === 'sell').length;
		const newSummary = `${String(pair).toUpperCase()} close=${latestPrice ?? 'n/a'} trades=${items.length} buy=${buys} sell=${sells}`;
		if (view === 'items') {
			const text = JSON.stringify(items, null, 2);
			return { content: [{ type: 'text', text }], structuredContent: { ...res, summary: newSummary, data: { ...res.data, normalized: items } } as Record<string, unknown> };
		}
		return { ...res, summary: newSummary, data: { ...res.data, normalized: items } };
	}
);

registerToolWithLog(
	'get_flow_metrics',
	{ description: 'Compute flow metrics (CVD, aggressor ratio, volume spikes) from recent transactions. Returns aggregated buy/sell flow analysis with spike detection. content shows summary stats; detailed data in structuredContent.data. Use for: short-term flow dominance, event detection, momentum shifts. For comprehensive multi-factor analysis, prefer analyze_market_signal. bucketMs: time bucket in ms (default 60000). Recommended: 15000-60000 for spike detection, 60000-300000 for trend analysis. limit: 100-2000 (default 100). view=summary|buckets|full (full prints all buckets and may be long); bucketsN controls how many recent buckets to print (default 10). Outputs zscore and spike flags per bucket. tz sets display timezone (default Asia/Tokyo).', inputSchema: GetFlowMetricsInputSchema },
	async ({ pair, limit, date, bucketMs, view, bucketsN, tz }: any) => {
		const res: any = await getFlowMetrics(pair, Number(limit), date, Number(bucketMs), tz);
		if (!res?.ok) return res;
		if (view === 'summary') return res;
		const agg = res?.data?.aggregates ?? {};
		const buckets: any[] = res?.data?.series?.buckets ?? [];
		const n = Number(bucketsN ?? 10);
		const last = buckets.slice(-n);
		const fmt = (b: any) => `${b.displayTime || b.isoTime}  buy=${b.buyVolume} sell=${b.sellVolume} total=${b.totalVolume} cvd=${b.cvd}${b.spike ? ` spike=${b.spike}` : ''}`;
		let text = `${String(pair).toUpperCase()} Flow Metrics (bucketMs=${res?.data?.params?.bucketMs ?? bucketMs})\n`;
		text += `Totals: trades=${agg.totalTrades} buyVol=${agg.buyVolume} sellVol=${agg.sellVolume} net=${agg.netVolume} buy%=${(agg.aggressorRatio * 100 || 0).toFixed(1)} CVD=${agg.finalCvd}`;
		if (view === 'buckets') {
			text += `\n\nRecent ${last.length} buckets:\n` + last.map(fmt).join('\n');
			return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
		}
		// full
		text += `\n\nAll buckets:\n` + buckets.map(fmt).join('\n');
		return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
	}
);
// get_depth_diff removed

/*
registerToolWithLog(
	'get_depth_diff',
	{ description: 'Depth diff between two REST snapshots.', inputSchema: z.object({}) as any },
	async () => ({ ok: false, summary: 'Removed: use get_orderbook_statistics', data: {}, meta: { errorType: 'deprecated' } })
);
*/

/* legacy handler retained above for reference */
/*
	const res: any = await getDepthDiff(pair, delayMs, maxLevels);
	if (!res?.ok) return res;
	if (view === 'summary') return res;
	const agg = res?.data?.aggregates || {};
	const asks = res?.data?.asks || {};
	const bids = res?.data?.bids || {};
	const abs = (n: number) => Math.abs(Number(n || 0));
	const flt = (arr: any[], key: 'size' | 'delta') => (arr || []).filter((x) => abs(x?.[key]) >= (minDeltaBTC || 0)).sort((a, b) => abs(b[key]) - abs(a[key])).slice(0, topN || 5);
	const fmt = (x: any, side: 'ask' | 'bid', kind: 'added' | 'removed' | 'changed', extra?: string) => {
		const sign = kind === 'removed' ? '-' : (kind === 'changed' ? (x.delta >= 0 ? '+' : '') : '+');
		const qty = kind === 'changed' ? x.delta : x.size;
		return `${Number(x.price).toLocaleString()}円 ${sign}${Number(qty).toFixed(2)} BTC (${side})${extra ? ` ${extra}` : ''}`;
	};
	const sigAsksAdded = flt(asks.added, 'size');
	const sigBidsAdded = flt(bids.added, 'size');
	const sigAsksRemoved = flt(asks.removed, 'size');
	const sigBidsRemoved = flt(bids.removed, 'size');
	const sigAsksChanged = flt(asks.changed, 'delta');
	const sigBidsChanged = flt(bids.changed, 'delta');

	// Optional trade cross-reference (basic)
	let tradeNoteMap = new Map<string, string>();
	const startTs = Number(res?.data?.prev?.timestamp ?? 0);
	const endTs = Number(res?.data?.curr?.timestamp ?? 0);
	if (enrichWithTradeData && endTs > startTs) {
		try {
			const txRes: any = await getTransactions(pair, 200, undefined as any);
			const txs: any[] = Array.isArray(txRes?.data?.normalized) ? txRes.data.normalized : [];
			const within = txs.filter((t: any) => Number(t.timestampMs) >= startTs && Number(t.timestampMs) <= endTs);
			const tol = 0.001; // 0.1%
			function matchVol(price: number) {
				return within.filter((t: any) => Math.abs(Number(t.price) - price) / Math.max(1, price) < tol).reduce((s, t) => s + Number(t.amount || 0), 0);
			}
			const allSig = [
				...sigAsksRemoved.map((x: any) => ({ x, side: 'ask', kind: 'removed' })),
				...sigBidsRemoved.map((x: any) => ({ x, side: 'bid', kind: 'removed' })),
				...sigAsksChanged.map((x: any) => ({ x, side: 'ask', kind: 'changed' })),
				...sigBidsChanged.map((x: any) => ({ x, side: 'bid', kind: 'changed' })),
			];
			for (const it of allSig) {
				const vol = matchVol(Number(it.x.price));
				const key = `${it.kind}:${it.side}:${it.x.price}:${it.x.delta ?? it.x.size}`;
				tradeNoteMap.set(key, vol > 0 ? `✅ 約定: ${vol.toFixed(2)} BTC` : '❌ 約定なし');
			}
		} catch { }
	}

	const toIsoJst = (ts: number) => {
		try { return new Date(ts).toLocaleString('ja-JP', { timeZone: tz || 'Asia/Tokyo', hour12: false }); } catch { return new Date(ts).toISOString(); }
	};
	let text = `=== ${String(pair).toUpperCase()} 板変化 (${Number(delayMs) / 1000}s) ===\n`;
	if (startTs && endTs) {
		text += `📅 ${toIsoJst(startTs)} → ${toIsoJst(endTs)}\n   (Unix: ${startTs} → ${endTs})\n`;
	}

	// Movement detection within snapshot (removed -> added near price with similar size)
	const priceTolRel = 0.001; // 0.1%
	const sizeTolRel = 0.05; // 5%
	function findMove(remArr: any[], addArr: any[]) {
		const moves: Array<{ side: 'bid' | 'ask'; from: any; to: any }> = [];
		for (const r of remArr) {
			const cand = addArr.find((a) => Math.abs(a.size - r.size) / Math.max(1e-12, r.size) <= sizeTolRel && Math.abs(a.price - r.price) / Math.max(1, r.price) <= priceTolRel);
			if (cand) moves.push({ side: addArr === sigBidsAdded ? 'bid' : 'ask', from: r, to: cand });
		}
		return moves;
	}
	const bidMoves = findMove(sigBidsRemoved, sigBidsAdded);
	const askMoves = findMove(sigAsksRemoved, sigAsksAdded);

	// Lifetime tracking across calls (LRU-like simple list)
	const track = depthTrackByPair.get(pair) || { nextId: 1, active: [] as TrackedOrder[] };
	depthTrackByPair.set(pair, track);
	const nowTs = endTs || Date.now();
	function attachLifetimeExtra(side: 'bid' | 'ask', item: any, kind: 'added' | 'removed') {
		if (kind === 'added') {
			if ((item.size || 0) >= (minTrackingSizeBTC || 1)) {
				track.active.push({ id: `T${track.nextId++}`, side, price: Number(item.price), size: Number(item.size), firstTs: nowTs, lastTs: nowTs });
			}
			return undefined;
		}
		// removed: try match existing
		const idx = track.active.findIndex((o) => o.side === side && Math.abs(o.size - Number(item.size)) / Math.max(1e-12, o.size) <= sizeTolRel && Math.abs(o.price - Number(item.price)) / Math.max(1, o.price) <= priceTolRel);
		if (idx >= 0) {
			const o = track.active[idx];
			const lifetimeSec = ((nowTs - o.firstTs) / 1000).toFixed(1);
			track.active.splice(idx, 1);
			return `| 存在: ${lifetimeSec}s`;
		}
		return undefined;
	}
	const tilt = agg.bidNetDelta - agg.askNetDelta;
	text += `${tilt >= 0 ? '🟢 買い圧力優勢' : '🔴 売り圧力優勢'}: bid ${agg.bidNetDelta} BTC, ask ${agg.askNetDelta} BTC`;
	text += `\n\n📊 主要な変化:`;
	const moveDur = startTs && endTs ? `${((endTs - startTs) / 1000).toFixed(1)}s` : '';
	const moveLines = [
		...bidMoves.map((m: any) => {
			const key = `removed:bid:${m.from.price}:${m.from.size}`;
			const note = tradeNoteMap.get(key);
			return `[移動] ${Number(m.from.price).toLocaleString()}円 → ${Number(m.to.price).toLocaleString()}円 | ${Number(m.to.size).toFixed(2)} BTC (bid)${moveDur ? ` | ${moveDur}` : ''}${note ? ` \n       └─ ${note}` : ''}`;
		}),
		...askMoves.map((m: any) => {
			const key = `removed:ask:${m.from.price}:${m.from.size}`;
			const note = tradeNoteMap.get(key);
			return `[移動] ${Number(m.from.price).toLocaleString()}円 → ${Number(m.to.price).toLocaleString()}円 | ${Number(m.to.size).toFixed(2)} BTC (ask)${moveDur ? ` | ${moveDur}` : ''}${note ? ` \n       └─ ${note}` : ''}`;
		}),
	];
	const lines = [
		...moveLines,
		...sigAsksAdded.map((x: any) => {
			attachLifetimeExtra('ask', x, 'added');
			return `[追加] ${fmt(x, 'ask', 'added')}`;
		}),
		...sigBidsAdded.map((x: any) => {
			attachLifetimeExtra('bid', x, 'added');
			return `[追加] ${fmt(x, 'bid', 'added')}`;
		}),
		...sigAsksRemoved.map((x: any) => {
			const key = `removed:ask:${x.price}:${x.size}`;
			const life = attachLifetimeExtra('ask', x, 'removed');
			const extra = [tradeNoteMap.get(key), life].filter(Boolean).join(' ');
			return `[削除] ${fmt(x, 'ask', 'removed', extra)}`;
		}),
		...sigBidsRemoved.map((x: any) => {
			const key = `removed:bid:${x.price}:${x.size}`;
			const life = attachLifetimeExtra('bid', x, 'removed');
			const extra = [tradeNoteMap.get(key), life].filter(Boolean).join(' ');
			return `[削除] ${fmt(x, 'bid', 'removed', extra)}`;
		}),
		...sigAsksChanged.map((x: any) => {
			const key = `changed:ask:${x.price}:${x.delta}`;
			return `[増減] ${fmt(x, 'ask', 'changed', tradeNoteMap.get(key))}`;
		}),
		...sigBidsChanged.map((x: any) => {
			const key = `changed:bid:${x.price}:${x.delta}`;
			return `[増減] ${fmt(x, 'bid', 'changed', tradeNoteMap.get(key))}`;
		}),
	];
	text += `\n` + (lines.length ? lines.join('\n') : '該当なし');
	// optional: enrich with trades and simple tracking hints
	if (enrichWithTradeData) {
		text += `\n\n🧾 約定照合: （簡易）観測期間内の実約定を参照して大口変化の相関を示します（詳細は別ツール推奨）`;
		// 提示のみ（実装は get_transactions を別途連携する拡張余地）
	}
	if (trackLargeOrders) {
		text += `\n\n🛰️ 追跡対象: ${minTrackingSizeBTC}BTC 以上の大口を優先的に監視（試験的）`;
	}
	if (view === 'full') {
		const dump = (title: string, arr: any[], side: 'ask' | 'bid', kind: 'added' | 'removed' | 'changed') => `\n\n--- ${title} (${side}) ---\n` + (arr || []).map((x) => fmt(x, side, kind)).join('\n');
		text += dump('ADDED', asks.added, 'ask', 'added');
		text += dump('REMOVED', asks.removed, 'ask', 'removed');
		text += dump('CHANGED', asks.changed, 'ask', 'changed');
		text += dump('ADDED', bids.added, 'bid', 'added');
		text += dump('REMOVED', bids.removed, 'bid', 'removed');
		text += dump('CHANGED', bids.changed, 'bid', 'changed');
	}
	return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
}
);
*/

registerToolWithLog(
	'get_orderbook_pressure',
	{ description: '板のセンチメント（買い/売り偏り）を静的スナップショットから評価します。bandsPct で帯域（%）を指定。本文に各帯域の詳細と総合判定を表示します。', inputSchema: GetOrderbookPressureInputSchema },
	async ({ pair, delayMs, bandsPct, normalize, weightScheme }: any) => {
		const res: any = await getOrderbookPressure(pair, delayMs, bandsPct);
		if (!res?.ok) return res;
		const bands: any[] = Array.isArray(res?.data?.bands) ? res.data.bands : [];
		if (bands.length === 0) return res;
		// derive volumes/score from tool output
		const rows = bands.map((b) => ({ pct: Number(b.widthPct), buy: Number(b.baseBidSize || 0), sell: Number(b.baseAskSize || 0), score: Number(b.netDeltaPct || 0) }));
		// normalization (optional): midvol across central bands (±0.2%〜0.5%)
		const central = rows.filter(r => r.pct >= 0.002 && r.pct <= 0.005);
		const sel = central.length ? central : rows.slice(0, Math.min(2, rows.length));
		const midVolume = sel.length ? (sel.reduce((s, r) => s + (r.buy + r.sell), 0) / sel.length) : 0;
		const epsNorm = 1e-9;
		const normScale = Math.max(epsNorm, midVolume);
		const normMode = String(normalize || 'none');
		const useNorm = normMode === 'midvol';
		const normInfo = { mode: useNorm ? 'midvol' : 'none', scale: useNorm ? Number(normScale.toFixed(6)) : null } as const;
		// weights for overall (closest bands first)
		const sorted = [...rows].sort((a, b) => a.pct - b.pct);
		let weights: number[];
		if ((weightScheme || 'byDistance') === 'equal') {
			weights = sorted.map(() => 1 / Math.max(1, sorted.length));
		} else {
			// distance-based: decreasing weights normalized to sum=1
			const raw = sorted.map((_, i) => 1 / (i + 1));
			const sum = raw.reduce((s, v) => s + v, 0) || 1;
			weights = raw.map(v => v / sum);
		}
		const overall = sorted.reduce((s, r, i) => s + (r.score * (weights[i] || 0)), 0);
		const s = overall;
		const sentiment = s <= -0.30 ? 'sell' : s <= -0.10 ? 'slightly_sell' : (Math.abs(s) < 0.10 ? 'neutral' : (s >= 0.30 ? 'buy' : 'slightly_buy'));
		// nearby wall from smallest band (pressure threshold logic)
		const nearest = sorted[0];
		const nearestPressure = nearest ? nearest.score : 0;
		const threshold = 0.10;
		const nearbyWall = nearest ? (nearestPressure > threshold ? 'bid' : (nearestPressure < -threshold ? 'ask' : 'none')) : 'none';
		// cliff score: thickness gap between first and second band (0-1 approx)
		const cliffScore = (() => {
			if (sorted.length < 2) return 0;
			const v1 = (sorted[0].buy + sorted[0].sell);
			const v2 = (sorted[1].buy + sorted[1].sell);
			const tot = v1 + v2;
			if (tot <= 0) return 0;
			const d = Math.abs(v1 - v2) / tot;
			return Number(d.toFixed(2));
		})();
		// distance label + implication
		const getDistanceLabel = (pct: number) => (pct <= 0.002 ? '直近' : (pct <= 0.006 ? '短期' : '中期'));
		const generateImplication = (score: number, pct: number) => {
			const distance = getDistanceLabel(pct);
			const absScore = Math.abs(score);
			if (absScore < 0.05) return `${distance}では均衡`;
			if (score > 0) {
				if (absScore > 0.20) return pct <= 0.002 ? `${distance}に強い買い壁（サポート）` : `${distance}的に厚い買い板（下支え期待）`;
				return `${distance}ではやや買い優勢`;
			} else {
				if (absScore > 0.20) return pct <= 0.002 ? `${distance}に強い売り壁（反発抵抗）` : `${distance}的に厚い売り板（上値重い）`;
				return `${distance}ではやや売り優勢`;
			}
		};

		// format lines per band
		const bandLines = rows
			.sort((a, b) => a.pct - b.pct)
			.map((r) => {
				const imp = generateImplication(r.score, r.pct);
				return `±${(r.pct * 100).toFixed(1)}%: 買${r.buy.toFixed(2)} BTC / 売${r.sell.toFixed(2)} BTC (圧力${r.score >= 0 ? '+' : ''}${r.score.toFixed(2)}) - ${imp}`;
			});
		const mid = res?.data?.bands?.[0]?.baseMid ?? null;
		// spread in bps (fetch best bid/ask quickly)
		let spreadBpsStr = 'n/a bps';
		try {
			const dres: any = await getDepth(pair);
			if (dres?.ok) {
				const bestAsk = Number(dres?.data?.asks?.[0]?.[0]);
				const bestBid = Number(dres?.data?.bids?.[0]?.[0]);
				if (Number.isFinite(bestAsk) && Number.isFinite(bestBid) && mid != null) {
					const spreadAbs = bestAsk - bestBid;
					const spreadRatio = spreadAbs / Number(mid);
					const spreadBpsVal = spreadRatio * 10000;
					const fmtBps = (x: number) => (Math.abs(x) < 1 ? x.toFixed(3) : x.toFixed(1));
					spreadBpsStr = `${fmtBps(spreadBpsVal)}bps`;
				}
			}
		} catch { }
		const text = [
			`${String(pair).toUpperCase()} ${mid != null ? Math.round(mid).toLocaleString() + '円' : ''}`.trim(),
			`全体圧力: ${s >= 0 ? '+' : ''}${s.toFixed(2)} (${sentiment.replace('_', ' ')})`,
			`正規化: ${normInfo.mode}${normInfo.scale != null ? ` (scale=${normInfo.scale})` : ''} | weight=${(weightScheme || 'byDistance')}`,
			'',
			'【帯域別】',
			...bandLines,
			'',
			`市場構造: スプレッド ${spreadBpsStr}、近接壁=${nearbyWall}、段差スコア ${cliffScore}`,
			'→ 瞬時の買い/売り偏りを要約（静的評価）'
		].join('\n');
		return { content: [{ type: 'text', text }], structuredContent: { ...res, data: { ...res.data, normalization: normInfo, weights: { scheme: (weightScheme || 'byDistance'), values: weights } } } as Record<string, unknown> };
	}
);

// New: orderbook statistics (swing/long-term investors)
registerToolWithLog(
	'get_orderbook_statistics',
	{ description: '板の厚み/流動性分布/大口/総合評価を返すスナップショット統計。ranges(%)とpriceZones(分割数)で範囲指定。用途: 市場構造の定量把握。', inputSchema: z.object({ pair: z.string().default('btc_jpy'), ranges: z.array(z.number()).optional().default([0.5, 1.0, 2.0]), priceZones: z.number().int().min(2).max(50).optional().default(10) }) as any },
	async ({ pair, ranges, priceZones }: any) => getOrderbookStatistics(pair, ranges, priceZones)
);

registerToolWithLog(
	'get_volatility_metrics',
	{ description: 'Compute deterministic volatility metrics (RV/ATR/Parkinson/GK/RS) over candles. content shows key aggregates and rolling trends (summary/detailed/full via view). Tags always printed. Use with analyze_market_signal for integrated judgment.', inputSchema: GetVolMetricsInputSchema },
	async ({ pair, type, limit, windows, useLogReturns, annualize, view }: any) => {
		const res: any = await getVolatilityMetrics(pair, type, limit, windows, { useLogReturns, annualize });
		if (!res?.ok) return res;
		const meta = res?.data?.meta || {};
		const a = res?.data?.aggregates || {};
		const roll: any[] = Array.isArray(res?.data?.rolling) ? res.data.rolling : [];
		const closeSeries: number[] = Array.isArray(res?.data?.series?.close) ? res.data.series.close : [];
		const lastClose = closeSeries.at(-1) ?? null;
		const ann = !!meta.annualize;
		const baseMs = Number(meta.baseIntervalMs ?? 0);
		const annFactor = ann && baseMs > 0 ? Math.sqrt(365 * 24 * 3600 * 1000 / baseMs) : 1;
		const rvAnn = a.rv_std_ann != null ? a.rv_std_ann : (a.rv_std != null ? a.rv_std * annFactor : null);
		const pkAnn = a.parkinson != null ? a.parkinson * (ann ? annFactor : 1) : null;
		const gkAnn = a.garmanKlass != null ? a.garmanKlass * (ann ? annFactor : 1) : null;
		const rsAnn = a.rogersSatchell != null ? a.rogersSatchell * (ann ? annFactor : 1) : null;
		const atrAbs = a.atr != null ? a.atr : null;
		const atrPct = lastClose ? (atrAbs as number) / lastClose : null;

		// tags: base + derived
		const tagsBase: string[] = Array.isArray(res?.data?.tags) ? [...res.data.tags] : [];
		const tagsDerived: string[] = [];
		if (Array.isArray(roll) && roll.length >= 2) {
			const minW = Math.min(...roll.map(r => r.window));
			const maxW = Math.max(...roll.map(r => r.window));
			const short = roll.find(r => r.window === minW);
			const long = roll.find(r => r.window === maxW);
			const shortVal = short ? (short.rv_std_ann ?? (short.rv_std != null ? short.rv_std * annFactor : null)) : null;
			const longVal = long ? (long.rv_std_ann ?? (long.rv_std != null ? long.rv_std * annFactor : null)) : null;
			if (shortVal != null && longVal != null) {
				if (shortVal > longVal * 1.05) tagsDerived.push('expanding_vol');
				else if (shortVal < longVal * 0.95) tagsDerived.push('contracting_vol');
				if (shortVal > 0.4) tagsDerived.push('high_short_term_vol');
			}
		}
		if (rvAnn != null) {
			if (rvAnn > 0.5) tagsDerived.push('high_vol');
			if (rvAnn < 0.2) tagsDerived.push('low_vol');
		}
		if (rvAnn != null && atrPct != null && rvAnn > 0) {
			const diff = Math.abs(atrPct - rvAnn) / rvAnn;
			if (diff > 0.2) tagsDerived.push('atr_divergence');
		}
		const tagsAll = [...new Set([...(tagsBase || []), ...tagsDerived])];

		// summary view
		if (view === 'summary') {
			const line = `${String(pair).toUpperCase()} [${String(type)}] samples=${meta.sampleSize ?? 'n/a'} RV=${fmtPct(rvAnn)} ATR=${fmtCurrencyShort(pair, atrAbs)} PK=${fmtPct(pkAnn)} GK=${fmtPct(gkAnn)} RS=${fmtPct(rsAnn)} Tags: ${tagsAll.join(', ')}`;
			return { content: [{ type: 'text', text: line }], structuredContent: { ...res, data: { ...res.data, tags: tagsAll } } as Record<string, unknown> };
		}

		// detailed/full
		const windowsList = roll.map(r => r.window).join('/');
		const header = `${String(pair).toUpperCase()} [${String(type)}] close=${lastClose != null ? Number(lastClose).toLocaleString() : 'n/a'}\n`;
		const block1 = `【Volatility Metrics${ann ? ' (annualized)' : ''}, ${meta.sampleSize ?? 'n/a'} samples】\nRV (std): ${fmtPct(rvAnn)}\nATR: ${fmtCurrency(pair, atrAbs)}\nParkinson: ${fmtPct(pkAnn)}\nGarman-Klass: ${fmtPct(gkAnn)}\nRogers-Satchell: ${fmtPct(rsAnn)}`;

		const maxW = roll.length ? Math.max(...roll.map(r => r.window)) : null;
		const baseVal = maxW != null ? (roll.find(r => r.window === maxW)?.rv_std_ann ?? ((roll.find(r => r.window === maxW)?.rv_std ?? null) as number) * (ann ? annFactor : 1)) : null;
		const arrowFor = (val: number | null | undefined) => {
			if (val == null || baseVal == null) return '→';
			if (val > baseVal * 1.05) return '⬆⬆';
			if (val > baseVal) return '⬆';
			if (val < baseVal * 0.95) return '⬇⬇';
			if (val < baseVal) return '⬇';
			return '→';
		};
		const trendLines = roll.map(r => {
			const now = r.rv_std_ann ?? (r.rv_std != null ? r.rv_std * (ann ? annFactor : 1) : null);
			return `${r.window}-day RV: ${fmtPct(now)} ${arrowFor(now)}`;
		});

		let text = header + '\n' + block1 + '\n\n' + `【Rolling Trends (${windowsList}-day windows)】\n` + trendLines.join('\n') + '\n\n' + `【Assessment】\nTags: ${tagsAll.join(', ')}`;
		if (view === 'full') {
			const series = res?.data?.series || {};
			const tsArr: number[] = Array.isArray(series.ts) ? series.ts : [];
			const firstIso = tsArr.length ? new Date(tsArr[0]).toISOString() : 'n/a';
			const lastIso = tsArr.length ? new Date(tsArr[tsArr.length - 1]).toISOString() : 'n/a';
			const cArr: number[] = Array.isArray(series.close) ? series.close : [];
			const minClose = cArr.length ? Math.min(...cArr) : null;
			const maxClose = cArr.length ? Math.max(...cArr) : null;
			const retArr: number[] = Array.isArray(series.ret) ? series.ret : [];
			const mean = retArr.length ? (retArr.reduce((s, v) => s + v, 0) / retArr.length) : null;
			const std = retArr.length ? Math.sqrt(retArr.reduce((s, v) => s + Math.pow(v - (mean as number), 2), 0) / retArr.length) : null;
			text += `\n\n【Series】\nTotal: ${meta.sampleSize ?? cArr.length} candles\nFirst: ${firstIso} , Last: ${lastIso}\nClose range: ${minClose != null ? Number(minClose).toLocaleString() : 'n/a'} - ${maxClose != null ? Number(maxClose).toLocaleString() : 'n/a'} JPY\nReturns: mean=${mean != null ? (mean * 100).toFixed(2) + '%' : 'n/a'}, std=${std != null ? (std * 100).toFixed(2) + '%' : 'n/a'}${ann ? ' (base interval)' : ''}`;
		}
		return { content: [{ type: 'text', text }], structuredContent: { ...res, data: { ...res.data, tags: tagsAll } } as Record<string, unknown> };

		function fmtPct(x: any) { return x == null ? 'n/a' : `${Number(x * 100).toFixed(1)}%`; }
		function fmtCurrency(p: any, v: any) {
			if (v == null) return 'n/a';
			const isJpy = typeof p === 'string' && p.toLowerCase().includes('jpy');
			return isJpy ? `${Number(v).toLocaleString()} JPY` : `${Number(v).toFixed(2)}`;
		}
		function fmtCurrencyShort(p: any, v: any) {
			if (v == null) return 'n/a';
			const isJpy = typeof p === 'string' && p.toLowerCase().includes('jpy');
			if (isJpy) {
				const n = Number(v);
				return n >= 1000 ? `${Math.round(n / 1000)}k JPY` : `${n.toLocaleString()} JPY`;
			}
			return `${Number(v).toFixed(2)}`;
		}
	}
);

registerToolWithLog(
	'get_circuit_break_info',
	{ description: 'Circuit break / auction info is currently unsupported (no public source). Do not call. Returns ok=false with reason=unsupported.', inputSchema: GetCircuitBreakInfoInputSchema },
	async ({ pair }: any) => getCircuitBreakInfo(pair)
);

registerToolWithLog(
	'render_chart_svg',
	{ description: 'ローソク足/ライン/板チャートをSVG形式で生成します。\n\n【使用タイミング】\n- ユーザーが視覚的確認を求めている時\n- パターンや指標の根拠を視覚的に示したい時\n- detect_patterns 等の分析結果を可視化したい時\n\n【返却形式】\n- data.svg: 完全なSVG文字列（最重要。これをそのまま image/svg+xml のアーティファクトとして出力）\n- data.filePath: サイズ超過時のみファイルパス（または preferFile=true の場合に常に）\n- data.legend: 描画したレイヤの凡例\n- meta.range: { start, end }（ISO8601）\n- meta.indicators: 表示中のインジケータ一覧\n\n【CRITICAL: アーティファクト表示要件】\n- SVGは必ず antArtifact タグで表示（例: <antArtifact type="image/svg+xml" isClosed="true">…</antArtifact>）\n- artifact タグは使用不可（テキスト表示になり視覚化されません）\n- タグ名は大文字小文字を厳密に: antArtifact（antは小、ArtifactのAは大）\n- data.svg が null の場合: file_read で data.filePath を読み、同様に antArtifact で表示\n\n【基本例】\nrender_chart_svg({ pair: "btc_jpy", type: "1day", limit: 30 })\n→ 返却 { data: { svg: "<svg>...</svg>" }, meta: { range: {start, end}, indicators: [..] } }\n→ LLMは data.svg をそのままアーティファクト出力。data.svg が null の場合は data.filePath を file_read で読み取り表示。\n\n【他ツールとの連携】\n1) detect_patterns を実行\n2) 返却された data.overlays を取得\n3) render_chart_svg({ overlays: data.overlays }) に渡して描画（ranges/annotations/depth_zones に対応）\n\n【軽量化オプション】\n- svgPrecision, svgMinify, simplifyTolerance, viewBoxTight\n- maxSvgBytes: 超過時は data.filePath、preferFile=true: 常に保存のみ', inputSchema: RenderChartSvgInputSchema },
	async (args: any) => {
		// Default to file-first strategy for reliability
		const effArgs = {
			...args,
			autoSave: args?.autoSave !== undefined ? args.autoSave : true,
			preferFile: args?.preferFile !== undefined ? args.preferFile : true,
		};
		const raw = await renderChartSvg(effArgs as any);
		const parsed = RenderChartSvgOutputSchema.parse(raw);
		// 本文に SVG/メタ情報を含め、LLM が structuredContent を見られない環境でも利用できるようにする
		try {
			const data: any = (parsed as any).data || {};
			const meta: any = (parsed as any).meta || {};
			const pair = String(meta?.pair || args?.pair || 'pair').toUpperCase();
			const type = String(meta?.type || args?.type || '1day');
			const header = `${pair} ${type} chart rendered`;
			// Prefer file output (concise link-based content)
			if (data?.filePath || data?.url) {
				const rangeLine = meta?.range ? `- Period: ${meta.range.start} to ${meta.range.end}` : '';
				const tfLine = `- Timeframe: ${type}${meta?.limit ? ` (${meta.limit} candles)` : ''}`;
				const indLine = `- Indicators: ${Array.isArray(meta?.indicators) && meta.indicators.length ? meta.indicators.join(', ') : 'None'}`;
				const sizeLine = meta?.sizeBytes != null ? `- Size: ${meta.sizeBytes} bytes` : '';
				const linkLine = data?.url ? `View chart: ${data.url}` : `View chart: computer://${data.filePath}`;
				const text = [
					'\n📊 Chart Generated Successfully',
					'',
					linkLine,
					'',
					'Chart Details:',
					`- Pair: ${pair}`,
					rangeLine,
					tfLine,
					indLine,
					sizeLine,
					'',
					'Note: The chart has been saved as an SVG file. Use the link above to view it.'
				].filter(Boolean).join('\n');
				const enriched = {
					...(parsed as any),
					displayMode: 'file',
					artifactHint: {
						renderHint: 'FILE_LINK',
						displayType: 'image/svg+xml',
						source: 'file',
						svgBytes: Number(meta?.sizeBytes ?? 0),
						filePath: data?.filePath || null,
						fileUrl: data?.url || (data?.filePath ? `computer://${data.filePath}` : null),
					},
				} as any;
				return { content: [{ type: 'text', text }], structuredContent: enriched };
			}
			if (data?.svg) {
				const rangeLine = meta?.range ? `- Period: ${meta.range.start} to ${meta.range.end}` : '';
				const tfLine = `- Timeframe: ${type}${meta?.limit ? ` (${meta.limit} candles)` : ''}`;
				const indLine = `- Indicators: ${Array.isArray(meta?.indicators) && meta.indicators.length ? meta.indicators.join(', ') : 'none'}`;
				const sizeLine = meta?.sizeBytes != null ? `- Size: ${meta.sizeBytes} bytes` : '';
				const legendLines = data?.legend ? Object.entries(data.legend).map(([k, v]: any[]) => `- ${k}: ${String(v)}`).join('\n') : '';
				const text = [
					header,
					'',
					'=== SVG_START ===',
					String(data.svg),
					'=== SVG_END ===',
					'',
					'Chart Info:',
					rangeLine,
					tfLine,
					indLine,
					sizeLine,
					'',
					legendLines ? 'Legend:\n' + legendLines : ''
				].filter(Boolean).join('\n');
				const enriched = {
					...(parsed as any),
					artifactHint: {
						renderHint: 'ARTIFACT_REQUIRED',
						displayType: 'image/svg+xml',
						source: 'inline_svg',
						svgBytes: Number(meta?.sizeBytes ?? 0),
						filePath: data?.filePath || null,
						fileUrl: data?.url || null,
					},
				} as any;
				return { content: [{ type: 'text', text }], structuredContent: enriched };
			}
			return { content: [{ type: 'text', text: header }], structuredContent: parsed as any };
		} catch {
			return { content: [{ type: 'text', text: String((parsed as any)?.summary || 'chart rendered') }], structuredContent: parsed as any };
		}
	}
);

registerToolWithLog(
	'detect_patterns',
	{ description: '古典的チャートパターン（ダブルトップ/ヘッドアンドショルダーズ/三角持ち合い等）を検出します。content に検出名・信頼度・期間（必要に応じて価格範囲/ネックライン）を出力。視覚確認には render_chart_svg の overlays に structuredContent.data.overlays を渡してください。view=summary|detailed|full（既定=detailed）。', inputSchema: DetectPatternsInputSchema },
	async ({ pair, type, limit, patterns, swingDepth, tolerancePct, minBarsBetweenSwings, view }: any) => {
		const out = await detectPatterns(pair, type, limit, { patterns, swingDepth, tolerancePct, minBarsBetweenSwings });
		const res = DetectPatternsOutputSchema.parse(out as any);
		if (!res?.ok) return res as any;
		const pats: any[] = Array.isArray((res as any)?.data?.patterns) ? (res as any).data.patterns : [];
		const meta: any = (res as any)?.meta || {};
		const count = Number(meta?.count ?? pats.length ?? 0);
		const hdr = `${String(pair).toUpperCase()} [${String(type)}] ${limit ?? count}本から${pats.length}件を検出`;
		// detection period (if candles range available in meta or infer from patterns)
		try {
			const toTs = (s?: string) => { try { return s ? Date.parse(s) : NaN; } catch { return NaN; } };
			const ends = pats.map(p => toTs(p?.range?.end)).filter((x: number) => Number.isFinite(x));
			const starts = pats.map(p => toTs(p?.range?.start)).filter((x: number) => Number.isFinite(x));
			if (starts.length && ends.length) {
				const startIso = new Date(Math.min(...starts)).toISOString().slice(0, 10);
				const endIso = new Date(Math.max(...ends)).toISOString().slice(0, 10);
				const days = Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 86400000));
				// prepend detection window line in summary/detailed
				if (view === 'summary') {
					// nothing extra here; appended below
				}
			}
		} catch { }
		// 種別別件数集計
		const byType = pats.reduce((m: Record<string, number>, p: any) => { const k = String(p?.type || 'unknown'); m[k] = (m[k] || 0) + 1; return m; }, {} as Record<string, number>);
		const typeSummary = Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(', ');
		const fmtLine = (p: any, idx: number) => {
			const name = String(p?.type || 'unknown');
			const conf = p?.confidence != null ? Number(p.confidence).toFixed(2) : 'n/a';
			const range = p?.range ? `${p.range.start} ~ ${p.range.end}` : 'n/a';
			let priceRange: string | null = null;
			if (Array.isArray(p?.pivots) && p.pivots.length) {
				const prices = p.pivots.map((v: any) => Number(v?.price)).filter((x: any) => Number.isFinite(x));
				if (prices.length) priceRange = `${Math.min(...prices).toLocaleString()}円 - ${Math.max(...prices).toLocaleString()}円`;
			}
			let neckline: string | null = null;
			if (Array.isArray(p?.neckline) && p.neckline.length === 2) {
				const [a, b] = p.neckline;
				const y1 = Number(a?.y);
				const y2 = Number(b?.y);
				if (Number.isFinite(y1) && Number.isFinite(y2)) {
					neckline = (y1 === y2)
						? `${y1.toLocaleString()}円（水平）`
						: `${y1.toLocaleString()}円 → ${y2.toLocaleString()}円`;
				}
			}
			const lines = [
				`${idx + 1}. ${name} (信頼度: ${conf})`,
				`   - 期間: ${range}`,
				priceRange ? `   - 価格範囲: ${priceRange}` : null,
				neckline ? `   - ネックライン: ${neckline}` : null,
			].filter(Boolean);
			return lines.join('\n');
		};
		if ((view || 'detailed') === 'summary') {
			const toTs = (s?: string) => { try { return s ? Date.parse(s) : NaN; } catch { return NaN; } };
			const now = Date.now();
			const within = (ms: number) => pats.filter(p => Number.isFinite(toTs(p?.range?.end)) && (now - toTs(p.range.end)) <= ms).length;
			const in30 = within(30 * 86400000);
			const in90 = within(90 * 86400000);
			const starts = pats.map(p => toTs(p?.range?.start)).filter((x: number) => Number.isFinite(x));
			const ends = pats.map(p => toTs(p?.range?.end)).filter((x: number) => Number.isFinite(x));
			const periodLine = (starts.length && ends.length) ? `検出対象期間: ${new Date(Math.min(...starts)).toISOString().slice(0, 10)} ~ ${new Date(Math.max(...ends)).toISOString().slice(0, 10)} (${Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 86400000))}日間)` : '';
			const text = `${hdr}（${typeSummary || '分類なし'}、直近30日: ${in30}件、直近90日: ${in90}件）\n${periodLine}\n検討パターン: ${(patterns && patterns.length) ? patterns.join(', ') : '既定セット'}\n※完成パターンのみ。形成中は detect_forming_patterns を使用してください。\n詳細は structuredContent.data.patterns を参照。`;
			return { content: [{ type: 'text', text }], structuredContent: res as any };
		}
		if ((view || 'detailed') === 'full') {
			const body = pats.map((p, i) => fmtLine(p, i)).join('\n\n');
			const overlayNote = (res as any)?.data?.overlays ? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。' : '';
			const trustNote = '\n\n信頼度について（形状一致度・対称性・期間から算出）:\n  0.8以上 = 明瞭なパターン（トレード判断に有効）\n  0.7-0.8 = 推奨レベル（他指標と併用推奨）\n  0.6-0.7 = 参考程度（慎重に判断）\n  0.6未満 = ノイズの可能性';
			const text = `${hdr}（${typeSummary || '分類なし'}）\n\n【検出パターン（全件）】\n${body}${overlayNote}${trustNote}`;
			return { content: [{ type: 'text', text }], structuredContent: res as any };
		}
		// detailed (default): 上位5件
		const top = pats.slice(0, 5);
		const body = top.length ? top.map((p, i) => fmtLine(p, i)).join('\n\n') : '';
		let none = '';
		if (!top.length) {
			none = `\nパターンは検出されませんでした（tolerancePct=${tolerancePct ?? 'default'}）。\n・検討パターン: ${(patterns && patterns.length) ? patterns.join(', ') : '既定セット'}\n・必要に応じて tolerance を 0.03-0.05 に緩和してください`;
		}
		const overlayNote = (res as any)?.data?.overlays ? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。' : '';
		const trustNote = '\n\n信頼度について（形状一致度・対称性・期間から算出）:\n  0.8以上 = 明瞭なパターン（トレード判断に有効）\n  0.7-0.8 = 推奨レベル（他指標と併用推奨）\n  0.6-0.7 = 参考程度（慎重に判断）\n  0.6未満 = ノイズの可能性';
		const usage = `\n\nusage_example:\n  step1: detect_patterns を実行\n  step2: structuredContent.data.overlays を取得\n  step3: render_chart_svg の overlays に渡す`;
		const text = `${hdr}（${typeSummary || '分類なし'}）\n\n${top.length ? '【検出パターン】\n' + body : ''}${none}${overlayNote}${trustNote}${usage}`;
		return { content: [{ type: 'text', text }], structuredContent: { ...res, usage_example: { step1: 'detect_patterns を実行', step2: 'data.overlays を取得', step3: 'render_chart_svg の overlays に渡す' } } as any };
	}
);

// Back-compat alias kept; prefer detect_forming_chart_patterns
// removed: detect_forming_patterns (replaced by detect_forming_chart_patterns)

registerToolWithLog(
	'detect_forming_chart_patterns',
	{ description: '⚠️ チャートパターン（ダブルトップ/ヘッドアンドショルダーズ等）専用。MACDクロスのforming検出には使用不可 → analyze_macd_pattern を使用。形成中パターンを検出し完成度・シナリオを提示。view=summary|detailed|full|debug（既定=detailed）。', inputSchema: z.object({ pair: z.string().default('btc_jpy'), type: z.string().default('1day'), limit: z.number().int().min(20).max(80).default(40), patterns: z.array(z.enum(['double_top', 'double_bottom'] as any)).optional(), minCompletion: z.number().min(0).max(1).default(0.4), view: z.enum(['summary', 'detailed', 'full', 'debug']).optional().default('detailed'), pivotConfirmBars: z.number().int().min(1).max(20).optional(), rightPeakTolerancePct: z.number().min(0.05).max(0.5).optional() }) as any },
	async ({ pair, type, limit, patterns, minCompletion, view, pivotConfirmBars, rightPeakTolerancePct }: any) => detectFormingPatterns(pair, type, limit, { patterns, minCompletion, view, pivotConfirmBars, rightPeakTolerancePct })
);

//

registerToolWithLog(
	'analyze_market_signal',
	{ description: '【初動トリアージ専用】市場の総合状態を単一スコア(-100〜+100)で瞬時評価。分析の起点として最初に呼び出すツール。\n\n■ 主な用途\n- 「今、買い/売り/中立のどれか？」の即答\n- 詳細分析が必要な要素の特定\n- 複数銘柄の相対比較・スクリーニング\n\n■ スコア計算式\nscore = 0.35×buyPressure + 0.25×cvdTrend + 0.15×momentum + 0.10×volatility + 0.15×smaTrend\n\n5要素の意味:\n- buyPressure (35%): 板の買い/売り注文バランス\n- cvdTrend (25%): 累積出来高差分の方向性\n- momentum (15%): RSI/MACDなどの勢い指標\n- volatility (10%): 価格変動の大きさ\n- smaTrend (15%): 移動平均線の配置と変化\n\n■ このツールの限界（重要）\nこれは概要把握用のスナップショット。詳細分析には以下の専門ツールを併用すること:\n- フロー詳細分析 → get_flow_metrics (時系列バケット、スパイク検出)\n- ボラティリティ詳細 → get_volatility_metrics (RV/ATR/Parkinson/GK/RS)\n- テクニカル指標詳細 → get_indicators (RSI/MACD/BB/一目の全詳細値)\n- 板の帯域別分析 → get_orderbook_pressure (±0.1%/0.5%/1%等の層別圧力)\n- パターン検出 → detect_patterns / detect_forming_patterns\n\n■ LLMへの指示\n1. スコアを説明する際は必ず計算式と各要素の寄与度を明示\n2. 最も影響している要素（topContributors）を強調\n3. スコアが中立付近または要素間で矛盾がある場合、追加の専門ツール呼び出しを推奨\n4. SMA関連は「SMA配置トレンド(構造)」と「短期SMA変化スコア(勢い)」を区別して説明', inputSchema: AnalyzeMarketSignalInputSchema },
	async ({ pair, type, flowLimit, bucketMs, windows }: any) => {
		const res = await analyzeMarketSignal(pair, { type, flowLimit, bucketMs, windows });
		return AnalyzeMarketSignalOutputSchema.parse(res);
	}
);

registerToolWithLog(
	'analyze_ichimoku_snapshot',
	{ description: '一目均衡表の数値スナップショットを返します（視覚的判定は行いません）。価格と雲の位置関係、転換線/基準線の関係、雲の傾き（spanA/Bの差分）を数値から評価します。SVGの見た目について断定しないでください。', inputSchema: (await import('./schemas.js')).AnalyzeIchimokuSnapshotInputSchema as any },
	async ({ pair, type, limit }: any) => analyzeIchimokuSnapshot(pair, type, limit)
);

registerToolWithLog(
	'analyze_bb_snapshot',
	{ description: 'ボリンジャーバンドの数値スナップショットを取得。視覚的判断は行わず、客観的な数値のみ提供。\n\n【mode の使い分け】\n- default (推奨): ±2σ帯の基本情報で高速チェック\n  - middle/upper(+2σ)/lower(-2σ)\n  - zScore: 現在価格が±2σ帯のどこに位置するか\n  - bandWidthPct: バンド幅の middle 比（スクイーズ/エクスパンション把握）\n  - 用途: 初動確認、定期監視、軽量スナップショット\n\n- extended: ±1σ/±2σ/±3σ を含む詳細分析\n  - 全階層のバンド値と各層での価格位置\n  - 極端値検出（±3σタッチ、バンドウォーク等）\n  - 用途: 異常値確認、詳細なボラティリティ分析\n\n【他ツールとの使い分け】\n- get_indicators: RSI/MACD等を含む総合テクニカル分析（重い）\n- analyze_bb_snapshot: BB特化で軽量（速い）\n- render_chart_svg: 視覚化が必要な場合', inputSchema: (await import('./schemas.js')).AnalyzeBbSnapshotInputSchema as any },
	async ({ pair, type, limit, mode }: any) => analyzeBbSnapshot(pair, type, limit, mode)
);

registerToolWithLog(
	'analyze_macd_pattern',
	{ description: 'MACDゴールデンクロス/デッドクロスのforming検出と過去統計分析専用。チャートパターン検出は detect_forming_chart_patterns を使用。historyDays（既定90）、performanceWindows（既定1/3/5/10）、minHistogramForForming（既定0.3）。', inputSchema: z.object({ pair: z.string(), historyDays: z.number().int().min(10).max(365).optional().default(90), performanceWindows: z.array(z.number().int().min(1).max(30)).optional().default([1, 3, 5, 10] as any), minHistogramForForming: z.number().min(0).optional().default(0.3) }) as any },
	async ({ pair, historyDays, performanceWindows, minHistogramForForming }: any) => analyzeMacdPattern({ pair, historyDays, performanceWindows, minHistogramForForming })
);

registerToolWithLog(
	'analyze_sma_snapshot',
	{ description: 'SMA の数値スナップショット。指定periodsの最新値、近傍のクロス（golden/dead）、整列状態（bullish/bearish/mixed）。視覚的主張は行いません。', inputSchema: (await import('./schemas.js')).AnalyzeSmaSnapshotInputSchema as any },
	async ({ pair, type, limit, periods }: any) => analyzeSmaSnapshot(pair, type, limit, periods)
);

registerToolWithLog(
	'get_tickers_jpy',
	{ description: 'Public REST /tickers_jpy。contentにサンプル(先頭3件)を表示し、全件は structuredContent.data に含めます。キャッシュTTL=10s。', inputSchema: z.object({}) as any },
	async () => {
		const res: any = await getTickersJpy();
		if (!res?.ok) return res;
		const arr: any[] = Array.isArray(res?.data) ? res.data : [];
		const top = arr.slice(0, 3)
			.map((it) => `${it.pair.toUpperCase()}: ¥${it.last}${it.vol ? ` (24h出来高 ${it.vol})` : ''}`)
			.join('\n');
		const text = `${arr.length} JPYペア取得:\n${top}${arr.length > 3 ? `\n…(他${arr.length - 3}ペア)` : ''}`;
		return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
	}
);



registerToolWithLog(
	'detect_macd_cross',
	{ description: '既にクロスした銘柄のスクリーニング専用。forming 中の検出は analyze_macd_pattern を使用。\n\n市場内の銘柄で直近のMACDゴールデンクロス/デッドクロスを検出します（1day）。\n\nview: summary|detailed（既定=summary）\n- summary: 簡潔な一覧（高速スキャン用）\n- detailed: クロス強度・価格変化等の詳細（分析用）\n推奨: まず summary で全体把握 → 気になる銘柄のみ detailed で深掘り\n\nlookback（既定=3）: 用途別の目安\n- リアルタイム監視: 1-2\n- 週次レビュー: 5-7\n\npairs で検査対象ペアを限定可能。\n\nscreen（任意）: スクリーニング用フィルタ/ソート\n- minHistogramDelta: ヒストグラム変化の下限\n- maxBarsAgo: 直近バー数以内\n- minReturnPct: クロス以降の騰落率下限\n- crossType: golden|dead|both\n- sortBy: date|histogram|return|barsAgo（既定=date）\n- sortOrder: asc|desc（既定=desc）\n- limit: 上位N件', inputSchema: z.object({ market: z.enum(['all', 'jpy']).default('all').describe('対象市場'), lookback: z.number().int().min(1).max(10).default(3).describe('検出ウィンドウ（推奨: リアルタイム=1-2, 週次=5-7）'), pairs: z.array(z.string()).optional().describe('検査対象を限定（省略時は市場全体）'), view: z.enum(['summary', 'detailed']).optional().default('summary').describe('summary: 簡潔な一覧（高速スキャン） / detailed: クロス強度・騰落率などの詳細（深掘り）。推奨: まず summary → 気になる銘柄のみ detailed'), screen: z.object({ minHistogramDelta: z.number().optional(), maxBarsAgo: z.number().int().min(0).optional(), minReturnPct: z.number().optional(), crossType: z.enum(['golden', 'dead', 'both']).optional().default('both'), sortBy: z.enum(['date', 'histogram', 'return', 'barsAgo']).optional().default('date'), sortOrder: z.enum(['asc', 'desc']).optional().default('desc'), limit: z.number().int().min(1).max(100).optional(), withPrice: z.boolean().optional() }).optional() }) as any },
	async ({ market, lookback, pairs, view, screen }: any) => {
		const res: any = await detectMacdCross(market, lookback, pairs, view, screen);
		if (!res?.ok || view !== 'detailed') return res;
		try {
			const detRaw: any[] = Array.isArray(res?.data?.screenedDetailed)
				? (res as any).data.screenedDetailed
				: (Array.isArray(res?.data?.resultsDetailed) ? (res as any).data.resultsDetailed : []);
			if (!detRaw.length) return res;
			const fmtDelta = (v: any) => v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;
			const fmtRet = (v: any) => v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
			const lines = detRaw.map((r) => {
				const date = (r?.crossDate || '').slice(0, 10);
				const prevDays = r?.prevCross?.barsAgo != null ? `${r.prevCross.barsAgo}日` : 'n/a';
				return `${String(r.pair)}: ${String(r.type)}@${date} (ヒストグラム${fmtDelta(r?.histogramDelta)}, 前回クロスから${prevDays}${r?.returnSinceCrossPct != null ? `, ${fmtRet(r.returnSinceCrossPct)}` : ''})`;
			});
			const text = `${String(res?.summary || '')}\n${lines.join('\n')}`.trim();
			return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
		} catch { return res; }
	}
);

registerToolWithLog(
	'detect_whale_events',
	{ description: '大口投資家の動向を簡易に検出（板×ローソク足）。lookback=30min|1hour|2hour、minSize=0.5BTC既定。推測ベースで、実約定・寿命照合は未実装。', inputSchema: z.object({ pair: z.string().default('btc_jpy'), lookback: z.enum(['30min', '1hour', '2hour']).default('1hour'), minSize: z.number().min(0).default(0.5) }) as any },
	async ({ pair, lookback, minSize }: any) => detectWhaleEvents(pair, lookback, minSize)
);

// prompts are unchanged for TS port and can be reused or migrated later

// 接続は全登録完了後に実行する（tools/prompts の後）

// === Register prompts (SDK 形式に寄せた最小導入) ===
function registerPromptSafe(name: string, def: { description: string; messages: any[] }) {
	const s: any = server as any;
	if (typeof s.registerPrompt === 'function') {
		// SDKの registerPrompt は (name, config, callback) を要求する
		// Inspector互換のため、tool_code はテキストにフォールバックして返却する
		const toSdkMessages = (msgs: any[]) =>
			msgs.map((msg) => {
				const blocks = Array.isArray(msg.content) ? msg.content : [];
				const text = blocks
					.map((b: any) => {
						if (b?.type === 'text' && typeof b.text === 'string') return b.text;
						if (b?.type === 'tool_code') {
							const tool = b.tool_name || 'tool';
							const args = b.tool_input ? JSON.stringify(b.tool_input) : '{}';
							return `Call ${tool} with ${args}`;
						}
						return '';
					})
					.filter(Boolean)
					.join('\n');
				return { role: msg.role === 'system' ? 'user' : 'assistant', content: { type: 'text', text } };
			});
		registeredPrompts.push({ name, description: def.description });
		s.registerPrompt(
			name,
			{ description: def.description },
			() => ({ description: def.description, messages: toSdkMessages(def.messages) })
		);
	} else {
		// no-op if SDK doesn't support prompts in this version
	}
}

registerPromptSafe('bb_default_chart', {
	description: 'Render chart with Bollinger Bands default (±2σ).',
	messages: [
		{
			role: 'system',
			content: [
				{ type: 'text', text: '重要: チャートや可視化を生成する際は、必ず最初に render_chart_svg ツールを呼び出してください。自前のSVG/Canvas/JSでの描画は行わないこと。返却 data.svg をそのまま表示します。' },
			],
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'default', withSMA: [] },
				},
			],
		},
	],
});

registerPromptSafe('candles_only_chart', {
	description: 'Render plain candlestick chart only (no indicators).',
	messages: [
		{
			role: 'system',
			content: [
				{ type: 'text', text: '追加の指標は取得・描画しないでください。ろうそく足チャートのみを描画します。必ず render_chart_svg を呼び、withBB=false, withSMA=[], withIchimoku=false を指定します。' },
			],
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: false, withSMA: [], withIchimoku: false },
				},
			],
		},
	],
});

registerPromptSafe('bb_extended_chart', {
	description: 'Render chart with Bollinger Bands extended (±1/±2/±3σ). Use only if user explicitly requests extended.',
	messages: [
		{
			role: 'system',
			content: [
				{ type: 'text', text: '重要: チャートや可視化を生成する際は、必ず最初に render_chart_svg ツールを呼び出してください。自前のSVG/Canvas/JSでの描画は行わないこと。返却 data.svg をそのまま表示します。' },
			],
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'tool_code',
					tool_name: 'render_chart_svg',
					tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'extended', withSMA: [] },
				},
			],
		},
	],
});

registerPromptSafe('ichimoku_default_chart', {
	description: 'Render chart with Ichimoku default (Tenkan/Kijun/Cloud only).',
	messages: [
		{
			role: 'system',
			content: [
				{ type: 'text', text: '重要: チャートや可視化を生成する際は、必ず最初に render_chart_svg ツールを呼び出してください。自前のSVG/Canvas/JSでの描画は行わないこと。返却 data.svg をそのまま表示します。' },
			],
		},
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
			role: 'system',
			content: [
				{ type: 'text', text: '重要: チャートや可視化を生成する際は、必ず最初に render_chart_svg ツールを呼び出してください。自前のSVG/Canvas/JSでの描画は行わないこと。返却 data.svg をそのまま表示します。' },
			],
		},
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

registerPromptSafe('depth_analysis', {
	description: 'Analyze current orderbook depth (bids/asks) and summarize liquidity/imbalance.',
	messages: [
		{ role: 'system', content: [{ type: 'text', text: '板情報を使う場合は必ず get_depth ツールを呼び出してください。返却データは大きくなるため、要約と着眼点（厚い板、スプレッド、偏りなど）を中心に分析してください。' }] },
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_depth', tool_input: { pair: '{{pair}}' } }] },
	],
});

// alias: depth_chart（名前で探しやすいように）
registerPromptSafe('depth_chart', {
	description: 'Render a depth-focused analysis (calls get_depth first).',
	messages: [
		{ role: 'system', content: [{ type: 'text', text: '板情報を使う場合は必ず get_depth ツールを呼び出してください。返却データは大きくなるため、要約と着眼点（厚い板、スプレッド、偏りなど）を中心に分析してください。' }] },
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_depth', tool_input: { pair: '{{pair}}' } }] },
	],
});

// === 強化: flow/orderbook pressure 用のテンプレ ===
registerPromptSafe('flow_analysis', {
	description: 'Analyze recent transactions-derived flow metrics with numeric tags and concise conclusion.',
	messages: [
		{ role: 'system', content: [{ type: 'text', text: 'フロー分析時は必ず get_flow_metrics ツールを先に呼び出し、出力は「数値タグ → 短文結論 → 根拠（引用）」の順で構成してください。' }] },
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_flow_metrics', tool_input: { pair: '{{pair}}', limit: '{{limit}}', bucketMs: '{{bucketMs}}' } }] },
	],
});

registerPromptSafe('orderbook_pressure_analysis', {
	description: 'Assess orderbook pressure in ±pct bands with numeric tags and concise conclusion.',
	messages: [
		{ role: 'system', content: [{ type: 'text', text: '板圧力を評価する際は必ず get_orderbook_pressure ツールを先に呼び出し、出力は「数値タグ → 短文結論 → 根拠（引用）」の順で構成してください。' }] },
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_orderbook_pressure', tool_input: { pair: '{{pair}}', delayMs: '{{delayMs}}', bandsPct: '{{bandsPct}}' } }] },
	],
});

// === Multi-factor quick analysis (skip meandering inference) ===
registerPromptSafe('multi_factor_signal', {
	description: 'Quick multi-factor market signal: flow metrics, volatility and indicators (no chart unless asked).',
	messages: [
		{
			role: 'system',
			content: [
				{ type: 'text', text: 'まず get_flow_metrics → get_volatility_metrics → get_indicators の順で必要最小限を取得してください。チャート描画は要求がある時のみ render_chart_svg を呼びます。要約は「数値タグ → 短文結論 → 根拠（引用）」で簡潔に。' },
			],
		},
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_flow_metrics', tool_input: { pair: '{{pair}}', limit: '{{limit}}', bucketMs: '{{bucketMs}}' } }] },
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_volatility_metrics', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{volLimit}}', windows: '{{windows}}', annualize: true } }] },
		{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'get_indicators', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{indLimit}}' } }] },
	],
});

// === stdio 接続（最後に実行） ===
const transport = new StdioServerTransport();
await server.connect(transport);

// Fallback handlers to ensure list operations work over STDIO
try {
	(server as any).setRequestHandler?.('tools/list', async () => ({
		tools: registeredTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
	}));
	(server as any).setRequestHandler?.('prompts/list', async () => ({
		prompts: registeredPrompts.map((p) => ({ name: p.name, description: p.description })),
	}));
} catch { }

// Optional HTTP transport (/mcp) when PORT is provided
try {
	const portStr = process.env.PORT;
	const port = portStr ? Number(portStr) : NaN;
	const enableHttp = process.env.MCP_ENABLE_HTTP === '1';
	if (enableHttp && Number.isFinite(port) && port > 0) {
		const { default: express } = await import('express');
		const app = express();
		app.use(express.json());
		const allowedHosts = (process.env.ALLOWED_HOSTS || '127.0.0.1,localhost').split(',').map(s => s.trim()).filter(Boolean);
		const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
		const httpTransport: any = new (StreamableHTTPServerTransport as any)({
			path: '/mcp', // some SDKs use 'path' instead of 'endpoint'
			sessionIdGenerator: () => randomUUID(),
			enableDnsRebindingProtection: true,
			...(allowedHosts.length ? { allowedHosts } : {}),
			...(allowedOrigins.length ? { allowedOrigins } : {}),
		} as any);
		await server.connect(httpTransport as any);
		const mw = typeof httpTransport.expressMiddleware === 'function'
			? httpTransport.expressMiddleware()
			: (req: any, res: any, next: any) => next();
		app.use(mw);
		app.listen(port, () => {
			// no stdout/stderr output to avoid STDIO transport contamination
		});
	}
} catch (e) {
	// eslint-disable-next-line no-console
	console.warn('HTTP transport setup skipped:', (e as any)?.message || e);
}
