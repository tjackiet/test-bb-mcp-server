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

export default async function getOrderbookPressure(pair: string = 'btc_jpy', delayMs: number = 1000, bandsPct: number[] = [0.001, 0.005, 0.01]) {
  const chk = ensurePair(pair);
  if (!chk.ok) return GetOrderbookPressureOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  try {
    // 前後2回のスナップショットから帯域内のネットΔを推計
    const a: any = await getDepth(chk.pair, { maxLevels: 200 });
    if (!a?.ok) return GetOrderbookPressureOutputSchema.parse(fail(a?.summary || 'failed', (a?.meta as any)?.errorType || 'internal')) as any;
    await new Promise((r) => setTimeout(r, Math.max(100, delayMs)));
    const b: any = await getDepth(chk.pair, { maxLevels: 200 });
    if (!b?.ok) return GetOrderbookPressureOutputSchema.parse(fail(b?.summary || 'failed', (b?.meta as any)?.errorType || 'internal')) as any;

    const mid0 = midFromDepth(a.data.asks as SideLevels, a.data.bids as SideLevels);
    const mid1 = midFromDepth(b.data.asks as SideLevels, b.data.bids as SideLevels);
    const baseMid = mid1 ?? mid0;

    function sumInBand(levels: SideLevels, low: number, high: number) {
      let s = 0;
      for (const [p, q] of levels) {
        const price = Number(p), qty = Number(q);
        if (Number.isFinite(price) && Number.isFinite(qty) && price >= low && price <= high) s += qty;
      }
      return s;
    }

    const bands = bandsPct.map((w) => {
      if (!Number.isFinite(baseMid as any)) {
        return { widthPct: w, baseMid: null, baseBidSize: 0, baseAskSize: 0, bidDelta: 0, askDelta: 0, netDelta: 0, netDeltaPct: null as number | null, tag: null as any };
      }
      const wAbs = (baseMid as number) * w;
      const bidLow = (baseMid as number) * (1 - w);
      const bidHigh = baseMid as number;
      const askLow = baseMid as number;
      const askHigh = (baseMid as number) * (1 + w);

      const baseBid = sumInBand(a.data.bids as SideLevels, bidLow, bidHigh);
      const baseAsk = sumInBand(a.data.asks as SideLevels, askLow, askHigh);
      const nowBid = sumInBand(b.data.bids as SideLevels, bidLow, bidHigh);
      const nowAsk = sumInBand(b.data.asks as SideLevels, askLow, askHigh);

      const bidDelta = Number((nowBid - baseBid).toFixed(8));
      const askDelta = Number((nowAsk - baseAsk).toFixed(8));
      const netDelta = Number((bidDelta - askDelta).toFixed(8));
      const netDeltaPct = (baseBid + baseAsk) > 0 ? Number((netDelta / (baseBid + baseAsk)).toFixed(4)) : null;

      const absZ = (() => {
        // 簡易タグ付け: パーセンタイル相当の擬似z（閾値固定）
        const v = Math.abs(netDeltaPct ?? 0);
        if (v >= 0.2) return 3; // strong 相当
        if (v >= 0.1) return 2; // warning
        if (v >= 0.05) return 1.5; // notice
        return 0;
      })();
      const tag = absZ >= 3 ? 'strong' : absZ >= 2 ? 'warning' : absZ >= 1.5 ? 'notice' : null;

      return { widthPct: w, baseMid: baseMid as number, baseBidSize: Number(baseBid.toFixed(8)), baseAskSize: Number(baseAsk.toFixed(8)), bidDelta, askDelta, netDelta, netDeltaPct, tag };
    });

    const strongestTag = ((): 'notice' | 'warning' | 'strong' | null => {
      if (bands.some((b: any) => b.tag === 'strong')) return 'strong';
      if (bands.some((b: any) => b.tag === 'warning')) return 'warning';
      if (bands.some((b: any) => b.tag === 'notice')) return 'notice';
      return null;
    })();

    const summary = formatSummary({ pair: chk.pair, latest: baseMid ?? undefined, extra: `bands=${bandsPct.join(',')}; tag=${strongestTag ?? 'none'}` });
    const data = { bands, aggregates: { netDelta: Number(bands.reduce((s: number, b: any) => s + b.netDelta, 0).toFixed(8)), strongestTag } };
    const meta = createMeta(chk.pair, { delayMs });
    return GetOrderbookPressureOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: any) {
    return GetOrderbookPressureOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


