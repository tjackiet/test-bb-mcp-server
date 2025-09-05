// lib/logger.js
import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
// level優先度
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESH = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function log(level, event) {
  if ((LEVELS[level] ?? 2) > THRESH) return;
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const file = path.join(LOG_DIR, `${date}.jsonl`);
  const record = { ts: new Date().toISOString(), level, ...event };
  try {
    writeJsonl(file, record);
  } catch (_) {
    // best-effort: ログ失敗は握りつぶす
  }
}

// ツール実行用のショートハンド
export function logToolRun({ tool, input, result, ms }) {
  // raw が巨大化しないように要点だけ
  const safeData = {
    ok: result?.ok,
    summary: result?.summary,
    meta: result?.meta,
  };
  log('info', { type: 'tool_run', tool, input, ms, result: safeData });
}

export function logError(tool, err, input) {
  log('error', {
    type: 'tool_error',
    tool,
    input,
    error: (err && err.message) || String(err),
  });
}
