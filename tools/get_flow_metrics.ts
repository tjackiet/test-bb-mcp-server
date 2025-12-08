import getTransactions from './get_transactions.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { getErrorMessage } from '../lib/error.js';
import { GetFlowMetricsOutputSchema } from '../src/schemas.js';

type Tx = { price: number; amount: number; side: 'buy' | 'sell'; timestampMs: number; isoTime: string };

function toIsoWithTz(ts: number, tz: string) {
  try { return new Date(ts).toLocaleString('sv-SE', { timeZone: tz, hour12: false }).replace(' ', 'T'); } catch { return null; }
}
function toDisplayTime(ts: number, tz: string) {
  try {
    const d = new Date(ts);
    const time = d.toLocaleTimeString('ja-JP', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = d.toLocaleDateString('ja-JP', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const tzShort = tz === 'UTC' ? 'UTC' : 'JST';
    return `${date} ${time} ${tzShort}`;
  } catch { return null; }
}

export default async function getFlowMetrics(
  pair: string = 'btc_jpy',
  limit: number = 100,
  date?: string,
  bucketMs: number = 60_000,
  tz: string = 'Asia/Tokyo'
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return GetFlowMetricsOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;
  const lim = validateLimit(limit, 1, 2000);
  if (!lim.ok) return GetFlowMetricsOutputSchema.parse(fail(lim.error.message, lim.error.type)) as any;

  try {
    const txRes: any = await getTransactions(chk.pair, lim.value, date);
    if (!txRes?.ok) return GetFlowMetricsOutputSchema.parse(fail(txRes?.summary || 'failed', (txRes?.meta as any)?.errorType || 'internal')) as any;
    const txs: Tx[] = txRes.data.normalized as Tx[];
    if (!Array.isArray(txs) || txs.length === 0) {
      return GetFlowMetricsOutputSchema.parse(ok('no transactions', {
        source: 'transactions',
        params: { bucketMs },
        aggregates: {
          totalTrades: 0,
          buyTrades: 0,
          sellTrades: 0,
          buyVolume: 0,
          sellVolume: 0,
          netVolume: 0,
          aggressorRatio: 0,
          finalCvd: 0,
        },
        series: { buckets: [] },
      }, createMeta(chk.pair, { count: 0, bucketMs }))) as any;
    }

    // バケット分割
    const t0 = txs[0].timestampMs;
    const buckets: Array<{ ts: number; buys: number; sells: number; vBuy: number; vSell: number }> = [];
    const idx = (ms: number) => Math.floor((ms - t0) / bucketMs);
    for (const t of txs) {
      const k = idx(t.timestampMs);
      while (buckets.length <= k) buckets.push({ ts: t0 + buckets.length * bucketMs, buys: 0, sells: 0, vBuy: 0, vSell: 0 });
      if (t.side === 'buy') { buckets[k].buys++; buckets[k].vBuy += t.amount; }
      else { buckets[k].sells++; buckets[k].vSell += t.amount; }
    }

    // CVD とスパイク
    const outBuckets: Array<{ timestampMs: number; isoTime: string; isoTimeJST?: string; displayTime?: string; buyVolume: number; sellVolume: number; totalVolume: number; cvd: number; zscore: number | null; spike: 'notice' | 'warning' | 'strong' | null }>
      = [];
    let cvd = 0;
    const vols = buckets.map(b => b.vBuy + b.vSell);
    const mean = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const variance = vols.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / Math.max(1, vols.length);
    const stdev = Math.sqrt(variance);
    const spikeLevel = (z: number): 'notice' | 'warning' | 'strong' | null => {
      if (!Number.isFinite(z)) return null;
      if (z >= 3) return 'strong';
      if (z >= 2) return 'warning';
      if (z >= 1.5) return 'notice';
      return null;
    };

    for (const b of buckets) {
      const vol = b.vBuy + b.vSell;
      cvd += b.vBuy - b.vSell;
      const z = stdev > 0 ? (vol - mean) / stdev : 0;
      const ts = b.ts + bucketMs - 1;
      outBuckets.push({
        timestampMs: ts,
        isoTime: new Date(ts).toISOString(),
        isoTimeJST: toIsoWithTz(ts, tz) ?? undefined,
        displayTime: toDisplayTime(ts, tz) ?? undefined,
        buyVolume: Number(b.vBuy.toFixed(8)),
        sellVolume: Number(b.vSell.toFixed(8)),
        totalVolume: Number(vol.toFixed(8)),
        cvd: Number(cvd.toFixed(8)),
        zscore: Number.isFinite(z) ? Number(z.toFixed(2)) : null,
        spike: spikeLevel(z),
      });
    }

    const totalTrades = txs.length;
    const buyTrades = txs.filter(t => t.side === 'buy').length;
    const sellTrades = totalTrades - buyTrades;
    const buyVolume = txs.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
    const sellVolume = txs.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
    const netVolume = buyVolume - sellVolume;
    const aggressorRatio = totalTrades > 0 ? Number((buyTrades / totalTrades).toFixed(3)) : 0;

    const summary = formatSummary({
      pair: chk.pair,
      latest: txs.at(-1)?.price,
      extra: `trades=${totalTrades} buy%=${(aggressorRatio * 100).toFixed(1)} CVD=${cvd.toFixed(2)}`,
    });

    const data = {
      source: 'transactions' as const,
      params: { bucketMs },
      aggregates: {
        totalTrades,
        buyTrades,
        sellTrades,
        buyVolume: Number(buyVolume.toFixed(8)),
        sellVolume: Number(sellVolume.toFixed(8)),
        netVolume: Number(netVolume.toFixed(8)),
        aggressorRatio,
        finalCvd: Number(cvd.toFixed(8)),
      },
      series: { buckets: outBuckets },
    };

    const offsetMin = -new Date().getTimezoneOffset();
    const offset = `${offsetMin >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMin) % 60).padStart(2, '0')}`;
    const meta = createMeta(chk.pair, { count: totalTrades, bucketMs, timezone: tz, timezoneOffset: offset, serverTime: toIsoWithTz(Date.now(), tz) ?? undefined });
    return GetFlowMetricsOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: unknown) {
    return GetFlowMetricsOutputSchema.parse(fail(getErrorMessage(e) || 'internal error', 'internal')) as any;
  }
}



