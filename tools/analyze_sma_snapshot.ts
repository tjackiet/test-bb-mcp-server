import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { AnalyzeSmaSnapshotOutputSchema } from '../src/schemas.js';

export default async function analyzeSmaSnapshot(
  pair: string = 'btc_jpy',
  type: string = '1day',
  limit: number = 220,
  periods: number[] = [25, 75, 200]
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return AnalyzeSmaSnapshotOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;
  try {
    const indRes: any = await getIndicators(chk.pair, type as any, Math.max(Math.max(...periods, 200), limit));
    if (!indRes?.ok) return AnalyzeSmaSnapshotOutputSchema.parse(fail(indRes?.summary || 'indicators failed', (indRes?.meta as any)?.errorType || 'internal')) as any;

    const close = indRes.data.normalized.at(-1)?.close ?? null;
    const map: Record<string, number | null> = {};
    const get = (p: number) => (indRes.data.indicators as any)[`SMA_${p}`] ?? null;
    for (const p of periods) map[`SMA_${p}`] = get(p);

    // Crosses between near pairs (e.g., 25 vs 75, 75 vs 200)
    const crosses: Array<{ a: string; b: string; type: 'golden' | 'dead'; delta: number }> = [];
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < periods.length - 1; i++) pairs.push([periods[i], periods[i + 1]]);
    for (const [a, b] of pairs) {
      const va = map[`SMA_${a}`];
      const vb = map[`SMA_${b}`];
      if (va != null && vb != null) {
        const delta = (va as number) - (vb as number);
        crosses.push({ a: `SMA_${a}`, b: `SMA_${b}`, type: delta >= 0 ? 'golden' : 'dead', delta: Number(delta.toFixed(2)) });
      }
    }

    let alignment: 'bullish' | 'bearish' | 'mixed' | 'unknown' = 'unknown';
    const v25 = map['SMA_25'];
    const v75 = map['SMA_75'];
    const v200 = map['SMA_200'];
    if (v25 != null && v75 != null && v200 != null) {
      if (v25 > v75 && v75 > v200) alignment = 'bullish';
      else if (v25 < v75 && v75 < v200) alignment = 'bearish';
      else alignment = 'mixed';
    }

    const tags: string[] = [];
    if (alignment === 'bullish') tags.push('sma_bullish_alignment');
    if (alignment === 'bearish') tags.push('sma_bearish_alignment');

    const summary = formatSummary({ pair: chk.pair, latest: close ?? undefined, extra: `align=${alignment}` });
    const data = { latest: { close }, sma: map, crosses, alignment, tags };
    const meta = createMeta(chk.pair, { type, count: indRes.data.normalized.length, periods });
    return AnalyzeSmaSnapshotOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: any) {
    return AnalyzeSmaSnapshotOutputSchema.parse(fail(e?.message || 'internal error', 'internal')) as any;
  }
}


