import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESH = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(file: string, obj: unknown) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function log(level: 'error' | 'warn' | 'info' | 'debug', event: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 2) > THRESH) return;
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `${date}.jsonl`);
  const record = { ts: new Date().toISOString(), level, ...event } as const;
  try {
    writeJsonl(file, record);
  } catch {
    // best-effort: ignore log failures
  }
}

export function logToolRun(args: { tool: string; input: unknown; result: any; ms: number }): void {
  const { tool, input, result, ms } = args;
  const safeData = {
    ok: result?.ok,
    summary: result?.summary,
    meta: result?.meta,
  };
  log('info', { type: 'tool_run', tool, input, ms, result: safeData });
}

export function logError(tool: string, err: any, input: unknown): void {
  log('error', {
    type: 'tool_error',
    tool,
    input,
    error: (err && err.message) || String(err),
  });
}


