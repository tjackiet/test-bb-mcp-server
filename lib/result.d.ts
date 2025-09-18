import type { OkResult, FailResult } from '../src/types/domain.d';

export function ok<T = Record<string, unknown>, M = Record<string, unknown>>(
	summary: string,
	data?: T,
	meta?: M
): OkResult<T, M>;

export function fail<M = Record<string, unknown>>(
	message: string,
	type?: string,
	meta?: M
): FailResult<M>;
