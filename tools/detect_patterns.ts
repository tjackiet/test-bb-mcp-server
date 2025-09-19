import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema, PatternTypeEnum } from '../src/schemas.js';

type DetectIn = typeof DetectPatternsInputSchema extends { _type: infer T } ? T : any;

export default async function detectPatterns(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 90,
  opts: Partial<{ swingDepth: number; tolerancePct: number; minBarsBetweenSwings: number; patterns: Array<typeof PatternTypeEnum._type> }> = {}
) {
  try {
    const swingDepth = opts.swingDepth ?? 3;
    const tolerancePct = opts.tolerancePct ?? 0.02;
    const minDist = opts.minBarsBetweenSwings ?? 3;
    const want = new Set(opts.patterns || []);

    const res = await getIndicators(pair, type as any, limit);
    if (!res?.ok) return DetectPatternsOutputSchema.parse(fail(res.summary || 'failed', 'internal')) as any;

    const candles = res.data.chart.candles as Array<{ close: number; isoTime?: string }>;
    if (!Array.isArray(candles) || candles.length < 20) {
      return DetectPatternsOutputSchema.parse(ok('insufficient data', { patterns: [] }, { pair, type, count: 0 })) as any;
    }

    // 1) Swing points (simple local extrema)
    const prices = candles.map(c => c.close);
    const pivots: Array<{ idx: number; price: number; kind: 'H' | 'L' }> = [];
    for (let i = swingDepth; i < prices.length - swingDepth; i++) {
      const p = prices[i];
      let isHigh = true, isLow = true;
      for (let k = 1; k <= swingDepth; k++) {
        if (!(p > prices[i - k] && p > prices[i + k])) isHigh = false;
        if (!(p < prices[i - k] && p < prices[i + k])) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) pivots.push({ idx: i, price: p, kind: 'H' });
      else if (isLow) pivots.push({ idx: i, price: p, kind: 'L' });
    }

    // helper
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tolerancePct;
    const push = (arr: any[], item: any) => { arr.push(item); };

    const patterns: any[] = [];

    // 2) Double top/bottom
    if (want.size === 0 || want.has('double_top') || want.has('double_bottom')) {
      for (let i = 0; i < pivots.length - 3; i++) {
        const a = pivots[i];
        const b = pivots[i + 1];
        const c = pivots[i + 2];
        if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
        // double top: H-L-H with H~H
        if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H' && near(a.price, c.price)) {
          const start = candles[a.idx].isoTime || String(a.idx);
          const end = candles[c.idx].isoTime || String(c.idx);
          push(patterns, { type: 'double_top', confidence: 0.65, range: { start, end }, pivots: [a, b, c] });
        }
        // double bottom: L-H-L with L~L
        if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L' && near(a.price, c.price)) {
          const start = candles[a.idx].isoTime || String(a.idx);
          const end = candles[c.idx].isoTime || String(c.idx);
          push(patterns, { type: 'double_bottom', confidence: 0.65, range: { start, end }, pivots: [a, b, c] });
        }
      }
    }

    // 3) Inverse H&S (L-H-L-H-L with head lower than both shoulders)
    if (want.size === 0 || want.has('inverse_head_and_shoulders')) {
      for (let i = 0; i < pivots.length - 4; i++) {
        const p0 = pivots[i], p1 = pivots[i + 1], p2 = pivots[i + 2], p3 = pivots[i + 3], p4 = pivots[i + 4];
        if (!(p0.kind === 'L' && p1.kind === 'H' && p2.kind === 'L' && p3.kind === 'H' && p4.kind === 'L')) continue;
        if (p1.idx - p0.idx < minDist || p2.idx - p1.idx < minDist || p3.idx - p2.idx < minDist || p4.idx - p3.idx < minDist) continue;
        const shouldersNear = near(p0.price, p4.price);
        const headLower = p2.price < Math.min(p0.price, p4.price) * (1 - tolerancePct);
        if (shouldersNear && headLower) {
          const start = candles[p0.idx].isoTime || String(p0.idx);
          const end = candles[p4.idx].isoTime || String(p4.idx);
          push(patterns, { type: 'inverse_head_and_shoulders', confidence: 0.7, range: { start, end }, pivots: [p0, p1, p2, p3, p4] });
        }
      }
    }

    const out = ok('patterns detected', { patterns }, { pair, type, count: patterns.length });
    return DetectPatternsOutputSchema.parse(out) as any;
  } catch (e: any) {
    return DetectPatternsOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


