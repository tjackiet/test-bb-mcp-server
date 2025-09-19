// tools/render_chart_svg.ts
import fs from 'fs/promises';
import path from 'path';
import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';
import type { Result, Pair, CandleType, RenderChartSvgOptions, ChartPayload } from '../src/types/domain.d.ts';

type RenderData = { svg?: string; filePath?: string; legend?: Record<string, string> };
type RenderMeta = { pair: Pair; type: CandleType | string; limit?: number; indicators?: string[]; bbMode: 'default' | 'extended' };

export default async function renderChartSvg(args: RenderChartSvgOptions = {}): Promise<Result<RenderData, RenderMeta>> {
  // --- パラメータの解決（強制排他ルール） ---
  const withIchimoku = args.withIchimoku ?? false;
  const ichimokuOpt = args.ichimoku || {};
  // モード正規化: light→default, full→extended（後方互換）
  const normalizeIchimokuMode = (m: unknown): 'default' | 'extended' => {
    const s = String(m ?? '').toLowerCase();
    if (s === 'full' || s === 'extended') return 'extended';
    if (s === 'light' || s === 'default') return 'default';
    return 'default';
  };
  const ichimokuMode = normalizeIchimokuMode((ichimokuOpt as any).mode || (withIchimoku ? 'default' : 'default'));
  const drawChikou = ichimokuMode === 'extended' || (ichimokuOpt as any).withChikou === true;

  // デフォルト: 明示されない限りSMAは描画しない
  // 互換: 以前の仕様からの流入に備え、withIchimoku時は引き続きBB/SMAをオフ
  let withSMA = args.withSMA ?? [];
  let withBB = args.withBB ?? (withIchimoku ? false : false);
  const svgPrecision = Math.max(0, Math.min(3, Number((args as any)?.svgPrecision ?? 0)));
  const svgMinify = (args as any)?.svgMinify !== false;
  const simplifyTolerance = Math.max(0, Number((args as any)?.simplifyTolerance ?? 0));
  const viewBoxTight = (args as any)?.viewBoxTight !== false;
  // BBモード正規化: light→default, full→extended（後方互換）
  const normalizeBbMode = (m: unknown): 'default' | 'extended' => {
    const s = String(m ?? '').toLowerCase();
    if (s === 'full' || s === 'extended') return 'extended';
    if (s === 'light' || s === 'default') return 'default';
    return 'default';
  };
  const bbMode: 'default' | 'extended' = normalizeBbMode(args.bbMode || 'default');
  if (withIchimoku) {
    withSMA = [];
    withBB = false;
  }

  const {
    pair = 'btc_jpy',
    // normalize to CandleType-like values (historically 'day' was used)
    type = '1day',
    limit = 60,
    withLegend = true,
  } = args;

  // --- 事前見積もりヒューリスティクス（重そうなら candles-only にフォールバック） ---
  const estimatedLayers = (withIchimoku ? 1 : 0) + (withBB ? (bbMode === 'extended' ? 3 : 1) : 0) + (Array.isArray(withSMA) ? withSMA.length : 0) + 1; // +1 for candles
  let summaryNotes: string[] = [];
  if (limit * estimatedLayers > 500) {
    if (withBB || (withSMA && withSMA.length > 0) || withIchimoku) {
      withBB = false;
      withSMA = [];
      if (withIchimoku) {
        // keep user intent for ichimoku unless very heavy
        if (limit * (1 + (bbMode === 'extended' ? 3 : 1)) > 800) {
          // fallback to candles only if still heavy
          (args as any).withIchimoku = false;
        }
      }
      summaryNotes.push('heavy chart detected → fallback to candles-only to avoid oversized SVG');
    }
  }

  // ★ データ取得はバッファ計算をgetIndicatorsに任せる
  const internalLimit = withIchimoku ? limit + 26 : limit;
  const res = await getIndicators(pair, type as any, internalLimit);
  if (!res?.ok) {
    return fail(res?.summary?.replace?.(/^Error: /, '') || 'failed to fetch indicators', (res as any)?.meta?.errorType || 'internal');
  }

  const chartData = res.data?.chart as ChartPayload;
  const items = chartData?.candles || [];
  const indicators = chartData?.indicators as Record<string, any>;
  const pastBuffer = chartData.meta?.pastBuffer ?? 0;
  const forwardShift = chartData.meta?.shift ?? 0;
  const displayItems = items.slice(pastBuffer);

  if (!items?.length) {
    return fail('No candle data available to render SVG chart.', 'user');
  }

  // Y軸スケール用の "きれいな" 目盛りを生成する関数
  function niceTicks(min: number, max: number, count = 5): number[] {
    if (max < min) [min, max] = [max, min];
    const range = max - min;
    if (range === 0) return [min];

    // stepが極小値になるのを防ぐ
    const step = Math.max(1e-9, Math.pow(10, Math.floor(Math.log10(range / count))));
    const err = (count * step) / range;

    let niceStep: number;
    if (err <= 0.15) niceStep = step * 10;
    else if (err <= 0.35) niceStep = step * 5;
    else if (err <= 0.75) niceStep = step * 2;
    else niceStep = step;

    // JSの浮動小数点誤差を吸収するため、toFixedで丸める
    const precision = Math.max(0, -Math.floor(Math.log10(niceStep)));
    const niceMin = Math.round(min / niceStep) * niceStep;
    const ticks: number[] = [];
    // 無限ループ対策
    for (let v = niceMin; ticks.length < 20 && v <= max * 1.01; v += niceStep) {
      ticks.push(Number(v.toFixed(precision)));
    }

    return ticks;
  }

  const xs = displayItems.map((_, i) => i);
  const highs = displayItems.map((d: any) => d.high as number);
  const lows = displayItems.map((d: any) => d.low as number);
  const xMin = 0;
  const xMax = xs.length - 1;
  // forwardShift は上部で meta.shift から取得済み

  // Y軸の範囲を、表示されるすべての要素から計算
  const allYValues: number[] = [
    ...highs,
    ...lows,
  ];
  if (withIchimoku) {
    allYValues.push(...(indicators.ICHI_tenkan?.slice(pastBuffer).filter((v: number | null) => v !== null) || []));
    allYValues.push(...(indicators.ICHI_kijun?.slice(pastBuffer).filter((v: number | null) => v !== null) || []));
    allYValues.push(...(indicators.ICHI_spanA?.slice(pastBuffer).filter((v: number | null) => v !== null) || []));
    allYValues.push(...(indicators.ICHI_spanB?.slice(pastBuffer).filter((v: number | null) => v !== null) || []));
  }
  if (withBB) {
    if (bbMode === 'extended') {
      ['BB1_upper', 'BB1_lower', 'BB2_upper', 'BB2_lower', 'BB3_upper', 'BB3_lower'].forEach((key) => {
        const series = indicators[key]?.slice?.(pastBuffer) || [];
        allYValues.push(...series.filter((v: number | null) => v !== null));
      });
    } else {
      allYValues.push(...(indicators.BB_upper?.slice(pastBuffer).filter((v: number | null) => v !== null) || []));
      allYValues.push(...(indicators.BB_lower?.slice(pastBuffer).filter((v: number | null) => v !== null) || []));
    }
  }
  if (withSMA && withSMA.length > 0) {
    const pickSmaSeries = (p: number) => {
      switch (p) {
        case 5: return indicators.SMA_5 as number[] | undefined;
        case 20: return indicators.SMA_20 as number[] | undefined;
        case 25: return indicators.SMA_25 as number[] | undefined;
        case 50: return indicators.SMA_50 as number[] | undefined;
        case 75: return indicators.SMA_75 as number[] | undefined;
        case 200: return indicators.SMA_200 as number[] | undefined;
        default: return undefined;
      }
    };
    withSMA.forEach((period) => {
      const series = pickSmaSeries(period) || [];
      allYValues.push(...(series.slice(pastBuffer).filter((v: number | null) => v !== null)));
    });
  }

  const dataYMin = Math.min(...allYValues);
  const dataYMax = Math.max(...allYValues);
  const yAxisMinWithBuffer = dataYMin * 0.95;
  const yAxisMaxWithBuffer = dataYMax * 1.05;
  const yTicks = niceTicks(yAxisMinWithBuffer, yAxisMaxWithBuffer, 6);
  const yMin = yTicks[0];
  const yMax = yTicks.at(-1) as number;

  // Y軸ラベルの最大幅に基づいてpadding.leftを動的に調整
  const maxLabelWidth = Math.max(...yTicks.map((v) => v.toLocaleString().length));
  const dynamicPaddingLeft = maxLabelWidth * 8 + 16; // 1文字8pxと仮定 + 余白

  // スケール計算
  const w = 860;
  const h = 420;
  // 上部に余白を多めに確保（凡例が詰まらないように）
  const padding = viewBoxTight ? { top: 36, right: 12, bottom: 32, left: dynamicPaddingLeft } : { top: 48, right: 16, bottom: 40, left: dynamicPaddingLeft };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  // X座標計算: 描画ウィンドウ内での相対位置を計算
  const x = (i: number) => padding.left + (i * plotW) / Math.max(1, xMax + forwardShift);
  const y = (v: number) => h - padding.bottom - ((v - yMin) * plotH) / Math.max(1, yMax - yMin);

  // --- 凡例メタデータと描画レイヤーの準備 ---
  const legendMeta: Record<string, string> = {};
  let legendLayers = '';

  const barW = Math.max(2, (plotW / Math.max(1, xs.length)) * 0.6);

  // ローソク（棒＋ヒゲ）
  const sticks = displayItems
    .map((d: any, i: number) => {
      const cx = x(i);
      return `<line x1="${cx}" y1="${y(d.high)}" x2="${cx}" y2="${y(d.low)
        }" stroke="#9ca3af" stroke-width="1"/>`;
    })
    .join('');

  const bodies = displayItems
    .map((d: any, i: number) => {
      const cx = x(i) - barW / 2;
      const o = y(d.open);
      const c = y(d.close);
      const top = Math.min(o, c);
      const bot = Math.max(o, c);
      const up = d.close >= d.open;
      return `<rect x="${cx}" y="${top}" width="${barW}" height="${Math.max(
        1,
        bot - top
      )}" fill="${up ? '#16a34a' : '#ef4444'}"/>`;
    })
    .join('');

  // --- インジケータ描画 ---
  const smaColors: Record<number, string> = { 5: '#f472b6', 20: '#a78bfa', 25: '#3b82f6', 50: '#22d3ee', 75: '#f59e0b', 200: '#10b981' };
  const bbColors = {
    bandFill2: 'rgba(59, 130, 246, 0.10)', // 2σバンド塗り
    line1: '#9ca3af', // ±1σ
    line2: '#3b82f6', // ±2σ
    line3: '#f59e0b', // ±3σ
    middle: '#9ca3af',
  } as const;

  // 汎用的なライン描画関数
  const round = (v: number) => Number(v.toFixed(svgPrecision));
  const createLinePath = (data: Array<number | null> | undefined, color: string, options: { dash?: string; width?: string; offset?: number; simplify?: boolean } = {}) => {
    if (!data || data.length === 0) return '';
    type Pt = { x: number; y: number };
    let raw: Pt[] = [];
    const offset = options.offset || 0; // 先行(+26) / 遅行(-26)
    data.forEach((val, i) => {
      if (val !== null && typeof val === 'number') {
        raw.push({ x: x(i - pastBuffer + offset), y: y(val) });
      }
    });
    if (raw.length === 0) return '';
    // RDP風の単純化
    const doSimplify = options.simplify !== false && simplifyTolerance > 0 && raw.length > 2;
    if (doSimplify) {
      const sqTol = simplifyTolerance * simplifyTolerance;
      const simplified: Pt[] = [];
      const keep = (a: Pt, b: Pt, c: Pt) => {
        // 二点直線からの距離（二乗）で判定
        const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        const dx = c.x - a.x; const dy = c.y - a.y; const len2 = dx * dx + dy * dy || 1;
        return (area * area) / len2 >= sqTol;
      };
      simplified.push(raw[0]);
      for (let i = 1; i < raw.length - 1; i++) {
        if (keep(raw[i - 1], raw[i], raw[i + 1])) simplified.push(raw[i]);
      }
      simplified.push(raw[raw.length - 1]);
      raw = simplified;
    }
    const points = raw.map(p => `${round(p.x)},${round(p.y)}`);
    const d = 'M ' + points.join(' L ');
    const dash = options.dash ? `stroke-dasharray="${options.dash}"` : '';
    const width = options.width || '2';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${dash}/>`;
  };

  // --- 型安全なインジケータ参照ヘルパー ---
  const bbSeries = {
    getUpper: (mode: 'default' | 'extended') => mode === 'extended' ? indicators?.BB2_upper : indicators?.BB_upper,
    getMiddle: (mode: 'default' | 'extended') => mode === 'extended' ? indicators?.BB2_middle : indicators?.BB_middle,
    getLower: (mode: 'default' | 'extended') => mode === 'extended' ? indicators?.BB2_lower : indicators?.BB_lower,
    getBand: (sigma: 1 | 2 | 3) => {
      switch (sigma) {
        case 1:
          return { upper: indicators?.BB1_upper, middle: indicators?.BB1_middle, lower: indicators?.BB1_lower };
        case 2:
          return { upper: indicators?.BB2_upper, middle: indicators?.BB2_middle, lower: indicators?.BB2_lower };
        case 3:
          return { upper: indicators?.BB3_upper, middle: indicators?.BB3_middle, lower: indicators?.BB3_lower };
        default:
          return { upper: undefined, middle: undefined, lower: undefined } as any;
      }
    },
  } as const;

  const ichiSeries = {
    tenkan: indicators?.ICHI_tenkan as Array<number | null> | undefined,
    kijun: indicators?.ICHI_kijun as Array<number | null> | undefined,
    spanA: indicators?.ICHI_spanA as Array<number | null> | undefined,
    spanB: indicators?.ICHI_spanB as Array<number | null> | undefined,
    chikou: indicators?.ICHI_chikou as Array<number | null> | undefined,
  } as const;

  // SMAレイヤー
  const sma5 = (indicators?.SMA_5 || []) as Array<number | null>;
  const sma20 = (indicators?.SMA_20 || []) as Array<number | null>;
  const sma25 = (indicators?.SMA_25 || []) as Array<number | null>;
  const sma50 = (indicators?.SMA_50 || []) as Array<number | null>;
  const sma75 = (indicators?.SMA_75 || []) as Array<number | null>;
  const sma200 = (indicators?.SMA_200 || []) as Array<number | null>;
  let smaLayers = '';
  // インジケーターは簡略化しない（見た目の忠実度を優先）
  if (withSMA?.includes(5) && sma5.length > 0) smaLayers += createLinePath(sma5, smaColors[5], { simplify: false });
  if (withSMA?.includes(20) && sma20.length > 0) smaLayers += createLinePath(sma20, smaColors[20], { simplify: false });
  if (withSMA?.includes(25) && sma25.length > 0) smaLayers += createLinePath(sma25, smaColors[25], { simplify: false });
  if (withSMA?.includes(50) && sma50.length > 0) smaLayers += createLinePath(sma50, smaColors[50], { simplify: false });
  if (withSMA?.includes(75) && sma75.length > 0) smaLayers += createLinePath(sma75, smaColors[75], { simplify: false });
  if (withSMA?.includes(200) && sma200.length > 0) smaLayers += createLinePath(sma200, smaColors[200], { simplify: false });

  // ボリンジャーバンド
  let bbLayers = '';
  if (withBB) {
    type Point = { x: number; y: number };
    const createPoints = (data?: Array<number | null>): Point[] => {
      const points: Point[] = [];
      data?.forEach?.((val, i) => {
        if (val !== null && val !== undefined) {
          points.push({ x: x(i - pastBuffer), y: y(val) });
        }
      });
      return points;
    };
    const createPathFromPoints = (points?: Point[]): string => {
      if (!points || points.length === 0) return '';
      return 'M ' + points.map((p) => `${round(p.x)},${round(p.y)}`).join(' L ');
    };

    const makeBand = (upperSeries?: Array<number | null>, lowerSeries?: Array<number | null>) => {
      const upperPoints = createPoints(upperSeries);
      const lowerPoints = createPoints(lowerSeries);
      const upperPath = createPathFromPoints(upperPoints);
      const lowerPath = createPathFromPoints(lowerPoints);
      let bandPath = '';
      if (upperPoints.length > 0 && lowerPoints.length > 0) {
        const lowerPointsReversed = [...lowerPoints].reverse();
        const allPoints = [...upperPoints, ...lowerPointsReversed];
        bandPath = createPathFromPoints(allPoints) + ' Z';
      }
      return { upperPath, lowerPath, bandPath };
    };

    if (bbMode === 'extended') {
      // ±2σのバンド塗り
      const band2 = makeBand(bbSeries.getBand(2).upper, bbSeries.getBand(2).lower);
      bbLayers += `
        <path d="${band2.bandPath}" fill="${bbColors.bandFill2}" stroke="none" />
      `;
      // ±1σ ライン（グレー）
      const p1u = createPathFromPoints(createPoints(bbSeries.getBand(1).upper));
      const p1l = createPathFromPoints(createPoints(bbSeries.getBand(1).lower));
      bbLayers += `
        <path d="${p1u}" fill="none" stroke="${bbColors.line1}" stroke-width="1"/>
        <path d="${p1l}" fill="none" stroke="${bbColors.line1}" stroke-width="1"/>
      `;
      // ±2σ ライン（青） + 中央線（灰の破線）
      const p2u = createPathFromPoints(createPoints(bbSeries.getBand(2).upper));
      const p2m = createPathFromPoints(createPoints(bbSeries.getBand(2).middle));
      const p2l = createPathFromPoints(createPoints(bbSeries.getBand(2).lower));
      bbLayers += `
        <path d="${p2u}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${p2l}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${p2m}" fill="none" stroke="${bbColors.middle}" stroke-width="1" stroke-dasharray="4 4"/>
      `;
      // ±3σ ライン（オレンジ）
      const p3u = createPathFromPoints(createPoints(bbSeries.getBand(3).upper));
      const p3l = createPathFromPoints(createPoints(bbSeries.getBand(3).lower));
      bbLayers += `
        <path d="${p3u}" fill="none" stroke="${bbColors.line3}" stroke-width="1"/>
        <path d="${p3l}" fill="none" stroke="${bbColors.line3}" stroke-width="1"/>
      `;
    } else {
      // light: 互換キー（±2σ）のみを使って従来描画
      const band2 = makeBand(bbSeries.getUpper('default'), bbSeries.getLower('default'));
      const mid2 = createPathFromPoints(createPoints(bbSeries.getMiddle('default')));
      bbLayers = `
        <path d="${band2.bandPath}" fill="${bbColors.bandFill2}" stroke="none" />
        <path d="${band2.upperPath}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${band2.lowerPath}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${mid2}" fill="none" stroke="${bbColors.middle}" stroke-width="1" stroke-dasharray="4 4"/>
      `;
    }
  }

  // 一目均衡表
  let ichimokuLayers = '';
  if (withIchimoku && ichiSeries.tenkan) {
    const tenkanPath = createLinePath(ichiSeries.tenkan, '#00a3ff', { width: '1', offset: 0 });
    const kijunPath = createLinePath(ichiSeries.kijun, '#ff4d4d', { width: '1', offset: 0 });
    const chikouPath = drawChikou ? createLinePath(ichiSeries.chikou, '#16a34a', { width: '1', dash: '2 2', offset: -26 }) : '';
    const spanAPath = createLinePath(ichiSeries.spanA, '#16a34a', { width: '1', offset: 26 });
    const spanBPath = createLinePath(ichiSeries.spanB, '#ef4444', { width: '1', offset: 26 });

    // 雲の描画（交点で色切替）
    const createCloudPaths = (spanA?: Array<number | null>, spanB?: Array<number | null>, offset?: number) => {
      let greenCloudPath = '';
      let redCloudPath = '';
      let currentTop: Array<{ x: number; y: number }> = [];
      let currentBottom: Array<{ x: number; y: number }> = [];
      let currentIsGreen: boolean | null = null;
      const pushPolygon = () => {
        if (currentTop.length < 2 || currentBottom.length < 2) return;
        const polygon = 'M ' + [...currentTop, ...currentBottom.slice().reverse()]
          .map(p => `${p.x},${p.y}`)
          .join(' L ') + ' Z';
        if (currentIsGreen) greenCloudPath += polygon; else redCloudPath += polygon;
      };
      const toPoint = (i: number, yVal: number) => ({ x: x(i - pastBuffer + (offset || 0)), y: y(yVal) });
      const len = Math.max(spanA?.length || 0, spanB?.length || 0);
      for (let i = 0; i < len - 1; i++) {
        const a0 = spanA?.[i] as number | null; const b0 = spanB?.[i] as number | null;
        const a1 = spanA?.[i + 1] as number | null; const b1 = spanB?.[i + 1] as number | null;
        if (a0 == null || b0 == null || a1 == null || b1 == null || !isFinite(a0) || !isFinite(b0) || !isFinite(a1) || !isFinite(b1)) {
          pushPolygon(); currentTop = []; currentBottom = []; currentIsGreen = null; continue;
        }
        const isGreen0 = a0 >= b0; const isGreen1 = a1 >= b1;
        if (currentIsGreen === null) { currentIsGreen = isGreen0; currentTop.push(toPoint(i, currentIsGreen ? a0 : b0)); currentBottom.push(toPoint(i, currentIsGreen ? b0 : a0)); }
        if (isGreen0 === isGreen1) { currentTop.push(toPoint(i + 1, currentIsGreen ? a1 : b1)); currentBottom.push(toPoint(i + 1, currentIsGreen ? b1 : a1)); continue; }
        const da = a1 - a0; const db = b1 - b0; const denom = (da - db); const t = denom === 0 ? 0 : (a0 - b0) / denom; const tClamped = Math.max(0, Math.min(1, t));
        const xi = i + tClamped; const yi = a0 + tClamped * da; const pInt = toPoint(xi, yi);
        currentTop.push(pInt); currentBottom.push(pInt); pushPolygon();
        currentIsGreen = isGreen1; currentTop = [pInt, toPoint(i + 1, currentIsGreen ? a1 : b1)]; currentBottom = [pInt, toPoint(i + 1, currentIsGreen ? b1 : a1)];
      }
      pushPolygon();
      return { greenCloudPath, redCloudPath };
    };

    const { greenCloudPath, redCloudPath } = createCloudPaths(ichiSeries.spanA, ichiSeries.spanB, 26);

    ichimokuLayers = `
      <path d="${greenCloudPath}" fill="rgba(16, 163, 74, 0.16)" stroke="none" />
      <path d="${redCloudPath}" fill="rgba(239, 68, 68, 0.24)" stroke="none" />
      ${tenkanPath}
      ${kijunPath}
      ${chikouPath}
      ${spanAPath}
      ${spanBPath}
    `;
  }

  // --- 凡例の動的構築 ---
  if (withLegend) {
    const legendItems: Array<{ text: string; color: string }> = [];
    if (withSMA?.length > 0) {
      withSMA.forEach((p) => {
        legendMeta[`SMA_${p}`] = `SMA ${p} (${smaColors[p]})`;
        legendItems.push({ text: `SMA ${p}`, color: smaColors[p] || '#e5e7eb' });
      });
    }
    if (withBB) {
      if (bbMode === 'extended') {
        legendMeta.BB1 = 'BB ±1σ';
        legendMeta.BB2 = 'BB ±2σ';
        legendMeta.BB3 = 'BB ±3σ';
        legendItems.push({ text: 'BB ±1σ', color: bbColors.line1 });
        legendItems.push({ text: 'BB ±2σ', color: bbColors.line2 });
        legendItems.push({ text: 'BB ±3σ', color: bbColors.line3 });
      } else {
        legendMeta.BB = 'Bollinger Bands (±2σ)';
        legendItems.push({ text: 'BB ±2σ', color: bbColors.line2 });
      }
    }
    if (withIchimoku) {
      legendMeta.Ichimoku = '一目均衡表';
      legendItems.push({ text: '転換線', color: '#00a3ff' });
      legendItems.push({ text: '基準線', color: '#ff4d4d' });
    }

    let yOffset = Math.max(14, padding.top - 18);
    legendLayers = `<g font-size="12" fill="#e5e7eb">` + legendItems.map((item, i) => {
      const xPos = padding.left + (i * 130);
      return `<g transform="translate(${xPos}, ${yOffset})">
        <rect y="-10" width="12" height="12" fill="${item.color}"></rect>
        <text x="16" y="0">${item.text}</text>
      </g>`;
    }).join('') + `</g>`;
  }

  // Y軸 (価格)
  const yAxis = `
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>
    <g font-size="12" fill="#e5e7eb">
      ${yTicks.map(val => {
    const yPos = y(val);
    return `<text x="${padding.left - 8}" y="${yPos}" text-anchor="end" dominant-baseline="middle">${val.toLocaleString()}</text>`;
  }).join('')}
    </g>
  `;

  // X軸 (日付)
  const xAxis = `
    <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>
    <g font-size="12" fill="#e5e7eb">
      ${displayItems
      .map((d: any, i: number) => {
        const step = Math.max(1, Math.floor(displayItems.length / 5));
        if (i % step !== 0) return '';
        const xPos = x(i);
        const date = new Date(d.isoTime || d.time || d.timestamp);
        if (isNaN(date.getTime())) return '';
        const label = `${date.getMonth() + 1}/${date.getDate()}`;
        return `<text x="${xPos}" y="${h - padding.bottom + 16}" text-anchor="middle" fill="#e5e7eb" font-size="10">${label}</text>`;
      })
      .join('')}
    </g>
  `;

  // --- 2種類のSVGを構築 ---
  const createSvgString = (layers: { ichimoku: string; bb: string; sma: string }) => `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="background-color: #1f2937; color: #e5e7eb; font-family: sans-serif;">
      <title>${formatPair(pair)} ${type} chart</title>
      <defs>
        <clipPath id="plotArea">
          <rect x="${padding.left}" y="${padding.top}" width="${plotW}" height="${plotH}"/>
        </clipPath>
      </defs>
      <g class="axes">
        ${yAxis}
        ${xAxis}
      </g>
      <g class="plot-area" clip-path="url(#plotArea)">
        ${layers.ichimoku}
        ${layers.bb}
  ${sticks}
  ${bodies}
        ${layers.sma}
      </g>
      <g class="legend">
        ${legendLayers}
      </g>
    </svg>
  `;

  let fullSvg = createSvgString({ ichimoku: ichimokuLayers, bb: bbLayers, sma: smaLayers });
  let lightSvg = createSvgString({ ichimoku: withIchimoku ? ichimokuLayers : '', bb: bbLayers, sma: smaLayers });
  if (svgMinify) {
    const minify = (s: string) => s.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><');
    fullSvg = minify(fullSvg);
    lightSvg = minify(lightSvg);
  }

  // --- SVGをファイルに保存（フォールバック付き） ---
  const filenameSuffix = withIchimoku ? '_light' : '';
  const filename = `chart-${pair}-${type}-${Date.now()}${filenameSuffix}.svg`;
  const assetsDir = 'assets';
  const outputPath = path.join(assetsDir, filename);

  try {
    await fs.mkdir(assetsDir, { recursive: true });
    const finalSvg = withIchimoku ? lightSvg : fullSvg;
    await fs.writeFile(outputPath, finalSvg);
    const sizeBytes = Buffer.byteLength(finalSvg, 'utf8');
    const layerCount = estimatedLayers;
    const maxSvgBytes = (args as any)?.maxSvgBytes as number | undefined;
    const truncated = typeof maxSvgBytes === 'number' && sizeBytes > maxSvgBytes;

    let summary = `${formatPair(pair)} ${type} chart saved to ${outputPath}`;
    if (summaryNotes.length) summary += ` (${summaryNotes.join('; ')})`;
    return ok<RenderData, RenderMeta>(
      summary,
      { filePath: outputPath, svg: truncated ? undefined : lightSvg, legend: legendMeta },
      { pair: pair as Pair, type, limit, indicators: Object.keys(legendMeta), bbMode, range: { start: displayItems[0]?.isoTime || '', end: displayItems.at(-1)?.isoTime || '' }, sizeBytes, layerCount, truncated, fallback: summaryNotes[0] }
    );
  } catch (err) {
    console.warn(
      `[Warning] Failed to save SVG to ${outputPath}. Fallback to inline SVG.`,
      err
    );
    const summary = `${formatPair(pair)} ${type} chart (SVG, file save failed)`;
    return ok<RenderData, RenderMeta>(
      summary,
      { svg: lightSvg, legend: legendMeta },
      { pair: pair as Pair, type, limit, indicators: Object.keys(legendMeta), bbMode, range: { start: displayItems[0]?.isoTime || '', end: displayItems.at(-1)?.isoTime || '' } }
    );
  }
}


