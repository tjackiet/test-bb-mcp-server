export type IndicatorBufferKey =
	| 'SMA_5'
	| 'SMA_20'
	| 'SMA_25'
	| 'SMA_50'
	| 'SMA_75'
	| 'SMA_200'
	| 'BB_20'
	| 'RSI_14'
	| 'ICHIMOKU';

const INDICATOR_PERIODS: Record<IndicatorBufferKey, number> = {
	SMA_5: 5,
	SMA_20: 20,
	SMA_25: 25,
	SMA_50: 50,
	SMA_75: 75,
	SMA_200: 200,
	BB_20: 20,
	RSI_14: 15,
	ICHIMOKU: 78,
};

export function getFetchCount(displayCount: number, indicatorKeys: IndicatorBufferKey[] = []): number {
	const maxPeriod = indicatorKeys.reduce((max, key) => {
		const period = INDICATOR_PERIODS[key] || 0;
		return Math.max(max, period);
	}, 0);
	const buffer = maxPeriod > 0 ? maxPeriod - 1 : 0;
	return displayCount + buffer;
}


