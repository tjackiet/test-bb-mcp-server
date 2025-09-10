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
  const allItems = chartData?.candles || [];
  // 表示は最後のlimit本に絞る
  const leftPad = Math.max(0, allItems.length - limit);
  const items = allItems.slice(-limit);
  const indicators = chartData?.indicators;

  if (!items?.length) {
    return fail('No candle data available to render SVG chart.', 'user');
  }

  // スケール計算
  const w = 860;
  const h = 420;
  const padding = { top: 24, right: 16, bottom: 32, left: 48 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const xs = items.map((_, i) => i);
  const highs = items.map((d) => d.high);
  const lows = items.map((d) => d.low);
  const xMin = 0;
  const xMax = xs.length - 1;
  // 一目均衡表の先行スパンを未来に26本突き出して描画するために、
  // X軸の分母（スケール範囲）を未来分だけ拡張
  const forwardShift = withIchimoku ? 26 : 0;
  const yMin = Math.min(...lows);
  const yMax = Math.max(...highs);

  const x = (i) =>
    padding.left + ((i - xMin) * plotW) / Math.max(1, xMax - xMin + forwardShift);
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
        points.push(`${x(i - leftPad + offset)},${y(val)}`);
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
    const tenkanPath = createLinePath(indicators.ICHI_tenkan, '#ef4444', { width: '1', offset: 0 });
    const kijunPath = createLinePath(indicators.ICHI_kijun, '#3b82f6', { width: '1', offset: 0 });
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
          const point = { x: x(i - leftPad + (offset || 0)), yA: y(spanA_val), yB: y(spanB_val) };
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
      legendItems.push({ text: 'Tenkan (転換線)', color: '#ef4444' });
      legendItems.push({ text: 'Kijun (基準線)', color: '#3b82f6' });
    }

    let yOffset = h - padding.bottom + 20;
    legendLayers = legendItems.map((item, i) => {
      const xPos = padding.left + (i * 150);
      return `
        <rect x="${xPos}" y="${yOffset - 8}" width="10" height="10" fill="${item.color}" />
        <text x="${xPos + 15}" y="${yOffset}" font-family="sans-serif" font-size="12" fill="#555">${item.text}</text>
      `;
    }).join('');
  }
  
  const title = `${formatPair(pair)} ${type} (${items.length} bars)`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + (withLegend ? 40 : 0)}" viewBox="0 0 ${w} ${h + (withLegend ? 40 : 0)}">
  <rect x="0" y="0" width="${w}" height="${h + (withLegend ? 40 : 0)}" fill="#ffffff"/>
  <g class="grid">
    <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${
    w - padding.right
  }" y2="${h - padding.bottom}" stroke="#e5e7eb"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${
    padding.left
  }" y2="${h - padding.bottom}" stroke="#e5e7eb"/>
  </g>
  <!-- ローソク -->
  ${sticks}
  ${bodies}
  <!-- SMA -->
  ${smaLayers}
  <!-- Bollinger Bands -->
  ${bbLayers}
  <!-- Ichimoku Cloud -->
  ${ichimokuLayers}
  <!-- Legend -->
  ${legendLayers}
  <!-- 目盛り（軽量） -->
  <text x="${
    w / 2
  }" y="${padding.top}" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#111">
    ${title}
  </text>
</svg>`;

  const summary = `${title} SVG chart`;
  return ok(
    summary,
    { svg, legend: legendMeta },
    { pair, type, count: items.length, mode: 'svg' }
  );
}
