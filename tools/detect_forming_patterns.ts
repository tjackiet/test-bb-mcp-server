import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta } from '../lib/validate.js';
import type { Pair } from '../src/types/domain.d.ts';
import detectPatterns from './detect_patterns.js';

type View = 'summary' | 'detailed' | 'full' | 'debug';

export default async function detectFormingPatterns(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 40,
  opts: Partial<{ patterns: string[]; minCompletion: number; view: View; pivotConfirmBars: number; rightPeakTolerancePct: number }> = {}
) {
  try {
    const want = new Set(opts.patterns || ['double_top', 'double_bottom', 'head_and_shoulders', 'inverse_head_and_shoulders', 'triple_top', 'triple_bottom', 'triangle_descending']);
    const minCompletion = Math.max(0, Math.min(1, opts.minCompletion ?? 0.4));
    const view: View = (opts.view as View) || 'detailed';
    const pivotConfirmBars = Math.max(1, Math.min(20, Math.floor(opts.pivotConfirmBars ?? 3)));
    const rightPeakTolerancePct = Math.max(0.05, Math.min(0.5, Number(opts.rightPeakTolerancePct ?? 0.2))); // 5% - 50%

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
    const MAX_COVERAGE = 0.70;
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
      if (isPeak) peaks.push({ idx, price: p.high });
      if (isValley) valleys.push({ idx, price: p.low });
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

    // forming double_bottom: inverse
    if (want.has('double_bottom') && lastPeak && lastValley && lastPeak.idx > lastValley.idx && isPivotConfirmed(lastPeak.idx, lastIdx) && isPivotConfirmed(lastValley.idx, lastIdx)) {
      const leftValley = lastValley;
      const peak = lastPeak; // interim peak
      const currentPrice = priceAt(lastIdx);
      const leftPct = currentPrice / Math.max(1, leftValley.price);
      if (leftPct >= (1 - rightPeakTolerancePct) && leftPct <= (1 + rightPeakTolerancePct) && currentPrice < peak.price) {
        const ratio = (peak.price - currentPrice) / Math.max(1e-12, peak.price - leftValley.price);
        let progress = Math.max(0, Math.min(1, ratio));
        if (!last3Down()) progress = Math.min(1, progress + 0.2); // 上昇転換の兆候（直近陰線でなければ加点）
        const completion = Math.min(1, 0.66 + progress * 0.34);
        if (completion >= minCompletion) {
          const neckline = [{ x: leftValley.idx, y: peak.price }, { x: lastIdx, y: peak.price }];
          const start = isoAt(leftValley.idx);
          const cur = isoAt(lastIdx);
          const confBase = Math.min(1, Math.max(0, (1 - Math.abs(leftPct - 1)) * 0.6 + progress * 0.4));
          const confidence = Math.round(confBase * 100) / 100;
          const formationBars = Math.max(0, lastIdx - leftValley.idx);
          const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
          const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
          if (patternDays < getMinPatternDays('double_bottom')) {
            // skip too short pattern
          } else {
            const scale_validation = buildScaleValidation(formationBars);
            patterns.push({
              type: 'double_bottom',
              completion: Number((completion).toFixed(2)),
              confidence,
              status: 'forming',
              range: { start, current: cur },
              candleType: type,
              formationPeriod: formation,
              scale_validation,
              confirmedPivots: [
                { role: 'left_valley', price: leftValley.price, idx: leftValley.idx, isoTime: start, formatted: fmtDate(start) },
                { role: 'peak', price: peak.price, idx: peak.idx, isoTime: isoAt(peak.idx), formatted: fmtDate(isoAt(peak.idx)) },
              ],
              formingPivots: [
                { role: 'right_valley', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
              ],
              neckline,
              scenarios: {
                completion: { priceRange: [Math.round(leftValley.price * 0.98), Math.round(leftValley.price * 1.02)], description: 'この価格帯で反転上昇すればパターン完成' },
                invalidation: { priceLevel: Math.round(leftValley.price * 0.988), description: `${Math.round(leftValley.price * 0.988).toLocaleString()}円を下抜けたらパターン無効` },
              },
              nextSteps: [
                `${Math.round(leftValley.price * 0.995).toLocaleString()}-${Math.round(leftValley.price * 1.005).toLocaleString()}円での反転シグナルを監視`,
                `完成後はネックライン${Math.round(peak.price).toLocaleString()}円の上抜けでロングエントリー検討`,
              ],
            });
          }
        }
      }
    }

    // forming head_and_shoulders: left_shoulder (peak) -> head (higher peak) -> post_head_valley (valley) -> right_shoulder forming near left_shoulder
    if (want.has('head_and_shoulders')) {
      // find latest sequence
      for (let i = 0; i < peaks.length - 1; i++) {
        const left = peaks[i];
        if (!isPivotConfirmed(left.idx, lastIdx)) continue;
        // head after left
        const head = peaks.slice(i + 1).find(p => isPivotConfirmed(p.idx, lastIdx) && p.price > left.price * 1.05);
        if (!head) continue;
        // valley after head
        const postValley = valleys.find(v => v.idx > head.idx && isPivotConfirmed(v.idx, lastIdx));
        if (!postValley) continue;
        const currentPrice = priceAt(lastIdx);
        const nearLeft = currentPrice / Math.max(1, left.price);
        if (nearLeft < (1 - rightPeakTolerancePct) || nearLeft > (1 + rightPeakTolerancePct)) continue;
        // price should be between post-head valley and below head
        if (!(currentPrice > postValley.price && currentPrice < head.price)) continue;
        // right shoulder progress by closeness to left shoulder
        let closeness = 1 - Math.abs(currentPrice - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct);
        closeness = Math.max(0, Math.min(1, closeness));
        let progress = closeness;
        if (last3Down()) progress = Math.min(1, progress + 0.2);
        const completion = Math.min(1, 0.75 + 0.25 * progress);
        if (completion >= minCompletion) {
          // neckline: between valley before head and post-head valley (fallback: horizontal at post-head valley)
          const preValley = valleys.find(v => v.idx > left.idx && v.idx < head.idx);
          const nlA = preValley ? { x: preValley.idx, y: preValley.price } : { x: left.idx, y: postValley.price };
          const nlB = { x: lastIdx, y: postValley.price };
          const start = isoAt(left.idx);
          const cur = isoAt(lastIdx);
          const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
          const confidence = Math.round(confBase * 100) / 100;
          const formationBars = Math.max(0, lastIdx - left.idx);
          const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
          const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
          if (patternDays < getMinPatternDays('head_and_shoulders')) {
            // skip too short pattern
          } else {
            const scale_validation = buildScaleValidation(formationBars);
            patterns.push({
              type: 'head_and_shoulders',
              completion: Number(completion.toFixed(2)),
              confidence,
              status: 'forming',
              range: { start, current: cur },
              candleType: type,
              formationPeriod: formation,
              scale_validation,
              confirmedPivots: [
                { role: 'left_shoulder', price: left.price, idx: left.idx, isoTime: start, formatted: fmtDate(start) },
                { role: 'head', price: head.price, idx: head.idx, isoTime: isoAt(head.idx), formatted: fmtDate(isoAt(head.idx)) },
                { role: 'post_head_valley', price: postValley.price, idx: postValley.idx, isoTime: isoAt(postValley.idx), formatted: fmtDate(isoAt(postValley.idx)) },
              ],
              formingPivots: [
                { role: 'right_shoulder', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
              ],
              neckline: [nlA, nlB],
              scenarios: {
                completion: { priceRange: [Math.round(left.price * 0.98), Math.round(left.price * 1.02)], description: 'この価格帯で反転下落すればパターン完成' },
                invalidation: { priceLevel: Math.round(head.price * 1.012), description: `${Math.round(head.price * 1.012).toLocaleString()}円を上抜けたらパターン無効` },
              },
              nextSteps: [
                `${Math.round(left.price * 0.997).toLocaleString()}-${Math.round(left.price * 1.005).toLocaleString()}円での反転シグナルを監視`,
                `完成後はネックライン${Math.round(postValley.price).toLocaleString()}円の下抜けを監視`,
              ],
            });
            break; // take the latest one
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

    // forming inverse_head_and_shoulders: left_shoulder (valley) -> head (lower valley) -> post_head_peak (peak) -> right_shoulder forming near left_shoulder
    if (want.has('inverse_head_and_shoulders')) {
      for (let i = 0; i < valleys.length - 1; i++) {
        const left = valleys[i];
        if (!isPivotConfirmed(left.idx, lastIdx)) continue;
        // head: deeper valley after left
        const head = valleys.slice(i + 1).find(v => isPivotConfirmed(v.idx, lastIdx) && v.price < left.price * (1 - 0.05));
        if (!head) continue;
        // peak after head
        const postPeak = peaks.find(p => p.idx > head.idx && isPivotConfirmed(p.idx, lastIdx));
        if (!postPeak) continue;
        const currentPrice = priceAt(lastIdx);
        const nearLeft = currentPrice / Math.max(1, left.price);
        if (nearLeft < (1 - rightPeakTolerancePct) || nearLeft > (1 + rightPeakTolerancePct)) continue;
        // price between head (lower) and post-peak (upper)
        if (!(currentPrice < postPeak.price && currentPrice > head.price)) continue;
        let closeness = 1 - Math.abs(currentPrice - left.price) / Math.max(1e-12, left.price * rightPeakTolerancePct);
        closeness = Math.max(0, Math.min(1, closeness));
        let progress = closeness;
        if (!last3Down()) progress = Math.min(1, progress + 0.2);
        const completion = Math.min(1, 0.75 + 0.25 * progress);
        if (completion >= minCompletion) {
          const prePeak = peaks.find(p => p.idx > left.idx && p.idx < head.idx);
          const nlA = prePeak ? { x: prePeak.idx, y: prePeak.price } : { x: left.idx, y: postPeak.price };
          const nlB = { x: lastIdx, y: postPeak.price };
          const start = isoAt(left.idx);
          const cur = isoAt(lastIdx);
          const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
          const confidence = Math.round(confBase * 100) / 100;
          const formationBars = Math.max(0, lastIdx - left.idx);
          const formation = { bars: formationBars, formatted: formatPeriod(formationBars, type), start: start, current: cur };
          const patternDays = Math.round(formationBars * daysPerBarCalc(String(type)));
          if (patternDays < getMinPatternDays('inverse_head_and_shoulders')) {
            // skip too short pattern
          } else {
            const scale_validation = buildScaleValidation(formationBars);
            patterns.push({
              type: 'inverse_head_and_shoulders',
              completion: Number(completion.toFixed(2)),
              confidence,
              status: 'forming',
              range: { start, current: cur },
              candleType: type,
              formationPeriod: formation,
              scale_validation,
              confirmedPivots: [
                { role: 'left_shoulder', price: left.price, idx: left.idx, isoTime: start, formatted: fmtDate(start) },
                { role: 'head', price: head.price, idx: head.idx, isoTime: isoAt(head.idx), formatted: fmtDate(isoAt(head.idx)) },
                { role: 'post_head_peak', price: postPeak.price, idx: postPeak.idx, isoTime: isoAt(postPeak.idx), formatted: fmtDate(isoAt(postPeak.idx)) },
              ],
              formingPivots: [
                { role: 'right_shoulder', price: currentPrice, idx: lastIdx, progress: Number(progress.toFixed(2)), isoTime: cur, formatted: fmtDate(cur) },
              ],
              neckline: [nlA, nlB],
              scenarios: {
                completion: { priceRange: [Math.round(left.price * 0.98), Math.round(left.price * 1.02)], description: 'この価格帯で反転上昇すればパターン完成' },
                invalidation: { priceLevel: Math.round(head.price * 0.988), description: `${Math.round(head.price * 0.988).toLocaleString()}円を下抜けたらパターン無効` },
              },
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

    const filtered = patterns.filter(p => p.completion >= minCompletion);
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
    const [ltWeek, ltMonth, recentCompleted] = await Promise.all([
      detectLongTermCurrentInvolved('1week'),
      detectLongTermCurrentInvolved('1month'),
      // recently completed on current timeframe (within 7 days)
      (async () => {
        try {
          const out: any = await detectPatterns(pair, type as any, Math.max(limit * 3, 120), { requireCurrentInPattern: true, currentRelevanceDays: 7 });
          if (!out?.ok) return [] as any[];
          return Array.isArray(out?.data?.patterns) ? out.data.patterns : [];
        } catch { return [] as any[]; }
      })(),
    ]);

    // content formatting
    if (view === 'debug') {
      const last5 = candles.slice(-5).map(c => Math.round(c.close).toLocaleString());
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

      const text = [
        `${String(pair).toUpperCase()} [${String(type)}] ${limit}本の分析`,
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
        '【検出されたパターン】',
        `${filtered.length}件（minCompletion=${minCompletion} を満たすパターン${filtered.length ? '' : 'なし'}）`,
      ].join('\n');
      return ok(text, { patterns: filtered, meta: { pair: pairNorm, type, count: filtered.length, peaks: peaks.length, valleys: valleys.length } }, createMeta(pairNorm, { type, debug: true })) as any;
    }

    if (view === 'summary') {
      const text = [
        `${summary}（${typeSummary || '分類なし'}）`,
        '',
        '【🔴 最重要: 現在進行形】',
        enriched.length ? enriched.map((p: any) => {
          const hc = p?.historicalCases;
          const hcLine = hc ? ` 過去${historyDays}日: 件数${hc.count} 成功率${(hc.successRate * 100).toFixed(0)}% 平均変動${hc.avgBreakoutMove >= 0 ? '+' : ''}${hc.avgBreakoutMove}%` : '';
          return `- ${p.type}（完成度${Math.round(p.completion * 100)}%）${hcLine}`;
        }).join('\n') : '該当なし',
        '',
        '【🟡 重要: 長期視点】',
        `週足: ${ltWeek.items.length ? ltWeek.items.map((p: any) => `${p.type}（ネックライン${p?.neckline?.[1]?.y != null ? Math.round(p.neckline[1].y).toLocaleString() : 'n/a'}円）`).slice(0, 3).join(' / ') : '該当なし'}`,
        `月足: ${ltMonth.items.length ? ltMonth.items.map((p: any) => `${p.type}（ネックライン${p?.neckline?.[1]?.y != null ? Math.round(p.neckline[1].y).toLocaleString() : 'n/a'}円）`).slice(0, 3).join(' / ') : '該当なし'}`,
        '',
        '【🟢 参考: 最近完成（7日以内）】',
        recentCompleted.length ? recentCompleted.slice(0, 3).map((p: any) => {
          const r7 = p?.aftermath?.priceMove?.days7?.return;
          return `- ${p.type}（${p.range?.end?.slice(0, 10)} 完成, ${typeof r7 === 'number' ? (r7 >= 0 ? '+' : '') + r7.toFixed(2) + '%' : 'n/a'}）`;
        }).join('\n') : '該当なし',
      ].join('\n');
      return ok(text, { patterns: enriched, meta: { pair: pairNorm, type, count: enriched.length } }, createMeta(pairNorm, { type })) as any;
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
      const left = p.confirmedPivots?.[0];
      const valleyOrPeak = p.confirmedPivots?.[1];
      const afterHead = p.confirmedPivots?.[2];
      const forming = p.formingPivots?.[0];
      const nl = Array.isArray(p.neckline) && p.neckline.length === 2 ? p.neckline : null;
      const nlStr = nl ? (nl[0].y === nl[1].y ? `${Math.round(nl[0].y).toLocaleString()}円（水平）` : `${Math.round(nl[0].y).toLocaleString()}円 → ${Math.round(nl[1].y).toLocaleString()}円`) : 'n/a';
      const periodBars = Math.max(0, (forming?.idx ?? lastIdx) - (left?.idx ?? 0));
      const periodFmt = formatPeriod(periodBars, type);
      const startFmt = fmtDate(left?.isoTime);
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
      const lines = [
        `${i + 1}. 【${tfLabel}・${periodFmt}】${p.type} (完成度: ${Math.round(p.completion * 100)}%, 信頼度: ${p.confidence?.toFixed(2) ?? 'n/a'})`,
        `   - 形成開始: ${startFmt}`,
        `   - カバレッジ: ${covPctStr} ${scaleOk ? '✅' : '⚠️'}`,
        left ? `   - ${leftLabel}: ${Math.round(left.price).toLocaleString()}円（${fmtDate(left.isoTime)}確定）` : null,
        valleyOrPeak ? `   - ${midLabel}: ${Math.round(valleyOrPeak.price).toLocaleString()}円（${fmtDate(valleyOrPeak.isoTime)}確定）` : null,
        (thirdLabel && afterHead) ? `   - ${thirdLabel}: ${Math.round(afterHead.price).toLocaleString()}円（${fmtDate(afterHead.isoTime)}確定）` : null,
        forming ? `   - ${rightLabel}: 形成中 ${Math.round(forming.price).toLocaleString()}円（${formingFmt}）` : null,
        `   - 推定ネックライン: ${nlStr}`,
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
    const tail = "\n\n形成中パターンについて:\n  完成度60%以上 = 形成が進んでいる\n  完成度40-60% = 初期段階（不確実）\n  信頼度は完成後の予想信頼度";

    // Priority-structured content (detailed/full)
    const lines: string[] = [];
    lines.push(summary);
    lines.push('');
    lines.push('【🔴 最重要: 現在進行形】');
    if (enriched.length) {
      const formingBlock = (view === 'full' ? enriched : enriched.slice(0, 5)).map((p, i) => fmt(p, i)).join('\n\n');
      lines.push(formingBlock);
      // attach history brief lines
      const histBrief = enriched.map((p: any) => {
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
    lines.push('【🟢 参考: 最近完成（7日以内）】');
    if (recentCompleted.length) {
      lines.push(...recentCompleted.slice(0, 5).map((p: any) => {
        const r7 = p?.aftermath?.priceMove?.days7?.return;
        const tgt = p?.aftermath?.targetReached ? `, 目標到達${p?.aftermath?.daysToTarget != null ? `(${p.aftermath.daysToTarget}本)` : ''}` : '';
        return `- ${p.type}（${p.range?.end?.slice(0, 10)} 完成, ${typeof r7 === 'number' ? (r7 >= 0 ? '+' : '') + r7.toFixed(2) + '%' : 'n/a'}${tgt}）`;
      }));
    } else {
      lines.push('- 該当なし');
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
    return ok(text, { patterns: enriched, meta: { pair: pairNorm, type, count: enriched.length } }, createMeta(pairNorm, { type })) as any;
  } catch (e: any) {
    return fail(e?.message || 'internal error', 'internal') as any;
  }
}


