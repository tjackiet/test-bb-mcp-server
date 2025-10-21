import { ok, fail } from '../lib/result.js';
import fs from 'fs';
import path from 'path';
import { GetTickersJpyOutputSchema } from '../src/schemas.js';

type Item = { pair: string; sell: string; buy: string; high: string; low: string; open: string; last: string; vol: string; timestamp: number };

const CACHE_TTL_MS = 10_000;
let cache: { ts: number; data: Item[] } | null = null;

export default async function getTickersJpy(opts?: { bypassCache?: boolean }) {
  const now = Date.now();
  if (!opts?.bypassCache && cache && now - cache.ts < CACHE_TTL_MS) {
    return GetTickersJpyOutputSchema.parse(
      ok('tickers_jpy (cache)', cache.data, { cache: { hit: true, key: 'tickers_jpy' }, ts: new Date().toISOString() })
    );
  }

  const url = String(process.env.TICKERS_JPY_URL || 'https://public.bitbank.cc/tickers_jpy');
  const timeoutMs = Number(process.env.TICKERS_JPY_TIMEOUT_MS ?? 2000);
  const retries = Number(process.env.TICKERS_JPY_RETRIES ?? 1);
  const retryWaitMs = Number(process.env.TICKERS_JPY_RETRY_WAIT_MS ?? 500);
  const t0 = Date.now();
  try {
    // テスト用: about:timeout を指定すると擬似タイムアウト
    if (url === 'about:timeout') {
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs + 10, 1000)));
      throw new Error('AbortError: simulated timeout');
    }

    // テスト用: file:// を指定するとローカルJSONを読み込む
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
      const buf = fs.readFileSync(abs, 'utf8');
      const raw = JSON.parse(buf);
      if (!raw || raw.success !== 1 || !Array.isArray(raw.data)) {
        return GetTickersJpyOutputSchema.parse(fail(`UPSTREAM_ERROR ${JSON.stringify(raw?.data ?? raw)}`, 'upstream'));
      }
      const data: Item[] = raw.data as Item[];
      cache = { ts: now, data };
      const ms = Date.now() - t0;
      const payloadBytes = Buffer.byteLength(JSON.stringify(data));
      return GetTickersJpyOutputSchema.parse(
        ok(
          `tickers_jpy fetched in ${ms}ms (${data.length} items, ${payloadBytes} bytes)`,
          data,
          { cache: { hit: false, key: 'tickers_jpy' }, ts: new Date().toISOString(), latencyMs: ms, payloadBytes }
        )
      );
    }

    // 固定バックオフでの簡易リトライ
    let lastErr: any;
    let raw: any;
    for (let i = 0; i <= retries; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
        break;
      } catch (e: any) {
        clearTimeout(t);
        lastErr = e;
        if (i < retries) await new Promise((r) => setTimeout(r, retryWaitMs));
      }
    }
    if (!raw) throw lastErr || new Error('no response');
    if (!raw || raw.success !== 1 || !Array.isArray(raw.data)) {
      return GetTickersJpyOutputSchema.parse(fail(`UPSTREAM_ERROR ${JSON.stringify(raw?.data ?? raw)}`, 'upstream'));
    }
    const data: Item[] = raw.data as Item[];
    cache = { ts: now, data };
    const ms = Date.now() - t0;
    const payloadBytes = Buffer.byteLength(JSON.stringify(data));
    // ロギングはサーバ側集約。ここではsummaryに最小指標を含める
    return GetTickersJpyOutputSchema.parse(
      ok(
        `tickers_jpy fetched in ${ms}ms (${data.length} items, ${payloadBytes} bytes)`,
        data,
        { cache: { hit: false, key: 'tickers_jpy' }, ts: new Date().toISOString(), latencyMs: ms, payloadBytes }
      )
    );
  } catch (e: any) {
    const msg = e?.message || 'network error';
    const isTimeout = msg.includes('AbortError') || msg.includes('timeout');
    return GetTickersJpyOutputSchema.parse(fail(isTimeout ? `TIMEOUT_OR_NETWORK` : `UPSTREAM_${msg}`, isTimeout ? 'timeout' : 'upstream'));
  }
}


