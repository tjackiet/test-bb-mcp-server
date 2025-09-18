import type { Pair } from '../src/types/domain.d';

export const ALLOWED_PAIRS: Set<Pair>;

export function normalizePair(raw: unknown): Pair | null;

export interface EnsurePairOk {
	ok: true;
	pair: Pair;
}

export interface EnsurePairErr {
	ok: false;
	error: { type: 'user' | 'internal'; message: string };
}

export function ensurePair(pair: unknown): EnsurePairOk | EnsurePairErr;

export interface ValidateNumberOk {
	ok: true;
	value: number;
}

export interface ValidateNumberErr {
	ok: false;
	error: { type: 'user' | 'internal'; message: string };
}

export function validateLimit(
	limit: unknown,
	min?: number,
	max?: number,
	paramName?: string
): ValidateNumberOk | ValidateNumberErr;

export interface ValidateDateOk {
	ok: true;
	value: string;
}

export interface ValidateDateErr {
	ok: false;
	error: { type: 'user' | 'internal'; message: string };
}

export function validateDate(date: string, type?: string | null): ValidateDateOk | ValidateDateErr;

export function createMeta(pair: Pair, additional?: Record<string, unknown>): {
	pair: Pair;
	fetchedAt: string;
} & Record<string, unknown>;
