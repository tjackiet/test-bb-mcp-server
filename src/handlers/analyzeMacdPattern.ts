import analyzeIndicators from '../../tools/analyze_indicators.js';
import { ok, fail } from '../../lib/result.js';
import { formatSummary } from '../../lib/formatter.js';
import { getErrorMessage } from '../../lib/error.js';

type AnalyzeInput = {
  pair: string;
  historyDays?: number; // default 90
  performanceWindows?: number[]; // default [1,3,5,10]
  minHistogramForForming?: number; // default 0.3
};

type CrossPerf = { date: string | null; histogram: number | null; performance: Record<string, number | null> };

export default async function analyzeMacdPattern({
  pair,
  historyDays = 90,
  performanceWindows = [1, 3, 5, 10],
  minHistogramForForming = 0.3,
}: AnalyzeInput) {
  try {
    const limit = Math.max(120, historyDays + 40);
    const ind: any = await analyzeIndicators(pair, '1day', limit);
    if (!ind?.ok) return fail(ind?.summary || 'indicators failed', (ind?.meta as any)?.errorType || 'internal');

    const macd = ind?.data?.indicators?.macd_series?.line || [];
    const signal = ind?.data?.indicators?.macd_series?.signal || [];
    const hist = ind?.data?.indicators?.macd_series?.hist || [];
    const candles: Array<{ isoTime?: string; close?: number }> = Array.isArray(ind?.data?.normalized) ? ind.data.normalized : [];
    const n = Math.min(macd.length, signal.length, hist.length, candles.length);
    if (n < 20) return fail('insufficient data', 'user');

    const nowIdx = n - 1;
    const lastClose = candles[nowIdx]?.close ?? null;

    // 1) forming detection（優先）
    const win = Math.min(5, n - 1);
    const hNow = hist[nowIdx] as number | null;
    const hPrev = hist[nowIdx - win] as number | null;
    let completion: number | null = null;
    let estimatedCrossDays: number | null = null;
    let status: 'forming_golden' | 'forming_dead' | 'neutral' | 'crossed_recently' = 'neutral';
    const histogramTrend: Array<number | null> = [];
    for (let i = nowIdx - win + 1; i <= nowIdx; i++) histogramTrend.push(hist[i] == null ? null : Number((hist[i] as number).toFixed(4)));

    if (hNow != null && hPrev != null && Math.abs(hPrev) > 0) {
      const slopePerBar = (hNow - hPrev) / win; // toward 0 if opposite sign of hPrev
      const movingTowardZero = (hPrev > 0 && slopePerBar < 0) || (hPrev < 0 && slopePerBar > 0);
      const notCrossedYet = (hPrev < 0 && hNow < 0) || (hPrev > 0 && hNow > 0);
      if (movingTowardZero && notCrossedYet && Math.abs(hNow) <= minHistogramForForming * 5) {
        completion = Number((1 - Math.min(1, Math.abs(hNow) / Math.abs(hPrev))).toFixed(2));
        const speed = Math.abs(slopePerBar);
        estimatedCrossDays = speed > 0 ? Number((Math.abs(hNow) / speed).toFixed(1)) : null;
        status = hPrev < 0 ? 'forming_golden' : 'forming_dead';
      }
    }

    // 直近クロスは最後に確認（forming優先）。ヒストグラムの符号変化でチェック（直近3本）
    let crossedRecently = false;
    let lastCrossIdx: number | null = null;
    let lastCrossType: 'golden' | 'dead' | null = null;
    for (let i = Math.max(1, nowIdx - 3); i <= nowIdx; i++) {
      const hp = hist[i - 1];
      const hc = hist[i];
      if (hp != null && hc != null) {
        if (hp <= 0 && hc > 0) { crossedRecently = true; lastCrossIdx = i; lastCrossType = 'golden'; break; }
        if (hp >= 0 && hc < 0) { crossedRecently = true; lastCrossIdx = i; lastCrossType = 'dead'; break; }
      }
    }
    if (status !== 'forming_golden' && status !== 'forming_dead' && crossedRecently) status = 'crossed_recently';

    // 2) history analysis within historyDays
    const msCut = Date.now() - historyDays * 86400000;
    const crosses: Array<{ idx: number; type: 'golden' | 'dead'; date: string | null; histogram: number | null; price: number | null }> = [];
    for (let i = 1; i < n; i++) {
      const prevDiff = (macd[i - 1] ?? null) != null && (signal[i - 1] ?? null) != null ? (macd[i - 1] as number) - (signal[i - 1] as number) : null;
      const currDiff = (macd[i] ?? null) != null && (signal[i] ?? null) != null ? (macd[i] as number) - (signal[i] as number) : null;
      if (prevDiff == null || currDiff == null) continue;
      const isGolden = prevDiff <= 0 && currDiff > 0;
      const isDead = prevDiff >= 0 && currDiff < 0;
      if (!isGolden && !isDead) continue;
      const dateStr = candles[i]?.isoTime || null;
      const ts = dateStr ? Date.parse(dateStr) : NaN;
      if (!Number.isFinite(ts) || ts < msCut) continue;
      crosses.push({ idx: i, type: isGolden ? 'golden' : 'dead', date: dateStr, histogram: hist[i] ?? null, price: candles[i]?.close ?? null });
    }

    function performanceFor(idx: number, basePrice: number | null): Record<string, number | null> {
      const perf: Record<string, number | null> = {};
      for (const w of performanceWindows) {
        const j = Math.min(n - 1, idx + w);
        const priceW = candles[j]?.close ?? null;
        perf['day' + String(w)] = basePrice != null && priceW != null ? Number((((priceW - basePrice) / basePrice) * 100).toFixed(2)) : null;
      }
      return perf;
    }

    const goldenCrosses: CrossPerf[] = [];
    const deadCrosses: CrossPerf[] = [];
    for (const c of crosses) {
      const perf = performanceFor(c.idx, c.price ?? null);
      const item: CrossPerf = { date: c.date, histogram: c.histogram == null ? null : Number((c.histogram as number).toFixed(4)), performance: perf };
      if (c.type === 'golden') goldenCrosses.push(item); else deadCrosses.push(item);
    }

    function statsOf(list: CrossPerf[]) {
      const w = performanceWindows.includes(5) ? 5 : performanceWindows[performanceWindows.length - 1];
      const pick = (it: CrossPerf) => it.performance['day' + String(w)];
      const vals = list.map(pick).filter((v): v is number => v != null);
      const avg = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
      const successRate = list.length ? Number(((list.filter(p => (pick(p) ?? -Infinity) > 0).length / list.length) * 100).toFixed(0)) : 0;
      const bestCase = vals.length ? Math.max(...vals) : null;
      const worstCase = vals.length ? Math.min(...vals) : null;
      return { avgDay5Return: avg, successRate, totalSamples: list.length, bestCase, worstCase };
    }

    const forming = {
      status,
      completion,
      estimatedCrossDays,
      currentMACD: macd[nowIdx] ?? null,
      currentSignal: signal[nowIdx] ?? null,
      currentHistogram: hNow ?? null,
      histogramTrend,
    };

    const history = { goldenCrosses, deadCrosses };
    const statistics = { golden: statsOf(goldenCrosses), dead: statsOf(deadCrosses) } as const;

    // Build multi-line content summary with forming details when applicable
    const lines: string[] = [];
    const pairStr = String(pair).toUpperCase();
    lines.push(lastClose != null ? `${pairStr} close=${Number(lastClose).toLocaleString()}円` : pairStr);
    if (status === 'forming_golden' || status === 'forming_dead') {
      const days = estimatedCrossDays != null ? (estimatedCrossDays <= 1.5 ? '1-2日以内' : `${Math.round(estimatedCrossDays)}日程度`) : '不明';
      const compStr = completion != null ? `${Math.round((completion || 0) * 100)}%` : 'n/a';
      const crossType = status === 'forming_golden' ? 'ゴールデン' : 'デッド';
      const fmt = (v: any, d = 2) => (v == null ? 'n/a' : Number(v).toFixed(d));
      const estDate = (() => {
        if (estimatedCrossDays == null) return '不明';
        try { return new Date(Date.now() + Math.max(0, Math.round(estimatedCrossDays)) * 86400000).toISOString().slice(0, 10); } catch { return '不明'; }
      })();
      lines.push(`${crossType}クロス形成中: 完成度${compStr}、推定クロス日 ${estDate}（あと${days}）`);
      lines.push(`- ヒストグラム: ${fmt(hNow, 2)} (直近5本: [${histogramTrend.map(v => v == null ? 'n/a' : String(v)).join(', ')}])`);
      lines.push(`- MACD: ${fmt(macd[nowIdx], 2)} / Signal: ${fmt(signal[nowIdx], 2)}`);
    } else if (status === 'crossed_recently') {
      const dateStr = (lastCrossIdx != null ? (candles[lastCrossIdx]?.isoTime || '').slice(0, 10) : '') || '不明';
      const barsAgo = lastCrossIdx != null ? (nowIdx - lastCrossIdx) : null;
      const agoStr = barsAgo != null ? `${barsAgo}日前` : '直近';
      const typ = lastCrossType === 'dead' ? 'デッド' : 'ゴールデン';
      lines.push(`${typ}クロス発生: ${dateStr}（${agoStr}）`);
    } else {
      lines.push('現在クロス形成の兆候なし');
    }
    const gStats = statistics.golden;
    if (gStats.totalSamples > 0) {
      const avgStr = gStats.avgDay5Return != null ? `${gStats.avgDay5Return >= 0 ? '+' : ''}${gStats.avgDay5Return}%` : 'n/a';
      const upCount = goldenCrosses.filter(c => (c.performance.day5 ?? -Infinity) > 0).length;
      const rangeStr = (gStats.worstCase != null && gStats.bestCase != null)
        ? `${gStats.worstCase >= 0 ? '+' : ''}${gStats.worstCase}% 〜 ${gStats.bestCase >= 0 ? '+' : ''}${gStats.bestCase}%`
        : 'n/a';
      lines.push(`過去${historyDays}日: ゴールデンクロス${goldenCrosses.length}回`);
      const upPct = goldenCrosses.length ? Math.round((upCount / goldenCrosses.length) * 100) : 0;
      lines.push(`- クロス後5日間: 平均${avgStr}、上昇した割合 ${upCount}/${goldenCrosses.length}回（${upPct}%）`);
      lines.push(`- 範囲: ${rangeStr}`);
    }
    const dStats = statistics.dead;
    if (dStats.totalSamples > 0) {
      const avgStr = dStats.avgDay5Return != null ? `${dStats.avgDay5Return >= 0 ? '+' : ''}${dStats.avgDay5Return}%` : 'n/a';
      const downCount = deadCrosses.filter(c => (c.performance.day5 ?? Infinity) < 0).length;
      const rangeStr = (dStats.worstCase != null && dStats.bestCase != null)
        ? `${dStats.worstCase >= 0 ? '+' : ''}${dStats.worstCase}% 〜 ${dStats.bestCase >= 0 ? '+' : ''}${dStats.bestCase}%`
        : 'n/a';
      lines.push(`デッドクロス${deadCrosses.length}回`);
      const downPct = deadCrosses.length ? Math.round((downCount / deadCrosses.length) * 100) : 0;
      lines.push(`- クロス後5日間: 平均${avgStr}、下落した割合 ${downCount}/${deadCrosses.length}回（${downPct}%）`);
      lines.push(`- 範囲: ${rangeStr}`);
    }

    const summary = lines.join('\n');
    return ok(summary, { forming, history, statistics }, { pair, historyDays, performanceWindows, minHistogramForForming });
  } catch (e: unknown) {
    return fail(getErrorMessage(e) || 'internal error', 'internal');
  }
}


