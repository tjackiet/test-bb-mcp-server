import { toDisplayTime } from './datetime.js';

export function formatPair(pair: string): string {
	return (pair || '').toUpperCase().replace('_', '/');
}

/**
 * タイムスタンプをJST表示形式に変換
 * @param ts タイムスタンプ（ミリ秒）。未指定時は現在時刻
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'）
 * @returns "2025/11/24 15:32:45 JST" 形式
 */
export function formatTimestampJST(ts?: number, tz: string = 'Asia/Tokyo'): string {
	const result = toDisplayTime(ts, tz);
	return result ?? new Date(ts ?? Date.now()).toISOString();
}

export function formatSummary(args: {
	pair?: string;
	timeframe?: string;
	latest?: number;
	totalItems?: number;
	keyPoints?: any;
	volumeStats?: any;
	extra?: string;
} = {}): string {
	const { pair, timeframe, latest, totalItems, keyPoints, volumeStats, extra } = args;
	const p = formatPair(pair ?? '');
	const tf = timeframe ? ` [${timeframe}]` : '';
	const isJpy = typeof pair === 'string' && pair.toLowerCase().includes('jpy');
	const currency = isJpy ? '円' : '';

	// 基本情報
	let summary = p;

	// ローソク足取得の場合（totalItemsが明示的に指定されている場合）
	if (typeof totalItems === 'number' && totalItems > 0) {
		summary += `${tf} ローソク足${totalItems}本取得`;
		summary += `\n⚠️ 配列は古い順: data[0]=最古、data[${totalItems - 1}]=最新`;
	}

	// 期間別の価格推移
	if (keyPoints && keyPoints.today) {
		summary += '\n\n📊 期間別の価格推移:';

		const formatPrice = (price: number) => price.toLocaleString('ja-JP');
		const formatChange = (pct: number | null) => {
			if (pct === null) return '';
			const sign = pct >= 0 ? '+' : '';
			return ` → 変化率 ${sign}${pct.toFixed(1)}%`;
		};

		// 今日
		const today = keyPoints.today;
		summary += `\n- 今日 (${today.date || '不明'}, data[${today.index}]): ¥${formatPrice(today.close)}`;

		// 7日前
		if (keyPoints.sevenDaysAgo) {
			const sd = keyPoints.sevenDaysAgo;
			summary += `\n- 7日前 (${sd.date || '不明'}, data[${sd.index}]): ¥${formatPrice(sd.close)}${formatChange(sd.changePct)}`;
		}

		// 30日前
		if (keyPoints.thirtyDaysAgo) {
			const td = keyPoints.thirtyDaysAgo;
			summary += `\n- 30日前 (${td.date || '不明'}, data[${td.index}]): ¥${formatPrice(td.close)}${formatChange(td.changePct)}`;
		}

		// 90日前
		if (keyPoints.ninetyDaysAgo) {
			const nd = keyPoints.ninetyDaysAgo;
			summary += `\n- 90日前 (${nd.date || '不明'}, data[${nd.index}]): ¥${formatPrice(nd.close)}${formatChange(nd.changePct)}`;
		}

		// 出来高情報
		if (volumeStats) {
			summary += '\n\n【出来高推移】';
			summary += `\n- 直近7日間の平均: ${volumeStats.recent7DaysAvg.toFixed(0)} BTC/日`;
			summary += `\n- その前7日間の平均: ${volumeStats.previous7DaysAvg.toFixed(0)} BTC/日`;
			if (typeof volumeStats.last30DaysAvg === 'number') {
				summary += `\n- 過去30日間の平均: ${volumeStats.last30DaysAvg.toFixed(0)} BTC/日`;
			}
			summary += `\n- 出来高変化率: ${volumeStats.changePct >= 0 ? '+' : ''}${volumeStats.changePct}%`;
			summary += `\n- 判定: ${volumeStats.judgment}`;
		}

		summary += '\n\n※ 全データは structuredContent.data に含まれます';
	} else if (typeof latest === 'number') {
		// keyPointsがない場合（板情報など）は中値を表示
		summary += ` 中値=${latest.toLocaleString('ja-JP')}${currency}`;
	}

	const tail = extra ? ` ${extra}` : '';
	return `${summary}${tail}`.trim();
}


