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
        withSMA: z.array(z.number().int()).optional().default([25, 75, 200]),
        withBB: z.boolean().optional().default(true),
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
        withLegend: z.boolean().optional().default(true),
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
      'SMA_5','SMA_20','SMA_25','SMA_50','SMA_75','SMA_200',
      'BB_upper','BB_middle','BB_lower','BB1_upper','BB1_middle','BB1_lower','BB2_upper','BB2_middle','BB2_lower','BB3_upper','BB3_middle','BB3_lower',
      'ICHI_tenkan','ICHI_kijun','ICHI_spanA','ICHI_spanB','ICHI_chikou',
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

export const GetTickerInputSchema = z.object({
	pair: z.string().optional().default('btc_jpy'),
});

export const GetOrderbookInputSchema = z.object({
	pair: z.string(),
	opN: z.number().int().min(1).max(1000).optional().default(10),
});

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
