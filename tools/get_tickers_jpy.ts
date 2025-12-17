import { ok, fail } from '../lib/result.js';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '../lib/error.js';
import { BITBANK_API_BASE } from '../lib/http.js';
import { ALLOWED_PAIRS } from '../lib/validate.js';
import { GetTickersJpyOutputSchema } from '../src/schemas.js';

type Item = { pair: string; sell: string; buy: string; high: string; low: string; open: string; last: string; vol: string; timestamp: number };

const CACHE_TTL_MS = 10_000;
let cache: { ts: number; data: Item[] } | null = null;

// === Auto mode (official pairs sync) ===
let dynamicPairs: Set<string> | null = null;
let dynamicPairsFetchedAt = 0;
const PAIRS_TTL_MS = Number(process.env.BITBANK_PAIRS_TTL_MS ?? 15 * 60 * 1000); // 15min
type PairsMode = 'strict' | 'auto' | 'off';
function getPairsMode(): PairsMode {
  // Back-compat: BITBANK_STRICT_PAIRS=0 → off
  const strictEnv = String(process.env.BITBANK_STRICT_PAIRS ?? '1');
  if (strictEnv === '0') return 'off';
  const mode = String(process.env.BITBANK_PAIRS_MODE || 'strict').toLowerCase();
  if (mode === 'auto') return 'auto';
  if (mode === 'off') return 'off';
  return 'strict';
}
async function fetchOfficialJpyPairs(timeoutMs: number, retries: number, retryWaitMs: number): Promise<Set<string>> {
  const officialUrl = `${BITBANK_API_BASE}/tickers_jpy`;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(officialUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json() as any;
      if (!raw || raw.success !== 1 || !Array.isArray(raw.data)) throw new Error('bad payload');
      const set = new Set<string>();
      for (const it of raw.data as any[]) {
        const p = String(it?.pair || '').toLowerCase();
        if (p.endsWith('_jpy')) set.add(p);
      }
      return set;
    } catch (e: unknown) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, retryWaitMs));
    }
  }
  throw lastErr ?? new Error('pairs fetch failed');
}
async function getFilterSet(timeoutMs: number, retries: number, retryWaitMs: number): Promise<{ mode: PairsMode; set: Set<string> | null; source: 'dynamic' | 'static' | 'off' }> {
  const mode = getPairsMode();
  if (mode === 'off') return { mode, set: null, source: 'off' };
  if (mode === 'strict') return { mode, set: ALLOWED_PAIRS as Set<string>, source: 'static' };
  // auto
  const now = Date.now();
  const stillFresh = dynamicPairs && (now - dynamicPairsFetchedAt) < PAIRS_TTL_MS;
  if (!stillFresh) {
    try {
      dynamicPairs = await fetchOfficialJpyPairs(timeoutMs, retries, retryWaitMs);
      dynamicPairsFetchedAt = now;
    } catch {
      // keep previous dynamic or fall back to static
      if (!dynamicPairs || dynamicPairs.size === 0) {
        return { mode, set: ALLOWED_PAIRS as Set<string>, source: 'static' };
      }
    }
  }
  return { mode, set: dynamicPairs!, source: 'dynamic' };
}
async function filterByMode(items: Item[], timeoutMs: number, retries: number, retryWaitMs: number): Promise<{ data: Item[]; filterInfo: { mode: PairsMode; source: 'dynamic' | 'static' | 'off'; setSize: number } }> {
  const { mode, set, source } = await getFilterSet(timeoutMs, retries, retryWaitMs);
  if (!set) return { data: items, filterInfo: { mode, source, setSize: 0 } };
  const out = items.filter((it) => set.has(String(it.pair).toLowerCase()));
  return { data: out, filterInfo: { mode, source, setSize: set.size } };
}

export default async function getTickersJpy(opts?: { bypassCache?: boolean }) {
  const now = Date.now();
  if (!opts?.bypassCache && cache && now - cache.ts < CACHE_TTL_MS) {
    return GetTickersJpyOutputSchema.parse(
      ok('tickers_jpy (cache)', cache.data, { cache: { hit: true, key: 'tickers_jpy' }, ts: new Date().toISOString() })
    );
  }

  const url = String(process.env.TICKERS_JPY_URL || `${BITBANK_API_BASE}/tickers_jpy`);
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
      const dataRaw: Item[] = raw.data as Item[];
      const { data: filtered, filterInfo } = await filterByMode(dataRaw, timeoutMs, retries, retryWaitMs);
      // 24h変動率を open/last から算出（%）
      const data: Item[] = filtered.map((it) => {
        const openN = Number(it.open);
        const lastN = Number(it.last);
        const change = Number.isFinite(openN) && openN > 0 && Number.isFinite(lastN)
          ? Number((((lastN - openN) / openN) * 100).toFixed(2))
          : null;
        return { ...it, change24h: change as any, change24hPct: change as any } as Item & { change24h?: number; change24hPct?: number };
      });
      cache = { ts: now, data };
      const ms = Date.now() - t0;
      const payloadBytes = Buffer.byteLength(JSON.stringify(dataRaw));
      return GetTickersJpyOutputSchema.parse(
        ok(
          `tickers_jpy fetched in ${ms}ms (${data.length}/${dataRaw.length} items after filter, ${payloadBytes} bytes raw, mode=${filterInfo.mode}/${filterInfo.source})`,
          data,
          { cache: { hit: false, key: 'tickers_jpy' }, ts: new Date().toISOString(), latencyMs: ms, payloadBytes }
        )
      );
    }

    // 固定バックオフでの簡易リトライ
    let lastErr: unknown;
    let raw: { success?: number; data?: Item[] } | undefined;
    for (let i = 0; i <= retries; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json() as { success?: number; data?: Item[] };
        break;
      } catch (e: unknown) {
        clearTimeout(t);
        lastErr = e;
        if (i < retries) await new Promise((r) => setTimeout(r, retryWaitMs));
      }
    }
    if (!raw) throw lastErr ?? new Error('no response');
    if (!raw || raw.success !== 1 || !Array.isArray(raw.data)) {
      return GetTickersJpyOutputSchema.parse(fail(`UPSTREAM_ERROR ${JSON.stringify(raw?.data ?? raw)}`, 'upstream'));
    }
    const dataRaw: Item[] = raw.data as Item[];
    const { data: filtered, filterInfo } = await filterByMode(dataRaw, timeoutMs, retries, retryWaitMs);
    const data: Item[] = filtered.map((it) => {
      const openN = Number(it.open);
      const lastN = Number(it.last);
      const change = Number.isFinite(openN) && openN > 0 && Number.isFinite(lastN)
        ? Number((((lastN - openN) / openN) * 100).toFixed(2))
        : null;
      return { ...it, change24h: change as any, change24hPct: change as any } as Item & { change24h?: number; change24hPct?: number };
    });
    cache = { ts: now, data };
    const ms = Date.now() - t0;
    const payloadBytes = Buffer.byteLength(JSON.stringify(dataRaw));
    // ロギングはサーバ側集約。ここではsummaryに最小指標を含める
    return GetTickersJpyOutputSchema.parse(
      ok(
        `tickers_jpy fetched in ${ms}ms (${data.length}/${dataRaw.length} items after filter, ${payloadBytes} bytes raw, mode=${filterInfo.mode}/${filterInfo.source})`,
        data,
        { cache: { hit: false, key: 'tickers_jpy' }, ts: new Date().toISOString(), latencyMs: ms, payloadBytes, filtered: true }
      )
    );
  } catch (e: unknown) {
    const msg = getErrorMessage(e) || 'network error';
    const isTimeout = msg.includes('AbortError') || msg.includes('timeout');
    return GetTickersJpyOutputSchema.parse(fail(isTimeout ? `TIMEOUT_OR_NETWORK` : `UPSTREAM_${msg}`, isTimeout ? 'timeout' : 'upstream'));
  }
}


