// tools/render_depth_svg.ts
import fs from 'fs/promises';
import path from 'path';
import getDepth from './get_depth.js';
import { ok, fail } from '../lib/result.js';
import { formatPair } from '../lib/formatter.js';
import type { Result, Pair } from '../src/types/domain.d.ts';

type RenderData = { svg?: string; filePath?: string; summary?: Record<string, any> };
type RenderMeta = {
  pair: Pair;
  type: string;
  bbMode: 'default';
  sizeBytes?: number;
};

export default async function renderDepthSvg(args: {
  pair?: Pair;
  type?: string; // schema都合上の表示用。depth自体は時間軸に依存しない
  depth?: { levels?: number };
  preferFile?: boolean;
  autoSave?: boolean;
} = {}): Promise<Result<RenderData, RenderMeta>> {
  try {
    const pair = (args.pair || 'btc_jpy') as Pair;
    const type = String(args.type || '1day');
    const levels = Math.max(10, Number(args?.depth?.levels ?? 200));

    const depth = await getDepth(pair, { maxLevels: levels });
    if (!depth.ok) return fail(depth.summary.replace(/^Error: /, ''), (depth as any)?.meta?.errorType || 'internal');
    const asks: Array<[string, string]> = depth.data.asks || [];
    const bids: Array<[string, string]> = depth.data.bids || [];

    // 価格レンジ
    const minBid = Number(bids[bids.length - 1]?.[0] ?? bids[0]?.[0] ?? 0);
    const maxAsk = Number(asks[asks.length - 1]?.[0] ?? asks[0]?.[0] ?? 0);
    const xMinP = Math.min(minBid, Number(bids[0]?.[0] ?? minBid));
    const xMaxP = Math.max(maxAsk, Number(asks[0]?.[0] ?? maxAsk));

    // 累積量（左：bids 降順→小へ、右：asks 昇順→大へ）
    const bidsSorted = [...bids].map(([p, s]) => [Number(p), Number(s)] as [number, number]).sort((a, b) => b[0] - a[0]);
    const asksSorted = [...asks].map(([p, s]) => [Number(p), Number(s)] as [number, number]).sort((a, b) => a[0] - b[0]);
    let cum = 0; const bidSteps: Array<[number, number]> = [];
    for (const [p, s] of bidsSorted) { cum += s; bidSteps.push([p, cum]); }
    cum = 0; const askSteps: Array<[number, number]> = [];
    for (const [p, s] of asksSorted) { cum += s; askSteps.push([p, cum]); }
    const maxQty = Math.max(bidSteps.at(-1)?.[1] || 0, askSteps.at(-1)?.[1] || 0) || 1;

    // キャンバス
    const w = 860, h = 420;
    // チャート（プロット領域）自体を押し下げ、最上段のY軸目盛りがヘッダー群の下に来るようにする
    const padding = { top: 84, right: 12, bottom: 32, left: 64 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;
    const x = (price: number) => Number((padding.left + ((price - xMinP) * plotW) / Math.max(1, xMaxP - xMinP)).toFixed(1));
    const y = (qty: number) => Number((h - padding.bottom - (qty * plotH) / maxQty).toFixed(1));
    const fmtJPYCompact = (p: number) => `¥${Math.round(p).toLocaleString('ja-JP')}`;
    const fmtJPYAxis = (p: number) => {
      const v = Math.round(p / 1000) * 1000;
      return `¥${v.toLocaleString('ja-JP')}`;
    };

    // ステップパス生成
    const toStepPath = (steps: Array<[number, number]>) => {
      if (!steps.length) return '';
      const pts = steps.map(([p, q]) => `${x(p)},${y(q)}`);
      return 'M ' + pts.join(' L ');
    };
    const bidPath = toStepPath(bidSteps);
    const askPath = toStepPath(askSteps);

    // 塗りつぶし
    const toFillPath = (steps: Array<[number, number]>, side: 'bid' | 'ask') => {
      if (!steps.length) return '';
      const head = steps[0];
      const tail = steps[steps.length - 1];
      const baseY = y(0);
      const poly = ['M', `${x(head[0])},${baseY}`, 'L']
        .concat(steps.map(([p, q]) => `${x(p)},${y(q)}`))
        .concat(['L', `${x(tail[0])},${baseY}`, 'Z'])
        .join(' ');
      const fill = side === 'bid' ? 'rgba(16,185,129,0.12)' : 'rgba(249,115,22,0.12)';
      return `<path d="${poly}" fill="${fill}" stroke="none"/>`;
    };
    const bidFill = toFillPath(bidSteps, 'bid');
    const askFill = toFillPath(askSteps, 'ask');

    const bestBid = Number(bidsSorted[0]?.[0] ?? 0);
    const bestAsk = Number(asksSorted[0]?.[0] ?? 0);
    const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (Number(bids[0]?.[0] ?? 0) + Number(asks[0]?.[0] ?? 0)) / 2;
    // 軸と目盛り
    const yAxis = `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>`;
    const xAxis = `<line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>`;
    // Y軸目盛り（キリの良い数値）
    const yStep = maxQty <= 25 ? 5 : (maxQty <= 50 ? 10 : 20);
    const yMaxNice = Math.ceil(maxQty / yStep) * yStep;
    const yTicks = [];
    for (let v = 0; v <= yMaxNice; v += yStep) yTicks.push({ q: v, y: y(v) });
    const yTickTexts = yTicks.map(t => `<text x="${padding.left - 8}" y="${t.y}" text-anchor="end" dominant-baseline="middle" fill="#e5e7eb" font-size="10">${Math.round(t.q)} BTC</text>`).join('');
    // X軸目盛り（5分割）
    const xTicks = (() => {
      const out: Array<{ p: number; x: number }> = [];
      const N = 4;
      for (let i = 0; i <= N; i++) {
        const p = xMinP + ((xMaxP - xMinP) * i) / N;
        out.push({ p, x: x(p) });
      }
      return out;
    })();
    const xTickTexts = xTicks.map(t => `<text x="${t.x}" y="${h - padding.bottom + 14}" text-anchor="middle" fill="#e5e7eb" font-size="10">${fmtJPYAxis(t.p)}</text>`).join('');
    const legendDepth = `
      <g font-size="12" fill="#e5e7eb" transform="translate(${padding.left + 190}, ${Math.max(14, padding.top - 34)})">
        <rect x="0" y="-10" width="12" height="12" fill="#10b981"></rect>
        <text x="16" y="0">買い (Bids)</text>
        <rect x="120" y="-10" width="12" height="12" fill="#f97316"></rect>
        <text x="136" y="0">売り (Asks)</text>
      </g>`;

    // 注釈（タイトル、タイムスタンプ、比率など）
    const nowJst = (() => {
      try { return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); } catch { return new Date().toISOString(); }
    })();
    // ±1%集計
    const band = 0.01;
    const bidBand = bidsSorted.filter(([p]) => p >= mid * (1 - band));
    const askBand = asksSorted.filter(([p]) => p <= mid * (1 + band));
    const bidDepth = bidBand.reduce((s, [, q]) => s + Number(q || 0), 0);
    const askDepth = askBand.reduce((s, [, q]) => s + Number(q || 0), 0);
    const ratio = (askDepth > 0) ? (bidDepth / askDepth) : Infinity;
    const headerTexts = `
      <g font-size="12" fill="#e5e7eb">
        <text x="${padding.left}" y="${padding.top - 36}">${formatPair(pair)} 板の深さ</text>
        <text x="${padding.left}" y="${padding.top - 22}">${nowJst} JST</text>
        <text x="${w - padding.right}" y="${padding.top - 8}" text-anchor="end">買い/売り 比率(±1%): ${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'}</text>
      </g>`;
    // 中央線ラベル（価格を見やすく）
    const midLabel = `<text x="${x(mid)}" y="${padding.top + 12}" text-anchor="middle" fill="#e5e7eb" font-size="12">${fmtJPYCompact(mid)}</text>`;

    const svg = `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background-color:#1f2937;color:#e5e7eb;font-family:sans-serif;max-width:100%;height:auto;">
      ${legendDepth}
      ${headerTexts}
      <g class="axes">
        ${yAxis}${xAxis}
        ${yTickTexts}
        ${xTickTexts}
      </g>
      <g class="plot-area">
        ${bidFill}
        ${askFill}
        <path d="${bidPath}" fill="none" stroke="#10b981" stroke-width="2"/>
        <path d="${askPath}" fill="none" stroke="#f97316" stroke-width="2"/>
        <line x1="${x(mid)}" y1="${padding.top}" x2="${x(mid)}" y2="${h - padding.bottom}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 4"/>
        ${midLabel}
      </g>
    </svg>`;

    const finalSvg = svg.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><');
    const sizeBytes = Buffer.byteLength(finalSvg, 'utf8');
    const preferFile = Boolean((args as any)?.preferFile);
    const autoSave = Boolean((args as any)?.autoSave);

    const meta: RenderMeta = { pair, type, bbMode: 'default', sizeBytes };

    const assetsDir = path.join(process.cwd(), 'assets');
    const filename = `depth-${pair}-${Date.now()}.svg`;
    const outputPath = path.join(assetsDir, filename);

    const summary = {
      pair,
      currentPrice: Math.round(mid),
      bestBid: Math.round(bestBid),
      bestAsk: Math.round(bestAsk),
      bandPct: band,
      bidDepth: Number(bidDepth.toFixed(4)),
      askDepth: Number(askDepth.toFixed(4)),
      ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
      timestamp: new Date().toISOString(),
    };

    if (preferFile || autoSave) {
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(outputPath, finalSvg);
      return ok<RenderData, RenderMeta>(`${formatPair(pair)} depth chart saved to ${outputPath}`, { filePath: outputPath, svg: undefined, summary }, meta);
    }
    // inline
    return ok<RenderData, RenderMeta>(`${formatPair(pair)} depth chart rendered`, { svg: finalSvg, filePath: undefined, summary }, meta);
  } catch (e: any) {
    return fail(e?.message || 'failed to render depth', 'internal');
  }
}


