// Domain types shareable across tools and future MCP TS SDK migration

export type Pair = `${string}_${string}`; // e.g., "btc_jpy"

export interface Candle {
	time?: number | string; // epoch ms or ISO string
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
	isoTime?: string; // existing data sometimes uses this
	timestamp?: number; // existing data sometimes uses this
}

export interface Ticker {
	pair: Pair;
	last: number; // last price
	bid?: number;
	ask?: number;
	timestamp?: number;
}

export interface TickerNormalized {
	pair: Pair;
	last: number | null;
	buy: number | null;
	sell: number | null;
	volume: number | null;
	timestamp: number | null;
	isoTime: string | null;
}

export interface OrderbookLevel {
	price: number;
	size: number;
}

export interface Orderbook {
	pair: Pair;
	bids: OrderbookLevel[];
	asks: OrderbookLevel[];
	timestamp?: number;
}

export interface OrderbookLevelWithCum extends OrderbookLevel {
	cumSize: number;
}

export interface OrderbookNormalized {
	pair: Pair;
	bestBid: number | null;
	bestAsk: number | null;
	spread: number | null;
	mid: number | null;
	bids: OrderbookLevelWithCum[];
	asks: OrderbookLevelWithCum[];
	timestamp: number | null;
	isoTime: string | null;
}

// Indicators
export type NumericSeries = Array<number | null>;

export interface IchimokuSeries {
	ICHI_tenkan: NumericSeries;
	ICHI_kijun: NumericSeries;
	ICHI_spanA: NumericSeries;
	ICHI_spanB: NumericSeries;
	ICHI_chikou?: NumericSeries;
}

export interface BollingerBandsSeries {
	// light compatibility
	BB_upper?: NumericSeries;
	BB_middle?: NumericSeries;
	BB_lower?: NumericSeries;
	// full
	BB1_upper?: NumericSeries;
	BB1_middle?: NumericSeries;
	BB1_lower?: NumericSeries;
	BB2_upper?: NumericSeries;
	BB2_middle?: NumericSeries;
	BB2_lower?: NumericSeries;
	BB3_upper?: NumericSeries;
	BB3_middle?: NumericSeries;
	BB3_lower?: NumericSeries;
}

export interface SmaSeriesFixed {
	SMA_5?: NumericSeries;
	SMA_20?: NumericSeries;
	SMA_25?: NumericSeries;
	SMA_50?: NumericSeries;
	SMA_75?: NumericSeries;
	SMA_200?: NumericSeries;
}

// Chart-side indicator series shape (flattened series only)
export type ChartIndicators = IchimokuSeries & BollingerBandsSeries & SmaSeriesFixed & {
	// RSI is latest-value only even in chart payload
	RSI_14?: number | null;
	RSI_14_series?: NumericSeries;
};

export interface ChartMeta {
	pastBuffer?: number; // how many items are trimmed from head for display
	shift?: number; // x forward shift for ichimoku
}

export interface ChartPayload {
	candles: Candle[];
	indicators: ChartIndicators;
	meta?: ChartMeta;
}

// === DTOs for tools/get_indicators ===
export interface LatestIndicatorsSummary {
	SMA_25?: number | null;
	SMA_75?: number | null;
	SMA_200?: number | null;
	RSI_14?: number | null;
	ICHIMOKU_conversion?: number | null;
	ICHIMOKU_base?: number | null;
	ICHIMOKU_spanA?: number | null;
	ICHIMOKU_spanB?: number | null;
}

export type TrendLabel =
	| 'strong_uptrend'
	| 'uptrend'
	| 'strong_downtrend'
	| 'downtrend'
	| 'overbought'
	| 'oversold'
	| 'sideways'
	| 'insufficient_data';

export interface IndicatorsInternal {
	SMA_5?: number | null;
	SMA_20?: number | null;
	SMA_25?: number | null;
	SMA_50?: number | null;
	SMA_75?: number | null;
	SMA_200?: number | null;
	RSI_14?: number | null;
	BB_upper?: number | null;
	BB_middle?: number | null;
	BB_lower?: number | null;
	BB1_upper?: number | null;
	BB1_middle?: number | null;
	BB1_lower?: number | null;
	BB2_upper?: number | null;
	BB2_middle?: number | null;
	BB2_lower?: number | null;
	BB3_upper?: number | null;
	BB3_middle?: number | null;
	BB3_lower?: number | null;
	ICHIMOKU_conversion?: number | null;
	ICHIMOKU_base?: number | null;
	ICHIMOKU_spanA?: number | null;
	ICHIMOKU_spanB?: number | null;
	// series fields
	bb1_series?: { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries };
	bb2_series?: { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries };
	bb3_series?: { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries };
	ichi_series?: { tenkan: NumericSeries; kijun: NumericSeries; spanA: NumericSeries; spanB: NumericSeries; chikou: NumericSeries };
	sma_5_series?: NumericSeries;
	sma_20_series?: NumericSeries;
	sma_25_series?: NumericSeries;
	sma_50_series?: NumericSeries;
	sma_75_series?: NumericSeries;
	sma_200_series?: NumericSeries;
}

export interface GetIndicatorsData {
	summary: string;
	raw: any;
	normalized: Candle[];
	indicators: IndicatorsInternal;
	trend: TrendLabel;
	chart: {
		candles: Candle[];
		indicators: ChartIndicators;
		meta: ChartMeta;
		stats: { min: number; max: number; avg: number; volume_avg: number };
	};
}

export interface GetIndicatorsMeta {
	pair: Pair;
	fetchedAt: string;
	type: CandleType | string;
	count: number;
	requiredCount: number;
	warnings?: string[];
}

// === DTOs for tools/get_ticker ===
export interface GetTickerData {
	raw: any;
	normalized: TickerNormalized;
}

export interface GetTickerMeta {
	pair: Pair;
	fetchedAt: string;
}

// === DTOs for tools/get_orderbook ===
export interface GetOrderbookData {
	raw: any;
	normalized: OrderbookNormalized;
}

export interface GetOrderbookMeta {
	pair: Pair;
	fetchedAt: string;
	topN: number;
	count: number;
}

// Render options aligned with project rules
export type BbMode = 'default' | 'extended';
export type IchimokuMode = 'default' | 'extended';
export type ChartStyle = 'candles' | 'line' | 'depth';

export interface IchimokuOptions {
	mode?: IchimokuMode;
}

export interface RenderChartSvgOptions {
	pair?: Pair;
	type?: CandleType | string; // gradually move to CandleType
	limit?: number;
	// main series style: candles (default) or line (close-only)
	style?: ChartStyle;
	withSMA?: number[];
	withBB?: boolean;
	bbMode?: BbMode;
	withIchimoku?: boolean; // default false
	ichimoku?: IchimokuOptions; // default { mode: 'default' }
	withLegend?: boolean; // default true
	barWidthRatio?: number; // 0.1 - 0.9, default 0.6
	yPaddingPct?: number; // 0-0.2, default 0.03 (縦方向バッファ率)
	// Optional overlays for pattern visualization
	overlays?: {
		ranges?: Array<{ start: string; end: string; color?: string; label?: string }>;
		annotations?: Array<{ isoTime: string; text: string }>;
	};
}

export interface OkResult<T = Record<string, unknown>, M = Record<string, unknown>> {
	ok: true;
	summary: string;
	data: T;
	meta: M;
}

export interface FailResult<M = Record<string, unknown>> {
	ok: false;
	summary: string; // prefixed with "Error: "
	data: Record<string, never>;
	meta: { errorType: string } & M;
}

export type Result<T = any, M = any> = OkResult<T, M> | FailResult<M>;

// === DTOs for tools/get_candles ===
export type CandleType =
	| '1min'
	| '5min'
	| '15min'
	| '30min'
	| '1hour'
	| '4hour'
	| '8hour'
	| '12hour'
	| '1day'
	| '1week'
	| '1month';

export interface KeyPoint {
	index: number;
	date: string | null;
	close: number;
	changePct?: number | null;
}

export interface KeyPoints {
	today: KeyPoint | null;
	sevenDaysAgo: KeyPoint | null;
	thirtyDaysAgo: KeyPoint | null;
	ninetyDaysAgo: KeyPoint | null;
}

export interface VolumeStats {
	recent7DaysAvg: number;
	previous7DaysAvg: number;
	last30DaysAvg: number | null;
	changePct: number;
	judgment: string;
}

export interface GetCandlesData {
	raw: any;
	normalized: Candle[];
	keyPoints?: KeyPoints;
	volumeStats?: VolumeStats | null;
}

export interface GetCandlesMeta {
	pair: Pair;
	fetchedAt: string;
	type: CandleType | string;
	count: number;
}
