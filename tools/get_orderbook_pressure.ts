import getDepth from './get_depth.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { GetOrderbookPressureOutputSchema } from '../src/schemas.js';

type SideLevels = Array<[string, string]>; // [price, size]

function midFromDepth(asks: SideLevels, bids: SideLevels): number | null {
  const bestAsk = Number(asks?.[0]?.[0] ?? NaN);
  const bestBid = Number(bids?.[0]?.[0] ?? NaN);
  if (!Number.isFinite(bestAsk) || !Number.isFinite(bestBid)) return null;
  return (bestAsk + bestBid) / 2;
}

export default async function getOrderbookPressure(pair: string = 'btc_jpy', _delayMs: number = 0, bandsPct: number[] = [0.001, 0.005, 0.01]) {
  const chk = ensurePair(pair);
  if (!chk.ok) return GetOrderbookPressureOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  try {
    // 単一スナップショットから帯域内の厚みを評価（静的）
    const snap: any = await getDepth(chk.pair, { maxLevels: 200 });
    if (!snap?.ok) return GetOrderbookPressureOutputSchema.parse(fail(snap?.summary || 'failed', (snap?.meta as any)?.errorType || 'internal')) as any;

    const asks = snap.data.asks as SideLevels;
    const bids = snap.data.bids as SideLevels;
    const baseMid = midFromDepth(asks, bids);

    function sumInBand(levels: SideLevels, low: number, high: number) {
      let s = 0;
      for (const [p, q] of levels) {
        const price = Number(p), qty = Number(q);
        if (Number.isFinite(price) && Number.isFinite(qty) && price >= low && price <= high) s += qty;
      }
      return s;
    }

    const eps = 1e-9;
    const bands = bandsPct.map((w) => {
      if (!Number.isFinite(baseMid as any)) {
        return { widthPct: w, baseMid: null, baseBidSize: 0, baseAskSize: 0, bidDelta: 0, askDelta: 0, netDelta: 0, netDeltaPct: null as number | null, tag: null as any };
      }
      const bidLow = (baseMid as number) * (1 - w);
      const bidHigh = baseMid as number;
      const askLow = baseMid as number;
      const askHigh = (baseMid as number) * (1 + w);

      const buyVol = sumInBand(bids, bidLow, bidHigh);
      const sellVol = sumInBand(asks, askLow, askHigh);

      const net = Number((buyVol - sellVol).toFixed(8));
      const pressure = Number(((buyVol - sellVol) / (buyVol + sellVol + eps)).toFixed(4));

      const absZ = (() => {
        // 簡易タグ付け: パーセンタイル相当の擬似z（閾値固定）
        const v = Math.abs(pressure ?? 0);
        if (v >= 0.2) return 3; // strong 相当
        if (v >= 0.1) return 2; // warning
        if (v >= 0.05) return 1.5; // notice
        return 0;
      })();
      const tag = absZ >= 3 ? 'strong' : absZ >= 2 ? 'warning' : absZ >= 1.5 ? 'notice' : null;

      // 互換のためフィールド名は従来を流用
      return {
        widthPct: w,
        baseMid: baseMid as number,
        baseBidSize: Number(buyVol.toFixed(8)),
        baseAskSize: Number(sellVol.toFixed(8)),
        bidDelta: Number(buyVol.toFixed(8)),
        askDelta: Number((-sellVol).toFixed(8)),
        netDelta: net,
        netDeltaPct: pressure,
        tag,
      };
    });

    const strongestTag = ((): 'notice' | 'warning' | 'strong' | null => {
      if (bands.some((b: any) => b.tag === 'strong')) return 'strong';
      if (bands.some((b: any) => b.tag === 'warning')) return 'warning';
      if (bands.some((b: any) => b.tag === 'notice')) return 'notice';
      return null;
    })();

    const summary = formatSummary({ pair: chk.pair, latest: baseMid ?? undefined, extra: `bands=${bandsPct.join(',')}; tag=${strongestTag ?? 'none'}` });
    const data = { bands, aggregates: { netDelta: Number(bands.reduce((s: number, b: any) => s + b.netDelta, 0).toFixed(8)), strongestTag } };
    const meta = createMeta(chk.pair, { delayMs: 0 });
    return GetOrderbookPressureOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: any) {
    return GetOrderbookPressureOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


