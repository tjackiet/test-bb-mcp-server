import getDepth from './get_depth.js';
import getCandles from './get_candles.js';
import { ok, fail } from '../lib/result.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { getErrorMessage } from '../lib/error.js';

type Lookback = '30min' | '1hour' | '2hour';

const cache = new Map<string, { ts: number; data: any }>();

function extractLargeOrders(levels: Array<[number, number]>, minSize: number) {
  return (levels || [])
    .filter(([p, s]) => Number(s) >= minSize)
    .map(([p, s]) => ({ price: Number(p), size: Number(s) }));
}

function analyzeTrend(buyVol: number, sellVol: number): 'accumulation' | 'distribution' | 'neutral' {
  if (buyVol > sellVol * 1.2) return 'accumulation';
  if (sellVol > buyVol * 1.2) return 'distribution';
  return 'neutral';
}

function generateRecommendation(trend: string): string {
  if (trend === 'accumulation') return '買い圧力が優勢。段階的なエントリーを検討。';
  if (trend === 'distribution') return '売り圧力が優勢。押し目待ち/警戒。';
  return '均衡。レンジ内の値動きを想定。';
}

export default async function detectWhaleEvents(
  pair: string = 'btc_jpy',
  lookback: Lookback = '1hour',
  minSize: number = 0.5
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const cacheKey = `${chk.pair}:${lookback}:${minSize}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < 60_000) return hit.data;

  try {
    const dep: any = await getDepth(chk.pair, { maxLevels: 200 });
    if (!dep?.ok) return fail(dep?.summary || 'depth failed', (dep?.meta as any)?.errorType || 'internal');
    const asks: Array<[number, number]> = dep?.data?.asks || [];
    const bids: Array<[number, number]> = dep?.data?.bids || [];
    const bestBid = bids.length ? Math.max(...bids.map(([p]) => Number(p))) : null;
    const bestAsk = asks.length ? Math.min(...asks.map(([p]) => Number(p))) : null;
    const mid = (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2 : null;

    const lbMap: Record<Lookback, { type: string; limit: number }> = {
      '30min': { type: '5min', limit: 6 },
      '1hour': { type: '5min', limit: 12 },
      '2hour': { type: '5min', limit: 24 },
    };
    const lb = lbMap[lookback] || lbMap['1hour'];
    const candlesRes: any = await getCandles(chk.pair, lb.type as any, undefined as any, lb.limit);
    if (!candlesRes?.ok) return fail(candlesRes?.summary || 'candles failed', (candlesRes?.meta as any)?.errorType || 'internal');
    const candles: Array<{ close: number }> = candlesRes?.data?.normalized || [];
    const priceChange = candles.length >= 2 ? (candles[candles.length - 1].close - candles[0].close) / candles[0].close : 0;

    const largeBids = extractLargeOrders(bids, minSize);
    const largeAsks = extractLargeOrders(asks, minSize);

    const buyVol = largeBids.reduce((s, o) => s + o.size, 0);
    const sellVol = largeAsks.reduce((s, o) => s + o.size, 0);
    const trend = analyzeTrend(buyVol, sellVol);
    const recommendation = generateRecommendation(trend);

    const annotate = (side: 'buy' | 'sell') => (o: { price: number; size: number }) => ({
      side,
      price: o.price,
      size: Number(o.size.toFixed(3)),
      distancePct: mid ? Number((((o.price - mid) / mid) * 100).toFixed(2)) : null,
    });
    const events = [
      ...largeBids.map(annotate('buy')),
      ...largeAsks.map(annotate('sell')),
    ].sort((a, b) => Math.abs((a.distancePct || 0)) - Math.abs((b.distancePct || 0))).slice(0, 20);

    // Visualization: buy/sell balance
    const totalVol = buyVol + sellVol;
    const buyPct = totalVol > 0 ? (buyVol / totalVol) : 0;
    const sellPct = totalVol > 0 ? (sellVol / totalVol) : 0;
    const barLen = 14;
    const buyBars = '█'.repeat(Math.max(0, Math.round(buyPct * barLen)));
    const sellBars = '█'.repeat(Math.max(0, Math.round(sellPct * barLen)));

    // Distance stats
    const buyDists = largeBids.map((o) => (mid ? ((o.price - mid) / mid) * 100 : null)).filter((x): x is number => x != null);
    const sellDists = largeAsks.map((o) => (mid ? ((o.price - mid) / mid) * 100 : null)).filter((x): x is number => x != null);
    const avg = (arr: number[]) => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
    const avgBuyDist = avg(buyDists);
    const avgSellDist = avg(sellDists);

    const text = [
      `=== ${chk.pair.toUpperCase()} 大口動向分析（過去${lookback}）===`,
      '',
      `🐋 検出された大口: ${events.length}件`,
      `買い: ${largeBids.length}件（合計${buyVol.toFixed(2)} BTC）`,
      `売り: ${largeAsks.length}件（合計${sellVol.toFixed(2)} BTC）`,
      '',
      '📊 買い/売りバランス:',
      `   買い: ${buyBars} ${buyVol.toFixed(2)} BTC (${(buyPct * 100).toFixed(0)}%)`,
      `   売り: ${sellBars} ${sellVol.toFixed(2)} BTC (${(sellPct * 100).toFixed(0)}%)`,
      '',
      '📏 距離の統計:',
      `   平均距離: 買い ${avgBuyDist.toFixed(2)}%, 売り ${avgSellDist.toFixed(2)}%`,
      '',
      '📋 主要な大口:',
      ...events.slice(0, 10).map((e) => `${e.side === 'buy' ? '🟢' : '🔴'} ${e.price.toLocaleString()}円に${e.size} BTC（${e.side === 'buy' ? '買い' : '売り'}）距離: ${e.distancePct != null ? (e.distancePct >= 0 ? '+' : '') + e.distancePct + '%' : 'n/a'}`),
      '',
      `📈 過去${lookback}の価格変化: ${(priceChange * 100).toFixed(2)}%`,
      '',
      `💡 総合評価: ${trend === 'accumulation' ? '買い圧力優勢' : (trend === 'distribution' ? '売り圧力優勢' : '均衡')}（${trend}）`,
      recommendation,
      '',
      '※ 注: 推測ベースの簡易分析です（実約定・寿命照合は未実装）。',
    ].join('\n');

    const data = {
      events,
      stats: {
        buyOrders: largeBids.length,
        sellOrders: largeAsks.length,
        buyVolume: Number(buyVol.toFixed(3)),
        sellVolume: Number(sellVol.toFixed(3)),
        trend,
        recommendation,
      },
      meta: { lookback, minSize },
    };

    const out = ok(text, data as any, createMeta(chk.pair, { fetchedAt: new Date().toISOString() })) as any;
    cache.set(cacheKey, { ts: Date.now(), data: out });
    return out;
  } catch (e: unknown) {
    return fail(getErrorMessage(e) || 'internal error', 'internal');
  }
}


