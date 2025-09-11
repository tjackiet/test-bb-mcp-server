// tools/render_chart_svg.js
import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';

export default async function renderChartSvg({
  pair = 'btc_jpy',
  type = 'day',
  limit = 60,
  withSMA = [25, 75],
  withBB = true,
  withIchimoku = false, // デフォルトではオフに
  withLegend = true,
} = {}) {
  // 取得本数: Ichimoku時は左側の雲を埋めるため+26
  const fetchLimit = withIchimoku ? limit + 26 : limit;
  const res = await getIndicators(pair, type, fetchLimit);
  if (!res?.ok) return res;

  const chartData = res.data?.chart;
  const items = chartData?.candles || [];
  const indicators = chartData?.indicators;

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

  const xs = items.map((_, i) => i);
  const highs = items.map((d) => d.high);
  const lows = items.map((d) => d.low);
  const xMin = 0;
  const xMax = xs.length - 1;
  // 一目均衡表の先行スパンを未来に26本突き出して描画するために、
  // X軸の分母（スケール範囲）を未来分だけ拡張
  const forwardShift = withIchimoku ? 26 : 0;
  const dataYMin = Math.min(...lows);
  const dataYMax = Math.max(...highs);
  
  // Y軸下部に5%のバッファを持たせる
  const yAxisMinWithBuffer = dataYMin * 0.95;
  
  // チャートのY軸範囲は実際の安値・高値を含むように拡張
  const yTicks = niceTicks(yAxisMinWithBuffer, dataYMax, 6);
  const yMin = yTicks[0];
  const yMax = yTicks.at(-1);
  
  // Y軸ラベルの最大幅に基づいてpadding.leftを動的に調整
  const maxLabelWidth = Math.max(...yTicks.map(v => v.toLocaleString().length));
  const dynamicPaddingLeft = maxLabelWidth * 8 + 16; // 1文字8pxと仮定 + 余白

  // スケール計算
  const w = 860;
  const h = 420;
  const padding = { top: 24, right: 16, bottom: 40, left: dynamicPaddingLeft };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const x = (i) =>
    padding.left + (i * plotW) / Math.max(1, xMax + forwardShift);
  const y = (v) =>
    h - padding.bottom - ((v - yMin) * plotH) / Math.max(1, yMax - yMin);

  // 先行表示時の左側欠けを埋めるための補正（26）
  const leftCompensation = withIchimoku ? 26 : 0;

  // --- 凡例メタデータと描画レイヤーの準備 ---
  const legendMeta = {};
  let legendLayers = '';
  
  const barW = Math.max(2, (plotW / Math.max(1, xs.length)) * 0.6);

  // ローソク（棒＋ヒゲ）
  const sticks = items
    .map((d, i) => {
      const cx = x(i);
      return `<line x1="${cx}" y1="${y(d.high)}" x2="${cx}" y2="${
        y(d.low)
      }" stroke="#9ca3af" stroke-width="1"/>`;
    })
    .join('');

  const bodies = items
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
  const smaColors = { 25: '#3b82f6', 75: '#f59e0b', 200: '#10b981' };
  
  // 汎用的なライン描画関数
  const createLinePath = (data, color, options = {}) => {
    if (!data || data.length === 0) return '';
    const points = [];
    const offset = options.offset || 0; // 先行(+26) / 遅行(-26)
    data.forEach((val, i) => {
      if (val !== null && typeof val === 'number') {
        // 取得増分(leftPad)は座標から差し引き、可視ウィンドウ(0..limit-1)基準で描画
        points.push(`${x(i + offset)},${y(val)}`);
      }
    });
    if (points.length === 0) return '';
    const d = 'M ' + points.join(' L ');
    const dash = options.dash ? `stroke-dasharray="${options.dash}"` : '';
    const width = options.width || '1.5';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${dash}/>`;
  };
  
  // SMAレイヤー
  const sma25 = indicators?.SMA_25 || [];
  const sma75 = indicators?.SMA_75 || [];
  const sma200 = indicators?.SMA_200 || [];
  let smaLayers = '';
  if (withSMA?.includes(25) && sma25.length > 0) {
    smaLayers += createLinePath(sma25, smaColors[25]);
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
    const chikouPath = createLinePath(indicators.ICHI_chikou, '#16a34a', { width: '1', dash: '2 2', offset: -26 });
    const spanAPath = createLinePath(indicators.ICHI_spanA, 'rgba(239, 68, 68, 0.5)', { width: '1', offset: 26 });
    const spanBPath = createLinePath(indicators.ICHI_spanB, 'rgba(16, 163, 74, 0.5)', { width: '1', offset: 26 });
    
    // 雲の描画ロジックを修正（途切れないように）
    const createCloudPaths = (spanA, spanB, offset) => {
      let greenCloudPath = '';
      let redCloudPath = '';
      let currentGreenPoints = [];
      let currentRedPoints = [];

      const finishPath = (points, isGreen) => {
        if (points.length < 2) return;
        
        const spanAPoints = points.map(p => ({ x: p.x, y: p.yA }));
        const spanBPoints = points.map(p => ({ x: p.x, y: p.yB })).reverse();
        const allPoints = [...spanAPoints, ...spanBPoints];
        
        const path = 'M ' + allPoints.map(p => `${p.x},${p.y}`).join(' L ') + ' Z';

        if (isGreen) {
          greenCloudPath += path;
        } else {
          redCloudPath += path;
        }
      };

      // 先行スパンの配列長（未来分を含む）を使う
      const len = Math.max(spanA?.length || 0, spanB?.length || 0);
      for (let i = 0; i < len; i++) {
        const spanA_val = spanA?.[i] ?? null;
        const spanB_val = spanB?.[i] ?? null;

        if (typeof spanA_val === 'number' && typeof spanB_val === 'number') {
          const point = { x: x(i + (offset || 0)), yA: y(spanA_val), yB: y(spanB_val) };
          const isGreen = spanA_val >= spanB_val; // 等しい場合も描画対象に含める

          if (isGreen) {
            if (currentRedPoints.length > 0) {
              finishPath(currentRedPoints, false);
              currentRedPoints = [];
            }
            currentGreenPoints.push(point);
          } else {
            if (currentGreenPoints.length > 0) {
              finishPath(currentGreenPoints, true);
              currentGreenPoints = [];
            }
            currentRedPoints.push(point);
          }
        } else {
          finishPath(currentGreenPoints, true);
          finishPath(currentRedPoints, false);
          currentGreenPoints = [];
          currentRedPoints = [];
        }
      }
      finishPath(currentGreenPoints, true);
      finishPath(currentRedPoints, false);

      return { greenCloudPath, redCloudPath };
    };

    const { greenCloudPath, redCloudPath } = createCloudPaths(indicators.ICHI_spanA, indicators.ICHI_spanB, 26);
    
    ichimokuLayers = `
      <path d="${greenCloudPath}" fill="rgba(16, 163, 74, 0.1)" stroke="none" />
      <path d="${redCloudPath}" fill="rgba(239, 68, 68, 0.1)" stroke="none" />
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
        legendItems.push({ text: `SMA ${p}`, color: smaColors[p] });
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

    let yOffset = padding.top / 2;
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
      ${items.filter((_, i) => i % Math.floor(items.length / 5) === 0).map((d) => {
        const idx = items.indexOf(d);
        const xPos = x(idx);
        const date = new Date(d.time || d.timestamp);
        if (isNaN(date.getTime())) return ''; // 不正な日付はスキップ

        const formattedDate = `${date.getMonth() + 1}/${date.getDate()}`;
        return `<text x="${xPos}" y="${h - padding.bottom + 16}" text-anchor="middle">${formattedDate}</text>`;
      }).join('')}
    </g>
  `;

  const svg = `
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
        ${ichimokuLayers}
        ${bbLayers}
        ${smaLayers}
        ${sticks}
        ${bodies}
      </g>
      <g class="legend">
        ${legendLayers}
      </g>
    </svg>
  `;

  const summary = `${formatPair(pair)} ${type} chart (SVG)`;
  return ok(
    summary,
    { svg, legend: legendMeta },
    { pair, type, limit, indicators: Object.keys(legendMeta) }
  );
}