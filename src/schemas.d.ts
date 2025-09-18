// Auto-typed facade for schemas.js so that schemas.js is the single source of truth.
// Keep declarations minimal to avoid drift; use z.infer for consumer types.
import type { z } from 'zod';

export declare const GetTickerInputSchema: z.ZodObject<any>;
export declare const GetOrderbookInputSchema: z.ZodObject<any>;
export declare const GetCandlesInputSchema: z.ZodObject<any>;
export declare const GetIndicatorsInputSchema: z.ZodObject<any>;

export declare const CandleTypeEnum: z.ZodTypeAny;
export declare const RenderChartSvgInputSchema: z.ZodObject<any>;
export declare const RenderChartSvgOutputSchema: z.ZodObject<any>;

export type RenderChartSvgInput = z.infer<typeof RenderChartSvgInputSchema>;
export type RenderChartSvgOutput = z.infer<typeof RenderChartSvgOutputSchema>;
export type GetTickerInput = z.infer<typeof GetTickerInputSchema>;
export type GetOrderbookInput = z.infer<typeof GetOrderbookInputSchema>;
export type GetCandlesInput = z.infer<typeof GetCandlesInputSchema>;
export type GetIndicatorsInput = z.infer<typeof GetIndicatorsInputSchema>;

export declare const NumericSeriesSchema: z.ZodTypeAny;
export declare const CandleSchema: z.ZodTypeAny;
export declare const IchimokuSeriesSchema: z.ZodTypeAny;
export declare const BollingerBandsSeriesSchema: z.ZodTypeAny;
export declare const SmaSeriesFixedSchema: z.ZodTypeAny;
export declare const ChartIndicatorsSchema: z.ZodTypeAny;
export declare const ChartMetaSchema: z.ZodTypeAny;
export declare const ChartStatsSchema: z.ZodTypeAny;
export declare const ChartPayloadSchema: z.ZodTypeAny;
export declare const TrendLabelEnum: z.ZodTypeAny;
export declare const IndicatorsInternalSchema: z.ZodTypeAny;
export declare const GetIndicatorsDataSchema: z.ZodTypeAny;
export declare const GetIndicatorsMetaSchema: z.ZodTypeAny;
