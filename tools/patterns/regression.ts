/**
 * patterns/regression.ts - 回帰・トレンドライン計算
 *
 * パターン検出で使用する線形回帰およびトレンドラインフィット計算。
 */

/** 回帰に使用するポイント（idx/price形式） */
export interface RegressionPoint {
  idx: number;
  price: number;
}

/** 回帰に使用するポイント（x/y形式） */
export interface XYPoint {
  x: number;
  y: number;
}

/** 線形回帰の結果 */
export interface LinearRegressionResult {
  slope: number;
  intercept: number;
}

/** R2付き線形回帰の結果 */
export interface LinearRegressionWithR2Result extends LinearRegressionResult {
  r2: number;
  valueAt: (x: number) => number;
}

/**
 * 線形回帰（三角保ち合い向け）
 */
export function linearRegression(points: RegressionPoint[]): LinearRegressionResult {
  const n = points.length;
  if (!n) return { slope: 0, intercept: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.idx;
    sumY += p.price;
    sumXY += p.idx * p.price;
    sumX2 += p.idx * p.idx;
  }

  const denom = n * sumX2 - sumX * sumX || 1;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

/**
 * トレンドラインへのフィット度を計算（0-1）
 */
export function trendlineFit(points: RegressionPoint[], line: LinearRegressionResult): number {
  if (!points.length) return 0;

  let sumDev = 0;
  for (const p of points) {
    const expected = line.slope * p.idx + line.intercept;
    const dev = Math.abs(p.price - expected) / Math.max(1e-12, p.price);
    sumDev += dev;
  }

  const avgDev = sumDev / points.length;
  return Math.max(0, Math.min(1, 1 - avgDev));
}

/**
 * R2（決定係数）付きの線形回帰（ウェッジ用）
 */
export function linearRegressionWithR2(points: XYPoint[]): LinearRegressionWithR2Result {
  const n = points.length;
  if (n < 2) {
    return {
      slope: 0,
      intercept: 0,
      r2: 0,
      valueAt: (_x: number) => 0,
    };
  }

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX || 1;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R^2
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const yHat = slope * p.x + intercept;
    ssTot += (p.y - meanY) * (p.y - meanY);
    ssRes += (p.y - yHat) * (p.y - yHat);
  }
  const r2 = ssTot <= 0 ? 0 : Math.max(0, Math.min(1, 1 - (ssRes / ssTot)));

  const valueAt = (x: number) => slope * x + intercept;

  return { slope, intercept, r2, valueAt };
}

// --- ヘルパー関数 ---

/**
 * 2つの値が許容誤差内で近いかどうかを判定
 */
export function near(a: number, b: number, tolerancePct: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * tolerancePct;
}

/**
 * パーセント変化を計算
 */
export function pct(a: number, b: number): number {
  return (b - a) / (a === 0 ? 1 : a);
}

/**
 * 0-1にクランプ
 */
export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * 相対偏差を計算
 */
export function relDev(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.max(a, b));
}

/**
 * 相対偏差からマージンを計算
 */
export function marginFromRelDev(rd: number, tol: number): number {
  return clamp01(1 - rd / Math.max(1e-12, tol));
}
