// tools/render_chart_html.js
import fs from 'fs';
import getCandles from './get_candles.js';
import { formatPair } from '../lib/formatter.js';
import { ok, fail } from '../lib/result.js';

function loadLwcInline() {
  try {
    const assetPath = 'assets/lightweight-charts.standalone.js';
    if (fs.existsSync(assetPath)) {
      return fs.readFileSync(assetPath, 'utf8');
    }
  } catch (_) {
    /* fall through */
  }
  return null;
}

function buildHtml({ title, candles, lwc }) {
  // Lightweight Charts 用に {time:'YYYY-MM-DD', open,high,low,close} に整形
  const ohlc = candles.map((c) => ({
    time: c.isoTime.split('T')[0],
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  const jsonOHLC = JSON.stringify(ohlc);

  const scriptTag = `<script>${lwc}</script>`;

  return `
<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
${scriptTag}
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,'Segoe UI',Roboto}
  #chart{height:600px;width:100vw;max-width:1200px;margin:24px auto}
  h2{margin:16px 0;text-align:center}
</style>
</head><body>
<h2>${title}</h2>
<div id="chart"></div>
<script>
  const ohlc = ${jsonOHLC};

  if (typeof window.LightweightCharts === 'undefined') {
    document.getElementById('chart').innerHTML = '<p style="color:red; text-align:center;">チャートライブラリの読み込みに失敗しました。(CSP or Network issue)</p>';
  } else if (ohlc.length === 0) {
    document.getElementById('chart').innerHTML = '<p style="text-align:center;">チャートを描画するための十分なデータがありませんでした。</p>';
  } else {
    const el = document.getElementById('chart');
    const chart = LightweightCharts.createChart(el, {
      width: el.clientWidth, height: 600,
      layout: { background: { type: 'solid', color: '#FFFFFF' }, textColor: '#333' },
      grid: { vertLines: { color: '#eee' }, horzLines: { color: '#eee' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries();
    series.setData(ohlc);
    window.addEventListener('resize', () => {
      chart.applyOptions({ width: el.clientWidth });
    });
  }
</script>
</body></html>`;
}

export default async function renderChartHtml(
  pair = 'btc_jpy',
  type = '1day',
  limit = 90,
  embedLib = true // embedLib is kept for schema consistency, but now it's effectively always true
) {
  const lwc = loadLwcInline();
  if (!lwc) {
    return fail(
      'Chart library missing: assets/lightweight-charts.standalone.js not found.',
      'runtime',
      { hint: 'Run `npm install` or `docker build` to copy the asset.' }
    );
  }

  const res = await getCandles(pair, type, undefined, limit);
  if (!res?.ok) return res;

  const items = res.data?.normalized ?? [];
  const title = `${formatPair(pair)} ${type} (${items.length} bars)`;
  const html = buildHtml({ title, candles: items, lwc });

  const summary = `rendered chart html: ${title}`;
  const data = { html, length: items.length };
  const meta = { pair, type, limit, embedLib, mode: 'inline' };

  return ok(summary, data, meta);
}
