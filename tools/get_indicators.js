// tools/get_indicators.js
// 使い方: node tools/get_indicators_cli.mjs btc_jpy 1day
// Claude / MCP Inspector から呼び出し、チャートや分析に利用

import getCandles from './get_candles.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { getFetchCount } from '../lib/indicator_buffer.js';

// SMA (単純移動平均線)
export function sma(values, period = 25) {
  const results = [];
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

// RSI (時系列を返すバージョン)
export function rsi(values, period = 14) {
  const results = [];
  let gains = 0;
  let losses = 0;

  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      results.push(null); // 最初は差分がないのでnull
      continue;
    }
    
    const diff = values[i] - values[i-1];
    
    if (i <= period) {
      if (diff >= 0) {
        gains += diff;
      } else {
        losses -= diff;
      }
    }
    
    if (i === period) {
       const rs = gains / (losses || 1);
       results.push(Number((100 - 100 / (1 + rs)).toFixed(2)));
    } else if (i > period) {
      const prevGains = results[i-1] ? (results[i-1].gains || 0) : 0;
      const prevLosses = results[i-1] ? (results[i-1].losses || 0) : 0;
      
      const currentGains = diff >=0 ? diff : 0;
      const currentLosses = diff < 0 ? -diff : 0;

      gains = (prevGains * (period - 1) + currentGains) / period;
      losses = (prevLosses * (period - 1) + currentLosses) / period;
      
      const rs = gains / (losses || 1);
      const rsiValue = Number((100 - 100 / (1 + rs)).toFixed(2));

      results.push({value: rsiValue, gains, losses});

    } else {
      results.push(null); // データ不足
    }
  }
  
  // オブジェクトから値だけを抽出
  return results.map(r => r ? r.value : null);
}

// ボリンジャーバンド
export function bollingerBands(values, period = 20, stdDev = 2) {
  const upper = [];
  const middle = [];
  const lower = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
      continue;
    }

    const slice = values.slice(i - period + 1, i + 1);
    const smaValue = slice.reduce((a, b) => a + b, 0) / period;
    const variance =
      slice.reduce((sum, val) => sum + Math.pow(val - smaValue, 2), 0) /
      period;
    const std = Math.sqrt(variance);

    upper.push(Number((smaValue + stdDev * std).toFixed(2)));
    middle.push(Number(smaValue.toFixed(2)));
    lower.push(Number((smaValue - stdDev * std).toFixed(2)));
  }
  return { upper, middle, lower };
}

// 一目均衡表
export function ichimokuSeries(highs, lows, closes) {
  const tenkanSen = []; // 転換線 (9)
  const kijunSen = []; // 基準線 (26)
  const rawSpanA = []; // 先行スパンA (計算用)
  const rawSpanB = []; // 先行スパンB (計算用)

  const tenkanPeriod = 9;
  const kijunPeriod = 26;
  const senkouBPeriod = 52;
  const shift = 26;

  for (let i = 0; i < highs.length; i++) {
    // 転換線
    if (i < tenkanPeriod - 1) {
      tenkanSen.push(null);
    } else {
      const highSlice = highs.slice(i - tenkanPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - tenkanPeriod + 1, i + 1);
      tenkanSen.push((Math.max(...highSlice) + Math.min(...lowSlice)) / 2);
    }

    // 基準線
    if (i < kijunPeriod - 1) {
      kijunSen.push(null);
    } else {
      const highSlice = highs.slice(i - kijunPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - kijunPeriod + 1, i + 1);
      kijunSen.push((Math.max(...highSlice) + Math.min(...lowSlice)) / 2);
    }

    // 先行スパンA (計算用)
    if (tenkanSen[i] && kijunSen[i]) {
      rawSpanA.push((tenkanSen[i] + kijunSen[i]) / 2);
    } else {
      rawSpanA.push(null);
    }

    // 先行スパンB (計算用)
    if (i < senkouBPeriod - 1) {
      rawSpanB.push(null);
    } else {
      const highSlice = highs.slice(i - senkouBPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - senkouBPeriod + 1, i + 1);
      rawSpanB.push((Math.max(...highSlice) + Math.min(...lowSlice)) / 2);
    }
  }

  // --- 描画用に各系列の時点をずらす ---
  // ★ 責務分離のため、描画側(render_chart_svg)でオフセットするため、ここではシフトしない
  // 遅行スパン (closesをそのまま利用し、描画側で-26オフセット)
  const chikou = closes;

  return {
    tenkan: tenkanSen.map(v => v ? Number(v.toFixed(2)) : null),
    kijun: kijunSen.map(v => v ? Number(v.toFixed(2)) : null),
    // 先行スパンもシフトせず、元データを返す
    spanA: rawSpanA.map(v => v ? Number(v.toFixed(2)) : null),
    spanB: rawSpanB.map(v => v ? Number(v.toFixed(2)) : null),
    chikou: chikou.map(v => v ? Number(v.toFixed(2)) : null),
  };
}

// 一目均衡表（簡略版）
function ichimoku(highs, lows, closes) {
  if (highs.length < 52 || lows.length < 52) return null;
  
  // 転換線 (Conversion Line) - 9日
  const conversion = (Math.max(...highs.slice(-9)) + Math.min(...lows.slice(-9))) / 2;
  
  // 基準線 (Base Line) - 26日
  const base = (Math.max(...highs.slice(-26)) + Math.min(...lows.slice(-26))) / 2;
  
  // 先行スパンA (Leading Span A)
  const spanA = (conversion + base) / 2;
  
  // 先行スパンB (Leading Span B) - 52日
  const spanB = (Math.max(...highs.slice(-52)) + Math.min(...lows.slice(-52))) / 2;
  
  return {
    conversion: Number(conversion.toFixed(2)),
    base: Number(base.toFixed(2)),
    spanA: Number(spanA.toFixed(2)),
    spanB: Number(spanB.toFixed(2))
  };
}

// 必要なデータ数を計算
function getRequiredDataCount(type) {
  const requirements = {
    '1min': 200,    // 短期分析用
    '5min': 200,
    '15min': 200,
    '30min': 200,
    '1hour': 200,
    '4hour': 200,
    '8hour': 200,
    '12hour': 200,
    '1day': 365,    // 長期インジケーター（SMA200）対応
    '1week': 52,    // 週足52本で1年分
    '1month': 24,   // 月足24本で2年分
  };
  return requirements[type] || 200;
}

export default async function getIndicators(
  pair = 'btc_jpy',
  type = '1day',
  limit = null
) {
  // ペアバリデーション
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  // 表示したい本数
  const displayCount = limit || 60;

  // 計算に利用するすべてのインジケータキー
  const indicatorKeys = [
    'SMA_5',
    'SMA_20',
    'SMA_25',
    'SMA_50',
    'SMA_75',
    'SMA_200',
    'RSI_14',
    'BB_20',
    'ICHIMOKU',
  ];

  // バッファを含めて取得すべき合計本数を計算
  const fetchCount = getFetchCount(displayCount, indicatorKeys);

  // ローソク足データを取得
  const candlesResult = await getCandles(chk.pair, type, undefined, fetchCount);
  if (!candlesResult.ok) return candlesResult; // failをそのまま返す

  const normalized = candlesResult.data.normalized;
  const allHighs = normalized.map((c) => c.high);
  const allLows = normalized.map((c) => c.low);
  const allCloses = normalized.map((c) => c.close);

  // インジケーター計算 (全長データで行う)
  const rsi14_series = rsi(allCloses, 14);
  const bb20 = bollingerBands(allCloses, 20, 2);
  const ichiSeries = ichimokuSeries(allHighs, allLows, allCloses);
  const sma_5_series = sma(allCloses, 5);
  const sma_20_series = sma(allCloses, 20);
  const sma_25_series = sma(allCloses, 25);
  const sma_50_series = sma(allCloses, 50);
  const sma_75_series = sma(allCloses, 75);
  const sma_200_series = sma(allCloses, 200);

  const indicators = {
    SMA_5: sma_5_series.at(-1),
    SMA_20: sma_20_series.at(-1),
    SMA_25: sma_25_series.at(-1),
    SMA_50: sma_50_series.at(-1),
    SMA_75: sma_75_series.at(-1),
    SMA_200: sma_200_series.at(-1),
    RSI_14: rsi14_series.at(-1),
    BB_upper: bb20.upper.at(-1),
    BB_middle: bb20.middle.at(-1),
    BB_lower: bb20.lower.at(-1),
    bb_series: bb20, // for chart
    ichi_series: ichiSeries, // for chart
    sma_5_series,
    sma_20_series,
    sma_25_series,
    sma_50_series,
    sma_75_series,
    sma_200_series,
  };

  // ボリンジャーバンド計算 (全長データで行う)
  const lastUpper = bb20.upper.at(-1);
  const lastMiddle = bb20.middle.at(-1);
  const lastLower = bb20.lower.at(-1);

  if (lastUpper && lastMiddle && lastLower) {
    indicators.BB_upper = lastUpper;
    indicators.BB_middle = lastMiddle;
    indicators.BB_lower = lastLower;
    const bandwidth = ((lastUpper - lastLower) / lastMiddle) * 100;
    indicators.BB_bandwidth = Number(bandwidth.toFixed(2));
  }

  // 一目均衡表計算 (全長データで行う)
  const ichiSimple = ichimoku(allHighs, allLows, allCloses);
  if (ichiSimple) {
    indicators.ICHIMOKU_conversion = ichiSimple.conversion;
    indicators.ICHIMOKU_base = ichiSimple.base;
    indicators.ICHIMOKU_spanA = ichiSimple.spanA;
    indicators.ICHIMOKU_spanB = ichiSimple.spanB;
  }

  // データ不足の警告
  const warnings = [];
  if (allCloses.length < 5) warnings.push('SMA_5: データ不足');
  if (allCloses.length < 20) warnings.push('SMA_20: データ不足');
  if (allCloses.length < 25) warnings.push('SMA_25: データ不足');
  if (allCloses.length < 50) warnings.push('SMA_50: データ不足');
  if (allCloses.length < 75) warnings.push('SMA_75: データ不足');
  if (allCloses.length < 200) warnings.push('SMA_200: データ不足');
  if (allCloses.length < 15) warnings.push('RSI_14: データ不足');
  if (allCloses.length < 20) warnings.push('Bollinger_Bands: データ不足');
  if (allCloses.length < 52) warnings.push('Ichimoku: データ不足');

  // トレンド分析
  const trend = analyzeTrend(indicators, allCloses.at(-1));

  // チャート描画用データ (表示本数 displayCount で切り出す)
  const chartData = createChartData(
    candlesResult.data.normalized,
    indicators,
    displayCount
  );

  // サマリー用の最新値取得
  const latestIndicators = {
    SMA_25: indicators.SMA_25,
    SMA_75: indicators.SMA_75,
    SMA_200: indicators.SMA_200,
    RSI_14: indicators.RSI_14,
  };
  // 既に計算済みのichiSimpleを再利用
  if (indicators.ICHIMOKU_conversion) {
    latestIndicators.ICHIMOKU_conversion = indicators.ICHIMOKU_conversion;
    latestIndicators.ICHIMOKU_base = indicators.ICHIMOKU_base;
    latestIndicators.ICHIMOKU_spanA = indicators.ICHIMOKU_spanA;
    latestIndicators.ICHIMOKU_spanB = indicators.ICHIMOKU_spanB;
  }

  const summary = formatSummary({
    pair: chk.pair,
    timeframe: type,
    latest: allCloses.at(-1),
    extra: `RSI=${latestIndicators.RSI_14} trend=${trend} (count=${allCloses.length})`,
  });

  // data のネストを一段階浅くする
  const data = {
    summary,
    raw: candlesResult.data.raw,
    normalized: candlesResult.data.normalized,
    indicators,
    trend,
    chart: chartData, // チャート描画用の軽量データ
  };
  const meta = createMeta(chk.pair, {
    type,
    count: allCloses.length,
    requiredCount: fetchCount,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  return ok(summary, data, meta);
}

// トレンド分析
function analyzeTrend(indicators, currentPrice) {
  if (!indicators.SMA_25 || !indicators.SMA_75) return 'insufficient_data';

  const sma25 = indicators.SMA_25;
  const sma75 = indicators.SMA_75;
  const sma200 = indicators.SMA_200;
  const rsi = indicators.RSI_14;

  // 短期トレンド
  if (currentPrice > sma25 && sma25 > sma75) {
    if (sma200 && currentPrice > sma200) return 'strong_uptrend';
    return 'uptrend';
  }
  
  if (currentPrice < sma25 && sma25 < sma75) {
    if (sma200 && currentPrice < sma200) return 'strong_downtrend';
    return 'downtrend';
  }

  // RSIによる過買い・過売り判定
  if (rsi > 70) return 'overbought';
  if (rsi < 30) return 'oversold';

  return 'sideways';
}

// チャート描画用の軽量データ生成
function createChartData(normalized, indicators, limit = 50) {
  const fullLength = normalized.length;
  const recent = normalized.slice(-limit);
  const pastBuffer = fullLength - recent.length;
  const shift = 26; // Ichimokuの先行スパンのシフト固定値

  return {
    candles: normalized, // ★ 描画側でスライスするため、バッファ付きのまま渡す
    
    // インジケーター値は全長を渡す
    indicators: {
      SMA_5: indicators.sma_5_series,
      SMA_20: indicators.sma_20_series,
      SMA_25: indicators.sma_25_series,
      SMA_50: indicators.sma_50_series,
      SMA_75: indicators.sma_75_series,
      SMA_200: indicators.sma_200_series,
      RSI_14: indicators.RSI_14, // 最新値のみ
      BB_upper: indicators.bb_series?.upper,
      BB_middle: indicators.bb_series?.middle,
      BB_lower: indicators.bb_series?.lower,
      ICHI_tenkan: indicators.ichi_series?.tenkan,
      ICHI_kijun: indicators.ichi_series?.kijun,
      ICHI_spanA: indicators.ichi_series?.spanA,
      ICHI_spanB: indicators.ichi_series?.spanB,
      ICHI_chikou: indicators.ichi_series?.chikou,
    },
    
    // 描画側に伝えるメタ情報
    meta: {
      pastBuffer,
      shift, // ★ 先行スパンのシフト数を描画側に伝える
    },

    // チャート描画用の統計情報
    stats: {
      min: Math.min(...recent.map(c => c.low)),
      max: Math.max(...recent.map(c => c.high)),
      avg: recent.reduce((sum, c) => sum + c.close, 0) / recent.length,
      volume_avg: recent.reduce((sum, c) => sum + c.volume, 0) / recent.length
    }
  };
}
