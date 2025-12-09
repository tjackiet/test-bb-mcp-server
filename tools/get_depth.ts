import { ensurePair, createMeta } from '../lib/validate.js';
import { fetchJson, BITBANK_API_BASE } from '../lib/http.js';
import { ok, fail } from '../lib/result.js';
import { formatSummary, formatTimestampJST } from '../lib/formatter.js';
import { getErrorMessage, isAbortError } from '../lib/error.js';
import { GetDepthOutputSchema } from '../src/schemas.js';

export interface GetDepthOptions { timeoutMs?: number; maxLevels?: number }

export default async function getDepth(
  pair: string,
  { timeoutMs = 3000, maxLevels = 200 }: GetDepthOptions = {}
) {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const url = `${BITBANK_API_BASE}/${chk.pair}/depth`;
  try {
    const json: unknown = await fetchJson(url, { timeoutMs, retries: 2 });
    const jsonObj = json as { data?: Record<string, unknown> };
    const d = jsonObj?.data ?? {};
    const asks = Array.isArray(d.asks) ? d.asks.slice(0, maxLevels) : [];
    const bids = Array.isArray(d.bids) ? d.bids.slice(0, maxLevels) : [];

    // 簡易サマリ（最良気配と件数）
    const bestAsk = asks[0]?.[0] ?? null;
    const bestBid = bids[0]?.[0] ?? null;
    const mid = bestBid && bestAsk ? Number(((Number(bestBid) + Number(bestAsk)) / 2).toFixed(2)) : null;
    const summary = formatSummary({
      pair: chk.pair,
      latest: mid ?? undefined,
      extra: `levels: bids=${bids.length} asks=${asks.length}`,
    });

    // ゾーン自動推定（簡易）：各サイドの上位Nレベルで閾値以上を帯にする
    function estimateZones(levels: Array<[number, number]>, side: 'bid' | 'ask'): Array<{ low: number; high: number; label: string; color?: string }> {
      if (!levels.length) return [];
      const qtys = levels.map(([, s]) => s);
      const avg = qtys.reduce((a, b) => a + b, 0) / qtys.length;
      const stdev = Math.sqrt(qtys.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / qtys.length) || 0;
      const thr = avg + stdev * 2; // 強めの閾値
      const zones: Array<{ low: number; high: number; label: string; color?: string }> = [];
      for (const [p, s] of levels) {
        if (s >= thr) {
          const pad = (p as number) * 0.001; // 0.1%幅
          if (side === 'bid') zones.push({ low: (p as number) - pad, high: (p as number) + pad, label: 'bid wall', color: 'rgba(34,197,94,0.08)' });
          else zones.push({ low: (p as number) - pad, high: (p as number) + pad, label: 'ask wall', color: 'rgba(249,115,22,0.08)' });
        }
      }
      return zones.slice(0, 5); // 多すぎないように上位数本
    }

    const data = {
      asks,
      bids,
      asks_over: d.asks_over,
      asks_under: d.asks_under,
      bids_over: d.bids_over,
      bids_under: d.bids_under,
      ask_market: d.ask_market,
      bid_market: d.bid_market,
      timestamp: Number(d.timestamp ?? d.timestamp_ms ?? Date.now()),
      sequenceId:
        d.sequenceId != null ? Number(d.sequenceId) :
          d.sequence_id != null ? Number(d.sequence_id) :
            undefined,
      overlays: {
        depth_zones: [
          ...estimateZones(bids.slice(0, 50).map(([p, s]: [unknown, unknown]) => [Number(p), Number(s)] as [number, number]), 'bid'),
          ...estimateZones(asks.slice(0, 50).map(([p, s]: [unknown, unknown]) => [Number(p), Number(s)] as [number, number]), 'ask'),
        ],
      },
    };

    // タイムスタンプ付きテキスト出力
    const text = [
      `📸 ${formatTimestampJST(data.timestamp)}`,
      '',
      summary,
      `板の層数: 買い ${bids.length}層 / 売り ${asks.length}層`,
      mid ? `中値: ${mid.toLocaleString()}円` : '',
    ].filter(Boolean).join('\n');

    const meta = createMeta(chk.pair);
    return GetDepthOutputSchema.parse(ok(text, data as any, meta as any));
  } catch (err: unknown) {
    const isAbort = isAbortError(err);
    const message = isAbort ? `タイムアウト (${timeoutMs}ms)` : getErrorMessage(err) || 'ネットワークエラー';
    return GetDepthOutputSchema.parse(fail(message, isAbort ? 'timeout' : 'network')) as any;
  }
}


