/**
 * patterns/index.ts - パターン検出モジュールの再エクスポート
 */

// config
export {
  MIN_CONFIDENCE,
  SCHEMA_DEFAULTS,
  getDefaultParamsForTf,
  getDefaultToleranceForTf,
  getConvergenceFactorForTf,
  getTriangleCoeffForTf,
  getMinFitForTf,
  getTriangleWindowSize,
  resolveParams,
} from './config.js';

// swing
export {
  type Candle,
  type Pivot,
  type DetectSwingePointsOptions,
  detectSwingPoints,
  filterPeaks,
  filterValleys,
} from './swing.js';

// regression
export {
  type RegressionPoint,
  type XYPoint,
  type LinearRegressionResult,
  type LinearRegressionWithR2Result,
  linearRegression,
  trendlineFit,
  linearRegressionWithR2,
  near,
  pct,
  clamp01,
  relDev,
  marginFromRelDev,
} from './regression.js';
