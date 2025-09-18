#!/usr/bin/env tsx
import renderChartSvg from './render_chart_svg.js';
import type { RenderChartSvgOptions } from '../src/types/domain.d.ts';

async function main() {
	const args = process.argv.slice(2);
	const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
	const flagArgs = new Set(args.filter((arg) => arg.startsWith('--')));

	const pair = positionalArgs[0] || 'btc_jpy';
	const type = positionalArgs[1] || '1day';
	const limit = positionalArgs[2] ? parseInt(positionalArgs[2], 10) : 60;

	const withIchimoku = flagArgs.has('--with-ichimoku');

	const options: RenderChartSvgOptions = {
		pair: pair as any,
		type: type as any,
		limit,
		withSMA: flagArgs.has('--no-sma') ? [] : [25, 75, 200],
		withBB: !flagArgs.has('--no-bb'),
		withIchimoku,
	};

	const modeFlag = args.find((a) => a.startsWith('--ichimoku-mode='));
	if (modeFlag) {
		const mode = modeFlag.split('=')[1];
		(options as any).ichimoku = { mode };
		options.withIchimoku = true;
	}

	const bbModeFlag = args.find((a) => a.startsWith('--bb-mode='));
	if (bbModeFlag) {
		const bbMode = bbModeFlag.split('=')[1];
		if (bbMode === 'light' || bbMode === 'full') {
			(options as any).bbMode = bbMode as any;
		}
	}

	const smaFlag = args.find((a) => a.startsWith('--sma='));
	if (smaFlag) {
		const list = smaFlag.split('=')[1];
		if (list && list.length > 0) {
			const periods = list
				.split(',')
				.map((v) => parseInt(v.trim(), 10))
				.filter((n) => Number.isFinite(n) && n > 0);
			if (periods.length > 0) {
				options.withSMA = periods;
			}
		}
	}

	const result = await renderChartSvg(options);
	if (result.ok) {
		if ((result.data as any).filePath) {
			console.error(`Chart saved to ${(result.data as any).filePath}`);
		}
		console.log((result.data as any).svg);
	} else {
		console.error('Failed to generate chart:', result.summary);
		process.exit(1);
	}
}

main();
