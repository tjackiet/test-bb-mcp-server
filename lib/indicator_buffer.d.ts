// Keys used in indicator buffer calculation
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

/**
 * Calculate total fetch count from desired display candles and indicator keys.
 */
export function getFetchCount(displayCount: number, indicatorKeys?: IndicatorBufferKey[]): number;
