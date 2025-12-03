#!/usr/bin/env tsx
/**
 * CLI for analyze_candle_patterns
 * Usage: 
 *   tsx tools/analyze_candle_patterns_cli.ts                    # Latest data
 *   tsx tools/analyze_candle_patterns_cli.ts 20251115           # YYYYMMDD format
 *   tsx tools/analyze_candle_patterns_cli.ts 2025-11-05         # ISO format
 */

import analyzeCandlePatterns from './analyze_candle_patterns.js';

async function main() {
  const dateArg = process.argv[2]; // YYYYMMDD, ISO, or undefined

  console.log('🕯️  Running analyze_candle_patterns...');
  if (dateArg) {
    console.log(`📅 Target date (as_of): ${dateArg}`);
  } else {
    console.log('📅 Target: Latest data');
  }
  console.log('');

  // as_of パラメータを使用（ISO形式とYYYYMMDD形式の両方を受け付け）
  const result = await analyzeCandlePatterns({
    as_of: dateArg,
  });

  if (result.ok) {
    console.log('✅ Success!\n');
    console.log('=== Summary ===');
    console.log(result.summary);
    console.log('\n=== Content ===');
    if (result.content && result.content.length > 0) {
      console.log(result.content[0].text);
    }
    console.log('\n=== Detected Patterns ===');
    console.log(JSON.stringify(result.data.recent_patterns, null, 2));
    console.log('\n=== Window Candles ===');
    console.log(JSON.stringify(result.data.window.candles, null, 2));
    console.log('\n=== Meta ===');
    console.log(JSON.stringify(result.meta, null, 2));
  } else {
    console.error('❌ Error:', result.summary);
  }
}

main().catch(console.error);

