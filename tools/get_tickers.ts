import { fetchJson, BITBANK_API_BASE } from '../lib/http.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';
import { toIsoTime } from '../lib/datetime.js';
import { getErrorMessage } from '../lib/error.js';
import { GetTickersOutputSchema } from '../src/schemas.js';

type Market = 'all' | 'jpy';

interface TickerItem {
  pair: string;
  last: number | null;
  buy: number | null;
  sell: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  timestamp: number | null;
  isoTime: string | null;
  change24hPct: number | null;
  vol24hJpy: number | null;
}

const CACHE_TTL_MS = 3000;
let cache: { market: Market; fetchedAt: number; items: TickerItem[] } | null = null;

/**
 * /tickers API から全ペアを一括取得してパース
 */
async function fetchAllTickers(timeoutMs = 5000): Promise<TickerItem[]> {
  const url = `${BITBANK_API_BASE}/tickers`;
  const json = (await fetchJson(url, { timeoutMs, retries: 2 })) as { data?: Array<Record<string, unknown>> };
  const data = json?.data ?? [];

  return data.map((d) => {
    const pair = String(d.pair ?? '');
    const last = d.last != null ? Number(d.last) : null;
    const open = d.open != null ? Number(d.open) : null;
    const high = d.high != null ? Number(d.high) : null;
    const low = d.low != null ? Number(d.low) : null;
    const buy = d.buy != null ? Number(d.buy) : null;
    const sell = d.sell != null ? Number(d.sell) : null;
    const volume = d.vol != null ? Number(d.vol) : null;
    const timestamp = d.timestamp != null ? Number(d.timestamp) : null;

    // 24h変動率
    const change24hPct =
      open != null && open > 0 && last != null
        ? Number((((last - open) / open) * 100).toFixed(2))
        : null;

    // 24h出来高(円換算) - JPYペアのみ意味がある
    const vol24hJpy =
      last != null && volume != null ? Math.round(last * volume) : null;

    return {
      pair,
      last,
      buy,
      sell,
      open,
      high,
      low,
      volume,
      timestamp,
      isoTime: toIsoTime(timestamp),
      change24hPct,
      vol24hJpy,
    };
  });
}

/**
 * 複数ペアのサマリを生成
 */
function formatTickersSummary(items: TickerItem[], market: Market): string {
  const lines: string[] = [];
  const validItems = items.filter((x) => x.last != null);

  lines.push(`全${items.length}ペア取得 (有効: ${validItems.length})`);
  lines.push('');

  // 上位5件を表示
  const top5 = items.slice(0, 5);
  for (const item of top5) {
    const pairDisplay = formatPair(item.pair);
    const isJpy = item.pair.includes('jpy');
    const priceStr = item.last != null
      ? (isJpy ? `¥${item.last.toLocaleString('ja-JP')}` : item.last.toLocaleString('ja-JP'))
      : 'N/A';
    const changeStr = item.change24hPct != null
      ? `${item.change24hPct >= 0 ? '+' : ''}${item.change24hPct}%`
      : 'n/a';
    const volStr = item.vol24hJpy != null && isJpy
      ? ` 出来高¥${item.vol24hJpy.toLocaleString('ja-JP')}`
      : '';
    lines.push(`${pairDisplay}: ${priceStr} (${changeStr})${volStr}`);
  }

  if (items.length > 5) {
    lines.push(`... 他${items.length - 5}ペア`);
  }

  return lines.join('\n');
}

export default async function getTickers(market: Market = 'all') {
  const now = Date.now();

  // キャッシュチェック
  if (cache && cache.market === market && now - cache.fetchedAt <= CACHE_TTL_MS) {
    const summary = formatTickersSummary(cache.items, market) + ' (cached)';
    return GetTickersOutputSchema.parse(
      ok(
        summary,
        { items: cache.items },
        { market, fetchedAt: new Date(cache.fetchedAt).toISOString(), count: cache.items.length }
      )
    ) as any;
  }

  try {
    let items = await fetchAllTickers();

    // market フィルタ
    if (market === 'jpy') {
      items = items.filter((x) => x.pair.endsWith('_jpy'));
    }

    const summary = formatTickersSummary(items, market);
    const fetchedAt = Date.now();
    cache = { market, fetchedAt, items };

    return GetTickersOutputSchema.parse(
      ok(
        summary,
        { items },
        { market, fetchedAt: new Date(fetchedAt).toISOString(), count: items.length }
      )
    ) as any;
  } catch (e: unknown) {
    return GetTickersOutputSchema.parse(fail(getErrorMessage(e) || 'internal error', 'internal')) as any;
  }
}


