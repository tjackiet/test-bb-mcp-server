import { fetchJson, BITBANK_API_BASE } from '../lib/http.js';
import { ensurePair, validateLimit, validateDate, createMeta } from '../lib/validate.js';
import { ok, fail } from '../lib/result.js';
import { GetCandlesOutputSchema } from '../src/schemas.js';
import { formatSummary } from '../lib/formatter.js';
import { toIsoTime } from '../lib/datetime.js';
import { getErrorMessage } from '../lib/error.js';
import type { Result, GetCandlesData, GetCandlesMeta, CandleType } from '../src/types/domain.d.ts';

const TYPES: Set<CandleType | string> = new Set([
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '12hour',
  '1day',
  '1week',
  '1month',
]);

function todayYyyymmdd(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
}

export default async function getCandles(
  pair: string,
  type: CandleType | string = '1day',
  date: string = todayYyyymmdd(),
  limit: number = 200
): Promise<Result<GetCandlesData, GetCandlesMeta>> {
  const chk = ensurePair(pair);
  if (!chk.ok) return fail(chk.error.message, chk.error.type);

  if (!TYPES.has(type)) {
    return fail(`type は ${[...TYPES].join(', ')} から選択してください（指定値: ${String(type)}）`, 'user');
  }

  const dateCheck = validateDate(date, String(type));
  if (!dateCheck.ok) return fail(dateCheck.error.message, dateCheck.error.type);

  const limitCheck = validateLimit(limit, 1, 1000);
  if (!limitCheck.ok) return fail(limitCheck.error.message, limitCheck.error.type);

  const url = `${BITBANK_API_BASE}/${chk.pair}/candlestick/${type}/${dateCheck.value}`;

  try {
    const json: any = await fetchJson(url, { timeoutMs: 5000, retries: 2 });
    const cs = json?.data?.candlestick?.[0];
    const ohlcvs: unknown[] = cs?.ohlcv ?? [];

    if (ohlcvs.length === 0) {
      return fail(`ローソク足データが見つかりません (${chk.pair} / ${type} / ${dateCheck.value})`, 'user');
    }

    const rows = (ohlcvs as any[]).slice(-limitCheck.value);

    const normalized = rows.map(([o, h, l, c, v, ts]) => ({
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
      isoTime: toIsoTime(ts) ?? undefined,
    }));

    // 期間別のキーポイントを抽出
    const totalItems = normalized.length;
    const today = normalized[totalItems - 1];
    const sevenDaysAgo = totalItems >= 8 ? normalized[totalItems - 1 - 7] : null;
    const thirtyDaysAgo = totalItems >= 31 ? normalized[totalItems - 1 - 30] : null;
    const ninetyDaysAgo = totalItems >= 91 ? normalized[totalItems - 1 - 90] : totalItems > 0 ? normalized[0] : null;

    // 変化率を計算
    const calcChange = (from: number | undefined, to: number | undefined) => {
      if (!from || !to) return null;
      return ((to - from) / from) * 100;
    };

    // 出来高情報を計算
    const calcVolumeStats = () => {
      if (totalItems < 14) return null;

      // 直近7日間の平均出来高
      const recent7Days = normalized.slice(totalItems - 7, totalItems);
      const recent7DaysAvg = recent7Days.reduce((sum, c) => sum + c.volume, 0) / 7;

      // その前7日間（8〜14日前）の平均出来高
      const previous7Days = normalized.slice(totalItems - 14, totalItems - 7);
      const previous7DaysAvg = previous7Days.reduce((sum, c) => sum + c.volume, 0) / 7;

      // 過去30日間の平均出来高（データが30本以上ある場合）
      let last30DaysAvg: number | null = null;
      if (totalItems >= 30) {
        const last30 = normalized.slice(totalItems - 30, totalItems);
        last30DaysAvg = last30.reduce((sum, c) => sum + c.volume, 0) / last30.length;
      }

      // 変化率（直近7日 vs その前7日）
      const volumeChangePct = ((recent7DaysAvg - previous7DaysAvg) / previous7DaysAvg) * 100;

      // 判定
      let judgment = 'ほぼ変わりません';
      if (volumeChangePct > 20) judgment = '活発になっています';
      else if (volumeChangePct < -20) judgment = '落ち着いています';

      return {
        recent7DaysAvg: Number(recent7DaysAvg.toFixed(2)),
        previous7DaysAvg: Number(previous7DaysAvg.toFixed(2)),
        last30DaysAvg: last30DaysAvg != null ? Number(last30DaysAvg.toFixed(2)) : null,
        changePct: Number(volumeChangePct.toFixed(1)),
        judgment,
      };
    };

    const volumeStats = calcVolumeStats();

    const keyPoints = {
      today: today ? {
        index: totalItems - 1,
        date: today.isoTime?.split('T')[0] || null,
        close: today.close,
      } : null,
      sevenDaysAgo: sevenDaysAgo ? {
        index: totalItems - 1 - 7,
        date: sevenDaysAgo.isoTime?.split('T')[0] || null,
        close: sevenDaysAgo.close,
        changePct: calcChange(sevenDaysAgo.close, today?.close),
      } : null,
      thirtyDaysAgo: thirtyDaysAgo ? {
        index: totalItems - 1 - 30,
        date: thirtyDaysAgo.isoTime?.split('T')[0] || null,
        close: thirtyDaysAgo.close,
        changePct: calcChange(thirtyDaysAgo.close, today?.close),
      } : null,
      ninetyDaysAgo: ninetyDaysAgo ? {
        index: ninetyDaysAgo === normalized[0] ? 0 : totalItems - 1 - 90,
        date: ninetyDaysAgo.isoTime?.split('T')[0] || null,
        close: ninetyDaysAgo.close,
        changePct: calcChange(ninetyDaysAgo.close, today?.close),
      } : null,
    };

    const summary = formatSummary({
      pair: chk.pair,
      timeframe: String(type),
      latest: normalized.at(-1)?.close,
      totalItems,
      keyPoints,
      volumeStats,
    });

    const result = ok<GetCandlesData, GetCandlesMeta>(
      summary,
      { raw: json, normalized, keyPoints, volumeStats } as GetCandlesData,
      createMeta(chk.pair, { type, count: normalized.length }) as GetCandlesMeta
    );
    return GetCandlesOutputSchema.parse(result) as unknown as Result<GetCandlesData, GetCandlesMeta>;
  } catch (e: unknown) {
    const rawMsg = getErrorMessage(e);
    const t = String(type);
    if (/404/.test(rawMsg) && ['4hour', '8hour', '12hour'].includes(t)) {
      const hint = `${t} は YYYY 形式（例: 2025）が必要です。なお、現在この時間足がAPIで提供されていない可能性もあります。1hour または 1day での取得もお試しください。`;
      return GetCandlesOutputSchema.parse(fail(`HTTP 404 Not Found (${chk.pair}/${t}). ${hint}`, 'user')) as unknown as Result<GetCandlesData, GetCandlesMeta>;
    }
    return GetCandlesOutputSchema.parse(fail(rawMsg || 'ネットワークエラー', 'network')) as unknown as Result<GetCandlesData, GetCandlesMeta>;
  }
}


