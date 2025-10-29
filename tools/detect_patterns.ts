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
    const swingDepth = opts.swingDepth ?? 3;
    const tolerancePct = opts.tolerancePct ?? 0.025; // relaxed default 2.5%
    const minDist = opts.minBarsBetweenSwings ?? 2;
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
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    const relDev = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.max(a, b));
    const marginFromRelDev = (rd: number, tol: number) => clamp01(1 - rd / Math.max(1e-12, tol));
    const periodScoreDays = (startIso?: string, endIso?: string) => {
      if (!startIso || !endIso) return 0.7;
      const d = Math.abs(new Date(endIso).getTime() - new Date(startIso).getTime()) / 86400000;
      if (d < 5) return 0.6;
      if (d < 15) return 0.8;
      if (d < 30) return 0.9;
      return 0.7;
    };
    const finalizeConf = (base: number, type: string) => {
      const adj = (type === 'head_and_shoulders' || type === 'inverse_head_and_shoulders') ? 1.1
        : (type === 'triple_top' || type === 'triple_bottom') ? 1.05
          : (type.startsWith('triangle') || type === 'pennant' || type === 'flag') ? 0.95
            : 1.0;
      const v = Math.min(1, Math.max(0, base * adj));
      return Math.round(v * 100) / 100;
    };
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
          if (start && end) {
            // ネックライン: 中間の谷(b)の水平線を期間両端に引く
            const neckline = [
              { x: a.idx, y: b.price },
              { x: c.idx, y: b.price },
            ];
            const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolerancePct);
            const symmetry = clamp01(1 - relDev(a.price, c.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base, 'double_top');
            push(patterns, { type: 'double_top', confidence, range: { start, end }, pivots: [a, b, c], neckline });
          }
        }
        // double bottom: L-H-L with L~L
        if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L' && near(a.price, c.price)) {
          const start = candles[a.idx].isoTime;
          const end = candles[c.idx].isoTime;
          if (start && end) {
            // ネックライン: 中間の山(b)の水平線を期間両端に引く
            const neckline = [
              { x: a.idx, y: b.price },
              { x: c.idx, y: b.price },
            ];
            const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolerancePct);
            const symmetry = clamp01(1 - relDev(a.price, c.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base, 'double_bottom');
            push(patterns, { type: 'double_bottom', confidence, range: { start, end }, pivots: [a, b, c], neckline });
          }
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
          if (start && end) {
            // ネックライン: 両肩間の高値(p1, p3)を結ぶ線
            const neckline = [
              { x: p1.idx, y: p1.price },
              { x: p3.idx, y: p3.price },
            ];
            const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct);
            const symmetry = clamp01(1 - relDev(p0.price, p4.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base, 'inverse_head_and_shoulders');
            push(patterns, { type: 'inverse_head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline });
          }
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
          if (start && end) {
            // ネックライン: 両肩間の安値(p1, p3)を結ぶ線
            const neckline = [
              { x: p1.idx, y: p1.price },
              { x: p3.idx, y: p3.price },
            ];
            const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct);
            const symmetry = clamp01(1 - relDev(p0.price, p4.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base, 'head_and_shoulders');
            push(patterns, { type: 'head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline });
          }
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
              const qFlat = clamp01(1 - Math.abs(dH) / Math.max(1e-12, tolerancePct * 0.8));
              const qRise = clamp01(dL / Math.max(1e-12, tolerancePct * 1.2));
              const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
              const per = periodScoreDays(start, end);
              const base = (qFlat + qRise + qConv + per) / 4;
              const confidence = finalizeConf(base, 'triangle_ascending');
              push(patterns, { type: 'triangle_ascending', confidence, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
            }
            // Descending: lows ~ flat, highs falling
            if ((want.size === 0 || want.has('triangle') || want.has('triangle_descending')) && Math.abs(dL) <= tolerancePct * 0.8 && dH <= -tolerancePct * 1.2 && converging) {
              const qFlat = clamp01(1 - Math.abs(dL) / Math.max(1e-12, tolerancePct * 0.8));
              const qFall = clamp01((-dH) / Math.max(1e-12, tolerancePct * 1.2));
              const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
              const per = periodScoreDays(start, end);
              const base = (qFlat + qFall + qConv + per) / 4;
              const confidence = finalizeConf(base, 'triangle_descending');
              push(patterns, { type: 'triangle_descending', confidence, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
            }
            // Symmetrical: highs falling and lows rising
            if ((want.size === 0 || want.has('triangle') || want.has('triangle_symmetrical')) && dH <= -tolerancePct * 1.1 && dL >= tolerancePct * 1.1 && converging) {
              const qFall = clamp01((-dH) / Math.max(1e-12, tolerancePct * 1.1));
              const qRise = clamp01(dL / Math.max(1e-12, tolerancePct * 1.1));
              const qSym = clamp01(1 - Math.abs(Math.abs(dH) - Math.abs(dL)) / Math.max(1e-12, Math.abs(dH) + Math.abs(dL)));
              const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
              const per = periodScoreDays(start, end);
              const base = (qFall + qRise + qSym + qConv + per) / 5;
              const confidence = finalizeConf(base, 'triangle_symmetrical');
              push(patterns, { type: 'triangle_symmetrical', confidence, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
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
            const qPole = clamp01((Math.abs(poleChange) - 0.08) / 0.12);
            const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
            const per = periodScoreDays(start, end);
            const base = (qPole + qConv + per) / 3;
            const confidence = finalizeConf(base, 'pennant');
            push(patterns, { type: 'pennant', confidence, range: { start, end } });
          }
          // Flag: parallel/slight slope against pole direction
          if (wantFlag) {
            const slopeAgainstUp = poleUp && dH < 0 && dL < 0; // both down
            const slopeAgainstDown = poleDown && dH > 0 && dL > 0; // both up
            const smallRange = spreadEnd <= spreadStart * 1.02; // 並行チャネルの厳格化
            if ((slopeAgainstUp || slopeAgainstDown) && smallRange) {
              const qPole = clamp01((Math.abs(poleChange) - 0.08) / 0.12);
              const qRange = clamp01(1 - (spreadEnd - spreadStart) / Math.max(1e-12, spreadStart * 0.2));
              const per = periodScoreDays(start, end);
              const base = (qPole + qRange + per) / 3;
              const confidence = finalizeConf(base, 'flag');
              push(patterns, { type: 'flag', confidence, range: { start, end } });
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
            if (start && end) {
              const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
              const tolMargin = clamp01(1 - (devs.reduce((s, v) => s + v, 0) / devs.length) / Math.max(1e-12, tolerancePct));
              const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
              const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base, 'triple_top');
              push(patterns, { type: 'triple_top', confidence, range: { start, end }, pivots: [a, b, c] });
            }
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
            if (start && end) {
              const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
              const tolMargin = clamp01(1 - (devs.reduce((s, v) => s + v, 0) / devs.length) / Math.max(1e-12, tolerancePct));
              const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
              const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base, 'triple_bottom');
              push(patterns, { type: 'triple_bottom', confidence, range: { start, end }, pivots: [a, b, c] });
            }
          }
        }
      }
    }

    // Aftermath analysis helpers
    const isoToIndex = new Map<string, number>();
    for (let i = 0; i < candles.length; i++) {
      const t = (candles[i] as any)?.isoTime;
      if (t) isoToIndex.set(String(t), i);
    }
    function necklineValue(p: any, idx: number): number | null {
      const nl = Array.isArray(p?.neckline) && p.neckline.length === 2 ? p.neckline : null;
      if (!nl) return null;
      const [a, b] = nl;
      // if x indices exist, linear interpolate; otherwise fallback to a.y/b.y
      if (Number.isFinite(a?.x) && Number.isFinite(b?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.y)) {
        const x1 = Number(a.x), y1 = Number(a.y), x2 = Number(b.x), y2 = Number(b.y);
        if (x2 !== x1) {
          const t = (idx - x1) / (x2 - x1);
          return y1 + (y2 - y1) * Math.max(0, Math.min(1, t));
        }
        return y1;
      }
      return Number.isFinite(a?.y) ? Number(a.y) : (Number.isFinite(b?.y) ? Number(b.y) : null);
    }
    function analyzeAftermath(p: any): any | null {
      try {
        const endIso = p?.range?.end;
        const endIdx = isoToIndex.has(String(endIso)) ? (isoToIndex.get(String(endIso)) as number) : -1;
        if (endIdx < 0) return null;
        const baseClose = Number(candles[endIdx]?.close ?? NaN);
        if (!Number.isFinite(baseClose)) return null;
        const nlAtEnd = necklineValue(p, endIdx);
        // direction by pattern type
        const bullish = ['double_bottom', 'inverse_head_and_shoulders', 'triangle_ascending', 'triangle_symmetrical', 'pennant', 'flag'].includes(String(p?.type));
        const bearish = ['double_top', 'head_and_shoulders', 'triangle_descending'].includes(String(p?.type));
        if (!Number.isFinite(nlAtEnd as any)) return null;
        let breakoutConfirmed = false;
        let breakoutDate: string | undefined;
        for (let i = endIdx + 1; i < Math.min(candles.length, endIdx + 30); i++) {
          const nl = necklineValue(p, i) ?? (nlAtEnd as number);
          const c = Number(candles[i]?.close ?? NaN);
          if (!Number.isFinite(c) || !Number.isFinite(nl)) continue;
          if ((bullish && c > nl) || (bearish && c < nl)) {
            breakoutConfirmed = true;
            breakoutDate = (candles[i] as any)?.isoTime;
            break;
          }
        }
        const horizon = [3, 7, 14];
        const priceMove: any = {};
        let bestRet = -Infinity;
        for (const h of horizon) {
          const to = Math.min(candles.length - 1, endIdx + h);
          if (to <= endIdx) continue;
          let hi = -Infinity, lo = Infinity;
          for (let i = endIdx + 1; i <= to; i++) {
            hi = Math.max(hi, Number(candles[i]?.high ?? -Infinity));
            lo = Math.min(lo, Number(candles[i]?.low ?? Infinity));
          }
          const closeTo = Number(candles[to]?.close ?? NaN);
          if (!Number.isFinite(closeTo)) continue;
          const ret = ((closeTo - baseClose) / baseClose) * 100;
          bestRet = Math.max(bestRet, ret);
          priceMove[`days${h}`] = { return: Number(ret.toFixed(2)), high: Number(hi.toFixed(0)), low: Number(lo.toFixed(0)) };
        }
        // theoretical target
        let theoreticalTarget = NaN;
        const nl = nlAtEnd as number;
        const pivotPrices = Array.isArray(p?.pivots) ? p.pivots.map((x: any) => Number(x?.price)).filter((x: any) => Number.isFinite(x)) : [];
        if (bullish && pivotPrices.length) {
          const patternLow = Math.min(...pivotPrices);
          theoreticalTarget = nl + (nl - patternLow);
        } else if (bearish && pivotPrices.length) {
          const patternHigh = Math.max(...pivotPrices);
          theoreticalTarget = nl - (patternHigh - nl);
        }
        // target reached within 14 bars
        let targetReached = false;
        if (Number.isFinite(theoreticalTarget)) {
          for (let i = endIdx + 1; i <= Math.min(candles.length - 1, endIdx + 14); i++) {
            const hi = Number(candles[i]?.high ?? NaN);
            const lo = Number(candles[i]?.low ?? NaN);
            if (bullish && Number.isFinite(hi) && hi >= theoreticalTarget) { targetReached = true; break; }
            if (bearish && Number.isFinite(lo) && lo <= theoreticalTarget) { targetReached = true; break; }
          }
        }
        // outcome
        function outcomeMessage(): string {
          if (!breakoutConfirmed) return 'ネックライン未突破（パターン不発）';
          if (targetReached) return '成功（理論目標価格到達）';
          const r3 = priceMove?.days3?.return;
          const r7 = priceMove?.days7?.return;
          const r14 = priceMove?.days14?.return;
          const arr = [r3, r7, r14].filter((v: any) => typeof v === 'number') as number[];
          if (!arr.length) return '評価不可（事後データ不足）';
          const best = arr.reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, 0);
          const bullish = ['double_bottom', 'inverse_head_and_shoulders', 'triangle_ascending', 'triangle_symmetrical', 'pennant', 'flag'].includes(String(p?.type));
          const expected = bullish ? 1 : -1;
          const actual = best > 0 ? 1 : -1;
          if (expected === actual && Math.abs(best) > 3) return `部分成功（ブレイクアウト後${best > 0 ? '+' : ''}${best.toFixed(1)}%、目標未達）`;
          if (expected !== actual && Math.abs(best) > 3) return `失敗（ブレイクアウト後、期待と逆方向に${best > 0 ? '+' : ''}${best.toFixed(1)}%）`;
          return `失敗（ブレイクアウト後、値動き僅少: ${best > 0 ? '+' : ''}${best.toFixed(1)}%）`;
        }
        const outcome = outcomeMessage();
        return {
          breakoutDate,
          breakoutConfirmed,
          priceMove,
          targetReached,
          theoreticalTarget: Number.isFinite(theoreticalTarget) ? Math.round(theoreticalTarget) : null,
          outcome,
        };
      } catch { return null; }
    }

    // attach aftermath and build statistics
    const stats: Record<string, { detected: number; withAftermath: number; success: number; r7: number[]; r14: number[] }> = {};
    for (const p of patterns) {
      const a = analyzeAftermath(p);
      if (a) p.aftermath = a;
      const t = String(p.type);
      if (!stats[t]) stats[t] = { detected: 0, withAftermath: 0, success: 0, r7: [], r14: [] };
      stats[t].detected += 1;
      if (a) {
        stats[t].withAftermath += 1;
        if (a.outcome === 'success') stats[t].success += 1;
        const r7 = a?.priceMove?.days7?.return;
        if (typeof r7 === 'number') stats[t].r7.push(r7);
        const r14 = a?.priceMove?.days14?.return;
        if (typeof r14 === 'number') stats[t].r14.push(r14);
      }
    }

    function avg(arr: number[]) { return arr.length ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2)) : null; }
    function median(arr: number[]) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(2)); }
    const statistics: any = {};
    for (const [k, v] of Object.entries(stats)) {
      statistics[k] = {
        detected: v.detected,
        withAftermath: v.withAftermath,
        successRate: v.withAftermath ? Number((v.success / v.withAftermath).toFixed(2)) : null,
        avgReturn7d: avg(v.r7),
        avgReturn14d: avg(v.r14),
        medianReturn7d: median(v.r7),
      };
    }

    // overlays: パターン範囲をそのまま帯描画できるように提供
    const ranges = patterns.map((p: any) => ({ start: p.range.start, end: p.range.end, label: p.type }));
    const warnings: any[] = [];
    if (patterns.length <= 1) {
      warnings.push({ type: 'low_detection_count', message: '検出数が少ないです。tolerancePct や minBarsBetweenSwings の調整を推奨します', suggestedParams: { tolerancePct: 0.03, minBarsBetweenSwings: 2 } });
    }
    const out = ok(
      'patterns detected',
      { patterns, overlays: { ranges }, warnings, statistics },
      { pair, type, count: patterns.length, visualization_hints: { preferred_style: 'line', highlight_patterns: patterns.map((p: any) => p.type).slice(0, 3) } }
    );
    return DetectPatternsOutputSchema.parse(out) as any;
  } catch (e: any) {
    return DetectPatternsOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


