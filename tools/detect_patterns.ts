import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema, PatternTypeEnum } from '../src/schemas.js';
import { generatePatternDiagram } from '../src/utils/pattern-diagrams.js';

/**
 * detect_patterns - 過去の統計分析・バックテスト向けパターン検出
 * 
 * 設計思想:
 * - 目的: 完成したパターンを厳密に検出し、統計的に信頼性の高いデータを提供
 * - 特徴: swingDepth パラメータによる厳密なスイング検出でパターン品質を重視
 * - ブレイク検出: ATR * 0.5 バッファ、最初の明確なブレイクで終点を確定
 * - 用途: 「過去の成功率は？」「典型的な期間は？」「aftermath は？」
 * 
 * 注意: detect_forming_patterns との違い
 * - 本ツールはより厳密なスイング検出を使用するため、回帰線の傾きが異なる
 * - detect_forming_patterns はシンプルなピボット検出（前後1本比較）を使用
 * - 結果として、ブレイク日が数日ずれる場合があるが、これは設計上の意図的な違い
 * - patterns: 統計的信頼性に有利 / forming: 早期警告に有利
 */

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
    // パターンごとの最小整合度（閾値）
    const MIN_CONFIDENCE: Record<string, number> = {
      triple_top: 0.7,
      triple_bottom: 0.7,
      double_top: 0.6,
      double_bottom: 0.6,
      head_and_shoulders: 0.7,
      inverse_head_and_shoulders: 0.7,
    };
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
    // (legacy wedge window helper removed)
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
      // 判定は high/low、格納価格は close（ヒゲ影響を回避）
      if (isHigh) pivots.push({ idx: i, price: candles[i].close, kind: 'H' });
      else if (isLow) pivots.push({ idx: i, price: candles[i].close, kind: 'L' });
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
    // --- Wedge helpers (revamped) ---
    function lrWithR2(points: Array<{ x: number; y: number }>) {
      const n = points.length;
      if (n < 2) return { slope: 0, intercept: 0, r2: 0, valueAt: (x: number) => 0 };
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
      for (const p of points) {
        sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; sumY2 += p.y * p.y;
      }
      const denom = n * sumX2 - sumX * sumX || 1;
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      // R^2
      const meanY = sumY / n;
      let ssTot = 0, ssRes = 0;
      for (const p of points) {
        const yHat = slope * p.x + intercept;
        ssTot += (p.y - meanY) * (p.y - meanY);
        ssRes += (p.y - yHat) * (p.y - yHat);
      }
      const r2 = ssTot <= 0 ? 0 : Math.max(0, Math.min(1, 1 - (ssRes / ssTot)));
      const valueAt = (x: number) => slope * x + intercept;
      return { slope, intercept, r2, valueAt };
    }
    // ATR計算（ブレイク検出用）
    function calcATR(from: number, to: number, period: number = 14): number {
      const start = Math.max(1, from);
      const end = Math.max(start + 1, to);
      const tr: number[] = [];
      for (let i = start; i <= end; i++) {
        const hi = Number(candles[i]?.high ?? NaN);
        const lo = Number(candles[i]?.low ?? NaN);
        const pc = Number(candles[i - 1]?.close ?? NaN);
        if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(pc)) continue;
        const r1 = hi - lo;
        const r2 = Math.abs(hi - pc);
        const r3 = Math.abs(lo - pc);
        tr.push(Math.max(r1, r2, r3));
      }
      if (!tr.length) return 0;
      const n = Math.min(period, tr.length);
      const slice = tr.slice(-n);
      return slice.reduce((s, v) => s + v, 0) / slice.length;
    }
    // ウェッジのブレイク検出（持続的なブレイクの開始位置を検出）
    function detectWedgeBreak(
      wedgeType: 'falling_wedge' | 'rising_wedge',
      upper: { valueAt: (x: number) => number },
      lower: { valueAt: (x: number) => number },
      startIdx: number,
      endIdx: number,
      lastIdx: number,
      atr: number
    ): { detected: boolean; breakIdx: number; breakIsoTime: string | null; breakPrice: number | null } {
      // パターン形成がある程度進んでから（最低20本または期間の30%経過後）スキャン開始
      const patternBars = endIdx - startIdx;
      const scanStart = startIdx + Math.max(20, Math.floor(patternBars * 0.3));
      const scanEnd = Math.max(endIdx, lastIdx);

      // 最初にブレイクが発生した位置を記録（一度ブレイクしたらリセットしない）
      let firstBreakIdx = -1;

      for (let i = scanStart; i <= scanEnd; i++) {
        const close = Number(candles[i]?.close ?? NaN);
        if (!Number.isFinite(close)) continue;

        const uLine = upper.valueAt(i);
        const lLine = lower.valueAt(i);
        if (!Number.isFinite(uLine) || !Number.isFinite(lLine)) continue;

        if (wedgeType === 'falling_wedge') {
          // 下側ラインを実体ベースで下抜け（ATR * 0.5 バッファ）
          if (close < lLine - atr * 0.5) {
            if (firstBreakIdx === -1) {
              firstBreakIdx = i;
              break; // 最初のブレイクを見つけたら終了
            }
          }
        } else {
          // 上側ラインを実体ベースで上抜け（ATR * 0.5 バッファ）
          if (close > uLine + atr * 0.5) {
            if (firstBreakIdx === -1) {
              firstBreakIdx = i;
              break; // 最初のブレイクを見つけたら終了
            }
          }
        }
      }

      if (firstBreakIdx !== -1) {
        return {
          detected: true,
          breakIdx: firstBreakIdx,
          breakIsoTime: (candles[firstBreakIdx] as any)?.isoTime ?? null,
          breakPrice: Number(candles[firstBreakIdx]?.close ?? NaN),
        };
      }
      return { detected: false, breakIdx: -1, breakIsoTime: null, breakPrice: null };
    }
    function generateWindows(totalBars: number, minSize: number, maxSize: number, step: number): Array<{ startIdx: number; endIdx: number }> {
      const out: Array<{ startIdx: number; endIdx: number }> = [];
      for (let size = minSize; size <= maxSize; size += step) {
        for (let start = 0; start + size < totalBars; start += step) {
          out.push({ startIdx: start, endIdx: start + size });
        }
      }
      return out;
    }
    function determineWedgeType(slopeHigh: number, slopeLow: number, params: any): 'rising_wedge' | 'falling_wedge' | null {
      const minSlope = params?.minSlope ?? 0.0001;
      const maxSlope = params?.maxSlope ?? Infinity; // do not hard-reject by absolute slope magnitude
      const ratioMinRising = (params?.slopeRatioMinRising ?? 1.20);
      const ratioMinFalling = (params?.slopeRatioMinFalling ?? (params?.slopeRatioMin ?? 1.15));
      if (slopeHigh > minSlope && slopeLow > minSlope) {
        if (Math.abs(slopeLow) >= Math.abs(slopeHigh) * ratioMinRising) {
          return 'rising_wedge';
        }
      }
      if (slopeHigh < -minSlope && slopeLow < -minSlope) {
        if (Math.abs(slopeHigh) >= Math.abs(slopeLow) * ratioMinFalling) {
          return 'falling_wedge';
        }
      }
      const slopeRatio = Math.abs(slopeLow / (slopeHigh || (slopeLow * 1e-6)));
      if (slopeRatio > 0.9 && slopeRatio < 1.1) return null;
      return null;
    }
    function checkConvergenceEx(upper: any, lower: any, startIdx: number, endIdx: number) {
      const midIdx = Math.floor((startIdx + endIdx) / 2);
      const gapStart = upper.valueAt(startIdx) - lower.valueAt(startIdx);
      const gapMid = upper.valueAt(midIdx) - lower.valueAt(midIdx);
      const gapEnd = upper.valueAt(endIdx) - lower.valueAt(endIdx);
      const ratio = gapEnd / Math.max(1e-12, gapStart);
      if (!(gapEnd > 0) || !(ratio < 0.38)) return { isConverging: false };
      const firstHalf = gapStart - gapMid;
      const secondHalf = gapMid - gapEnd;
      const isAccelerating = secondHalf > firstHalf * 1.2;
      const score = Math.max(0, Math.min(1, 0.5 * (1 - ratio) + 0.3 * 1 + 0.2 * (isAccelerating ? 1 : 0)));
      return { isConverging: true, gapStart, gapMid, gapEnd, ratio, isAccelerating, score };
    }
    function evaluateTouchesEx(candles: any[], upper: any, lower: any, startIdx: number, endIdx: number) {
      let hiWin = -Infinity, loWin = Infinity;
      for (let i = startIdx; i <= endIdx; i++) { hiWin = Math.max(hiWin, Number(candles[i]?.high ?? -Infinity)); loWin = Math.min(loWin, Number(candles[i]?.low ?? Infinity)); }
      const threshold = (hiWin - loWin) * 0.01; // 1%
      const upperTouches: any[] = [], lowerTouches: any[] = [];
      for (let i = startIdx; i <= endIdx; i++) {
        const c = candles[i]; if (!c) continue;
        const u = upper.valueAt(i), l = lower.valueAt(i);
        const distU = Math.abs(c?.high - u);
        const distL = Math.abs(c?.low - l);
        if (distU < threshold && c?.high <= u + threshold) upperTouches.push({ index: i, distance: distU, isBreak: false }); else if (c?.high > u + threshold) upperTouches.push({ index: i, distance: distU, isBreak: true });
        if (distL < threshold && c?.low >= l - threshold) lowerTouches.push({ index: i, distance: distL, isBreak: false }); else if (c?.low < l - threshold) lowerTouches.push({ index: i, distance: distL, isBreak: true });
      }
      const upQ = upperTouches.filter(t => !t.isBreak).length;
      const loQ = lowerTouches.filter(t => !t.isBreak).length;
      const score = Math.max(0, Math.min(1, (upQ + loQ) / 8));
      return { upperTouches, lowerTouches, upperQuality: upQ, lowerQuality: loQ, score };
    }
    function calcAlternationScoreEx(touches: any) {
      const all = [...touches.upperTouches.map((t: any) => ({ ...t, type: 'upper' })), ...touches.lowerTouches.map((t: any) => ({ ...t, type: 'lower' }))].sort((a, b) => a.index - b.index);
      if (all.length < 2) return 0;
      let alternations = 0;
      for (let i = 1; i < all.length; i++) { if (all[i].type !== all[i - 1].type) alternations++; }
      return Math.max(0, Math.min(1, alternations / Math.max(1, all.length - 1)));
    }
    function calcInsideRatioEx(candles: any[], upper: any, lower: any, startIdx: number, endIdx: number) {
      let inside = 0, total = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        const c = candles[i]; if (!c) continue; total++;
        const u = upper.valueAt(i), l = lower.valueAt(i);
        if (c.high <= u && c.low >= l) inside++;
      }
      return total ? inside / total : 0;
    }
    function calcDurationScoreEx(bars: number, params: any) {
      const min = params?.windowSizeMin ?? 25, max = params?.windowSizeMax ?? 90;
      if (bars < min) return 0;
      if (bars > max) return 0;
      const mid = (min + max) / 2;
      const dist = Math.abs(bars - mid) / Math.max(1, (max - min) / 2);
      return Math.max(0, Math.min(1, 1 - dist));
    }
    function calculatePatternScoreEx(components: any, weights?: any) {
      // Emphasize touch count; slightly reduce fit/converge; keep others modest.
      const w = weights || { fit: 0.25, converge: 0.25, touch: 0.35, alternation: 0.07, inside: 0.05, duration: 0.03 };
      return (
        w.fit * components.fitScore +
        w.converge * components.convergeScore +
        w.touch * components.touchScore +
        w.alternation * components.alternationScore +
        w.inside * components.insideScore +
        w.duration * components.durationScore
      );
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
      const minDistDB = 3; // ダブル系はより短期を許容
      for (let i = 0; i < pivots.length - 3; i++) {
        const a = pivots[i];
        const b = pivots[i + 1];
        const c = pivots[i + 2];
        if (b.idx - a.idx < minDistDB || c.idx - b.idx < minDistDB) continue;
        // サイズ下限フィルタ（3%未満は除外）
        if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H') {
          const patternHeight = Math.abs(a.price - b.price);
          const heightPct = patternHeight / Math.max(1, Math.max(a.price, b.price));
          if (heightPct < 0.03) { pushCand({ type: 'double_top', accepted: false, reason: 'pattern_too_small', idxs: [a.idx, b.idx, c.idx] }); continue; }
        }
        // double top: H-L-H with H~H + ネックライン下抜け（終値ベース1.5%バッファ）必須
        if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H' && near(a.price, c.price)) {
          const necklinePrice = b.price;
          const breakoutBuffer = 0.015;
          let breakoutIdx = -1;
          // 山2から最大20本以内にネックライン下抜けが必要
          const maxBarsFromPeak2 = 20;
          for (let k = c.idx + 1; k < Math.min(c.idx + maxBarsFromPeak2 + 1, candles.length); k++) {
            const closeK = Number(candles[k]?.close ?? NaN);
            if (Number.isFinite(closeK) && closeK < necklinePrice * (1 - breakoutBuffer)) {
              breakoutIdx = k;
              break;
            }
          }
          if (breakoutIdx >= 0) {
            const start = candles[a.idx].isoTime;
            const end = candles[breakoutIdx].isoTime; // 完成＝ブレイク時点
            if (start && end) {
              const neckline = [
                { x: a.idx, y: necklinePrice },
                { x: breakoutIdx, y: necklinePrice }, // ブレイク地点まで延長
              ];
              const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolerancePct);
              const symmetry = clamp01(1 - relDev(a.price, c.price));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base, 'double_top');
              // 構造図（ダブルトップ）
              const diagram = generatePatternDiagram(
                'double_top',
                [
                  { ...a, date: (candles[a.idx] as any)?.isoTime },
                  { ...b, date: (candles[b.idx] as any)?.isoTime },
                  { ...c, date: (candles[c.idx] as any)?.isoTime },
                ],
                { price: necklinePrice },
                { start, end }
              );
              push(patterns, { type: 'double_top', confidence, range: { start, end }, pivots: [a, b, c], neckline, breakout: { idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) }, structureDiagram: diagram });
              foundDoubleTop = true;
              pushCand({
                type: 'double_top',
                accepted: true,
                idxs: [a.idx, b.idx, c.idx, breakoutIdx],
                pts: [
                  { role: 'peak1', idx: a.idx, price: a.price },
                  { role: 'valley', idx: b.idx, price: b.price },
                  { role: 'peak2', idx: c.idx, price: c.price },
                  { role: 'breakout', idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) },
                ]
              });
            }
          } else {
            // ネックライン未下抜け → 完成パターンとしては不採用（forming側で扱う）
            pushCand({ type: 'double_top', accepted: false, reason: 'no_breakout', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'valley', idx: b.idx, price: b.price }, { role: 'peak2', idx: c.idx, price: c.price }] });
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
        if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L') {
          const patternHeight = Math.abs(a.price - b.price);
          const heightPct = patternHeight / Math.max(1, Math.max(a.price, b.price));
          if (heightPct < 0.03) { pushCand({ type: 'double_bottom', accepted: false, reason: 'pattern_too_small', idxs: [a.idx, b.idx, c.idx] }); continue; }
        }
        if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L' && near(a.price, c.price)) {
          // ネックライン突破（終値ベース＋1.5%バッファ）を c 以降で確認
          const necklinePrice = b.price;
          const breakoutBuffer = 0.015;
          let breakoutIdx = -1;
          // 谷2から最大20本以内にネックライン上抜けが必要
          const maxBarsFromValley2 = 20;
          for (let k = c.idx + 1; k < Math.min(c.idx + maxBarsFromValley2 + 1, candles.length); k++) {
            const closeK = Number(candles[k]?.close ?? NaN);
            if (Number.isFinite(closeK) && closeK > necklinePrice * (1 + breakoutBuffer)) {
              breakoutIdx = k;
              break;
            }
          }
          if (breakoutIdx >= 0) {
            const start = candles[a.idx].isoTime;
            const end = candles[breakoutIdx].isoTime; // 完成＝ブレイク時点
            if (start && end) {
              // ネックラインはブレイク地点まで延長
              const neckline = [
                { x: a.idx, y: necklinePrice },
                { x: breakoutIdx, y: necklinePrice },
              ];
              const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolerancePct);
              const symmetry = clamp01(1 - relDev(a.price, c.price));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base, 'double_bottom');
              // 構造図（ダブルボトム）
              const diagram = generatePatternDiagram(
                'double_bottom',
                [
                  { ...a, date: (candles[a.idx] as any)?.isoTime },
                  { ...b, date: (candles[b.idx] as any)?.isoTime },
                  { ...c, date: (candles[c.idx] as any)?.isoTime },
                ],
                { price: necklinePrice },
                { start, end }
              );
              push(patterns, {
                type: 'double_bottom',
                confidence,
                range: { start, end },
                pivots: [a, b, c],
                neckline,
                breakout: { idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) },
                structureDiagram: diagram
              });
              foundDoubleBottom = true;
              pushCand({ type: 'double_bottom', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'peak', idx: b.idx, price: b.price }, { role: 'valley2', idx: c.idx, price: c.price }] });
            }
          } else {
            // ネックライン未突破 → 完成パターンとしては不採用（forming側で扱う）
            pushCand({ type: 'double_bottom', accepted: false, reason: 'no_breakout', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'peak', idx: b.idx, price: b.price }, { role: 'valley2', idx: c.idx, price: c.price }] });
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
            if (b.idx - a.idx < minDistDB || c.idx - b.idx < minDistDB) continue;
            // サイズ下限フィルタ（3%未満は除外）
            {
              const patternHeight = Math.abs(a.price - b.price);
              const heightPct = patternHeight / Math.max(1, Math.max(a.price, b.price));
              if (heightPct < 0.03) { pushCand({ type: 'double_top', accepted: false, reason: 'pattern_too_small', idxs: [a.idx, b.idx, c.idx] }); continue; }
            }
            if (!nearRelaxed(a.price, c.price)) { pushCand({ type: 'double_top', accepted: false, reason: 'peaks_not_equal_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'peak2', idx: c.idx, price: c.price }] }); continue; }
            // 緩和判定でもネックライン下抜け必須
            const necklinePrice = b.price;
            const breakoutBuffer = 0.015;
            let breakoutIdx = -1;
            // 山2から最大20本以内にネックライン下抜けが必要（緩和）
            const maxBarsFromPeak2 = 20;
            for (let k = c.idx + 1; k < Math.min(c.idx + maxBarsFromPeak2 + 1, candles.length); k++) {
              const closeK = Number(candles[k]?.close ?? NaN);
              if (Number.isFinite(closeK) && closeK < necklinePrice * (1 - breakoutBuffer)) {
                breakoutIdx = k;
                break;
              }
            }
            if (breakoutIdx >= 0) {
              const start = candles[a.idx].isoTime, end = candles[breakoutIdx].isoTime;
              if (!start || !end) continue;
              const neckline = [{ x: a.idx, y: necklinePrice }, { x: breakoutIdx, y: necklinePrice }];
              const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolRelax);
              const symmetry = clamp01(1 - relDev(a.price, c.price));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base * 0.95, 'double_top');
              const diagram = generatePatternDiagram(
                'double_top',
                [
                  { ...a, date: (candles[a.idx] as any)?.isoTime },
                  { ...b, date: (candles[b.idx] as any)?.isoTime },
                  { ...c, date: (candles[c.idx] as any)?.isoTime },
                ],
                { price: necklinePrice },
                { start, end }
              );
              push(patterns, { type: 'double_top', confidence, range: { start, end }, pivots: [a, b, c], neckline, breakout: { idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) }, structureDiagram: diagram, _fallback: `relaxed_double_x${f}` });
              foundDoubleTop = true;
              break;
            } else {
              pushCand({ type: 'double_top', accepted: false, reason: 'no_breakout_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'valley', idx: b.idx, price: b.price }, { role: 'peak2', idx: c.idx, price: c.price }] });
            }
          }
        }
        if (!foundDoubleBottom && (want.size === 0 || want.has('double_bottom'))) {
          const tolRelax = tolerancePct * f;
          const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;
          for (let i = 0; i < pivots.length - 3; i++) {
            const a = pivots[i], b = pivots[i + 1], c = pivots[i + 2];
            if (!(a.kind === 'L' && b.kind === 'H' && c.kind === 'L')) continue;
            if (b.idx - a.idx < minDistDB || c.idx - b.idx < minDistDB) continue;
            // サイズ下限フィルタ（3%未満は除外）
            {
              const patternHeight = Math.abs(a.price - b.price);
              const heightPct = patternHeight / Math.max(1, Math.max(a.price, b.price));
              if (heightPct < 0.03) { pushCand({ type: 'double_bottom', accepted: false, reason: 'pattern_too_small', idxs: [a.idx, b.idx, c.idx] }); continue; }
            }
            if (!nearRelaxed(a.price, c.price)) { pushCand({ type: 'double_bottom', accepted: false, reason: 'valleys_not_equal_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'valley2', idx: c.idx, price: c.price }] }); continue; }
            // 緩和判定でもネックライン突破必須
            const necklinePrice = b.price;
            const breakoutBuffer = 0.015;
            let breakoutIdx = -1;
            // 谷2から最大20本以内にネックライン上抜けが必要（緩和）
            const maxBarsFromValley2 = 20;
            for (let k = c.idx + 1; k < Math.min(c.idx + maxBarsFromValley2 + 1, candles.length); k++) {
              const closeK = Number(candles[k]?.close ?? NaN);
              if (Number.isFinite(closeK) && closeK > necklinePrice * (1 + breakoutBuffer)) {
                breakoutIdx = k;
                break;
              }
            }
            if (breakoutIdx >= 0) {
              const start = candles[a.idx].isoTime, end = candles[breakoutIdx].isoTime;
              if (!start || !end) continue;
              const neckline = [{ x: a.idx, y: necklinePrice }, { x: breakoutIdx, y: necklinePrice }];
              const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolRelax);
              const symmetry = clamp01(1 - relDev(a.price, c.price));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base * 0.95, 'double_bottom');
              const diagram = generatePatternDiagram(
                'double_bottom',
                [
                  { ...a, date: (candles[a.idx] as any)?.isoTime },
                  { ...b, date: (candles[b.idx] as any)?.isoTime },
                  { ...c, date: (candles[c.idx] as any)?.isoTime },
                ],
                { price: necklinePrice },
                { start, end }
              );
              push(patterns, { type: 'double_bottom', confidence, range: { start, end }, pivots: [a, b, c], neckline, breakout: { idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) }, structureDiagram: diagram, _fallback: `relaxed_double_x${f}` });
              foundDoubleBottom = true;
              break;
            } else {
              pushCand({ type: 'double_bottom', accepted: false, reason: 'no_breakout_relaxed', idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'peak', idx: b.idx, price: b.price }, { role: 'valley2', idx: c.idx, price: c.price }] });
            }
          }
        }
      }
      // --- 重複パターンの排除（同型で期間重複>50%の中から最良を採用） ---
      function deduplicatePatterns(arr: any[]): any[] {
        const result: any[] = [];
        for (const pattern of arr) {
          if (!pattern?.type || !pattern?.range?.start || !pattern?.range?.end) { result.push(pattern); continue; }
          const overlapping = result.filter((existing: any) => {
            if (existing?.type !== pattern.type) return false;
            const existingStart = Date.parse(existing.range.start);
            const existingEnd = Date.parse(existing.range.end);
            const patternStart = Date.parse(pattern.range.start);
            const patternEnd = Date.parse(pattern.range.end);
            if (!Number.isFinite(existingStart) || !Number.isFinite(existingEnd) || !Number.isFinite(patternStart) || !Number.isFinite(patternEnd)) return false;
            const overlapStart = Math.max(existingStart, patternStart);
            const overlapEnd = Math.min(existingEnd, patternEnd);
            const overlapDuration = Math.max(0, overlapEnd - overlapStart);
            const existingDuration = Math.max(1, existingEnd - existingStart);
            const patternDuration = Math.max(1, patternEnd - patternStart);
            const minDuration = Math.min(existingDuration, patternDuration);
            return overlapDuration / minDuration > 0.5;
          });
          if (overlapping.length === 0) {
            result.push(pattern);
          } else {
            const allCandidates = [...overlapping, pattern];
            // 1) 鮮度: range.end が最も遅い
            const maxEndTime = Math.max(...allCandidates.map((p: any) => Date.parse(p.range.end)));
            let best = allCandidates.filter((p: any) => Date.parse(p.range.end) === maxEndTime);
            // 2) パターン整合度
            if (best.length > 1) {
              const maxConfidence = Math.max(...best.map((p: any) => Number(p.confidence ?? 0)));
              best = best.filter((p: any) => Number(p.confidence ?? 0) === maxConfidence);
            }
            // 3) 規模（高さ）
            if (best.length > 1) {
              const getHeight = (p: any) => {
                const piv = Array.isArray(p?.pivots) ? p.pivots : [];
                if (p?.type === 'double_top' && piv.length >= 3) {
                  const peak = Math.max(Number(piv[0]?.price ?? 0), Number(piv[2]?.price ?? 0));
                  const valley = Number(piv[1]?.price ?? peak);
                  return Math.max(0, peak - valley);
                }
                if (p?.type === 'double_bottom' && piv.length >= 3) {
                  const valley = Math.min(Number(piv[0]?.price ?? Infinity), Number(piv[2]?.price ?? Infinity));
                  const peak = Number(piv[1]?.price ?? valley);
                  return Math.max(0, peak - valley);
                }
                return 0;
              };
              const maxHeight = Math.max(...best.map(getHeight));
              best = best.filter((p: any) => getHeight(p) === maxHeight);
            }
            const chosen = best[0];
            const toRemove = overlapping.filter((p: any) => p !== chosen);
            for (const rem of toRemove) {
              const idx = result.indexOf(rem);
              if (idx >= 0) result.splice(idx, 1);
            }
            if (!result.includes(chosen)) result.push(chosen);
          }
        }
        return result;
      }
      patterns = deduplicatePatterns(patterns);
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
            // 構造図（逆三尊）
            const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
            const diagram = generatePatternDiagram(
              'inverse_head_and_shoulders',
              [
                { ...p0, date: (candles[p0.idx] as any)?.isoTime },
                { ...p1, date: (candles[p1.idx] as any)?.isoTime },
                { ...p2, date: (candles[p2.idx] as any)?.isoTime },
                { ...p3, date: (candles[p3.idx] as any)?.isoTime },
                { ...p4, date: (candles[p4.idx] as any)?.isoTime },
              ],
              { price: nlAvg },
              { start, end }
            );
            push(patterns, { type: 'inverse_head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline, structureDiagram: diagram });
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
            const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
            const diagram = generatePatternDiagram(
              'head_and_shoulders',
              [
                { ...p0, date: (candles[p0.idx] as any)?.isoTime },
                { ...p1, date: (candles[p1.idx] as any)?.isoTime },
                { ...p2, date: (candles[p2.idx] as any)?.isoTime },
                { ...p3, date: (candles[p3.idx] as any)?.isoTime },
                { ...p4, date: (candles[p4.idx] as any)?.isoTime },
              ],
              { price: nlAvg },
              { start, end }
            );
            push(patterns, { type: 'head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline, structureDiagram: diagram });
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
          const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
          const diagram = generatePatternDiagram(
            'head_and_shoulders',
            [
              { ...p0, date: (candles[p0.idx] as any)?.isoTime },
              { ...p1, date: (candles[p1.idx] as any)?.isoTime },
              { ...p2, date: (candles[p2.idx] as any)?.isoTime },
              { ...p3, date: (candles[p3.idx] as any)?.isoTime },
              { ...p4, date: (candles[p4.idx] as any)?.isoTime },
            ],
            { price: nlAvg },
            { start, end }
          );
          push(patterns, { type: 'head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline, structureDiagram: diagram, _fallback: `relaxed_hs_${factors.tag}` });
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
            const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
            const diagram = generatePatternDiagram(
              'inverse_head_and_shoulders',
              [
                { ...p0, date: (candles[p0.idx] as any)?.isoTime },
                { ...p1, date: (candles[p1.idx] as any)?.isoTime },
                { ...p2, date: (candles[p2.idx] as any)?.isoTime },
                { ...p3, date: (candles[p3.idx] as any)?.isoTime },
                { ...p4, date: (candles[p4.idx] as any)?.isoTime },
              ],
              { price: nlAvg },
              { start, end }
            );
            push(patterns, { type: 'inverse_head_and_shoulders', confidence, range: { start, end }, pivots: [p0, p1, p2, p3, p4], neckline, structureDiagram: diagram, _fallback: `relaxed_ihs_${factors.tag}` });
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
        want.has('triangle_symmetrical');
      if (wantTriangle) {
        const highs = pivots.filter(p => p.kind === 'H');
        const lows = pivots.filter(p => p.kind === 'L');
        const WIN = getTriangleWindowSize(type);
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
            // Guard: same-direction slopes → likely wedge; skip triangle classification
            if ((hiLine.slope * loLine.slope) > 0) {
              debugCandidates.push({
                type: 'triangle_symmetrical' as any,
                accepted: false,
                reason: 'same_direction_slopes_skip_for_wedge',
                indices: [startIdx, endIdx],
                details: { hiSlope: hiLine.slope, loSlope: loLine.slope }
              });
              continue;
            }
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
            // (legacy wedge detection removed; revamped scanner runs later)
          }
        }
        // for-loop end
      }
    }

    // 4b) Revamped Wedge scanning (rising/falling)
    {
      const params = {
        swingDepth,
        minBarsBetweenSwings: minDist,
        tolerancePct,
        windowSizeMin: 25,
        windowSizeMax: 90,
        windowStep: 5,
        minSlope: 0.00005,
        maxSlope: 0.08,
        slopeRatioMin: 1.15,
        slopeRatioMinRising: 1.20,
        minTouchesPerLine: 2,
        minScore: 0.5,
      };
      const swings = {
        highs: pivots.filter(p => p.kind === 'H').map(p => ({ index: p.idx, price: p.price })),
        lows: pivots.filter(p => p.kind === 'L').map(p => ({ index: p.idx, price: p.price })),
      };
      const allowRising = (want.size === 0) || want.has('rising_wedge' as any);
      const allowFalling = (want.size === 0) || want.has('falling_wedge' as any);
      const windows = generateWindows(candles.length, params.windowSizeMin, params.windowSizeMax, params.windowStep);
      for (const w of windows) {
        const highsIn = swings.highs.filter(s => s.index >= w.startIdx && s.index <= w.endIdx);
        const lowsIn = swings.lows.filter(s => s.index >= w.startIdx && s.index <= w.endIdx);
        if (highsIn.length < 3 || lowsIn.length < 3) continue;
        const upper = lrWithR2(highsIn.map(s => ({ x: s.index, y: s.price })));
        const lower = lrWithR2(lowsIn.map(s => ({ x: s.index, y: s.price })));
        if (upper.r2 < 0.25 || lower.r2 < 0.25) {
          // Debug: R^2不足で却下
          const dbgType = (upper.slope < 0 && lower.slope < 0) ? 'falling_wedge' : ((upper.slope > 0 && lower.slope > 0) ? 'rising_wedge' : 'triangle_symmetrical');
          debugCandidates.push({
            type: dbgType as any,
            accepted: false,
            reason: 'r2_below_threshold',
            indices: [w.startIdx, w.endIdx],
            details: { r2High: upper.r2, r2Low: lower.r2, slopeHigh: upper.slope, slopeLow: lower.slope, r2MinRequired: 0.25 }
          });
          continue;
        }
        // Phase 1: Rising Wedge の「有意な上昇」チェック（動的なしきい値）
        if (upper.slope > 0 && lower.slope > 0) {
          let hiMax = -Infinity, loMin = Infinity;
          for (let i = w.startIdx; i <= w.endIdx; i++) {
            const hi = Number(candles[i]?.high ?? NaN);
            const lo = Number(candles[i]?.low ?? NaN);
            if (Number.isFinite(hi)) hiMax = Math.max(hiMax, hi);
            if (Number.isFinite(lo)) loMin = Math.min(loMin, lo);
          }
          const priceRange = Number.isFinite(hiMax) && Number.isFinite(loMin) ? (hiMax - loMin) : 0;
          const barsSpan = Math.max(1, w.endIdx - w.startIdx);
          const minMeaningfulSlope = (priceRange * 0.01) / barsSpan; // 期間中に価格レンジの1%以上
          const absHi = Math.abs(upper.slope);
          const absLo = Math.abs(lower.slope);
          // 汎用プローブ: 指定窓群で詳細情報を出す
          const probeWindows: Array<[number, number]> = [
            [105, 175], [140, 210], [140, 225], [135, 225], [140, 230]
          ];
          const isProbe = probeWindows.some(([s, e]) => s === w.startIdx && e === w.endIdx);
          if (isProbe) {
            const highsArr = highsIn.map(s => ({ index: s.index, price: s.price }));
            const lowsArr = lowsIn.map(s => ({ index: s.index, price: s.price }));
            const slopeRatioLH = absLo / Math.max(1e-12, absHi);
            const firstHalfProbe = highsIn.slice(0, Math.floor(highsIn.length / 2));
            const secondHalfProbe = highsIn.slice(Math.floor(highsIn.length / 2));
            const firstAvgProbe = firstHalfProbe.reduce((s, p) => s + Number(p.price), 0) / Math.max(1, firstHalfProbe.length);
            const secondAvgProbe = secondHalfProbe.reduce((s, p) => s + Number(p.price), 0) / Math.max(1, secondHalfProbe.length);
            const ratioProbe = Number((secondAvgProbe / Math.max(1e-12, firstAvgProbe)).toFixed(4));
            debugCandidates.unshift({
              type: 'rising_wedge' as any,
              accepted: false,
              reason: 'rising_probe',
              indices: [w.startIdx, w.endIdx],
              details: {
                highsCount: highsIn.length,
                r2High: upper.r2, r2Low: lower.r2,
                slopeHigh: upper.slope, slopeLow: lower.slope,
                slopeRatioLH,
                priceRange, barsSpan, minMeaningfulSlope,
                firstAvg: firstAvgProbe, secondAvg: secondAvgProbe, ratio: ratioProbe,
                highsIn: highsArr, lowsIn: lowsArr
              }
            });
          }
          // 指定窓の詳細プローブ（5/21-8/19 などの検証用）
          if (w.startIdx === 105 && w.endIdx === 175) {
            const highsArr = highsIn.map(s => ({ index: s.index, price: s.price }));
            const lowsArr = lowsIn.map(s => ({ index: s.index, price: s.price }));
            // 先頭に挿入して cap=200 に切られないようにする
            debugCandidates.unshift({
              type: 'rising_wedge' as any,
              accepted: false,
              reason: 'probe_window',
              indices: [w.startIdx, w.endIdx],
              details: { slopeHigh: upper.slope, slopeLow: lower.slope, hiSlope: upper.slope, loSlope: lower.slope, priceRange, barsSpan, minMeaningfulSlope, highsIn: highsArr, lowsIn: lowsArr }
            });
          }
          if (absHi < minMeaningfulSlope) {
            debugCandidates.push({
              type: 'rising_wedge' as any,
              accepted: false,
              reason: 'upper_line_barely_rising',
              indices: [w.startIdx, w.endIdx],
              details: { slopeHigh: upper.slope, slopeLow: lower.slope, minMeaningfulSlope, priceRange, barsSpan }
            });
            continue;
          }
          // 新規: 高値トレンドチェック（後半の平均高値が前半の99%未満なら切り下がりとして却下）
          if (highsIn.length >= 3) {
            const mid = Math.floor(highsIn.length / 2);
            const firstHalf = highsIn.slice(0, mid);
            const secondHalf = highsIn.slice(mid);
            const firstAvg = firstHalf.reduce((s, p) => s + Number(p.price), 0) / Math.max(1, firstHalf.length);
            const secondAvg = secondHalf.reduce((s, p) => s + Number(p.price), 0) / Math.max(1, secondHalf.length);
            const ratio = Number((secondAvg / Math.max(1e-12, firstAvg)).toFixed(4));
            // デバッグ用プローブ（対象窓の場合は必ずログ）
            if (w.startIdx === 105 && w.endIdx === 175) {
              debugCandidates.unshift({
                type: 'rising_wedge' as any,
                accepted: false,
                reason: 'declining_highs_probe',
                indices: [w.startIdx, w.endIdx],
                details: { highsCount: highsIn.length, firstAvg, secondAvg, ratio }
              });
            }
            if (Number.isFinite(firstAvg) && Number.isFinite(secondAvg) && ratio < 0.99) {
              debugCandidates.push({
                type: 'rising_wedge' as any,
                accepted: false,
                reason: 'declining_highs',
                indices: [w.startIdx, w.endIdx],
                details: { firstAvg, secondAvg, ratio }
              });
              continue;
            }
          }
        }
        const wedgeType = determineWedgeType(upper.slope, lower.slope, params);
        if (!wedgeType) {
          const absHi = Math.abs(upper.slope);
          const absLo = Math.abs(lower.slope);
          const slopeRatioHL = absHi / Math.max(1e-12, absLo);
          const slopeRatioLH = absLo / Math.max(1e-12, absHi);
          let failureReason: 'slope_ratio_too_small' | 'slopes_too_flat' | 'wrong_side_steeper' = 'slope_ratio_too_small';
          if ((upper.slope > 0 && lower.slope > 0)) {
            // rising wedge候補: 下側が急、absLo/absHi > ratioMin
            if (absHi < (params.minSlope ?? 0.0001) || absLo < (params.minSlope ?? 0.0001)) {
              failureReason = 'slopes_too_flat';
            } else if (!(absLo > absHi)) {
              failureReason = 'wrong_side_steeper';
            } else if (!(slopeRatioLH > (params.slopeRatioMinRising ?? 1.20))) {
              failureReason = 'slope_ratio_too_small';
            }
          } else if ((upper.slope < 0 && lower.slope < 0)) {
            // falling wedge候補: 上側が急、absHi/absLo > ratioMin
            if (absHi < (params.minSlope ?? 0.0001) || absLo < (params.minSlope ?? 0.0001)) {
              failureReason = 'slopes_too_flat';
            } else if (!(absHi > absLo)) {
              failureReason = 'wrong_side_steeper';
            } else if (!(slopeRatioHL > (((params as any).slopeRatioMinFalling ?? (params.slopeRatioMin ?? 1.15))))) {
              failureReason = 'slope_ratio_too_small';
            }
          } else {
            // 逆向き（ウェッジの対象外）→ 比率不足扱いに寄せる
            failureReason = 'slope_ratio_too_small';
          }
          const dbgType = (upper.slope < 0 && lower.slope < 0) ? 'falling_wedge' : ((upper.slope > 0 && lower.slope > 0) ? 'rising_wedge' : 'triangle_symmetrical');
          debugCandidates.push({
            type: dbgType as any,
            accepted: false,
            reason: 'type_classification_failed',
            indices: [w.startIdx, w.endIdx],
            details: {
              slopeHigh: upper.slope,
              slopeLow: lower.slope,
              slopeRatio: Number((Math.abs(upper.slope) / Math.max(1e-12, Math.abs(lower.slope))).toFixed(4)),
              minSlope: (params.minSlope ?? 0.0001),
              maxSlope: (params.maxSlope ?? 0.05),
              slopeRatioMin: (dbgType === 'rising_wedge'
                ? (params.slopeRatioMinRising ?? 1.20)
                : (((params as any).slopeRatioMinFalling ?? (params.slopeRatioMin ?? 1.15)))),
              failureReason
            }
          });
          continue;
        }
        // リクエストされていないタイプは以降を評価しない
        if ((wedgeType === 'rising_wedge' && !allowRising) || (wedgeType === 'falling_wedge' && !allowFalling)) {
          debugCandidates.push({
            type: wedgeType as any,
            accepted: false,
            reason: 'type_not_requested',
            indices: [w.startIdx, w.endIdx]
          });
          continue;
        }
        const conv = checkConvergenceEx(upper, lower, w.startIdx, w.endIdx);
        if (!conv.isConverging) {
          debugCandidates.push({
            type: wedgeType as any,
            accepted: false,
            reason: 'convergence_failed',
            indices: [w.startIdx, w.endIdx],
            details: { gapStart: conv.gapStart, gapEnd: conv.gapEnd, ratio: conv.ratio, isAccelerating: conv.isAccelerating }
          });
          continue;
        }
        const touches = evaluateTouchesEx(candles as any, upper, lower, w.startIdx, w.endIdx);
        if (touches.upperQuality < (params.minTouchesPerLine ?? 2) || touches.lowerQuality < (params.minTouchesPerLine ?? 2)) {
          debugCandidates.push({
            type: wedgeType as any,
            accepted: false,
            reason: 'insufficient_touches',
            indices: [w.startIdx, w.endIdx],
            details: { upperTouches: touches.upperQuality, lowerTouches: touches.lowerQuality, minRequired: (params.minTouchesPerLine ?? 2) }
          });
          continue;
        }
        const alternation = calcAlternationScoreEx(touches);
        // 上下タッチのバランスチェック（極端な偏りを除外）
        {
          const upQ = Number(touches?.upperQuality ?? 0);
          const loQ = Number(touches?.lowerQuality ?? 0);
          const denom = Math.max(upQ, loQ, 1);
          const touchBalance = Math.min(upQ, loQ) / denom;
          const minTouchBalance = 0.45;
          if (touchBalance < minTouchBalance) {
            debugCandidates.push({
              type: wedgeType as any,
              accepted: false,
              reason: 'unbalanced_touches',
              indices: [w.startIdx, w.endIdx],
              details: {
                upperTouches: upQ,
                lowerTouches: loQ,
                balance: Number(touchBalance.toFixed(3)),
                minRequired: minTouchBalance
              }
            });
            continue;
          }
        }
        const insideRatio = calcInsideRatioEx(candles as any, upper, lower, w.startIdx, w.endIdx);
        const score = calculatePatternScoreEx({
          fitScore: (upper.r2 + lower.r2) / 2,
          convergeScore: conv.score,
          touchScore: touches.score,
          alternationScore: alternation,
          insideScore: insideRatio,
          durationScore: calcDurationScoreEx(w.endIdx - w.startIdx, params),
        });
        // 最低交互性の基準を一時無効化
        // {
        //   const minAlternation = 0.3;
        //   if (Number(alternation ?? 0) < minAlternation) {
        //     debugCandidates.push({
        //       type: wedgeType as any,
        //       accepted: false,
        //       reason: 'insufficient_alternation',
        //       indices: [w.startIdx, w.endIdx],
        //       details: {
        //         alternation: Number((alternation ?? 0).toFixed(3)),
        //         minRequired: minAlternation,
        //         upperTouches: Number(touches?.upperQuality ?? 0),
        //         lowerTouches: Number(touches?.lowerQuality ?? 0),
        //       }
        //     });
        //     continue;
        //   }
        // }
        if (score < (params.minScore ?? 0.6)) {
          debugCandidates.push({
            type: wedgeType as any,
            accepted: false,
            reason: 'score_below_threshold',
            indices: [w.startIdx, w.endIdx],
            details: {
              score: Number(score.toFixed(3)),
              minScore: (params.minScore ?? 0.6),
              components: {
                fit: Number(((upper.r2 + lower.r2) / 2).toFixed(3)),
                converge: Number((conv.score ?? 0).toFixed(3)),
                touch: Number((touches.score ?? 0).toFixed(3)),
                alternation: Number((alternation ?? 0).toFixed(3)),
                inside: Number((insideRatio ?? 0).toFixed(3)),
                duration: Number((calcDurationScoreEx(w.endIdx - w.startIdx, params)).toFixed(3))
              }
            }
          });
          continue;
        }
        const start = (candles[w.startIdx] as any)?.isoTime;
        const theoreticalEnd = (candles[w.endIdx] as any)?.isoTime;
        if (!start || !theoreticalEnd) continue;

        // ブレイク検出
        const lastIdx = candles.length - 1;
        const atr = calcATR(w.startIdx, w.endIdx, 14);
        const breakInfo = detectWedgeBreak(wedgeType, upper, lower, w.startIdx, w.endIdx, lastIdx, atr);


        // 終点: ブレイクが検出された場合はブレイク日、そうでなければウィンドウ終端
        const actualEndIdx = breakInfo.detected ? breakInfo.breakIdx : w.endIdx;
        const end = (candles[actualEndIdx] as any)?.isoTime ?? theoreticalEnd;

        // ブレイク方向の判定
        let breakoutDirection: 'up' | 'down' | null = null;
        if (breakInfo.detected && Number.isFinite(breakInfo.breakPrice)) {
          const breakPrice = breakInfo.breakPrice as number;
          const lLineAtBreak = lower.valueAt(breakInfo.breakIdx);
          const uLineAtBreak = upper.valueAt(breakInfo.breakIdx);
          if (breakPrice < lLineAtBreak - atr * 0.3) {
            breakoutDirection = 'down';
          } else if (breakPrice > uLineAtBreak + atr * 0.3) {
            breakoutDirection = 'up';
          }
        }

        const confidence = Math.max(0, Math.min(1, Number(score.toFixed(2))));
        // ダイアグラム用にタッチポイントから主要点を間引きして pivots を構成
        const upTouchPts = (touches.upperTouches || []).filter((t: any) => !t.isBreak).map((t: any) => ({ idx: t.index, kind: 'H' as const }));
        const loTouchPts = (touches.lowerTouches || []).filter((t: any) => !t.isBreak).map((t: any) => ({ idx: t.index, kind: 'L' as const }));
        const allPts = [...upTouchPts, ...loTouchPts].sort((a, b) => a.idx - b.idx);
        const downsample = (pts: Array<{ idx: number; kind: 'H' | 'L' }>, maxPoints = 6) => {
          if (pts.length <= maxPoints) return pts;
          const out: typeof pts = [];
          const lastIdxPts = pts.length - 1;
          for (let i = 0; i < maxPoints; i++) {
            const pos = Math.round((i / Math.max(1, maxPoints - 1)) * lastIdxPts);
            out.push(pts[pos]);
          }
          // 重複を除去（同じ idx が選ばれた場合）
          return out.filter((p, i, arr) => arr.findIndex(q => q.idx === p.idx && q.kind === p.kind) === i);
        };
        const sel = downsample(allPts, 6);
        const pivForDiagram = sel.map(p => ({
          idx: p.idx,
          price: Number(candles[p.idx]?.close ?? NaN),
          kind: p.kind,
          date: (candles[p.idx] as any)?.isoTime
        }));
        let diagram: any = undefined;
        try {
          diagram = generatePatternDiagram(
            wedgeType,
            pivForDiagram,
            { price: 0 }, // ウェッジでは未使用
            { start, end }
          );
        } catch { /* noop */ }

        // aftermath情報（ブレイク後の結果）
        // falling_wedge: 上方ブレイクが成功、下方ブレイクは失敗
        // rising_wedge: 下方ブレイクが成功、上方ブレイクは失敗
        const isSuccessfulBreakout = breakInfo.detected ? (
          wedgeType === 'falling_wedge'
            ? breakoutDirection === 'up'
            : breakoutDirection === 'down'
        ) : false;

        const aftermath = breakInfo.detected ? {
          breakoutDate: breakInfo.breakIsoTime,
          breakoutConfirmed: true,
          targetReached: false, // TODO: 目標価格到達の判定を追加
          outcome: isSuccessfulBreakout
            ? (wedgeType === 'falling_wedge' ? 'bullish_breakout' : 'bearish_breakout')
            : (wedgeType === 'falling_wedge' ? 'bearish_breakdown' : 'bullish_breakdown'),
        } : undefined;

        push(patterns, {
          type: wedgeType,
          confidence,
          range: { start, end },
          ...(aftermath ? { aftermath } : {}),
          ...(diagram ? { structureDiagram: diagram } : {})
        });
        debugCandidates.push({
          type: wedgeType,
          accepted: true,
          reason: 'revamped_ok',
          indices: [w.startIdx, actualEndIdx],
          details: {
            slopeHigh: upper.slope, slopeLow: lower.slope, r2High: upper.r2, r2Low: lower.r2,
            converge: conv, touches: { up: touches.upperQuality, lo: touches.lowerQuality }, alternation, insideRatio, score,
            breakInfo: breakInfo.detected ? { ...breakInfo, direction: breakoutDirection } : null
          }
        });
      }
    }

    // 最終整合性フィルタは撤回（ウェッジの定義は収束・傾き関係で十分とする）

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

    // 5b) Global deduplication across types by time overlap and confidence
    {
      function toMs(iso?: string): number {
        try { const t = Date.parse(String(iso)); return Number.isFinite(t) ? t : NaN; } catch { return NaN; }
      }
      function overlapRatio(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
        const as = toMs(aStart), ae = toMs(aEnd), bs = toMs(bStart), be = toMs(bEnd);
        if (!Number.isFinite(as) || !Number.isFinite(ae) || !Number.isFinite(bs) || !Number.isFinite(be)) return 0;
        const os = Math.max(as, bs);
        const oe = Math.min(ae, be);
        const ov = Math.max(0, oe - os);
        const ad = Math.max(1, ae - as);
        const bd = Math.max(1, be - bs);
        const minD = Math.min(ad, bd);
        return ov / minD;
      }
      const dedupThreshold = 0.70;
      const out: any[] = [];
      for (const p of patterns) {
        const sameTypeIdx = out.findIndex(q =>
          String(q?.type) === String(p?.type) &&
          overlapRatio(String(q?.range?.start), String(q?.range?.end ?? q?.range?.current), String(p?.range?.start), String(p?.range?.end ?? p?.range?.current)) >= dedupThreshold
        );
        if (sameTypeIdx < 0) {
          out.push(p);
        } else {
          const existing = out[sameTypeIdx];
          const eConf = Number(existing?.confidence ?? 0);
          const pConf = Number(p?.confidence ?? 0);
          if (pConf > eConf) {
            out[sameTypeIdx] = p;
          } else if (pConf === eConf) {
            const eEnd = toMs(existing?.range?.end ?? existing?.range?.current);
            const pEnd = toMs(p?.range?.end ?? p?.range?.current);
            if (Number.isFinite(pEnd) && Number.isFinite(eEnd) && pEnd > eEnd) {
              out[sameTypeIdx] = p;
            }
          }
        }
      }
      patterns = out;
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
              // Additional strict checks: valleys equality and neckline slope
              const v1cands = allValleys.filter((v: any) => v.idx > a.idx && v.idx < b.idx);
              const v2cands = allValleys.filter((v: any) => v.idx > b.idx && v.idx < c.idx);
              const v1 = v1cands.length ? v1cands.reduce((m: any, v: any) => v.price < m.price ? v : m) : null;
              const v2 = v2cands.length ? v2cands.reduce((m: any, v: any) => v.price < m.price ? v : m) : null;
              if (!(v1 && v2)) { pushCand({ type: 'triple_top', accepted: false, reason: 'valleys_missing', idxs: [a.idx, b.idx, c.idx] }); continue; }
              const valleysNear = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price)) <= tolerancePct;
              const necklineSlopeLimit = 0.02;
              const necklineSlope = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price));
              const necklineValid = necklineSlope <= necklineSlopeLimit;
              if (!(valleysNear && necklineValid)) { pushCand({ type: 'triple_top', accepted: false, reason: !valleysNear ? 'valleys_not_equal' : 'neckline_slope_excess', idxs: [a.idx, b.idx, c.idx] }); continue; }
              const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
              const tolMargin = clamp01(1 - (devs.reduce((s, v) => s + v, 0) / devs.length) / Math.max(1e-12, tolerancePct));
              const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
              const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base, 'triple_top');
              const nlAvg = ((Number(v1.price) + Number(v2.price)) / 2);
              const neckline = [{ x: a.idx, y: nlAvg }, { x: c.idx, y: nlAvg }];
              // Build 5-point pivot order for diagram if valleys exist
              let diagram: any = undefined;
              diagram = generatePatternDiagram(
                'triple_top',
                [
                  { ...a, date: (candles[a.idx] as any)?.isoTime },
                  { ...v1, date: (candles[v1.idx] as any)?.isoTime },
                  { ...b, date: (candles[b.idx] as any)?.isoTime },
                  { ...v2, date: (candles[v2.idx] as any)?.isoTime },
                  { ...c, date: (candles[c.idx] as any)?.isoTime },
                ],
                { price: nlAvg },
                { start, end }
              );
              if (confidence >= (MIN_CONFIDENCE['triple_top'] ?? 0)) {
                push(patterns, { type: 'triple_top', confidence, range: { start, end }, pivots: [a, b, c], ...(neckline ? { neckline } : {}), ...(diagram ? { structureDiagram: diagram } : {}) });
                pushCand({ type: 'triple_top', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'peak1', idx: a.idx, price: a.price }, { role: 'peak2', idx: b.idx, price: b.price }, { role: 'peak3', idx: c.idx, price: c.price }] });
              } else {
                pushCand({ type: 'triple_top', accepted: false, reason: 'confidence_below_min', idxs: [a.idx, b.idx, c.idx] });
              }
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
              // Additional strict checks:
              // 3 valleys near + spread limit, peaks near and neckline slope limit
              const valleyPrices = [a.price, b.price, c.price];
              const valleyNearStrict = near(a.price, b.price) && near(b.price, c.price) && near(a.price, c.price);
              const valleyMin = Math.min(...valleyPrices);
              const valleyMax = Math.max(...valleyPrices);
              const maxValleySpread = 0.015;
              const valleySpreadValid = (valleyMax - valleyMin) / Math.max(1, valleyMin) <= maxValleySpread;
              const p1cands = allPeaks.filter((v: any) => v.idx > a.idx && v.idx < b.idx);
              const p2cands = allPeaks.filter((v: any) => v.idx > b.idx && v.idx < c.idx);
              const p1 = p1cands.length ? p1cands.reduce((m: any, v: any) => v.price > m.price ? v : m) : null;
              const p2 = p2cands.length ? p2cands.reduce((m: any, v: any) => v.price > m.price ? v : m) : null;
              if (!(p1 && p2)) { pushCand({ type: 'triple_bottom', accepted: false, reason: 'peaks_missing', idxs: [a.idx, b.idx, c.idx] }); continue; }
              const peaksNear = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price)) <= tolerancePct;
              const necklineSlopeLimit = 0.02;
              const necklineSlope = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price));
              const necklineValid = necklineSlope <= necklineSlopeLimit;
              if (!(valleyNearStrict && valleySpreadValid && peaksNear && necklineValid)) {
                pushCand({ type: 'triple_bottom', accepted: false, reason: !valleyNearStrict ? 'valleys_not_equal' : (!valleySpreadValid ? 'valley_spread_excess' : (!peaksNear ? 'peaks_not_equal' : 'neckline_slope_excess')), idxs: [a.idx, b.idx, c.idx] });
                continue;
              }
              const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
              const tolMargin = clamp01(1 - (devs.reduce((s, v) => s + v, 0) / devs.length) / Math.max(1e-12, tolerancePct));
              const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
              const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
              const per = periodScoreDays(start, end);
              const base = (tolMargin + symmetry + per) / 3;
              const confidence = finalizeConf(base, 'triple_bottom');
              const nlAvg = ((Number(p1.price) + Number(p2.price)) / 2);
              const neckline = [{ x: a.idx, y: nlAvg }, { x: c.idx, y: nlAvg }];
              // Build 5-point pivot order for diagram if peaks exist
              let diagram: any = undefined;
              diagram = generatePatternDiagram(
                'triple_bottom',
                [
                  { ...a, date: (candles[a.idx] as any)?.isoTime },
                  { ...p1, date: (candles[p1.idx] as any)?.isoTime },
                  { ...b, date: (candles[b.idx] as any)?.isoTime },
                  { ...p2, date: (candles[p2.idx] as any)?.isoTime },
                  { ...c, date: (candles[c.idx] as any)?.isoTime },
                ],
                { price: nlAvg },
                { start, end }
              );
              if (confidence >= (MIN_CONFIDENCE['triple_bottom'] ?? 0)) {
                push(patterns, { type: 'triple_bottom', confidence, range: { start, end }, pivots: [a, b, c], ...(neckline ? { neckline } : {}), ...(diagram ? { structureDiagram: diagram } : {}) });
                pushCand({ type: 'triple_bottom', accepted: true, idxs: [a.idx, b.idx, c.idx], pts: [{ role: 'valley1', idx: a.idx, price: a.price }, { role: 'valley2', idx: b.idx, price: b.price }, { role: 'valley3', idx: c.idx, price: c.price }] });
              } else {
                pushCand({ type: 'triple_bottom', accepted: false, reason: 'confidence_below_min', idxs: [a.idx, b.idx, c.idx] });
              }
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
              // valleys for neckline & diagram
              const v1cands = allValleys.filter((v: any) => v.idx > a.idx && v.idx < b.idx);
              const v2cands = allValleys.filter((v: any) => v.idx > b.idx && v.idx < c.idx);
              const v1 = v1cands.length ? v1cands.reduce((m: any, v: any) => v.price < m.price ? v : m) : null;
              const v2 = v2cands.length ? v2cands.reduce((m: any, v: any) => v.price < m.price ? v : m) : null;
              const nlAvg = (v1 && v2) ? ((Number(v1.price) + Number(v2.price)) / 2) : null;
              // Additional strictness in relaxed path as well
              if (!(v1 && v2)) { pushCand({ type: 'triple_top', accepted: false, reason: 'valleys_missing_relaxed', idxs: [a.idx, b.idx, c.idx] }); continue; }
              const necklineSlopeLimit = 0.02;
              const necklineSlope = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price));
              if (necklineSlope > necklineSlopeLimit) { pushCand({ type: 'triple_top', accepted: false, reason: 'neckline_slope_excess_relaxed', idxs: [a.idx, b.idx, c.idx] }); continue; }
              let diagram: any = undefined;
              const neckline = (v1 && v2) ? [{ x: a.idx, y: nlAvg }, { x: c.idx, y: nlAvg }] : undefined as any;
              if (v1 && v2) {
                diagram = generatePatternDiagram(
                  'triple_top',
                  [
                    { ...a, date: (candles[a.idx] as any)?.isoTime },
                    { ...v1, date: (candles[v1.idx] as any)?.isoTime },
                    { ...b, date: (candles[b.idx] as any)?.isoTime },
                    { ...v2, date: (candles[v2.idx] as any)?.isoTime },
                    { ...c, date: (candles[c.idx] as any)?.isoTime },
                  ],
                  { price: nlAvg ?? Number(b.price) },
                  { start, end }
                );
              }
              if (confidence >= (MIN_CONFIDENCE['triple_top'] ?? 0)) {
                push(patterns, { type: 'triple_top', confidence, range: { start, end }, pivots: [a, b, c], ...(neckline ? { neckline } : {}), ...(diagram ? { structureDiagram: diagram } : {}), _fallback: `relaxed_triple_x${f}` });
              } else {
                pushCand({ type: 'triple_top', accepted: false, reason: 'confidence_below_min_relaxed', idxs: [a.idx, b.idx, c.idx] });
              }
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
              // peaks for neckline & diagram
              const p1cands = allPeaks.filter((v: any) => v.idx > a.idx && v.idx < b.idx);
              const p2cands = allPeaks.filter((v: any) => v.idx > b.idx && v.idx < c.idx);
              const p1 = p1cands.length ? p1cands.reduce((m: any, v: any) => v.price > m.price ? v : m) : null;
              const p2 = p2cands.length ? p2cands.reduce((m: any, v: any) => v.price > m.price ? v : m) : null;
              const nlAvg = (p1 && p2) ? ((Number(p1.price) + Number(p2.price)) / 2) : null;
              if (!(p1 && p2)) { pushCand({ type: 'triple_bottom', accepted: false, reason: 'peaks_missing_relaxed', idxs: [a.idx, b.idx, c.idx] }); continue; }
              const necklineSlopeLimit = 0.02;
              const necklineSlope = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price));
              if (necklineSlope > necklineSlopeLimit) { pushCand({ type: 'triple_bottom', accepted: false, reason: 'neckline_slope_excess_relaxed', idxs: [a.idx, b.idx, c.idx] }); continue; }
              let diagram: any = undefined;
              const neckline = (p1 && p2) ? [{ x: a.idx, y: nlAvg }, { x: c.idx, y: nlAvg }] : undefined as any;
              if (p1 && p2) {
                diagram = generatePatternDiagram(
                  'triple_bottom',
                  [
                    { ...a, date: (candles[a.idx] as any)?.isoTime },
                    { ...p1, date: (candles[p1.idx] as any)?.isoTime },
                    { ...b, date: (candles[b.idx] as any)?.isoTime },
                    { ...p2, date: (candles[p2.idx] as any)?.isoTime },
                    { ...c, date: (candles[c.idx] as any)?.isoTime },
                  ],
                  { price: nlAvg ?? Number(b.price) },
                  { start, end }
                );
              }
              if (confidence >= (MIN_CONFIDENCE['triple_bottom'] ?? 0)) {
                push(patterns, { type: 'triple_bottom', confidence, range: { start, end }, pivots: [a, b, c], ...(neckline ? { neckline } : {}), ...(diagram ? { structureDiagram: diagram } : {}), _fallback: `relaxed_triple_x${f}` });
              } else {
                pushCand({ type: 'triple_bottom', accepted: false, reason: 'confidence_below_min_relaxed', idxs: [a.idx, b.idx, c.idx] });
              }
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
        // Require a small buffer over/under the neckline to confirm breakout
        const breakoutBuffer = 0.015; // 1.5%
        for (let i = endIdx + 1; i < Math.min(candles.length, endIdx + 30); i++) {
          const nl = necklineValue(p, i) ?? (nlAtEnd as number);
          const c = Number(candles[i]?.close ?? NaN);
          if (!Number.isFinite(c) || !Number.isFinite(nl)) continue;
          if ((bullish && c > nl * (1 + breakoutBuffer)) || (bearish && c < nl * (1 - breakoutBuffer))) {
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
    // MIN_CONFIDENCE は関数先頭で定義済み
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
    // ただし accepted を優先的に残す（accepted → rejected の順で cap まで）
    const cap = 200;
    const swingsTrimmed = Array.isArray(debugSwings) ? debugSwings.slice(0, cap) : [];
    let candidatesTrimmed: any[] = [];
    if (Array.isArray(debugCandidates)) {
      const acc = debugCandidates.filter((c: any) => !!c?.accepted);
      const rej = debugCandidates.filter((c: any) => !c?.accepted);
      candidatesTrimmed = [...acc, ...rej].slice(0, cap);
    }
    const debugTrimmed = {
      swings: swingsTrimmed,
      candidates: candidatesTrimmed,
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


