import getCandles from './get_candles.js';
import { ok, fail } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { formatSummary } from '../lib/formatter.js';
import { AnalyzeSupportResistanceOutputSchema } from '../src/schemas.js';

export interface AnalyzeSupportResistanceOptions {
  lookbackDays?: number;
  topN?: number;
  tolerance?: number;
}

export interface TouchEvent {
  date: string;
  price: number;
  bounceStrength: number; // ヒゲの長さ%
  type: 'support' | 'resistance';
}

export interface SupportResistanceLevel {
  price: number;
  pctFromCurrent: number;
  strength: number; // 1-3
  label: string;
  touchCount: number;
  touches: TouchEvent[];
  recentBreak?: {
    date: string;
    price: number;
    breakPct: number;
  };
  type: 'support' | 'resistance'; // タイプ
  formationType?: 'traditional' | 'new_formation' | 'role_reversal'; // 形成タイプ
  volumeBoost?: boolean; // 出来高による補強
  note?: string; // 補足説明
}

function roundToLevel(price: number, step: number = 50000): number {
  return Math.round(price / step) * step;
}

function findPriceLevels(
  candles: Array<{ isoTime: string; open: number; high: number; low: number; close: number }>,
  currentPrice: number,
  tolerance: number,
  recentDays: number
): { supports: Map<number, TouchEvent[]>; resistances: Map<number, TouchEvent[]> } {
  const supports = new Map<number, TouchEvent[]>();
  const resistances = new Map<number, TouchEvent[]>();
  
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);

  for (const candle of candles) {
    const candleDate = new Date(candle.isoTime);
    if (candleDate < recentCutoff) continue;

    // サポート判定：安値での反発
    const lowLevel = roundToLevel(candle.low);
    const lowBounce = ((candle.close - candle.low) / candle.low) * 100;
    
    if (lowBounce > 0.3) { // 0.3%以上の下ヒゲまたは反発
      const event: TouchEvent = {
        date: candle.isoTime.split('T')[0],
        price: candle.low,
        bounceStrength: lowBounce,
        type: 'support'
      };
      
      if (!supports.has(lowLevel)) {
        supports.set(lowLevel, []);
      }
      supports.get(lowLevel)!.push(event);
    }

    // レジスタンス判定：高値での反落
    const highLevel = roundToLevel(candle.high);
    const highReject = ((candle.high - candle.close) / candle.high) * 100;
    
    if (highReject > 0.3) { // 0.3%以上の上ヒゲまたは反落
      const event: TouchEvent = {
        date: candle.isoTime.split('T')[0],
        price: candle.high,
        bounceStrength: highReject,
        type: 'resistance'
      };
      
      if (!resistances.has(highLevel)) {
        resistances.set(highLevel, []);
      }
      resistances.get(highLevel)!.push(event);
    }
  }

  return { supports, resistances };
}

function detectRecentBreak(
  level: number,
  type: 'support' | 'resistance',
  candles: Array<{ isoTime: string; open: number; high: number; low: number; close: number }>,
  recentDays: number = 7
): { date: string; price: number; breakPct: number } | undefined {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  const recentCandles = candles.filter(c => new Date(c.isoTime) >= recentCutoff);

  for (const candle of recentCandles) {
    if (type === 'support') {
      if (candle.low < level * 0.99) { // 1%以上下回った
        const breakPct = ((candle.low - level) / level) * 100;
        return {
          date: candle.isoTime.split('T')[0],
          price: candle.low,
          breakPct
        };
      }
    } else {
      if (candle.high > level * 1.01) { // 1%以上上回った
        const breakPct = ((candle.high - level) / level) * 100;
        return {
          date: candle.isoTime.split('T')[0],
          price: candle.high,
          breakPct
        };
      }
    }
  }
  
  return undefined;
}

function detectNewSupport(
  candles: Array<{ isoTime: string; open: number; high: number; low: number; close: number; volume?: number }>,
  recentDays: number = 10
): Array<{ price: number; date: string; volumeBoost: boolean; note: string }> {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  const recentCandles = candles.filter(c => new Date(c.isoTime) >= recentCutoff);
  
  const newSupports: Array<{ price: number; date: string; volumeBoost: boolean; note: string }> = [];
  
  // 平均出来高計算
  const avgVolume = recentCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / recentCandles.length;
  
  for (let i = 1; i < recentCandles.length - 1; i++) {
    const current = recentCandles[i];
    const prev = recentCandles[i - 1];
    const next = recentCandles[i + 1];
    
    // 安値が2日以上連続で切り上がっているかチェック
    if (current.low < prev.low && next.low > current.low) {
      // その最安値を以降割っていないかチェック
      const subsequentCandles = recentCandles.slice(i + 1);
      const lowestSubsequent = Math.min(...subsequentCandles.map(c => c.low));
      
      if (lowestSubsequent >= current.low * 0.999) { // 0.1%の許容誤差
        const volumeBoost = (current.volume || 0) > avgVolume * 1.5;
        
        // V字反発の検出
        const prevDrop = ((current.close - prev.close) / prev.close) * 100;
        const nextRise = ((next.close - current.close) / current.close) * 100;
        let note = '新サポート形成（安値切り上げ）';
        
        if (prevDrop < -3 && nextRise > 3) {
          note = 'V字反発によるサポート形成';
        } else if (volumeBoost) {
          note = '大出来高での反発（新サポート）';
        }
        
        newSupports.push({
          price: roundToLevel(current.low),
          date: current.isoTime.split('T')[0],
          volumeBoost,
          note
        });
      }
    }
  }
  
  return newSupports;
}

function detectRoleReversal(
  brokenSupports: Map<number, { date: string; price: number }>,
  brokenResistances: Map<number, { date: string; price: number }>,
  candles: Array<{ isoTime: string; open: number; high: number; low: number; close: number }>,
  currentPrice: number
): { newResistances: Map<number, string>; newSupports: Map<number, string> } {
  const newResistances = new Map<number, string>();
  const newSupports = new Map<number, string>();
  
  // 崩壊したサポート → レジスタンス転換
  for (const [level, breakInfo] of brokenSupports.entries()) {
    if (level > currentPrice) { // 現在価格より上
      newResistances.set(level, `元サポート（${breakInfo.date}に崩壊）→ レジスタンス転換`);
    }
  }
  
  // 突破されたレジスタンス → サポート転換
  for (const [level, breakInfo] of brokenResistances.entries()) {
    if (level < currentPrice) { // 現在価格より下
      newSupports.set(level, `元レジスタンス（${breakInfo.date}に突破）→ サポート転換`);
    }
  }
  
  return { newResistances, newSupports };
}

function calculateStrength(
  touchCount: number,
  recentCount: number,
  hasRecentBreak: boolean,
  volumeBoost: boolean = false,
  formationType: 'traditional' | 'new_formation' | 'role_reversal' = 'traditional'
): number {
  let strength = 1;
  
  if (formationType === 'new_formation') {
    // 新形成は基本★★
    strength = 2;
    if (volumeBoost) strength = 3;
  } else if (formationType === 'role_reversal') {
    // ロールリバーサルは基本★（検証待ち）
    strength = 1;
  } else {
    // 従来型：接触回数ベース
    if (touchCount >= 5) strength = 3;
    else if (touchCount >= 3) strength = 2;
    else strength = 1;
    
    // 直近の接触で強化
    if (recentCount >= 2 && touchCount >= 3) strength = Math.min(3, strength + 1);
    
    // 出来高補強
    if (volumeBoost && strength < 3) strength += 1;
    
    // 直近崩壊で減格
    if (hasRecentBreak && strength > 1) strength -= 1;
  }
  
  return Math.max(1, Math.min(3, strength));
}

export default async function analyzeSupportResistance(
  pair: string = 'btc_jpy',
  { lookbackDays = 90, topN = 3, tolerance = 0.015 }: AnalyzeSupportResistanceOptions = {}
) {
  const chk = ensurePair(pair);
  if (!chk.ok) {
    return AnalyzeSupportResistanceOutputSchema.parse(
      fail(chk.error.message, chk.error.type)
    ) as any;
  }

  try {
    // ローソク足データ取得
    const candlesRes: any = await getCandles(chk.pair, '1day', undefined as any, lookbackDays + 10);
    if (!candlesRes?.ok) {
      return AnalyzeSupportResistanceOutputSchema.parse(
        fail(candlesRes?.summary || 'candles failed', (candlesRes?.meta as any)?.errorType || 'internal')
      ) as any;
    }

    const candles = candlesRes.data.normalized || [];
    if (candles.length === 0) {
      return AnalyzeSupportResistanceOutputSchema.parse(
        fail('No candle data available', 'data')
      ) as any;
    }

    const currentCandle = candles[candles.length - 1];
    const currentPrice = currentCandle.close;

    // 価格レベル検出
    const { supports, resistances } = findPriceLevels(candles, currentPrice, tolerance, lookbackDays);

    // 新サポート形成の検出
    const newSupports = detectNewSupport(candles, 10);
    
    // 崩壊・突破を記録
    const brokenSupports = new Map<number, { date: string; price: number }>();
    const brokenResistances = new Map<number, { date: string; price: number }>();
    
    for (const [level] of supports.entries()) {
      const recentBreak = detectRecentBreak(level, 'support', candles, 30);
      if (recentBreak) {
        brokenSupports.set(level, { date: recentBreak.date, price: recentBreak.price });
      }
    }
    
    for (const [level] of resistances.entries()) {
      const recentBreak = detectRecentBreak(level, 'resistance', candles, 30);
      if (recentBreak) {
        brokenResistances.set(level, { date: recentBreak.date, price: recentBreak.price });
      }
    }
    
    // ロールリバーサル検出
    const { newResistances, newSupports: roleReversalSupports } = detectRoleReversal(
      brokenSupports,
      brokenResistances,
      candles,
      currentPrice
    );

    // 平均出来高計算
    const avgVolume = candles.reduce((sum: number, c: any) => sum + (c.volume || 0), 0) / candles.length;

    // サポートレベルを評価
    const supportLevels: SupportResistanceLevel[] = [];
    
    // A. 従来型サポート（崩壊していないもの）
    for (const [level, touches] of supports.entries()) {
      const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;
      
      if (pctFromCurrent >= 0) continue;
      if (Math.abs(pctFromCurrent) > 20) continue;
      if (touches.length < 2) continue;

      const recentTouches = touches.filter(t => {
        const touchDate = new Date(t.date);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return touchDate >= thirtyDaysAgo;
      });

      const recentBreak = detectRecentBreak(level, 'support', candles, 7);
      if (recentBreak) continue; // 直近7日で崩壊したものは除外
      
      const volumeBoost = touches.some(t => {
        const candle = candles.find((c: any) => c.isoTime.split('T')[0] === t.date);
        return candle && (candle.volume || 0) > avgVolume * 1.5;
      });

      const strength = calculateStrength(touches.length, recentTouches.length, false, volumeBoost, 'traditional');

      supportLevels.push({
        price: level,
        pctFromCurrent,
        strength,
        label: '',
        touchCount: touches.length,
        touches,
        type: 'support',
        formationType: 'traditional',
        volumeBoost
      });
    }
    
    // B. 新形成サポート
    for (const newSup of newSupports) {
      const pctFromCurrent = ((newSup.price - currentPrice) / currentPrice) * 100;
      if (pctFromCurrent >= 0 || Math.abs(pctFromCurrent) > 20) continue;
      
      const isDuplicate = supportLevels.some(s => Math.abs(s.price - newSup.price) < newSup.price * tolerance);
      if (isDuplicate) continue;
      
      const strength = calculateStrength(0, 0, false, newSup.volumeBoost, 'new_formation');
      
      supportLevels.push({
        price: newSup.price,
        pctFromCurrent,
        strength,
        label: '',
        touchCount: 1,
        touches: [{ date: newSup.date, price: newSup.price, bounceStrength: 0, type: 'support' }],
        type: 'support',
        formationType: 'new_formation',
        volumeBoost: newSup.volumeBoost,
        note: newSup.note
      });
    }
    
    // C. ロールリバーサル（元レジスタンス → サポート転換）
    for (const [level, note] of roleReversalSupports.entries()) {
      const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;
      if (pctFromCurrent >= 0 || Math.abs(pctFromCurrent) > 20) continue;
      
      const isDuplicate = supportLevels.some(s => Math.abs(s.price - level) < level * tolerance);
      if (isDuplicate) continue;
      
      const strength = calculateStrength(0, 0, false, false, 'role_reversal');
      
      supportLevels.push({
        price: level,
        pctFromCurrent,
        strength,
        label: '',
        touchCount: 1,
        touches: [],
        type: 'support',
        formationType: 'role_reversal',
        note
      });
    }

    // レジスタンスレベルを評価
    const resistanceLevels: SupportResistanceLevel[] = [];
    
    // A. 従来型レジスタンス（突破されていないもの）
    for (const [level, touches] of resistances.entries()) {
      const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;
      
      if (pctFromCurrent <= 0) continue;
      if (Math.abs(pctFromCurrent) > 20) continue;
      if (touches.length < 2) continue;

      const recentTouches = touches.filter(t => {
        const touchDate = new Date(t.date);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return touchDate >= thirtyDaysAgo;
      });

      const recentBreak = detectRecentBreak(level, 'resistance', candles, 7);
      if (recentBreak) continue; // 直近7日で突破されたものは除外
      
      const volumeBoost = touches.some(t => {
        const candle = candles.find((c: any) => c.isoTime.split('T')[0] === t.date);
        return candle && (candle.volume || 0) > avgVolume * 1.5;
      });

      const strength = calculateStrength(touches.length, recentTouches.length, false, volumeBoost, 'traditional');

      resistanceLevels.push({
        price: level,
        pctFromCurrent,
        strength,
        label: '',
        touchCount: touches.length,
        touches,
        type: 'resistance',
        formationType: 'traditional',
        volumeBoost
      });
    }
    
    // B. ロールリバーサル（元サポート → レジスタンス転換）
    for (const [level, note] of newResistances.entries()) {
      const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;
      if (pctFromCurrent <= 0 || Math.abs(pctFromCurrent) > 20) continue;
      
      const isDuplicate = resistanceLevels.some(r => Math.abs(r.price - level) < level * tolerance);
      if (isDuplicate) continue;
      
      const strength = calculateStrength(0, 0, false, false, 'role_reversal');
      
      resistanceLevels.push({
        price: level,
        pctFromCurrent,
        strength,
        label: '',
        touchCount: 1,
        touches: [],
        type: 'resistance',
        formationType: 'role_reversal',
        note
      });
    }

    // ソート（現在価格に近い順、同じ距離なら強度順）
    supportLevels.sort((a, b) => {
      const distA = Math.abs(a.pctFromCurrent);
      const distB = Math.abs(b.pctFromCurrent);
      if (Math.abs(distA - distB) < 0.5) {
        return b.strength - a.strength;
      }
      return distA - distB;
    });

    resistanceLevels.sort((a, b) => {
      const distA = Math.abs(a.pctFromCurrent);
      const distB = Math.abs(b.pctFromCurrent);
      if (Math.abs(distA - distB) < 0.5) {
        return b.strength - a.strength;
      }
      return distA - distB;
    });

    // 有効なレベルのみ出力（topN個まで、無理に埋めない）
    const topSupports = supportLevels.slice(0, Math.min(supportLevels.length, topN));
    const topResistances = resistanceLevels.slice(0, Math.min(resistanceLevels.length, topN));

    // ラベルを付与（タイプに関わらず統一表記）
    topSupports.forEach((level) => {
      level.label = `サポート`;
    });
    
    topResistances.forEach((level) => {
      level.label = `レジスタンス`;
    });

    // content生成（LLMが読みやすいフォーマット）
    const formatLevel = (level: SupportResistanceLevel, type: 'support' | 'resistance') => {
      // 3段階表記：★☆☆ / ★★☆ / ★★★
      const stars = '★'.repeat(level.strength) + '☆'.repeat(3 - level.strength);
      let text = `${level.label}: ${level.price.toLocaleString()}円（${level.pctFromCurrent > 0 ? '+' : ''}${level.pctFromCurrent.toFixed(1)}%）強度：${stars}\n`;
      
      // 形成タイプに応じた平易な説明
      if (level.formationType === 'new_formation') {
        // 新形成サポート
        text += `  - 背景: ${level.note || '直近で底を打ち、安値を切り上げ中'}\n`;
        if (level.volumeBoost) {
          text += `  - 特徴: 大出来高での反発（平均の1.5倍以上）\n`;
        }
        text += `  - 意義: 直近の最安値、形成されたばかりの下支え\n`;
      } else if (level.formationType === 'role_reversal') {
        // ロールリバーサル
        if (type === 'support') {
          text += `  - 背景: ${level.note || '以前に上抜けした価格帯。現在は「上抜け後の下支え」として機能する可能性'}\n`;
          text += `  - 注意: 転換直後で信頼性未確認、再割れリスクあり（強度★）\n`;
        } else {
          text += `  - 背景: ${level.note || '以前に崩壊した価格帯。現在は「戻り売りポイント」として機能する可能性'}\n`;
          text += `  - 注意: 転換直後で信頼性未確認、再突破される可能性あり（強度★）\n`;
        }
      } else {
        // 従来型
        text += `  - 実績: ${level.touchCount}回の反応`;
        if (level.touches.length > 0) {
          const dates = level.touches.slice(-3).map(t => t.date).join(', ');
          text += `（最近: ${dates}）`;
        }
        text += `\n`;
        if (level.volumeBoost) {
          text += `  - 特徴: 大出来高での反応あり（強度補強済み）\n`;
        }
        text += `  - 意義: 過去の実績から信頼性高い\n`;
      }
      
      if (level.recentBreak) {
        text += `  - ⚠️ 直近の崩壊: ${level.recentBreak.date}に${Math.abs(level.recentBreak.breakPct).toFixed(1)}%${type === 'support' ? '下抜け' : '上抜け'}（${type === 'support' ? '最安' : '最高'}${level.recentBreak.price.toLocaleString()}円）\n`;
        text += `  - 評価: 崩壊実績により信頼性低下、${type === 'support' ? '再割れ' : '再突破'}リスク高\n`;
      }
      
      return text;
    };

    let contentText = `BTC/JPY サポート・レジスタンス分析（過去${lookbackDays}日）\n`;
    contentText += `現在価格: ${currentPrice.toLocaleString()}円\n`;
    contentText += `分析日時: ${currentCandle.isoTime.split('T')[0]}\n\n`;
    
    contentText += `【サポートライン】\n`;
    if (topSupports.length === 0) {
      contentText += `  明確なサポートラインは検出されませんでした\n`;
    } else {
      topSupports.forEach(level => {
        contentText += formatLevel(level, 'support') + '\n';
      });
    }
    
    contentText += `\n【レジスタンスライン】\n`;
    if (topResistances.length === 0) {
      contentText += `  明確なレジスタンスラインは検出されませんでした\n`;
    } else {
      topResistances.forEach(level => {
        contentText += formatLevel(level, 'resistance') + '\n';
      });
    }

    contentText += `\n【判定ロジック】\n`;
    contentText += `A. 従来型: 過去90日で反発/反落2回以上、直近7日で崩壊なし\n`;
    contentText += `B. 新形成: 安値2日以上切り上げ + 以降割れなし（出来高1.5倍以上で強度+1）\n`;
    contentText += `C. 転換型: 崩壊したサポート→レジスタンス転換、突破したレジスタンス→サポート転換\n`;
    contentText += `- 強度判定: 接触回数・直近の維持・出来高を総合評価\n`;
    contentText += `- 直近7日で崩壊/突破した価格帯は従来型から除外、転換型候補へ\n`;

    const summary = formatSummary({
      pair: chk.pair,
      latest: currentPrice,
      extra: `supports=${topSupports.length} resistances=${topResistances.length}`
    });

    const data = {
      currentPrice,
      analysisDate: currentCandle.isoTime,
      lookbackDays,
      supports: topSupports,
      resistances: topResistances,
      detectionCriteria: {
        supportBounceMin: 0.3,
        resistanceRejectMin: 0.3,
        recentBreakWindow: 7,
        tolerance
      }
    };

    const meta = createMeta(chk.pair, {
      lookbackDays,
      topN,
      supportCount: topSupports.length,
      resistanceCount: topResistances.length
    });

    return AnalyzeSupportResistanceOutputSchema.parse({
      ok: true,
      summary,
      content: [{ type: 'text', text: contentText }],
      data,
      meta
    }) as any;

  } catch (err: any) {
    return AnalyzeSupportResistanceOutputSchema.parse(
      fail(err?.message || 'Analysis error', 'internal')
    ) as any;
  }
}

