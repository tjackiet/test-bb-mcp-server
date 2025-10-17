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
    svgPrecision: z.number().int().min(0).max(3).optional().default(0).describe('Coordinate rounding decimals (0-3).'),
    svgMinify: z.boolean().optional().default(true).describe('Minify SVG text by stripping whitespace where safe.'),
    simplifyTolerance: z.number().min(0).optional().default(0).describe('Line simplification tolerance in pixels (0 disables).'),
    viewBoxTight: z.boolean().optional().default(true).describe('Use tighter paddings to reduce empty margins.'),
    barWidthRatio: z.number().min(0.1).max(0.9).optional().describe('Width ratio of each candle body (slot fraction).'),
    yPaddingPct: z.number().min(0).max(0.2).optional().describe('Vertical padding ratio to expand y-range.'),
    // サイズ制御（超過時は data.svg を省略し filePath のみ返却）
    maxSvgBytes: z.number().int().min(1024).optional().describe('If set and svg exceeds this size (bytes), omit data.svg and return filePath only.'),
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
export const GetCandlesDataSchemaOut = z.object({ raw: z.unknown(), normalized: z.array(CandleSchema) });
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

// === Depth Diff (simple REST-based) ===
export const GetDepthDiffInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  delayMs: z.number().int().min(100).max(5000).optional().default(1000),
  maxLevels: z.number().int().min(10).max(500).optional().default(200),
});

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
  opN: z.number().int().min(1).max(1000).optional().default(10),
});

export const GetTransactionsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  limit: z.number().int().min(1).max(1000).optional().default(100),
  date: z.string().regex(/^\d{8}$/).optional().describe('YYYYMMDD; omit for latest'),
});

export const GetFlowMetricsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  limit: z.number().int().min(1).max(2000).optional().default(100),
  date: z.string().regex(/^\d{8}$/).optional().describe('YYYYMMDD; omit for latest'),
  bucketMs: z.number().int().min(1000).max(3600_000).optional().default(60_000),
});

export const GetTickersInputSchema = z.object({
  market: z.enum(['all', 'jpy']).optional().default('all'),
});

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
  date: z.string().describe('YYYY (1month) or YYYYMMDD (others)'),
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
  'pennant',
  'flag',
]);

export const DetectPatternsInputSchema = z.object({
  pair: z.string().optional().default('btc_jpy'),
  type: CandleTypeEnum.optional().default('1day'),
  limit: z.number().int().min(20).max(365).optional().default(90),
  patterns: z.array(PatternTypeEnum).optional(),
  // Heuristics
  swingDepth: z.number().int().min(1).max(10).optional().default(3),
  tolerancePct: z.number().min(0).max(0.1).optional().default(0.02),
  minBarsBetweenSwings: z.number().int().min(1).max(30).optional().default(3),
});

export const DetectedPatternSchema = z.object({
  type: PatternTypeEnum,
  confidence: z.number().min(0).max(1),
  range: z.object({ start: z.string(), end: z.string() }),
  pivots: z.array(z.object({ idx: z.number().int(), price: z.number() })).optional(),
  neckline: z.array(z.object({ x: z.number().int(), y: z.number() })).length(2).optional(),
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

export const GetMarketSummaryDataSchemaOut = z.object({
  items: z.array(MarketSummaryItemSchema),
  ranks: MarketSummaryRanksSchema.optional(),
  errors: z.array(z.object({ pair: z.string(), reason: z.string() })).optional(),
});

export const GetMarketSummaryMetaSchemaOut = z.object({
  market: z.enum(['all', 'jpy']).optional().default('all'),
  window: z.number().int().optional().default(30),
  ann: z.boolean().optional().default(true),
  fetchedAt: z.string(),
});

export const GetMarketSummaryOutputSchema = z.union([
  z.object({ ok: z.literal(true), summary: z.string(), data: GetMarketSummaryDataSchemaOut, meta: GetMarketSummaryMetaSchemaOut }),
  z.object({ ok: z.literal(false), summary: z.string(), data: z.object({}).passthrough(), meta: z.object({ errorType: z.string() }).passthrough() }),
]);

export const GetMarketSummaryInputSchema = z.object({
  market: z.enum(['all', 'jpy']).optional().default('all'),
  window: z.number().int().min(2).max(180).optional().default(30),
  ann: z.boolean().optional().default(true),
});

// === Analyze Market Signal ===
export const AnalyzeMarketSignalDataSchemaOut = z.object({
  score: z.number(),
  recommendation: z.enum(['bullish', 'bearish', 'neutral']),
  tags: z.array(z.string()),
  metrics: z.object({
    buyPressure: z.number(),
    cvdTrend: z.number(),
    momentumFactor: z.number(),
    volatilityFactor: z.number(),
    rsi: z.number().nullable(),
    rv_std_ann: z.number(),
    aggressorRatio: z.number(),
    cvdSlope: z.number(),
    horizon: z.number().int(),
  }),
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
