import type { OkResult, FailResult } from '../src/types/domain.d.ts';

export function ok<T = Record<string, unknown>, M = Record<string, unknown>>(
	summary: string,
	data: T = {} as T,
	meta: M = {} as M
): OkResult<T, M> {
	return {
		ok: true,
		summary,
		data,
		meta,
	};
}

export function fail<M = Record<string, unknown>>(
	message: string,
	type: string = 'user',
	meta: M = {} as M
): FailResult<M> {
	return {
		ok: false,
		summary: `Error: ${message}`,
		data: {},
		meta: { errorType: type, ...(meta as object) } as FailResult<M>['meta'],
	};
}


