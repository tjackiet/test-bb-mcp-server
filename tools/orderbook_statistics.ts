import getTicker from './get_ticker.js';
import getDepth from './get_depth.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary, formatTimestampJST } from '../lib/formatter.js';

export default async function getOrderbookStatistics(
  pair: string = 'btc_jpy',
  ranges: number[] = [0.5, 1.0, 2.0],
  priceZones: number = 10
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  try {
    const [tkr, dep]: any = await Promise.all([getTicker(chk.pair), getDepth(chk.pair, { maxLevels: 200 })]);
    if (!tkr?.ok) return fail(tkr?.summary || 'ticker failed', (tkr?.meta as any)?.errorType || 'internal');
    if (!dep?.ok) return fail(dep?.summary || 'depth failed', (dep?.meta as any)?.errorType || 'internal');

    // タイムスタンプを取得
    const timestamp = dep?.data?.timestamp ?? Date.now();

    // normalize raw depth from get_depth (bids/asks arrays [price,size])
    const asks: Array<[number, number]> = Array.isArray(dep?.data?.asks) ? dep.data.asks.map(([p, s]: any) => [Number(p), Number(s)]) : [];
    const bids: Array<[number, number]> = Array.isArray(dep?.data?.bids) ? dep.data.bids.map(([p, s]: any) => [Number(p), Number(s)]) : [];

    // derive best bid/ask from depth arrays (fallback: ticker last for mid)
    const bestBid = bids.length ? Math.max(...bids.map(([p]) => p)) : null;
    const bestAsk = asks.length ? Math.min(...asks.map(([p]) => p)) : null;
    const mid = (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2 : (tkr?.data?.normalized?.last ?? null);

    const basic = {
      currentPrice: mid != null ? Math.round(mid) : null,
      bestBid: bestBid != null ? Number(bestBid) : null,
      bestAsk: bestAsk != null ? Number(bestAsk) : null,
      spread: (bestBid != null && bestAsk != null) ? Number(bestAsk) - Number(bestBid) : null,
      spreadPct: (bestBid != null && bestAsk != null && mid) ? (Number(bestAsk) - Number(bestBid)) / Number(mid) : null,
    };

    // Ranges (±pct around mid)
    function sumWithinPct(levels: Array<[number, number]>, pct: number, side: 'bid' | 'ask') {
      if (!mid) return { vol: 0, val: 0 };
      const minP = mid * (1 - pct / 100);
      const maxP = mid * (1 + pct / 100);
      let vol = 0; let val = 0;
      for (const [price, size] of levels) {
        if (side === 'bid' && price >= minP && price <= mid) { vol += size; val += size * price; }
        if (side === 'ask' && price <= maxP && price >= mid) { vol += size; val += size * price; }
      }
      return { vol, val };
    }
    const rangesOut = ranges.map((pct) => {
      const b = sumWithinPct(bids, pct, 'bid');
      const a = sumWithinPct(asks, pct, 'ask');
      const ratio = a.vol > 0 ? (b.vol / a.vol) : (b.vol > 0 ? Infinity : 0);
      const interpretation = ratio > 1.2 ? '買い板が厚い（下値堅い）' : (ratio < 0.8 ? '売り板が厚い（上値重い）' : '均衡');
      return { pct, bidVolume: Number(b.vol.toFixed(4)), askVolume: Number(a.vol.toFixed(4)), bidValue: Math.round(b.val), askValue: Math.round(a.val), ratio: Number(ratio.toFixed(2)), interpretation };
    });

    // Liquidity zones (split ±max(ranges) into priceZones)
    const maxPct = Math.max(...ranges);
    const minPrice = mid ? mid * (1 - maxPct / 100) : 0;
    const maxPrice = mid ? mid * (1 + maxPct / 100) : 0;
    const step = priceZones > 0 && mid ? (maxPrice - minPrice) / priceZones : 0;
    const zones: Array<{ priceRange: string; bidVolume: number; askVolume: number; dominance: 'bid' | 'ask' | 'balanced'; note?: string }> = [];
    if (step > 0) {
      for (let i = 0; i < priceZones; i++) {
        const lo = minPrice + i * step;
        const hi = lo + step;
        const bVol = bids.filter(([p]) => p >= lo && p < hi).reduce((s, [, sz]) => s + sz, 0);
        const aVol = asks.filter(([p]) => p >= lo && p < hi).reduce((s, [, sz]) => s + sz, 0);
        const dom = bVol > aVol * 1.2 ? 'bid' : (aVol > bVol * 1.2 ? 'ask' : 'balanced');
        const note = dom === 'bid' ? '強い買いサポート' : (dom === 'ask' ? '強い売り圧力' : undefined);
        zones.push({ priceRange: `${Math.round(lo).toLocaleString()} - ${Math.round(hi).toLocaleString()}`, bidVolume: Number(bVol.toFixed(4)), askVolume: Number(aVol.toFixed(4)), dominance: dom, note });
      }
    }

    // Large orders
    const threshold = 0.1;
    const largeBids = bids.filter(([, sz]) => sz >= threshold).slice(0, 20).map(([p, sz]) => ({ price: Math.round(p), size: Number(sz.toFixed(3)), distance: mid ? Number((((p - mid) / mid) * 100).toFixed(2)) : null }));
    const largeAsks = asks.filter(([, sz]) => sz >= threshold).slice(0, 20).map(([p, sz]) => ({ price: Math.round(p), size: Number(sz.toFixed(3)), distance: mid ? Number((((p - mid) / mid) * 100).toFixed(2)) : null }));

    // Overall assessment
    const lastRatio = rangesOut[0]?.ratio ?? 1;
    const overall = lastRatio > 1.1 ? '買い優勢' : (lastRatio < 0.9 ? '売り優勢' : '均衡');
    const strength = Math.abs(lastRatio - 1) > 0.3 ? 'strong' : (Math.abs(lastRatio - 1) > 0.1 ? 'moderate' : 'weak');
    const liquidity = (rangesOut[0]?.bidVolume ?? 0) + (rangesOut[0]?.askVolume ?? 0) > 20 ? 'high' : (((rangesOut[0]?.bidVolume ?? 0) + (rangesOut[0]?.askVolume ?? 0) > 5) ? 'medium' : 'low');
    const recommendation = overall === '買い優勢' ? '下値が堅く、買いエントリーに適した環境。' : (overall === '売り優勢' ? '上値が重く、押し目待ち・警戒。' : '均衡圏、レンジ想定。');

    const data = {
      basic,
      ranges: rangesOut,
      liquidityZones: zones,
      largeOrders: { bids: largeBids, asks: largeAsks, threshold },
      summary: { overall, strength, liquidity, recommendation },
    };

    const text = [
      `📸 ${formatTimestampJST(timestamp)}`,
      '',
      '=== ' + String(pair).toUpperCase() + ' 板統計分析 ===',
      '💰 現在価格: ' + (basic.currentPrice != null ? `${basic.currentPrice.toLocaleString()}円` : 'n/a'),
      basic.spread != null ? `   スプレッド: ${basic.spread}円 (${((basic.spreadPct || 0) * 100).toFixed(6)}%)` : '',
      '',
      '📊 板の厚み分析:',
      ...rangesOut.map((r) => `±${r.pct}%レンジ: 買い ${r.bidVolume} BTC / 売り ${r.askVolume} BTC (比率 ${r.ratio}) → ${r.interpretation}`),
      '',
      '📈 価格帯別の流動性分布:',
      ...zones.slice(0, 5).map((z) => `${z.priceRange}円: 買い ${z.bidVolume} / 売り ${z.askVolume} (${z.dominance}) ${z.note || ''}`),
      '',
      '🐋 大口注文:',
      ...largeBids.slice(0, 3).map((o) => `買い板: ${o.price.toLocaleString()}円に${o.size} BTC (${o.distance != null ? (o.distance >= 0 ? '+' : '') + o.distance + '%' : ''})`),
      ...largeAsks.slice(0, 3).map((o) => `売り板: ${o.price.toLocaleString()}円に${o.size} BTC (${o.distance != null ? (o.distance >= 0 ? '+' : '') + o.distance + '%' : ''})`),
      '',
      `💡 総合評価: ${overall}（${strength}）`,
      recommendation,
    ].filter(Boolean).join('\n');

    const summary = formatSummary({ pair: chk.pair, latest: basic.currentPrice ?? undefined, extra: `spread=${basic.spread} (${((basic.spreadPct || 0) * 100).toFixed(4)}%)` });
    return ok(text, data as any, createMeta(chk.pair, { fetchedAt: new Date().toISOString(), summary })) as any;
  } catch (e: any) {
    return fail(e?.message || 'internal error', 'internal') as any;
  }
}


