// tools/render_chart_svg.js
import getIndicators from './get_indicators.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';

export default async function renderChartSvg({
  pair = 'btc_jpy',
  type = '1day',
  limit = 60,
  withSMA = [25, 75],
  withBB = true,
} = {}) {
  const res = await getIndicators(pair, type, limit);
  if (!res?.ok) return res;

  const chartData = res.data?.chart;
  const items = chartData?.candles;
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
  const yMin = Math.min(...lows);
  const yMax = Math.max(...highs);

  const x = (i) =>
    padding.left + ((i - xMin) * plotW) / Math.max(1, xMax - xMin);
  const y = (v) =>
    h - padding.bottom - ((v - yMin) * plotH) / Math.max(1, yMax - yMin);

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

  // 簡易SMA
  const smaColors = ['#3b82f6', '#f59e0b', '#10b981'];
  const closes = items.map((d) => d.close);

  const smaPath = (period, color) => {
    if (closes.length < period) return '';

    const smaValues = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= period) {
        sum -= closes[i - period];
      }
      if (i >= period - 1) {
        smaValues.push({ i, v: sum / period });
      }
    }

    if (smaValues.length === 0) return '';

    let d = `M ${x(smaValues[0].i)},${y(smaValues[0].v)}`;
    for (let k = 1; k < smaValues.length; k++) {
      d += ` L ${x(smaValues[k].i)},${y(smaValues[k].v)}`;
    }
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
  };

  const smaLayers = (withSMA || [])
    .map((p, idx) => smaPath(p, smaColors[idx % smaColors.length]))
    .join('');

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

  const title = `${formatPair(pair)} ${type} (${items.length} bars)`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>
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
    { svg },
    { pair, type, count: items.length, mode: 'svg' }
  );
}
