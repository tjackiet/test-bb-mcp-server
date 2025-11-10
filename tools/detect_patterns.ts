import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema, PatternTypeEnum } from '../src/schemas.js';

type DetectIn = typeof DetectPatternsInputSchema extends { _type: infer T } ? T : any;

export default async function detectPatterns(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 90,
  opts: Partial<{
    swingDepth: number;
    tolerancePct: number;
    minBarsBetweenSwings: number;
    strictPivots: boolean;
    patterns: Array<typeof PatternTypeEnum._type>;
    requireCurrentInPattern: boolean;
    currentRelevanceDays: number;
  }> = {}
) {
  try {
    // --- 時間軸に応じた自動スケーリング（ユーザー指定があればそちらを優先） ---
    const defaultParamsForTf = (tf: string): { swingDepth: number; minBarsBetweenSwings: number } => {
      const t = String(tf);
      // 期待動作（例）の目安に基づくデフォルト
      if (t === '1hour') return { swingDepth: 3, minBarsBetweenSwings: 2 };
      if (t === '4hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
      if (t === '8hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
      if (t === '12hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
      if (t === '1day') return { swingDepth: 6, minBarsBetweenSwings: 4 };
      if (t === '1week') return { swingDepth: 7, minBarsBetweenSwings: 5 };
      if (t === '1month') return { swingDepth: 8, minBarsBetweenSwings: 6 };
      // 分足はやや緩め（ノイズ多めのため最小幅は確保）
      if (t === '30min') return { swingDepth: 3, minBarsBetweenSwings: 2 };
      if (t === '15min') return { swingDepth: 3, minBarsBetweenSwings: 2 };
      if (t === '5min') return { swingDepth: 2, minBarsBetweenSwings: 1 };
      if (t === '1min') return { swingDepth: 2, minBarsBetweenSwings: 1 };
      // フォールバック（日足相当）
      return { swingDepth: 6, minBarsBetweenSwings: 4 };
    };
    const defaultToleranceForTf = (tf: string): number => {
      const t = String(tf);
      if (t === '1hour' || t === '4hour') return 0.05; // 5%
      if (t === '8hour' || t === '12hour') return 0.045; // 4.5%
      if (t === '15min' || t === '30min') return 0.06; // 6%
      if (t === '1week') return 0.035; // 3.5%
      if (t === '1month') return 0.03; // 3.0%
      return 0.04; // 1day 他
    };
    const auto = defaultParamsForTf(type);
    // 入力スキーマの既定値（サーバ側でデフォルト埋めされるため、ここで「ユーザー指定か」を推定する）
    const SCHEMA_DEFAULTS = { swingDepth: 7, minBarsBetweenSwings: 5, tolerancePct: 0.04 };
    // swingDepth: スキーマ既定値(7)が来た場合は時間軸オートに置換（明示指定で7の場合は影響あるが、時間軸適応を優先）
    const swingDepth = Number.isFinite(opts.swingDepth as any)
      ? ((opts.swingDepth as number) === SCHEMA_DEFAULTS.swingDepth ? auto.swingDepth : (opts.swingDepth as number))
      : auto.swingDepth;
    // tolerancePct: スキーマ既定値(0.04)が来た場合は時間軸オートを採用。ユーザーが0.04を意図した場合は明示指定を推奨
    const tolAuto = defaultToleranceForTf(type);
    const tolerancePct = (typeof opts.tolerancePct === 'number' && !Number.isNaN(opts.tolerancePct))
      ? ((opts.tolerancePct as number) === SCHEMA_DEFAULTS.tolerancePct ? tolAuto : (opts.tolerancePct as number))
      : tolAuto;
    // minBarsBetweenSwings: 同様に既定値(5)なら時間軸オートに置換
    const minDist = Number.isFinite(opts.minBarsBetweenSwings as any)
      ? ((opts.minBarsBetweenSwings as number) === SCHEMA_DEFAULTS.minBarsBetweenSwings ? auto.minBarsBetweenSwings : (opts.minBarsBetweenSwings as number))
      : auto.minBarsBetweenSwings;
    const strictPivots = (opts as any)?.strictPivots !== false; // 既定: 厳格
    const convergenceFactorForTf = (tf: string): number => {
      const t = String(tf);
      if (t === '1hour' || t === '4hour' || t === '15min' || t === '30min') return 0.6;
      return 0.8; // default
    };
    const triangleCoeffForTf = (tf: string): { flat: number; move: number } => {
      const t = String(tf);
      if (t === '1hour' || t === '4hour') return { flat: 1.2, move: 0.8 };
      return { flat: 0.8, move: 1.2 };
    };
    const minFitForTf = (tf: string): number => {
      const t = String(tf);
      if (t === '1hour' || t === '4hour') return 0.60;
      if (t === '1day') return 0.70;
      return 0.75;
    };
    const getTriangleWindowSize = (tf: string): number => {
      const t = String(tf);
      // 長期: 大きなパターン
      if (t === '1month') return 30;
      if (t === '1week') return 40;
      // 中期
      if (t === '1day') return 50;
      // 短期
      if (t === '4hour') return 30;
      if (t === '1hour') return 40;
      if (t === '30min') return 30;
      if (t === '15min') return 30;
      return 20;
    };
    // Wedge 向けの短いウィンドウサイズ
    const getWedgeWindowSize = (tf: string): number => {
      const t = String(tf);
      // ウェッジは三角より短期間で形成されやすい
      if (t === '1month') return 20;
      if (t === '1week') return 25;
      if (t === '1day') return 8;   // 画像参照: 約2ヶ月（8週間）相当
      if (t === '4hour') return 20;
      if (t === '1hour') return 25;
      if (t === '30min') return 20;
      if (t === '15min') return 20;
      return 12;
    };
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
      if (strictPivots) {
        for (let k = 1; k <= swingDepth; k++) {
          if (!(highs[i] > highs[i - k] && highs[i] > highs[i + k])) isHigh = false;
          if (!(lows[i] < lows[i - k] && lows[i] < lows[i + k])) isLow = false;
          if (!isHigh && !isLow) break;
        }
      } else {
        let votesHigh = 0, votesLow = 0;
        for (let k = 1; k <= swingDepth; k++) {
          votesHigh += (highs[i] > highs[i - k] && highs[i] > highs[i + k]) ? 1 : 0;
          votesLow += (lows[i] < lows[i - k] && lows[i] < lows[i + k]) ? 1 : 0;
        }
        const need = Math.ceil(swingDepth * 0.6);
        isHigh = votesHigh >= need;
        isLow = votesLow >= need;
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
    // --- 回帰ベースのトレンドライン推定（三角保ち合い向け） ---
    function linearRegression(points: Array<{ idx: number; price: number }>): { slope: number; intercept: number } {
      const n = points.length;
      if (!n) return { slope: 0, intercept: 0 };
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (const p of points) {
        sumX += p.idx;
        sumY += p.price;
        sumXY += p.idx * p.price;
        sumX2 += p.idx * p.idx;
      }
      const denom = n * sumX2 - sumX * sumX || 1;
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      return { slope, intercept };
    }
    function trendlineFit(points: Array<{ idx: number; price: number }>, line: { slope: number; intercept: number }): number {
      if (!points.length) return 0;
      let sumDev = 0;
      for (const p of points) {
        const expected = line.slope * p.idx + line.intercept;
        const dev = Math.abs(p.price - expected) / Math.max(1e-12, p.price);
        sumDev += dev;
      }
      const avgDev = sumDev / points.length;
      return Math.max(0, Math.min(1, 1 - avgDev));
    }
    // (visual scale filters were reverted to previous behavior)
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
    // debug buffers
    const debugSwings = pivots.map(p => ({ idx: p.idx, price: p.price, kind: p.kind, isoTime: (candles[p.idx] as any)?.isoTime }));
    const debugCandidates: Array<{ type: string; accepted: boolean; reason?: string; indices?: number[]; points?: Array<{ role: string; idx: number; price: number; isoTime?: string }>; details?: any }> = [];
    const pushCand = (arg: { type: string; accepted: boolean; reason?: string; idxs?: number[]; pts?: Array<{ role: string; idx: number; price: number }> }) => {
      const points = (arg.pts || []).map(p => ({ ...p, isoTime: (candles[p.idx] as any)?.isoTime }));
      debugCandidates.push({ type: arg.type, accepted: arg.accepted, reason: arg.reason, indices: arg.idxs, points });
    };

    let patterns: any[] = [];

    // convenience lists for relaxed passes
    const allPeaks: Array<{ idx: number; price: number; kind: 'H' | 'L' }> = pivots.filter(p => p.kind === 'H');
    const allValleys: Array<{ idx: number; price: number; kind: 'H' | 'L' }> = pivots.filter(p => p.kind === 'L');

    // 2) Double top/bottom
    let foundDoubleTop = false, foundDoubleBottom = false;
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
            foundDoubleTop = true;
            pushCand({ type: 'double_top', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'valley', idx: b.idx, price: b.price }, { role: 'peak2', idx: c.idx, price: c.price }] });
          }
        } else if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H') {
          // reject reason for debugging
          const diffAbs = Math.abs(a.price - c.price);
          const diffPct = diffAbs / Math.max(1, Math.max(a.price, c.price));
          if (diffPct > tolerancePct) {
            pushCand({
              type: 'double_top',
              accepted: false,
              reason: 'peaks_not_equal',
              idxs: [a.idx, b.idx, c.idx],
              pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'peak2', idx: c.idx, price: c.price }]
            });
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
            foundDoubleBottom = true;
            pushCand({ type: 'double_bottom', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'peak', idx: b.idx, price: b.price }, { role: 'valley2', idx: c.idx, price: c.price }] });
          }
        } else if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L') {
          const diffAbs = Math.abs(a.price - c.price);
          const diffPct = diffAbs / Math.max(1, Math.max(a.price, c.price));
          if (diffPct > tolerancePct) {
            pushCand({
              type: 'double_bottom',
              accepted: false,
              reason: 'valleys_not_equal',
              idxs: [a.idx, b.idx, c.idx],
              pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'valley2', idx: c.idx, price: c.price }]
            });
          }
        }
      }
      // relaxed fallback for double top/bottom: multi-stage factors [1.5, 2.0]
      for (const f of [1.5, 2.0]) {
        if (!foundDoubleTop && (want.size === 0 || want.has('double_top'))) {
          const tolRelax = tolerancePct * f;
          const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;
          for (let i = 0; i < pivots.length - 3; i++) {
            const a = pivots[i], b = pivots[i + 1], c = pivots[i + 2];
            if (!(a.kind === 'H' && b.kind === 'L' && c.kind === 'H')) continue;
            if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
            if (!nearRelaxed(a.price, c.price)) { pushCand({ type: 'double_top', accepted: false, reason: 'peaks_not_equal_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'peak2', idx: c.idx, price: c.price }] }); continue; }
            const start = candles[a.idx].isoTime, end = candles[c.idx].isoTime;
            if (!start || !end) continue;
            const neckline = [{ x: a.idx, y: b.price }, { x: c.idx, y: b.price }];
            const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolRelax);
            const symmetry = clamp01(1 - relDev(a.price, c.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base * 0.95, 'double_top');
            push(patterns, { type: 'double_top', confidence, range: { start, end }, pivots: [a, b, c], neckline, _fallback: `relaxed_double_x${f}` });
            foundDoubleTop = true;
            break;
          }
        }
        if (!foundDoubleBottom && (want.size === 0 || want.has('double_bottom'))) {
          const tolRelax = tolerancePct * f;
          const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;
          for (let i = 0; i < pivots.length - 3; i++) {
            const a = pivots[i], b = pivots[i + 1], c = pivots[i + 2];
            if (!(a.kind === 'L' && b.kind === 'H' && c.kind === 'L')) continue;
            if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
            if (!nearRelaxed(a.price, c.price)) { pushCand({ type: 'double_bottom', accepted: false, reason: 'valleys_not_equal_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'valley2', idx: c.idx, price: c.price }] }); continue; }
            const start = candles[a.idx].isoTime, end = candles[c.idx].isoTime;
            if (!start || !end) continue;
            const neckline = [{ x: a.idx, y: b.price }, { x: c.idx, y: b.price }];
            const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolRelax);
            const symmetry = clamp01(1 - relDev(a.price, c.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base * 0.95, 'double_bottom');
            push(patterns, { type: 'double_bottom', confidence, range: { start, end }, pivots: [a, b, c], neckline, _fallback: `relaxed_double_x${f}` });
            foundDoubleBottom = true;
            break;
          }
        }
      }
    }

    // 3) Inverse H&S (L-H-L-H-L with head lower than both shoulders)
    let foundInverseHS = false;
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
            foundInverseHS = true;
            debugCandidates.push({
              type: 'inverse_head_and_shoulders',
              accepted: true,
              indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
              points: [
                { role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: (candles[p0.idx] as any)?.isoTime },
                { role: 'peak1', idx: p1.idx, price: p1.price, isoTime: (candles[p1.idx] as any)?.isoTime },
                { role: 'head', idx: p2.idx, price: p2.price, isoTime: (candles[p2.idx] as any)?.isoTime },
                { role: 'peak2', idx: p3.idx, price: p3.price, isoTime: (candles[p3.idx] as any)?.isoTime },
                { role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: (candles[p4.idx] as any)?.isoTime },
              ],
            });
          }
        }
        else {
          const reason = !shouldersNear ? 'shoulders_not_near' : (!headLower ? 'head_not_lower' : 'unknown');
          debugCandidates.push({
            type: 'inverse_head_and_shoulders',
            accepted: false,
            reason,
            details: {
              leftShoulder: p0.price, rightShoulder: p4.price,
              shouldersDiff: Math.abs(p0.price - p4.price),
              shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
              head: p2.price, thresholdPct: tolerancePct,
            },
            indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
          });
        }
      }
    }

    // 3b) Head & Shoulders (H-L-H-L-H with head higher than both shoulders)
    let foundHS = false;
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
            foundHS = true;
            debugCandidates.push({
              type: 'head_and_shoulders',
              accepted: true,
              indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
              points: [
                { role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: (candles[p0.idx] as any)?.isoTime },
                { role: 'valley1', idx: p1.idx, price: p1.price, isoTime: (candles[p1.idx] as any)?.isoTime },
                { role: 'head', idx: p2.idx, price: p2.price, isoTime: (candles[p2.idx] as any)?.isoTime },
                { role: 'valley2', idx: p3.idx, price: p3.price, isoTime: (candles[p3.idx] as any)?.isoTime },
                { role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: (candles[p4.idx] as any)?.isoTime },
              ],
            });
          }
        }
        else {
          const reason = !shouldersNear ? 'shoulders_not_near' : (!headHigher ? 'head_not_higher' : 'unknown');
          debugCandidates.push({
            type: 'head_and_shoulders',
            accepted: false,
            reason,
            details: {
              leftShoulder: p0.price, rightShoulder: p4.price,
              shouldersDiff: Math.abs(p0.price - p4.price),
              shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
              head: p2.price, thresholdPct: tolerancePct,
            },
            indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
          });
        }
      }
    }

    // Relaxed fallback for H&S patterns (multi-stage)
    if (!foundHS && (want.size === 0 || want.has('head_and_shoulders'))) {
      for (const factors of [{ shoulder: 1.6, head: 0.6, tag: 'x1.6_0.6' }, { shoulder: 2.0, head: 0.4, tag: 'x2.0_0.4' }]) {
        if (foundHS) break;
        for (let i = 0; i < pivots.length - 4; i++) {
          const p0 = pivots[i], p1 = pivots[i + 1], p2 = pivots[i + 2], p3 = pivots[i + 3], p4 = pivots[i + 4];
          if (!(p0.kind === 'H' && p1.kind === 'L' && p2.kind === 'H' && p3.kind === 'L' && p4.kind === 'H')) continue;
          if (p1.idx - p0.idx < minDist || p2.idx - p1.idx < minDist || p3.idx - p2.idx < minDist || p4.idx - p3.idx < minDist) continue;
          // Relax shoulders similarity and head prominence
          const shouldersNearRelaxed = Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)) <= tolerancePct * factors.shoulder;
          const headHigherRelaxed = p2.price > Math.max(p0.price, p4.price) * (1 + tolerancePct * factors.head);
          if (!shouldersNearRelaxed || !headHigherRelaxed) continue;
          const start = candles[p0.idx].isoTime;
          const end = candles[p4.idx].isoTime;
          if (!start || !end) continue;
          // choose lowest valley between shoulders and after head for neckline robustness
          const valleyBetween = allValleys.filter((v: any) => v.idx > p0.idx && v.idx < p4.idx);
          const postValleys = allValleys.filter((v: any) => v.idx > p2.idx);
          const minValley = valleyBetween.length ? valleyBetween.reduce((m: any, v: any) => v.price < m.price ? v : m) : (postValleys.length ? postValleys.reduce((m: any, v: any) => v.price < m.price ? v : m) : null);
          const nlY = minValley ? minValley.price : Math.min(p1.price, p3.price);
          const neckline = [{ x: p1.idx, y: nlY }, { x: p3.idx, y: nlY }];
          const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct * factors.shoulder);
          const symmetry = clamp01(1 - relDev(p0.price, p4.price));
          const per = periodScoreDays(start, end);
          const base = (tolMargin + symmetry + per) / 3;
          const confidence = finalizeConf(base * 0.95, 'head_and_shoulders');
          push(patterns, { type: 'head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline, _fallback: `relaxed_hs_${factors.tag}` });
          foundHS = true;
          debugCandidates.push({
            type: 'head_and_shoulders',
            accepted: true,
            reason: 'fallback_relaxed',
            indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
          });
          break;
        }
      }
    }

    if (!foundInverseHS && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
      for (const factors of [{ shoulder: 1.6, head: 0.6, tag: 'x1.6_0.6' }, { shoulder: 2.0, head: 0.4, tag: 'x2.0_0.4' }]) {
        if (foundInverseHS) break;
        for (let i = 0; i < pivots.length - 4; i++) {
          const p0 = pivots[i], p1 = pivots[i + 1], p2 = pivots[i + 2], p3 = pivots[i + 3], p4 = pivots[i + 4];
          if (!(p0.kind === 'L' && p1.kind === 'H' && p2.kind === 'L' && p3.kind === 'H' && p4.kind === 'L')) continue;
          if (p1.idx - p0.idx < minDist || p2.idx - p1.idx < minDist || p3.idx - p2.idx < minDist || p4.idx - p3.idx < minDist) continue;
          const shouldersNearRelaxed = Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)) <= tolerancePct * factors.shoulder;
          const headLowerRelaxed = p2.price < Math.min(p0.price, p4.price) * (1 - tolerancePct * factors.head);
          if (shouldersNearRelaxed && headLowerRelaxed) {
            const start = candles[p0.idx].isoTime;
            const end = candles[p4.idx].isoTime;
            if (!start || !end) continue;
            const peaksBetween = allPeaks.filter((v: any) => v.idx > p0.idx && v.idx < p4.idx);
            const postPeaks = allPeaks.filter((v: any) => v.idx > p2.idx);
            const maxPeak = peaksBetween.length ? peaksBetween.reduce((m: any, v: any) => v.price > m.price ? v : m) : (postPeaks.length ? postPeaks.reduce((m: any, v: any) => v.price > m.price ? v : m) : null);
            const nlY = maxPeak ? maxPeak.price : Math.max(p1.price, p3.price);
            const neckline = [{ x: p1.idx, y: nlY }, { x: p3.idx, y: nlY }];
            const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct * factors.shoulder);
            const symmetry = clamp01(1 - relDev(p0.price, p4.price));
            const per = periodScoreDays(start, end);
            const base = (tolMargin + symmetry + per) / 3;
            const confidence = finalizeConf(base * 0.95, 'inverse_head_and_shoulders');
            push(patterns, { type: 'inverse_head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline, _fallback: `relaxed_ihs_${factors.tag}` });
            foundInverseHS = true;
            debugCandidates.push({
              type: 'inverse_head_and_shoulders',
              accepted: true,
              reason: 'fallback_relaxed',
              indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
            });
            break;
          }
        }
      }
    }
    // 4) Triangles (ascending/descending/symmetrical)
    {
      const wantTriangle =
        want.size === 0 ||
        want.has('triangle') ||
        want.has('triangle_ascending') ||
        want.has('triangle_descending') ||
        want.has('triangle_symmetrical') ||
        // include wedges so that wedge detection inside this block runs
        want.has('falling_wedge') ||
        want.has('rising_wedge');
      if (wantTriangle) {
        const highs = pivots.filter(p => p.kind === 'H');
        const lows = pivots.filter(p => p.kind === 'L');
        const wantWedge = want.has('falling_wedge') || want.has('rising_wedge');
        const WIN = wantWedge ? getWedgeWindowSize(type) : getTriangleWindowSize(type);
        const step = Math.max(1, Math.floor(WIN / 4));
        // DEBUG: 窓スキャンの設定とループ条件（ログ出力は抑止）
        for (let offset = 0; offset <= Math.max(0, Math.min(highs.length, lows.length) - Math.max(3, WIN)); offset += step) {
          // per-iteration debug log removed
          const hwin = highs.slice(offset, offset + WIN);
          const lwin = lows.slice(offset, offset + WIN);
          if (hwin.length < 3 || lwin.length < 3) continue;
          const coef = triangleCoeffForTf(type);
          const firstH = hwin[0], lastH = hwin[hwin.length - 1];
          const firstL = lwin[0], lastL = lwin[lwin.length - 1];
          const dH = pct(firstH.price, lastH.price);
          const dL = pct(firstL.price, lastL.price);
          const spreadStart = firstH.price - firstL.price;
          const spreadEnd = lastH.price - lastL.price;
          const convF = convergenceFactorForTf(type);
          const converging = spreadEnd < spreadStart * (1 - tolerancePct * convF);
          const startIdx = Math.min(firstH.idx, firstL.idx);
          const endIdx = Math.max(lastH.idx, lastL.idx);
          const start = candles[startIdx].isoTime;
          const end = candles[endIdx].isoTime;

          if (start && end) {
            // --- 回帰ベースのライン推定 ---
            const minTouches = 3;
            const highsPts = hwin.map(p => ({ idx: p.idx, price: p.price }));
            const lowsPts = lwin.map(p => ({ idx: p.idx, price: p.price }));
            const highsOk = highsPts.length >= minTouches;
            const lowsOk = lowsPts.length >= minTouches;
            const hiLine = linearRegression(highsPts);
            const loLine = linearRegression(lowsPts);
            const barsSpan = Math.max(1, endIdx - startIdx);
            const avgH = highsPts.reduce((s, p) => s + p.price, 0) / Math.max(1, highsPts.length);
            const avgL = lowsPts.reduce((s, p) => s + p.price, 0) / Math.max(1, lowsPts.length);
            // 窓全体での回帰による変化率（相対）
            const hiSlopeRel = Math.abs(hiLine.slope) * barsSpan / Math.max(1e-12, avgH);
            const loSlopeRelSigned = (loLine.slope) * barsSpan / Math.max(1e-12, avgL);
            const loSlopeRelAbs = Math.abs(loSlopeRelSigned);
            const fitH = trendlineFit(highsPts, hiLine);
            const fitL = trendlineFit(lowsPts, loLine);
            // フィット品質しきい値（時間軸別+段階フォールバック）
            const baseFit = minFitForTf(type);
            const fitThresholds = Array.from(new Set([baseFit, 0.70, 0.60])).sort((a, b) => b - a);
            let placedAsc = false, placedDesc = false, placedSym = false;
            for (const minFit of fitThresholds) {
              // Ascending: highs ~ flat, lows rising
              if (!placedAsc &&
                (want.size === 0 || want.has('triangle') || want.has('triangle_ascending')) &&
                highsOk && lowsOk &&
                hiSlopeRel <= tolerancePct * coef.flat &&
                loSlopeRelSigned >= tolerancePct * coef.move &&
                fitH >= minFit && fitL >= minFit &&
                converging
              ) {
                const qFlat = clamp01(1 - Math.abs(dH) / Math.max(1e-12, tolerancePct * coef.flat));
                const qRise = clamp01(dL / Math.max(1e-12, tolerancePct * coef.move));
                const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
                const per = periodScoreDays(start, end);
                const base = (qFlat + qRise + qConv + per) / 4;
                const confidence = Math.min(1, finalizeConf(base, 'triangle_ascending') * (minFit / 0.78));
                push(patterns, { type: 'triangle_ascending', confidence, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
                placedAsc = true;
              }
              // Descending: lows ~ flat, highs falling
              if (!placedDesc &&
                (want.size === 0 || want.has('triangle') || want.has('triangle_descending')) &&
                highsOk && lowsOk &&
                loSlopeRelAbs <= tolerancePct * coef.flat &&
                (hiLine.slope * barsSpan / Math.max(1e-12, avgH)) <= -tolerancePct * coef.move &&
                fitH >= minFit && fitL >= minFit &&
                converging
              ) {
                const qFlat = clamp01(1 - Math.abs(dL) / Math.max(1e-12, tolerancePct * coef.flat));
                const qFall = clamp01((-dH) / Math.max(1e-12, tolerancePct * coef.move));
                const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
                const per = periodScoreDays(start, end);
                const base = (qFlat + qFall + qConv + per) / 4;
                const confidence = Math.min(1, finalizeConf(base, 'triangle_descending') * (minFit / 0.78));
                push(patterns, { type: 'triangle_descending', confidence, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
                placedDesc = true;
              }
              // Symmetrical: highs falling and lows rising
              if (!placedSym &&
                (want.size === 0 || want.has('triangle') || want.has('triangle_symmetrical')) &&
                highsOk && lowsOk &&
                (hiLine.slope * barsSpan / Math.max(1e-12, avgH)) <= -tolerancePct * coef.move &&
                loSlopeRelSigned >= tolerancePct * coef.move &&
                fitH >= minFit && fitL >= minFit &&
                converging
              ) {
                const qFall = clamp01((-dH) / Math.max(1e-12, tolerancePct * coef.move));
                const qRise = clamp01(dL / Math.max(1e-12, tolerancePct * coef.move));
                const qSym = clamp01(1 - Math.abs(Math.abs(dH) - Math.abs(dL)) / Math.max(1e-12, Math.abs(dH) + Math.abs(dL)));
                const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
                const per = periodScoreDays(start, end);
                const base = (qFall + qRise + qSym + qConv + per) / 5;
                const confidence = Math.min(1, finalizeConf(base, 'triangle_symmetrical') * (minFit / 0.78));
                push(patterns, { type: 'triangle_symmetrical', confidence, range: { start, end }, pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx) });
                placedSym = true;
              }
              if (placedAsc && placedDesc && placedSym) break;
            }
            // --- Wedge detection (falling/rising) ---
            // 方向性と傾き比率（緩い側の傾きが小さい）
            const bothFalling = (hiLine.slope < 0) && (loLine.slope < 0);
            const bothRising = (hiLine.slope > 0) && (loLine.slope > 0);
            const ratioThresh = 0.85; // 緩い側 ≈ 85%以下（緩和）
            const lowerSlopeFlatter = Math.abs(loLine.slope) < Math.abs(hiLine.slope) * ratioThresh;
            const upperSlopeFlatter = Math.abs(hiLine.slope) < Math.abs(loLine.slope) * ratioThresh;
            // 収束は spread 比で担保（さらに緩和）
            const convergingStrict = spreadEnd < spreadStart * (1 - Math.max(0.005, tolerancePct * 0.3));
            const minFitAny = Math.min(...fitThresholds);
            const fitOk = fitH >= minFitAny && fitL >= minFitAny;
            if (highsOk && lowsOk && fitOk && convergingStrict) {
              const qConv = clamp01((spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8));
              const wedgeFit = (fitH + fitL) / 2;
              const per = periodScoreDays(start, end);
              const baseWedge = (qConv + wedgeFit + per) / 3;
              // Falling Wedge → 通常は上抜け（bullish bias）
              if (bothFalling && lowerSlopeFlatter) {
                const confidence = Math.min(1, finalizeConf(baseWedge, 'triangle_symmetrical'));
                push(patterns, {
                  type: 'falling_wedge',
                  confidence,
                  range: { start, end },
                  pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx),
                });
                debugCandidates.push({
                  type: 'falling_wedge',
                  accepted: true,
                  reason: 'ok',
                  indices: [startIdx, endIdx],
                  points: [{ role: 'hi_start', idx: firstH.idx, price: firstH.price }, { role: 'hi_end', idx: lastH.idx, price: lastH.price }, { role: 'lo_start', idx: firstL.idx, price: firstL.price }, { role: 'lo_end', idx: lastL.idx, price: lastL.price }],
                  details: { highsIdxs: hwin.map(p => p.idx), lowsIdxs: lwin.map(p => p.idx), WIN, offset, hiSlope: hiLine.slope, loSlope: loLine.slope, fitH, fitL, ratioThresh, spreadStart, spreadEnd, qConv }
                });
              }
              // Rising Wedge → 通常は下抜け（bearish bias）
              if (bothRising && upperSlopeFlatter) {
                const confidence = Math.min(1, finalizeConf(baseWedge, 'triangle_symmetrical'));
                push(patterns, {
                  type: 'rising_wedge',
                  confidence,
                  range: { start, end },
                  pivots: [...hwin, ...lwin].sort((a, b) => a.idx - b.idx),
                });
                debugCandidates.push({
                  type: 'rising_wedge',
                  accepted: true,
                  reason: 'ok',
                  indices: [startIdx, endIdx],
                  points: [{ role: 'hi_start', idx: firstH.idx, price: firstH.price }, { role: 'hi_end', idx: lastH.idx, price: lastH.price }, { role: 'lo_start', idx: firstL.idx, price: firstL.price }, { role: 'lo_end', idx: lastL.idx, price: lastL.price }],
                  details: { highsIdxs: hwin.map(p => p.idx), lowsIdxs: lwin.map(p => p.idx), WIN, offset, hiSlope: hiLine.slope, loSlope: loLine.slope, fitH, fitL, ratioThresh, spreadStart, spreadEnd, qConv }
                });
              }
              if (!(bothFalling && lowerSlopeFlatter) && !(bothRising && upperSlopeFlatter)) {
                debugCandidates.push({
                  type: (bothFalling ? 'falling_wedge' : (bothRising ? 'rising_wedge' : 'triangle_symmetrical')) as any,
                  accepted: false,
                  reason: 'slope_ratio_or_direction_not_met',
                  indices: [startIdx, endIdx],
                  details: { highsIdxs: hwin.map(p => p.idx), lowsIdxs: lwin.map(p => p.idx), WIN, offset, bothFalling, bothRising, lowerSlopeFlatter, upperSlopeFlatter, hiSlope: hiLine.slope, loSlope: loLine.slope, fitH, fitL, spreadStart, spreadEnd, qConv }
                });
              }
            } else {
              debugCandidates.push({
                type: 'triangle_symmetrical' as any,
                accepted: false,
                reason: !highsOk || !lowsOk ? 'insufficient_touches' : (!fitOk ? 'fit_below_threshold' : (!convergingStrict ? 'not_converging' : 'unknown')),
                indices: [startIdx, endIdx],
                details: { highsIdxs: hwin.map(p => p.idx), lowsIdxs: lwin.map(p => p.idx), WIN, offset, highsOk, lowsOk, fitH, fitL, minFitAny, spreadStart, spreadEnd, tol: tolerancePct }
              });
            }
          }
        }
        // for-loop end
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
      // 時間軸に応じた旗竿しきい値（C）
      const poleThreshold = (tf: string): number => {
        const t = String(tf);
        if (t === '1hour' || t === '4hour') return 0.05; // 5%
        if (t === '1day') return 0.08; // 8%
        return 0.06; // others
      };
      const minPole = poleThreshold(type);
      const poleUp = poleChange >= minPole;
      const poleDown = poleChange <= -minPole;
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
      // 収束条件を時間軸で緩和（B）
      const convF = convergenceFactorForTf(type);
      const converging = spreadEnd < spreadStart * (1 - tolerancePct * convF);

      if (havePole) {
        const start = candles[winStart].isoTime;
        const end = candles[idxEnd].isoTime;
        if (start && end) {
          // Pennant: converging (symmetrical) consolidation after strong pole
          if (wantPennant && ((dH <= 0 && dL >= 0) || (dH < 0 && dL > 0)) && converging) {
            const qPole = clamp01((Math.abs(poleChange) - minPole) / Math.max(1e-12, (minPole * 2)));
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
              const qPole = clamp01((Math.abs(poleChange) - minPole) / Math.max(1e-12, (minPole * 2)));
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
              pushCand({ type: 'triple_top', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'peak2', idx: b.idx, price: b.price }, { role: 'peak3', idx: c.idx, price: c.price }] });
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
              pushCand({ type: 'triple_bottom', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'valley2', idx: b.idx, price: b.price }, { role: 'valley3', idx: c.idx, price: c.price }] });
            }
          }
        }
        // relaxed fallback for triple if none found (multi-stage 1.25, 2.0)
        for (const f of [1.25, 2.0]) {
          const tolTriple = tolerancePct * f;
          const nearTriple = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.max(x, y)) <= tolTriple;
          if (wantTripleTop && !patterns.some(p => p.type === 'triple_top')) {
            const hs = highsOnly;
            let placed = false;
            for (let i = 0; i <= hs.length - 3 && !placed; i++) {
              const a = hs[i], b = hs[i + 1], c = hs[i + 2];
              if ((b.idx - a.idx) < minDist || (c.idx - b.idx) < minDist) continue;
              if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) { pushCand({ type: 'triple_top', accepted: false, reason: 'peaks_not_equal_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'peak2', idx: b.idx, price: b.price }, { role: 'peak3', idx: c.idx, price: c.price }] }); continue; }
              const start = candles[a.idx].isoTime, end = candles[c.idx].isoTime;
              if (!start || !end) continue;
              const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
              const tolMargin = clamp01(1 - (devs.reduce((s, v) => s + v, 0) / devs.length) / Math.max(1e-12, tolTriple));
              const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
              const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base * 0.95, 'triple_top');
              push(patterns, { type: 'triple_top', confidence, range: { start, end }, pivots: [a, b, c], _fallback: `relaxed_triple_x${f}` });
              placed = true;
            }
          }
          if (wantTripleBottom && !patterns.some(p => p.type === 'triple_bottom')) {
            const ls = lowsOnly;
            let placed = false;
            for (let i = 0; i <= ls.length - 3 && !placed; i++) {
              const a = ls[i], b = ls[i + 1], c = ls[i + 2];
              if ((b.idx - a.idx) < minDist || (c.idx - b.idx) < minDist) continue;
              if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) { pushCand({ type: 'triple_bottom', accepted: false, reason: 'valleys_not_equal_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'valley2', idx: b.idx, price: b.price }, { role: 'valley3', idx: c.idx, price: c.price }] }); continue; }
              const start = candles[a.idx].isoTime, end = candles[c.idx].isoTime;
              if (!start || !end) continue;
              const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
              const tolMargin = clamp01(1 - (devs.reduce((s, v) => s + v, 0) / devs.length) / Math.max(1e-12, tolTriple));
              const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
              const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base * 0.95, 'triple_bottom');
              push(patterns, { type: 'triple_bottom', confidence, range: { start, end }, pivots: [a, b, c], _fallback: `relaxed_triple_x${f}` });
              placed = true;
            }
          }
        }
      }
    }

    // Optional filter: only patterns whose end is within N days from now (current relevance)
    {
      const requireCurrent = !!opts.requireCurrentInPattern;
      const defaultDaysByType = (tf: string): number => {
        if (tf === '1month') return 60; // ~2 months
        if (tf === '1week') return 21;  // ~3 weeks
        return 7; // default for daily and intraday
      };
      const maxAgeDays = Number.isFinite(opts.currentRelevanceDays as any)
        ? Number(opts.currentRelevanceDays)
        : defaultDaysByType(String(type));
      if (requireCurrent && patterns.length) {
        const nowMs = Date.now();
        const inDays = (iso?: string) => {
          if (!iso) return Infinity;
          const t = Date.parse(iso);
          if (!Number.isFinite(t)) return Infinity;
          return Math.abs(nowMs - t) / 86400000;
        };
        patterns = patterns.filter((p: any) => inDays(p?.range?.end) <= maxAgeDays);
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
        let daysToTarget: number | null = null;
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
            if (bullish && Number.isFinite(hi) && hi >= theoreticalTarget) { targetReached = true; daysToTarget = i - endIdx; break; }
            if (bearish && Number.isFinite(lo) && lo <= theoreticalTarget) { targetReached = true; daysToTarget = i - endIdx; break; }
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
          daysToTarget,
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
    // --- サイズ抑制: debug 配列を上限でトリム（view未指定で返却が肥大化しやすいため） ---
    const cap = 200;
    const debugTrimmed = {
      swings: Array.isArray(debugSwings) ? debugSwings.slice(0, cap) : [],
      candidates: Array.isArray(debugCandidates) ? debugCandidates.slice(0, cap) : [],
    };
    const out = ok(
      'patterns detected',
      { patterns, overlays: { ranges }, warnings, statistics },
      {
        pair,
        type,
        count: patterns.length,
        effective_params: { swingDepth, minBarsBetweenSwings: minDist, tolerancePct, autoScaled: !(Number.isFinite(opts.swingDepth as any) || Number.isFinite(opts.minBarsBetweenSwings as any)) },
        visualization_hints: { preferred_style: 'line', highlight_patterns: patterns.map((p: any) => p.type).slice(0, 3) },
        debug: debugTrimmed
      }
    );
    return DetectPatternsOutputSchema.parse(out) as any;
  } catch (e: any) {
    return DetectPatternsOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


