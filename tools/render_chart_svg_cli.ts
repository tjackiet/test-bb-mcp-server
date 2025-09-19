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
	const noSma = flagArgs.has('--no-sma');
	const noBb = flagArgs.has('--no-bb');
	const smaOnly = flagArgs.has('--sma-only');
	const bbOnly = flagArgs.has('--bb-only');
	const ichimokuOnly = flagArgs.has('--ichimoku-only');

	const options: RenderChartSvgOptions = {
		pair: pair as any,
		type: type as any,
		limit,
		// 既定はSMA描画なし（--sma-only や --sma= 指定で有効化）
		withSMA: noSma ? [] : [],
		withBB: !noBb,
		withIchimoku,
	};

	const modeFlag = args.find((a) => a.startsWith('--ichimoku-mode='));
	if (modeFlag) {
		const mode = modeFlag.split('=')[1];
		(options as any).ichimoku = { mode };
		options.withIchimoku = true;
	}

	// BollingerBands モード: --bb-mode=default|extended（後方互換で light/full も受け付け）
	const bbModeFlag = args.find((a) => a.startsWith('--bb-mode='));
	if (bbModeFlag) {
		const bbMode = bbModeFlag.split('=')[1];
		const normalized = bbMode === 'light' ? 'default' : bbMode === 'full' ? 'extended' : bbMode;
		if (normalized === 'default' || normalized === 'extended') {
			(options as any).bbMode = normalized as any;
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

	// --- 単独表示フラグの処理 ---
	if (smaOnly) {
		options.withBB = false;
		options.withIchimoku = false;
	}
	if (bbOnly) {
		options.withBB = true;
		options.withSMA = [];
		options.withIchimoku = false;
	}
	if (ichimokuOnly) {
		options.withIchimoku = true;
		options.withBB = false;
		options.withSMA = [];
		if (!(options as any).ichimoku) (options as any).ichimoku = { mode: 'default' };
	}

	// --- 自動判定 ---
	const hasSmaFlag = Boolean(smaFlag);
	const hasBbMode = Boolean(bbModeFlag);
	if (options.withIchimoku) {
		options.withBB = false;
		options.withSMA = [];
	} else if (hasBbMode) {
		if (!hasSmaFlag && !noSma) {
			options.withSMA = [];
		}
		options.withBB = true;
	} else if (hasSmaFlag && !noBb) {
		options.withBB = false;
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
