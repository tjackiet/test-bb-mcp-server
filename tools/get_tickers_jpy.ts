import { ok, fail } from '../lib/result.js';
import fs from 'fs';
import path from 'path';
import { GetTickersJpyOutputSchema } from '../src/schemas.js';

type Item = { pair: string; sell: string; buy: string; high: string; low: string; open: string; last: string; vol: string; timestamp: number };

const CACHE_TTL_MS = 10_000;
let cache: { ts: number; data: Item[] } | null = null;

// Bitbank公式のJPY建て取扱想定ペア（不足/変更があれば適宜追加）
// 目的: 外部集約APIやモックから流入した非対応銘柄（例: FLOKI/JPY, APT/JPY など）を除去するためのフィルタ
const BITBANK_JPY_PAIRS = new Set<string>([
  'btc_jpy', 'xrp_jpy', 'eth_jpy', 'sol_jpy', 'dot_jpy', 'doge_jpy', 'ltc_jpy', 'bcc_jpy',
  'mona_jpy', 'xlm_jpy', 'qtum_jpy', 'bat_jpy', 'omg_jpy', 'xym_jpy', 'link_jpy', 'mkr_jpy',
  'boba_jpy', 'enj_jpy', 'astr_jpy', 'ada_jpy', 'avax_jpy', 'axs_jpy', 'flr_jpy', 'sand_jpy',
  'gala_jpy', 'chz_jpy', 'ape_jpy', 'oas_jpy', 'mana_jpy', 'grt_jpy', 'rndr_jpy',
  'bnb_jpy', 'dai_jpy', 'op_jpy', 'arb_jpy', 'klay_jpy', 'imx_jpy', 'mask_jpy', 'pol_jpy',
  'cyber_jpy', 'trx_jpy', 'lpt_jpy', 'atom_jpy', 'sui_jpy', 'sky_jpy', 'matic_jpy',
  // 'render_jpy' はシンボル重複の可能性があるため除外（RNDRが正）
]);

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
  const officialUrl = 'https://public.bitbank.cc/tickers_jpy';
  let lastErr: any;
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
    } catch (e: any) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, retryWaitMs));
    }
  }
  throw lastErr || new Error('pairs fetch failed');
}
async function getFilterSet(timeoutMs: number, retries: number, retryWaitMs: number): Promise<{ mode: PairsMode; set: Set<string> | null; source: 'dynamic' | 'static' | 'off' }> {
  const mode = getPairsMode();
  if (mode === 'off') return { mode, set: null, source: 'off' };
  if (mode === 'strict') return { mode, set: BITBANK_JPY_PAIRS, source: 'static' };
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
        return { mode, set: BITBANK_JPY_PAIRS, source: 'static' };
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
  } catch (e: any) {
    const msg = e?.message || 'network error';
    const isTimeout = msg.includes('AbortError') || msg.includes('timeout');
    return GetTickersJpyOutputSchema.parse(fail(isTimeout ? `TIMEOUT_OR_NETWORK` : `UPSTREAM_${msg}`, isTimeout ? 'timeout' : 'upstream'));
  }
}


