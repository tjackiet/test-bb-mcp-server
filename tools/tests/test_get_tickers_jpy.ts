import getTickersJpy from '../get_tickers_jpy.js';

async function testSuccessFromNetwork() {
  process.env.TICKERS_JPY_URL = 'https://public.bitbank.cc/tickers_jpy';
  const res = await getTickersJpy({ bypassCache: true });
  if (!(res as any)?.ok) throw new Error('ok=false on network');
}

async function testSuccessFromFile() {
  process.env.TICKERS_JPY_URL = 'file://tools/tests/fixtures/tickers_jpy_sample.json';
  const res = await getTickersJpy({ bypassCache: true });
  if (!(res as any)?.ok) throw new Error('ok=false on file');
}

async function testTimeout() {
  process.env.TICKERS_JPY_URL = 'about:timeout';
  process.env.TICKERS_JPY_TIMEOUT_MS = '50';
  process.env.TICKERS_JPY_RETRIES = '0';
  const res = await getTickersJpy({ bypassCache: true });
  if ((res as any)?.ok) throw new Error('expected timeout fail');
}

async function testCacheFallbackAfterFailure() {
  // 1) seed cache from file
  process.env.TICKERS_JPY_URL = 'file://tools/tests/fixtures/tickers_jpy_sample.json';
  const ok1 = await getTickersJpy({ bypassCache: true });
  if (!(ok1 as any)?.ok) throw new Error('seed cache failed');
  // 2) simulate failure but allow cache usage
  process.env.TICKERS_JPY_URL = 'about:timeout';
  process.env.TICKERS_JPY_TIMEOUT_MS = '10';
  process.env.TICKERS_JPY_RETRIES = '0';
  const res = await getTickersJpy({ bypassCache: false });
  if (!(res as any)?.ok) throw new Error('expected cache fallback success');
}

async function main() {
  try {
    await testSuccessFromFile();
    await testTimeout();
    await testCacheFallbackAfterFailure();
    // network test is optional in CI-less local run; skip if offline
    try { await testSuccessFromNetwork(); } catch { /* ignore */ }
    console.log('PASS: tests completed');
  } catch (e) {
    console.error('FAIL:', e);
    process.exit(1);
  }
}

main();


