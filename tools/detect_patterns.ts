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
    // 厳しめデフォルト（誤検知を抑制）
    const swingDepth = opts.swingDepth ?? 4;
    const tolerancePct = opts.tolerancePct ?? 0.012; // 1.2%
    const minDist = opts.minBarsBetweenSwings ?? 4;
    const want = new Set(opts.patterns || []);
    // 'triangle' が指定された場合は3種を含む互換挙動
    if (want.has('triangle')) {
      want.add('triangle_ascending' as any);
      want.add('triangle_descending' as any);
      want.add('triangle_symmetrical' as any);
    }

    const res = await getIndicators(pair, type as any, limit);
    if (!res?.ok) return DetectPatternsOutputSchema.parse(fail(res.summary || 'failed', 'internal')) as any;

    const candles = res.data.chart.candles as Array<{ close: number; high: number; low: number; isoTime?: string }>;
    if (!Array.isArray(candles) || candles.length < 20) {
      return DetectPatternsOutputSchema.parse(ok('insufficient data', { patterns: [] }, { pair, type, count: 0 })) as any;
    }

    // 1) Swing points (simple local extrema) — use High/Low based pivots
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const pivots: Array<{ idx: number; price: number; kind: 'H' | 'L' }> = [];
    for (let i = swingDepth; i < candles.length - swingDepth; i++) {
      let isHigh = true, isLow = true;
      for (let k = 1; k <= swingDepth; k++) {
        if (!(highs[i] > highs[i - k] && highs[i] > highs[i + k])) isHigh = false;
        if (!(lows[i] < lows[i - k] && lows[i] < lows[i + k])) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) pivots.push({ idx: i, price: highs[i], kind: 'H' });
      else if (isLow) pivots.push({ idx: i, price: lows[i], kind: 'L' });
    }

    // helper
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tolerancePct;
    const pct = (a: number, b: number) => (b - a) / (a === 0 ? 1 : a);
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
          const start = candles[a.idx].isoTime;
          const end = candles[c.idx].isoTime;
          if (start && end) push(patterns, { type: 'double_top', confidence: 0.65, range: { start, end }, pivots: [a, b, c] });
        }
        // double bottom: L-H-L with L~L
        if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L' && near(a.price, c.price)) {
          const start = candles[a.idx].isoTime;
          const end = candles[c.idx].isoTime;
          if (start && end) push(patterns, { type: 'double_bottom', confidence: 0.65, range: { start, end }, pivots: [a, b, c] });
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
          const start = candles[p0.idx].isoTime;
          const end = candles[p4.idx].isoTime;
          if (start && end) push(patterns, { type: 'inverse_head_and_shoulders', confidence: 0.7, range: { start, end }, pivots: [p0, p1, p2, p3, p4] });
        }
      }
    }

    // 3b) Head & Shoulders (H-L-H-L-H with head higher than both shoulders)
    if (want.size === 0 || want.has('head_and_shoulders')) {
      for (let i = 0; i < pivots.length - 4; i++) {
        const p0 = pivots[i], p1 = pivots[i + 1], p2 = pivots[i + 2], p3 = pivots[i + 3], p4 = pivots[i + 4];
        if (!(p0.kind === 'H' && p1.kind === 'L' && p2.kind === 'H' && p3.kind === 'L' && p4.kind === 'H')) continue;
        if (p1.idx - p0.idx < minDist || p2.idx - p1.idx < minDist || p3.idx - p2.idx < minDist || p4.idx - p3.idx < minDist) continue;
        const shouldersNear = near(p0.price, p4.price);
        const headHigher = p2.price > Math.max(p0.price, p4.price) * (1 + tolerancePct);
        if (shouldersNear && headHigher) {
          const start = candles[p0.idx].isoTime;
          const end = candles[p4.idx].isoTime;
          if (start && end) push(patterns, { type: 'head_and_shoulders', confidence: 0.7, range: { start, end }, pivots: [p0, p1, p2, p3, p4] });
        }
      }
    }

    // 4) Triangles (ascending/descending/symmetrical)
    {
      const wantTriangle = want.size === 0 || want.has('triangle') || want.has('triangle_ascending') || want.has('triangle_descending') || want.has('triangle_symmetrical');
      if (wantTriangle) {
        const highs = pivots.filter(p => p.kind === 'H');
        const lows = pivots.filter(p => p.kind === 'L');
        const hwin = highs.slice(-5);
        const lwin = lows.slice(-5);
        if (hwin.length >= 2 && lwin.length >= 2) {
          const firstH = hwin[0], lastH = hwin[hwin.length - 1];
          const firstL = lwin[0], lastL = lwin[lwin.length - 1];
          const dH = pct(firstH.price, lastH.price);
          const dL = pct(firstL.price, lastL.price);
          const spreadStart = firstH.price - firstL.price;
          const spreadEnd = lastH.price - lastL.price;
          const converging = spreadEnd < spreadStart * (1 - tolerancePct * 0.8); // 収束条件を強化
          const startIdx = Math.min(firstH.idx, firstL.idx);
          const endIdx = Math.max(lastH.idx, lastL.idx);
          const start = candles[startIdx].isoTime;
          const end = candles[endIdx].isoTime;

          // Ascending: highs ~ flat (±0.8×tol), lows rising (≥1.2×tol)
          if (start && end) {
            if ((want.size === 0 || want.has('triangle') || want.has('triangle_ascending')) && Math.abs(dH) <= tolerancePct * 0.8 && dL >= tolerancePct * 1.2 && converging) {
              push(patterns, { type: 'triangle_ascending', confidence: 0.72, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
            }
            // Descending: lows ~ flat, highs falling
            if ((want.size === 0 || want.has('triangle') || want.has('triangle_descending')) && Math.abs(dL) <= tolerancePct * 0.8 && dH <= -tolerancePct * 1.2 && converging) {
              push(patterns, { type: 'triangle_descending', confidence: 0.72, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
            }
            // Symmetrical: highs falling and lows rising
            if ((want.size === 0 || want.has('triangle') || want.has('triangle_symmetrical')) && dH <= -tolerancePct * 1.1 && dL >= tolerancePct * 1.1 && converging) {
              push(patterns, { type: 'triangle_symmetrical', confidence: 0.7, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
            }
          }
        }
      }
    }

    // 5) Pennant & Flag (continuation after pole)
    {
      const wantPennant = want.size === 0 || want.has('pennant');
      const wantFlag = want.size === 0 || want.has('flag');
      const W = Math.min(20, candles.length);
      const closes = candles.map(c => c.close);
      const highsArr = candles.map(c => c.high);
      const lowsArr = candles.map(c => c.low);
      const M = Math.min(12, Math.max(6, Math.floor(W * 0.6))); // 旗竿計測をやや長めに
      const idxEnd = candles.length - 1;
      const idxStart = Math.max(0, idxEnd - M);
      const poleChange = pct(closes[idxStart], closes[idxEnd]);
      const poleUp = poleChange >= 0.08; // 8% 以上の強い値動き
      const poleDown = poleChange <= -0.08;
      const havePole = poleUp || poleDown;

      // Consolidation window after pole start
      const C = Math.min(14, W);
      const winStart = Math.max(0, candles.length - C);
      const hwin = highsArr.slice(winStart);
      const lwin = lowsArr.slice(winStart);
      const firstH = hwin[0];
      const lastH = hwin[hwin.length - 1];
      const firstL = lwin[0];
      const lastL = lwin[lwin.length - 1];
      const dH = pct(firstH, lastH);
      const dL = pct(firstL, lastL);
      const spreadStart = firstH - firstL;
      const spreadEnd = lastH - lastL;
      const converging = spreadEnd < spreadStart * (1 - tolerancePct * 0.8); // 収束強化

      if (havePole) {
        const start = candles[winStart].isoTime;
        const end = candles[idxEnd].isoTime;
        if (start && end) {
          // Pennant: converging (symmetrical) consolidation after strong pole
          if (wantPennant && ((dH <= 0 && dL >= 0) || (dH < 0 && dL > 0)) && converging) {
            push(patterns, { type: 'pennant', confidence: 0.68, range: { start, end } });
          }
          // Flag: parallel/slight slope against pole direction
          if (wantFlag) {
            const slopeAgainstUp = poleUp && dH < 0 && dL < 0; // both down
            const slopeAgainstDown = poleDown && dH > 0 && dL > 0; // both up
            const smallRange = spreadEnd <= spreadStart * 1.02; // 並行チャネルの厳格化
            if ((slopeAgainstUp || slopeAgainstDown) && smallRange) {
              push(patterns, { type: 'flag', confidence: 0.66, range: { start, end } });
            }
          }
        }
      }
    }

    // 6) Triple Top / Triple Bottom (厳しめの等高/等安＋等間隔に近い)
    {
      const wantTripleTop = want.size === 0 || want.has('triple_top');
      const wantTripleBottom = want.size === 0 || want.has('triple_bottom');
      if (wantTripleTop || wantTripleBottom) {
        // 直近の同種ピボット3点を走査
        const highsOnly = pivots.filter(p => p.kind === 'H');
        const lowsOnly = pivots.filter(p => p.kind === 'L');

        if (wantTripleTop && highsOnly.length >= 3) {
          for (let i = 0; i <= highsOnly.length - 3; i++) {
            const a = highsOnly[i], b = highsOnly[i + 1], c = highsOnly[i + 2];
            if ((b.idx - a.idx) < minDist || (c.idx - b.idx) < minDist) continue;
            const nearAll = near(a.price, b.price) && near(b.price, c.price) && near(a.price, c.price);
            if (!nearAll) continue;
            const start = candles[a.idx].isoTime;
            const end = candles[c.idx].isoTime;
            if (start && end) push(patterns, { type: 'triple_top', confidence: 0.68, range: { start, end }, pivots: [a, b, c] });
          }
        }

        if (wantTripleBottom && lowsOnly.length >= 3) {
          for (let i = 0; i <= lowsOnly.length - 3; i++) {
            const a = lowsOnly[i], b = lowsOnly[i + 1], c = lowsOnly[i + 2];
            if ((b.idx - a.idx) < minDist || (c.idx - b.idx) < minDist) continue;
            const nearAll = near(a.price, b.price) && near(b.price, c.price) && near(a.price, c.price);
            if (!nearAll) continue;
            const start = candles[a.idx].isoTime;
            const end = candles[c.idx].isoTime;
            if (start && end) push(patterns, { type: 'triple_bottom', confidence: 0.68, range: { start, end }, pivots: [a, b, c] });
          }
        }
      }
    }

    // overlays: パターン範囲をそのまま帯描画できるように提供
    const ranges = patterns.map((p: any) => ({ start: p.range.start, end: p.range.end, label: p.type }));
    const out = ok(
      'patterns detected',
      { patterns, overlays: { ranges } },
      { pair, type, count: patterns.length, visualization_hints: { preferred_style: 'line', highlight_patterns: patterns.map((p: any) => p.type).slice(0, 3) } }
    );
    return DetectPatternsOutputSchema.parse(out) as any;
  } catch (e: any) {
    return DetectPatternsOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


