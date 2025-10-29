import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta } from '../lib/validate.js';

type View = 'summary' | 'detailed' | 'full' | 'debug';

export default async function detectFormingPatterns(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 40,
  opts: Partial<{ patterns: string[]; minCompletion: number; view: View; pivotConfirmBars: number; rightPeakTolerancePct: number }> = {}
) {
  try {
    const want = new Set(opts.patterns || ['double_top', 'double_bottom', 'head_and_shoulders', 'inverse_head_and_shoulders']);
    const minCompletion = Math.max(0, Math.min(1, opts.minCompletion ?? 0.4));
    const view: View = (opts.view as View) || 'detailed';
    const pivotConfirmBars = Math.max(1, Math.min(20, Math.floor(opts.pivotConfirmBars ?? 3)));
    const rightPeakTolerancePct = Math.max(0.05, Math.min(0.5, Number(opts.rightPeakTolerancePct ?? 0.2))); // 5% - 50%

    const res = await getIndicators(pair, type as any, limit);
    if (!res?.ok) return fail(res.summary || 'failed', (res.meta as any)?.errorType || 'internal') as any;

    const candles: Array<{ open: number; high: number; low: number; close: number; isoTime?: string }>
      = res.data.chart.candles as any[];
    if (!Array.isArray(candles) || candles.length < 20)
      return ok('insufficient data', { patterns: [] }, createMeta(pair, { type, count: 0 })) as any;

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
          patterns.push({
            type: 'double_top',
            completion: Number((completion).toFixed(2)),
            confidence,
            status: 'forming',
            range: { start, current: cur },
            candleType: type,
            formationPeriod: formation,
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
          patterns.push({
            type: 'double_bottom',
            completion: Number((completion).toFixed(2)),
            confidence,
            status: 'forming',
            range: { start, current: cur },
            candleType: type,
            formationPeriod: formation,
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
          patterns.push({
            type: 'head_and_shoulders',
            completion: Number(completion.toFixed(2)),
            confidence,
            status: 'forming',
            range: { start, current: cur },
            candleType: type,
            formationPeriod: formation,
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
          patterns.push({
            type: 'inverse_head_and_shoulders',
            completion: Number(completion.toFixed(2)),
            confidence,
            status: 'forming',
            range: { start, current: cur },
            candleType: type,
            formationPeriod: formation,
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

    const filtered = patterns.filter(p => p.completion >= minCompletion);
    const summary = `${String(pair).toUpperCase()} [${String(type)}] ${limit}本から${filtered.length}件の形成中パターンを検出`;
    const byType: Record<string, number> = filtered.reduce((m: any, p: any) => { m[p.type] = (m[p.type] || 0) + 1; return m; }, {});
    const typeSummary = Object.entries(byType).map(([k, v]) => `${k}×${v}${v > 0 ? '' : ''}`).join(', ');

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
      return ok(text, { patterns: filtered, meta: { pair, type, count: filtered.length, peaks: peaks.length, valleys: valleys.length } }, createMeta(pair, { type, debug: true })) as any;
    }

    if (view === 'summary') {
      const text = `${summary}（${typeSummary || '分類なし'}）\n詳細は structuredContent.data.patterns を参照。`;
      return ok(text, { patterns: filtered, meta: { pair, type, count: filtered.length } }, createMeta(pair, { type })) as any;
    }

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
      const lines = [
        `${i + 1}. 【${tfLabel}・${periodFmt}】${p.type} (完成度: ${Math.round(p.completion * 100)}%, 信頼度: ${p.confidence?.toFixed(2) ?? 'n/a'})`,
        `   - 形成開始: ${startFmt}`,
        left ? `   - ${leftLabel}: ${Math.round(left.price).toLocaleString()}円（${fmtDate(left.isoTime)}確定）` : null,
        valleyOrPeak ? `   - ${midLabel}: ${Math.round(valleyOrPeak.price).toLocaleString()}円（${fmtDate(valleyOrPeak.isoTime)}確定）` : null,
        (thirdLabel && afterHead) ? `   - ${thirdLabel}: ${Math.round(afterHead.price).toLocaleString()}円（${fmtDate(afterHead.isoTime)}確定）` : null,
        forming ? `   - ${rightLabel}: 形成中 ${Math.round(forming.price).toLocaleString()}円（${formingFmt}）` : null,
        `   - 推定ネックライン: ${nlStr}`,
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

    const list = (view === 'full' ? filtered : filtered.slice(0, 5)).map(fmt).join('\n\n');
    const tail = "\n\n形成中パターンについて:\n  完成度60%以上 = 形成が進んでいる\n  完成度40-60% = 初期段階（不確実）\n  信頼度は完成後の予想信頼度";
    const text = `${summary}\n\n${filtered.length ? '【形成中パターン】\n' + list + tail : '該当なし（minCompletion=' + minCompletion + '）'}`;
    return ok(text, { patterns: filtered, meta: { pair, type, count: filtered.length } }, createMeta(pair, { type })) as any;
  } catch (e: any) {
    return fail(e?.message || 'internal error', 'internal') as any;
  }
}


