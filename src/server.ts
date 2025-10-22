import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
import { GetMarketSummaryInputSchema, GetMarketSummaryOutputSchema } from './schemas.js';
import { GetTickersInputSchema } from './schemas.js';
import { GetTransactionsInputSchema, GetFlowMetricsInputSchema } from './schemas.js';
import { GetDepthDiffInputSchema, GetOrderbookPressureInputSchema } from './schemas.js';
import { GetCircuitBreakInfoInputSchema } from './schemas.js';
import getTransactions from '../tools/get_transactions.js';
import getFlowMetrics from '../tools/get_flow_metrics.js';
import getTickers from '../tools/get_tickers.js';
import getDepthDiff from '../tools/get_depth_diff.js';
import getOrderbookPressure from '../tools/get_orderbook_pressure.js';
import getVolatilityMetrics from '../tools/get_volatility_metrics.js';
import getMarketSummary from '../tools/get_market_summary.js';
import analyzeMarketSignal from '../tools/analyze_market_signal.js';
import analyzeIchimokuSnapshot from '../tools/analyze_ichimoku_snapshot.js';
import analyzeBbSnapshot from '../tools/analyze_bb_snapshot.js';
import analyzeSmaSnapshot from '../tools/analyze_sma_snapshot.js';
import getTickersJpy from '../tools/get_tickers_jpy.js';
import detectMacdCross from '../tools/detect_macd_cross.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema } from './schemas.js';
import getCircuitBreakInfo from '../tools/get_circuit_break_info.js';
import { AnalyzeMarketSignalInputSchema, AnalyzeMarketSignalOutputSchema } from './schemas.js';

const server = new McpServer({ name: 'bitbank-mcp', version: '0.3.0' });

type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> };
type ToolReturn = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const respond = (result: unknown): ToolReturn => {
	// ルール: 画面には要約のみを出す。詳細データは structuredContent に載せる。
	// SVGなどの巨大フィールドがテキストに出てしまうのを防止する。
	let text = '';
	if (isPlainObject(result) && typeof (result as any).summary === 'string') {
		text = String((result as any).summary);
	} else {
		// 後方互換: 既存のツールが summary を返さない場合は、短縮版のJSONを出す
		try {
			const json = JSON.stringify(result, (_key, value) => {
				// よく肥大化する既知キーは省略
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

function registerToolWithLog<S extends z.ZodTypeAny, R = unknown>(
	name: string,
	schema: { description: string; inputSchema: S },
	handler: (input: z.infer<S>) => Promise<R>
) {
	// server.registerTool expects ZodRawShape; unwrap Optional/Default/Effects and extract Object.shape
	const getRawShape = (s: z.ZodTypeAny): z.ZodRawShape => {
		let cur: any = s as any;
		// Unwrap ZodDefault / ZodOptional / ZodEffects chains
		for (let i = 0; i < 5; i++) {
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
registerToolWithLog(
	'get_depth_diff',
	{ description: 'Depth diff between two REST snapshots. view=summary|detailed|full. detailed/full prints major changes with price/size; filters: minDeltaBTC, topN.', inputSchema: GetDepthDiffInputSchema },
	async ({ pair, delayMs, maxLevels, view, minDeltaBTC, topN, enrichWithTradeData, trackLargeOrders, minTrackingSizeBTC }: any) => {
		const res: any = await getDepthDiff(pair, delayMs, maxLevels);
		if (!res?.ok) return res;
		if (view === 'summary') return res;
		const agg = res?.data?.aggregates || {};
		const asks = res?.data?.asks || {};
		const bids = res?.data?.bids || {};
		const abs = (n: number) => Math.abs(Number(n || 0));
		const flt = (arr: any[], key: 'size' | 'delta') => (arr || []).filter((x) => abs(x?.[key]) >= (minDeltaBTC || 0)).sort((a, b) => abs(b[key]) - abs(a[key])).slice(0, topN || 5);
		const fmt = (x: any, side: 'ask' | 'bid', kind: 'added' | 'removed' | 'changed') => {
			const sign = kind === 'removed' ? '-' : (kind === 'changed' ? (x.delta >= 0 ? '+' : '') : '+');
			const qty = kind === 'changed' ? x.delta : x.size;
			return `${Number(x.price).toLocaleString()}円 ${sign}${Number(qty).toFixed(2)} BTC (${side})`;
		};
		const added = [...flt(asks.added, 'size').map((x: any) => fmt(x, 'ask', 'added')), ...flt(bids.added, 'size').map((x: any) => fmt(x, 'bid', 'added'))];
		const removed = [...flt(asks.removed, 'size').map((x: any) => fmt(x, 'ask', 'removed')), ...flt(bids.removed, 'size').map((x: any) => fmt(x, 'bid', 'removed'))];
		const changed = [...flt(asks.changed, 'delta').map((x: any) => fmt(x, 'ask', 'changed')), ...flt(bids.changed, 'delta').map((x: any) => fmt(x, 'bid', 'changed'))];
		let text = `=== ${String(pair).toUpperCase()} 板変化 (${Number(delayMs) / 1000}s) ===\n`;
		const tilt = agg.bidNetDelta - agg.askNetDelta;
		text += `${tilt >= 0 ? '🟢 買い圧力優勢' : '🔴 売り圧力優勢'}: bid ${agg.bidNetDelta} BTC, ask ${agg.askNetDelta} BTC`;
		text += `\n\n📊 主要な変化:`;
		const lines = [
			...added.map((s: string) => `[追加] ${s}`),
			...removed.map((s: string) => `[削除] ${s}`),
			...changed.map((s: string) => `[増減] ${s}`),
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

registerToolWithLog(
	'get_orderbook_pressure',
	{ description: 'Compute orderbook pressure in ±pct bands around mid using two snapshots.', inputSchema: GetOrderbookPressureInputSchema },
	async ({ pair, delayMs, bandsPct }: any) => getOrderbookPressure(pair, delayMs, bandsPct)
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
	{ description: '重要: チャートはユーザーが明示的に要求した場合のみ描画します。分析目的だけでは呼び出さないでください。出力: `{ ok, summary, data: { svg?: string, filePath?: string }, meta }`。既定はローソク足のみ（SMA/BB/一目はオフ）。必要時のみ withSMA/withBB/withIchimoku を指定。軽量化: svgPrecision=1, svgMinify=true, simplifyTolerance=1, viewBoxTight=true。\n\n使い方: 1) 実行 → 2) 返却の structuredContent.data.svg を取得 → 3) image/svg+xml のアーティファクトとして出力 → 4) data.svg が無い場合は data.filePath を読み取り表示。', inputSchema: RenderChartSvgInputSchema },
	async (args: any) => {
		const result = await renderChartSvg(args as any);
		// スキーマで最終検証（SDK 契約の単一ソース化）
		return RenderChartSvgOutputSchema.parse(result);
	}
);

registerToolWithLog(
	'detect_patterns',
	{ description: 'Detect classic chart patterns from recent candles. Returns candidate patterns with confidence and ranges. Use after rendering the chart.', inputSchema: DetectPatternsInputSchema },
	async ({ pair, type, limit, patterns, swingDepth, tolerancePct, minBarsBetweenSwings }: any) => {
		const out = await detectPatterns(pair, type, limit, { patterns, swingDepth, tolerancePct, minBarsBetweenSwings });
		return DetectPatternsOutputSchema.parse(out as any);
	}
);

// Deprecated: prefer analyze_market_signal or targeted tools.
registerToolWithLog(
	'get_market_summary',
	{ description: '非推奨: 低解像度の市場サマリー（tickers + 年率化RV）。最初の呼び出しには使わないでください。具体的な分析には analyze_market_signal / get_flow_metrics / get_volatility_metrics を利用。', inputSchema: GetMarketSummaryInputSchema },
	async ({ market, window, ann }: any) => {
		const result = await getMarketSummary(market, { window, ann });
		return GetMarketSummaryOutputSchema.parse(result);
	}
);

// Safer alias with explicit purpose: quick snapshot only, not for decision.
registerToolWithLog(
	'market_overview_snapshot',
	{ description: 'Quick snapshot of market movers/volatility buckets. Use only as context; do not base decisions solely on this. Prefer analyze_market_signal for conclusions.', inputSchema: GetMarketSummaryInputSchema },
	async ({ market, window, ann }: any) => {
		const result = await getMarketSummary(market, { window, ann });
		return GetMarketSummaryOutputSchema.parse(result);
	}
);

registerToolWithLog(
	'analyze_market_signal',
	{ description: 'Flow/Volatility/Indicators/SMA を合成した相対強度スコアを返します（式・重み・要素寄与の内訳（rawValue, contribution, interpretation）と topContributors を同梱）。SMA関連は「SMA配置トレンド（構造）」と「短期SMA変化スコア（勢い）」を区別して説明してください。**重要: ユーザーにスコアを説明する際は、必ず(1)計算式: score = 0.35*buyPressure + 0.25*cvdTrend + 0.15*momentum + 0.10*volatility + 0.15*smaTrend、(2)各要素の内訳、(3)最も影響している要素、を明示してください。**', inputSchema: AnalyzeMarketSignalInputSchema },
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
	{ description: 'ボリンジャーバンドの数値スナップショット。mid/upper/lower と zScore, bandWidthPct を返します。視覚的主張は行いません。', inputSchema: (await import('./schemas.js')).AnalyzeBbSnapshotInputSchema as any },
	async ({ pair, type, limit, mode }: any) => analyzeBbSnapshot(pair, type, limit, mode)
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
	{ description: '市場内の銘柄で直近のMACDゴールデン/デッドクロスを検出します（1day, lookback=3本）。pairsで限定可能。', inputSchema: z.object({ market: z.enum(['all', 'jpy']).default('all'), lookback: z.number().int().min(1).max(10).default(3), pairs: z.array(z.string()).optional() }) as any },
	async ({ market, lookback, pairs }: any) => detectMacdCross(market, lookback, pairs)
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
