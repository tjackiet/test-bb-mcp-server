/**
 * 日時変換ユーティリティ
 * 各ツールで重複していた関数を統一
 */

/**
 * タイムスタンプをISO8601形式に変換
 * @param ts タイムスタンプ（ミリ秒または秒、unknown型対応）
 * @returns ISO8601文字列、無効な場合はnull
 */
export function toIsoTime(ts: unknown): string | null {
	const d = new Date(Number(ts));
	return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

/**
 * ミリ秒タイムスタンプをISO8601形式に変換（null安全版）
 * @param ms ミリ秒タイムスタンプ
 * @returns ISO8601文字列、無効な場合はnull
 */
export function toIsoMs(ms: number | null): string | null {
	if (ms == null) return null;
	const d = new Date(ms);
	if (Number.isNaN(d.valueOf())) return null;
	return d.toISOString();
}

/**
 * タイムスタンプをタイムゾーン付きISO風形式に変換
 * @param ts ミリ秒タイムスタンプ
 * @param tz タイムゾーン（例: 'Asia/Tokyo', 'UTC'）
 * @returns "2025-01-15T14:30:00" 形式、エラー時はnull
 */
export function toIsoWithTz(ts: number, tz: string): string | null {
	try {
		return new Date(ts).toLocaleString('sv-SE', { timeZone: tz, hour12: false }).replace(' ', 'T');
	} catch {
		return null;
	}
}

/**
 * タイムスタンプを日本語表示形式に変換
 * @param ts ミリ秒タイムスタンプ（未指定時は現在時刻）
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'）
 * @returns "2025/01/15 14:30:00 JST" 形式
 */
export function toDisplayTime(ts: number | undefined, tz: string = 'Asia/Tokyo'): string | null {
	try {
		const d = new Date(ts ?? Date.now());
		const time = d.toLocaleTimeString('ja-JP', {
			timeZone: tz,
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		const date = d.toLocaleDateString('ja-JP', {
			timeZone: tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
		const tzShort = tz === 'UTC' ? 'UTC' : 'JST';
		return `${date} ${time} ${tzShort}`;
	} catch {
		return null;
	}
}
