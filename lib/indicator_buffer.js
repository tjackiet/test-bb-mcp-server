// lib/indicator_buffer.js

// インジケータの計算に必要な期間（バッファ）を定義
const INDICATOR_PERIODS = {
  SMA_25: 25,
  SMA_75: 75,
  SMA_200: 200,
  BB_20: 20, // デフォルトのボリンジャーバンド期間
  RSI_14: 15, // 変化を計算するために+1本必要
  ICHIMOKU: 52, // 一目均衡表で最も長い期間
};

/**
 * 表示したいローソク足の本数と、使用するインジケータのリストに基づき、
 * APIから取得すべきローソク足の合計本数を計算します。
 *
 * @param {number} displayCount - チャートに表示したいローソク足の本数
 * @param {string[]} indicatorKeys - 使用するインジケータのキー配列 (例: ['SMA_200', 'BB_20'])
 * @returns {number} 取得すべき合計本数 (表示本数 + バッファ)
 */
export function getFetchCount(displayCount, indicatorKeys = []) {
  // 使われるインジケータの中で最大の期間を探す
  const maxPeriod = indicatorKeys.reduce((max, key) => {
    // INDICATOR_PERIODS に存在するキーのみを対象とする
    const period = INDICATOR_PERIODS[key] || 0;
    return Math.max(max, period);
  }, 0);

  // バッファは (最大期間 - 1) あれば、表示1本目からインジケータが描画できる
  const buffer = maxPeriod > 0 ? maxPeriod - 1 : 0;

  return displayCount + buffer;
}
