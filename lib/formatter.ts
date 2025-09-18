export function formatPair(pair: string): string {
	return (pair || '').toUpperCase().replace('_', '/');
}

export function formatSummary(args: { pair?: string; timeframe?: string; latest?: number; extra?: string } = {}): string {
	const { pair, timeframe, latest, extra } = args;
	const p = formatPair(pair ?? '');
	const tf = timeframe ? ` [${timeframe}]` : '';
	const price = typeof latest === 'number' ? ` close=${latest.toLocaleString('ja-JP')}` : '';
	const tail = extra ? ` ${extra}` : '';
	return `${p}${tf}${price}${tail}`.trim();
}


