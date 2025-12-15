/**
 * patterns/config.ts - 時間軸に応じたパラメータ設定
 *
 * パターン検出で使用するデフォルトパラメータを時間軸ごとに提供する。
 */

/** パターンごとの最小整合度（閾値） */
export const MIN_CONFIDENCE: Record<string, number> = {
  triple_top: 0.7,
  triple_bottom: 0.7,
  double_top: 0.6,
  double_bottom: 0.6,
  head_and_shoulders: 0.7,
  inverse_head_and_shoulders: 0.7,
};

/** スキーマのデフォルト値（サーバ側で埋められる値） */
export const SCHEMA_DEFAULTS = {
  swingDepth: 7,
  minBarsBetweenSwings: 5,
  tolerancePct: 0.04,
} as const;

/**
 * 時間軸に応じたスイング検出パラメータを返す
 */
export function getDefaultParamsForTf(tf: string): { swingDepth: number; minBarsBetweenSwings: number } {
  const t = String(tf);
  // 期待動作（例）の目安に基づくデフォルト
  if (t === '1hour') return { swingDepth: 3, minBarsBetweenSwings: 2 };
  if (t === '4hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
  if (t === '8hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
  if (t === '12hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
  if (t === '1day') return { swingDepth: 6, minBarsBetweenSwings: 4 };
  if (t === '1week') return { swingDepth: 7, minBarsBetweenSwings: 5 };
  if (t === '1month') return { swingDepth: 8, minBarsBetweenSwings: 6 };
  // 分足はやや緩め（ノイズ多めのため最小幅は確保）
  if (t === '30min') return { swingDepth: 3, minBarsBetweenSwings: 2 };
  if (t === '15min') return { swingDepth: 3, minBarsBetweenSwings: 2 };
  if (t === '5min') return { swingDepth: 2, minBarsBetweenSwings: 1 };
  if (t === '1min') return { swingDepth: 2, minBarsBetweenSwings: 1 };
  // フォールバック（日足相当）
  return { swingDepth: 6, minBarsBetweenSwings: 4 };
}

/**
 * 時間軸に応じた許容誤差（tolerancePct）を返す
 */
export function getDefaultToleranceForTf(tf: string): number {
  const t = String(tf);
  if (t === '1hour' || t === '4hour') return 0.05; // 5%
  if (t === '8hour' || t === '12hour') return 0.045; // 4.5%
  if (t === '15min' || t === '30min') return 0.06; // 6%
  if (t === '1week') return 0.035; // 3.5%
  if (t === '1month') return 0.03; // 3.0%
  return 0.04; // 1day 他
}

/**
 * 時間軸に応じた収束係数を返す（三角形・ウェッジ用）
 */
export function getConvergenceFactorForTf(tf: string): number {
  const t = String(tf);
  if (t === '1hour' || t === '4hour' || t === '15min' || t === '30min') return 0.6;
  return 0.8; // default
}

/**
 * 時間軸に応じた三角形の係数を返す
 */
export function getTriangleCoeffForTf(tf: string): { flat: number; move: number } {
  const t = String(tf);
  if (t === '1hour' || t === '4hour') return { flat: 1.2, move: 0.8 };
  return { flat: 0.8, move: 1.2 };
}

/**
 * 時間軸に応じた最小フィット値を返す
 */
export function getMinFitForTf(tf: string): number {
  const t = String(tf);
  if (t === '1hour' || t === '4hour') return 0.60;
  if (t === '1day') return 0.70;
  return 0.75;
}

/**
 * 時間軸に応じた三角形のウィンドウサイズを返す
 */
export function getTriangleWindowSize(tf: string): number {
  const t = String(tf);
  // 長期: 大きなパターン
  if (t === '1month') return 30;
  if (t === '1week') return 40;
  // 中期
  if (t === '1day') return 50;
  // 短期
  if (t === '4hour') return 30;
  if (t === '1hour') return 40;
  if (t === '30min') return 30;
  if (t === '15min') return 30;
  return 20;
}

/**
 * オプションとスキーマデフォルトから実効パラメータを解決する
 */
export function resolveParams(
  tf: string,
  opts: Partial<{
    swingDepth: number;
    tolerancePct: number;
    minBarsBetweenSwings: number;
  }>
): {
  swingDepth: number;
  tolerancePct: number;
  minBarsBetweenSwings: number;
  autoScaled: boolean;
} {
  const auto = getDefaultParamsForTf(tf);
  const tolAuto = getDefaultToleranceForTf(tf);

  // swingDepth: スキーマ既定値(7)が来た場合は時間軸オートに置換
  const swingDepth = Number.isFinite(opts.swingDepth as number)
    ? ((opts.swingDepth as number) === SCHEMA_DEFAULTS.swingDepth ? auto.swingDepth : (opts.swingDepth as number))
    : auto.swingDepth;

  // tolerancePct: スキーマ既定値(0.04)が来た場合は時間軸オートを採用
  const tolerancePct = (typeof opts.tolerancePct === 'number' && !Number.isNaN(opts.tolerancePct))
    ? ((opts.tolerancePct as number) === SCHEMA_DEFAULTS.tolerancePct ? tolAuto : (opts.tolerancePct as number))
    : tolAuto;

  // minBarsBetweenSwings: 同様に既定値(5)なら時間軸オートに置換
  const minBarsBetweenSwings = Number.isFinite(opts.minBarsBetweenSwings as number)
    ? ((opts.minBarsBetweenSwings as number) === SCHEMA_DEFAULTS.minBarsBetweenSwings ? auto.minBarsBetweenSwings : (opts.minBarsBetweenSwings as number))
    : auto.minBarsBetweenSwings;

  const autoScaled = !(Number.isFinite(opts.swingDepth as number) || Number.isFinite(opts.minBarsBetweenSwings as number));

  return { swingDepth, tolerancePct, minBarsBetweenSwings, autoScaled };
}
