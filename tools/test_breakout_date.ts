import detectPatterns from './detect_patterns.js';
import getIndicators from './get_indicators.js';

async function test() {
  // 11/2 開始のパターンを確認
  const result = await detectPatterns('btc_jpy', '1day', 180, {
    patterns: ['falling_wedge']
  });
  
  if (!result.ok) { console.error('Error'); return; }
  
  const target = result.data.patterns.find((p: any) => p.range.start.startsWith('2025-11-02'));
  
  if (target) {
    console.log('=== 11/2 開始のパターン ===');
    console.log(`期間: ${target.range.start.substring(0,10)} ~ ${target.range.end.substring(0,10)}`);
    console.log(`status: ${target.status}`);
    console.log(`breakoutDirection: ${target.breakoutDirection}`);
    console.log(`outcome: ${target.outcome}`);
  }
  
  // 11/26 と 11/27 の価格を確認
  const ind = await getIndicators('btc_jpy', '1day', 180);
  if (!ind.ok) return;
  
  const candles = ind.data.chart?.candles;
  if (!candles) return;
  
  console.log('\n=== 11/26 と 11/27 の価格 ===');
  for (const date of ['2025-11-26', '2025-11-27']) {
    const c = candles.find((c: any) => c.isoTime?.startsWith(date));
    if (c) {
      console.log(`${date}: open=${c.open}, close=${c.close}, high=${c.high}, low=${c.low}`);
    }
  }
}
test();
