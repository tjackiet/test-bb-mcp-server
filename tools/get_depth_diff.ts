import getDepth from './get_depth.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary } from '../lib/formatter.js';
import { getErrorMessage } from '../lib/error.js';
import { GetDepthDiffOutputSchema } from '../src/schemas.js';

type SideLevels = Array<[string, string]>; // [price, size]

function toMap(levels: SideLevels, maxLevels: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const [p, s] of levels.slice(0, maxLevels)) {
    const price = Number(p);
    const size = Number(s);
    if (Number.isFinite(price) && Number.isFinite(size)) m.set(price, size);
  }
  return m;
}

function diffMaps(prev: Map<number, number>, curr: Map<number, number>) {
  const added: Array<{ price: number; size: number }> = [];
  const removed: Array<{ price: number; size: number }> = [];
  const changed: Array<{ price: number; delta: number; from: number | null; to: number | null }> = [];
  for (const [price, size] of curr) {
    if (!prev.has(price)) added.push({ price, size });
    else {
      const before = prev.get(price)!;
      const delta = Number((size - before).toFixed(8));
      if (delta !== 0) changed.push({ price, delta, from: before, to: size });
    }
  }
  for (const [price, size] of prev) {
    if (!curr.has(price)) removed.push({ price, size });
  }
  const netDelta = Number([...changed].reduce((s, c) => s + c.delta, 0) + added.reduce((s, a) => s + a.size, 0) - removed.reduce((s, r) => s + r.size, 0));
  return { added, removed, changed, netDelta };
}

// Deprecated: retained temporarily for reference; not exported/registered
export default async function getDepthDiff(pair: string = 'btc_jpy', delayMs: number = 1000, maxLevels: number = 200) {
  const chk = ensurePair(pair);
  if (!chk.ok) return GetDepthDiffOutputSchema.parse(fail(chk.error.message, chk.error.type)) as any;

  try {
    const a: any = await getDepth(chk.pair, { maxLevels });
    if (!a?.ok) return GetDepthDiffOutputSchema.parse(fail(a?.summary || 'failed', (a?.meta as any)?.errorType || 'internal')) as any;
    await new Promise((r) => setTimeout(r, Math.max(100, delayMs)));
    const b: any = await getDepth(chk.pair, { maxLevels });
    if (!b?.ok) return GetDepthDiffOutputSchema.parse(fail(b?.summary || 'failed', (b?.meta as any)?.errorType || 'internal')) as any;

    // sequenceId/timestamp をメタに残す
    const prevTs = Number(a.data.timestamp);
    const currTs = Number(b.data.timestamp);
    const prevSeq = (a.data as any).sequenceId ?? null;
    const currSeq = (b.data as any).sequenceId ?? null;

    const prevAsks = toMap(a.data.asks as SideLevels, maxLevels);
    const prevBids = toMap(a.data.bids as SideLevels, maxLevels);
    const currAsks = toMap(b.data.asks as SideLevels, maxLevels);
    const currBids = toMap(b.data.bids as SideLevels, maxLevels);

    const askDiff = diffMaps(prevAsks, currAsks);
    const bidDiff = diffMaps(prevBids, currBids);

    const aggregates = {
      bidNetDelta: Number(bidDiff.netDelta.toFixed(8)),
      askNetDelta: Number(askDiff.netDelta.toFixed(8)),
      totalNetDelta: Number((bidDiff.netDelta - askDiff.netDelta).toFixed(8)),
    };

    const summary = formatSummary({ pair: chk.pair, latest: undefined, extra: `Δbid=${aggregates.bidNetDelta.toFixed(2)} Δask=${aggregates.askNetDelta.toFixed(2)}` });
    const data = {
      prev: { timestamp: prevTs, sequenceId: prevSeq != null ? Number(prevSeq) : null },
      curr: { timestamp: currTs, sequenceId: currSeq != null ? Number(currSeq) : null },
      asks: { added: askDiff.added, removed: askDiff.removed, changed: askDiff.changed },
      bids: { added: bidDiff.added, removed: bidDiff.removed, changed: bidDiff.changed },
      aggregates,
    };
    const meta = createMeta(chk.pair, { delayMs });
    return GetDepthDiffOutputSchema.parse(ok(summary, data as any, meta as any)) as any;
  } catch (e: unknown) {
    return GetDepthDiffOutputSchema.parse(fail(getErrorMessage(e) || 'internal error', 'internal')) as any;
  }
}


