/**
 * 数値演算ユーティリティ
 * 各ツールで重複していた関数を統一
 */

/**
 * 配列の平均値を計算
 * @param arr 数値配列
 * @returns 平均値、空配列の場合はnull
 */
export function avg(arr: number[]): number | null {
	return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

/**
 * 配列の中央値を計算
 * @param arr 数値配列
 * @returns 中央値、空配列の場合はnull
 */
export function median(arr: number[]): number | null {
	if (!arr.length) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 配列の標準偏差を計算
 * @param values 数値配列
 * @returns 標準偏差、空配列の場合は0
 */
export function stddev(values: number[]): number {
	const n = values.length;
	if (n === 0) return 0;
	const mean = values.reduce((s, v) => s + v, 0) / n;
	const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
	return Math.sqrt(Math.max(0, variance));
}
