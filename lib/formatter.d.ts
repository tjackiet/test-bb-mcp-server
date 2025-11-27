export function formatPair(pair: string): string;

export function formatSummary(args?: {
	pair?: string;
	timeframe?: string;
	latest?: number;
	totalItems?: number;
	keyPoints?: any;
	volumeStats?: any;
	extra?: string;
}): string;
