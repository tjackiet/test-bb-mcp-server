import getCandles from './get_candles.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { getFetchCount } from '../lib/indicator_buffer.js';
import { GetIndicatorsDataSchema, GetIndicatorsMetaSchema, GetIndicatorsOutputSchema } from '../src/schemas.js';
import type {
  Result,
  Candle,
  NumericSeries,
  CandleType,
  GetIndicatorsData,
  GetIndicatorsMeta,
} from '../src/types/domain.d.ts';

// --- Indicators implementations ---

export function sma(values: number[], period: number = 25): NumericSeries {
  const results: NumericSeries = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
      results.push(Number((sum / period).toFixed(2)));
    } else {
      results.push(null);
    }
  }
  return results;
}

export function rsi(values: number[], period: number = 14): NumericSeries {
  const results: Array<number | null | { value: number; gains: number; losses: number }> = [];
  let gains = 0;
  let losses = 0;

  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      results.push(null);
      continue;
    }

    const diff = values[i] - values[i - 1];

    if (i <= period) {
      if (diff >= 0) gains += diff; else losses -= diff;
    }

    if (i === period) {
      const rs = gains / (losses || 1);
      results.push(Number((100 - 100 / (1 + rs)).toFixed(2)));
    } else if (i > period) {
      const prev = results[i - 1];
      const prevGains = typeof prev === 'object' && prev ? prev.gains : 0;
      const prevLosses = typeof prev === 'object' && prev ? prev.losses : 0;

      const currentGains = diff >= 0 ? diff : 0;
      const currentLosses = diff < 0 ? -diff : 0;

      gains = (prevGains * (period - 1) + currentGains) / period;
      losses = (prevLosses * (period - 1) + currentLosses) / period;

      const rs = gains / (losses || 1);
      const rsiValue = Number((100 - 100 / (1 + rs)).toFixed(2));

      results.push({ value: rsiValue, gains, losses });
    } else {
      results.push(null);
    }
  }

  return results.map((r) => (r != null && typeof r === 'object' ? r.value : r)) as NumericSeries;
}

export function bollingerBands(
  values: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries } {
  const upper: NumericSeries = [];
  const middle: NumericSeries = [];
  const lower: NumericSeries = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
      continue;
    }

    const slice = values.slice(i - period + 1, i + 1);
    const smaValue = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - smaValue, 2), 0) / period;
    const std = Math.sqrt(variance);

    upper.push(Number((smaValue + stdDev * std).toFixed(2)));
    middle.push(Number(smaValue.toFixed(2)));
    lower.push(Number((smaValue - stdDev * std).toFixed(2)));
  }
  return { upper, middle, lower };
}

// Exponential Moving Average
export function ema(values: number[], period: number): NumericSeries {
  const out: NumericSeries = [];
  if (period <= 1) return values.map((v) => (v != null ? Number(v.toFixed(2)) : null));
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) { out.push(null); continue; }
    if (prev == null) {
      // seed with simple average once we have period samples
      if (i < period - 1) { out.push(null); continue; }
      const avg = values.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period;
      prev = avg;
      out.push(Number(avg.toFixed(2)));
    } else {
      const cur: number = v * k + (prev as number) * (1 - k);
      prev = cur;
      out.push(Number(cur.toFixed(2)));
    }
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): { line: NumericSeries; signal: NumericSeries; hist: NumericSeries } {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line: NumericSeries = [];
  for (let i = 0; i < values.length; i++) {
    const a = emaFast[i]; const b = emaSlow[i];
    if (a == null || b == null) line.push(null);
    else line.push(Number(((a as number) - (b as number)).toFixed(2)));
  }
  // signal EMA over MACD line
  const sig = ema(line.map((v) => (v == null ? 0 : (v as number))) as number[], signal);
  const signalSeries: NumericSeries = sig.map((v, i) => (line[i] == null ? null : v));
  const hist: NumericSeries = line.map((v, i) => (v == null || signalSeries[i] == null ? null : Number(((v as number) - (signalSeries[i] as number)).toFixed(2))));
  return { line, signal: signalSeries, hist };
}

export function ichimokuSeries(
  highs: number[],
  lows: number[],
  closes: number[]
): { tenkan: NumericSeries; kijun: NumericSeries; spanA: NumericSeries; spanB: NumericSeries; chikou: NumericSeries } {
  const tenkanSen: NumericSeries = [];
  const kijunSen: NumericSeries = [];
  const rawSpanA: NumericSeries = [];
  const rawSpanB: NumericSeries = [];

  const tenkanPeriod = 9;
  const kijunPeriod = 26;
  const senkouBPeriod = 52;

  for (let i = 0; i < highs.length; i++) {
    if (i < tenkanPeriod - 1) {
      tenkanSen.push(null);
    } else {
      const highSlice = highs.slice(i - tenkanPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - tenkanPeriod + 1, i + 1);
      tenkanSen.push(Number(((Math.max(...highSlice) + Math.min(...lowSlice)) / 2).toFixed(2)));
    }

    if (i < kijunPeriod - 1) {
      kijunSen.push(null);
    } else {
      const highSlice = highs.slice(i - kijunPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - kijunPeriod + 1, i + 1);
      kijunSen.push(Number(((Math.max(...highSlice) + Math.min(...lowSlice)) / 2).toFixed(2)));
    }

    if (tenkanSen[i] != null && kijunSen[i] != null) {
      const a = (tenkanSen[i] as number) + (kijunSen[i] as number);
      rawSpanA.push(Number((a / 2).toFixed(2)));
    } else {
      rawSpanA.push(null);
    }

    if (i < senkouBPeriod - 1) {
      rawSpanB.push(null);
    } else {
      const highSlice = highs.slice(i - senkouBPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - senkouBPeriod + 1, i + 1);
      rawSpanB.push(Number(((Math.max(...highSlice) + Math.min(...lowSlice)) / 2).toFixed(2)));
    }
  }

  const chikou = closes.map((v) => (v != null ? Number(v.toFixed(2)) : null));

  return {
    tenkan: tenkanSen,
    kijun: kijunSen,
    spanA: rawSpanA,
    spanB: rawSpanB,
    chikou,
  };
}

function ichimoku(
  highs: number[],
  lows: number[],
  closes: number[]
): { conversion: number; base: number; spanA: number; spanB: number } | null {
  if (highs.length < 52 || lows.length < 52) return null;
  const conversion = (Math.max(...highs.slice(-9)) + Math.min(...lows.slice(-9))) / 2;
  const base = (Math.max(...highs.slice(-26)) + Math.min(...lows.slice(-26))) / 2;
  const spanA = (conversion + base) / 2;
  const spanB = (Math.max(...highs.slice(-52)) + Math.min(...lows.slice(-52))) / 2;
  return {
    conversion: Number(conversion.toFixed(2)),
    base: Number(base.toFixed(2)),
    spanA: Number(spanA.toFixed(2)),
    spanB: Number(spanB.toFixed(2)),
  };
}

function createChartData(
  normalized: Candle[],
  indicators: any,
  limit: number = 50
): GetIndicatorsData['chart'] {
  const fullLength = normalized.length;
  const recent = normalized.slice(-limit);
  const pastBuffer = fullLength - recent.length;
  const shift = 26;

  return {
    candles: normalized,
    indicators: {
      SMA_5: indicators.sma_5_series,
      SMA_20: indicators.sma_20_series,
      SMA_25: indicators.sma_25_series,
      SMA_50: indicators.sma_50_series,
      SMA_75: indicators.sma_75_series,
      SMA_200: indicators.sma_200_series,
      RSI_14: indicators.RSI_14,
      BB1_upper: indicators.bb1_series?.upper,
      BB1_middle: indicators.bb1_series?.middle,
      BB1_lower: indicators.bb1_series?.lower,
      BB2_upper: indicators.bb2_series?.upper,
      BB2_middle: indicators.bb2_series?.middle,
      BB2_lower: indicators.bb2_series?.lower,
      BB3_upper: indicators.bb3_series?.upper,
      BB3_middle: indicators.bb3_series?.middle,
      BB3_lower: indicators.bb3_series?.lower,
      BB_upper: indicators.bb2_series?.upper,
      BB_middle: indicators.bb2_series?.middle,
      BB_lower: indicators.bb2_series?.lower,
      ICHI_tenkan: indicators.ichi_series?.tenkan,
      ICHI_kijun: indicators.ichi_series?.kijun,
      ICHI_spanA: indicators.ichi_series?.spanA,
      ICHI_spanB: indicators.ichi_series?.spanB,
      ICHI_chikou: indicators.ichi_series?.chikou,
    },
    meta: { pastBuffer, shift },
    stats: {
      min: Math.min(...recent.map((c) => c.low)),
      max: Math.max(...recent.map((c) => c.high)),
      avg: recent.reduce((sum, c) => sum + c.close, 0) / Math.max(1, recent.length),
      volume_avg: recent.reduce((sum, c) => sum + (c.volume ?? 0), 0) / Math.max(1, recent.length),
    },
  };
}

function analyzeTrend(indicators: any, currentPrice: number | null | undefined) {
  if (!indicators.SMA_25 || !indicators.SMA_75 || currentPrice == null) return 'insufficient_data';

  const sma25 = indicators.SMA_25 as number | null;
  const sma75 = indicators.SMA_75 as number | null;
  const sma200 = indicators.SMA_200 as number | null;
  const rsi = indicators.RSI_14 as number | null;

  if (currentPrice > (sma25 ?? Number.POSITIVE_INFINITY) && (sma25 ?? Number.POSITIVE_INFINITY) > (sma75 ?? Number.NEGATIVE_INFINITY)) {
    if (sma200 && currentPrice > sma200) return 'strong_uptrend';
    return 'uptrend';
  }

  if (currentPrice < (sma25 ?? Number.NEGATIVE_INFINITY) && (sma25 ?? Number.NEGATIVE_INFINITY) < (sma75 ?? Number.POSITIVE_INFINITY)) {
    if (sma200 && currentPrice < sma200) return 'strong_downtrend';
    return 'downtrend';
  }

  if (rsi != null && rsi > 70) return 'overbought';
  if (rsi != null && rsi < 30) return 'oversold';
  return 'sideways';
}

export default async function getIndicators(
  pair: string = 'btc_jpy',
  type: CandleType | string = '1day',
  limit: number | null = null
): Promise<Result<GetIndicatorsData, GetIndicatorsMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const displayCount = limit || 60;

  const indicatorKeys = ['SMA_5', 'SMA_20', 'SMA_25', 'SMA_50', 'SMA_75', 'SMA_200', 'RSI_14', 'BB_20', 'ICHIMOKU'] as const;
  const fetchCount = getFetchCount(displayCount, indicatorKeys as unknown as any);

  const candlesResult = await getCandles(chk.pair, type as any, undefined as any, fetchCount);
  if (!candlesResult.ok) return fail(candlesResult.summary.replace(/^Error: /, ''), candlesResult.meta.errorType as any);

  const normalized = candlesResult.data.normalized;
  const allHighs = normalized.map((c) => c.high);
  const allLows = normalized.map((c) => c.low);
  const allCloses = normalized.map((c) => c.close);

  const rsi14_series = rsi(allCloses, 14);
  const macdSeries = macd(allCloses, 12, 26, 9);
  const bb1 = bollingerBands(allCloses, 20, 1);
  const bb2 = bollingerBands(allCloses, 20, 2);
  const bb3 = bollingerBands(allCloses, 20, 3);
  const ichi = ichimokuSeries(allHighs, allLows, allCloses);
  const sma_5_series = sma(allCloses, 5);
  const sma_20_series = sma(allCloses, 20);
  const sma_25_series = sma(allCloses, 25);
  const sma_50_series = sma(allCloses, 50);
  const sma_75_series = sma(allCloses, 75);
  const sma_200_series = sma(allCloses, 200);

  const indicators: any = {
    SMA_5: sma_5_series.at(-1),
    SMA_20: sma_20_series.at(-1),
    SMA_25: sma_25_series.at(-1),
    SMA_50: sma_50_series.at(-1),
    SMA_75: sma_75_series.at(-1),
    SMA_200: sma_200_series.at(-1),
    RSI_14: rsi14_series.at(-1),
    RSI_14_series: rsi14_series,
    BB_upper: bb2.upper.at(-1),
    BB_middle: bb2.middle.at(-1),
    BB_lower: bb2.lower.at(-1),
    BB1_upper: bb1.upper.at(-1),
    BB1_middle: bb1.middle.at(-1),
    BB1_lower: bb1.lower.at(-1),
    BB2_upper: bb2.upper.at(-1),
    BB2_middle: bb2.middle.at(-1),
    BB2_lower: bb2.lower.at(-1),
    BB3_upper: bb3.upper.at(-1),
    BB3_middle: bb3.middle.at(-1),
    BB3_lower: bb3.lower.at(-1),
    bb1_series: bb1,
    bb2_series: bb2,
    bb3_series: bb3,
    ichi_series: ichi,
    macd_series: macdSeries,
    sma_5_series,
    sma_20_series,
    sma_25_series,
    sma_50_series,
    sma_75_series,
    sma_200_series,
  };

  // latest MACD values
  indicators.MACD_line = macdSeries.line.at(-1) as number | null | undefined;
  indicators.MACD_signal = macdSeries.signal.at(-1) as number | null | undefined;
  indicators.MACD_hist = macdSeries.hist.at(-1) as number | null | undefined;

  const ichiSimple = ichimoku(allHighs, allLows, allCloses);
  if (ichiSimple) {
    indicators.ICHIMOKU_conversion = ichiSimple.conversion;
    indicators.ICHIMOKU_base = ichiSimple.base;
    indicators.ICHIMOKU_spanA = ichiSimple.spanA;
    indicators.ICHIMOKU_spanB = ichiSimple.spanB;
  }

  const warnings: string[] = [];
  if (allCloses.length < 5) warnings.push('SMA_5: データ不足');
  if (allCloses.length < 20) warnings.push('SMA_20: データ不足');
  if (allCloses.length < 25) warnings.push('SMA_25: データ不足');
  if (allCloses.length < 50) warnings.push('SMA_50: データ不足');
  if (allCloses.length < 75) warnings.push('SMA_75: データ不足');
  if (allCloses.length < 200) warnings.push('SMA_200: データ不足');
  if (allCloses.length < 15) warnings.push('RSI_14: データ不足');
  if (allCloses.length < 20) warnings.push('Bollinger_Bands: データ不足');
  if (allCloses.length < 52) warnings.push('Ichimoku: データ不足');

  const trend = analyzeTrend(indicators, allCloses.at(-1));

  const chartData = createChartData(normalized, indicators, displayCount);

  (function padSeriesLengths() {
    const len = chartData.candles.length;
    const seriesMap = chartData.indicators as unknown as Record<string, NumericSeries | number | null | undefined>;
    const keys = [
      'SMA_5', 'SMA_20', 'SMA_25', 'SMA_50', 'SMA_75', 'SMA_200',
      'BB_upper', 'BB_middle', 'BB_lower',
      'BB1_upper', 'BB1_middle', 'BB1_lower',
      'BB2_upper', 'BB2_middle', 'BB2_lower',
      'BB3_upper', 'BB3_middle', 'BB3_lower',
      'ICHI_tenkan', 'ICHI_kijun', 'ICHI_spanA', 'ICHI_spanB', 'ICHI_chikou',
    ];
    keys.forEach((k) => {
      const arr = seriesMap[k] as NumericSeries | undefined;
      if (!Array.isArray(arr)) return;
      if (arr.length === len) return;
      if (arr.length < len) {
        const pad = new Array(len - arr.length).fill(null);
        (seriesMap[k] as NumericSeries) = [...arr, ...pad];
      } else {
        (seriesMap[k] as NumericSeries) = arr.slice(-len);
      }
    });
  })();

  const latestIndicators: Record<string, number | null | undefined> = {
    SMA_25: indicators.SMA_25,
    SMA_75: indicators.SMA_75,
    SMA_200: indicators.SMA_200,
    RSI_14: indicators.RSI_14,
    MACD_line: indicators.MACD_line,
    MACD_signal: indicators.MACD_signal,
    MACD_hist: indicators.MACD_hist,
  };
  if (indicators.ICHIMOKU_conversion) {
    latestIndicators.ICHIMOKU_conversion = indicators.ICHIMOKU_conversion;
    latestIndicators.ICHIMOKU_base = indicators.ICHIMOKU_base;
    latestIndicators.ICHIMOKU_spanA = indicators.ICHIMOKU_spanA;
    latestIndicators.ICHIMOKU_spanB = indicators.ICHIMOKU_spanB;
  }

  const summary = formatSummary({
    pair: chk.pair,
    timeframe: String(type),
    latest: allCloses.at(-1) ?? undefined,
    extra: `RSI=${latestIndicators.RSI_14} trend=${trend} (count=${allCloses.length})`,
  });

  const data: GetIndicatorsData = {
    summary,
    raw: candlesResult.data.raw,
    normalized,
    indicators,
    trend,
    chart: chartData,
  } satisfies GetIndicatorsData;

  const meta = createMeta(chk.pair, {
    type,
    count: allCloses.length,
    requiredCount: fetchCount,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  const parsedData = GetIndicatorsDataSchema.parse(data);
  const parsedMeta = GetIndicatorsMetaSchema.parse(meta);
  return GetIndicatorsOutputSchema.parse(ok(summary, parsedData, parsedMeta)) as unknown as Result<GetIndicatorsData, GetIndicatorsMeta>;
}


