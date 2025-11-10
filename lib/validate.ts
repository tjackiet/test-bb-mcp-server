import type { Pair } from '../src/types/domain.d.ts';

export const ALLOWED_PAIRS: Set<Pair> = new Set([
	'btc_jpy',
	'eth_jpy',
	'xrp_jpy',
	'ltc_jpy',
	'bcc_jpy',
]);

export function normalizePair(raw: unknown): Pair | null {
	if (!raw) return null;
	return String(raw).trim().toLowerCase().replace(/[\/-]/g, '_') as Pair;
}

export function ensurePair(pair: unknown):
	| { ok: true; pair: Pair }
	| { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	const norm = normalizePair(pair);
	if (!norm || !/^[a-z0-9]+_[a-z0-9]+$/.test(norm)) {
		return {
			ok: false,
			error: { type: 'user', message: `pair '${String(pair)}' が不正です（例: btc_jpy）` },
		};
	}
	if (!ALLOWED_PAIRS.has(norm)) {
		return {
			ok: false,
			error: {
				type: 'user',
				message: `未対応のpair: '${norm}'（対応例: ${[...ALLOWED_PAIRS].join(', ')}）`,
			},
		};
	}
	return { ok: true, pair: norm };
}

export function validateLimit(
	limit: unknown,
	min = 1,
	max = 1000,
	paramName = 'limit'
):
	| { ok: true; value: number }
	| { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	const num = Number(limit);
	if (!Number.isInteger(num) || num < min || num > max) {
		return {
			ok: false,
			error: {
				type: 'user',
				message: `${paramName} は ${min}〜${max} の整数で指定してください（指定値: ${String(limit)}）`,
			},
		};
	}
	return { ok: true, value: num };
}

export function validateDate(
	date: string,
	type: string | null = null
):
	| { ok: true; value: string }
	| { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	if (type) {
		// YYYYMMDD が必要なタイプ（分足～1時間足）
		const TYPES_REQUIRE_YYYYMMDD = new Set([
			'1min',
			'5min',
			'15min',
			'30min',
			'1hour',
		]);

		if (TYPES_REQUIRE_YYYYMMDD.has(type)) {
			if (!/^\d{8}$/.test(date)) {
				return {
					ok: false,
					error: { type: 'user', message: `${type} の場合、date は YYYYMMDD 形式で指定してください（指定値: ${date}）` },
				};
			}
			return { ok: true, value: date };
		} else {
			// 4hour/8hour/12hour 以上は YYYY 単位で取得（公式仕様）
			if (!/^\d{4,8}$/.test(date)) {
				return {
					ok: false,
					error: { type: 'user', message: `date は YYYY または YYYYMMDD 形式で指定してください（指定値: ${date}）` },
				};
			}
			return { ok: true, value: String(date).substring(0, 4) };
		}
	}

	if (!/^\d{4,8}$/.test(date)) {
		return {
			ok: false,
			error: { type: 'user', message: `date は YYYY または YYYYMMDD 形式で指定してください（指定値: ${date}）` },
		};
	}
	return { ok: true, value: date };
}

export function createMeta(pair: Pair, additional: Record<string, unknown> = {}) {
	return {
		pair,
		fetchedAt: new Date().toISOString(),
		...additional,
	};
}


