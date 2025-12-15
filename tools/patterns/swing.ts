/**
 * patterns/swing.ts - スイングポイント（ピボット）検出
 *
 * ローソク足データからスイングハイ/スイングローを検出する。
 */

/** ローソク足の最小インターフェース */
export interface Candle {
  open: number;
  close: number;
  high: number;
  low: number;
  isoTime?: string;
}

/** スイングポイント（ピボット） */
export interface Pivot {
  idx: number;
  price: number;
  kind: 'H' | 'L';
}

export interface DetectSwingePointsOptions {
  /** スイング検出の深さ（前後何本を比較するか） */
  swingDepth: number;
  /** 厳格モード: 全ての前後バーより高い/低い必要がある（false: 60%投票制） */
  strictPivots?: boolean;
}

/**
 * ローソク足データからスイングポイント（ピボット）を検出する
 *
 * @param candles - ローソク足データ
 * @param options - 検出オプション
 * @returns 検出されたピボットの配列
 */
export function detectSwingPoints(
  candles: Candle[],
  options: DetectSwingePointsOptions
): Pivot[] {
  const { swingDepth, strictPivots = true } = options;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const pivots: Pivot[] = [];

  for (let i = swingDepth; i < candles.length - swingDepth; i++) {
    let isHigh = true;
    let isLow = true;

    if (strictPivots) {
      // 厳格モード: 全ての前後バーより高い/低い必要がある
      for (let k = 1; k <= swingDepth; k++) {
        if (!(highs[i] > highs[i - k] && highs[i] > highs[i + k])) isHigh = false;
        if (!(lows[i] < lows[i - k] && lows[i] < lows[i + k])) isLow = false;
        if (!isHigh && !isLow) break;
      }
    } else {
      // 緩和モード: 60%投票制
      let votesHigh = 0;
      let votesLow = 0;
      for (let k = 1; k <= swingDepth; k++) {
        votesHigh += (highs[i] > highs[i - k] && highs[i] > highs[i + k]) ? 1 : 0;
        votesLow += (lows[i] < lows[i - k] && lows[i] < lows[i + k]) ? 1 : 0;
      }
      const need = Math.ceil(swingDepth * 0.6);
      isHigh = votesHigh >= need;
      isLow = votesLow >= need;
    }

    // 判定は high/low、格納価格は close（ヒゲ影響を回避）
    if (isHigh) {
      pivots.push({ idx: i, price: candles[i].close, kind: 'H' });
    } else if (isLow) {
      pivots.push({ idx: i, price: candles[i].close, kind: 'L' });
    }
  }

  return pivots;
}

/**
 * ピボットを高値（H）のみにフィルタリング
 */
export function filterPeaks(pivots: Pivot[]): Pivot[] {
  return pivots.filter(p => p.kind === 'H');
}

/**
 * ピボットを安値（L）のみにフィルタリング
 */
export function filterValleys(pivots: Pivot[]): Pivot[] {
  return pivots.filter(p => p.kind === 'L');
}
