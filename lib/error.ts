/**
 * unknown型のエラーからメッセージを安全に取得する
 */
export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

/**
 * AbortErrorかどうかを判定する
 */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
