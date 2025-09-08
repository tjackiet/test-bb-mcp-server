// tools/get_indicators.js
// 使い方: node tools/get_indicators_cli.mjs btc_jpy 1day
// Claude / MCP Inspector から呼び出し、チャートや分析に利用

import getCandles from './get_candles.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { getFetchCount } from '../lib/indicator_buffer.js';

// 移動平均 (SMA)
function sma(values, period) {
  if (values.length < period) return null;
  const sum = values.slice(-period).reduce((a, b) => a + b, 0);
  return Number((sum / period).toFixed(2));
}

// RSI (相対力指数, デフォルト14日)
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

// ボリンジャーバンド
function bollingerBands(values, period = 20, stdDev = 2) {
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
    'SMA_25',
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

  const allCloses = candlesResult.data.normalized.map((c) => c.close);
  const latestClose = allCloses.at(-1);

  // インジケーター計算 (全長データで行う)
  const indicators = {
    SMA_25: sma(allCloses, 25),
    SMA_75: sma(allCloses, 75),
    SMA_200: sma(allCloses, 200),
    RSI_14: rsi(allCloses, 14),
  };

  // ボリンジャーバンド計算 (全長データで行う)
  const bbSeries = bollingerBands(allCloses, 20, 2);
  const lastUpper = bbSeries.upper.at(-1);
  const lastMiddle = bbSeries.middle.at(-1);
  const lastLower = bbSeries.lower.at(-1);

  if (lastUpper && lastMiddle && lastLower) {
    indicators.BB_upper = lastUpper;
    indicators.BB_middle = lastMiddle;
    indicators.BB_lower = lastLower;
    const bandwidth = ((lastUpper - lastLower) / lastMiddle) * 100;
    indicators.BB_bandwidth = Number(bandwidth.toFixed(2));
  }

  // 一目均衡表計算 (全長データで行う)
  const allHighs = candlesResult.data.normalized.map((c) => c.high);
  const allLows = candlesResult.data.normalized.map((c) => c.low);
  const ichi = ichimoku(allHighs, allLows, allCloses);
  if (ichi) {
    indicators.ICHIMOKU_conversion = ichi.conversion;
    indicators.ICHIMOKU_base = ichi.base;
    indicators.ICHIMOKU_spanA = ichi.spanA;
    indicators.ICHIMOKU_spanB = ichi.spanB;
  }

  // データ不足の警告
  const warnings = [];
  if (allCloses.length < 25) warnings.push('SMA_25: データ不足');
  if (allCloses.length < 75) warnings.push('SMA_75: データ不足');
  if (allCloses.length < 200) warnings.push('SMA_200: データ不足');
  if (allCloses.length < 15) warnings.push('RSI_14: データ不足');
  if (allCloses.length < 20) warnings.push('Bollinger_Bands: データ不足');
  if (allCloses.length < 52) warnings.push('Ichimoku: データ不足');

  // トレンド分析
  const trend = analyzeTrend(indicators, latestClose);

  // チャート描画用データ (表示本数 displayCount で切り出す)
  const chartIndicatorData = { ...indicators, bb_series: bbSeries };
  const chartData = createChartData(
    candlesResult.data.normalized,
    chartIndicatorData,
    displayCount
  );

  const summary = formatSummary({
    pair: chk.pair,
    timeframe: type,
    latest: latestClose,
    extra: `RSI=${indicators.RSI_14} trend=${trend} (count=${allCloses.length})`,
  });

  const data = {
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
  const recent = normalized.slice(-limit);

  const bbUpper = indicators.bb_series?.upper.slice(-limit);
  const bbMiddle = indicators.bb_series?.middle.slice(-limit);
  const bbLower = indicators.bb_series?.lower.slice(-limit);

  return {
    // 最近のデータのみ（軽量化）
    candles: recent.map(c => ({
      time: c.isoTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    })),
    
    // インジケーター値
    indicators: {
      SMA_25: indicators.SMA_25,
      SMA_75: indicators.SMA_75,
      SMA_200: indicators.SMA_200,
      RSI_14: indicators.RSI_14,
      BB_upper: bbUpper,
      BB_middle: bbMiddle,
      BB_lower: bbLower,
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
