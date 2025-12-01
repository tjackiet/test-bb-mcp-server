/**
 * analyze_candle_patterns - 2本足パターン検出（包み線・はらみ線等）
 *
 * 設計思想:
 * - 目的: BTC/JPY の直近5日間のローソク足から短期反転パターンを検出
 * - 対象: 2営業日の短期パターン（包み線、はらみ線等）
 * - 用途: 初心者向けの自然言語解説 + 過去統計付与
 *
 * 既存ツールとの違い:
 * - detect_patterns / detect_forming_patterns: 数週間〜数ヶ月スケールの大型パターン
 * - 本ツール: 2本足の短期反転パターンに特化
 *
 * 🚨 CRITICAL: 配列順序の明示
 * candles配列の順序は常に [最古, ..., 最新] です
 * - index 0: 最古（5日前）
 * - index n-1: 最新（今日、未確定の可能性）
 */

import getCandles from './get_candles.js';
import { ok, fail } from '../lib/result.js';
import { createMeta } from '../lib/validate.js';
import {
  AnalyzeCandlePatternsInputSchema,
  AnalyzeCandlePatternsOutputSchema,
  CandlePatternTypeEnum,
} from '../src/schemas.js';
import type { Candle, Pair } from '../src/types/domain.d.ts';

// ----- 型定義 -----
type CandlePatternType = typeof CandlePatternTypeEnum._type;

interface WindowCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  is_partial: boolean;
}

interface HistoryHorizonStats {
  avg_return: number;
  win_rate: number;
  sample: number;
}

interface HistoryStats {
  lookback_days: number;
  occurrences: number;
  horizons: Record<string, HistoryHorizonStats>;
}

interface LocalContext {
  trend_before: 'up' | 'down' | 'neutral';
  volatility_level: 'low' | 'medium' | 'high';
}

interface DetectedCandlePattern {
  pattern: CandlePatternType;
  pattern_jp: string;
  direction: 'bullish' | 'bearish';
  strength: number;
  candle_range_index: [number, number];
  uses_partial_candle: boolean;
  status: 'confirmed' | 'forming';
  local_context: LocalContext;
  history_stats: HistoryStats | null;
}

// ----- パターン日本語名マッピング -----
const PATTERN_JP_NAMES: Record<CandlePatternType, string> = {
  bullish_engulfing: '陽線包み線',
  bearish_engulfing: '陰線包み線',
  bullish_harami: '陽線はらみ線',
  bearish_harami: '陰線はらみ線',
  tweezer_top: '毛抜き天井',
  tweezer_bottom: '毛抜き底',
  dark_cloud_cover: 'かぶせ線',
  piercing_line: '切り込み線',
};

const PATTERN_DIRECTIONS: Record<CandlePatternType, 'bullish' | 'bearish'> = {
  bullish_engulfing: 'bullish',
  bearish_engulfing: 'bearish',
  bullish_harami: 'bullish',
  bearish_harami: 'bearish',
  tweezer_top: 'bearish',
  tweezer_bottom: 'bullish',
  dark_cloud_cover: 'bearish',
  piercing_line: 'bullish',
};

// ----- ヘルパー関数 -----

/**
 * ローソク足が陽線かどうか
 */
function isBullish(c: Candle): boolean {
  return c.close > c.open;
}

/**
 * ローソク足が陰線かどうか
 */
function isBearish(c: Candle): boolean {
  return c.close < c.open;
}

/**
 * 実体の大きさを取得
 */
function bodySize(c: Candle): number {
  return Math.abs(c.close - c.open);
}

/**
 * 実体の上端
 */
function bodyTop(c: Candle): number {
  return Math.max(c.open, c.close);
}

/**
 * 実体の下端
 */
function bodyBottom(c: Candle): number {
  return Math.min(c.open, c.close);
}

/**
 * トレンド判定（直前n本の終値で判定）
 * CRITICAL: candles配列は [最古, ..., 最新] の順序
 */
function detectTrendBefore(
  candles: Candle[],
  endIndex: number,
  lookbackCount: number = 3
): 'up' | 'down' | 'neutral' {
  if (endIndex < lookbackCount) return 'neutral';

  let upCount = 0;
  let downCount = 0;

  for (let i = endIndex - lookbackCount + 1; i <= endIndex; i++) {
    if (i > 0 && candles[i].close > candles[i - 1].close) {
      upCount++;
    } else if (i > 0 && candles[i].close < candles[i - 1].close) {
      downCount++;
    }
  }

  const threshold = Math.ceil(lookbackCount * 0.6);
  if (upCount >= threshold) return 'up';
  if (downCount >= threshold) return 'down';
  return 'neutral';
}

/**
 * ボラティリティレベルの判定
 */
function detectVolatilityLevel(
  candles: Candle[],
  endIndex: number,
  lookbackCount: number = 5
): 'low' | 'medium' | 'high' {
  if (endIndex < lookbackCount) return 'medium';

  const recentCandles = candles.slice(Math.max(0, endIndex - lookbackCount + 1), endIndex + 1);
  const avgPrice = recentCandles.reduce((sum, c) => sum + c.close, 0) / recentCandles.length;
  const avgRange = recentCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / recentCandles.length;
  const rangePct = (avgRange / avgPrice) * 100;

  if (rangePct < 1.5) return 'low';
  if (rangePct > 3.0) return 'high';
  return 'medium';
}

// ----- パターン検出関数 -----

/**
 * 陽線包み線 (bullish_engulfing) の検出
 * 条件: 陰線 → それを完全に包む陽線
 */
function detectBullishEngulfing(candle1: Candle, candle2: Candle): { detected: boolean; strength: number } {
  // candle1: 1本目（前日）、candle2: 2本目（当日）
  if (!isBearish(candle1) || !isBullish(candle2)) {
    return { detected: false, strength: 0 };
  }

  // 2本目の実体が1本目の実体を完全に包む
  // 2本目の始値 < 1本目の終値（または同値）かつ 2本目の終値 > 1本目の始値
  const engulfs = candle2.open <= candle1.close && candle2.close >= candle1.open;

  if (!engulfs) {
    return { detected: false, strength: 0 };
  }

  // 強度の計算: 包み込み度合い
  const body1 = bodySize(candle1);
  const body2 = bodySize(candle2);
  const coverageRatio = body1 > 0 ? body2 / body1 : 1;

  // 強度を0〜1に正規化（2倍以上包んでいれば1.0）
  const strength = Math.min(coverageRatio / 2, 1.0);

  return { detected: true, strength };
}

/**
 * 陰線包み線 (bearish_engulfing) の検出
 * 条件: 陽線 → それを完全に包む陰線
 */
function detectBearishEngulfing(candle1: Candle, candle2: Candle): { detected: boolean; strength: number } {
  if (!isBullish(candle1) || !isBearish(candle2)) {
    return { detected: false, strength: 0 };
  }

  // 2本目の実体が1本目の実体を完全に包む
  const engulfs = candle2.open >= candle1.close && candle2.close <= candle1.open;

  if (!engulfs) {
    return { detected: false, strength: 0 };
  }

  const body1 = bodySize(candle1);
  const body2 = bodySize(candle2);
  const coverageRatio = body1 > 0 ? body2 / body1 : 1;
  const strength = Math.min(coverageRatio / 2, 1.0);

  return { detected: true, strength };
}

/**
 * 陽線はらみ線 (bullish_harami) の検出
 * 条件: 大陰線 → 小さいローソク足が内包される
 */
function detectBullishHarami(candle1: Candle, candle2: Candle): { detected: boolean; strength: number } {
  if (!isBearish(candle1)) {
    return { detected: false, strength: 0 };
  }

  // 2本目が1本目の実体内に収まる
  const isContained =
    bodyTop(candle2) <= bodyTop(candle1) && bodyBottom(candle2) >= bodyBottom(candle1);

  if (!isContained) {
    return { detected: false, strength: 0 };
  }

  // 2本目が1本目より十分小さい
  const body1 = bodySize(candle1);
  const body2 = bodySize(candle2);
  if (body1 === 0 || body2 >= body1 * 0.7) {
    return { detected: false, strength: 0 };
  }

  // 強度: 1本目の大きさと2本目の小ささの比率
  const sizeRatio = 1 - body2 / body1;
  const strength = Math.min(sizeRatio, 1.0);

  return { detected: true, strength };
}

/**
 * 陰線はらみ線 (bearish_harami) の検出
 * 条件: 大陽線 → 小さいローソク足が内包される
 */
function detectBearishHarami(candle1: Candle, candle2: Candle): { detected: boolean; strength: number } {
  if (!isBullish(candle1)) {
    return { detected: false, strength: 0 };
  }

  const isContained =
    bodyTop(candle2) <= bodyTop(candle1) && bodyBottom(candle2) >= bodyBottom(candle1);

  if (!isContained) {
    return { detected: false, strength: 0 };
  }

  const body1 = bodySize(candle1);
  const body2 = bodySize(candle2);
  if (body1 === 0 || body2 >= body1 * 0.7) {
    return { detected: false, strength: 0 };
  }

  const sizeRatio = 1 - body2 / body1;
  const strength = Math.min(sizeRatio, 1.0);

  return { detected: true, strength };
}

// ----- パターン検出のディスパッチャー -----
type PatternDetector = (c1: Candle, c2: Candle) => { detected: boolean; strength: number };

const PATTERN_DETECTORS: Record<CandlePatternType, PatternDetector> = {
  bullish_engulfing: detectBullishEngulfing,
  bearish_engulfing: detectBearishEngulfing,
  bullish_harami: detectBullishHarami,
  bearish_harami: detectBearishHarami,
  tweezer_top: () => ({ detected: false, strength: 0 }), // Phase 2
  tweezer_bottom: () => ({ detected: false, strength: 0 }), // Phase 2
  dark_cloud_cover: () => ({ detected: false, strength: 0 }), // Phase 2
  piercing_line: () => ({ detected: false, strength: 0 }), // Phase 2
};

// ----- 過去統計計算 -----
interface PatternOccurrence {
  index: number;
  pattern: CandlePatternType;
  basePrice: number;
}

/**
 * 過去のパターン出現を検索
 */
function findHistoricalPatterns(
  candles: Candle[],
  pattern: CandlePatternType,
  excludeLastN: number = 1
): PatternOccurrence[] {
  const detector = PATTERN_DETECTORS[pattern];
  const occurrences: PatternOccurrence[] = [];

  // 最後のn本は除外（未確定または検出対象のため）
  const endIndex = candles.length - 1 - excludeLastN;

  for (let i = 1; i <= endIndex; i++) {
    const result = detector(candles[i - 1], candles[i]);
    if (result.detected) {
      occurrences.push({
        index: i,
        pattern,
        basePrice: candles[i].close,
      });
    }
  }

  return occurrences;
}

/**
 * 過去統計を計算
 */
function calculateHistoryStats(
  candles: Candle[],
  pattern: CandlePatternType,
  horizons: number[],
  lookbackDays: number
): HistoryStats | null {
  // lookbackDays分のデータがあるか確認
  if (candles.length < lookbackDays) {
    return null;
  }

  // lookbackDays期間内のパターンを検索
  const startIndex = candles.length - lookbackDays;
  const relevantCandles = candles.slice(startIndex);

  const occurrences = findHistoricalPatterns(relevantCandles, pattern, 5);

  if (occurrences.length < 5) {
    // サンプル数が少なすぎる場合はnull
    return null;
  }

  const horizonStats: Record<string, HistoryHorizonStats> = {};

  for (const h of horizons) {
    const returns: number[] = [];

    for (const occ of occurrences) {
      // グローバルインデックスに変換
      const globalIndex = startIndex + occ.index;

      // h本後のデータが存在するか確認
      if (globalIndex + h < candles.length) {
        const futureCandle = candles[globalIndex + h];
        const returnPct = ((futureCandle.close - occ.basePrice) / occ.basePrice) * 100;
        returns.push(returnPct);
      }
    }

    if (returns.length > 0) {
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const winCount = returns.filter((r) => r > 0).length;
      const winRate = winCount / returns.length;

      horizonStats[String(h)] = {
        avg_return: Number(avgReturn.toFixed(2)),
        win_rate: Number(winRate.toFixed(2)),
        sample: returns.length,
      };
    }
  }

  return {
    lookback_days: lookbackDays,
    occurrences: occurrences.length,
    horizons: horizonStats,
  };
}

// ----- サマリー生成 -----
function generateSummary(
  patterns: DetectedCandlePattern[],
  windowCandles: WindowCandle[]
): string {
  if (patterns.length === 0) {
    const trend = windowCandles.length >= 3
      ? (windowCandles[windowCandles.length - 1].close > windowCandles[0].close ? '上昇' : '下落')
      : '横ばい';
    return `直近${windowCandles.length}日間で${trend}傾向ですが、特徴的な2本足パターンは検出されませんでした。`;
  }

  const parts: string[] = [];

  for (const p of patterns) {
    const trendText = p.local_context.trend_before === 'down' ? '下落傾向' : p.local_context.trend_before === 'up' ? '上昇傾向' : '横ばい';
    const statusText = p.status === 'forming' ? '形成中（未確定）' : '確定';
    const directionText = p.direction === 'bullish' ? '上昇転換のサイン' : '下落転換のサイン';

    let statsPart = '';
    if (p.history_stats && p.history_stats.horizons['1']) {
      const h1 = p.history_stats.horizons['1'];
      statsPart = `過去${p.history_stats.lookback_days}日間で同様のパターンが${p.history_stats.occurrences}回出現し、翌日の勝率は${(h1.win_rate * 100).toFixed(0)}%でした。`;
    }

    parts.push(
      `${trendText}の中で「${p.pattern_jp}」（${statusText}）が検出されました。これは${directionText}とされます。${statsPart}`
    );

    if (p.uses_partial_candle) {
      parts.push('⚠️ 本日の日足は未確定のため、終値確定後にパターンが変化する可能性があります。');
    }
  }

  return parts.join(' ');
}

// ----- コンテント生成（LLM向け詳細テキスト） -----
function generateContent(
  patterns: DetectedCandlePattern[],
  windowCandles: WindowCandle[]
): Array<{ type: 'text'; text: string }> {
  const lines: string[] = [];

  lines.push('【ローソク足パターン分析結果】');
  lines.push('');
  lines.push(`分析期間: ${windowCandles[0]?.timestamp?.split('T')[0] || '?'} 〜 ${windowCandles[windowCandles.length - 1]?.timestamp?.split('T')[0] || '?'}`);
  lines.push('');

  if (patterns.length === 0) {
    lines.push('検出されたパターン: なし');
    lines.push('');
    lines.push('直近の値動きには特徴的な2本足パターンは見られませんでした。');
  } else {
    for (const p of patterns) {
      lines.push(`■ ${p.pattern_jp}（${p.pattern}）`);
      lines.push(`  方向性: ${p.direction === 'bullish' ? '強気（上昇転換シグナル）' : '弱気（下落転換シグナル）'}`);
      lines.push(`  状態: ${p.status === 'forming' ? '形成中（終値未確定）' : '確定'}`);
      lines.push(`  強度: ${(p.strength * 100).toFixed(0)}%`);
      lines.push(`  直前トレンド: ${p.local_context.trend_before === 'up' ? '上昇' : p.local_context.trend_before === 'down' ? '下落' : '中立'}`);

      if (p.history_stats) {
        lines.push('');
        lines.push(`  【過去${p.history_stats.lookback_days}日間の統計】`);
        lines.push(`    出現回数: ${p.history_stats.occurrences}回`);

        for (const [horizon, stats] of Object.entries(p.history_stats.horizons)) {
          lines.push(`    ${horizon}日後: 勝率${(stats.win_rate * 100).toFixed(0)}%, 平均リターン${stats.avg_return > 0 ? '+' : ''}${stats.avg_return.toFixed(2)}% (n=${stats.sample})`);
        }
      }

      if (p.uses_partial_candle) {
        lines.push('');
        lines.push('  ⚠️ 注意: 本日の日足は未確定です。終値確定後にパターンが変化・消失する可能性があります。');
      }

      lines.push('');
    }
  }

  // 補足説明
  lines.push('【パターンの読み方】');
  lines.push('・陽線包み線: 下落後に出現すると上昇転換のサインとされます');
  lines.push('・陰線包み線: 上昇後に出現すると下落転換のサインとされます');
  lines.push('・勝率50%超でもリスク管理は必須です。統計は参考値であり、将来を保証するものではありません。');

  return [{ type: 'text', text: lines.join('\n') }];
}

// ----- メイン関数 -----
export default async function analyzeCandlePatterns(
  opts: {
    pair?: 'btc_jpy';
    timeframe?: '1day';
    window_days?: number;
    focus_last_n?: number;
    patterns?: CandlePatternType[];
    history_lookback_days?: number;
    history_horizons?: number[];
    allow_partial_patterns?: boolean;
  } = {}
) {
  try {
    // 入力の正規化
    const input = AnalyzeCandlePatternsInputSchema.parse(opts);
    const pair = input.pair as Pair;
    const timeframe = input.timeframe;
    const windowDays = input.window_days;
    const focusLastN = input.focus_last_n;
    const targetPatterns = input.patterns || (Object.keys(PATTERN_DETECTORS) as CandlePatternType[]);
    const historyLookbackDays = input.history_lookback_days;
    const historyHorizons = input.history_horizons;
    const allowPartial = input.allow_partial_patterns;

    // ローソク足データを取得（統計計算用に多めに取得）
    const requiredCandles = Math.max(windowDays, historyLookbackDays + 10);
    const candlesResult = await getCandles(pair, '1day', undefined, requiredCandles);

    if (!candlesResult.ok) {
      return AnalyzeCandlePatternsOutputSchema.parse(
        fail(candlesResult.summary, 'internal')
      );
    }

    const allCandles = candlesResult.data.normalized;

    if (allCandles.length < windowDays) {
      return AnalyzeCandlePatternsOutputSchema.parse(
        fail(`ローソク足データが不足しています（${allCandles.length}本 < ${windowDays}本）`, 'user')
      );
    }

    // 直近windowDays分を切り出し
    // CRITICAL: allCandlesは [最古, ..., 最新] の順序
    const windowStart = allCandles.length - windowDays;
    const windowCandles = allCandles.slice(windowStart);

    // 日足確定判定: 最新の日足が今日のデータかどうか
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const lastCandleTime = windowCandles[windowCandles.length - 1]?.isoTime?.split('T')[0];
    const isLastPartial = lastCandleTime === todayStr;

    // WindowCandle形式に変換
    const formattedWindowCandles: WindowCandle[] = windowCandles.map((c, idx) => ({
      timestamp: c.isoTime || new Date(c.time || 0).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume || 0,
      is_partial: idx === windowCandles.length - 1 && isLastPartial,
    }));

    // パターン検出
    // focus_last_n: 直近n本の組み合わせを重点的にチェック
    // CRITICAL: windowCandles配列は [最古, ..., 最新] の順序
    // - index 0: 最古
    // - index windowDays-1: 最新（is_partialの可能性）
    const detectedPatterns: DetectedCandlePattern[] = [];
    const startCheckIndex = Math.max(1, windowCandles.length - focusLastN);

    for (let i = startCheckIndex; i < windowCandles.length; i++) {
      const candle1 = windowCandles[i - 1];
      const candle2 = windowCandles[i];
      const usesPartial = i === windowCandles.length - 1 && isLastPartial;

      // 未確定ローソクを使うかどうか
      if (usesPartial && !allowPartial) {
        continue;
      }

      for (const patternType of targetPatterns) {
        const detector = PATTERN_DETECTORS[patternType];
        const result = detector(candle1, candle2);

        if (result.detected) {
          // ローカルコンテキストの計算
          // トレンドは1本目より前の3本で判定
          const trendBefore = detectTrendBefore(windowCandles, i - 1, 3);
          const volatilityLevel = detectVolatilityLevel(windowCandles, i, 5);

          // 過去統計の計算
          const historyStats = calculateHistoryStats(
            allCandles,
            patternType,
            historyHorizons,
            historyLookbackDays
          );

          detectedPatterns.push({
            pattern: patternType,
            pattern_jp: PATTERN_JP_NAMES[patternType],
            direction: PATTERN_DIRECTIONS[patternType],
            strength: Number(result.strength.toFixed(2)),
            candle_range_index: [i - 1, i] as [number, number],
            uses_partial_candle: usesPartial,
            status: usesPartial ? 'forming' : 'confirmed',
            local_context: {
              trend_before: trendBefore,
              volatility_level: volatilityLevel,
            },
            history_stats: historyStats,
          });
        }
      }
    }

    // サマリーとコンテント生成
    const summary = generateSummary(detectedPatterns, formattedWindowCandles);
    const content = generateContent(detectedPatterns, formattedWindowCandles);

    const data = {
      pair,
      timeframe,
      snapshot_time: new Date().toISOString(),
      window: {
        from: formattedWindowCandles[0]?.timestamp?.split('T')[0] || '',
        to: formattedWindowCandles[formattedWindowCandles.length - 1]?.timestamp?.split('T')[0] || '',
        candles: formattedWindowCandles,
      },
      recent_patterns: detectedPatterns,
      summary,
    };

    const meta = {
      ...createMeta(pair, {}),
      timeframe,
      window_days: windowDays,
      patterns_checked: targetPatterns,
      history_lookback_days: historyLookbackDays,
      history_horizons: historyHorizons,
    };

    const result = {
      ok: true as const,
      summary,
      content,
      data,
      meta,
    };

    return AnalyzeCandlePatternsOutputSchema.parse(result);
  } catch (e: any) {
    return AnalyzeCandlePatternsOutputSchema.parse(
      fail(e?.message || 'Unknown error', 'internal')
    );
  }
}

