import { z } from 'zod';

export const CandleTypeEnum = z.enum([
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '12hour',
  '1day',
  '1week',
  '1month',
]);

export const RenderChartSvgInputSchema = z
  .object({
    pair: z.string().optional().default('btc_jpy'),
    type: CandleTypeEnum.optional().default('1day'),
    // impl default is 60; align contract to tool behavior
    limit: z.number().int().min(5).max(365).optional().default(60),
    // main series style: candles (default) or line (close-only)
    style: z.enum(['candles', 'line', 'depth']).optional().default('candles'),
    depth: z.object({ levels: z.number().int().min(10).max(500).optional().default(200) }).optional(),
    // デフォルトは描画しない（明示時のみ描画）
    withSMA: z.array(z.number().int()).optional().default([]),
    // 既定でBBはオフ（必要時のみ指定）
    withBB: z.boolean().optional().default(false),
    // backward-compat: accept legacy values and normalize in implementation
    bbMode: z.enum(['default', 'extended', 'light', 'full']).optional().default('default'),
    withIchimoku: z.boolean().optional().default(false),
    ichimoku: z
      .object({
        mode: z.enum(['default', 'extended']).optional().default('default'),
        // implementation optionally respects this when true
        withChikou: z.boolean().optional(),
      })
      .optional(),
    // 軽量化のため凡例は既定でオフ
    withLegend: z.boolean().optional().default(false),
    // 軽量化オプション
    svgPrecision: z.number().int().min(0).max(3).optional().default(1).describe('Coordinate rounding decimals (0-3).'),
    svgMinify: z.boolean().optional().default(true).describe('Minify SVG text by stripping whitespace where safe.'),
    simplifyTolerance: z.number().min(0).optional().default(0.5).describe('Line simplification tolerance in pixels (0 disables).'),
    viewBoxTight: z.boolean().optional().default(true).describe('Use tighter paddings to reduce empty margins.'),
    barWidthRatio: z.number().min(0.1).max(0.9).optional().describe('Width ratio of each candle body (slot fraction).'),
    yPaddingPct: z.number().min(0).max(0.2).optional().describe('Vertical padding ratio to expand y-range.'),
    // 自動保存（LLM利便性のため）
    autoSave: z.boolean().optional().default(false).describe('If true, also save SVG to /mnt/user-data/outputs and return filePath/url.'),
    // 自動保存時のファイル名（拡張子は自動で .svg を付与）
    outputPath: z.string().optional().describe('File name (without extension) under /mnt/user-data/outputs when autoSave=true.'),
    // サイズ制御（超過時は data.svg を省略し filePath のみ返却）
    maxSvgBytes: z.number().int().min(1024).optional().default(100_000).describe('If set and svg exceeds this size (bytes), omit data.svg and return filePath only.'),
    // 返却方針: true の場合は保存を最優先し、失敗時はエラーにする（inline返却にフォールバックしない）
    preferFile: z.boolean().optional().default(false).describe('If true, prefer saving SVG to file and return error on save failure (no inline fallback).'),
    // Optional pattern overlays (ranges/annotations)
    overlays: z
      .object({
        ranges: z
          .array(
            z.object({
              start: z.string(),
              end: z.string(),
              color: z.string().optional(),
              label: z.string().optional(),
            })
          )
          .optional(),
        annotations: z
          .array(
            z.object({ isoTime: z.string(), text: z.string() })
          )
          .optional(),
        depth_zones: z
          .array(
            z.object({ low: z.number(), high: z.number(), color: z.string().optional(), label: z.string().optional() })
          )
          .optional(),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.withIchimoku) {
      if (Array.isArray(val.withSMA) && val.withSMA.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['withSMA'],
          message: 'withIchimoku=true の場合、withSMA は空配列でなければなりません',
        });
      }
      if (val.withBB === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['withBB'],
          message: 'withIchimoku=true の場合、withBB は false でなければなりません',
        });
      }
    }
  });

// Optional: output contract (not enforced by SDK at runtime, but useful for validation/tests)
export const RenderChartSvgOutputSchema = z.object({
  ok: z.literal(true).or(z.literal(false)),
  summary: z.string(),
  data: z.object({
    svg: z.string().optional(),
    filePath: z.string().optional(),
    url: z.string().optional(),
    legend: z.record(z.string()).optional(),
  }).or(z.object({})),
  meta: z
    .object({
      pair: z.string(),
      type: CandleTypeEnum.or(z.string()),
      limit: z.number().optional(),
      indicators: z.array(z.string()).optional(),
      bbMode: z.enum(['default', 'extended']).optional(),
      range: z.object({ start: z.string(), end: z.string() }).optional(),
      sizeBytes: z.number().optional(),
      layerCount: z.number().optional(),
      truncated: z.boolean().optional(),
      fallback: z.string().optional(),
    })
    .optional(),
});

// === Shared output schemas (partial) ===
export const NumericSeriesSchema = z
  .array(z.union([z.number(), z.null()]))
  .transform((arr) => arr.map((v) => (v == null ? null : Number(Number(v).toFixed(2)))));

export const CandleSchema = z.object({
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional(),
  isoTime: z.string().nullable().optional(),
  time: z.union([z.string(), z.number()]).optional(),
  timestamp: z.number().optional(),
});

// ChartIndicators shape
export const IchimokuSeriesSchema = z.object({
  ICHI_tenkan: NumericSeriesSchema,
  ICHI_kijun: NumericSeriesSchema,
  ICHI_spanA: NumericSeriesSchema,
  ICHI_spanB: NumericSeriesSchema,
  ICHI_chikou: NumericSeriesSchema,
});

export const BollingerBandsSeriesSchema = z.object({
  BB_upper: NumericSeriesSchema,
  BB_middle: NumericSeriesSchema,
  BB_lower: NumericSeriesSchema,
  BB1_upper: NumericSeriesSchema,
  BB1_middle: NumericSeriesSchema,
  BB1_lower: NumericSeriesSchema,
  BB2_upper: NumericSeriesSchema,
  BB2_middle: NumericSeriesSchema,
  BB2_lower: NumericSeriesSchema,
  BB3_upper: NumericSeriesSchema,
  BB3_middle: NumericSeriesSchema,
  BB3_lower: NumericSeriesSchema,
});

export const SmaSeriesFixedSchema = z.object({
  SMA_5: NumericSeriesSchema,
  SMA_20: NumericSeriesSchema,
  SMA_25: NumericSeriesSchema,
  SMA_50: NumericSeriesSchema,
  SMA_75: NumericSeriesSchema,
  SMA_200: NumericSeriesSchema,
});

export const ChartIndicatorsSchema = IchimokuSeriesSchema.merge(BollingerBandsSeriesSchema).merge(SmaSeriesFixedSchema).extend({
  RSI_14: z.number().nullable().optional(),
});

export const ChartMetaSchema = z.object({
  pastBuffer: z.number().optional(),
  shift: z.number().optional(),
});

export const ChartStatsSchema = z.object({
  min: z.number(),
  max: z.number(),
  avg: z.number(),
  volume_avg: z.number(),
});

export const ChartPayloadSchema = z
  .object({
    candles: z.array(CandleSchema),
    indicators: ChartIndicatorsSchema,
    meta: ChartMetaSchema.optional(),
    stats: ChartStatsSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const len = val.candles.length;
    const seriesKeys = [
      'SMA_5', 'SMA_20', 'SMA_25', 'SMA_50', 'SMA_75', 'SMA_200',
      'BB_upper', 'BB_middle', 'BB_lower', 'BB1_upper', 'BB1_middle', 'BB1_lower', 'BB2_upper', 'BB2_middle', 'BB2_lower', 'BB3_upper', 'BB3_middle', 'BB3_lower',
      'ICHI_tenkan', 'ICHI_kijun', 'ICHI_spanA', 'ICHI_spanB', 'ICHI_chikou',
    ];
    for (const key of seriesKeys) {
      const arr = (val as any).indicators[key];
      if (!Array.isArray(arr) || arr.length !== len) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Indicator series '${key}' must have length ${len}`,
          path: ['indicators', key],
        });
      }
    }
  });

export const TrendLabelEnum = z.enum([
  'strong_uptrend',
  'uptrend',
  'strong_downtrend',
  'downtrend',
  'overbought',
  'oversold',
  'sideways',
  'insufficient_data',
]);

export const IndicatorsInternalSchema = z.object({
  SMA_5: z.number().nullable().optional(),
  SMA_20: z.number().nullable().optional(),
  SMA_25: z.number().nullable().optional(),
  SMA_50: z.number().nullable().optional(),
  SMA_75: z.number().nullable().optional(),
  SMA_200: z.number().nullable().optional(),
  RSI_14: z.number().nullable().optional(),
  RSI_14_series: NumericSeriesSchema.optional(),
  BB_upper: z.number().nullable().optional(),
  BB_middle: z.number().nullable().optional(),
  BB_lower: z.number().nullable().optional(),
  BB1_upper: z.number().nullable().optional(),
  BB1_middle: z.number().nullable().optional(),
  BB1_lower: z.number().nullable().optional(),
  BB2_upper: z.number().nullable().optional(),
  BB2_middle: z.number().nullable().optional(),
  BB2_lower: z.number().nullable().optional(),
  BB3_upper: z.number().nullable().optional(),
  BB3_middle: z.number().nullable().optional(),
  BB3_lower: z.number().nullable().optional(),
  ICHIMOKU_conversion: z.number().nullable().optional(),
  ICHIMOKU_base: z.number().nullable().optional(),
  ICHIMOKU_spanA: z.number().nullable().optional(),
  ICHIMOKU_spanB: z.number().nullable().optional(),
  bb1_series: z
    .object({ upper: NumericSeriesSchema, middle: NumericSeriesSchema, lower: NumericSeriesSchema })
    .optional(),
  bb2_series: z
    .object({ upper: NumericSeriesSchema, middle: NumericSeriesSchema, lower: NumericSeriesSchema })
    .optional(),
  bb3_series: z
    .object({ upper: NumericSeriesSchema, middle: NumericSeriesSchema, lower: NumericSeriesSchema })
    .optional(),
  ichi_series: z
    .object({ tenkan: NumericSeriesSchema, kijun: NumericSeriesSchema, spanA: NumericSeriesSchema, spanB: NumericSeriesSchema, chikou: NumericSeriesSchema })
    .optional(),
  sma_5_series: NumericSeriesSchema.optional(),
  sma_20_series: NumericSeriesSchema.optional(),
  sma_25_series: NumericSeriesSchema.optional(),
  sma_50_series: NumericSeriesSchema.optional(),
  sma_75_series: NumericSeriesSchema.optional(),
  sma_200_series: NumericSeriesSchema.optional(),
  // MACD latest values
  MACD_line: z.number().nullable().optional(),
  MACD_signal: z.number().nullable().optional(),
  MACD_hist: z.number().nullable().optional(),
  // series (optional)
  macd_series: z
    .object({ line: NumericSeriesSchema, signal: NumericSeriesSchema, hist: NumericSeriesSchema })
    .optional(),
});

export const GetIndicatorsDataSchema = z.object({
  summary: z.string(),
  raw: z.unknown(),
  normalized: z.array(CandleSchema),
  indicators: IndicatorsInternalSchema,
  trend: TrendLabelEnum,
  chart: z.object({
    candles: z.array(CandleSchema),
    indicators: ChartIndicatorsSchema,
    meta: ChartMetaSchema,
    stats: ChartStatsSchema,
  }),
});

export const GetIndicatorsMetaSchema = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  type: CandleTypeEnum.or(z.string()),
  count: z.number(),
  requiredCount: z.number(),
  warnings: z.array(z.string()).optional(),
});

// === Tool Output Schemas ===
// Ticker
export const TickerNormalizedSchema = z.object({
  pair: z.string(),
  last: z.number().nullable(),
  buy: z.number().nullable(),
  sell: z.number().nullable(),
  volume: z.number().nullable(),
  timestamp: z.number().nullable(),
  isoTime: z.string().nullable(),
});

export const GetTickerDataSchemaOut = z.object({ raw: z.unknown(), normalized: TickerNormalizedSchema });
export const GetTickerMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string() });
export const GetTickerOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetTickerDataSchemaOut, meta: GetTickerMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// Tickers (snapshot of many pairs)
export const TickerExtendedSchema = TickerNormalizedSchema.extend({
  change24hPct: z.number().nullable().optional(),
  vol24hJpy: z.number().nullable().optional(),
});
export const GetTickersDataSchemaOut = z.object({ items: z.array(TickerExtendedSchema) });
export const GetTickersMetaSchemaOut = z.object({ market: z.enum(['all', 'jpy']), fetchedAt: z.string(), count: z.number().int() });
export const GetTickersOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetTickersDataSchemaOut, meta: GetTickersMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// Orderbook
export const OrderbookLevelSchema = z.object({ price: z.number(), size: z.number() });
export const OrderbookLevelWithCumSchema = OrderbookLevelSchema.extend({ cumSize: z.number() });
export const OrderbookNormalizedSchema = z.object({
  pair: z.string(),
  bestBid: z.number().nullable(),
  bestAsk: z.number().nullable(),
  spread: z.number().nullable(),
  mid: z.number().nullable(),
  bids: z.array(OrderbookLevelWithCumSchema),
  asks: z.array(OrderbookLevelWithCumSchema),
  timestamp: z.number().nullable(),
  isoTime: z.string().nullable(),
});
export const GetOrderbookDataSchemaOut = z.object({ raw: z.unknown(), normalized: OrderbookNormalizedSchema });
export const GetOrderbookMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), topN: z.number(), count: z.number() });
export const GetOrderbookOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetOrderbookDataSchemaOut, meta: GetOrderbookMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// Candles
export const KeyPointSchema = z.object({
  index: z.number(),
  date: z.string().nullable(),
  close: z.number(),
  changePct: z.number().nullable().optional(),
});

export const KeyPointsSchema = z.object({
  today: KeyPointSchema.nullable(),
  sevenDaysAgo: KeyPointSchema.nullable(),
  thirtyDaysAgo: KeyPointSchema.nullable(),
  ninetyDaysAgo: KeyPointSchema.nullable(),
});

export const VolumeStatsSchema = z.object({
  recent7DaysAvg: z.number(),
  previous7DaysAvg: z.number(),
  last30DaysAvg: z.number().nullable(),
  changePct: z.number(),
  judgment: z.string(),
});

export const GetCandlesDataSchemaOut = z.object({
  raw: z.unknown(),
  normalized: z.array(CandleSchema),
  keyPoints: KeyPointsSchema.optional(),
  volumeStats: VolumeStatsSchema.nullable().optional(),
});
export const GetCandlesMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), type: CandleTypeEnum.or(z.string()), count: z.number() });
export const GetCandlesOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetCandlesDataSchemaOut, meta: GetCandlesMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// Indicators
export const GetIndicatorsOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetIndicatorsDataSchema, meta: GetIndicatorsMetaSchema }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// Depth (raw depth for analysis/visualization)
export const DepthLevelTupleSchema = z.tuple([z.string(), z.string()]);
export const GetDepthDataSchemaOut = z.object({
  asks: z.array(DepthLevelTupleSchema),
  bids: z.array(DepthLevelTupleSchema),
  asks_over: z.string().optional(),
  asks_under: z.string().optional(),
  bids_over: z.string().optional(),
  bids_under: z.string().optional(),
  ask_market: z.string().optional(),
  bid_market: z.string().optional(),
  timestamp: z.number().int(),
  sequenceId: z.number().int().optional(),
  overlays: z
    .object({
      depth_zones: z.array(z.object({ low: z.number(), high: z.number(), color: z.string().optional(), label: z.string().optional() }))
    })
    .optional(),
});
export const GetDepthMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string() });
export const GetDepthOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetDepthDataSchemaOut, meta: GetDepthMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// Depth (raw) input schema
export const GetDepthInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  view: z.enum(['summary', 'sample', 'full']).optional().default('summary'),
  sampleN: z.number().int().min(1).max(50).optional().default(10),
});

// === Depth Diff (simple REST-based) ===
// Deprecated: get_depth_diff is removed in favor of get_orderbook_statistics

const DepthDeltaSchema = z.object({ price: z.number(), delta: z.number(), from: z.number().nullable(), to: z.number().nullable() });
const DepthSideDiffSchema = z.object({
  added: z.array(z.object({ price: z.number(), size: z.number() })),
  removed: z.array(z.object({ price: z.number(), size: z.number() })),
  changed: z.array(DepthDeltaSchema),
});

export const GetDepthDiffDataSchemaOut = z.object({
  prev: z.object({ timestamp: z.number().int(), sequenceId: z.number().int().nullable().optional() }),
  curr: z.object({ timestamp: z.number().int(), sequenceId: z.number().int().nullable().optional() }),
  asks: DepthSideDiffSchema,
  bids: DepthSideDiffSchema,
  aggregates: z.object({ bidNetDelta: z.number(), askNetDelta: z.number(), totalNetDelta: z.number() }),
});
export const GetDepthDiffMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), delayMs: z.number().int() });
export const GetDepthDiffOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetDepthDiffDataSchemaOut, meta: GetDepthDiffMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Orderbook Pressure (derived from Depth Diff) ===
export const GetOrderbookPressureInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  delayMs: z.number().int().min(100).max(5000).optional().default(1000),
  bandsPct: z.array(z.number().positive()).optional().default([0.001, 0.005, 0.01]),
  normalize: z.enum(['none', 'midvol']).optional().default('none'),
  weightScheme: z.enum(['equal', 'byDistance']).optional().default('byDistance'),
});

const PressureBandSchema = z.object({
  widthPct: z.number(),
  baseMid: z.number().nullable(),
  baseBidSize: z.number(),
  baseAskSize: z.number(),
  bidDelta: z.number(),
  askDelta: z.number(),
  netDelta: z.number(),
  netDeltaPct: z.number().nullable(),
  tag: z.enum(['notice', 'warning', 'strong']).nullable(),
});

export const GetOrderbookPressureDataSchemaOut = z.object({
  bands: z.array(PressureBandSchema),
  aggregates: z.object({ netDelta: z.number(), strongestTag: z.enum(['notice', 'warning', 'strong']).nullable() }),
});
export const GetOrderbookPressureMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), delayMs: z.number().int() });
export const GetOrderbookPressureOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetOrderbookPressureDataSchemaOut, meta: GetOrderbookPressureMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Transactions ===
export const TransactionItemSchema = z.object({
  price: z.number(),
  amount: z.number(),
  side: z.enum(['buy', 'sell']),
  timestampMs: z.number().int(),
  isoTime: z.string(),
});

export const GetTransactionsDataSchemaOut = z.object({ raw: z.unknown(), normalized: z.array(TransactionItemSchema) });
export const GetTransactionsMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), count: z.number().int(), source: z.enum(['latest', 'by_date']) });
export const GetTransactionsOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetTransactionsDataSchemaOut, meta: GetTransactionsMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Flow Metrics (derived from recent transactions) ===
export const FlowBucketSchema = z.object({
  timestampMs: z.number().int(),
  isoTime: z.string(),
  isoTimeJST: z.string().optional(),
  displayTime: z.string().optional(),
  buyVolume: z.number(),
  sellVolume: z.number(),
  totalVolume: z.number(),
  cvd: z.number(),
  zscore: z.number().nullable().optional(),
  spike: z.enum(['notice', 'warning', 'strong']).nullable().optional(),
});

export const GetFlowMetricsDataSchemaOut = z.object({
  source: z.literal('transactions'),
  params: z.object({ bucketMs: z.number().int().min(1000) }),
  aggregates: z.object({
    totalTrades: z.number().int(),
    buyTrades: z.number().int(),
    sellTrades: z.number().int(),
    buyVolume: z.number(),
    sellVolume: z.number(),
    netVolume: z.number(),
    aggressorRatio: z.number().min(0).max(1),
    finalCvd: z.number(),
  }),
  series: z.object({ buckets: z.array(FlowBucketSchema) }),
});

export const GetFlowMetricsMetaSchemaOut = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  count: z.number().int(),
  bucketMs: z.number().int(),
  timezone: z.string().optional(),
  timezoneOffset: z.string().optional(),
  serverTime: z.string().optional(),
});

export const GetFlowMetricsOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetFlowMetricsDataSchemaOut, meta: GetFlowMetricsMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

export const GetTickerInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
});

export const GetOrderbookInputSchema = z.object({
  pair: z.string(),
  opN: z.number().int().min(1).max(200).optional().default(10),
  view: z.enum(['summary', 'detailed', 'full']).optional().default('summary'),
});

export const GetTransactionsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  limit: z.number().int().min(1).max(1000).optional().default(100),
  date: z.string().regex(/^\d{8}$/).optional().describe('YYYYMMDD; omit for latest'),
  minAmount: z.number().positive().optional(),
  maxAmount: z.number().positive().optional(),
  minPrice: z.number().positive().optional(),
  maxPrice: z.number().positive().optional(),
  view: z.enum(['summary', 'items']).optional().default('summary'),
});

export const GetFlowMetricsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  limit: z.number().int().min(1).max(2000).optional().default(100),
  date: z.string().regex(/^\d{8}$/).optional().describe('YYYYMMDD; omit for latest'),
  bucketMs: z.number().int().min(1000).max(3600_000).optional().default(60_000),
  view: z.enum(['summary', 'buckets', 'full']).optional().default('summary'),
  bucketsN: z.number().int().min(1).max(100).optional().default(10),
  tz: z.string().optional().default('Asia/Tokyo'),
});

export const GetTickersInputSchema = z.object({
  market: z.enum(['all', 'jpy']).optional().default('all'),
  view: z.enum(['items']).optional(),
});

// === /tickers_jpy (public REST) ===
export const TickerJpyItemSchema = z.object({
  pair: z.string(),
  sell: z.string().nullable(),
  buy: z.string().nullable(),
  high: z.string(),
  low: z.string(),
  open: z.string(),
  last: z.string(),
  vol: z.string(),
  timestamp: z.number(),
  // 追加: 24h変化率（%）。open/last から算出
  change24h: z.number().nullable().optional(),
  change24hPct: z.number().nullable().optional(),
});
export const GetTickersJpyOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: z.array(TickerJpyItemSchema), meta: z.object({ cache: z.object({ hit: z.boolean(), key: z.string() }).optional(), ts: z.string() }).passthrough() }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Circuit Break Info ===
export const GetCircuitBreakInfoInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
});

export const CircuitBreakInfoSchema = z.object({
  mode: z.enum(['normal', 'halted', 'auction', 'unknown']).nullable(),
  estimated_itayose_price: z.number().nullable().optional(),
  estimated_itayose_amount: z.number().nullable().optional(),
  reopen_timestamp: z.number().int().nullable().optional(),
  reopen_isoTime: z.string().nullable().optional(),
});

export const GetCircuitBreakInfoDataSchemaOut = z.object({ info: CircuitBreakInfoSchema });
export const GetCircuitBreakInfoMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), source: z.enum(['official', 'none', 'placeholder']).optional(), updatedAt: z.string().optional() });
export const GetCircuitBreakInfoOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetCircuitBreakInfoDataSchemaOut, meta: GetCircuitBreakInfoMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

export const GetCandlesInputSchema = z.object({
  pair: z.string(),
  type: CandleTypeEnum,
  date: z
    .string()
    .optional()
    .describe("YYYYMMDD format (e.g., 20251022). Fetches the {limit} most recent candles up to and including this date. For '1month' type use YYYY format. If omitted, returns latest candles."),
  limit: z.number().int().min(1).max(1000).optional().default(200),
  view: z.enum(['full', 'items']).optional().default('full'),
});

export const GetIndicatorsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  type: CandleTypeEnum.optional().default('1day'),
  limit: z.number().int().min(1).max(1000).optional(),
});

// === Pattern Detection ===
export const PatternTypeEnum = z.enum([
  'double_top',
  'double_bottom',
  'triple_top',
  'triple_bottom',
  'head_and_shoulders',
  'inverse_head_and_shoulders',
  // legacy umbrella key (kept for filter-compat)
  'triangle',
  // new explicit triangle variants
  'triangle_ascending',
  'triangle_descending',
  'triangle_symmetrical',
  // wedge patterns
  'falling_wedge',
  'rising_wedge',
  'pennant',
  'flag',
]);

export const DetectPatternsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  type: CandleTypeEnum.optional().default('1day'),
  limit: z.number().int().min(20).max(365).optional().default(90),
  patterns: z.array(PatternTypeEnum).optional().describe(
    [
      'Patterns to detect. Recommended params (guideline):',
      '- double_top/double_bottom: default (swingDepth=7, tolerancePct=0.04, minBarsBetweenSwings=5)',
      '- triple_top/triple_bottom: tolerancePct≈0.05',
      '- triangle_*: tolerancePct≈0.06',
      '- pennant: swingDepth≈5, minBarsBetweenSwings≈3',
    ].join('\n')
  ),
  // Heuristics
  swingDepth: z.number().int().min(1).max(10).optional().default(7),
  tolerancePct: z.number().min(0).max(0.1).optional().default(0.04),
  minBarsBetweenSwings: z.number().int().min(1).max(30).optional().default(5),
  view: z.enum(['summary', 'detailed', 'full', 'debug']).optional().default('detailed'),
  // New: relevance filter for “current-involved” long-term patterns
  requireCurrentInPattern: z.boolean().optional().default(false),
  currentRelevanceDays: z.number().int().min(1).max(365).optional().default(7),
});

export const DetectedPatternSchema = z.object({
  type: PatternTypeEnum,
  confidence: z.number().min(0).max(1),
  range: z.object({ start: z.string(), end: z.string() }),
  pivots: z.array(z.object({ idx: z.number().int(), price: z.number() })).optional(),
  neckline: z.array(z.object({ x: z.number().int().optional(), y: z.number() })).length(2).optional(),
  // Optional: structure diagram (static SVG artifact to help beginners grok the pattern shape)
  structureDiagram: z.object({
    svg: z.string(),
    artifact: z.object({ identifier: z.string(), title: z.string() }),
  }).optional(),
  // 統合: パターンのステータス（形成中/完成度近し/完成済み）
  status: z.enum(['forming', 'near_completion', 'completed']).optional(),
  // 形成中パターン用フィールド
  apexDate: z.string().optional(),           // アペックス（頂点）到達予定日
  daysToApex: z.number().int().optional(),   // アペックスまでの日数
  completionPct: z.number().int().optional(), // 完成度（%）
  // 完成済みパターン用フィールド
  breakoutDate: z.string().optional(),       // ブレイクアウト日
  daysSinceBreakout: z.number().int().optional(), // ブレイクアウトからの経過日数
  aftermath: z
    .object({
      breakoutDate: z.string().nullable().optional(),
      breakoutConfirmed: z.boolean(),
      priceMove: z
        .object({
          days3: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
          days7: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
          days14: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
        })
        .optional(),
      targetReached: z.boolean(),
      theoreticalTarget: z.number().nullable().optional(),
      outcome: z.string(),
      // New: number of bars (days for 1day, weeks for 1week, etc.) to reach theoretical target (if reached within evaluation window)
      daysToTarget: z.number().int().nullable().optional(),
    })
    .optional(),
});

export const DetectPatternsOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    summary: z.string(),
    data: z.object({
      patterns: z.array(DetectedPatternSchema),
      overlays: z
        .object({
          ranges: z
            .array(
              z.object({ start: z.string(), end: z.string(), color: z.string().optional(), label: z.string().optional() })
            )
            .optional(),
          annotations: z.array(z.object({ isoTime: z.string(), text: z.string() })).optional(),
        })
        .optional(),
    }),
    meta: z.object({
      pair: z.string(),
      type: CandleTypeEnum.or(z.string()),
      count: z.number().int(),
      visualization_hints: z
        .object({ preferred_style: z.enum(['candles', 'line']).optional(), highlight_patterns: z.array(PatternTypeEnum).optional() })
        .optional(),
      debug: z
        .object({
          swings: z.array(z.object({ idx: z.number().int(), price: z.number(), kind: z.enum(['H', 'L']), isoTime: z.string().optional() })).optional(),
          candidates: z.array(z.object({
            type: PatternTypeEnum,
            accepted: z.boolean(),
            reason: z.string().optional(),
            indices: z.array(z.number().int()).optional(),
            points: z.array(z.object({ role: z.string(), idx: z.number().int(), price: z.number(), isoTime: z.string().optional() })).optional(),
            details: z.any().optional(),
          })).optional(),
        })
        .optional(),
    }),
  }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Volatility Metrics ===
export const GetVolMetricsInputSchema = z.object({
  pair: z.string(),
  type: CandleTypeEnum,
  limit: z.number().int().min(20).max(500).optional().default(200),
  windows: z.array(z.number().int().min(2)).optional().default([14, 20, 30]),
  useLogReturns: z.boolean().optional().default(true),
  annualize: z.boolean().optional().default(true),
  tz: z.string().optional().default('UTC'),
  cacheTtlMs: z.number().int().optional().default(60_000),
  view: z.enum(['summary', 'detailed', 'full', 'beginner']).optional().default('summary'),
});

export const GetVolMetricsDataSchemaOut = z.object({
  meta: z.object({
    pair: z.string(),
    type: z.string(),
    fetchedAt: z.string(),
    baseIntervalMs: z.number(),
    sampleSize: z.number(),
    windows: z.array(z.number()),
    annualize: z.boolean(),
    useLogReturns: z.boolean(),
    source: z.literal('bitbank:candlestick'),
  }),
  aggregates: z.object({
    rv_std: z.number(),
    rv_std_ann: z.number().optional(),
    parkinson: z.number(),
    garmanKlass: z.number(),
    rogersSatchell: z.number(),
    atr: z.number(),
    skewness: z.number().optional(),
    kurtosis: z.number().optional(),
    gap_ratio: z.number().optional(),
  }),
  rolling: z.array(z.object({
    window: z.number(),
    rv_std: z.number(),
    rv_std_ann: z.number().optional(),
    atr: z.number().optional(),
    parkinson: z.number().optional(),
    garmanKlass: z.number().optional(),
    rogersSatchell: z.number().optional(),
  })),
  series: z.object({
    ts: z.array(z.number()),
    close: z.array(z.number()),
    ret: z.array(z.number()),
    rv_inst: z.array(z.number()).optional(),
  }),
  tags: z.array(z.string()),
});

export const GetVolMetricsMetaSchemaOut = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  type: CandleTypeEnum.or(z.string()),
  count: z.number().int(),
});

export const GetVolMetricsOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetVolMetricsDataSchemaOut, meta: GetVolMetricsMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Market Summary (tickers + volatility snapshot) ===
export const MarketSummaryItemSchema = z.object({
  pair: z.string(),
  last: z.number().nullable(),
  change24hPct: z.number().nullable().optional(),
  vol24h: z.number().nullable().optional(),
  rv_std_ann: z.number().nullable().optional(),
  vol_bucket: z.enum(['low', 'mid', 'high']).nullable().optional(),
  tags: z.array(z.string()).optional(),
});

export const MarketSummaryRanksSchema = z.object({
  topGainers: z.array(z.object({ pair: z.string(), change24hPct: z.number().nullable() })).optional(),
  topLosers: z.array(z.object({ pair: z.string(), change24hPct: z.number().nullable() })).optional(),
  topVolatility: z.array(z.object({ pair: z.string(), rv_std_ann: z.number().nullable() })).optional(),
});

// removed: GetMarketSummary* schemas

// === Analyze Market Signal ===
export const AnalyzeMarketSignalDataSchemaOut = z.object({
  score: z.number(),
  recommendation: z.enum(['bullish', 'bearish', 'neutral']),
  tags: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
  confidenceReason: z.string(),
  nextActions: z.array(z.object({
    priority: z.enum(['high', 'medium', 'low']),
    tool: z.string(),
    reason: z.string(),
    suggestedParams: z.record(z.any()).optional(),
  })),
  alerts: z.array(z.object({ level: z.enum(['info', 'warning', 'critical']), message: z.string() })).optional(),
  formula: z.string(),
  weights: z.object({
    buyPressure: z.number(),
    cvdTrend: z.number(),
    momentum: z.number(),
    volatility: z.number(),
    smaTrend: z.number(),
  }),
  contributions: z.object({
    buyPressure: z.number(),
    cvdTrend: z.number(),
    momentum: z.number(),
    volatility: z.number(),
    smaTrend: z.number(),
  }),
  breakdown: z.object({
    buyPressure: z.object({ rawValue: z.number(), weight: z.number(), contribution: z.number(), interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']) }),
    cvdTrend: z.object({ rawValue: z.number(), weight: z.number(), contribution: z.number(), interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']) }),
    momentum: z.object({ rawValue: z.number(), weight: z.number(), contribution: z.number(), interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']) }),
    volatility: z.object({ rawValue: z.number(), weight: z.number(), contribution: z.number(), interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']) }),
    smaTrend: z.object({ rawValue: z.number(), weight: z.number(), contribution: z.number(), interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']) }),
  }),
  topContributors: z.array(z.enum(['buyPressure', 'cvdTrend', 'momentum', 'volatility', 'smaTrend'])).min(1),
  thresholds: z.object({ bullish: z.number(), bearish: z.number() }),
  metrics: z.object({
    buyPressure: z.number(),
    cvdTrend: z.number(),
    momentumFactor: z.number(),
    volatilityFactor: z.number(),
    smaTrendFactor: z.number(),
    rsi: z.number().nullable(),
    rv_std_ann: z.number(),
    aggressorRatio: z.number(),
    cvdSlope: z.number(),
    horizon: z.number().int(),
  }),
  // Enriched SMA block for LLM-friendly grounding
  sma: z.object({
    current: z.number().nullable(),
    values: z.object({
      sma25: z.number().nullable(),
      sma75: z.number().nullable(),
      sma200: z.number().nullable(),
    }),
    deviations: z.object({
      vs25: z.number().nullable(),
      vs75: z.number().nullable(),
      vs200: z.number().nullable(),
    }),
    arrangement: z.enum(['bullish', 'bearish', 'mixed']),
    position: z.enum(['above_all', 'below_all', 'mixed']),
    distanceFromSma25Pct: z.number().nullable().optional(),
    recentCross: z.object({
      type: z.enum(['golden_cross', 'death_cross']),
      pair: z.literal('25/75'),
      barsAgo: z.number().int(),
    }).nullable().optional(),
  }).optional(),
  // Optional helper fields
  recommendedTimeframes: z.array(z.string()).optional(),
  refs: z.object({
    flow: z.object({ aggregates: z.unknown(), lastBuckets: z.array(z.unknown()) }),
    volatility: z.object({ aggregates: z.unknown() }),
    indicators: z.object({ latest: z.unknown(), trend: TrendLabelEnum }),
  }),
});
export const AnalyzeMarketSignalMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), type: CandleTypeEnum.or(z.string()), windows: z.array(z.number()), bucketMs: z.number().int(), flowLimit: z.number().int() });
export const AnalyzeMarketSignalOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: AnalyzeMarketSignalDataSchemaOut, meta: AnalyzeMarketSignalMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);
export const AnalyzeMarketSignalInputSchema = z.object({ pair: z.string().optional().default('btc_jpy'), type: CandleTypeEnum.optional().default('1day'), flowLimit: z.number().int().optional().default(300), bucketMs: z.number().int().optional().default(60_000), windows: z.array(z.number().int()).optional().default([14, 20, 30]) });

// === Ichimoku numeric snapshot (no visual assumptions) ===
export const AnalyzeIchimokuSnapshotInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  type: CandleTypeEnum.optional().default('1day'),
  limit: z.number().int().min(60).max(365).optional().default(120),
  lookback: z.number().int().min(2).max(120).optional().default(10),
});

export const AnalyzeIchimokuSnapshotDataSchemaOut = z.object({
  latest: z.object({
    close: z.number().nullable(),
    tenkan: z.number().nullable(),
    kijun: z.number().nullable(),
    spanA: z.number().nullable(),
    spanB: z.number().nullable(),
    chikou: z.number().nullable().optional(),
    cloudTop: z.number().nullable(),
    cloudBottom: z.number().nullable(),
  }),
  assessment: z.object({
    pricePosition: z.enum(['above_cloud', 'in_cloud', 'below_cloud', 'unknown']),
    tenkanKijun: z.enum(['bullish', 'bearish', 'neutral', 'unknown']),
    cloudSlope: z.enum(['rising', 'falling', 'flat', 'unknown']),
  }),
  cloud: z.object({
    thickness: z.number().nullable(),
    thicknessPct: z.number().nullable(),
    direction: z.enum(['rising', 'falling', 'flat']).nullable(),
    strength: z.enum(['strong', 'moderate', 'weak']).nullable(),
    upperBound: z.number().nullable(),
    lowerBound: z.number().nullable(),
  }).optional(),
  tenkanKijunDetail: z.object({
    relationship: z.enum(['bullish', 'bearish']).nullable(),
    distance: z.number().nullable(),
    distancePct: z.number().nullable(),
  }).optional(),
  chikouSpan: z.object({
    position: z.enum(['above', 'below']).nullable(),
    distance: z.number().nullable(),
    clearance: z.number().nullable(),
  }).optional(),
  trend: z.object({
    cloudHistory: z.array(z.object({ barsAgo: z.number().int(), position: z.enum(['above', 'in', 'below']) })),
    trendStrength: z.object({ shortTerm: z.number(), mediumTerm: z.number() }),
    momentum: z.enum(['accelerating', 'steady', 'decelerating']),
  }).optional(),
  signals: z.object({
    sanpuku: z.object({
      kouten: z.boolean(),
      gyakuten: z.boolean(),
      conditions: z.object({ priceAboveCloud: z.boolean(), tenkanAboveKijun: z.boolean(), chikouAbovePrice: z.boolean() })
    }),
    recentCrosses: z.array(z.object({ type: z.enum(['golden_cross', 'death_cross']), barsAgo: z.number().int(), description: z.string() })),
    kumoTwist: z.object({ detected: z.boolean(), barsAgo: z.number().int().optional(), direction: z.enum(['bullish', 'bearish']).optional() }),
    overallSignal: z.enum(['strong_bullish', 'bullish', 'neutral', 'bearish', 'strong_bearish']),
    confidence: z.enum(['high', 'medium', 'low']),
  }).optional(),
  scenarios: z.object({
    keyLevels: z.object({ resistance: z.array(z.number()), support: z.array(z.number()), cloudEntry: z.number(), cloudExit: z.number() }),
    scenarios: z.object({
      bullish: z.object({ condition: z.string(), target: z.number(), probability: z.enum(['high', 'medium', 'low']) }),
      bearish: z.object({ condition: z.string(), target: z.number(), probability: z.enum(['high', 'medium', 'low']) }),
    }),
    watchPoints: z.array(z.string()),
  }).optional(),
  tags: z.array(z.string()),
});

export const AnalyzeIchimokuSnapshotMetaSchemaOut = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  type: CandleTypeEnum.or(z.string()),
  count: z.number().int(),
});

export const AnalyzeIchimokuSnapshotOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: AnalyzeIchimokuSnapshotDataSchemaOut, meta: AnalyzeIchimokuSnapshotMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === BB snapshot ===
export const AnalyzeBbSnapshotInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  type: CandleTypeEnum.optional().default('1day'),
  limit: z.number().int().min(40).max(365).optional().default(120),
  mode: z.enum(['default', 'extended']).optional().default('default')
});

// analyze_bb_snapshot: support legacy (flat) and new (structured) data shapes
const AnalyzeBbSnapshotDataSchemaLegacy = z.object({
  latest: z.object({ close: z.number().nullable(), middle: z.number().nullable(), upper: z.number().nullable(), lower: z.number().nullable() }),
  zScore: z.number().nullable(),
  bandWidthPct: z.number().nullable(),
  tags: z.array(z.string()),
});

const AnalyzeBbSnapshotDataSchemaStructured = z.object({
  mode: z.enum(['default', 'extended']),
  price: z.number().nullable(),
  bb: z.union([
    // default: middle/upper/lower
    z.object({
      middle: z.number().nullable(),
      upper: z.number().nullable(),
      lower: z.number().nullable(),
      zScore: z.number().nullable(),
      bandWidthPct: z.number().nullable(),
    }),
    // extended: bands map and bandWidthPct per band
    z.object({
      middle: z.number().nullable(),
      bands: z.record(z.string(), z.number().nullable()).optional(),
      zScore: z.number().nullable(),
      bandWidthPct: z.union([z.number().nullable(), z.record(z.string(), z.number().nullable())]),
    }),
  ]),
  interpretation: z.unknown().optional(),
  position_analysis: z.unknown().optional(),
  extreme_events: z.unknown().optional(),
  context: z.unknown().optional(),
  signals: z.array(z.string()).optional(),
  next_steps: z.record(z.any()).optional(),
  tags: z.array(z.string()).optional(),
});

export const AnalyzeBbSnapshotDataSchemaOut = z.union([
  AnalyzeBbSnapshotDataSchemaLegacy,
  AnalyzeBbSnapshotDataSchemaStructured,
]);

export const AnalyzeBbSnapshotMetaSchemaOut = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  type: CandleTypeEnum.or(z.string()),
  count: z.number().int(),
  mode: z.enum(['default', 'extended']),
  // allow additional meta injected by implementation
  extra: z.object({}).passthrough().optional(),
});

export const AnalyzeBbSnapshotOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: AnalyzeBbSnapshotDataSchemaOut, meta: AnalyzeBbSnapshotMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === SMA snapshot ===
export const AnalyzeSmaSnapshotInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  type: CandleTypeEnum.optional().default('1day'),
  limit: z.number().int().min(200).max(365).optional().default(220),
  periods: z.array(z.number().int()).optional().default([25, 75, 200])
});

export const AnalyzeSmaSnapshotDataSchemaOut = z.object({
  latest: z.object({ close: z.number().nullable() }),
  sma: z.record(z.string(), z.number().nullable()),
  crosses: z.array(z.object({ a: z.string(), b: z.string(), type: z.enum(['golden', 'dead']), delta: z.number() })),
  alignment: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
  tags: z.array(z.string()),
  // Extended (optional): enriched summary and SMA analytics
  summary: z.object({
    close: z.number().nullable(),
    align: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
    position: z.enum(['above_all', 'below_all', 'between', 'unknown']),
  }).optional(),
  smas: z.record(z.string(), z.object({
    value: z.number().nullable(),
    distancePct: z.number().nullable(),
    distanceAbs: z.number().nullable(),
    slope: z.enum(['rising', 'falling', 'flat']),
    slopePctPerBar: z.number().nullable(),
    slopePctTotal: z.number().nullable(),
    barsWindow: z.number().nullable(),
    slopePctPerDay: z.number().nullable().optional(),
  })).optional(),
  recentCrosses: z.array(z.object({
    type: z.enum(['golden_cross', 'dead_cross']),
    pair: z.tuple([z.number(), z.number()]),
    barsAgo: z.number().int(),
    date: z.string(),
  })).optional(),
}).passthrough();

export const AnalyzeSmaSnapshotMetaSchemaOut = z.object({ pair: z.string(), fetchedAt: z.string(), type: CandleTypeEnum.or(z.string()), count: z.number().int(), periods: z.array(z.number().int()) });

export const AnalyzeSmaSnapshotOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: AnalyzeSmaSnapshotDataSchemaOut, meta: AnalyzeSmaSnapshotMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Support Resistance Analysis ===
export const AnalyzeSupportResistanceInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  lookbackDays: z.number().int().min(30).max(200).optional().default(90),
  topN: z.number().int().min(1).max(5).optional().default(3),
  tolerance: z.number().min(0.001).max(0.05).optional().default(0.015),
});

const TouchEventSchema = z.object({
  date: z.string(),
  price: z.number(),
  bounceStrength: z.number(),
  type: z.enum(['support', 'resistance']),
});

const SupportResistanceLevelSchema = z.object({
  price: z.number(),
  pctFromCurrent: z.number(),
  strength: z.number().int().min(1).max(3),
  label: z.string(),
  touchCount: z.number().int(),
  touches: z.array(TouchEventSchema),
  recentBreak: z.object({
    date: z.string(),
    price: z.number(),
    breakPct: z.number(),
  }).optional(),
});

export const AnalyzeSupportResistanceDataSchemaOut = z.object({
  currentPrice: z.number(),
  analysisDate: z.string(),
  lookbackDays: z.number().int(),
  supports: z.array(SupportResistanceLevelSchema),
  resistances: z.array(SupportResistanceLevelSchema),
  detectionCriteria: z.object({
    supportBounceMin: z.number(),
    resistanceRejectMin: z.number(),
    recentBreakWindow: z.number().int(),
    tolerance: z.number(),
  }),
}).passthrough();

export const AnalyzeSupportResistanceMetaSchemaOut = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  lookbackDays: z.number().int(),
  topN: z.number().int(),
  supportCount: z.number().int(),
  resistanceCount: z.number().int(),
}).passthrough();

export const AnalyzeSupportResistanceOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(), data: AnalyzeSupportResistanceDataSchemaOut, meta: AnalyzeSupportResistanceMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

// === Candle Patterns (2-bar patterns: engulfing, harami, etc.) ===

export const CandlePatternTypeEnum = z.enum([
  'bullish_engulfing',
  'bearish_engulfing',
  'bullish_harami',
  'bearish_harami',
  'tweezer_top',
  'tweezer_bottom',
  'dark_cloud_cover',
  'piercing_line',
]);

export const AnalyzeCandlePatternsInputSchema = z.object({
  pair: z.literal('btc_jpy').optional().default('btc_jpy'),
  timeframe: z.literal('1day').optional().default('1day'),
  // as_of: 主要パラメータ名（ISO形式 "2025-11-05" または YYYYMMDD "20251105" を受け付け）
  as_of: z.string().optional().describe('Date to analyze (ISO "2025-11-05" or YYYYMMDD "20251105"). If omitted, uses latest data.'),
  // date: 互換性のため残す（as_of が優先）
  date: z.string().regex(/^\d{8}$/).optional().describe('DEPRECATED: Use as_of instead. YYYYMMDD format.'),
  window_days: z.number().int().min(3).max(10).optional().default(5),
  focus_last_n: z.number().int().min(2).max(5).optional().default(3),
  patterns: z.array(CandlePatternTypeEnum).optional().describe('Patterns to detect. If omitted, all patterns are checked.'),
  history_lookback_days: z.number().int().min(30).max(365).optional().default(180),
  history_horizons: z.array(z.number().int().min(1).max(10)).optional().default([1, 3, 5]),
  allow_partial_patterns: z.boolean().optional().default(true),
});

const HistoryHorizonStatsSchema = z.object({
  avg_return: z.number(),
  win_rate: z.number(),
  sample: z.number().int(),
});

const HistoryStatsSchema = z.object({
  lookback_days: z.number().int(),
  occurrences: z.number().int(),
  horizons: z.record(z.string(), HistoryHorizonStatsSchema),
});

const LocalContextSchema = z.object({
  trend_before: z.enum(['up', 'down', 'neutral']),
  volatility_level: z.enum(['low', 'medium', 'high']),
});

const DetectedCandlePatternSchema = z.object({
  pattern: CandlePatternTypeEnum,
  pattern_jp: z.string(),
  direction: z.enum(['bullish', 'bearish']),
  strength: z.number().min(0).max(1),
  candle_range_index: z.tuple([z.number().int(), z.number().int()]),
  uses_partial_candle: z.boolean(),
  status: z.enum(['confirmed', 'forming']),
  local_context: LocalContextSchema,
  history_stats: HistoryStatsSchema.nullable(),
});

const WindowCandleSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  is_partial: z.boolean(),
});

export const AnalyzeCandlePatternsDataSchemaOut = z.object({
  pair: z.string(),
  timeframe: z.string(),
  snapshot_time: z.string(),
  window: z.object({
    from: z.string(),
    to: z.string(),
    candles: z.array(WindowCandleSchema).describe(
      'CRITICAL: Array order is [oldest, ..., newest]. index 0 = most distant, index n-1 = latest (possibly partial).'
    ),
  }),
  recent_patterns: z.array(DetectedCandlePatternSchema),
  summary: z.string(),
});

export const AnalyzeCandlePatternsMetaSchemaOut = z.object({
  pair: z.string(),
  fetchedAt: z.string(),
  timeframe: z.string(),
  as_of: z.string().nullable().describe('Original input value (ISO or YYYYMMDD)'),
  date: z.string().nullable().describe('YYYYMMDD normalized, null for latest'),
  window_days: z.number().int(),
  patterns_checked: z.array(CandlePatternTypeEnum),
  history_lookback_days: z.number().int(),
  history_horizons: z.array(z.number().int()),
});

export const AnalyzeCandlePatternsOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    summary: z.string(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
    data: AnalyzeCandlePatternsDataSchemaOut,
    meta: AnalyzeCandlePatternsMetaSchemaOut,
  }),
  z.object({
    ok: z.literal(false),
    summary: z.string(),
    data: z.object({}).passthrough(),
    meta: z.object({ errorType: z.string() }).passthrough(),
  }),
]);

// === Candle Pattern Diagram (2-bar pattern visualization) ===

const DiagramCandleSchema = z.object({
  date: z.string().describe('Display date e.g. "11/6(木)"'),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  type: z.enum(['bullish', 'bearish']),
  isPartial: z.boolean().optional(),
});

const DiagramPatternSchema = z.object({
  name: z.string().describe('Pattern name in Japanese e.g. "陽線包み線"'),
  nameEn: z.string().optional().describe('Pattern name in English e.g. "bullish_engulfing"'),
  confirmedDate: z.string().describe('Confirmed date e.g. "11/9(日)"'),
  involvedIndices: z.tuple([z.number().int(), z.number().int()]).describe('[prevIndex, confirmedIndex]'),
  direction: z.enum(['bullish', 'bearish']).optional(),
});

export const RenderCandlePatternDiagramInputSchema = z.object({
  candles: z.array(DiagramCandleSchema).min(2).max(10).describe('Candle data array (oldest first)'),
  pattern: DiagramPatternSchema.optional().describe('Pattern to highlight'),
  title: z.string().optional().describe('Chart title (default: pattern name or "ローソク足チャート")'),
  theme: z.enum(['dark', 'light']).optional().default('dark'),
});

export const RenderCandlePatternDiagramDataSchemaOut = z.object({
  svg: z.string().optional(),
  filePath: z.string().optional(),
  url: z.string().optional(),
});

export const RenderCandlePatternDiagramMetaSchemaOut = z.object({
  width: z.number().int(),
  height: z.number().int(),
  candleCount: z.number().int(),
  patternName: z.string().nullable(),
});

export const RenderCandlePatternDiagramOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    summary: z.string(),
    data: RenderCandlePatternDiagramDataSchemaOut,
    meta: RenderCandlePatternDiagramMetaSchemaOut,
  }),
  z.object({
    ok: z.literal(false),
    summary: z.string(),
    data: z.object({}).passthrough(),
    meta: z.object({ errorType: z.string() }).passthrough(),
  }),
]);
