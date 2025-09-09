// tools/get_simple_trend.js
import getCandles from './get_candles.js';
import { sma, ichimokuSeries } from './get_indicators.js';
import { ensurePair, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { getFetchCount } from '../lib/indicator_buffer.js';
import { formatSummary } from '../lib/formatter.js';

export default async function getSimpleTrend({
  pair = 'btc_jpy',
  type = '1day',
  limit = 100,
}) {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  const indicatorKeys = ['SMA_20', 'ICHIMOKU'];
  const fetchCount = getFetchCount(limit, indicatorKeys);

  const candlesResult = await getCandles(chk.pair, type, undefined, fetchCount);
  if (!candlesResult.ok) return candlesResult;

  const candles = candlesResult.data.normalized;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const sma20 = sma(closes, 20);
  const ichi = ichimokuSeries(highs, lows, closes);

  const latest = {
    close: closes.at(-1),
    sma20: sma20.at(-1),
    spanA: ichi.spanA.at(-1),
    spanB: ichi.spanB.at(-1),
  };

  let trend = 'neutral';
  let comment = '明確なトレンドは見られません。';

  if (
    latest.sma20 &&
    latest.close > latest.sma20 &&
    latest.spanA &&
    latest.spanB &&
    latest.close > latest.spanA &&
    latest.close > latest.spanB
  ) {
    trend = 'bullish';
    comment =
      '20期間移動平均線が上向きで、価格が一目均衡表の雲の上にあります。強気トレンドの可能性があります。';
  } else if (
    latest.sma20 &&
    latest.close < latest.sma20 &&
    latest.spanA &&
    latest.spanB &&
    latest.close < latest.spanA &&
    latest.close < latest.spanB
  ) {
    trend = 'bearish';
    comment =
      '20期間移動平均線が下向きで、価格が一目均衡表の雲の下にあります。弱気トレンドの可能性があります。';
  }

  const summary = `Trend for ${chk.pair} (${type}) is ${trend}.`;
  const data = { trend, comment, pair: chk.pair, timeframe: type, latest };
  const meta = createMeta(chk.pair, { type, limit });

  return ok(summary, data, meta);
}
