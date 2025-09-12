// tools/render_chart_svg.js
import fs from 'fs/promises';
import path from 'path';
import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';

export default async function renderChartSvg(args = {}) {
  // --- パラメータの解決（強制排他ルール） ---
  const withIchimoku = args.withIchimoku ?? false;
  const ichimokuOpt = args.ichimoku || {};
  const ichimokuMode = ichimokuOpt.mode || (withIchimoku ? 'full' : 'light');
  const drawChikou = ichimokuMode === 'full' || ichimokuOpt.withChikou === true;
  
  // デフォルト（軽量版）: SMA 25/75/200
  // オプション: SMA 5/20/50 はユーザー指定時のみ追加描画
  let withSMA = args.withSMA ?? (withIchimoku ? [] : [25, 75, 200]);
  let withBB = args.withBB ?? (withIchimoku ? false : true);
  if (withIchimoku) {
    withSMA = [];
    withBB = false;
  }

  const {
  pair = 'btc_jpy',
    type = 'day',
  limit = 60,
    withLegend = true,
  } = args;

  // ★ データ取得はバッファ計算をgetIndicatorsに任せる
  const internalLimit = withIchimoku ? limit + 26 : limit;
  const res = await getIndicators(pair, type, internalLimit);
  if (!res?.ok) return res;

  const chartData = res.data?.chart;
  const items = chartData?.candles || [];
  const indicators = chartData?.indicators;
  const pastBuffer = chartData.meta?.pastBuffer ?? 0;
  const forwardShift = chartData.meta?.shift ?? 0;
  const displayItems = items.slice(pastBuffer);

  if (!items?.length) {
    return fail('No candle data available to render SVG chart.', 'user');
  }

  // Y軸スケール用の "きれいな" 目盛りを生成する関数
  function niceTicks(min, max, count = 5) {
    if (max < min) [min, max] = [max, min];
    const range = max - min;
    if (range === 0) return [min];
    
    // stepが極小値になるのを防ぐ
    const step = Math.max(1e-9, Math.pow(10, Math.floor(Math.log10(range / count))));
    const err = (count * step) / range;
  
    let niceStep;
    if (err <= 0.15) niceStep = step * 10;
    else if (err <= 0.35) niceStep = step * 5;
    else if (err <= 0.75) niceStep = step * 2;
    else niceStep = step;
    
    // JSの浮動小数点誤差を吸収するため、toFixedで丸める
    const precision = Math.max(0, -Math.floor(Math.log10(niceStep)));
    const niceMin = Math.round(min / niceStep) * niceStep;
    const ticks = [];
    // 無限ループ対策
    for (let v = niceMin; ticks.length < 20 && v <= max * 1.01; v += niceStep) {
      ticks.push(Number(v.toFixed(precision)));
    }
    
    return ticks;
  }

  const xs = displayItems.map((_, i) => i);
  const highs = displayItems.map((d) => d.high);
  const lows = displayItems.map((d) => d.low);
  const xMin = 0;
  const xMax = xs.length - 1;
  // forwardShift は上部で meta.shift から取得済み
  
  // Y軸の範囲を、表示されるすべての要素から計算
  const allYValues = [
    ...highs,
    ...lows,
  ];
  if (withIchimoku) {
    // インジケータのデータも表示範囲にスライスしてからY軸範囲計算に含める
    allYValues.push(...(indicators.ICHI_tenkan?.slice(pastBuffer).filter(v => v !== null) || []));
    allYValues.push(...(indicators.ICHI_kijun?.slice(pastBuffer).filter(v => v !== null) || []));
    allYValues.push(...(indicators.ICHI_spanA?.slice(pastBuffer).filter(v => v !== null) || []));
    allYValues.push(...(indicators.ICHI_spanB?.slice(pastBuffer).filter(v => v !== null) || []));
  }
  if (withBB) {
    allYValues.push(...(indicators.BB_upper?.slice(pastBuffer).filter(v => v !== null) || []));
    allYValues.push(...(indicators.BB_lower?.slice(pastBuffer).filter(v => v !== null) || []));
  }
  if (withSMA && withSMA.length > 0) {
    withSMA.forEach(period => {
      allYValues.push(...(indicators[`SMA_${period}`]?.slice(pastBuffer).filter(v => v !== null) || []));
    });
  }
  
  const dataYMin = Math.min(...allYValues);
  const dataYMax = Math.max(...allYValues);
  const yAxisMinWithBuffer = dataYMin * 0.95;
  const yAxisMaxWithBuffer = dataYMax * 1.05;
  const yTicks = niceTicks(yAxisMinWithBuffer, yAxisMaxWithBuffer, 6);
  const yMin = yTicks[0];
  const yMax = yTicks.at(-1);

  // Y軸ラベルの最大幅に基づいてpadding.leftを動的に調整
  const maxLabelWidth = Math.max(...yTicks.map(v => v.toLocaleString().length));
  const dynamicPaddingLeft = maxLabelWidth * 8 + 16; // 1文字8pxと仮定 + 余白

  // スケール計算
  const w = 860;
  const h = 420;
  // 上部に余白を多めに確保（凡例が詰まらないように）
  const padding = { top: 48, right: 16, bottom: 40, left: dynamicPaddingLeft };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  // X座標計算: 描画ウィンドウ内での相対位置を計算
  const x = (i) => padding.left + (i * plotW) / Math.max(1, xMax + forwardShift);

  const y = (v) =>
    h - padding.bottom - ((v - yMin) * plotH) / Math.max(1, yMax - yMin);

  // 先行表示時の左側欠けを埋めるための補正（26）
  const leftCompensation = withIchimoku ? 26 : 0;

  // --- 凡例メタデータと描画レイヤーの準備 ---
  const legendMeta = {};
  let legendLayers = '';

  const barW = Math.max(2, (plotW / Math.max(1, xs.length)) * 0.6);

  // ローソク（棒＋ヒゲ）
  const sticks = displayItems
    .map((d, i) => {
      const cx = x(i);
      return `<line x1="${cx}" y1="${y(d.high)}" x2="${cx}" y2="${
        y(d.low)
      }" stroke="#9ca3af" stroke-width="1"/>`;
    })
    .join('');

  const bodies = displayItems
    .map((d, i) => {
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
  const smaColors = { 5: '#f472b6', 20: '#a78bfa', 25: '#3b82f6', 50: '#22d3ee', 75: '#f59e0b', 200: '#10b981' };
  
  // 汎用的なライン描画関数
  const createLinePath = (data, color, options = {}) => {
    if (!data || data.length === 0) return '';
    const points = [];
    const offset = options.offset || 0; // 先行(+26) / 遅行(-26)
    data.forEach((val, i) => {
      if (val !== null && typeof val === 'number') {
        // ★ 座標計算時にpastBufferを引くことで、描画開始位置を揃える
        points.push(`${x(i - pastBuffer + offset)},${y(val)}`);
      }
    });
    if (points.length === 0) return '';
    const d = 'M ' + points.join(' L ');
    const dash = options.dash ? `stroke-dasharray="${options.dash}"` : '';
    const width = options.width || '2';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${dash}/>`;
  };
  
  // SMAレイヤー
  const sma5 = indicators?.SMA_5 || [];
  const sma20 = indicators?.SMA_20 || [];
  const sma25 = indicators?.SMA_25 || [];
  const sma50 = indicators?.SMA_50 || [];
  const sma75 = indicators?.SMA_75 || [];
  const sma200 = indicators?.SMA_200 || [];
  let smaLayers = '';
  if (withSMA?.includes(5) && sma5.length > 0) {
    smaLayers += createLinePath(sma5, smaColors[5]);
  }
  if (withSMA?.includes(20) && sma20.length > 0) {
    smaLayers += createLinePath(sma20, smaColors[20]);
  }
  if (withSMA?.includes(25) && sma25.length > 0) {
    smaLayers += createLinePath(sma25, smaColors[25]);
  }
  if (withSMA?.includes(50) && sma50.length > 0) {
    smaLayers += createLinePath(sma50, smaColors[50]);
  }
  if (withSMA?.includes(75) && sma75.length > 0) {
    smaLayers += createLinePath(sma75, smaColors[75]);
  }
  if (withSMA?.includes(200) && sma200.length > 0) {
    smaLayers += createLinePath(sma200, smaColors[200]);
  }

  // ボリンジャーバンド
  let bbLayers = '';
  if (
    withBB &&
    indicators?.BB_upper &&
    indicators?.BB_middle &&
    indicators?.BB_lower
  ) {
    const createPoints = (data) => {
      const points = [];
      data.forEach((val, i) => {
        if (val !== null) {
          points.push({ x: x(i), y: y(val) });
        }
      });
      return points;
    };
    const createPathFromPoints = (points) => {
      if (points.length === 0) return '';
      return 'M ' + points.map((p) => `${p.x},${p.y}`).join(' L ');
    };

    const upperPoints = createPoints(indicators.BB_upper);
    const middlePoints = createPoints(indicators.BB_middle);
    const lowerPoints = createPoints(indicators.BB_lower);

    const upperPath = createPathFromPoints(upperPoints);
    const middlePath = createPathFromPoints(middlePoints);
    const lowerPath = createPathFromPoints(lowerPoints);

    let bandPath = '';
    if (upperPoints.length > 0 && lowerPoints.length > 0) {
      const lowerPointsReversed = [...lowerPoints].reverse();
      const allPoints = [...upperPoints, ...lowerPointsReversed];
      bandPath = createPathFromPoints(allPoints) + ' Z';
    }

    bbLayers = `
      <path d="${bandPath}" fill="rgba(59, 130, 246, 0.1)" stroke="none" />
      <path d="${upperPath}" fill="none" stroke="#3b82f6" stroke-width="1"/>
      <path d="${lowerPath}" fill="none" stroke="#3b82f6" stroke-width="1"/>
      <path d="${middlePath}" fill="none" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 4"/>
    `;
  }

  // 一目均衡表
  let ichimokuLayers = '';
  if (withIchimoku && indicators?.ICHI_tenkan) {

    // Tenkan = red, Kijun = blue
    // bitbankアプリの配色: 転換線=青, 基準線=赤
    const tenkanPath = createLinePath(indicators.ICHI_tenkan, '#00a3ff', { width: '1', offset: 0 });
    const kijunPath = createLinePath(indicators.ICHI_kijun, '#ff4d4d', { width: '1', offset: 0 });
    const chikouPath = drawChikou ? createLinePath(indicators.ICHI_chikou, '#16a34a', { width: '1', dash: '2 2', offset: -26 }) : '';
    // SpanA 上側=緑、SpanB 下側=赤（Bitbank準拠）
    const spanAPath = createLinePath(indicators.ICHI_spanA, '#16a34a', { width: '1', offset: 26 });
    const spanBPath = createLinePath(indicators.ICHI_spanB, '#ef4444', { width: '1', offset: 26 });
    
    // 雲の描画ロジックを修正（交差点で色を正確に切り替える）
    const createCloudPaths = (spanA, spanB, offset) => {
      let greenCloudPath = '';
      let redCloudPath = '';

      // 現在の領域（同一色の連続区間）を保持
      let currentTop = [];
      let currentBottom = [];
      let currentIsGreen = null;

      const pushPolygon = () => {
        if (currentTop.length < 2 || currentBottom.length < 2) return;
        const polygon = 'M ' + [...currentTop, ...currentBottom.slice().reverse()]
          .map(p => `${p.x},${p.y}`)
          .join(' L ') + ' Z';
        if (currentIsGreen) {
          greenCloudPath += polygon;
        } else {
          redCloudPath += polygon;
        }
      };

      const toPoint = (i, yVal) => ({ x: x(i - pastBuffer + (offset || 0)), y: y(yVal) });

      const len = Math.max(spanA?.length || 0, spanB?.length || 0);
      for (let i = 0; i < len - 1; i++) {
        const a0 = spanA?.[i];
        const b0 = spanB?.[i];
        const a1 = spanA?.[i + 1];
        const b1 = spanB?.[i + 1];

        // nullを含むセグメントは区切ってスキップ
        if (
          a0 == null || b0 == null || a1 == null || b1 == null ||
          !isFinite(a0) || !isFinite(b0) || !isFinite(a1) || !isFinite(b1)
        ) {
          pushPolygon();
          currentTop = [];
          currentBottom = [];
          currentIsGreen = null;
          continue;
        }

        const isGreen0 = a0 >= b0;
        const isGreen1 = a1 >= b1;

        // 初回開始
        if (currentIsGreen === null) {
          currentIsGreen = isGreen0;
          // 始点を追加
          currentTop.push(toPoint(i, currentIsGreen ? a0 : b0));
          currentBottom.push(toPoint(i, currentIsGreen ? b0 : a0));
        }

        // 交差がない場合はそのまま次点を追加
        if (isGreen0 === isGreen1) {
          currentTop.push(toPoint(i + 1, currentIsGreen ? a1 : b1));
          currentBottom.push(toPoint(i + 1, currentIsGreen ? b1 : a1));
          continue;
        }

        // 交差がある場合: 交点を計算して両配列に追加し、ポリゴンを確定
        // A(t) = a0 + t*(a1-a0), B(t) = b0 + t*(b1-b0), A(t) = B(t) を解く
        const da = a1 - a0;
        const db = b1 - b0;
        const denom = (da - db);
        const t = denom === 0 ? 0 : (a0 - b0) / denom; // [0,1]想定
        const tClamped = Math.max(0, Math.min(1, t));
        const xi = i + tClamped;
        const yi = a0 + tClamped * da; // = b0 + tClamped * db

        const pInt = toPoint(xi, yi);

        // 現在区間の終点として交点を追加
        currentTop.push(pInt);
        currentBottom.push(pInt);
        pushPolygon();

        // 次の区間を交点から開始（色を反転）
        currentIsGreen = isGreen1;
        currentTop = [pInt, toPoint(i + 1, currentIsGreen ? a1 : b1)];
        currentBottom = [pInt, toPoint(i + 1, currentIsGreen ? b1 : a1)];
      }

      // 末尾を確定
      pushPolygon();

      return { greenCloudPath, redCloudPath };
    };

    const { greenCloudPath, redCloudPath } = createCloudPaths(indicators.ICHI_spanA, indicators.ICHI_spanB, 26);
    
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
    const legendItems = [];
    if (withSMA?.length > 0) {
      withSMA.forEach((p, idx) => {
        legendMeta[`SMA_${p}`] = `SMA ${p} (${smaColors[p]})`;
        legendItems.push({ text: `SMA ${p}`, color: smaColors[p] || '#e5e7eb' });
      });
    }
    if (withBB) {
      legendMeta.BB = 'ボリンジャーバンド (青)';
      legendItems.push({ text: 'Bollinger Bands', color: '#3b82f6' });
    }
    if (withIchimoku) {
      legendMeta.Ichimoku = '一目均衡表';
      // 転換線・基準線を個別に表示
      legendItems.push({ text: '転換線', color: '#00a3ff' });
      legendItems.push({ text: '基準線', color: '#ff4d4d' });
    }

    // 凡例は上部に余白を持たせて配置
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
        .map((d, i) => {
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
  const createSvgString = (layers) => `
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
  
  const fullSvg = createSvgString({ ichimoku: ichimokuLayers, bb: bbLayers, sma: smaLayers });
  const lightSvg = createSvgString({ ichimoku: withIchimoku ? ichimokuLayers : '', bb: bbLayers, sma: smaLayers });


  // --- SVGをファイルに保存（フォールバック付き） ---
  const filenameSuffix = withIchimoku ? '_light' : '';
  const filename = `chart-${pair}-${type}-${Date.now()}${filenameSuffix}.svg`;
  const assetsDir = 'assets';
  const outputPath = path.join(assetsDir, filename);

  try {
    // ディレクトリが存在しない場合は作成
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(outputPath, withIchimoku ? lightSvg : fullSvg);

    // 保存成功時
    const summary = `${formatPair(pair)} ${type} chart saved to ${outputPath}`;
    return ok(
      summary,
      { filePath: outputPath, svg: lightSvg, legend: legendMeta }, // ★ 出力構造を統一
      { pair, type, limit, indicators: Object.keys(legendMeta) }
    );
  } catch (err) {
    console.warn(
      `[Warning] Failed to save SVG to ${outputPath}. Fallback to inline SVG.`,
      err
    );
    // 保存失敗時は軽量版SVGを直接返す
    const summary = `${formatPair(pair)} ${type} chart (SVG, file save failed)`;
  return ok(
    summary,
      { svg: lightSvg, legend: legendMeta }, // ★ 出力構造を統一
      { pair, type, limit, indicators: Object.keys(legendMeta) }
  );
}
}