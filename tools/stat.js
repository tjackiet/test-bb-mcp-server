// tools/stat.js
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const LOG_DIR = process.env.LOG_DIR || './logs';

function parseDuration(durationStr) {
  if (!durationStr) return null;
  const match = durationStr.match(/^(\d+)([dhms])$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case 'd':
      now.setDate(now.getDate() - value);
      break;
    case 'h':
      now.setHours(now.getHours() - value);
      break;
    case 'm':
      now.setMinutes(now.getMinutes() - value);
      break;
    case 's':
      now.setSeconds(now.getSeconds() - value);
      break;
  }
  return now;
}

async function processLogFile(filePath, stats, startTime) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    try {
      const log = JSON.parse(line);

      // 期間フィルタ
      if (startTime && new Date(log.ts) < startTime) {
        continue;
      }

      // tool_run イベントのみを集計対象とする
      if (log.type !== 'tool_run') continue;

      stats.total++;
      if (log.result?.ok) {
        stats.success++;
      } else {
        stats.fail++;
        const errorType = log.result?.meta?.errorType || 'unknown';
        stats.errorTypes[errorType] = (stats.errorTypes[errorType] || 0) + 1;
      }

      if (typeof log.ms === 'number') {
        stats.durations.push(log.ms);
      }
    } catch (e) {
      // JSONパースエラーは無視
    }
  }
}

async function run() {
  const args = process.argv.slice(2);
  const lastFlagIndex = args.indexOf('--last');
  const durationStr = lastFlagIndex !== -1 ? args[lastFlagIndex + 1] : null;
  const startTime = parseDuration(durationStr);

  if (lastFlagIndex !== -1 && !startTime) {
    console.error(`Error: Invalid duration format '${durationStr}'. Use format like '7d', '24h', '30m'.`);
    process.exit(1);
  }

  if (!fs.existsSync(LOG_DIR)) {
    console.error(`Error: Log directory not found at '${LOG_DIR}'`);
    process.exit(1);
  }

  const stats = {
    total: 0,
    success: 0,
    fail: 0,
    durations: [],
    errorTypes: {},
  };

  try {
    const files = await fs.promises.readdir(LOG_DIR);
    const logFiles = files.filter((f) => f.endsWith('.jsonl'));

    if (logFiles.length === 0) {
      console.log('No log files found.');
      return;
    }

    console.log(`Processing ${logFiles.length} log file(s)...`);

    for (const file of logFiles) {
      const filePath = path.join(LOG_DIR, file);
      await processLogFile(filePath, stats, startTime);
    }

    // 集計結果の表示
    const errRate =
      stats.total > 0 ? (stats.fail / stats.total) * 100 : 0;
    const avgDuration =
      stats.durations.length > 0
        ? stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length
        : 0;
    const maxDuration =
      stats.durations.length > 0 ? Math.max(...stats.durations) : 0;
    const minDuration =
      stats.durations.length > 0 ? Math.min(...stats.durations) : 0;

    let errorSummary = 'N/A';
    if (stats.fail > 0) {
      errorSummary = Object.entries(stats.errorTypes)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ');
    }

    const durationInfo = startTime ? ` (last ${durationStr})` : '';

    console.log(`
--- Log Statistics${durationInfo} ---
Total Runs:   ${stats.total}
Success:      ${stats.success}
Failure:      ${stats.fail}
Error Rate:   ${errRate.toFixed(2)}%
Error Types:  ${errorSummary}

--- Processing Time (ms) ---
Average:      ${avgDuration.toFixed(2)} ms
Min:          ${minDuration.toFixed(2)} ms
Max:          ${maxDuration.toFixed(2)} ms
--------------------
    `);
  } catch (err) {
    console.error('Failed to process logs:', err);
    process.exit(1);
  }
}

run();
