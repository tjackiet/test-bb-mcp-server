import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';

/**
 * detect_forming_patterns - リアルタイム監視・早期警告向けパターン検出
 * 
 * 設計思想:
 * - 目的: 現在形成中のパターンを早期に検出し、ブレイク/無効化を素早く通知
 * - 特徴: シンプルなピーク/バレー検出（前後1本との比較）で素早い反応を優先
 * - ブレイク検出: ATR * 0.5 バッファ、最初のブレイクで即座に invalid 判定
 * - 用途: 「今forming中か？」「いつ無効化されたか？」
 * 
 * 注意: detect_patterns との違い
 * - 本ツールはシンプルなピボット検出を使用するため、回帰線の傾きが異なる
 * - detect_patterns はより厳密なスイング検出（swingDepth 基準）を使用
 * - 結果として、ブレイク日が数日ずれる場合があるが、これは設計上の意図的な違い
 * - forming: 早期警告に有利 / patterns: 統計的信頼性に有利
 */
import { createMeta } from '../lib/validate.js';
import type { Pair } from '../src/types/domain.d.ts';
import detectPatterns from './detect_patterns.js';

type View = 'summary' | 'detailed' | 'full' | 'debug';

export default async function detectFormingPatterns(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 150,
  opts: Partial<{ patterns: string[]; minCompletion: number; view: View; pivotConfirmBars: number; rightPeakTolerancePct: number; maxBarsFromBreakout: number; maxBarsFromLastPivot: number; includeCompleted: boolean; maxCompletedBars: number; maxPatternDays: number; allowProvisionalRightShoulder: boolean; necklineSlopeTolerancePct: number; symmetryTolerancePct: number; prePostSymmetryTolerancePct: number; necklineSlopePerBarMin: number; headInvalidBelowPct: number; minDowntrendPct: number; minDowntrendFrac: number; minValleyDepthPct: number; minValleySeparationBars: number; minUptrendPct: number; minUptrendFrac: number; maxNecklineSlopePerBar: number; rightValleyInvalidBelowPct: number }> = {}
) {
  const want = new Set(opts.patterns || ['head_and_shoulders', 'inverse_head_and_shoulders', 'double_top', 'double_bottom', 'falling_wedge', 'rising_wedge']);
  const minCompletion = Math.max(0, Math.min(1, opts.minCompletion ?? 0.4));
  const view: View = (opts.view as View) || 'detailed';
  const pivotConfirmBars = Math.max(1, Math.min(20, Math.floor(opts.pivotConfirmBars ?? 2)));
  const rightPeakTolerancePct = Math.max(0.05, Math.min(0.5, Number(opts.rightPeakTolerancePct ?? 0.3))); // 5% - 50%
  const maxPatternDays = Math.max(7, Math.min(365, Number(opts.maxPatternDays ?? 90)));
  const allowProvisionalRightShoulder = Boolean(opts.allowProvisionalRightShoulder ?? false);
  // 許容ネックライン傾斜（価格差の比率）。超過時は水平化
  const necklineSlopeTolerancePct = Math.max(0.01, Math.min(0.2, Number((opts as any).necklineSlopeTolerancePct ?? 0.08)));
  // 左右対称の許容（頭前ピーク vs 頭後ピーク / 頭前谷 vs 頭後谷 の差）
  const symmetryTolerancePct = Math.max(0.02, Math.min(0.3, Number((opts as any).symmetryTolerancePct ?? 0.12)));
  // ヘッド前後の山/谷の高さ差の許容（対称性チェック）
  const prePostSymmetryTolerancePct = Math.max(0.02, Math.min(0.3, Number((opts as any).prePostSymmetryTolerancePct ?? 0.12)));
  // 逆三尊: ネックラインの1本あたり下向き傾斜がこの閾値より小さい（強い下向き）場合は除外（既定: -0.1%/本）
  const necklineSlopePerBarMin = Math.max(-0.05, Math.min(0, Number((opts as any).necklineSlopePerBarMin ?? -0.001)));
  // 逆三尊: 現在値が頭安値をこの比率以上で割り込んだら除外（既定1%）
  const headInvalidBelowPct = Math.max(0, Math.min(0.2, Number((opts as any).headInvalidBelowPct ?? 0.01)));
  // 逆三尊の前提: 左肩→頭の下落率（最低3%）と下落継続性
  const minDowntrendPct = Math.max(0, Math.min(0.5, Number((opts as any).minDowntrendPct ?? 0.03)));
  const minDowntrendFrac = Math.max(0.5, Math.min(0.9, Number((opts as any).minDowntrendFrac ?? 0.55))); // 下降本数の比率閾値
  // ダブルボトム品質フィルタ（厳格化）
  const minValleyDepthPct = Math.max(0, Math.min(0.3, Number((opts as any).minValleyDepthPct ?? 0.03))); // 各谷の最低深さ
  const minValleySeparationBars = Math.max(1, Math.min(60, Math.floor((opts as any).minValleySeparationBars ?? 5))); // 谷間の最小バー間隔
  const minUptrendPct = Math.max(0, Math.min(0.5, Number((opts as any).minUptrendPct ?? 0.03))); // （命名は互換のため）前提下落率の別名/将来拡張用
  const minUptrendFrac = Math.max(0.5, Math.min(0.9, Number((opts as any).minUptrendFrac ?? 0.55))); // （命名は互換のため）
  const maxNecklineSlopePerBar = Math.max(0, Math.min(0.05, Number((opts as any).maxNecklineSlopePerBar ?? 0.001))); // ネックラインの過度な上向き傾斜を排除
  const rightValleyInvalidBelowPct = Math.max(0, Math.min(0.2, Number((opts as any).rightValleyInvalidBelowPct ?? 0.01))); // 右谷割れの無効化
  // freshness defaults (favor recency over timeframe)
  const defaultMaxBarsFromBreakout = (tf: string): number => {
    return 20;
  };
  const defaultMaxBarsFromLastPivot = (tf: string): number => {
    return 10;
  };
  const maxBarsFromBreakout = Math.max(1, Math.floor(opts.maxBarsFromBreakout ?? defaultMaxBarsFromBreakout(type)));
  const maxBarsFromLastPivot = Math.max(1, Math.floor(opts.maxBarsFromLastPivot ?? defaultMaxBarsFromLastPivot(type)));
  const includeCompleted = opts.includeCompleted ?? true;
  const maxCompletedBars = Math.max(1, Math.floor(opts.maxCompletedBars ?? maxBarsFromBreakout));

  const res = await getIndicators(pair, type as any, limit);
  if (!res?.ok) return fail(res.summary || 'failed', (res.meta as any)?.errorType || 'internal') as any;
  const pairNorm: Pair = ((res.meta as any)?.pair ?? pair) as Pair;

  const candles: Array<{ open: number; high: number; low: number; close: number; isoTime?: string }>
    = res.data.chart.candles as any[];
  if (!Array.isArray(candles) || candles.length < 20)
    return ok('insufficient data', { patterns: [] }, createMeta(pairNorm, { type, count: 0 })) as any;

  // helpers
  const n = candles.length;
  const priceAt = (idx: number) => candles[Math.max(0, Math.min(n - 1, idx))].close;
  const isoAt = (idx: number) => candles[Math.max(0, Math.min(n - 1, idx))].isoTime;
  const lastIdx = n - 1;
  const isPivotConfirmed = (pivotIdx: number, currentIdx: number) => (currentIdx - pivotIdx) >= pivotConfirmBars;
  const last3Down = () => {
    if (n < 4) return false;
    const a = candles[n - 4].close, b = candles[n - 3].close, c = candles[n - 2].close, d = candles[n - 1].close;
    return d < c && c < b && b < a;
  };
  const fmtDate = (iso?: string) => {
    if (!iso) return 'n/a';
    const dt = new Date(iso);
    const now = new Date();
    const y = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return y === now.getFullYear() ? `${mm}/${dd}` : `${y}/${mm}/${dd}`;
  };
  const formatPeriod = (bars: number, candleType: string) => {
    const units: Record<string, string> = {
      '1day': '日間',
      '1hour': '時間',
      '4hour': '時間',
      '8hour': '時間',
      '12hour': '時間',
      '1week': '週間',
      '1month': 'ヶ月',
      '15min': '分',
      '30min': '分',
    };
    const multipliers: Record<string, number> = {
      '1day': 1,
      '1hour': 1,
      '4hour': 4,
      '8hour': 8,
      '12hour': 12,
      '1week': 1,
      '1month': 1,
      '15min': 15,
      '30min': 30,
    };
    const value = Math.max(0, Math.round(bars * (multipliers[candleType] ?? 1)));
    const unit = units[candleType] ?? '本';
    return `${value}${unit}`;
  };

  // 共通ブレイク検出（H&S/逆H&S）
  const detectBreakout = (
    startIdx: number,
    necklineY: number,
    isInverse: boolean,
    buffer: number = 0.02
  ): { completed: boolean; invalidated: boolean; breakIdx: number; barsSinceBreak: number } => {
    let completedBreakIdx = -1;
    for (let i = Math.max(0, startIdx + 1); i <= lastIdx; i++) {
      const cl = Number(candles[i]?.close);
      if (!Number.isFinite(cl)) continue;
      const expected = isInverse ? (cl > necklineY * (1 + buffer)) : (cl < necklineY * (1 - buffer));
      if (expected) { completedBreakIdx = i; break; }
    }
    let invalidated = false;
    if (completedBreakIdx !== -1) {
      const seg = candles.slice(completedBreakIdx);
      if (isInverse) {
        const lo = Math.min(...seg.map(c => Number(c?.low) || Infinity));
        invalidated = Number.isFinite(lo) && lo < necklineY * (1 - buffer);
      } else {
        const hi = Math.max(...seg.map(c => Number(c?.high) || -Infinity));
        invalidated = Number.isFinite(hi) && hi > necklineY * (1 + buffer);
      }
    }
    const barsSinceBreak = completedBreakIdx !== -1 ? Math.max(0, lastIdx - completedBreakIdx) : -1;
    return { completed: completedBreakIdx !== -1, invalidated, breakIdx: completedBreakIdx, barsSinceBreak };
  };
  // scale/coverage validation helpers
  const daysPerBarCalc = (tf: string): number => {
    const map: Record<string, number> = {
      '1min': 1 / (24 * 60),
      '5min': 5 / (24 * 60),
      '15min': 15 / (24 * 60),
      '30min': 30 / (24 * 60),
      '1hour': 1 / 24,
      '4hour': 4 / 24,
      '8hour': 8 / 24,
      '12hour': 12 / 24,
      '1day': 1,
      '1week': 7,
      '1month': 30,
    };
    return map[tf] ?? 1;
  };
  // パターン別の最小期間（日換算）
  const MIN_PATTERN_DAYS_MAP: Record<string, number> = {
    'double_top': 14,
    'double_bottom': 14,
    'triple_top': 21,
    'triple_bottom': 21,
    'head_and_shoulders': 21,
    'inverse_head_and_shoulders': 21,
    'triangle_ascending': 28,
    'triangle_descending': 28,
    'triangle_symmetrical': 21,
    'pennant': 7,
    'flag': 14,
  };
  const getMinPatternDays = (patternType: string): number => MIN_PATTERN_DAYS_MAP[patternType] ?? 14;
  const MIN_COVERAGE = 0.30;
  const MAX_COVERAGE = 0.90;
  const IDEAL_COVERAGE = 0.50;
  const suggestTimeframe = (patternDays: number): string => {
    if (patternDays < 7) return 'このパターンは4時間足または1時間足で確認してください';
    if (patternDays >= 7 && patternDays <= 60) return '日足で適切な規模です';
    return '週足で見るとより明確になります';
  };
  const buildScaleValidation = (patternBars: number) => {
    const totalBars = Number(limit);
    const coverageRatio = totalBars > 0 ? (patternBars / totalBars) : 0;
    const patternDays = Math.round(patternBars * daysPerBarCalc(String(type)));
    let status: 'too_small' | 'appropriate' | 'too_large' = 'appropriate';
    let recommended_limit: number | undefined;
    let timeframe_suggestion: string | undefined;
    let warning: string | undefined;
    if (coverageRatio < MIN_COVERAGE) {
      status = 'too_small';
      recommended_limit = Math.ceil(patternBars / Math.max(IDEAL_COVERAGE, 1e-12));
      timeframe_suggestion = suggestTimeframe(patternDays);
      warning = `パターンが表示範囲の${(coverageRatio * 100).toFixed(1)}%しか占めていません。limit=${recommended_limit}で再確認を推奨します。`;
    } else if (coverageRatio > MAX_COVERAGE) {
      status = 'too_large';
      timeframe_suggestion = suggestTimeframe(patternDays);
      warning = 'パターンが大きすぎます。週足など長期の時間軸での確認を推奨します。';
    }
    return {
      coverage_ratio: Number(coverageRatio.toFixed(3)),
      pattern_bars: patternBars,
      total_bars: totalBars,
      pattern_days: patternDays,
      is_appropriate: status === 'appropriate',
      status,
      ...(recommended_limit ? { recommended_limit } : {}),
      ...(timeframe_suggestion ? { timeframe_suggestion } : {}),
      ...(warning ? { warning } : {}),
    };
  };

  // naive swing scan for last confirmed peak/valley
  const peaks: Array<{ idx: number; price: number }> = [];
  const valleys: Array<{ idx: number; price: number }> = [];
  for (let idx = 1; idx < n - 1; idx++) {
    const p = candles[idx];
    const isPeak = p.high > candles[idx - 1].high && p.high > candles[idx + 1].high;
    const isValley = p.low < candles[idx - 1].low && p.low < candles[idx + 1].low;
    // ピボット判定は high/low を用いるが、価格値はヒゲ影響を避けるため close を格納
    if (isPeak) peaks.push({ idx, price: p.close });
    if (isValley) valleys.push({ idx, price: p.close });
  }
  const lastPeak = [...peaks].reverse().find(p => isPivotConfirmed(p.idx, lastIdx));
  const lastValley = [...valleys].reverse().find(v => isPivotConfirmed(v.idx, lastIdx));
  const patterns: any[] = [];

  // forming double_top: confirmed left_peak + confirmed valley + right rising toward left_peak
  if (want.has('double_top') && lastPeak && lastValley && lastValley.idx > lastPeak.idx && isPivotConfirmed(lastPeak.idx, lastIdx) && isPivotConfirmed(lastValley.idx, lastIdx)) {
    const leftPeak = lastPeak;
    const valley = lastValley;
    const currentPrice = priceAt(lastIdx);
    const leftPct = currentPrice / Math.max(1, leftPeak.price);
    if (leftPct >= (1 - rightPeakTolerancePct) && leftPct <= (1 + rightPeakTolerancePct) && currentPrice > valley.price) {
      const ratio = (currentPrice - valley.price) / Math.max(1e-12, leftPeak.price - valley.price);
      let progress = Math.max(0, Math.min(1, ratio));
      if (last3Down()) progress = Math.min(1, progress + 0.2);
      const completion = Math.min(1, 0.66 + progress * 0.34);
      if (completion >= minCompletion) {
        const neckline = [{ x: leftPeak.idx, y: valley.price }, { x: lastIdx, y: valley.price }];
        const start = isoAt(leftPeak.idx);
        const cur = isoAt(lastIdx);
        const confBase = Math.min(1, Math.max(0, (1 - Math.abs(leftPct - 1)) * 0.6 + progress * 0.4));
        const confidence = Math.round(confBase * 100) / 100; // estimated post-completion
        const formationBars = Math.max(0, lastIdx - leftPeak.idx);
        const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
        // Absolute period check: pattern-specific minimum (days)
        const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
        if (patternDays < getMinPatternDays('double_top')) {
          // skip too short pattern
        } else {
          const scale_validation = buildScaleValidation(formationBars);
          patterns.push({
            type: 'double_top',
            completion: Number((completion).toFixed(2)),
            confidence,
            status: 'forming',
            range: { start, current: cur },
            candleType: type,
            formationPeriod: formation,
            scale_validation,
            confirmedPivots: [
              { role: 'left_peak', price: leftPeak.price, idx: leftPeak.idx, isoTime: start, formatted: fmtDate(start) },
              { role: 'valley', price: valley.price, idx: valley.idx, isoTime: isoAt(valley.idx), formatted: fmtDate(isoAt(valley.idx)) },
            ],
            formingPivots: [
              { role: 'right_peak', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
            ],
            neckline,
            scenarios: {
              completion: { priceRange: [Math.round(leftPeak.price * 0.98), Math.round(leftPeak.price * 1.02)], description: 'この価格帯で反転下落すればパターン完成' },
              invalidation: { priceLevel: Math.round(leftPeak.price * 1.012), description: `${Math.round(leftPeak.price * 1.012).toLocaleString()}円を上抜けたらパターン無効` },
            },
            nextSteps: [
              `${Math.round(leftPeak.price * 0.997).toLocaleString()}-${Math.round(leftPeak.price * 1.005).toLocaleString()}円での反転シグナルを監視`,
              `完成後はネックライン${Math.round(valley.price).toLocaleString()}円の下抜けでショートエントリー検討`,
            ],
          });
        }
      }
    }
  }

  // forming double_bottom（厳格化）
  if (want.has('double_bottom')) {
    // 1) 直近の確定谷を2つ以上取得
    const confirmedValleys = valleys.filter(v => isPivotConfirmed(v.idx, lastIdx));
    if (confirmedValleys.length >= 2) {
      // 右側の谷を優先（より新しいペアを探索）
      for (let j = confirmedValleys.length - 1; j >= 1; j--) {
        const rightValley = confirmedValleys[j];
        const leftValley = confirmedValleys[j - 1];
        if (rightValley.idx - leftValley.idx < minValleySeparationBars) continue; // 谷の間隔が短すぎる
        // 2) 2つの谷の間に存在する戻り高値（ネックライン候補）を抽出
        const peaksBetween = peaks.filter(p => p.idx > leftValley.idx && p.idx < rightValley.idx && isPivotConfirmed(p.idx, lastIdx));
        if (!peaksBetween.length) continue;
        const midPeak = peaksBetween.reduce((best, p) => (p.price > best.price ? p : best), peaksBetween[0]);
        // 3) 各谷の深さ（戻り高値に対する割合）をチェック
        const leftDepth = (midPeak.price - leftValley.price) / Math.max(1e-12, midPeak.price);
        const rightDepth = (midPeak.price - rightValley.price) / Math.max(1e-12, midPeak.price);
        if (!(leftDepth >= minValleyDepthPct && rightDepth >= minValleyDepthPct)) continue;
        // 4) 前提条件: 左谷に至る下落トレンドを確認（高値切下げ/下落率・下落本数）
        const priorPeak = [...peaks].reverse().find(p => p.idx < leftValley.idx && isPivotConfirmed(p.idx, lastIdx));
        if (priorPeak) {
          const totalBars = Math.max(1, leftValley.idx - priorPeak.idx);
          const dropPct = (leftValley.price - priorPeak.price) / Math.max(1e-12, priorPeak.price); // 負値が期待
          let downCount = 0;
          for (let k = priorPeak.idx + 1; k <= leftValley.idx; k++) {
            const prev = candles[k - 1].close;
            const now = candles[k].close;
            if (now < prev) downCount++;
          }
          const frac = downCount / totalBars;
          if (!(dropPct <= -minDowntrendPct && frac >= minDowntrendFrac)) continue;
        }
        // 5) ネックラインの傾斜チェック（過度に上向きな場合は「単なる上昇トレンド中の押し目」を除外）
        const postPeaks = peaks.filter(p => p.idx > rightValley.idx && isPivotConfirmed(p.idx, lastIdx));
        if (postPeaks.length) {
          const refPeak = postPeaks[postPeaks.length - 1];
          const bars = Math.max(1, refPeak.idx - midPeak.idx);
          const perBarPct = (refPeak.price - midPeak.price) / Math.max(1e-12, midPeak.price) / bars;
          if (perBarPct > maxNecklineSlopePerBar) continue;
        }
        // 6) 無効化: 現在値が右谷を大きく割り込んでいないこと
        const currentPrice = priceAt(lastIdx);
        if (currentPrice < rightValley.price * (1 - rightValleyInvalidBelowPct)) continue;
        // 7) 完成度: 右谷からネックラインへ向けた戻り具合
        const upRatio = (currentPrice - rightValley.price) / Math.max(1e-12, midPeak.price - rightValley.price);
        const progress = Math.max(0, Math.min(1, upRatio));
        const completion = Math.min(1, 0.66 + 0.34 * progress);
        if (completion < minCompletion) continue;
        // 8) ネックライン（基本は水平。傾斜が許容内で postPeak がある場合は2点で表現）
        const neckline =
          postPeaks.length && postPeaks[postPeaks.length - 1].idx > midPeak.idx
            ? [{ x: midPeak.idx, y: midPeak.price }, { x: postPeaks[postPeaks.length - 1].idx, y: postPeaks[postPeaks.length - 1].price }]
            : [{ x: midPeak.idx, y: midPeak.price }, { x: lastIdx, y: midPeak.price }];
        // 期間チェックとスケール検証
        const formationBars = Math.max(0, rightValley.idx - leftValley.idx);
        const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
        if (patternDays < getMinPatternDays('double_bottom')) continue;
        const scale_validation = buildScaleValidation(formationBars);
        const start = isoAt(leftValley.idx);
        const cur = isoAt(lastIdx);
        const confidence = Number((Math.min(1, 0.5 + 0.5 * progress)).toFixed(2));
        patterns.push({
          type: 'double_bottom',
          completion: Number(completion.toFixed(2)),
          confidence,
          status: 'forming',
          range: { start, current: cur },
          candleType: type,
          formationPeriod: { bars: formationBars, formatted: formatPeriod(formationBars, type), start, current: cur },
          scale_validation,
          confirmedPivots: [
            { role: 'left_valley', price: leftValley.price, idx: leftValley.idx, isoTime: start, formatted: fmtDate(start) },
            { role: 'peak', price: midPeak.price, idx: midPeak.idx, isoTime: isoAt(midPeak.idx), formatted: fmtDate(isoAt(midPeak.idx)) },
            { role: 'right_valley', price: rightValley.price, idx: rightValley.idx, isoTime: isoAt(rightValley.idx), formatted: fmtDate(isoAt(rightValley.idx)) },
          ],
          formingPivots: [
            { role: 'current', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
          ],
          neckline,
          scenarios: {
            completion: { priceRange: [Math.round(rightValley.price * 1.01), Math.round(midPeak.price)], description: '右谷からの戻り継続 → ネックライン接近' },
            invalidation: { priceLevel: Math.round(rightValley.price * (1 - rightValleyInvalidBelowPct)), description: `${Math.round(rightValley.price * (1 - rightValleyInvalidBelowPct)).toLocaleString()}円割れで無効` },
          },
          nextSteps: [
            `${Math.round(rightValley.price * 1.005).toLocaleString()}-${Math.round(rightValley.price * 1.02).toLocaleString()}円の戻り強さを確認`,
            `完成後はネックライン${Math.round(midPeak.price).toLocaleString()}円の上抜けでロング検討`,
          ],
        });
        // 最新の妥当な1件で十分
        break;
      }
    }
  }

  // forming wedges: falling_wedge / rising_wedge（ピボットベース検出）
  {
    const wantFalling = want.has('falling_wedge');
    const wantRising = want.has('rising_wedge');
    const wantAnyWedge = wantFalling || wantRising;
    ; (globalThis as any).__formingWedgeDebugMeta = { scanned: false, windows: 0, want: Array.from(want as any) };
    if (wantAnyWedge) {
      const wedgeDebug: Array<{ accepted: boolean; type: string; reason?: string; indices?: [number, number]; details?: any }> = [];
      // window設定
      const windowSizeMin = 25, windowSizeMax = 120, windowStep = 5;
      // 直近性: 最終ピボットからの経過本数（緩和）
      const maxBarsSinceLastPivot = 30;
      // スコア重み（形成用・元の値）
      const weights = { converge: 0.50, fit: 0.15, touches: 0.25, inside: 0.10, duration: 0.05, apexProximity: 0.10, recencyBonus: 0.05 };
      // 直近30本の未確定高値/安値（デバッグ用のベース情報）
      const lb = Math.max(0, lastIdx - 29);
      let recentHi = -Infinity, recentHiIdx = -1;
      let recentLo = Infinity, recentLoIdx = -1;
      for (let k = lb; k <= lastIdx; k++) {
        const hi = Number(candles[k]?.high ?? NaN);
        const lo = Number(candles[k]?.low ?? NaN);
        if (Number.isFinite(hi) && hi > recentHi) { recentHi = hi; recentHiIdx = k; }
        if (Number.isFinite(lo) && lo < recentLo) { recentLo = lo; recentLoIdx = k; }
      }
      const lastConfirmedPeak = [...peaks].reverse().find(p => isPivotConfirmed(p.idx, lastIdx));
      const lastConfirmedValley = [...valleys].reverse().find(v => isPivotConfirmed(v.idx, lastIdx));
      // ヘルパー
      const lrWithR2 = (pts: Array<{ x: number; y: number }>) => {
        const n = pts.length;
        if (n < 2) return { slope: 0, intercept: 0, r2: 0, valueAt: (x: number) => 0 };
        let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
        for (const p of pts) { sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x; sy2 += p.y * p.y; }
        const denom = n * sx2 - sx * sx || 1;
        const slope = (n * sxy - sx * sy) / denom;
        const intercept = (sy - slope * sx) / n;
        const meanY = sy / n;
        let ssTot = 0, ssRes = 0;
        for (const p of pts) {
          const yhat = slope * p.x + intercept;
          ssTot += (p.y - meanY) ** 2;
          ssRes += (p.y - yhat) ** 2;
        }
        const r2 = ssTot <= 0 ? 0 : Math.max(0, Math.min(1, 1 - (ssRes / ssTot)));
        const valueAt = (x: number) => slope * x + intercept;
        return { slope, intercept, r2, valueAt };
      };
      const calcATR = (from: number, to: number, period: number = 14) => {
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
      };
      const insideRatio = (up: any, lo: any, from: number, to: number) => {
        let total = 0, inside = 0;
        for (let i = from; i <= to; i++) {
          const c = candles[i]; if (!c) continue; total++;
          const u = up.valueAt(i), l = lo.valueAt(i);
          if (c.high <= u && c.low >= l) inside++;
        }
        return total ? inside / total : 0;
      };
      const overlapWindows: Array<{ startIdx: number; endIdx: number }> = [];
      for (let size = windowSizeMin; size <= windowSizeMax; size += windowStep) {
        for (let startIdx = 0; startIdx + size < n; startIdx += windowStep) {
          overlapWindows.push({ startIdx, endIdx: startIdx + size });
        }
      }
      // 末尾（現在）に揃えた特別ウィンドウも追加（最新を確実にカバー）
      for (let size = windowSizeMin; size <= windowSizeMax; size += windowStep) {
        const s = Math.max(0, lastIdx - size);
        overlapWindows.push({ startIdx: s, endIdx: lastIdx });
      }
      // メタ情報（デバッグ用）
      // 直近ウィンドウ統計
      const recentWindowThreshold = 120;
      const recentWindowCount = overlapWindows.filter(w => (lastIdx - w.endIdx) <= recentWindowThreshold).length;
      const latestWindowSamples = overlapWindows.slice(-5);
      ; (globalThis as any).__formingWedgeDebugMeta = {
        scanned: true,
        windows: overlapWindows.length,
        want: Array.from(want as any),
        currentIdx: lastIdx,
        recentRange: [lb, lastIdx],
        recentWindowCount,
        latestWindowSamples,
        recentHiIdx,
        recentHiPrice: Number.isFinite(recentHi) ? Math.round(recentHi) : null,
        recentLoIdx,
        recentLoPrice: Number.isFinite(recentLo) ? Math.round(recentLo) : null,
        lastConfirmedPeakIdx: lastConfirmedPeak?.idx ?? null,
        lastConfirmedPeakAgo: lastConfirmedPeak ? (lastIdx - lastConfirmedPeak.idx) : null,
        lastConfirmedValleyIdx: lastConfirmedValley?.idx ?? null,
        lastConfirmedValleyAgo: lastConfirmedValley ? (lastIdx - lastConfirmedValley.idx) : null,
      };
      for (const w of overlapWindows) {
        const startIdx = w.startIdx, endIdx = w.endIdx;
        const startIso = isoAt(startIdx), endIso = isoAt(endIdx);
        if (!startIso || !endIso) continue;
        // ウィンドウ内の確定ピボット
        const highsIn = peaks.filter(p => p.idx >= startIdx && p.idx <= endIdx);
        const lowsIn = valleys.filter(p => p.idx >= startIdx && p.idx <= endIdx);
        if (highsIn.length < 2 || lowsIn.length < 2) {
          wedgeDebug.push({
            accepted: false,
            type: 'wedge_window',
            reason: 'insufficient_swings',
            indices: [startIdx, endIdx] as any,
            details: { highsCount: highsIn.length, lowsCount: lowsIn.length }
          });
          continue;
        }
        const lastPivotIdx = Math.max(highsIn[highsIn.length - 1].idx, lowsIn[lowsIn.length - 1].idx);
        // 直近性チェック（緩和策: 直近30本の未確定高値/安値がウィンドウ内に含まれていれば許容）
        const barsSince = lastIdx - lastPivotIdx;
        if (barsSince > maxBarsSinceLastPivot) {
          // 最近30本のローソクから最大高値/最小安値の位置を取得
          const recentInside = (recentHiIdx >= startIdx && recentHiIdx <= endIdx) || (recentLoIdx >= startIdx && recentLoIdx <= endIdx);
          if (!recentInside) {
            // 長期ウィンドウ（100-120本）かつ終端が最新に近い場合は、収束の参考値も併記
            let extraDebug: any = {};
            try {
              const winLen = endIdx - startIdx;
              const isLongLatest = (winLen >= 100 && winLen <= 120) && ((lastIdx - endIdx) <= 2);
              if (isLongLatest) {
                const upTmp = lrWithR2(highsIn.map(h => ({ x: h.idx, y: Number(candles[h.idx]?.close) })));
                const loTmp = lrWithR2(lowsIn.map(l => ({ x: l.idx, y: Number(candles[l.idx]?.close) })));
                const upStart = upTmp.valueAt(startIdx), upEnd = upTmp.valueAt(endIdx);
                const loStart = loTmp.valueAt(startIdx), loEnd = loTmp.valueAt(endIdx);
                const gs = upStart - loStart;
                const ge = upEnd - loEnd;
                const conv = (gs > 0 && ge > 0) ? (ge / Math.max(1e-12, gs)) : NaN;
                extraDebug = {
                  longWindow: true,
                  winLen,
                  gapStart: gs,
                  gapEnd: ge,
                  convRatio: conv,
                  upStart, upEnd, loStart, loEnd,
                };
              }
            } catch { /* noop */ }
            wedgeDebug.push({
              accepted: false,
              type: 'wedge_window',
              reason: 'stale_last_pivot',
              indices: [startIdx, endIdx] as any,
              details: {
                barsSince,
                allowedByRecent: false,
                lastPeakInWindow: highsIn[highsIn.length - 1]?.idx ?? null,
                lastValleyInWindow: lowsIn[lowsIn.length - 1]?.idx ?? null,
                recentHiInside: (recentHiIdx >= startIdx && recentHiIdx <= endIdx),
                recentLoInside: (recentLoIdx >= startIdx && recentLoIdx <= endIdx),
                ...extraDebug,
              }
            });
            continue;
          }
        }
        // 回帰は close ベース（タッチ判定はヒゲ基準の high/low）
        const up = lrWithR2(highsIn.map(h => ({ x: h.idx, y: Number(candles[h.idx]?.close) })));
        const lo = lrWithR2(lowsIn.map(l => ({ x: l.idx, y: Number(candles[l.idx]?.close) })));
        // R² 最低値（close回帰のためやや厳しめ）
        if (!(up.r2 >= 0.20 && lo.r2 >= 0.20)) {
          wedgeDebug.push({ accepted: false, type: 'wedge_window', reason: 'r2_below_threshold', indices: [startIdx, endIdx] as any, details: { r2High: up.r2, r2Low: lo.r2, min: 0.20 } });
          continue;
        }
        const bothDown = up.slope < 0 && lo.slope < 0;
        const bothUp = up.slope > 0 && lo.slope > 0;
        if (!(bothDown || bothUp)) { wedgeDebug.push({ accepted: false, type: 'wedge_window', reason: 'not_same_direction', indices: [startIdx, endIdx] as any, details: { slopeHigh: up.slope, slopeLow: lo.slope } }); continue; }
        const absHi = Math.abs(up.slope), absLo = Math.abs(lo.slope);
        const ratio = (bothDown || bothUp) ? (bothDown ? absHi / Math.max(1e-12, absLo) : absLo / Math.max(1e-12, absHi)) : 0;

        // 傾き比率チェック: 1.1 ~ 3.0 の範囲
        if (!((Math.max(absHi, absLo) > Math.min(absHi, absLo) * 1.1) && (Math.max(absHi, absLo) <= Math.min(absHi, absLo) * 3.0))) {
          wedgeDebug.push({ accepted: false, type: 'wedge_window', reason: 'slope_ratio_out_of_range', indices: [startIdx, endIdx] as any, details: { ratio } });
          continue;
        }

        // minWeakerSlopeRatio チェック: 弱い方のラインが強い方の30%以上の傾きを持つ
        const minWeakerSlopeRatio = 0.3;
        const weakerSlope = Math.min(absHi, absLo);
        const strongerSlope = Math.max(absHi, absLo);
        const weakerRatio = weakerSlope / Math.max(1e-12, strongerSlope);
        if (weakerRatio < minWeakerSlopeRatio) {
          wedgeDebug.push({
            accepted: false,
            type: 'wedge_window',
            reason: 'weaker_slope_too_flat',
            indices: [startIdx, endIdx] as any,
            details: {
              absHi,
              absLo,
              weakerRatio: Number(weakerRatio.toFixed(3)),
              minRequired: minWeakerSlopeRatio
            }
          });
          continue;
        }

        const wedgeType: 'falling_wedge' | 'rising_wedge' | null = bothDown ? 'falling_wedge' : (bothUp ? 'rising_wedge' : null);
        if (!wedgeType) continue;
        // 収束
        const gapStart = up.valueAt(startIdx) - lo.valueAt(startIdx);
        const gapEnd = up.valueAt(endIdx) - lo.valueAt(endIdx);
        if (!(gapStart > 0 && gapEnd > 0)) {
          wedgeDebug.push({
            accepted: false,
            type: wedgeType,
            reason: 'gap_non_positive',
            indices: [startIdx, endIdx] as any,
            details: {
              gapStart,
              gapEnd,
              upStart: up.valueAt(startIdx),
              upEnd: up.valueAt(endIdx),
              loStart: lo.valueAt(startIdx),
              loEnd: lo.valueAt(endIdx),
            }
          });
          continue;
        }
        const convRatio = gapEnd / Math.max(1e-12, gapStart); // 小さいほど収束
        // 収束チェック: 1) 収束度が0.80未満、かつ 2) 実際に収束している（拡大パターンを除外）
        if (!(convRatio < 0.80 && gapEnd < gapStart)) {
          wedgeDebug.push({
            accepted: false,
            type: wedgeType,
            reason: 'not_converging_enough',
            indices: [startIdx, endIdx] as any,
            details: {
              convRatio,
              gapStart,
              gapEnd,
              isExpanding: gapEnd >= gapStart,
              upStart: up.valueAt(startIdx),
              upEnd: up.valueAt(endIdx),
              loStart: lo.valueAt(startIdx),
              loEnd: lo.valueAt(endIdx),
            }
          });
          continue;
        }
        const convergeScore = Math.max(0, Math.min(1, 1 - convRatio)); // 0~1
        // 価格比率ベースのタッチ評価（ラインの0.5%以内をタッチと判定）
        const atr = calcATR(startIdx, endIdx, 14);
        const touchThresholdPct = 0.005; // 0.5%
        const upTouchesIdx: number[] = [];
        const loTouchesIdx: number[] = [];
        for (let i = startIdx; i <= endIdx; i++) {
          const u = up.valueAt(i), l = lo.valueAt(i);
          const hi = Number(candles[i]?.high ?? NaN);
          const lw = Number(candles[i]?.low ?? NaN);
          // 上限ライン: 高値がラインの0.5%以内
          const thrUp = Math.abs(u) * touchThresholdPct;
          if (Number.isFinite(hi) && Math.abs(hi - u) <= thrUp && hi <= u + thrUp) upTouchesIdx.push(i);
          // 下限ライン: 安値がラインの0.5%以内
          const thrLo = Math.abs(l) * touchThresholdPct;
          if (Number.isFinite(lw) && Math.abs(lw - l) <= thrLo && lw >= l - thrLo) loTouchesIdx.push(i);
        }
        if (upTouchesIdx.length < 2 || loTouchesIdx.length < 2) { wedgeDebug.push({ accepted: false, type: wedgeType, reason: 'insufficient_touches', indices: [startIdx, endIdx] as any, details: { upTouches: upTouchesIdx.length, loTouches: loTouchesIdx.length, touchThresholdPct } }); continue; }

        // タッチ間隔チェック（25本以内）
        const calcMaxGap = (touchIndices: number[]): number => {
          if (touchIndices.length < 2) return 0;
          const sorted = [...touchIndices].sort((a, b) => a - b);
          let maxGap = 0;
          for (let i = 1; i < sorted.length; i++) {
            const gap = sorted[i] - sorted[i - 1];
            if (gap > maxGap) maxGap = gap;
          }
          return maxGap;
        };
        const maxTouchGap = 25; // 日足で25本（約1ヶ月）
        const upperMaxGap = calcMaxGap(upTouchesIdx);
        const lowerMaxGap = calcMaxGap(loTouchesIdx);
        const maxGap = Math.max(upperMaxGap, lowerMaxGap);
        if (maxGap > maxTouchGap) {
          wedgeDebug.push({
            accepted: false,
            type: wedgeType,
            reason: 'touch_gap_too_large',
            indices: [startIdx, endIdx] as any,
            details: { upperMaxGap, lowerMaxGap, maxGap, maxAllowed: maxTouchGap }
          });
          continue;
        }

        // 開始日ギャップチェック（10本以内）
        const maxStartGap = 10;
        const firstUpperTouch = upTouchesIdx[0];
        const firstLowerTouch = loTouchesIdx[0];
        const startGap = Math.abs(firstUpperTouch - firstLowerTouch);
        if (startGap > maxStartGap) {
          wedgeDebug.push({
            accepted: false,
            type: wedgeType,
            reason: 'start_gap_too_large',
            indices: [startIdx, endIdx] as any,
            details: {
              firstUpperIdx: firstUpperTouch,
              firstLowerIdx: firstLowerTouch,
              startGap,
              maxAllowed: maxStartGap
            }
          });
          continue;
        }

        const touchesScore = Math.max(0, Math.min(1, (upTouchesIdx.length + loTouchesIdx.length) / 8));
        // R2/fit
        const fitScore = Math.max(0, Math.min(1, (up.r2 + lo.r2) / 2));
        // 内側率
        const inside = insideRatio(up, lo, startIdx, endIdx);
        // 期間スコア（短期でも落ち過ぎない）
        const bars = Math.max(1, endIdx - startIdx);
        const durationMid = (windowSizeMin + windowSizeMax) / 2;
        const durationScore = Math.max(0, Math.min(1, 1 - Math.abs(bars - durationMid) / Math.max(1, (windowSizeMax - windowSizeMin) / 2)));
        // アペックス接近度
        let apexIdx: number | null = null;
        try {
          // up.slope*x + up.int = lo.slope*x + lo.int
          const denom = (up.slope - lo.slope);
          if (Math.abs(denom) > 1e-12) {
            const x = (lo.intercept - up.intercept) / denom;
            apexIdx = Math.round(x);
          }
        } catch { apexIdx = null; }
        const apexProximity = (() => {
          if (apexIdx == null || !Number.isFinite(apexIdx)) return 0;
          if (apexIdx <= endIdx) return 1; // すでに近辺
          const total = Math.max(1, apexIdx - startIdx);
          const progressed = Math.max(0, endIdx - startIdx);
          return Math.max(0, Math.min(1, progressed / total));
        })();
        const recencyBonus = Math.max(0, Math.min(1, (lastIdx - endIdx) <= 2 ? 1 : ((lastIdx - endIdx) <= 5 ? 0.5 : 0)));
        // 総合スコア
        let confidence =
          weights.converge * convergeScore +
          weights.fit * fitScore +
          weights.touches * touchesScore +
          weights.inside * inside +
          weights.duration * durationScore +
          weights.apexProximity * apexProximity +
          weights.recencyBonus * recencyBonus;
        confidence = Math.max(0, Math.min(1, confidence));
        // 進行度
        const completion = Math.max(0, Math.min(1, 0.7 * convergeScore + 0.3 * apexProximity));
        // 実用情報
        const apexDate = apexIdx != null && Number.isFinite(apexIdx) ? isoAt(Math.max(0, Math.min(lastIdx, apexIdx))) : undefined;
        const daysToApex = (() => {
          if (apexIdx == null || !Number.isFinite(apexIdx)) return undefined;
          const barsLeft = Math.max(0, apexIdx - endIdx);
          const d = Math.round(barsLeft * daysPerBarCalc(String(type)));
          return d;
        })();
        const gap0 = gapStart;
        const lastClose = Number(candles[endIdx]?.close ?? NaN);
        const breakoutTarget = Number.isFinite(lastClose) ? (wedgeType === 'falling_wedge' ? Math.round(lastClose + gap0) : Math.round(lastClose - gap0)) : undefined;
        const invalidationPrice = (() => {
          const uNow = up.valueAt(endIdx), lNow = lo.valueAt(endIdx);
          if (!Number.isFinite(uNow) || !Number.isFinite(lNow)) return undefined;
          return wedgeType === 'falling_wedge' ? Math.round(lNow - atr * 0.5) : Math.round(uNow + atr * 0.5);
        })();
        // ステータス
        let status: 'active' | 'mature' | 'breaking' | 'invalid' | 'near_invalidation' = 'active';
        const nearUpper = Number.isFinite(lastClose) ? (Math.abs(lastClose - up.valueAt(endIdx)) <= atr * 0.3) : false;
        const nearLower = Number.isFinite(lastClose) ? (Math.abs(lastClose - lo.valueAt(endIdx)) <= atr * 0.3) : false;

        // 【重要】パターン形成期間中〜最新までのブレイク検出
        // 持続的なブレイク（ラインに戻らず継続）の開始位置を検出
        const breakDetection = (() => {
          const breakIdx = (() => {
            // パターン形成がある程度進んでから（最低20本または期間の30%経過後）スキャン開始
            const patternBars = endIdx - startIdx;
            const scanStart = startIdx + Math.max(20, Math.floor(patternBars * 0.3));
            const scanEnd = Math.max(endIdx, lastIdx);

            let firstBreakOfCurrentSequence = -1;

            for (let i = scanStart; i <= scanEnd; i++) {
              const close = Number(candles[i]?.close ?? NaN);
              if (!Number.isFinite(close)) continue;

              const uLine = up.valueAt(i);
              const lLine = lo.valueAt(i);
              if (!Number.isFinite(uLine) || !Number.isFinite(lLine)) continue;

              if (wedgeType === 'falling_wedge') {
                // 上側ラインを実体ベースで上抜け（ATR * 0.5 バッファ）→ 強気ブレイクアウト
                // または下側ラインを下抜け → 弱気ブレイクアウト（パターン失敗）
                if (close > uLine + atr * 0.5 || close < lLine - atr * 0.5) {
                  if (firstBreakOfCurrentSequence === -1) {
                    firstBreakOfCurrentSequence = i; // 新しいブレイクシーケンス開始
                  }
                } else if (close > lLine + atr * 0.2 && close < uLine - atr * 0.2) {
                  // ウェッジ内に明確に戻った場合のみブレイクシーケンスをリセット
                  firstBreakOfCurrentSequence = -1;
                }
              } else {
                // Rising Wedge: 下側ラインを実体ベースで下抜け（ATR * 0.5 バッファ）→ 弱気ブレイクアウト
                // または上側ラインを上抜け → 強気ブレイクアウト（パターン失敗）
                if (close < lLine - atr * 0.5 || close > uLine + atr * 0.5) {
                  if (firstBreakOfCurrentSequence === -1) {
                    firstBreakOfCurrentSequence = i; // 新しいブレイクシーケンス開始
                  }
                } else if (close > lLine + atr * 0.2 && close < uLine - atr * 0.2) {
                  // ウェッジ内に明確に戻った場合のみブレイクシーケンスをリセット
                  firstBreakOfCurrentSequence = -1;
                }
              }
            }
            return firstBreakOfCurrentSequence;
          })();

          return {
            detected: breakIdx !== -1,
            breakIdx,
            breakIsoTime: breakIdx !== -1 ? isoAt(breakIdx) : null,
            barsAgo: breakIdx !== -1 ? (lastIdx - breakIdx) : null,
            breakPrice: breakIdx !== -1 ? Number(candles[breakIdx]?.close ?? NaN) : null,
          };
        })();

        // ブレイク検出時は即座にinvalidステータス
        if (breakDetection.detected) {
          status = 'invalid';
        }

        // 現在価格を取得
        const currentPrice = Number(candles[lastIdx]?.close ?? NaN);

        // ブレイク未検出の場合のみ、追加の無効化判定を実施
        let invalidationIdx: number | null = null; // 無効化された最初のインデックス
        if (!breakDetection.detected && Number.isFinite(currentPrice)) {
          // ラインを最新（lastIdx）まで延長
          const uAtCurrent = up.valueAt(lastIdx);
          const lAtCurrent = lo.valueAt(lastIdx);

          if (Number.isFinite(uAtCurrent) && Number.isFinite(lAtCurrent)) {
            const atrBuffer = atr * 0.5;

            if (wedgeType === 'falling_wedge') {
              // 下降ウェッジ（上昇転換パターン）
              // 上方ブレイク（強気転換）または下方ブレイク（パターン失敗）を検出
              const upperBreakLine = uAtCurrent + atrBuffer;
              const lowerBreakLine = lAtCurrent - atrBuffer;

              if (currentPrice > upperBreakLine) {
                // 上方ブレイクアウト → 強気転換（無効化扱い）
                status = 'invalid';
                for (let i = endIdx; i <= lastIdx; i++) {
                  const px = Number(candles[i]?.close ?? NaN);
                  const lineAtI = up.valueAt(i) + atr * 0.5;
                  if (Number.isFinite(px) && Number.isFinite(lineAtI) && px > lineAtI) {
                    invalidationIdx = i;
                    break;
                  }
                }
              } else if (currentPrice < lowerBreakLine) {
                // 下方ブレイクアウト → パターン失敗（無効化）
                status = 'invalid';
                for (let i = endIdx; i <= lastIdx; i++) {
                  const px = Number(candles[i]?.close ?? NaN);
                  const lineAtI = lo.valueAt(i) - atr * 0.5;
                  if (Number.isFinite(px) && Number.isFinite(lineAtI) && px < lineAtI) {
                    invalidationIdx = i;
                    break;
                  }
                }
              } else if (currentPrice < lAtCurrent || currentPrice > uAtCurrent) {
                // ウェッジ外に出ている場合は無効化寸前
                status = 'near_invalidation';
              }
            } else {
              // 上昇ウェッジ（下落転換パターン）
              // 下方ブレイク（弱気転換）または上方ブレイク（パターン失敗）を検出
              const upperBreakLine = uAtCurrent + atrBuffer;
              const lowerBreakLine = lAtCurrent - atrBuffer;

              if (currentPrice < lowerBreakLine) {
                // 下方ブレイクアウト → 弱気転換（無効化扱い）
                status = 'invalid';
                for (let i = endIdx; i <= lastIdx; i++) {
                  const px = Number(candles[i]?.close ?? NaN);
                  const lineAtI = lo.valueAt(i) - atr * 0.5;
                  if (Number.isFinite(px) && Number.isFinite(lineAtI) && px < lineAtI) {
                    invalidationIdx = i;
                    break;
                  }
                }
              } else if (currentPrice > upperBreakLine) {
                // 上方ブレイクアウト → パターン失敗（無効化）
                status = 'invalid';
                for (let i = endIdx; i <= lastIdx; i++) {
                  const px = Number(candles[i]?.close ?? NaN);
                  const lineAtI = up.valueAt(i) + atr * 0.5;
                  if (Number.isFinite(px) && Number.isFinite(lineAtI) && px > lineAtI) {
                    invalidationIdx = i;
                    break;
                  }
                }
              } else if (currentPrice < lAtCurrent || currentPrice > uAtCurrent) {
                // ウェッジ外に出ている場合は無効化寸前
                status = 'near_invalidation';
              }
            }
          }
        }

        // 無効化されていない場合のみ他のステータスを判定
        if (status === 'active') {
          if ((daysToApex ?? 999) <= 10) status = 'mature';
          if (nearUpper || nearLower) status = 'breaking';
        }

        // 無効化/ブレイクアウトされた場合は終了日をその日付に設定
        // 優先順位: 1. breakDetection.breakIsoTime (ブレイクアウト日)
        //          2. invalidationIdx (価格無効化日)
        //          3. endIso (デフォルト)
        const effectiveInvalidationIdx: number | null =
          (breakDetection.detected && typeof breakDetection.breakIdx === 'number')
            ? breakDetection.breakIdx
            : invalidationIdx;
        const effectiveInvalidationIso: string | null =
          (breakDetection.detected && typeof breakDetection.breakIsoTime === 'string')
            ? String(breakDetection.breakIsoTime)
            : (invalidationIdx !== null ? (isoAt(invalidationIdx) || null) : null);
        const effectiveEndIso = (status === 'invalid' && effectiveInvalidationIso)
          ? effectiveInvalidationIso
          : endIso;
        const formation = { bars, formatted: formatPeriod(bars, type), start: startIso, current: effectiveEndIso };
        const obj: any = {
          type: wedgeType,
          status,
          currentPrice: Number.isFinite(currentPrice) ? Math.round(currentPrice) : undefined,
          upperLine: { slope: up.slope, intercept: up.intercept, r2: Number(up.r2.toFixed(3)), touchPoints: upTouchesIdx },
          lowerLine: { slope: lo.slope, intercept: lo.intercept, r2: Number(lo.r2.toFixed(3)), touchPoints: loTouchesIdx },
          completion: Number(completion.toFixed(2)),
          convergenceRatio: Number(convRatio.toFixed(3)),
          apexDate,
          daysToApex,
          breakoutTarget,
          invalidationPrice,
          range: { start: startIso, current: effectiveEndIso },
          candleType: type,
          formationPeriod: formation,
          confidence: Number(confidence.toFixed(2)),
          invalidationDate: effectiveInvalidationIso,
          debug: {
            endIdx,
            lastIdx,
            invalidationIdx: effectiveInvalidationIdx,
            priceAtEnd: Number.isFinite(lastClose) ? Math.round(lastClose) : null,
            priceAtLast: Number.isFinite(currentPrice) ? Math.round(currentPrice) : null,
            lowerLineAtEnd: Number.isFinite(lo.valueAt(endIdx)) ? Math.round(lo.valueAt(endIdx)) : null,
            lowerLineAtLast: Number.isFinite(lo.valueAt(lastIdx)) ? Math.round(lo.valueAt(lastIdx)) : null,
            upperLineAtEnd: Number.isFinite(up.valueAt(endIdx)) ? Math.round(up.valueAt(endIdx)) : null,
            upperLineAtLast: Number.isFinite(up.valueAt(lastIdx)) ? Math.round(up.valueAt(lastIdx)) : null,
            invalidationLine: wedgeType === 'falling_wedge'
              ? (Number.isFinite(lo.valueAt(lastIdx)) ? Math.round(lo.valueAt(lastIdx) - atr * 0.5) : null)
              : (Number.isFinite(up.valueAt(lastIdx)) ? Math.round(up.valueAt(lastIdx) + atr * 0.5) : null),
            breakDetection: {
              detected: breakDetection.detected,
              breakIdx: breakDetection.breakIdx !== -1 ? breakDetection.breakIdx : null,
              breakIsoTime: breakDetection.breakIsoTime,
              barsAgo: breakDetection.barsAgo,
              breakPrice: (breakDetection.breakPrice !== null && Number.isFinite(breakDetection.breakPrice)) ? Math.round(breakDetection.breakPrice) : null,
            },
          },
        };
        patterns.push(obj);
        wedgeDebug.push({
          accepted: true,
          type: wedgeType,
          reason: 'ok',
          indices: [startIdx, endIdx] as any,
          details: { convRatio, r2High: up.r2, r2Low: lo.r2, touches: { up: upTouchesIdx.length, lo: loTouchesIdx.length }, apexProximity, confidence: obj.confidence }
        });
      }
      // debug view で参照できるよう、あとで text に出力
      (globalThis as any).__formingWedgeDebug = wedgeDebug;
    }
  }

  // Wedge 重複排除（終端が近く重複する同構造の候補を間引く）
  try {
    const isWedge = (p: any) => p?.type === 'falling_wedge' || p?.type === 'rising_wedge';
    const wedgeOnly = patterns.filter(isWedge);
    if (wedgeOnly.length >= 2) {
      const parseMs = (iso?: string) => {
        const t = Date.parse(String(iso ?? ''));
        return Number.isFinite(t) ? t : NaN;
      };
      const daysBetween = (aMs: number, bMs: number) => Math.abs(aMs - bMs) / (1000 * 60 * 60 * 24);
      const calcOverlap = (a: any, b: any) => {
        const aStart = parseMs(a?.range?.start);
        const aEnd = parseMs(a?.range?.current);
        const bStart = parseMs(b?.range?.start);
        const bEnd = parseMs(b?.range?.current);
        if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || !Number.isFinite(bStart) || !Number.isFinite(bEnd)) return 0;
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        const minDur = Math.max(1, Math.min(aEnd - aStart, bEnd - bStart));
        return overlap / minDur; // 0..1
      };
      const avgR2 = (p: any) => {
        const up = Number(p?.upperLine?.r2 ?? 0);
        const lo = Number(p?.lowerLine?.r2 ?? 0);
        return (up + lo) / 2;
      };
      const endMs = (p: any) => parseMs(p?.range?.current);
      const deduped: any[] = [];
      const sorted = [...wedgeOnly].sort((a, b) => {
        const c = Number(b?.confidence ?? 0) - Number(a?.confidence ?? 0);
        if (c !== 0) return c;
        const comp = Number(b?.completion ?? 0) - Number(a?.completion ?? 0);
        if (comp !== 0) return comp;
        const r2 = avgR2(b) - avgR2(a);
        if (r2 !== 0) return r2;
        return endMs(b) - endMs(a);
      });
      for (const p of sorted) {
        const existsSimilar = deduped.some((ex) => {
          if (ex?.type !== p?.type) return false;
          const endClose = daysBetween(endMs(ex), endMs(p)) <= 3;
          const overlapRatio = calcOverlap(ex, p);
          return endClose && overlapRatio > 0.7;
        });
        if (!existsSimilar) deduped.push(p);
      }
      const nonWedge = patterns.filter((p: any) => !isWedge(p));
      const merged = [...nonWedge, ...deduped];
      patterns.length = 0;
      patterns.push(...merged);
    }
  } catch { /* noop */ }

  // forming head_and_shoulders: left_shoulder (peak) -> head (higher peak) -> post_head_valley (valley) -> right_shoulder forming near left_shoulder
  if (want.has('head_and_shoulders')) {
    // compute max bars window from maxPatternDays（やや緩めに1.5倍）
    const barsWindow = Math.max(5, Math.round((maxPatternDays * 1.5) / Math.max(1e-12, daysPerBarCalc(String(type)))));
    // robust peak detection to handle plateau highs（前後3本の範囲で最高値ならピーク）
    const robustPeaks: Array<{ idx: number; price: number }> = [];
    for (let idx = 3; idx <= lastIdx - 3; idx++) {
      const priceH = Number(candles[idx]?.high);
      if (!Number.isFinite(priceH)) continue;
      let isLocalMax = true;
      for (let j = idx - 3; j <= idx + 3; j++) {
        if (j === idx) continue;
        const h = Number(candles[j]?.high);
        if (Number.isFinite(h) && h > priceH) { isLocalMax = false; break; }
      }
      if (isLocalMax && isPivotConfirmed(idx, lastIdx)) {
        // 判定は high に基づくが、格納価格は close を用いてヒゲの影響を回避
        robustPeaks.push({ idx, price: Number(candles[idx]?.close) });
      }
    }
    // fallback to existing peaks if robust detection yields nothing
    const confirmedPeaks = robustPeaks.length ? robustPeaks : peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
    if (confirmedPeaks.length >= 1) {
      // 1) head = 期間内の最高値（確定ピークの中で最大高値）
      const head = confirmedPeaks.reduce((best, p) => (p.price > best.price ? p : best), confirmedPeaks[0]);
      // 2) left shoulder: headより左のピークで、期間比率 20%-60% の範囲かつ headより5%以上低い
      const leftCandidates = confirmedPeaks.filter(p => {
        if (p.idx >= head.idx) return false;
        const dist = head.idx - p.idx;
        const ratio = dist / Math.max(1, barsWindow);
        // 緩和: 0.10〜0.80（期間が長めでも短めでも拾えるように）
        return ratio >= 0.10 && ratio <= 0.80 && head.price > p.price * 1.05;
      });
      if (!leftCandidates.length) {
        // fallback: no suitable left shoulder
      } else {
        const left = leftCandidates[leftCandidates.length - 1]; // nearest before head
        if (isPivotConfirmed(left.idx, lastIdx)) {
          // valley after head
          let postValley = valleys.find(v => v.idx > head.idx && isPivotConfirmed(v.idx, lastIdx));
          let provisionalValley: { idx: number; price: number } | null = null;
          let usedValley: { idx: number; price: number } | null = null;
          let provisionalPenalty = 1.0;
          // 頭前の代表谷（ネックラインの水平フォールバック用）
          const preHeadValleys = valleys.filter(v => v.idx > left.idx && v.idx < head.idx && isPivotConfirmed(v.idx, lastIdx));
          const preValley = preHeadValleys.length ? preHeadValleys.reduce((best, v) => (v.price < best.price ? v : best), preHeadValleys[0]) : null;
          if (!postValley) {
            // フォールバック: 右側の確定谷が未出の間は、ネックラインは「頭前の谷」と水平に扱う
            // （ヘッドの最安値を拾う暫定谷は使用しない）
            usedValley = preValley ?? null;
            provisionalPenalty = 0.9;
          } else {
            usedValley = postValley;
          }
          if (!usedValley) { /* no valley, skip */ } else {
            // 探索: 右肩の候補は「頭後の谷」以降に形成された直近の確定ピークを最優先、
            // 見つからなければ同区間の最高値（暫定）を使用
            const rightPeakCandidates = peaks.filter(p =>
              p.idx > usedValley.idx &&
              isPivotConfirmed(p.idx, lastIdx) &&
              p.price < head.price &&
              Math.abs(p.price - left.price) / Math.max(1, left.price) <= rightPeakTolerancePct
            );
            const rightConfirmed = rightPeakCandidates.length ? rightPeakCandidates[rightPeakCandidates.length - 1] : null;
            let rightShoulder: { idx: number; price: number } | null = rightConfirmed;
            let rightPenalty = 1.0;
            if (!rightShoulder) {
              // 暫定右肩: usedValley以降〜現在までの最高値
              let maxIdx = Math.min(lastIdx, usedValley.idx + 1);
              let maxHigh = candles[maxIdx]?.high ?? -Infinity;
              for (let j = usedValley.idx + 1; j <= lastIdx; j++) {
                const hi = candles[j].high;
                if (hi > maxHigh) { maxHigh = hi; maxIdx = j; }
              }
              if (Number.isFinite(maxHigh)) {
                const near = Math.abs(maxHigh - left.price) / Math.max(1, left.price) <= rightPeakTolerancePct;
                if (near && maxHigh < head.price) {
                  // 判定は high、格納は close（ヒゲ影響を避ける）
                  rightShoulder = { idx: maxIdx, price: Number(candles[maxIdx]?.close) };
                  rightPenalty = 0.9;
                }
              }
            }
            if (rightShoulder) {
              const rightPrice = rightShoulder.price;
              const nearLeft = rightPrice / Math.max(1, left.price);
              // 条件: 右肩が谷より上、頭より下、左肩近傍
              if (
                rightPrice > usedValley.price &&
                rightPrice < head.price &&
                nearLeft >= (1 - rightPeakTolerancePct) &&
                nearLeft <= (1 + rightPeakTolerancePct)
              ) {
                // right shoulder progress by closeness to left shoulder
                let closeness = 1 - Math.abs(rightPrice - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct);
                closeness = Math.max(0, Math.min(1, closeness));
                let progress = closeness;
                if (last3Down()) progress = Math.min(1, progress + 0.2);
                const completion = Math.min(1, (0.75 + 0.25 * progress)) * provisionalPenalty * rightPenalty;
                if (completion >= minCompletion) {
                  // neckline: between valley before head and post-head valley (fallback: horizontal at post-head valley)
                  // pre-head valley: 左肩〜頭の区間で「最も低い」確定谷を採用（直前の小谷よりもネックラインの代表性を優先）
                  const preHeadValleys = valleys.filter(v => v.idx > left.idx && v.idx < head.idx && isPivotConfirmed(v.idx, lastIdx));
                  const preValley = preHeadValleys.length ? preHeadValleys.reduce((best, v) => (v.price < best.price ? v : best), preHeadValleys[0]) : null;
                  let nlA = preValley ? { x: preValley.idx, y: preValley.price } : { x: left.idx, y: usedValley.price };
                  let nlB = { x: usedValley.idx, y: usedValley.price };
                  // 過度な傾斜を水平化（H&S）
                  try {
                    const dy = Math.abs(Number(nlA.y) - Number(nlB.y));
                    const denom = Math.max(1e-12, Math.max(Number(nlA.y), Number(nlB.y)));
                    const slopePct = dy / denom;
                    if (slopePct > necklineSlopeTolerancePct) {
                      const avg = Math.round(((Number(nlA.y) + Number(nlB.y)) / 2));
                      nlA = { ...nlA, y: avg };
                      nlB = { ...nlB, y: avg };
                    }
                  } catch { /* noop */ }
                  // 対称性チェック（頭前/頭後の谷の差）: 後段で反映するためフラグ化
                  let skipDueToAsymmetry = false;
                  let symPenalty = 1.0;
                  let symWarnNeeded = false;
                  if (preValley) {
                    const symDiffTmp = Math.abs(preValley.price - usedValley.price) / Math.max(1e-12, Math.max(preValley.price, usedValley.price));
                    if (symDiffTmp > prePostSymmetryTolerancePct * 1.5) {
                      skipDueToAsymmetry = true;
                    } else if (symDiffTmp > prePostSymmetryTolerancePct) {
                      symPenalty = 0.85;
                      symWarnNeeded = true;
                    }
                  }
                  const start = isoAt(left.idx);
                  const cur = isoAt(lastIdx);
                  let confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
                  confBase = confBase * provisionalPenalty * rightPenalty;
                  confBase = Math.max(0, Math.min(1, confBase * symPenalty));
                  let confidence = Math.round(confBase * 100) / 100;
                  // formation period: end at confirmed right shoulder when confirmed
                  const formationEndIdx = rightPenalty < 1.0 ? lastIdx : rightShoulder.idx;
                  // 形成区間は「左肩ピーク ↔ 右肩ピーク（暫定なら現在）」で表す
                  const shoulderStartIdx = left.idx;
                  const shoulderEndIdx = rightShoulder ? rightShoulder.idx : lastIdx;
                  const formationBars = Math.max(0, shoulderEndIdx - shoulderStartIdx);
                  const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: isoAt(shoulderStartIdx), end: isoAt(shoulderEndIdx), status: (rightPenalty < 1.0) ? 'forming' : 'completed_pending_breakout' };
                  const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
                  if (!skipDueToAsymmetry && patternDays >= getMinPatternDays('head_and_shoulders') && patternDays <= Math.round(Number(maxPatternDays))) {
                    const scale_validation = buildScaleValidation(formationBars);
                    const nlY = Number(usedValley.price);
                    const br = detectBreakout(rightShoulder.idx, nlY, false, 0.02);
                    // Freshness/coverage/approach penalties（H&S版）
                    const formationEndIdx2 = (rightPenalty < 1.0) ? lastIdx : rightShoulder.idx;
                    const formationBars2 = Math.max(0, formationEndIdx2 - left.idx);
                    const covRatio = Number(limit) > 0 ? (formationBars2 / Number(limit)) : 1;
                    if (covRatio < 0.2) confidence = Math.max(0, Number((confidence * 0.75).toFixed(2)));
                    else if (covRatio < 0.3) confidence = Math.max(0, Number((confidence * 0.85).toFixed(2)));
                    const currentPx = priceAt(lastIdx);
                    const diffPctToNeckline = ((currentPx - nlY) / Math.max(1e-12, nlY)) * 100; // H&Sでは下抜けが完成方向
                    let completionAdj = completion;
                    if (diffPctToNeckline > 10) completionAdj = Number((completionAdj * 0.7).toFixed(2));
                    else if (diffPctToNeckline > 5) completionAdj = Number((completionAdj * 0.85).toFixed(2));
                    const barsSinceRight = Math.max(0, lastIdx - rightShoulder.idx);
                    if (barsSinceRight > maxBarsFromLastPivot) {
                      confidence = Math.min(confidence, 0.6);
                      completionAdj = Math.min(completionAdj, 0.7);
                    }
                    // 対称性の警告用に再計算
                    const valleySymWarn = (() => {
                      if (!preValley) return null;
                      const sd = Math.abs(preValley.price - usedValley.price) / Math.max(1e-12, Math.max(preValley.price, usedValley.price));
                      return sd > prePostSymmetryTolerancePct ? `頭前/頭後の谷の深さ差が大きい（${(sd * 100).toFixed(1)}%）` : null;
                    })();
                    // ステータス決定
                    let finalStatus: 'forming' | 'completed_active' | 'invalidated' | 'expired' = 'forming';
                    if (br.invalidated) {
                      finalStatus = 'invalidated';
                    } else if (br.completed) {
                      finalStatus = br.barsSinceBreak <= maxBarsFromBreakout ? 'completed_active' : 'expired';
                    }
                    if (!(finalStatus === 'expired' || finalStatus === 'invalidated')) {
                      patterns.push({
                        type: 'head_and_shoulders',
                        completion: Number(completionAdj.toFixed(2)),
                        confidence,
                        status: finalStatus,
                        range: { start: isoAt(shoulderStartIdx), current: isoAt(shoulderEndIdx) },
                        rangeAnchors: {
                          startRole: 'left_shoulder',
                          endRole: 'right_shoulder',
                          startIdx: shoulderStartIdx,
                          endIdx: shoulderEndIdx,
                          startIso: isoAt(shoulderStartIdx),
                          endIso: isoAt(shoulderEndIdx),
                        },
                        candleType: type,
                        formationPeriod: formation,
                        scale_validation,
                        breakout: { completed: br.completed, invalidated: br.invalidated, direction: br.completed ? 'down' : null, barsAgo: br.barsSinceBreak, effectiveness: (!br.invalidated && br.completed) ? 'active' : null },
                        confirmedPivots: [
                          { role: 'left_shoulder', price: left.price, idx: left.idx, isoTime: start, formatted: fmtDate(start) },
                          { role: 'head', price: head.price, idx: head.idx, isoTime: isoAt(head.idx), formatted: fmtDate(isoAt(head.idx)) },
                          ...(preValley ? [{ role: 'pre_head_valley', price: preValley.price, idx: preValley.idx, isoTime: isoAt(preValley.idx), formatted: fmtDate(isoAt(preValley.idx)) }] : []),
                          ...(postValley ? [{ role: 'post_head_valley', price: postValley.price, idx: postValley.idx, isoTime: isoAt(postValley.idx), formatted: fmtDate(isoAt(postValley.idx)) }] : []),
                        ],
                        formingPivots: [
                          { role: rightPenalty < 1.0 ? 'right_shoulder_provisional' : 'right_shoulder', price: rightPrice, idx: rightShoulder.idx, progress: Number(progress.toFixed(2)), isoTime: isoAt(rightShoulder.idx), formatted: fmtDate(isoAt(rightShoulder.idx)) },
                        ],
                        neckline: [nlA, nlB],
                        scenarios: {
                          completion: { priceRange: [Math.round(left.price * 0.98), Math.round(left.price * 1.02)], description: 'この価格帯で反転下落すればパターン完成' },
                          invalidation: { priceLevel: Math.round(head.price * 1.012), description: `${Math.round(head.price * 1.012).toLocaleString()}円を上抜けたらパターン無効` },
                        },
                        warnings: [
                          ...(br.completed && br.barsSinceBreak <= maxBarsFromBreakout ? ['ネックライン下抜け済み（直近）'] : []),
                          ...(barsSinceRight > maxBarsFromLastPivot ? [`右肩確定から${barsSinceRight}本経過（鮮度低下）`] : []),
                          ...(diffPctToNeckline > 5 ? [`ネックラインまでの乖離 +${diffPctToNeckline.toFixed(1)}%`] : []),
                          ...(covRatio < 0.3 ? [`低カバレッジ（${(covRatio * 100).toFixed(1)}%）— limit調整推奨`] : []),
                          ...(valleySymWarn ? [valleySymWarn] : []),
                        ].length ? [
                          ...(br.completed && br.barsSinceBreak <= maxBarsFromBreakout ? ['ネックライン下抜け済み（直近）'] : []),
                          ...(barsSinceRight > maxBarsFromLastPivot ? [`右肩確定から${barsSinceRight}本経過（鮮度低下）`] : []),
                          ...(diffPctToNeckline > 5 ? [`ネックラインまでの乖離 +${diffPctToNeckline.toFixed(1)}%`] : []),
                          ...(covRatio < 0.3 ? [`低カバレッジ（${(covRatio * 100).toFixed(1)}%）— limit調整推奨`] : []),
                          ...(valleySymWarn ? [valleySymWarn] : []),
                        ] : undefined,
                        nextSteps: [
                          `${Math.round(left.price * 0.997).toLocaleString()}-${Math.round(left.price * 1.005).toLocaleString()}円での反転シグナルを監視`,
                          `完成後はネックライン${Math.round(usedValley.price).toLocaleString()}円の下抜けを監視`,
                        ],
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // forming triple_top: two confirmed peaks (near equal) and current rising toward their level, with a confirmed valley after the second peak
    if (want.has('triple_top')) {
      // find last two confirmed peaks with a confirmed valley after the second peak
      const confirmedPeaks = peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
      if (confirmedPeaks.length >= 2) {
        const p2 = confirmedPeaks[confirmedPeaks.length - 1];
        const p1 = confirmedPeaks[confirmedPeaks.length - 2];
        const valleyAfter = valleys.find(v => v.idx > p2.idx && isPivotConfirmed(v.idx, lastIdx));
        if (valleyAfter) {
          // peaks should be near equal
          const near = (a: number, b: number, tolPct: number) => Math.abs(a - b) / Math.max(1, Math.max(a, b)) <= tolPct;
          if (near(p1.price, p2.price, rightPeakTolerancePct)) {
            const currentPrice = priceAt(lastIdx);
            // current near the average of p1/p2 and above valley
            const avgPeak = (p1.price + p2.price) / 2;
            const nearAvg = Math.abs(currentPrice - avgPeak) / Math.max(1, avgPeak) <= rightPeakTolerancePct;
            if (nearAvg && currentPrice > valleyAfter.price) {
              // completion ratio by how close current is to avgPeak from valley
              const ratio = (currentPrice - valleyAfter.price) / Math.max(1e-12, avgPeak - valleyAfter.price);
              let progress = Math.max(0, Math.min(1, ratio));
              if (last3Down()) progress = Math.min(1, progress + 0.2);
              const completion = Math.min(1, 0.66 + progress * 0.34);
              if (completion >= minCompletion) {
                const start = isoAt(p1.idx);
                const cur = isoAt(lastIdx);
                const formationBars = Math.max(0, lastIdx - p1.idx);
                const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
                // min pattern days check
                const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
                if (patternDays >= getMinPatternDays('triple_top')) {
                  const scale_validation = buildScaleValidation(formationBars);
                  const confBase = Math.min(1, Math.max(0, (1 - Math.abs((currentPrice - avgPeak) / Math.max(1, avgPeak))) * 0.6 + progress * 0.4));
                  const confidence = Math.round(confBase * 100) / 100;
                  const neckline = [{ x: p1.idx, y: valleyAfter.price }, { x: lastIdx, y: valleyAfter.price }];
                  patterns.push({
                    type: 'triple_top',
                    completion: Number(completion.toFixed(2)),
                    confidence,
                    status: 'forming',
                    range: { start, current: cur },
                    candleType: type,
                    formationPeriod: formation,
                    scale_validation,
                    confirmedPivots: [
                      { role: 'left_peak', price: p1.price, idx: p1.idx, isoTime: start, formatted: fmtDate(start) },
                      { role: 'mid_peak', price: p2.price, idx: p2.idx, isoTime: isoAt(p2.idx), formatted: fmtDate(isoAt(p2.idx)) },
                      { role: 'valley_after_mid', price: valleyAfter.price, idx: valleyAfter.idx, isoTime: isoAt(valleyAfter.idx), formatted: fmtDate(isoAt(valleyAfter.idx)) },
                    ],
                    formingPivots: [
                      { role: 'right_peak', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                    ],
                    neckline,
                    scenarios: {
                      completion: { priceRange: [Math.round(avgPeak * (1 - rightPeakTolerancePct)), Math.round(avgPeak * (1 + rightPeakTolerancePct))], description: 'この価格帯で反転下落すればパターン完成' },
                      invalidation: { priceLevel: Math.round(avgPeak * (1 + rightPeakTolerancePct * 0.6)), description: `${Math.round(avgPeak * (1 + rightPeakTolerancePct * 0.6)).toLocaleString()}円を上抜けたらパターン無効` },
                    },
                    nextSteps: [
                      `${Math.round(avgPeak * (1 - rightPeakTolerancePct * 0.2)).toLocaleString()}-${Math.round(avgPeak * (1 + rightPeakTolerancePct * 0.2)).toLocaleString()}円での反転シグナルを監視`,
                      `完成後はネックライン${Math.round(valleyAfter.price).toLocaleString()}円の下抜けでショートエントリー検討`,
                    ],
                  });
                }
              }
            }
          }
        }
      }
    }

    // forming triple_bottom: two confirmed valleys (near equal) and current falling toward their level, with a confirmed peak after the second valley
    if (want.has('triple_bottom')) {
      const confirmedValleys = valleys.filter(v => isPivotConfirmed(v.idx, lastIdx));
      if (confirmedValleys.length >= 2) {
        const v2 = confirmedValleys[confirmedValleys.length - 1];
        const v1 = confirmedValleys[confirmedValleys.length - 2];
        const peakAfter = peaks.find(p => p.idx > v2.idx && isPivotConfirmed(p.idx, lastIdx));
        if (peakAfter) {
          const near = (a: number, b: number, tolPct: number) => Math.abs(a - b) / Math.max(1, Math.max(a, b)) <= tolPct;
          if (near(v1.price, v2.price, rightPeakTolerancePct)) {
            const currentPrice = priceAt(lastIdx);
            const avgValley = (v1.price + v2.price) / 2;
            const nearAvg = Math.abs(currentPrice - avgValley) / Math.max(1, avgValley) <= rightPeakTolerancePct;
            if (nearAvg && currentPrice < peakAfter.price) {
              const ratio = (peakAfter.price - currentPrice) / Math.max(1e-12, peakAfter.price - avgValley);
              let progress = Math.max(0, Math.min(1, ratio));
              if (!last3Down()) progress = Math.min(1, progress + 0.2);
              const completion = Math.min(1, 0.66 + progress * 0.34);
              if (completion >= minCompletion) {
                const start = isoAt(v1.idx);
                const cur = isoAt(lastIdx);
                const formationBars = Math.max(0, lastIdx - v1.idx);
                const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
                const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
                if (patternDays >= getMinPatternDays('triple_bottom')) {
                  const scale_validation = buildScaleValidation(formationBars);
                  const confBase = Math.min(1, Math.max(0, (1 - Math.abs((currentPrice - avgValley) / Math.max(1, avgValley))) * 0.6 + progress * 0.4));
                  const confidence = Math.round(confBase * 100) / 100;
                  const neckline = [{ x: v1.idx, y: peakAfter.price }, { x: lastIdx, y: peakAfter.price }];
                  patterns.push({
                    type: 'triple_bottom',
                    completion: Number(completion.toFixed(2)),
                    confidence,
                    status: 'forming',
                    range: { start, current: cur },
                    candleType: type,
                    formationPeriod: formation,
                    scale_validation,
                    confirmedPivots: [
                      { role: 'left_valley', price: v1.price, idx: v1.idx, isoTime: start, formatted: fmtDate(start) },
                      { role: 'mid_peak', price: peakAfter.price, idx: peakAfter.idx, isoTime: isoAt(peakAfter.idx), formatted: fmtDate(isoAt(peakAfter.idx)) },
                      { role: 'right_valley', price: v2.price, idx: v2.idx, isoTime: isoAt(v2.idx), formatted: fmtDate(isoAt(v2.idx)) },
                    ],
                    formingPivots: [
                      { role: 'third_valley', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                    ],
                    neckline,
                    scenarios: {
                      completion: { priceRange: [Math.round(avgValley * (1 - rightPeakTolerancePct)), Math.round(avgValley * (1 + rightPeakTolerancePct))], description: 'この価格帯で反転上昇すればパターン完成' },
                      invalidation: { priceLevel: Math.round(avgValley * (1 - rightPeakTolerancePct * 0.6)), description: `${Math.round(avgValley * (1 - rightPeakTolerancePct * 0.6)).toLocaleString()}円を下抜けたらパターン無効` },
                    },
                    nextSteps: [
                      `${Math.round(avgValley * (1 - rightPeakTolerancePct * 0.2)).toLocaleString()}-${Math.round(avgValley * (1 + rightPeakTolerancePct * 0.2)).toLocaleString()}円での反転シグナルを監視`,
                      `完成後はネックライン${Math.round(peakAfter.price).toLocaleString()}円の上抜けでロングエントリー検討`,
                    ],
                  });
                }
              }
            }
          }
        }
      }
    }

    // forming triangle_descending: lows roughly flat (2+ valleys near-equal), highs falling (last confirmed peak < prev confirmed peak)
    if (want.has('triangle_descending')) {
      const confirmedPeaks = peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
      const confirmedValleys = valleys.filter(v => isPivotConfirmed(v.idx, lastIdx));
      if (confirmedPeaks.length >= 2 && confirmedValleys.length >= 2) {
        const lastPeak = confirmedPeaks[confirmedPeaks.length - 1];
        const prevPeak = confirmedPeaks[confirmedPeaks.length - 2];
        const lastValley = confirmedValleys[confirmedValleys.length - 1];
        const prevValley = confirmedValleys[confirmedValleys.length - 2];
        const fallingHighs = lastPeak.price < prevPeak.price * (1 - 0.01); // 1% lower
        const flatLows = Math.abs(lastValley.price - prevValley.price) / Math.max(1, Math.max(lastValley.price, prevValley.price)) <= Math.max(0.02, rightPeakTolerancePct * 0.5);
        if (fallingHighs && flatLows) {
          const flatLow = (lastValley.price + prevValley.price) / 2;
          const currentPrice = priceAt(lastIdx);
          // require current between lastPeak and flatLow
          if (currentPrice < lastPeak.price && currentPrice > flatLow * (1 - 0.02)) {
            // completion by closeness to flat support
            const span = Math.max(1e-12, lastPeak.price - flatLow);
            let progress = Math.max(0, Math.min(1, (lastPeak.price - currentPrice) / span));
            if (last3Down()) progress = Math.min(1, progress + 0.1);
            const completion = Math.min(1, 0.6 + progress * 0.4);
            if (completion >= minCompletion) {
              const startIdx = Math.min(prevPeak.idx, prevValley.idx);
              const start = isoAt(startIdx);
              const cur = isoAt(lastIdx);
              const formationBars = Math.max(0, lastIdx - startIdx);
              const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
              const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
              if (patternDays >= getMinPatternDays('triangle_descending')) {
                const scale_validation = buildScaleValidation(formationBars);
                const confBase = Math.min(1, Math.max(0, 0.5 * progress + 0.5 * (1 - Math.abs((lastPeak.price - prevPeak.price) / Math.max(1, prevPeak.price))))); // crude
                const confidence = Math.round(confBase * 100) / 100;
                const neckline = [{ x: startIdx, y: flatLow }, { x: lastIdx, y: flatLow }];
                patterns.push({
                  type: 'triangle_descending',
                  completion: Number(completion.toFixed(2)),
                  confidence,
                  status: 'forming',
                  range: { start, current: cur },
                  candleType: type,
                  formationPeriod: formation,
                  scale_validation,
                  confirmedPivots: [
                    { role: 'prev_peak', price: prevPeak.price, idx: prevPeak.idx, isoTime: isoAt(prevPeak.idx), formatted: fmtDate(isoAt(prevPeak.idx)) },
                    { role: 'last_peak', price: lastPeak.price, idx: lastPeak.idx, isoTime: isoAt(lastPeak.idx), formatted: fmtDate(isoAt(lastPeak.idx)) },
                    { role: 'flat_low_1', price: prevValley.price, idx: prevValley.idx, isoTime: isoAt(prevValley.idx), formatted: fmtDate(isoAt(prevValley.idx)) },
                    { role: 'flat_low_2', price: lastValley.price, idx: lastValley.idx, isoTime: isoAt(lastValley.idx), formatted: fmtDate(isoAt(lastValley.idx)) },
                  ],
                  formingPivots: [
                    { role: 'inside_consolidation', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                  ],
                  neckline,
                  scenarios: {
                    completion: { priceRange: [Math.round(flatLow * 0.995), Math.round(flatLow * 1.005)], description: 'フラットサポート付近での下抜けで完成' },
                    invalidation: { priceLevel: Math.round(prevPeak.price * 1.01), description: `${Math.round(prevPeak.price * 1.01).toLocaleString()}円超の上抜けで形状否定` },
                  },
                  nextSteps: [
                    `サポート${Math.round(flatLow).toLocaleString()}円の攻防を監視`,
                    '下抜け時の出来高増加が伴えばブレイクの信頼性が高まる',
                  ],
                });
              }
            }
          }
        }
      }
    }

    // forming triangle_ascending: highs roughly flat, lows rising
    if (want.has('triangle_ascending')) {
      const confirmedPeaks = peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
      const confirmedValleys = valleys.filter(v => isPivotConfirmed(v.idx, lastIdx));
      if (confirmedPeaks.length >= 2 && confirmedValleys.length >= 2) {
        const lastPeak = confirmedPeaks[confirmedPeaks.length - 1];
        const prevPeak = confirmedPeaks[confirmedPeaks.length - 2];
        const lastValley = confirmedValleys[confirmedValleys.length - 1];
        const prevValley = confirmedValleys[confirmedValleys.length - 2];
        const flatHighs = Math.abs(lastPeak.price - prevPeak.price) / Math.max(1, Math.max(lastPeak.price, prevPeak.price)) <= Math.max(0.02, rightPeakTolerancePct * 0.8);
        const risingLows = lastValley.price > prevValley.price * (1 + Math.max(0.02, rightPeakTolerancePct));
        if (flatHighs && risingLows) {
          const resLine = (lastPeak.price + prevPeak.price) / 2;
          const supNow = lastValley.price;
          const supPrev = prevValley.price;
          const spreadStart = prevPeak.price - supPrev;
          const spreadEnd = lastPeak.price - supNow;
          const converging = spreadEnd < spreadStart * (1 - Math.max(0.01, rightPeakTolerancePct * 0.5));
          if (converging) {
            const currentPrice = priceAt(lastIdx);
            if (currentPrice < resLine && currentPrice > supNow) {
              const span = Math.max(1e-12, resLine - supNow);
              let progress = Math.max(0, Math.min(1, (currentPrice - supNow) / span));
              if (!last3Down()) progress = Math.min(1, progress + 0.1);
              const completion = Math.min(1, 0.66 + 0.34 * progress);
              if (completion >= minCompletion) {
                const startIdx = Math.min(prevPeak.idx, prevValley.idx);
                const start = isoAt(startIdx);
                const cur = isoAt(lastIdx);
                const formationBars = Math.max(0, lastIdx - startIdx);
                const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
                const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
                if (patternDays >= getMinPatternDays('triangle_ascending')) {
                  const scale_validation = buildScaleValidation(formationBars);
                  const confidence = Math.round(Math.min(1, Math.max(0, 0.5 * progress + 0.5)) * 100) / 100;
                  const neckline = [{ x: startIdx, y: resLine }, { x: lastIdx, y: resLine }];
                  patterns.push({
                    type: 'triangle_ascending',
                    completion: Number(completion.toFixed(2)),
                    confidence,
                    status: 'forming',
                    range: { start, current: cur },
                    candleType: type,
                    formationPeriod: formation,
                    scale_validation,
                    confirmedPivots: [
                      { role: 'prev_peak', price: prevPeak.price, idx: prevPeak.idx, isoTime: isoAt(prevPeak.idx), formatted: fmtDate(isoAt(prevPeak.idx)) },
                      { role: 'last_peak', price: lastPeak.price, idx: lastPeak.idx, isoTime: isoAt(lastPeak.idx), formatted: fmtDate(isoAt(lastPeak.idx)) },
                      { role: 'rising_low_prev', price: prevValley.price, idx: prevValley.idx, isoTime: isoAt(prevValley.idx), formatted: fmtDate(isoAt(prevValley.idx)) },
                      { role: 'rising_low_now', price: lastValley.price, idx: lastValley.idx, isoTime: isoAt(lastValley.idx), formatted: fmtDate(isoAt(lastValley.idx)) },
                    ],
                    formingPivots: [
                      { role: 'inside_consolidation', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                    ],
                    neckline,
                    scenarios: {
                      completion: { priceRange: [Math.round(resLine)], description: `${Math.round(resLine).toLocaleString()}円の上抜けで完成` },
                      invalidation: { priceLevel: Math.round(supPrev * 0.99), description: `${Math.round(supPrev * 0.99).toLocaleString()}円割れで形状否定` },
                    },
                    nextSteps: [
                      `レジスタンス${Math.round(resLine).toLocaleString()}円の上抜けを監視`,
                      '上抜け時の出来高増加が伴えばブレイクの信頼性が高まる',
                    ],
                  });
                }
              }
            }
          }
        }
      }
    }

    // forming triangle_symmetrical: highs falling and lows rising with converging range
    if (want.has('triangle_symmetrical')) {
      const confirmedPeaks = peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
      const confirmedValleys = valleys.filter(v => isPivotConfirmed(v.idx, lastIdx));
      if (confirmedPeaks.length >= 2 && confirmedValleys.length >= 2) {
        const lastPeak = confirmedPeaks[confirmedPeaks.length - 1];
        const prevPeak = confirmedPeaks[confirmedPeaks.length - 2];
        const lastValley = confirmedValleys[confirmedValleys.length - 1];
        const prevValley = confirmedValleys[confirmedValleys.length - 2];
        const fallingHighs = lastPeak.price < prevPeak.price * (1 - Math.max(0.01, rightPeakTolerancePct * 0.6));
        const risingLows = lastValley.price > prevValley.price * (1 + Math.max(0.01, rightPeakTolerancePct * 0.6));
        if (fallingHighs && risingLows) {
          const spreadStart = prevPeak.price - prevValley.price;
          const spreadEnd = lastPeak.price - lastValley.price;
          const converging = spreadEnd < spreadStart * (1 - Math.max(0.01, rightPeakTolerancePct * 0.5));
          if (converging) {
            const currentPrice = priceAt(lastIdx);
            if (currentPrice < lastPeak.price && currentPrice > lastValley.price) {
              const qConv = Math.max(0, Math.min(1, (spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8)));
              const completion = Math.min(1, 0.6 + 0.4 * qConv);
              if (completion >= minCompletion) {
                const startIdx = Math.min(prevPeak.idx, prevValley.idx);
                const start = isoAt(startIdx);
                const cur = isoAt(lastIdx);
                const formationBars = Math.max(0, lastIdx - startIdx);
                const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
                const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
                if (patternDays >= getMinPatternDays('triangle_symmetrical')) {
                  const scale_validation = buildScaleValidation(formationBars);
                  const confidence = Math.round(Math.min(1, Math.max(0, 0.5 * qConv + 0.4)) * 100) / 100;
                  patterns.push({
                    type: 'triangle_symmetrical',
                    completion: Number(completion.toFixed(2)),
                    confidence,
                    status: 'forming',
                    range: { start, current: cur },
                    candleType: type,
                    formationPeriod: formation,
                    scale_validation,
                    confirmedPivots: [
                      { role: 'prev_peak', price: prevPeak.price, idx: prevPeak.idx, isoTime: isoAt(prevPeak.idx), formatted: fmtDate(isoAt(prevPeak.idx)) },
                      { role: 'last_peak', price: lastPeak.price, idx: lastPeak.idx, isoTime: isoAt(lastPeak.idx), formatted: fmtDate(isoAt(lastPeak.idx)) },
                      { role: 'prev_valley', price: prevValley.price, idx: prevValley.idx, isoTime: isoAt(prevValley.idx), formatted: fmtDate(isoAt(prevValley.idx)) },
                      { role: 'last_valley', price: lastValley.price, idx: lastValley.idx, isoTime: isoAt(lastValley.idx), formatted: fmtDate(isoAt(lastValley.idx)) },
                    ],
                    formingPivots: [
                      { role: 'inside_consolidation', price: currentPrice, idx: lastIdx, progress: Number(qConv.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                    ],
                    scenarios: {
                      completion: { priceRange: [Math.round((lastValley.price + lastPeak.price) / 2)], description: '収束継続しブレイク接近' },
                      invalidation: { priceLevel: Math.round(prevValley.price * 0.99), description: `${Math.round(prevValley.price * 0.99).toLocaleString()}円割れで失効の可能性` },
                    },
                    nextSteps: [
                      '上下いずれかのブレイク方向と出来高を監視（方向性の確定待ち）',
                    ],
                  });
                }
              }
            }
          }
        }
      }
    }

    // forming pennant: strong pole then short symmetrical convergence
    if (want.has('pennant') || want.has('flag')) {
      const closes = candles.map(c => c.close);
      const highsArr = candles.map(c => c.high);
      const lowsArr = candles.map(c => c.low);
      const W = Math.min(20, candles.length);
      const idxEnd = candles.length - 1;
      const M = Math.min(12, Math.max(6, Math.floor(W * 0.6)));
      const idxStart = Math.max(0, idxEnd - M);
      const poleChange = (closes[idxEnd] - closes[idxStart]) / Math.max(1e-12, closes[idxStart]);
      const poleUp = poleChange >= 0.08;
      const poleDown = poleChange <= -0.08;
      const havePole = poleUp || poleDown;
      // consolidation window after pole start
      const C = Math.min(14, W);
      const winStart = Math.max(0, candles.length - C);
      const hwin = highsArr.slice(winStart);
      const lwin = lowsArr.slice(winStart);
      const firstH = hwin[0];
      const lastH = hwin[hwin.length - 1];
      const firstL = lwin[0];
      const lastL = lwin[lwin.length - 1];
      const dH = (lastH - firstH) / Math.max(1e-12, firstH);
      const dL = (lastL - firstL) / Math.max(1e-12, firstL);
      const spreadStart = firstH - firstL;
      const spreadEnd = lastH - lastL;
      const converging = spreadEnd < spreadStart * (1 - Math.max(0.01, rightPeakTolerancePct * 0.5));
      if (havePole) {
        const start = isoAt(winStart);
        const cur = isoAt(lastIdx);
        const formationBars = Math.max(0, idxEnd - winStart);
        const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start, current: cur };
        const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
        // Pennant (symmetrical convergence)
        if (want.has('pennant')) {
          if (((dH <= 0 && dL >= 0) || (dH < 0 && dL > 0)) && converging) {
            if (patternDays >= getMinPatternDays('pennant')) {
              const qPole = Math.max(0, Math.min(1, (Math.abs(poleChange) - 0.08) / 0.12));
              const qConv = Math.max(0, Math.min(1, (spreadStart - spreadEnd) / Math.max(1e-12, spreadStart * 0.8)));
              const completion = Math.min(1, 0.6 + 0.4 * qConv);
              if (completion >= minCompletion) {
                const scale_validation = buildScaleValidation(formationBars);
                const confidence = Math.round(Math.min(1, Math.max(0, (qPole + qConv) / 2)) * 100) / 100;
                patterns.push({
                  type: 'pennant',
                  completion: Number(completion.toFixed(2)),
                  confidence,
                  status: 'forming',
                  range: { start, current: cur },
                  candleType: type,
                  formationPeriod: formation,
                  scale_validation,
                  confirmedPivots: [],
                  formingPivots: [
                    { role: 'consolidation', price: priceAt(lastIdx), idx: lastIdx, progress: Number(qConv.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                  ],
                  scenarios: {
                    completion: { priceRange: [], description: `${poleUp ? '上' : '下'}方向の旗竿方向ブレイクで完成` },
                    invalidation: { priceLevel: null as any, description: '対称収束が崩れ、逆方向へチャネル化した場合は別パターン' },
                  },
                  nextSteps: [
                    '旗竿方向のブレイクと出来高増加を監視',
                  ],
                });
              }
            }
          }
        }
        // Flag (parallel channel against pole direction)
        if (want.has('flag')) {
          const slopeAgainstUp = poleUp && dH < 0 && dL < 0;
          const slopeAgainstDown = poleDown && dH > 0 && dL > 0;
          const smallRange = spreadEnd <= spreadStart * 1.02;
          if ((slopeAgainstUp || slopeAgainstDown) && smallRange) {
            if (patternDays >= getMinPatternDays('flag')) {
              const qPole = Math.max(0, Math.min(1, (Math.abs(poleChange) - 0.08) / 0.12));
              const qRange = Math.max(0, Math.min(1, 1 - (spreadEnd - spreadStart) / Math.max(1e-12, spreadStart * 0.2)));
              const completion = Math.min(1, 0.6 + 0.4 * qRange);
              if (completion >= minCompletion) {
                const scale_validation = buildScaleValidation(formationBars);
                const confidence = Math.round(Math.min(1, Math.max(0, (qPole + qRange) / 2)) * 100) / 100;
                patterns.push({
                  type: 'flag',
                  completion: Number(completion.toFixed(2)),
                  confidence,
                  status: 'forming',
                  range: { start, current: cur },
                  candleType: type,
                  formationPeriod: formation,
                  scale_validation,
                  confirmedPivots: [],
                  formingPivots: [
                    { role: 'channel', price: priceAt(lastIdx), idx: lastIdx, progress: Number(qRange.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
                  ],
                  scenarios: {
                    completion: { priceRange: [], description: `${poleUp ? '上' : '下'}方向の旗竿方向ブレイクで完成` },
                    invalidation: { priceLevel: null as any, description: '平行チャネルが崩れる/レンジ拡大で別パターン' },
                  },
                  nextSteps: [
                    '旗竿方向のブレイクと出来高増加を監視',
                  ],
                });
              }
            }
          }
        }
      }
    }

    // forming inverse_head_and_shoulders: left_shoulder (valley) -> head (lower valley) -> post_head_peak (peak) -> right_shoulder（谷）
    if (want.has('inverse_head_and_shoulders')) {
      // scan from most recent to prioritize現在進行形
      for (let i = valleys.length - 2; i >= 0; i--) {
        const left = valleys[i];
        if (!isPivotConfirmed(left.idx, lastIdx)) continue;
        // head: deeper valley after left
        const head = valleys.slice(i + 1).find(v => isPivotConfirmed(v.idx, lastIdx) && v.price < left.price * (1 - 0.05));
        if (!head) continue;
        // peak after head: choose the highest confirmed peak after head（近い小ピークに限定せず高値を優先）
        const afterHeadPeaks = peaks.filter(p => p.idx > head.idx && isPivotConfirmed(p.idx, lastIdx));
        const postPeak = afterHeadPeaks.length ? afterHeadPeaks.reduce((best, p) => (p.price > best.price ? p : best), afterHeadPeaks[0]) : null;
        if (!postPeak) continue;
        // 追加フィルタ0: 左肩→頭の間に「下落トレンド」があるか（逆三尊の前提）
        if ((head.idx - left.idx) >= 5) {
          const startClose = priceAt(left.idx);
          const endClose = priceAt(head.idx);
          const dropPct = (endClose - startClose) / Math.max(1e-12, startClose); // 負なら下落
          // 下降本数の割合
          let decCount = 0, obsCount = 0;
          for (let j = left.idx + 1; j <= head.idx; j++) {
            const c0 = priceAt(j - 1), c1 = priceAt(j);
            if (Number.isFinite(c0) && Number.isFinite(c1)) {
              obsCount++;
              if (c1 < c0) decCount++;
            }
          }
          const frac = obsCount > 0 ? decCount / obsCount : 0;
          // 下落率が小さい（>= -minDowntrendPct ではない）または下降割合が低い場合 → 除外
          if (!(dropPct <= -minDowntrendPct && frac >= minDowntrendFrac)) {
            continue;
          }
        }
        // 追加フィルタ1: ネックラインの強い下向きは逆三尊候補から除外（下降トレンドライン同然）
        const preHeadPeaks = peaks.filter(p => p.idx > left.idx && p.idx < head.idx && isPivotConfirmed(p.idx, lastIdx));
        const prePeak = preHeadPeaks.length ? preHeadPeaks.reduce((best, p) => (p.price > best.price ? p : best), preHeadPeaks[0]) : null;
        if (prePeak) {
          const barsBetween = Math.max(1, postPeak.idx - prePeak.idx);
          const relDelta = (postPeak.price - prePeak.price) / Math.max(1e-12, prePeak.price);
          const perBar = relDelta / barsBetween; // 1本あたりの相対傾斜（負が下向き）
          if (perBar < necklineSlopePerBarMin) {
            // 強い下向きネックライン → 除外
            continue;
          }
        }
        // 追加フィルタ2: 現在価格が頭の安値を明確に割り込んでいる場合は除外（候補死亡）
        const currentPxNow = priceAt(lastIdx);
        if (currentPxNow < head.price * (1 - headInvalidBelowPct)) {
          continue;
        }
        // 右肩は「確定済みの谷」を優先採用（保守的）
        const rightCandidates = valleys
          .filter(v =>
            v.idx > postPeak.idx &&
            isPivotConfirmed(v.idx, lastIdx) &&
            v.price > head.price && // 右肩は頭（最安）より上
            (Math.abs(v.price - left.price) / Math.max(1, left.price)) <= rightPeakTolerancePct
          )
          .sort((a, b) => b.idx - a.idx); // 直近優先

        let right: { idx: number; price: number } | null = rightCandidates[0] || null;
        let rightProvisional = false;

        if (!right && allowProvisionalRightShoulder) {
          // 暫定許容: 直近が下落基調なら「右肩形成初期」として現在値を仮置き（完成度を低く制限）
          const isDescending = last3Down();
          if (isDescending) {
            const curIdx = lastIdx;
            const curPx = priceAt(curIdx);
            // 暫定でも基本条件を軽く満たす（頭よりは上、左肩近傍）
            const nearLeft = (Math.abs(curPx - left.price) / Math.max(1, left.price)) <= rightPeakTolerancePct;
            if (curPx > head.price && nearLeft) {
              right = { idx: curIdx, price: curPx };
              rightProvisional = true;
            }
          }
        }

        if (!right) continue; // 右肩が見つからない場合はスキップ

        // 完成度を段階設定
        const closeness = Math.max(0, Math.min(1,
          1 - Math.abs(right.price - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct)
        ));
        const barsFromRight = Math.max(0, lastIdx - right.idx);
        let completion = 0;
        if (rightProvisional) {
          completion = Math.min(0.6, 0.4 + 0.2 * closeness); // 形成初期: 最大60%
        } else {
          if (barsFromRight <= 2) {
            completion = Math.min(1.0, 0.85 + 0.15 * closeness); // 確定直後: 85-100%
          } else {
            completion = Math.min(0.8, 0.65 + 0.15 * closeness); // 確定後に時間経過: 65-80%
          }
        }
        if (completion < minCompletion) continue;

        // pre-head peak は上で取得済み（prePeak）。ここでは再利用する。
        let nlA = prePeak ? { x: prePeak.idx, y: prePeak.price } : { x: left.idx, y: postPeak.price };
        let nlB = { x: postPeak.idx, y: postPeak.price };
        // 過度な傾斜を水平化
        try {
          const dy = Math.abs(Number(nlA.y) - Number(nlB.y));
          const denom = Math.max(1e-12, Math.max(Number(nlA.y), Number(nlB.y)));
          const slopePct = dy / denom;
          if (slopePct > necklineSlopeTolerancePct) {
            const avg = Math.round(((Number(nlA.y) + Number(nlB.y)) / 2));
            nlA = { ...nlA, y: avg };
            nlB = { ...nlB, y: avg };
          }
        } catch { /* noop */ }
        const start = isoAt(left.idx);
        const cur = isoAt(lastIdx);
        const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * (rightProvisional ? 0.5 : 1)));
        let confidence = Math.round(confBase * 100) / 100;
        // formation period: end at right shoulder confirmation if confirmed
        const formationEndIdx = rightProvisional ? lastIdx : right.idx;
        // 形成区間は「左肩（谷）↔ 右肩（谷, 暫定なら現在）」で表す
        const shoulderStartIdx = left.idx;
        const shoulderEndIdx = rightProvisional ? lastIdx : right.idx;
        const formationBars = Math.max(0, shoulderEndIdx - shoulderStartIdx);
        const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: isoAt(shoulderStartIdx), end: isoAt(shoulderEndIdx), status: rightProvisional ? 'forming' : 'completed_pending_breakout' };
        const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
        if (patternDays < getMinPatternDays('inverse_head_and_shoulders')) {
          // too short → skip
        } else if (patternDays > Math.round(Number(maxPatternDays))) {
          // too long for current settings → skip
        } else {
          // 逆三尊: 上抜けで完成、下回りで無効化
          const nlY = Number(postPeak.price);
          const br = detectBreakout(right.idx, nlY, true, 0.02);
          // Freshness/coverage/approach penalties
          const covRatio = Number(limit) > 0 ? (formationBars / Number(limit)) : 1;
          if (covRatio < 0.2) confidence = Math.max(0, Number((confidence * 0.75).toFixed(2)));
          else if (covRatio < 0.3) confidence = Math.max(0, Number((confidence * 0.85).toFixed(2)));
          const currentPx = priceAt(lastIdx);
          const diffPctToNeckline = ((currentPx - nlY) / Math.max(1e-12, nlY)) * 100; // negative = 下にいる
          let completionAdj = completion;
          if (diffPctToNeckline < -10) completionAdj = Number((completionAdj * 0.7).toFixed(2));
          else if (diffPctToNeckline < -5) completionAdj = Number((completionAdj * 0.85).toFixed(2));
          const barsSinceRight = Math.max(0, lastIdx - right.idx);
          if (barsSinceRight > maxBarsFromLastPivot) {
            confidence = Math.min(confidence, 0.6);
            completionAdj = Math.min(completionAdj, 0.7);
          }
          const scale_validation = buildScaleValidation(formationBars);
          const formingPivots = [
            { role: rightProvisional ? 'right_shoulder_provisional' : 'right_shoulder', price: right.price, idx: right.idx, progress: Number(closeness.toFixed(2)), isoTime: rightProvisional ? cur : isoAt(right.idx), formatted: fmtDate(rightProvisional ? cur : isoAt(right.idx)) },
          ];
          const warnings: string[] = [];
          if (rightProvisional) warnings.push('右肩は未確定（現在価格ベース）');
          if (br.completed && br.barsSinceBreak <= maxBarsFromBreakout) warnings.push('ネックライン上抜け済み（直近）');
          // もし水平化が行われた場合に注意を付与（差分が一定以上なら）
          try {
            const diffPct = Math.abs((prePeak ? prePeak.price : postPeak.price) - postPeak.price) / Math.max(1e-12, Math.max((prePeak ? prePeak.price : postPeak.price), postPeak.price));
            if (diffPct > necklineSlopeTolerancePct) warnings.push('ネックライン傾斜が大きいため水平化（解釈の安全性向上）');
          } catch { /* noop */ }
          // 対称性チェック（頭前の山と頭後の山の差が大きすぎないか）
          if (prePeak) {
            const symDiff = Math.abs(prePeak.price - postPeak.price) / Math.max(1e-12, Math.max(prePeak.price, postPeak.price));
            if (symDiff > prePostSymmetryTolerancePct * 1.5) {
              // 極端に不均衡 → 採用を見送り
              continue;
            } else if (symDiff > prePostSymmetryTolerancePct) {
              warnings.push(`頭前/頭後の山の高さ差が大きい（${(symDiff * 100).toFixed(1)}%）`);
              confidence = Math.max(0, Number((confidence * 0.85).toFixed(2)));
            }
          }
          if (barsSinceRight > maxBarsFromLastPivot) warnings.push(`右肩確定から${barsSinceRight}本経過（鮮度低下）`);
          if (diffPctToNeckline < -5) warnings.push(`ネックラインまでの乖離 ${diffPctToNeckline.toFixed(1)}%`);
          if (covRatio < 0.3) warnings.push(`低カバレッジ（${(covRatio * 100).toFixed(1)}%）— limit調整推奨`);
          const pivotStatus = {
            left: 'confirmed',
            head: 'confirmed',
            postPeak: 'confirmed',
            right: rightProvisional ? 'provisional' : 'confirmed',
          };
          // ステータス決定
          let finalStatus: 'forming' | 'completed_active' | 'invalidated' | 'expired' = 'forming';
          if (br.invalidated) {
            finalStatus = 'invalidated';
          } else if (br.completed) {
            finalStatus = br.barsSinceBreak <= maxBarsFromBreakout ? 'completed_active' : 'expired';
          }
          if (finalStatus !== 'expired' && finalStatus !== 'invalidated') {
            patterns.push({
              type: 'inverse_head_and_shoulders',
              completion: Number(completionAdj.toFixed(2)),
              confidence,
              status: finalStatus,
              range: { start: isoAt(shoulderStartIdx), current: isoAt(shoulderEndIdx) },
              rangeAnchors: {
                startRole: 'left_shoulder',
                endRole: 'right_shoulder',
                startIdx: shoulderStartIdx,
                endIdx: shoulderEndIdx,
                startIso: isoAt(shoulderStartIdx),
                endIso: isoAt(shoulderEndIdx),
              },
              necklineAnchors: {
              },
              candleType: type,
              formationPeriod: formation,
              scale_validation,
              breakout: { completed: br.completed, invalidated: br.invalidated, direction: br.completed ? 'up' : null, barsAgo: br.barsSinceBreak, effectiveness: (!br.invalidated && br.completed) ? 'active' : null },
              confirmedPivots: [
                { role: 'left_shoulder', price: left.price, idx: left.idx, isoTime: start, formatted: fmtDate(start) },
                { role: 'head', price: head.price, idx: head.idx, isoTime: isoAt(head.idx), formatted: fmtDate(isoAt(head.idx)) },
                ...(prePeak ? [{ role: 'pre_head_peak', price: prePeak.price, idx: prePeak.idx, isoTime: isoAt(prePeak.idx), formatted: fmtDate(isoAt(prePeak.idx)) }] : []),
                { role: 'post_head_peak', price: postPeak.price, idx: postPeak.idx, isoTime: isoAt(postPeak.idx), formatted: fmtDate(isoAt(postPeak.idx)) },
              ],
              formingPivots,
              neckline: [nlA, nlB],
              scenarios: {
                completion: { priceRange: [Math.round(left.price * 0.98), Math.round(left.price * 1.02)], description: 'この価格帯で反転上昇すればパターン完成' },
                invalidation: { priceLevel: Math.round(head.price * 0.988), description: `${Math.round(head.price * 0.988).toLocaleString()}円を下抜けたらパターン無効` },
              },
              warnings,
              pivotStatus,
              nextSteps: [
                `${Math.round(left.price * 0.995).toLocaleString()}-${Math.round(left.price * 1.005).toLocaleString()}円での反転シグナルを監視`,
                `完成後はネックライン${Math.round(postPeak.price).toLocaleString()}円の上抜けを監視`,
              ],
            });
            break;
          }
        }
      }
    }
  }

  // filter by completion and scale appropriateness（巨大すぎるパターンは形成中リストから除外）
  // === Deduplication of overlapping patterns of the same type ===
  function getIdxRange(p: any): { startIdx: number; endIdx: number } {
    try {
      const startIdx = Number(p?.confirmedPivots?.[0]?.idx ?? 0);
      const endIdx = Number(p?.formingPivots?.[0]?.idx ?? lastIdx);
      return {
        startIdx: Number.isFinite(startIdx) ? startIdx : 0,
        endIdx: Number.isFinite(endIdx) ? endIdx : lastIdx,
      };
    } catch {
      return { startIdx: 0, endIdx: lastIdx };
    }
  }
  function calcOverlapRatio(a: any, b: any): number {
    const ar = getIdxRange(a);
    const br = getIdxRange(b);
    const start = Math.max(ar.startIdx, br.startIdx);
    const end = Math.min(ar.endIdx, br.endIdx);
    const overlap = Math.max(0, end - start);
    const aSpan = Math.max(1, ar.endIdx - ar.startIdx);
    const bSpan = Math.max(1, br.endIdx - br.startIdx);
    const base = Math.min(aSpan, bSpan);
    return overlap / base;
  }
  function selectBestPattern(cluster: any[]): any {
    return [...cluster].sort((a, b) => {
      const aEnd = getIdxRange(a).endIdx;
      const bEnd = getIdxRange(b).endIdx;
      if (bEnd !== aEnd) return bEnd - aEnd; // latest end first
      const aComp = Number(a?.completion ?? 0);
      const bComp = Number(b?.completion ?? 0);
      if (bComp !== aComp) return bComp - aComp;
      const aQ = Number(a?.confidence ?? 0);
      const bQ = Number(b?.confidence ?? 0);
      return bQ - aQ;
    })[0];
  }
  function deduplicateByTypeAndOverlap(input: any[], threshold: number = 0.5): any[] {
    const groups = input.reduce((m: Record<string, any[]>, p: any) => {
      const t = String(p?.type || 'unknown');
      (m[t] ||= []).push(p);
      return m;
    }, {});
    const result: any[] = [];
    for (const [t, arr] of Object.entries(groups)) {
      const sorted = [...arr].sort((a, b) => getIdxRange(a).startIdx - getIdxRange(b).startIdx);
      const clusters: any[][] = [];
      for (const p of sorted) {
        let joined = false;
        for (const cl of clusters) {
          // overlap with any member in cluster
          if (cl.some(x => calcOverlapRatio(x, p) >= threshold)) {
            cl.push(p);
            joined = true;
            break;
          }
        }
        if (!joined) clusters.push([p]);
      }
      for (const cl of clusters) {
        result.push(selectBestPattern(cl));
      }
    }
    return result;
  }
  const deduped = deduplicateByTypeAndOverlap(patterns, 0.5);
  const filtered = deduped.filter(p => {
    if (!(p?.completion >= minCompletion)) return false;
    const status = p?.scale_validation?.status;
    if (status && status === 'too_large') return false;
    return true;
  });
  const summary = `${String(pair).toUpperCase()} [${String(type)}] ${limit}本から${filtered.length}件の形成中パターンを検出`;
  const byType: Record<string, number> = filtered.reduce((m: any, p: any) => { m[p.type] = (m[p.type] || 0) + 1; return m; }, {});
  const typeSummary = Object.entries(byType).map(([k, v]) => `${k}×${v}${v > 0 ? '' : ''}`).join(', ');

  // === Enrichment: historicalCases for each forming pattern (past N days) ===
  // Decide history window (in days) based on limit and timeframe to avoid too few samples
  const daysPerBar = (tf: string): number => {
    const map: Record<string, number> = {
      '1min': 1 / (24 * 60),
      '5min': 5 / (24 * 60),
      '15min': 15 / (24 * 60),
      '30min': 30 / (24 * 60),
      '1hour': 1 / 24,
      '4hour': 4 / 24,
      '8hour': 8 / 24,
      '12hour': 12 / 24,
      '1day': 1,
      '1week': 7,
      '1month': 30,
    };
    return map[tf] ?? 1;
  };
  const historyDays = Math.max(30, Math.round(Number(limit) * daysPerBar(String(type))));
  async function enrichWithHistory(fp: any): Promise<any> {
    try {
      const wantType = String(fp?.type);
      const histLimit = Math.max(120, limit * 3);
      const det: any = await detectPatterns(pair, type as any, histLimit, { patterns: [wantType as any] });
      if (!det?.ok) return fp;
      const now = Date.now();
      const withinDays = (iso?: string, days: number = historyDays) => {
        if (!iso) return false;
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return false;
        return (now - t) <= days * 86400000;
      };
      const pats: any[] = Array.isArray(det?.data?.patterns) ? det.data.patterns : [];
      const sameRecent = pats.filter(p => String(p?.type) === wantType && withinDays(p?.range?.end, historyDays));
      const count = sameRecent.length;
      if (!count) {
        fp.historicalCases = { count: 0, avgBreakoutMove: 0, successRate: 0, examples: [] };
        return fp;
      }
      const success = sameRecent.filter(p => p?.aftermath?.breakoutConfirmed === true).length;
      const moves7 = sameRecent
        .map(p => Number(p?.aftermath?.priceMove?.days7?.return))
        .filter((v: any) => Number.isFinite(v)) as number[];
      const avgBreakoutMove = moves7.length ? Number((moves7.reduce((s, v) => s + v, 0) / moves7.length).toFixed(2)) : 0;
      const pickExamples = [...sameRecent].slice(0, 10) // cap for safety
        .map(p => {
          const r3 = p?.aftermath?.priceMove?.days3?.return;
          const r7 = p?.aftermath?.priceMove?.days7?.return;
          const r14 = p?.aftermath?.priceMove?.days14?.return;
          const candidates = [r3, r7, r14].filter((v: any) => typeof v === 'number') as number[];
          const chosen = candidates.length ? candidates.reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, 0) : null;
          const nlA = p?.neckline?.[0]?.y;
          const nlB = p?.neckline?.[1]?.y;
          const neckline = Number.isFinite(nlB) ? nlB : (Number.isFinite(nlA) ? nlA : null);
          return {
            completedDate: String(p?.range?.end || ''),
            necklineBreak: neckline != null ? Math.round(Number(neckline)) : null,
            maxMoveAfter: chosen != null ? Number(chosen.toFixed(2)) : null,
            daysToTarget: (p?.aftermath?.daysToTarget ?? null),
          };
        })
        .sort((a, b) => {
          const av = typeof a.maxMoveAfter === 'number' ? Math.abs(a.maxMoveAfter) : -Infinity;
          const bv = typeof b.maxMoveAfter === 'number' ? Math.abs(b.maxMoveAfter) : -Infinity;
          return bv - av;
        })
        .slice(0, 3);
      fp.historicalCases = {
        count,
        avgBreakoutMove,
        successRate: Number((success / count).toFixed(2)),
        examples: pickExamples,
      };
      return fp;
    } catch {
      return fp;
    }
  }
  const enriched = await Promise.all(filtered.map(enrichWithHistory));
  // Impact score: freshness (bars since last pivot), completion, pattern importance
  const patternWeight = (t: string): number => {
    if (t === 'head_and_shoulders' || t === 'inverse_head_and_shoulders') return 1.0;
    if (t === 'double_top' || t === 'double_bottom') return 0.85;
    if (t.startsWith('triple_')) return 0.80;
    return 0.70;
  };
  const impactScore = (p: any): number => {
    const formingIdx = Number(p?.formingPivots?.[0]?.idx ?? p?.confirmedPivots?.[p?.confirmedPivots?.length - 1]?.idx ?? lastIdx);
    const barsSince = Math.max(0, lastIdx - formingIdx);
    const freshness = 1 - Math.min(1, barsSince / Math.max(1, maxBarsFromLastPivot));
    const comp = Math.max(0, Math.min(1, Number(p?.completion ?? 0)));
    const w = patternWeight(String(p?.type || ''));
    // scale factor (favor larger structural patterns), plus slight penalty if scale not appropriate
    const durationDays = (() => {
      const startIdx = Number(p?.confirmedPivots?.[0]?.idx ?? lastIdx);
      const endIdx = Number(p?.formingPivots?.[0]?.idx ?? lastIdx);
      const bars = Math.max(0, endIdx - startIdx);
      return Math.round(bars * daysPerBarCalc(String(type)));
    })();
    const scaleBoost = durationDays >= 60 ? 1.5 : durationDays >= 30 ? 1.2 : 1.0;
    const scale = String(p?.scale_validation?.status || 'appropriate');
    const scalePenalty = scale === 'appropriate' ? 1 : (scale === 'too_large' ? 0.92 : 0.95);
    return (0.35 * freshness + 0.35 * comp + 0.10 * w + 0.20 * scaleBoost) * scalePenalty;
  };
  const sortedEnriched = [...enriched].sort((a, b) => impactScore(b) - impactScore(a));

  // === Context categorization (short-term freshness vs structural impact) ===
  const currentPriceCtx = Number(candles[lastIdx]?.close);
  function getBarsSinceLastPivot(p: any): number {
    const formingIdx = Number(p?.formingPivots?.[0]?.idx ?? p?.confirmedPivots?.[p?.confirmedPivots?.length - 1]?.idx ?? lastIdx);
    return Math.max(0, lastIdx - formingIdx);
  }
  function getDurationDays(p: any): number {
    const startIdx = Number(p?.confirmedPivots?.[0]?.idx ?? lastIdx);
    const endIdx = Number(p?.formingPivots?.[0]?.idx ?? lastIdx);
    const bars = Math.max(0, endIdx - startIdx);
    return Math.round(bars * daysPerBarCalc(String(type)));
  }
  function getAmplitudeAbs(p: any): number {
    try {
      const nlA = p?.neckline?.[0]?.y;
      const nlB = p?.neckline?.[1]?.y;
      const nl = Number.isFinite(nlB) ? Number(nlB) : (Number.isFinite(nlA) ? Number(nlA) : null);
      const cps = Array.isArray(p?.confirmedPivots) ? p.confirmedPivots : [];
      const byRole = (role: string) => cps.find((cp: any) => String(cp?.role) === role);
      const typeStr = String(p?.type || '');
      let headLike: any = null;
      if (typeStr === 'head_and_shoulders' || typeStr === 'inverse_head_and_shoulders') {
        headLike = byRole('head') || cps[1] || cps[0] || null;
      } else if (typeStr === 'double_top') {
        headLike = byRole('left_peak') || cps[0] || null;
      } else if (typeStr === 'double_bottom') {
        headLike = byRole('peak') || cps[1] || cps[0] || null;
      } else {
        headLike = cps[1] || cps[0] || null;
      }
      const hp = Number(headLike?.price);
      if (Number.isFinite(hp) && Number.isFinite(nl)) return Math.abs(hp - (nl as number));
    } catch { /* ignore */ }
    try {
      const cps = Array.isArray(p?.confirmedPivots) ? p.confirmedPivots : [];
      if (!cps.length) return 0;
      const prices = cps.map((cp: any) => Number(cp?.price)).filter((v: any) => Number.isFinite(v));
      if (!prices.length) return 0;
      const maxv = Math.max(...prices);
      const minv = Math.min(...prices);
      return Math.abs(maxv - minv);
    } catch { return 0; }
  }
  function analyzePatternContext(p: any) {
    const barsSince = getBarsSinceLastPivot(p);
    const freshness = Math.max(0, 1 - (barsSince / Math.max(1, maxBarsFromLastPivot)));
    const amplitude = getAmplitudeAbs(p);
    const durationDays = getDurationDays(p);
    const price = Number.isFinite(currentPriceCtx) ? currentPriceCtx : Math.max(1e-12, Number(p?.formingPivots?.[0]?.price ?? p?.confirmedPivots?.[0]?.price ?? 1));
    const marketImpact = (amplitude / Math.max(1e-12, price)) * Math.max(1, durationDays);
    let category: 'short_term' | 'structural' | 'watchlist' = 'watchlist';
    let label = '要監視';
    let timeframe = '参考情報';
    let priority = 'balanced';
    // invalidation by neckline re-cross (2% buffer)
    const typeStr = String(p?.type || '');
    const nlA = p?.neckline?.[0]?.y, nlB = p?.neckline?.[1]?.y;
    const nl = Number.isFinite(nlB) ? Number(nlB) : (Number.isFinite(nlA) ? Number(nlA) : null);
    const buf = 0.02;
    let isInvalidated = false;
    if (Number.isFinite(nl)) {
      if (typeStr === 'inverse_head_and_shoulders' || typeStr === 'double_bottom' || typeStr === 'triple_bottom') {
        // bullish patterns invalid if price is well below neckline (after previous cross) – here treated as invalid snapshot
        if (currentPriceCtx < (nl as number) * (1 - buf)) isInvalidated = true;
      } else if (typeStr === 'head_and_shoulders' || typeStr === 'double_top' || typeStr === 'triple_top') {
        // bearish patterns invalid if price is well above neckline
        if (currentPriceCtx > (nl as number) * (1 + buf)) isInvalidated = true;
      }
    }
    if (freshness > 0.7 && marketImpact < 4.0) {
      category = 'short_term'; label = '短期・鮮度重視'; timeframe = '直近数日〜1週間'; priority = 'freshness';
    } else if (marketImpact >= 4.0 && freshness >= 0.05) {
      category = 'structural'; label = '中期・構造重視'; timeframe = '1週間〜1ヶ月'; priority = 'impact';
    } else if (freshness > 0.05) {
      category = 'watchlist'; label = '要監視'; timeframe = '参考情報'; priority = 'balanced';
    }
    if (isInvalidated) { category = 'watchlist'; label = '無効化済み'; timeframe = '参考情報（既にブレイク）'; priority = 'low'; }
    return { category, label, timeframe, priority, freshness: Number(freshness.toFixed(2)), marketImpact: Number(marketImpact.toFixed(2)), durationDays, amplitude, isInvalidated };
  }
  const categorized = (() => {
    const cats = { short_term: [] as any[], structural: [] as any[], watchlist: [] as any[], invalid: [] as any[] };
    for (const p of sortedEnriched) {
      const ctx = analyzePatternContext(p);
      const sc = impactScore(p);
      const barsSince = getBarsSinceLastPivot(p);
      const withCtx = { ...p, context: ctx, _impactScore: sc, _barsSince: barsSince };

      // 無効化されたパターンは invalidカテゴリに
      if (p.status === 'invalid' || p.status === 'near_invalidation') {
        (cats as any).invalid.push(withCtx);
      } else {
        (cats as any)[ctx.category].push(withCtx);
      }
    }
    for (const k of Object.keys(cats) as Array<keyof typeof cats>) {
      (cats as any)[k].sort((a: any, b: any) => b._impactScore - a._impactScore);
    }
    return cats;
  })();
  const hasDifferentCategories = (categorized.short_term.length > 0 && categorized.structural.length > 0);
  const isBullish = (t: string) => (t === 'inverse_head_and_shoulders' || t === 'double_bottom' || t === 'triple_bottom');
  const isBearish = (t: string) => (t === 'head_and_shoulders' || t === 'double_top' || t === 'triple_top');
  function periodOverlap(a: any, b: any): boolean {
    const aStart = Number(a?.confirmedPivots?.[0]?.idx ?? 0);
    const aEnd = Number(a?.formingPivots?.[0]?.idx ?? lastIdx);
    const bStart = Number(b?.confirmedPivots?.[0]?.idx ?? 0);
    const bEnd = Number(b?.formingPivots?.[0]?.idx ?? lastIdx);
    return !(aEnd < bStart || bEnd < aStart);
  }
  const relationships: Array<{ pattern1: string; pattern2: string; overlap: boolean; conflict?: 'directional' | null; note?: string }> = [];
  try {
    const all = sortedEnriched;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const pa = all[i], pb = all[j];
        const conflict = (isBullish(String(pa?.type)) && isBearish(String(pb?.type))) || (isBearish(String(pa?.type)) && isBullish(String(pb?.type)));
        const overlap = periodOverlap(pa, pb);
        if (conflict || overlap) {
          relationships.push({
            pattern1: String(pa?.type),
            pattern2: String(pb?.type),
            overlap,
            conflict: conflict ? 'directional' : null,
            note: conflict ? '短期と中期で方向性が異なる可能性' : undefined,
          });
        }
      }
    }
  } catch { /* ignore */ }

  // === Long-term (weekly/monthly) “current-involved” patterns ===
  async function detectLongTermCurrentInvolved(tf: string) {
    try {
      // leave currentRelevanceDays undefined to allow timeframe-aware default inside detect_patterns
      const out: any = await detectPatterns(pair, tf as any, 200, { requireCurrentInPattern: true });
      if (!out?.ok) return { tf, items: [] as any[] };
      const items: any[] = Array.isArray(out?.data?.patterns) ? out.data.patterns : [];
      return { tf, items };
    } catch { return { tf, items: [] as any[] }; }
  }
  const longLimit = Math.max(limit * 3, 120);
  const [ltWeek, ltMonth, recentCompleted] = await Promise.all([
    detectLongTermCurrentInvolved('1week'),
    detectLongTermCurrentInvolved('1month'),
    // recently completed on current timeframe (within 7 days)
    (async () => {
      try {
        const relDays = Math.round(maxCompletedBars * (daysPerBar(String(type)) || 1));
        const out: any = await detectPatterns(pair, type as any, longLimit, { requireCurrentInPattern: false, currentRelevanceDays: relDays });
        if (!out?.ok) return [] as any[];
        const pats: any[] = Array.isArray(out?.data?.patterns) ? out.data.patterns : [];
        // Post-filter by end date within relDays to avoid older items混入
        const now = Date.now();
        const recent = pats.filter((p: any) => {
          const t = Date.parse(p?.range?.end || p?.range?.current || '');
          return Number.isFinite(t) && (now - t) <= relDays * 86400000;
        });
        return recent;
      } catch { return [] as any[]; }
    })(),
  ]);

  // content formatting
  if (view === 'debug') {
    const last5 = candles.slice(-5).map(c => Math.round(c.close).toLocaleString());
    const windowStart = isoAt(0);
    const windowEnd = isoAt(lastIdx);
    const highestInWindow = (() => {
      let mx = -Infinity, mIdx = -1;
      for (let i = 0; i < n; i++) {
        const h = Number(candles[i]?.high);
        if (Number.isFinite(h) && h > mx) { mx = h; mIdx = i; }
      }
      return { price: Number.isFinite(mx) ? Math.round(mx) : null, idx: mIdx };
    })();
    // Build simple candidates for debug (completion >= 0.10)
    const candidates: Array<{ title: string; adopt: boolean; detail: string[]; completion: number }> = [];
    if (lastPeak && lastValley && lastValley.idx > lastPeak.idx) {
      const currentPrice = priceAt(lastIdx);
      const leftPct = currentPrice / Math.max(1, lastPeak.price);
      const ratio = (currentPrice - lastValley.price) / Math.max(1e-12, lastPeak.price - lastValley.price);
      let progress = Math.max(0, Math.min(1, ratio));
      if (last3Down()) progress = Math.min(1, progress + 0.2);
      const comp = Math.min(1, 0.66 + progress * 0.34);
      if (comp >= 0.10) {
        const title = `double_top (完成度: ${Math.round(comp * 100)}%)`;
        const adopt = comp >= minCompletion;
        const detail = [
          `  - 左肩: ${Math.round(lastPeak.price).toLocaleString()}円（idx=${lastPeak.idx}, 確定）`,
          `  - 谷: ${Math.round(lastValley.price).toLocaleString()}円（idx=${lastValley.idx}, 確定）`,
          `  - 右肩: 検出中（現在${Math.round(currentPrice).toLocaleString()}円, 左肩の${(leftPct * 100).toFixed(1)}%）`,
        ];
        candidates.push({ title, adopt, detail, completion: comp });
      }
    }
    if (lastPeak && lastValley && lastPeak.idx > lastValley.idx) {
      const currentPrice = priceAt(lastIdx);
      const leftPct = currentPrice / Math.max(1, lastValley.price);
      const ratio = (lastPeak.price - currentPrice) / Math.max(1e-12, lastPeak.price - lastValley.price);
      let progress = Math.max(0, Math.min(1, ratio));
      if (!last3Down()) progress = Math.min(1, progress + 0.2);
      const comp = Math.min(1, 0.66 + progress * 0.34);
      if (comp >= 0.10) {
        const title = `double_bottom (完成度: ${Math.round(comp * 100)}%)`;
        const adopt = comp >= minCompletion;
        const detail = [
          `  - 左谷: ${Math.round(lastValley.price).toLocaleString()}円（idx=${lastValley.idx}, 確定）`,
          `  - 山: ${Math.round(lastPeak.price).toLocaleString()}円（idx=${lastPeak.idx}, 確定）`,
          `  - 右谷: 検出中（現在${Math.round(currentPrice).toLocaleString()}円, 左谷の${(leftPct * 100).toFixed(1)}%）`,
        ];
        candidates.push({ title, adopt, detail, completion: comp });
      }
    }
    // H&S candidate debug (use same conditions as detector for adopt)
    if (peaks.length >= 2) {
      const left = [...peaks].find(p => isPivotConfirmed(p.idx, lastIdx));
      const head = [...peaks].reverse().find(p => isPivotConfirmed(p.idx, lastIdx) && left && p.idx > left.idx && p.price > left.price * 1.05);
      const postValley = valleys.find(v => head && v.idx > head.idx && isPivotConfirmed(v.idx, lastIdx));
      if (left && head && postValley) {
        const currentPrice = priceAt(lastIdx);
        const nearLeft = currentPrice / Math.max(1, left.price);
        let closeness = 1 - Math.abs(currentPrice - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct);
        closeness = Math.max(0, Math.min(1, closeness));
        let progress = closeness;
        if (last3Down()) progress = Math.min(1, progress + 0.2);
        const comp = Math.min(1, 0.75 + 0.25 * progress);
        if (comp >= 0.10) {
          const title = `head_and_shoulders (完成度: ${Math.round(comp * 100)}%)`;
          const adopt = comp >= minCompletion && nearLeft >= (1 - rightPeakTolerancePct) && nearLeft <= (1 + rightPeakTolerancePct) && (currentPrice > postValley.price && currentPrice < head.price);
          const detail = [
            `  - 左肩: ${Math.round(left.price).toLocaleString()}円（idx=${left.idx}, 確定）`,
            `  - 頭: ${Math.round(head.price).toLocaleString()}円（idx=${head.idx}, 確定）`,
            `  - 頭後の谷: ${Math.round(postValley.price).toLocaleString()}円（idx=${postValley.idx}, 確定）`,
            `  - 右肩: 検出中（現在${Math.round(currentPrice).toLocaleString()}円, 左肩の${(nearLeft * 100).toFixed(1)}%）`,
          ];
          candidates.push({ title, adopt, detail, completion: comp });
        }
      }
    }
    // Inverse H&S candidate debug
    if (valleys.length >= 2) {
      const left = [...valleys].find(v => isPivotConfirmed(v.idx, lastIdx));
      const head = [...valleys].reverse().find(v => isPivotConfirmed(v.idx, lastIdx) && left && v.idx > left.idx && v.price < left.price * (1 - 0.05));
      const postPeak = peaks.find(p => head && p.idx > head.idx && isPivotConfirmed(p.idx, lastIdx));
      if (left && head && postPeak) {
        const currentPrice = priceAt(lastIdx);
        const nearLeft = currentPrice / Math.max(1, left.price);
        let closeness = 1 - Math.abs(currentPrice - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct);
        closeness = Math.max(0, Math.min(1, closeness));
        let progress = closeness;
        if (!last3Down()) progress = Math.min(1, progress + 0.2);
        const comp = Math.min(1, 0.75 + 0.25 * progress);
        if (comp >= 0.10) {
          const title = `inverse_head_and_shoulders (完成度: ${Math.round(comp * 100)}%)`;
          const adopt = comp >= minCompletion && nearLeft >= (1 - rightPeakTolerancePct) && nearLeft <= (1 + rightPeakTolerancePct) && (currentPrice < postPeak.price && currentPrice > head.price);
          const detail = [
            `  - 左肩: ${Math.round(left.price).toLocaleString()}円（idx=${left.idx}, 確定）`,
            `  - 頭: ${Math.round(head.price).toLocaleString()}円（idx=${head.idx}, 確定）`,
            `  - 頭後の山: ${Math.round(postPeak.price).toLocaleString()}円（idx=${postPeak.idx}, 確定）`,
            `  - 右肩: 検出中（現在${Math.round(currentPrice).toLocaleString()}円, 左肩の${(nearLeft * 100).toFixed(1)}%）`,
          ];
          candidates.push({ title, adopt, detail, completion: comp });
        }
      }
    }

    // What-if: 期間内の最高値idxを「頭」として採用した場合の検証ブロック
    const whatIfBlock = (() => {
      const highestIdx = highestInWindow.idx;
      const highestPrice = Number(candles[highestIdx]?.high);
      if (!Number.isFinite(highestPrice) || highestIdx < 0) return '';
      const barsWindow = Math.max(5, Math.round(maxPatternDays / Math.max(1e-12, daysPerBarCalc(String(type)))));
      const confirmedPeaksForHead = peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
      const leftCandidates = confirmedPeaksForHead.filter(p => p.idx < highestIdx && (highestIdx - p.idx) <= barsWindow && highestPrice > p.price * 1.05);
      const left = leftCandidates.length ? leftCandidates[leftCandidates.length - 1] : null;
      let postValley = valleys.find(v => v.idx > highestIdx && isPivotConfirmed(v.idx, lastIdx));
      let provisionalValley: { idx: number; price: number } | null = null;
      let usedValley: { idx: number; price: number } | null = null;
      let provisionalPenalty = 1.0;
      if (!postValley) {
        const start = Math.min(lastIdx - 1, Math.max(highestIdx + 1, 0));
        if (start > highestIdx) {
          let minIdx = start;
          let minLow = candles[start].low;
          for (let j = start; j <= lastIdx; j++) {
            const low = candles[j].low;
            if (low < minLow) { minLow = low; minIdx = j; }
          }
          provisionalValley = { idx: minIdx, price: minLow };
          usedValley = provisionalValley;
          provisionalPenalty = 0.85;
        }
      } else {
        usedValley = postValley;
      }
      // 右肩候補の選定（確定ピーク優先、なければ暫定で最高値）
      let rightPenalty = 1.0;
      let rightShoulder: { idx: number; price: number } | null = null;
      if (left && usedValley) {
        const rightPeakCandidates = peaks.filter(p =>
          p.idx > usedValley.idx &&
          isPivotConfirmed(p.idx, lastIdx) &&
          p.price < highestPrice &&
          Math.abs(p.price - left.price) / Math.max(1, left.price) <= rightPeakTolerancePct
        );
        rightShoulder = rightPeakCandidates.length ? rightPeakCandidates[rightPeakCandidates.length - 1] : null;
        if (!rightShoulder) {
          let maxIdx = Math.min(lastIdx, usedValley.idx + 1);
          let maxHigh = candles[maxIdx]?.high ?? -Infinity;
          for (let j = usedValley.idx + 1; j <= lastIdx; j++) {
            const hi = candles[j].high;
            if (hi > maxHigh) { maxHigh = hi; maxIdx = j; }
          }
          if (Number.isFinite(maxHigh)) {
            const near = Math.abs(maxHigh - left.price) / Math.max(1, left.price) <= rightPeakTolerancePct;
            if (near && maxHigh < highestPrice) {
              rightShoulder = { idx: maxIdx, price: maxHigh };
              rightPenalty = 0.9;
            }
          }
        }
      }
      const currentPrice = priceAt(lastIdx);
      let reason = '' as string;
      let compPct = 0;
      let adopt = false;
      let rightNearPct: number | null = null;
      if (!left) {
        reason = 'left_shoulder_not_found';
      } else if (!usedValley) {
        reason = 'post_head_valley_not_found';
      } else if (!rightShoulder) {
        reason = 'right_shoulder_not_found';
      } else {
        const rsPrice = rightShoulder.price;
        const nearLeft = rsPrice / Math.max(1, left.price);
        rightNearPct = nearLeft * 100;
        const between = rsPrice > usedValley.price && rsPrice < highestPrice;
        let closeness = 1 - Math.abs(rsPrice - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct);
        closeness = Math.max(0, Math.min(1, closeness));
        let progress = closeness;
        if (last3Down()) progress = Math.min(1, progress + 0.2);
        const completion = Math.min(1, 0.75 + 0.25 * progress) * provisionalPenalty * rightPenalty;
        compPct = Math.round(completion * 100);
        const formationBars = left ? Math.max(0, lastIdx - left.idx) : 0;
        const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
        const minDaysOk = patternDays >= getMinPatternDays('head_and_shoulders');
        const nearOk = nearLeft >= (1 - rightPeakTolerancePct) && nearLeft <= (1 + rightPeakTolerancePct);
        if (!minDaysOk) reason = 'pattern_too_short';
        else if (!nearOk) reason = 'right_shoulder_not_near_left';
        else if (!between) reason = 'price_not_between_head_and_valley';
        else if (completion < minCompletion) reason = 'minCompletion_not_met';
        else { adopt = true; reason = 'adopted'; }
      }
      const lines: string[] = [];
      lines.push('【idx=224を頭とした場合】');
      lines.push(`- 左肩: ${left ? `idx=${left.idx} price=${Math.round(left.price).toLocaleString()}` : 'n/a'}`);
      lines.push(`- 頭: idx=${highestIdx} price=${Math.round(highestPrice).toLocaleString()}`);
      lines.push(`- 頭後の谷: ${usedValley ? `idx=${usedValley.idx} price=${Math.round(usedValley.price).toLocaleString()}${provisionalValley ? '（暫定）' : ''}` : 'n/a'}`);
      lines.push(`- 右肩候補: ${rightShoulder ? `idx=${rightShoulder.idx} price=${Math.round(rightShoulder.price).toLocaleString()}` : 'n/a'}${rightNearPct != null ? `（左肩の${rightNearPct.toFixed(1)}%）` : ''}`);
      lines.push(`- 完成度: ${compPct}%`);
      lines.push(`- 却下理由: ${adopt ? '採用条件を満たす' : (reason || 'unknown')}`);
      lines.push('');
      return lines.join('\n');
    })();

    // debugではスケール理由で除外せず、minCompletionだけで可視化（影響度順に並べる）
    const visible = patterns.filter(p => p?.completion >= minCompletion);
    const impactScoreDebug = (p: any): number => {
      const formingIdx = Number(p?.formingPivots?.[0]?.idx ?? p?.confirmedPivots?.[p?.confirmedPivots?.length - 1]?.idx ?? lastIdx);
      const barsSince = Math.max(0, lastIdx - formingIdx);
      const freshness = 1 - Math.min(1, barsSince / Math.max(1, maxBarsFromLastPivot));
      const comp = Math.max(0, Math.min(1, Number(p?.completion ?? 0)));
      const w = patternWeight(String(p?.type || ''));
      return 0.5 * freshness + 0.4 * comp + 0.1 * w;
    };
    const visibleSorted = [...visible].sort((a, b) => impactScoreDebug(b) - impactScoreDebug(a));
    const detectedBrief = visibleSorted.length
      ? visibleSorted.map((p: any, i: number) => {
        const left = p?.confirmedPivots?.[0];
        const mid = p?.confirmedPivots?.[1];
        const after = p?.confirmedPivots?.[2];
        const right = p?.formingPivots?.[0];
        const scaleStatus = p?.scale_validation?.status || 'unknown';
        const comp = Math.round((p?.completion || 0) * 100);
        const formingIdx = Number(right?.idx ?? after?.idx ?? left?.idx ?? lastIdx);
        const barsSince = Math.max(0, lastIdx - formingIdx);
        const daysSince = Math.round(barsSince * (daysPerBar(String(type)) || 1));
        return `${i + 1}. ${p.type}（完成度${comp}% / scale=${scaleStatus} / lastPivot=${barsSince}本（約${daysSince}日））\n` +
          `   - 左: ${left ? `idx=${left.idx} ${Math.round(left.price).toLocaleString()}円` : 'n/a'}\n` +
          `   - 中: ${mid ? `idx=${mid.idx} ${Math.round(mid.price).toLocaleString()}円` : 'n/a'}\n` +
          `   - 三: ${after ? `idx=${after.idx} ${Math.round(after.price).toLocaleString()}円` : 'n/a'}\n` +
          `   - 右: ${right ? `idx=${right.idx} ${Math.round(right.price).toLocaleString()}円` : 'n/a'}`;
      }).join('\n\n')
      : '該当なし';
    // Build debug context categorization for visible patterns
    const dbgCats = { short_term: [] as any[], structural: [] as any[], watchlist: [] as any[] };
    const dbgContextItems: string[] = [];
    for (const p of visibleSorted) {
      const ctx = analyzePatternContext(p);
      (dbgCats as any)[ctx.category].push({ type: p.type, completion: p.completion, context: ctx });
      dbgContextItems.push(
        `- ${p.type}: category=${ctx.category} freshness=${ctx.freshness} impact=${ctx.marketImpact} days=${ctx.durationDays} amplitude=${Math.round(ctx.amplitude || 0).toLocaleString()}`
      );
    }
    const dbgHasMulti = (dbgCats.short_term.length > 0 && dbgCats.structural.length > 0);
    const contextBlock = [
      '【Context（カテゴリ判定・デバッグ）】',
      `- hasMultipleTimeframes: ${dbgHasMulti}`,
      `- short_term: ${dbgCats.short_term.length}件`,
      `- structural: ${dbgCats.structural.length}件`,
      `- watchlist: ${dbgCats.watchlist.length}件`,
      ...(dbgContextItems.length ? ['- items:', ...dbgContextItems] : []),
    ].join('\n');
    const text = [
      `${String(pair).toUpperCase()} [${String(type)}] ${limit}本の分析`,
      '',
      `【ウィンドウ】start=${windowStart || 'n/a'} end=${windowEnd || 'n/a'} bars=${n}`,
      `【最高値（期間内）】idx=${highestInWindow.idx} price=${highestInWindow.price?.toLocaleString?.() || 'n/a'}`,
      (() => {
        // Wedge スキャン診断（want の中身と判定結果を可視化）
        try {
          const wantArr = Array.from(want as any) as any[];
          const fw = (want as any).has ? (want as any).has('falling_wedge') : (Array.isArray(wantArr) && wantArr.includes('falling_wedge'));
          const rw = (want as any).has ? (want as any).has('rising_wedge') : (Array.isArray(wantArr) && wantArr.includes('rising_wedge'));
          return [
            '【Wedge スキャン診断】',
            `- want長さ: ${Array.isArray(wantArr) ? wantArr.length : 'n/a'}`,
            `- 要素: ${Array.isArray(wantArr) ? wantArr.join(', ') : 'n/a'}`,
            `- falling_wedge判定: ${fw ? 'Yes' : 'No'}`,
            `- rising_wedge判定: ${rw ? 'Yes' : 'No'}`,
            ''
          ].join('\n');
        } catch {
          return '';
        }
      })(),
      (() => {
        const wdbg = (globalThis as any).__formingWedgeDebug as Array<any> | undefined;
        const meta: any = (globalThis as any).__formingWedgeDebugMeta;
        const arr = Array.isArray(wdbg) ? wdbg : [];
        const accepted = arr.filter(x => x?.accepted);
        const rejected = arr.filter(x => !x?.accepted);
        const tally: Record<string, number> = {};
        for (const r of rejected) {
          const key = String(r?.reason || 'unknown');
          tally[key] = (tally[key] || 0) + 1;
        }
        const reasonKeys = ['stale_last_pivot', 'insufficient_swings', 'slope_ratio_out_of_range', 'not_converging_enough', 'insufficient_touches', 'score_below_threshold', 'gap_non_positive', 'not_same_direction', 'unknown'];
        const lines: string[] = [];
        lines.push(''); // spacer
        lines.push('【Wedge candidates (forming)】');
        lines.push(`- スキャン実行: ${meta?.scanned ? 'Yes' : 'No'}`);
        lines.push(`- ウィンドウ数: ${Number.isFinite(Number(meta?.windows)) ? meta?.windows : 'n/a'}個`);
        lines.push(`- 候補総数: ${arr.length}件`);
        lines.push(`- 却下理由の内訳:`);
        for (const k of reasonKeys) lines.push(`  * ${k}: ${tally[k] || 0}件`);
        // 追加診断: 直近30本の範囲と極値・最後の確定ピーク/谷
        try {
          const curIdx = Number(meta?.currentIdx);
          const rr = Array.isArray((meta as any)?.recentRange) ? (meta as any).recentRange : null;
          const rwc = Number((meta as any)?.recentWindowCount);
          const samples = Array.isArray((meta as any)?.latestWindowSamples) ? (meta as any).latestWindowSamples : [];
          const hiIdx = Number((meta as any)?.recentHiIdx);
          const hiPx = Number((meta as any)?.recentHiPrice);
          const loIdx = Number((meta as any)?.recentLoIdx);
          const loPx = Number((meta as any)?.recentLoPrice);
          const lcp = Number((meta as any)?.lastConfirmedPeakIdx);
          const lcpAgo = Number((meta as any)?.lastConfirmedPeakAgo);
          const lcv = Number((meta as any)?.lastConfirmedValleyIdx);
          const lcvAgo = Number((meta as any)?.lastConfirmedValleyAgo);
          lines.push('');
          lines.push('【直近30本の診断】');
          lines.push(`- 現在のバーインデックス: ${Number.isFinite(curIdx) ? curIdx : 'n/a'}`);
          lines.push(`- 範囲: ${Array.isArray(rr) ? `[${rr[0]}, ${rr[1]}]` : 'n/a'}`);
          lines.push(`- 直近ウィンドウ数(<=120本以内の終端): ${Number.isFinite(rwc) ? rwc : 'n/a'}`);
          if (samples.length) {
            const sampleStr = samples.map((w: any) => `[${w?.startIdx},${w?.endIdx}]`).join(', ');
            lines.push(`- 最新ウィンドウ例(5件): ${sampleStr}`);
          }
          lines.push(`- 最高値idx: ${Number.isFinite(hiIdx) ? hiIdx : 'n/a'} (price: ${Number.isFinite(hiPx) ? hiPx.toLocaleString() : 'n/a'})`);
          lines.push(`- 最安値idx: ${Number.isFinite(loIdx) ? loIdx : 'n/a'} (price: ${Number.isFinite(loPx) ? loPx.toLocaleString() : 'n/a'})`);
          lines.push(`- 最後の確定ピーク: idx=${Number.isFinite(lcp) ? lcp : 'n/a'} (${Number.isFinite(lcpAgo) ? `${lcpAgo}本前` : 'n/a'})`);
          lines.push(`- 最後の確定谷: idx=${Number.isFinite(lcv) ? lcv : 'n/a'} (${Number.isFinite(lcvAgo) ? `${lcvAgo}本前` : 'n/a'})`);
        } catch { /* noop */ }
        lines.push('');
        lines.push('【却下された候補（最新ウィンドウから5件）】');
        if (!rejected.length) {
          lines.push('- なし');
        } else {
          // 直近（終端idxが最新から50本以内）の却下候補を優先表示
          const recentRejected = rejected.filter((c: any) => {
            try {
              const e = Array.isArray(c?.indices) ? Number(c.indices[1]) : NaN;
              return Number.isFinite(e) ? ((lastIdx - e) <= 50) : false;
            } catch { return false; }
          });
          const list = (recentRejected.length ? recentRejected : rejected)
            .slice()
            .sort((a: any, b: any) => {
              const ae = Array.isArray(a?.indices) ? Number(a.indices[1]) : -Infinity;
              const be = Array.isArray(b?.indices) ? Number(b.indices[1]) : -Infinity;
              if (be !== ae) return be - ae; // endIdx desc
              const as = Array.isArray(a?.indices) ? Number(a.indices[0]) : -Infinity;
              const bs = Array.isArray(b?.indices) ? Number(b.indices[0]) : -Infinity;
              return bs - as; // startIdx desc
            })
            .slice(0, 5);
          lines.push(...list.map((c: any, i: number) => {
            const idxs = Array.isArray(c?.indices) ? `[${c.indices[0]},${c.indices[1]}]` : 'n/a';
            const reason = String(c?.reason || 'unknown');
            const upT = c?.details?.touches?.up ?? c?.details?.upTouches ?? 'n/a';
            const loT = c?.details?.touches?.lo ?? c?.details?.loTouches ?? 'n/a';
            const conv = c?.details?.convRatio != null ? Number(c.details.convRatio).toFixed(2) : 'n/a';
            const r2h = c?.details?.r2High != null ? Number(c.details.r2High).toFixed(3) : 'n/a';
            const r2l = c?.details?.r2Low != null ? Number(c.details.r2Low).toFixed(3) : 'n/a';
            const lp = c?.details?.lastPeakInWindow;
            const lv = c?.details?.lastValleyInWindow;
            const agoP = Number.isFinite(lp) ? `${lastIdx - Number(lp)}本前` : 'n/a';
            const agoV = Number.isFinite(lv) ? `${lastIdx - Number(lv)}本前` : 'n/a';
            const rHi = c?.details?.recentHiInside === true ? 'Yes' : 'No';
            const rLo = c?.details?.recentLoInside === true ? 'Yes' : 'No';
            const allowed = c?.details?.allowedByRecent === false ? 'false' : (c?.details?.allowedByRecent === true ? 'true' : 'n/a');
            const staleThreshold = 30;
            let why = '';
            if (reason === 'stale_last_pivot') {
              const barsSince = c?.details?.barsSince;
              const tooOld = Number.isFinite(barsSince) ? (barsSince > staleThreshold) : false;
              const haveRecent = (c?.details?.recentHiInside === true) || (c?.details?.recentLoInside === true);
              why = `（barsSince=${barsSince ?? 'n/a'}${tooOld ? `>${staleThreshold}` : ''}, recentInside=${haveRecent ? 'Yes' : 'No'}）`;
            }
            const hiCnt = c?.details?.highsCount != null ? c.details.highsCount : 'n/a';
            const loCnt = c?.details?.lowsCount != null ? c.details.lowsCount : 'n/a';
            // 収束の詳細（あれば出力）
            let convergeDetail = '';
            if (reason === 'not_converging_enough' || (c?.details?.gapStart != null && c?.details?.gapEnd != null)) {
              const upStart = c?.details?.upStart;
              const upEnd = c?.details?.upEnd;
              const loStart = c?.details?.loStart;
              const loEnd = c?.details?.loEnd;
              const gapStart = c?.details?.gapStart;
              const gapEnd = c?.details?.gapEnd;
              const convStr = (c?.details?.convRatio != null) ? Number(c.details.convRatio).toFixed(2) : 'n/a';
              const yen = (v: any) => Number.isFinite(Number(v)) ? Math.round(Number(v)).toLocaleString() + '円' : 'n/a';
              const calcExpr = (Number.isFinite(Number(upEnd)) && Number.isFinite(Number(loEnd)) && Number.isFinite(Number(upStart)) && Number.isFinite(Number(loStart)))
                ? `(${yen(upEnd)} - ${yen(loEnd)}) / (${yen(upStart)} - ${yen(loStart)}) = ${convStr}`
                : `gapEnd / gapStart = ${convStr}`;
              convergeDetail =
                `\n   - gapStart: ${yen(gapStart)}（開始時点の上下ライン幅）` +
                `\n   - gapEnd: ${yen(gapEnd)}（終了時点の上下ライン幅）` +
                `\n   - convRatio: gapEnd / gapStart = ${convStr}` +
                `\n   - 上側ライン(startIdx): ${yen(upStart)} / 上側ライン(endIdx): ${yen(upEnd)}` +
                `\n   - 下側ライン(startIdx): ${yen(loStart)} / 下側ライン(endIdx): ${yen(loEnd)}` +
                `\n   - 計算: ${calcExpr}`;
            }
            return `${i + 1}. indices=${idxs} reason=${reason}${why}\n   - 最終ピーク in window: ${Number.isFinite(lp) ? lp : 'n/a'} (${agoP})\n   - 最終谷 in window: ${Number.isFinite(lv) ? lv : 'n/a'} (${agoV})\n   - 直近高値含む: ${rHi} / 直近安値含む: ${rLo} / allowedByRecent: ${allowed}\n   - r2={hi:${r2h}, lo:${r2l}} touches={up:${upT}, lo:${loT}} convRatio=${conv}\n   - swings={peaks:${hiCnt}, valleys:${loCnt}}${convergeDetail}`;
          }));
          // 長期ウィンドウ（100-120本, 終端=最新）の候補も別枠で表示
          try {
            const longRejected = rejected
              .filter((c: any) => {
                if (!Array.isArray(c?.indices)) return false;
                const s = Number(c.indices[0]), e = Number(c.indices[1]);
                const len = e - s;
                return Number.isFinite(s) && Number.isFinite(e) && e >= lastIdx - 2 && len >= 100 && len <= 120;
              })
              .sort((a: any, b: any) => {
                const as = Number(a.indices[0]); const bs = Number(b.indices[0]);
                return bs - as; // startIdx desc
              })
              .slice(0, 5);
            if (longRejected.length) {
              lines.push('');
              lines.push('【長期ウィンドウ（100-120本, 終端=最新）の却下候補】');
              lines.push(...longRejected.map((c: any, i: number) => {
                const idxs = `[${c.indices[0]},${c.indices[1]}]`;
                const reason = String(c?.reason || 'unknown');
                const conv = c?.details?.convRatio != null ? Number(c.details.convRatio).toFixed(2) : 'n/a';
                const yen = (v: any) => Number.isFinite(Number(v)) ? Math.round(Number(v)).toLocaleString() + '円' : 'n/a';
                const upStart = c?.details?.upStart, upEnd = c?.details?.upEnd;
                const loStart = c?.details?.loStart, loEnd = c?.details?.loEnd;
                const gapStart = c?.details?.gapStart, gapEnd = c?.details?.gapEnd;
                return `${i + 1}. indices=${idxs} reason=${reason}\n   - gapStart: ${yen(gapStart)} / gapEnd: ${yen(gapEnd)} / convRatio: ${conv}\n   - 上側(start→end): ${yen(upStart)} → ${yen(upEnd)}\n   - 下側(start→end): ${yen(loStart)} → ${yen(loEnd)}`;
              }));
            }
          } catch { /* noop */ }
        }
        // 参考: 最初の10件をサンプル表示
        const sample = arr.slice(0, 10).map((c: any, i: number) => {
          const tag = c.accepted ? '✅' : '❌';
          const idxs = Array.isArray(c?.indices) ? ` [${c.indices[0]},${c.indices[1]}]` : '';
          const reason = c.accepted ? '' : (c.reason ? ` (${c.reason})` : '');
          let det = '';
          if (c.details) {
            try { det = ` conv=${c.details?.convRatio ?? 'n/a'} upT=${c.details?.touches?.up ?? 'n/a'} loT=${c.details?.touches?.lo ?? 'n/a'} conf=${c.details?.confidence ?? 'n/a'}`; } catch { }
          }
          return `  ${i + 1}. ${tag} ${c.type}${reason}${idxs}${det}`;
        }).join('\n');
        lines.push('');
        lines.push(sample || '  （候補サンプルなし）');
        lines.push('');
        return lines.join('\n');
      })(),
      (() => {
        const highestIdx = highestInWindow.idx;
        const highestPrice = Number(candles[highestIdx]?.high);
        const inPeaksList = peaks.some(p => p.idx === highestIdx);
        const isConfirmed = inPeaksList && isPivotConfirmed(highestIdx, lastIdx);
        const barsWindow = Math.max(5, Math.round(maxPatternDays / Math.max(1e-12, daysPerBarCalc(String(type)))));
        const confirmedPeaksForHead = peaks.filter(p => isPivotConfirmed(p.idx, lastIdx));
        const leftCandidates = confirmedPeaksForHead.filter(p => p.idx < highestIdx && (highestIdx - p.idx) <= barsWindow && highestPrice > p.price * 1.05);
        const leftFound = leftCandidates.length > 0;
        const postHeadValleyFound = valleys.some(v => v.idx > highestIdx && isPivotConfirmed(v.idx, lastIdx));
        return [
          '【最高値の詳細】',
          `- idx=${highestIdx}`,
          `- price=${Number.isFinite(highestPrice) ? Math.round(highestPrice).toLocaleString() : 'n/a'}`,
          `- isConfirmedPeak: ${isConfirmed}`,
          `- leftShoulderFound: ${leftFound}`,
          `- postHeadValleyFound: ${postHeadValleyFound}`,
          `- inPeaksList: ${inPeaksList}`,
          '',
        ].join('\n');
      })(),
      '',
      '【スイング検出】',
      `- ピーク: ${peaks.length}個`,
      `- 谷: ${valleys.length}個`,
      `- 最新5本: [${last5.join(', ')}]`,
      '',
      '【候補パターン】',
      candidates.length
        ? candidates
          .map((c, i) => {
            const reason = c.adopt ? '← 採用' : '← 却下（minCompletion未満）';
            const det = c.detail.join('\n');
            return `${i + 1}. ${c.title} ${reason}\n${det}`;
          })
          .join('\n\n')
        : '該当なし',
      '',
      whatIfBlock,
      '',
      '【検出されたパターン】',
      `${visible.length}件（minCompletion=${minCompletion} を満たすパターン${visible.length ? '' : 'なし'}）`,
      visible.length ? detectedBrief : '',
      '',
      contextBlock,
    ].join('\n');
    const dbgContext = {
      hasMultipleTimeframes: dbgHasMulti,
      categories: {
        short_term: dbgCats.short_term,
        structural: dbgCats.structural,
        watchlist: dbgCats.watchlist,
      },
    };
    return ok(text, { patterns: visibleSorted, context: dbgContext, meta: { pair: pairNorm, type, count: visibleSorted.length, peaks: peaks.length, valleys: valleys.length } }, createMeta(pairNorm, { type, debug: true })) as any;
  }

  // === Freshness grouping ===
  const grouped = (() => {
    const active: any[] = [];
    const watchlist: any[] = [];
    const expired: any[] = [];
    // completed summary buckets for LLM誤解防止（構造化）
    const completedActive: any[] = [];
    const completedInvalidated: any[] = [];
    const completedExpired: any[] = [];
    // forming freshness by bars since last forming/confirmed pivot
    for (const p of enriched) {
      const formingIdx = Number(p?.formingPivots?.[0]?.idx ?? p?.confirmedPivots?.[p?.confirmedPivots?.length - 1]?.idx ?? lastIdx);
      const barsSinceLastPivot = Math.max(0, lastIdx - formingIdx);
      const status = barsSinceLastPivot <= maxBarsFromLastPivot ? 'forming_active' : 'forming_stale';
      const target = status === 'forming_active' ? active : watchlist;
      target.push({
        type: p.type,
        completion: p.completion,
        status,
        freshness: status === 'forming_active' ? 'アクティブ - エントリー検討可' : '形成停滞 - 要監視',
        barsSinceLastPivot,
        formationPeriod: p?.formationPeriod,
      });
    }
    // recently completed freshness (optional) + post-breakout retracement expiry
    if (includeCompleted && Array.isArray(recentCompleted)) {
      // Only patterns that actually confirmed breakout (with buffer, handled in detect_patterns aftermath)
      const onlyBrokenOut = recentCompleted.filter((p: any) => p?.aftermath?.breakoutConfirmed === true && typeof p?.aftermath?.breakoutDate === 'string');
      const parseIdxGap = (isoEnd?: string) => {
        const tEnd = Number.isFinite(Date.parse(String(isoEnd))) ? Date.parse(String(isoEnd)) : NaN;
        const tLast = Number.isFinite(Date.parse(String(candles[lastIdx]?.isoTime))) ? Date.parse(String(candles[lastIdx]?.isoTime)) : NaN;
        if (!Number.isFinite(tEnd) || !Number.isFinite(tLast)) return Infinity;
        const days = Math.max(0, Math.round((tLast - tEnd) / 86400000));
        const bars = Math.max(0, Math.round(days / Math.max(1e-12, daysPerBar(String(type)))));
        return bars;
      };
      const idxByIso = (iso?: string) => {
        try {
          const t = Date.parse(String(iso));
          if (!Number.isFinite(t)) return lastIdx;
          let best = lastIdx;
          for (let i = 0; i < n; i++) {
            const ti = Date.parse(String(candles[i]?.isoTime));
            if (Number.isFinite(ti) && ti >= t) { best = i; break; }
          }
          return best;
        } catch { return lastIdx; }
      };
      const currentPrice = candles[lastIdx]?.close;
      for (const p of onlyBrokenOut) {
        // 完成日 = ブレイクアウト日（after range.end）
        const breakoutIso = String(p?.aftermath?.breakoutDate || '');
        const barsFromBreakout = parseIdxGap(breakoutIso);
        // estimate breakout index and neckline/breakout price
        const breakoutIdx = idxByIso(breakoutIso);
        const nlA = p?.neckline?.[0]?.y;
        const nlB = p?.neckline?.[1]?.y;
        const breakoutPrice = Number.isFinite(nlB) ? Number(nlB) : (Number.isFinite(nlA) ? Number(nlA) : Number(candles[breakoutIdx]?.close));
        // scan candles after breakout
        const seg = candles.slice(Math.min(Math.max(0, breakoutIdx), n - 1));
        const hiAfter = seg.length ? Math.max(...seg.map(c => Number(c?.high) || 0)) : breakoutPrice;
        const loAfter = seg.length ? Math.min(...seg.map(c => Number(c?.low) || breakoutPrice)) : breakoutPrice;
        // retracement expiry check (50%既定)
        const retraceExpire = (() => {
          const half = 0.5;
          if (!Number.isFinite(breakoutPrice) || !Number.isFinite(currentPrice)) return false;
          const typeStr = String(p?.type || '');
          if (typeStr === 'inverse_head_and_shoulders' || typeStr === 'double_bottom' || typeStr === 'triple_bottom') {
            const expectedRise = breakoutPrice * 0.05;
            const actualRise = hiAfter - breakoutPrice;
            if (actualRise >= expectedRise) {
              const denom = Math.max(1e-12, hiAfter - breakoutPrice);
              const retr = (hiAfter - currentPrice) / denom;
              return retr > half;
            }
            return false;
          }
          if (typeStr === 'head_and_shoulders' || typeStr === 'double_top' || typeStr === 'triple_top') {
            const expectedDrop = breakoutPrice * 0.05;
            const actualDrop = breakoutPrice - loAfter;
            if (actualDrop >= expectedDrop) {
              const denom = Math.max(1e-12, breakoutPrice - loAfter);
              const retr = (currentPrice - loAfter) / denom;
              return retr > half;
            }
            return false;
          }
          return false;
        })();
        // neckline re-entry invalidation (fail after breakout)
        const invalidated = (() => {
          if (!Number.isFinite(breakoutPrice) || !Number.isFinite(currentPrice)) return false;
          const typeStr = String(p?.type || '');
          if (typeStr === 'inverse_head_and_shoulders' || typeStr === 'double_bottom' || typeStr === 'triple_bottom') {
            // bullish: if price is back below neckline, treat as invalidated
            return currentPrice < breakoutPrice;
          }
          if (typeStr === 'head_and_shoulders' || typeStr === 'double_top' || typeStr === 'triple_top') {
            // bearish: if price back above neckline, invalidated
            return currentPrice > breakoutPrice;
          }
          return false;
        })();
        // return since breakout（方向に依らず生の変化率）
        const retPct = (() => {
          if (!Number.isFinite(breakoutPrice) || !Number.isFinite(currentPrice)) return null;
          return Number((((currentPrice - breakoutPrice) / Math.max(1e-12, breakoutPrice)) * 100).toFixed(2));
        })();
        const bullishLike = ['inverse_head_and_shoulders', 'double_bottom', 'triple_bottom'].includes(String(p?.type));
        const invalidReason = invalidated ? (bullishLike ? 'price_below_neckline' : 'price_above_neckline') : null;
        const obj = {
          type: p?.type,
          status: invalidated ? 'invalidated' as const : 'completed' as const,
          freshness: (barsFromBreakout <= maxCompletedBars && !retraceExpire && !invalidated) ? '完成直後 - 有効範囲' : '期限切れ',
          barsFromBreakout,
          range: p?.range,
          details: {
            breakoutPrice: Number.isFinite(breakoutPrice) ? Math.round(breakoutPrice) : null,
            hiAfter: Number.isFinite(hiAfter) ? Math.round(hiAfter) : null,
            loAfter: Number.isFinite(loAfter) ? Math.round(loAfter) : null,
            retracementExpired: retraceExpire || false,
            necklineInvalidated: invalidated || false,
            breakoutDate: breakoutIso || null,
            currentPrice: Number.isFinite(currentPrice) ? Math.round(currentPrice) : null,
            returnPctSinceBreakout: retPct,
            invalidationReason: invalidReason,
          }
        };
        const isActive = (barsFromBreakout <= maxCompletedBars) && !retraceExpire && !invalidated;
        if (isActive) {
          active.push(obj);
          completedActive.push({
            pattern: String(p?.type),
            breakoutDate: breakoutIso || null,
            barsAgo: barsFromBreakout,
            returnPct: retPct,
            status: 'active',
            neckline: Number.isFinite(breakoutPrice) ? Math.round(breakoutPrice) : null,
            currentPrice: Number.isFinite(currentPrice) ? Math.round(currentPrice) : null,
            pivots: Array.isArray((p as any)?.pivots) ? (p as any).pivots : [],
            range: p?.range,
          });
        } else if (invalidated) {
          expired.push(obj);
          completedInvalidated.push({
            pattern: String(p?.type),
            breakoutDate: breakoutIso || null,
            barsAgo: barsFromBreakout,
            returnPct: retPct,
            status: 'invalidated',
            invalidationReason: invalidReason,
            neckline: Number.isFinite(breakoutPrice) ? Math.round(breakoutPrice) : null,
            currentPrice: Number.isFinite(currentPrice) ? Math.round(currentPrice) : null,
            pivots: Array.isArray((p as any)?.pivots) ? (p as any).pivots : [],
            range: p?.range,
          });
        } else {
          expired.push(obj);
          completedExpired.push({
            pattern: String(p?.type),
            breakoutDate: breakoutIso || null,
            barsAgo: barsFromBreakout,
            returnPct: retPct,
            status: 'expired',
            neckline: Number.isFinite(breakoutPrice) ? Math.round(breakoutPrice) : null,
            currentPrice: Number.isFinite(currentPrice) ? Math.round(currentPrice) : null,
            reason: retraceExpire ? 'retracement>50%' : 'time_window_exceeded',
            pivots: Array.isArray((p as any)?.pivots) ? (p as any).pivots : [],
            range: p?.range,
          });
        }
      }
    }
    return { active, watchlist, expired, completedSummary: { active: completedActive, invalidated: completedInvalidated, expired: completedExpired } };
  })();

  if (view === 'summary') {
    const pickShort = categorized.short_term[0];
    const pickStruct = categorized.structural[0];
    const linesSum: string[] = [];
    linesSum.push(`${summary}（${typeSummary || '分類なし'}）`);
    linesSum.push('');
    linesSum.push('【🔴 最重要: 現在進行形】');
    if (pickShort || pickStruct) {
      if (pickShort && pickStruct) {
        linesSum.push('複数の重要なパターンが検出されています。');
        const fmtPick = (p: any, tag: string) => {
          const right = p?.formingPivots?.[0];
          const formingIdx = Number(right?.idx ?? lastIdx);
          const barsSince = Math.max(0, lastIdx - formingIdx);
          const daysSince = Math.round(barsSince * (daysPerBar(String(type)) || 1));
          return `【${tag}】${p.type}（完成度${Math.round(p.completion * 100)}%、右肩=${daysSince === 0 ? '今日' : `${daysSince}日前`}）`;
        };
        linesSum.push(fmtPick(pickShort, '短期'));
        linesSum.push(fmtPick(pickStruct, '中期'));
        if ((isBullish(String(pickShort?.type)) && isBearish(String(pickStruct?.type))) ||
          (isBearish(String(pickShort?.type)) && isBullish(String(pickStruct?.type)))) {
          linesSum.push('⚠️ 短期と中期で示唆が異なるため、調整局面の可能性');
        }
      } else {
        const only = pickShort || pickStruct;
        const tag = pickShort ? '短期' : '中期';
        const right = only?.formingPivots?.[0];
        const formingIdx = Number(right?.idx ?? lastIdx);
        const barsSince = Math.max(0, lastIdx - formingIdx);
        const daysSince = Math.round(barsSince * (daysPerBar(String(type)) || 1));
        linesSum.push(`【${tag}】${only.type}（完成度${Math.round(only.completion * 100)}%、右肩=${daysSince === 0 ? '今日' : `${daysSince}日前`}）`);
      }
    } else {
      // フォールバック（カテゴリ無し）: impact順で上位2件を簡潔に
      const top2 = sortedEnriched.slice(0, 2).map((p: any) => `- ${p.type}（完成度${Math.round(p.completion * 100)}%）`);
      linesSum.push(top2.length ? top2.join('\n') : '該当なし');
    }
    linesSum.push('');
    linesSum.push('【🟡 重要: 長期視点】');
    linesSum.push(`週足: ${ltWeek.items.length ? ltWeek.items.map((p: any) => `${p.type}（ネックライン${p?.neckline?.[1]?.y != null ? Math.round(p.neckline[1].y).toLocaleString() : 'n/a'}円）`).slice(0, 3).join(' / ') : '該当なし'}`);
    linesSum.push(`月足: ${ltMonth.items.length ? ltMonth.items.map((p: any) => `${p.type}（ネックライン${p?.neckline?.[1]?.y != null ? Math.round(p.neckline[1].y).toLocaleString() : 'n/a'}円）`).slice(0, 3).join(' / ') : '該当なし'}`);
    linesSum.push('');
    const recentDaysSum = Math.round(maxCompletedBars * (daysPerBar(String(type)) || 1));
    linesSum.push(`【🟢 参考: 最近完成（${recentDaysSum}日以内）】`);
    // セクション分離（有効 / 無効化 / 期限切れ）
    const comp = (grouped as any)?.completedSummary || { active: [], invalidated: [], expired: [] };
    const fmtArr = (arr: any[], tag: 'active' | 'invalidated' | 'expired') => {
      if (!arr?.length) return '- 該当なし';
      return arr.slice(0, 3).map((p: any) => {
        const date = String(p?.breakoutDate || '').slice(0, 10) || 'n/a';
        const ret = (typeof p?.returnPct === 'number') ? `${p.returnPct >= 0 ? '+' : ''}${p.returnPct.toFixed(2)}%` : 'n/a';
        const neck = Number.isFinite(p?.neckline) ? Math.round(Number(p.neckline)).toLocaleString() : 'n/a';
        const nowPx = Number.isFinite(p?.currentPrice) ? Math.round(Number(p.currentPrice)).toLocaleString() : 'n/a';
        if (tag === 'active') return `- ${p.pattern}（${date} 完成, ${ret}）`;
        if (tag === 'invalidated') return `- ${p.pattern}（${date} 完成 → ❌無効化, 理由: ${p?.invalidationReason || 'unknown'} / NL: ${neck}円 / 現在: ${nowPx}円）`;
        return `- ${p.pattern}（${date} 完成 → 期限切れ, ${ret} / NL: ${neck}円）`;
      }).join('\n');
    };
    linesSum.push('【✅ 有効なブレイク】');
    linesSum.push(fmtArr(comp.active, 'active'));
    linesSum.push('');
    linesSum.push('【❌ 無効化されたパターン】');
    linesSum.push(fmtArr(comp.invalidated, 'invalidated'));
    const text = linesSum.join('\n');
    const context = {
      hasMultipleTimeframes: hasDifferentCategories,
      categories: {
        short_term: categorized.short_term.map((p: any) => ({ type: p.type, completion: p.completion, context: p.context })),
        structural: categorized.structural.map((p: any) => ({ type: p.type, completion: p.completion, context: p.context })),
        watchlist: categorized.watchlist.map((p: any) => ({ type: p.type, completion: p.completion, context: p.context })),
      },
      relationships,
    };
    return ok(text, { patterns: sortedEnriched, grouped, context, meta: { pair: pairNorm, type, count: enriched.length } }, createMeta(pairNorm, { type })) as any;
  }

  // optional: pattern metadata for reliability/complexity and typical formation window
  const PATTERN_METADATA: Record<string, { minDays: number; typicalDays: number; maxDays?: number; reliability: 'high' | 'medium' | 'low'; complexity: 'simple' | 'moderate' | 'complex'; note?: string }> = {
    'double_top': { minDays: 14, typicalDays: 21, maxDays: 60, reliability: 'high', complexity: 'simple', note: 'ネックラインのブレイク＋出来高増が確認条件' },
    'double_bottom': { minDays: 14, typicalDays: 21, maxDays: 60, reliability: 'high', complexity: 'simple', note: 'ネックライン上抜け時の出来高が重要' },
    'triple_top': { minDays: 21, typicalDays: 60, maxDays: 180, reliability: 'high', complexity: 'moderate', note: '3点の等高性に注意（±2-3%）' },
    'triple_bottom': { minDays: 21, typicalDays: 60, maxDays: 180, reliability: 'high', complexity: 'moderate', note: '3点の等安性に注意（±2-3%）' },
    'head_and_shoulders': { minDays: 21, typicalDays: 60, maxDays: 365, reliability: 'high', complexity: 'moderate', note: 'ネックライン傾き・左右対称性で信頼度変化' },
    'inverse_head_and_shoulders': { minDays: 21, typicalDays: 60, maxDays: 365, reliability: 'high', complexity: 'moderate', note: '完成後の戻り売りを想定' },
    'triangle_descending': { minDays: 28, typicalDays: 60, maxDays: 90, reliability: 'high', complexity: 'moderate', note: 'フラットサポートの実体割れ＋出来高で信頼度上昇' },
    'triangle_ascending': { minDays: 28, typicalDays: 60, maxDays: 90, reliability: 'medium', complexity: 'moderate' },
    'triangle_symmetrical': { minDays: 21, typicalDays: 60, maxDays: 84, reliability: 'medium', complexity: 'moderate' },
    'pennant': { minDays: 7, typicalDays: 14, maxDays: 21, reliability: 'medium', complexity: 'moderate' },
    'flag': { minDays: 14, typicalDays: 21, maxDays: 28, reliability: 'medium', complexity: 'simple' },
  };
  const typicalString = (d: number) => {
    if (d < 7) return `${d}日`;
    const w = Math.round(d / 7);
    return `${w}週間`;
  };

  const fmt = (p: any, i: number) => {
    const start = p?.range?.start?.slice(0, 10) || 'n/a';
    // Wedge specific formatting (falling/rising)
    const tStr = String(p?.type || '');
    if (tStr === 'falling_wedge' || tStr === 'rising_wedge') {
      const rangeEndIso = (p?.range?.current as string) || '';
      const endFmt = fmtDate(rangeEndIso);
      const up = p?.upperLine || {};
      const lo = p?.lowerLine || {};
      const upSlope = (Number.isFinite(Number(up?.slope)) ? Number(up.slope).toFixed(6) : 'n/a');
      const loSlope = (Number.isFinite(Number(lo?.slope)) ? Number(lo.slope).toFixed(6) : 'n/a');
      const upR2 = (Number.isFinite(Number(up?.r2)) ? Number(up.r2).toFixed(3) : 'n/a');
      const loR2 = (Number.isFinite(Number(lo?.r2)) ? Number(lo.r2).toFixed(3) : 'n/a');
      const upT = Array.isArray(up?.touchPoints) ? up.touchPoints.length : (Number.isFinite(Number(up?.touches)) ? Number(up.touches) : 'n/a');
      const loT = Array.isArray(lo?.touchPoints) ? lo.touchPoints.length : (Number.isFinite(Number(lo?.touches)) ? Number(lo.touches) : 'n/a');
      const conv = Number.isFinite(Number(p?.convergenceRatio)) ? Number(p.convergenceRatio).toFixed(3) : 'n/a';
      const compPct = Number.isFinite(Number(p?.completion)) ? Math.round(Number(p.completion) * 100) : 'n/a';
      const apexDate = p?.apexDate ? fmtDate(String(p.apexDate)) : 'n/a';
      const d2a = Number.isFinite(Number(p?.daysToApex)) ? `${p.daysToApex}日` : 'n/a';
      const target = Number.isFinite(Number(p?.breakoutTarget)) ? Math.round(Number(p.breakoutTarget)).toLocaleString() + '円' : 'n/a';
      const inval = Number.isFinite(Number(p?.invalidationPrice)) ? Math.round(Number(p.invalidationPrice)).toLocaleString() + '円' : 'n/a';
      const formation = p?.formationPeriod?.formatted || '';
      const status = String(p?.status || 'active');
      const conf = Number.isFinite(Number(p?.confidence)) ? Number(p.confidence).toFixed(2) : 'n/a';

      // 無効化警告の生成
      const currentPrice = Number.isFinite(Number(p?.currentPrice)) ? Number(p.currentPrice) : null;
      const invalidationPrice = Number.isFinite(Number(p?.invalidationPrice)) ? Number(p.invalidationPrice) : null;
      let invalidationWarning: string | null = null;

      if (status === 'invalid' && currentPrice != null && invalidationPrice != null) {
        const pctBelow = ((currentPrice - invalidationPrice) / invalidationPrice * 100);
        const direction = p.type === 'falling_wedge' ? '下回' : '上回';
        invalidationWarning = `   ⚠️ 【無効化済み】現在価格¥${currentPrice.toLocaleString()}が無効化ライン¥${invalidationPrice.toLocaleString()}を${pctBelow.toFixed(1)}%${direction}っており、このパターンは既に無効化されています`;
      } else if (status === 'near_invalidation' && currentPrice != null && invalidationPrice != null) {
        const pctToInvalidation = Math.abs((invalidationPrice - currentPrice) / currentPrice * 100);
        invalidationWarning = `   ⚠️ 【警告】現在価格¥${currentPrice.toLocaleString()}が無効化ライン¥${invalidationPrice.toLocaleString()}まで${pctToInvalidation.toFixed(1)}%圏内です`;
      }

      const lines = [
        `${i + 1}. ${tStr} (完成度: ${compPct}%, パターン整合度: ${conf})`,
        `   - 期間: ${fmtDate(start)} 〜 ${endFmt}${formation ? `（${formation}）` : ''}`,
        `   - 上側ライン: slope=${upSlope}, r2=${upR2}, touches=${upT}`,
        `   - 下側ライン: slope=${loSlope}, r2=${loR2}, touches=${loT}`,
        `   - 収束率: ${conv}（小さいほど収束）`,
        `   - アペックス: ${apexDate}（残り${d2a}）`,
        status === 'invalid' || status === 'near_invalidation'
          ? `   - 現在価格: ¥${currentPrice?.toLocaleString() || 'n/a'}`
          : null,
        `   - ブレイク目標: ${target} / 無効化: ${inval}`,
        `   - 状態: ${status}${status === 'invalid' ? '（無効化済み）' : status === 'near_invalidation' ? '（無効化寸前）' : ''}`,
        invalidationWarning,
      ].filter(Boolean);
      return lines.join('\n');
    }
    // confirmed pivots by role（順序に依存しない安全な参照）
    const cps = Array.isArray(p?.confirmedPivots) ? p.confirmedPivots : [];
    const byRole = (role: string) => cps.find((cp: any) => String(cp?.role) === role);
    const left = byRole('left_shoulder') || cps[0];
    const headPivot = byRole('head') || cps.find((cp: any) => String(cp?.role).includes('head')) || cps[1];
    const preHeadPeak = byRole('pre_head_peak');
    const postHeadPeak = byRole('post_head_peak');
    const preHeadValley = byRole('pre_head_valley');
    const postHeadValley = byRole('post_head_valley');
    // legacy fallbacks
    const valleyOrPeak = headPivot || cps[1];
    const afterHead = postHeadPeak || postHeadValley || cps[2];
    const forming = p.formingPivots?.[0];
    const formingRole = String(forming?.role || '');
    const nl = Array.isArray(p.neckline) && p.neckline.length === 2 ? p.neckline : null;
    const nlStr = nl ? (nl[0].y === nl[1].y ? `${Math.round(nl[0].y).toLocaleString()}円（水平）` : `${Math.round(nl[0].y).toLocaleString()}円 → ${Math.round(nl[1].y).toLocaleString()}円`) : 'n/a';
    // 形成期間は右肩確定時点まで（確定していない場合のみ現在まで）
    const periodBars = Number.isFinite(p?.formationPeriod?.bars) ? Number(p.formationPeriod.bars) : Math.max(0, (forming?.idx ?? lastIdx) - (left?.idx ?? 0));
    const periodFmt = formatPeriod(periodBars, type);
    // 表示上の範囲はネックラインアンカー（range.start ↔ range.current）を優先
    // まず「肩区間（range）」を優先し、なければフォールバック
    const rangeStartIso = (p?.range?.start as string) || (p?.rangeAnchors?.startIso as string) || (p?.formationPeriod?.start as string) || (left?.isoTime as string);
    const rangeEndIso = (p?.range?.current as string) || (p?.rangeAnchors?.endIso as string) || (p?.formationPeriod?.end as string) || (forming?.isoTime as string) || (afterHead?.isoTime as string);
    const startFmt = fmtDate(rangeStartIso);
    const formingFmt = fmtDate(forming?.isoTime);
    const covRatio = Number(limit) > 0 ? (periodBars / Number(limit)) : 0;
    const covPctStr = `${(covRatio * 100).toFixed(1)}%`;
    const scaleOk = p?.scale_validation?.status === 'appropriate';
    // Labels by pattern type
    let leftLabel = '左肩';
    let midLabel = '谷';
    let rightLabel = '右肩';
    let thirdLabel: string | null = null;
    if (p.type === 'double_bottom') {
      leftLabel = '左谷';
      midLabel = '山';
      rightLabel = '右谷';
      thirdLabel = null;
    } else if (p.type === 'double_top') {
      leftLabel = '左肩';
      midLabel = '谷';
      rightLabel = '右肩';
      thirdLabel = null;
    } else if (p.type === 'head_and_shoulders') {
      leftLabel = '左肩';
      midLabel = '頭';
      rightLabel = '右肩';
      thirdLabel = '頭後の谷';
    } else if (p.type === 'inverse_head_and_shoulders') {
      leftLabel = '左肩';
      midLabel = '頭';
      rightLabel = '右肩';
      thirdLabel = '頭後の山';
    }
    const tfLabel = (() => {
      const map: Record<string, string> = {
        '1day': '日足',
        '1week': '週足',
        '1month': '月足',
        '1hour': '1時間足',
        '4hour': '4時間足',
        '8hour': '8時間足',
        '12hour': '12時間足',
        '15min': '15分足',
        '30min': '30分足',
        '5min': '5分足',
        '1min': '1分足',
      };
      return map[type] || type;
    })();
    const meta = PATTERN_METADATA[String(p.type)] || null;
    // ネックライン乖離と状態（未ブレイク/直近ブレイク）を補足
    let stateLines: string[] = [];
    try {
      const curPx = Number(candles[lastIdx]?.close);
      const nlY = nl ? Number(nl[1]?.y ?? nl[0]?.y) : null;
      if (Number.isFinite(curPx) && Number.isFinite(nlY)) {
        const diffPct = ((curPx - (nlY as number)) / Math.max(1e-12, nlY as number)) * 100;
        const sign = diffPct >= 0 ? '+' : '';
        const dir = (p.type === 'inverse_head_and_shoulders' || p.type === 'double_bottom' || p.type === 'triple_bottom') ? '上抜け' : '下抜け';
        const buf = 2.0; // %
        const crossed = (p.type === 'inverse_head_and_shoulders' || p.type === 'double_bottom' || p.type === 'triple_bottom')
          ? (diffPct > buf)
          : (diffPct < -buf);
        const status = p?.status === 'recent_breakout' ? `直近ブレイク（${dir}）` : (crossed ? `ブレイク済み（${dir}）` : `未ブレイク（乖離 ${sign}${diffPct.toFixed(1)}%）`);
        stateLines.push(`   - 状態: ${status}`);
      }
    } catch { /* noop */ }
    // 鮮度（右肩からの経過本数）と乖離の補助行
    let freshnessLine: string | null = null;
    try {
      const rs = forming?.idx != null ? Math.max(0, lastIdx - forming.idx) : null;
      if (rs != null) freshnessLine = `   - 鮮度: 右肩から${rs}本（基準${maxBarsFromLastPivot}本以内で鮮度高）`;
    } catch { /* ignore */ }
    const lines = [
      `${i + 1}. 【${tfLabel}・${periodFmt}】${p.type} (完成度: ${Math.round(p.completion * 100)}%, パターン整合度: ${p.confidence?.toFixed(2) ?? 'n/a'})`,
      `   - 形成区間（肩→肩）: ${startFmt} 〜 ${fmtDate(rangeEndIso)}`,
      `   - カバレッジ: ${covPctStr} ${scaleOk ? '✅' : '⚠️'}`,
      left ? `   - ${leftLabel}: ${Math.round(left.price).toLocaleString()}円（${fmtDate(left.isoTime)}確定）` : null,
      valleyOrPeak ? `   - ${midLabel}: ${Math.round(valleyOrPeak.price).toLocaleString()}円（${fmtDate(valleyOrPeak.isoTime)}確定）` : null,
      // 逆三尊: 頭前の山/頭後の山 を明示
      (p.type === 'inverse_head_and_shoulders' && preHeadPeak) ? `   - 頭前の山: ${Math.round(preHeadPeak.price).toLocaleString()}円（${fmtDate(preHeadPeak.isoTime)}確定）` : null,
      (p.type === 'inverse_head_and_shoulders' && postHeadPeak) ? `   - 頭後の山: ${Math.round(postHeadPeak.price).toLocaleString()}円（${fmtDate(postHeadPeak.isoTime)}確定）` : null,
      // 三尊: 頭前/頭後の谷 を明示
      (p.type === 'head_and_shoulders' && preHeadValley) ? `   - 頭前の谷: ${Math.round(preHeadValley.price).toLocaleString()}円（${fmtDate(preHeadValley.isoTime)}確定）` : null,
      (p.type === 'head_and_shoulders' && postHeadValley) ? `   - 頭後の谷: ${Math.round(postHeadValley.price).toLocaleString()}円（${fmtDate(postHeadValley.isoTime)}確定）` : null,
      // 役割ピボットが欠ける場合は従来のthirdLabelで補う
      (!((p.type === 'inverse_head_and_shoulders' && (preHeadPeak || postHeadPeak)) || (p.type === 'head_and_shoulders' && (preHeadValley || postHeadValley))) && thirdLabel && afterHead)
        ? `   - ${thirdLabel}: ${Math.round(afterHead.price).toLocaleString()}円（${fmtDate(afterHead.isoTime)}確定）` : null,
      forming ? (formingRole === 'right_shoulder'
        ? `   - ${rightLabel}: 確定 ${Math.round(forming.price).toLocaleString()}円（${formingFmt}）`
        : `   - ${rightLabel}: 形成中 ${Math.round(forming.price).toLocaleString()}円（${formingFmt}）`) : null,
      `   - 推定ネックライン: ${nlStr}`,
      ...stateLines,
      freshnessLine,
      p?.scale_validation?.warning ? `   【スケール警告】${p.scale_validation.warning}` : null,
      p?.scale_validation?.recommended_limit ? `   【推奨表示範囲】limit=${p.scale_validation.recommended_limit}` : null,
      p?.scale_validation?.timeframe_suggestion ? `   【時間軸の提案】${p.scale_validation.timeframe_suggestion}` : null,
      meta ? `   【パターン情報】典型形成: ${typicalString(meta.typicalDays)} / 信頼性: ${meta.reliability}${meta.note ? ` / メモ: ${meta.note}` : ''}` : null,
      '',
      '   【シナリオ】',
      `   ✓ 完成条件: ${p.scenarios?.completion?.priceRange?.[0]?.toLocaleString?.() || 'n/a'}-${p.scenarios?.completion?.priceRange?.[1]?.toLocaleString?.() || 'n/a'}円で反転${p.type === 'double_top' ? '下落' : '上昇'}`,
      `   ✓ 完成後の注目: ネックライン${nl ? Math.round(nl[0].y).toLocaleString() : 'n/a'}円のブレイク`,
      `   ✗ 無効化条件: ${p.scenarios?.invalidation?.priceLevel?.toLocaleString?.() || 'n/a'}円を${p.type === 'double_top' ? '上' : '下'}抜け`,
      '',
      '   【次のアクション】',
      ...(Array.isArray(p.nextSteps) ? p.nextSteps.map((s: string) => `   - ${s}`) : []),
    ].filter(Boolean);
    return lines.join('\n');
  };

  const list = (view === 'full' ? enriched : enriched.slice(0, 5)).map(fmt).join('\n\n');
  const tail = "\n\n形成中パターンについて:\n  完成度60%以上 = 形成が進んでいる\n  完成度40-60% = 初期段階（不確実）\n  パターン整合度は完成後の予想整合度";

  // Priority-structured content (detailed/full)
  const lines: string[] = [];
  lines.push(summary);
  lines.push('');
  lines.push('【検出ルール】同一タイプで期間重複50%以上は「直近まで含む＞完成度＞整合度」の優先度で1件のみ表示（重複は整理）');
  lines.push('【🔴 最重要: 現在進行形】');
  if (enriched.length) {
    if (hasDifferentCategories) {
      lines.push('複数の重要なパターンが検出されています。短期的な動きと中期的な構造の両方を考慮してください。');
      lines.push('');
      if (categorized.short_term.length) {
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('【短期・鮮度重視】直近数日〜1週間の動き');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
        const items = (view === 'full' ? categorized.short_term : categorized.short_term.slice(0, 2)).map((p: any, i: number) => fmt(p, i));
        lines.push(items.join('\n\n'));
        lines.push('');
      }
      if (categorized.structural.length) {
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('【中期・構造重視】1週間〜1ヶ月の大きな流れ');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
        const items = (view === 'full' ? categorized.structural : categorized.structural.slice(0, 2)).map((p: any, i: number) => fmt(p, i));
        lines.push(items.join('\n\n'));
        lines.push('');
      }
      if (categorized.watchlist.length) {
        lines.push('【要監視】参考情報');
        const items = (view === 'full' ? categorized.watchlist : categorized.watchlist.slice(0, 1)).map((p: any) => `- ${p.type}（完成度${Math.round(p.completion * 100)}%）`);
        lines.push(items.join('\n'));
      }
      if (categorized.invalid.length) {
        lines.push('');
        lines.push('【⚠️ 無効化済み】');
        const items = categorized.invalid.map((p: any) => {
          const comp = Math.round(p.completion * 100);
          const currentPrice = Number.isFinite(p.currentPrice) ? p.currentPrice.toLocaleString() : 'n/a';
          const invalPrice = Number.isFinite(p.invalidationPrice) ? p.invalidationPrice.toLocaleString() : 'n/a';
          const reason = p.status === 'invalid' ? '無効化ライン突破' : '無効化寸前';
          return `- ${p.type}（元の完成度: ${comp}%, ${reason}）\n  現在価格: ¥${currentPrice}、無効化ライン: ¥${invalPrice}`;
        });
        lines.push(items.join('\n'));
      }
      if (relationships.length) {
        const rel = relationships[0];
        lines.push('');
        lines.push('【パターン間の関係（要点）】');
        const note = rel?.conflict === 'directional'
          ? '短期は反発サイン、中期は天井サイン → 調整局面の可能性'
          : (rel?.overlap ? '期間が重複しており、相互に影響する可能性' : '関係なし');
        lines.push(`- ${rel.pattern1} × ${rel.pattern2}: ${note}`);
      }
    } else {
      const formingBlock = (view === 'full' ? sortedEnriched : sortedEnriched.slice(0, 5)).map((p, i) => fmt(p, i)).join('\n\n');
      lines.push(formingBlock);
    }
    // attach history brief lines
    const histBrief = sortedEnriched.map((p: any) => {
      const hc = p?.historicalCases;
      if (!hc) return null;
      return `   ↳ 過去${historyDays}日: 件数${hc.count} 成功率${(hc.successRate * 100).toFixed(0)}% 平均変動${hc.avgBreakoutMove >= 0 ? '+' : ''}${hc.avgBreakoutMove}%`;
    }).filter(Boolean).join('\n');
    if (histBrief) lines.push(histBrief);
  } else {
    lines.push('該当なし');
  }
  lines.push('');
  lines.push('【🟡 重要: 長期視点】');
  const weekLines = ltWeek.items.slice(0, 3).map((p: any) => `- 週足 ${p.type}（ネックライン${p?.neckline?.[1]?.y != null ? Math.round(p.neckline[1].y).toLocaleString() : 'n/a'}円）`).join('\n');
  const monthLines = ltMonth.items.slice(0, 3).map((p: any) => `- 月足 ${p.type}（ネックライン${p?.neckline?.[1]?.y != null ? Math.round(p.neckline[1].y).toLocaleString() : 'n/a'}円）`).join('\n');
  lines.push(weekLines || '- 該当なし');
  lines.push(monthLines || '- 該当なし');
  lines.push('');
  lines.push(`【🟢 参考: 最近完成（${Math.round(maxCompletedBars * (daysPerBar(String(type)) || 1))}日以内）】`);
  {
    const comp = (grouped as any)?.completedSummary || { active: [], invalidated: [], expired: [] };
    const fmtArr = (arr: any[], tag: 'active' | 'invalidated' | 'expired') => {
      if (!arr?.length) return '- 該当なし';
      return arr.slice(0, 5).map((p: any) => {
        const date = String(p?.breakoutDate || '').slice(0, 10) || 'n/a';
        const ret = (typeof p?.returnPct === 'number') ? `${p.returnPct >= 0 ? '+' : ''}${p.returnPct.toFixed(2)}%` : 'n/a';
        const neck = Number.isFinite(p?.neckline) ? Math.round(Number(p.neckline)).toLocaleString() : 'n/a';
        const nowPx = Number.isFinite(p?.currentPrice) ? Math.round(Number(p.currentPrice)).toLocaleString() : 'n/a';
        const base = (tag === 'active')
          ? `- ${p.pattern}（${date} 完成, ${ret}）`
          : (tag === 'invalidated'
            ? `- ${p.pattern}（${date} 完成 → ❌無効化, 理由: ${p?.invalidationReason || 'unknown'} / NL: ${neck}円 / 現在: ${nowPx}円）`
            : `- ${p.pattern}（${date} 完成 → 期限切れ, ${ret} / NL: ${neck}円）`);
        // 追加詳細（view=detailed/full のみ）
        if (view === 'detailed' || view === 'full') {
          const piv: Array<{ idx: number; price: number }> = Array.isArray(p?.pivots) ? p.pivots : [];
          const val = (i?: number) => (Number.isFinite(i as any) && piv[i as number]) ? Math.round(Number(piv[i as number].price)).toLocaleString() : 'n/a';
          if (p?.pattern === 'head_and_shoulders' || p?.pattern === 'inverse_head_and_shoulders') {
            const ls = val(0), hd = val(2), rs = val(4);
            return [
              base,
              `   ・左肩: ${ls}円`,
              `   ・頭: ${hd}円`,
              `   ・右肩: ${rs}円`,
              `   ・ネックライン: ${neck}円`,
            ].join('\n');
          }
          if (p?.pattern === 'double_top' || p?.pattern === 'double_bottom') {
            const a = val(0), c = val(2);
            const label = p?.pattern === 'double_top' ? ['第1天井', '第2天井'] : ['第1底', '第2底'];
            return [
              base,
              `   ・${label[0]}: ${a}円`,
              `   ・${label[1]}: ${c}円`,
              `   ・ネックライン: ${neck}円`,
            ].join('\n');
          }
        }
        return base;
      });
    };
    lines.push('【✅ 有効なブレイク】');
    {
      const block = fmtArr(comp.active, 'active');
      if (Array.isArray(block)) lines.push(...block);
      else lines.push(block);
    }
    lines.push('');
    lines.push('【❌ 無効化されたパターン】');
    {
      const block = fmtArr(comp.invalidated, 'invalidated');
      if (Array.isArray(block)) lines.push(...block);
      else lines.push(block);
    }
    lines.push('');
    lines.push('【⚠️ 期限切れ】');
    {
      const block = fmtArr(comp.expired, 'expired');
      if (Array.isArray(block)) lines.push(...block);
      else lines.push(block);
    }
  }
  if (view === 'full') {
    // optional archive (older than 7 days) count only
    try {
      const out: any = await detectPatterns(pair, type as any, Math.max(limit * 3, 120));
      const pats: any[] = Array.isArray(out?.data?.patterns) ? out.data.patterns : [];
      const now = Date.now();
      const older = pats.filter(p => {
        const t = Date.parse(p?.range?.end || '');
        return Number.isFinite(t) && (now - t) > 7 * 86400000;
      }).length;
      lines.push('');
      lines.push('【⚪ アーカイブ】');
      lines.push(`- 7日超過の完成済みパターン: ${older}件（省略）`);
    } catch { /* ignore */ }
  }
  lines.push(tail);
  const text = lines.join('\n');
  const context = {
    hasMultipleTimeframes: hasDifferentCategories,
    categories: {
      short_term: categorized.short_term.map((p: any) => ({ type: p.type, completion: p.completion, context: p.context })),
      structural: categorized.structural.map((p: any) => ({ type: p.type, completion: p.completion, context: p.context })),
      watchlist: categorized.watchlist.map((p: any) => ({ type: p.type, completion: p.completion, context: p.context })),
    },
    relationships,
  };
  return ok(text, { patterns: sortedEnriched, grouped, context, meta: { pair: pairNorm, type, count: enriched.length } }, createMeta(pairNorm, { type })) as any;
}