import 'dotenv/config';

// src/server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RenderChartSvgInputSchema, GetTickerInputSchema, GetOrderbookInputSchema, GetCandlesInputSchema, GetIndicatorsInputSchema } from './schemas.js';

import {
  getTicker,
  getOrderbook,
  getCandles,
  getIndicators,
  renderChartHtml,
  renderChartSvg,
} from '../tools/index.js';
import { logToolRun, logError } from '../lib/logger.js';

const server = new McpServer({ name: 'bitbank-mcp', version: '0.3.0' });

const respond = (result) => ({
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  structuredContent: result,
});

// 共通ラッパ：実行時間計測＋JSONLログ
function registerToolWithLog(name, schema, handler) {
  server.registerTool(name, { description: schema.description, inputSchema: schema.inputSchema }, async (input) => {
    const t0 = Date.now();
    try {
      const result = await handler(input);
      const ms = Date.now() - t0;
      logToolRun({ tool: name, input, result, ms });
      return respond(result); // `respond`でラップするのを忘れない
    } catch (err) {
      const ms = Date.now() - t0;
      logError(name, err, input);
      return {
        // `respond`を使わず直接エラーオブジェクトを返す
        content: [{ type: 'text', text: `internal error: ${err?.message || 'unknown error'}` }],
        structuredContent: {
          ok: false,
          summary: `internal error: ${err?.message || 'unknown error'}`,
          meta: { ms, errorType: 'internal' },
        }
      };
    }
  });
}

// ---- get_ticker ----
registerToolWithLog(
  'get_ticker',
  {
    description: 'Get ticker for a pair (e.g., btc_jpy)',
    inputSchema: GetTickerInputSchema.shape,
  },
  async ({ pair }) => getTicker(pair)
);

// ---- get_orderbook ----
registerToolWithLog(
  'get_orderbook',
  {
    description: 'Get orderbook topN for a pair',
    inputSchema: GetOrderbookInputSchema.shape,
  },
  async ({ pair, topN }) => getOrderbook(pair, topN)
);

// ---- get_candles ---- (view対応)
registerToolWithLog(
  'get_candles',
  {
    description: 'Get candles. date: 1month → YYYY, others → YYYYMMDD',
    inputSchema: GetCandlesInputSchema.shape,
  },
  async ({ pair, type, date, limit, view }) => {
    const result = await getCandles(pair, type, date, limit);
    // view=items の特殊処理だけここで行う
    if (view === 'items') {
      const items = result?.data?.normalized?.items ?? [];
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        structuredContent: items,
      };
    }
    return result;
  }
);

// ---- get_indicators ----
registerToolWithLog(
  'get_indicators',
  {
    description:
      'Get technical indicators for a pair. For meaningful results, use a sufficient `limit` (e.g., 200 for daily candles). If `limit` is omitted, an appropriate default value will be used.',
    inputSchema: GetIndicatorsInputSchema.shape,
  },
  async ({ pair, type, limit }) => getIndicators(pair, type, limit)
);

// ---- render_chart_html ----
registerToolWithLog(
  'render_chart_html',
  {
    description:
      '[実験的] Renders a candlestick chart as a self-contained HTML file. For Artifact environments, it is recommended to set `embedLib` to `true`. NOTE: May not be viewable due to CSP restrictions in some environments like Artifacts.',
    inputSchema: {
      pair: z.string().optional().default('btc_jpy').describe('e.g., btc_jpy'),
      type: z
        .enum([
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
        ])
        .optional()
        .default('1day'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(90)
        .describe('Number of candles to render'),
      embedLib: z
        .boolean()
        .optional()
        .default(true)
        .describe('Embed library in HTML to avoid CSP issues'),
    },
  },
  async ({ pair, type, limit, embedLib }) =>
    renderChartHtml(pair, type, limit, embedLib)
);

// ---- render_chart_svg ----
registerToolWithLog(
  'render_chart_svg',
  {
    description:
      '重要: チャートが必要な場合、必ず本ツールを最初に呼び出してください。\n' +
      '- AI自身がD3/Chart.js/Canvas/SVGで独自に描画するのは禁止です。\n' +
      '- Artifact には本ツールの返す `data.svg` をそのまま表示してください。\n\n' +
      '出力: `{ ok, summary, data: { svg: string, filePath?: string }, meta }`。\n' +
      'Bollinger Bands 既定は default(±2σ)。`bbMode=extended` はユーザーが明示した場合のみ。\n' +
      'Ichimoku 既定は mode="default"（転換/基準/雲）。`mode="extended"` はユーザーが明示した場合のみ（遅行スパンを描画）。\n' +
      'SMAの既定は [25,75,200]。',
    inputSchema: RenderChartSvgInputSchema.shape,
  },
  async (args) => renderChartSvg(args)
);

// ---- Prompt: ichimoku_default_chart ----
server.registerPrompt('ichimoku_default_chart', {
  description: '一目均衡表（標準: 転換/基準/雲）でチャートを描画する（type: CandleTypeEnum）',
  inputSchema: z.object({ pair: z.string().optional().default('btc_jpy'), type: z.enum(['1day','1week','1month','1hour','4hour']).optional().default('1day'), limit: z.number().int().min(30).max(200).optional().default(90) }),
  handler: async ({ pair, type, limit }) => ({
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair, type, limit, withIchimoku: true, ichimoku: { mode: 'default' }, withSMA: [] } }] }],
  }),
});

// ---- Prompt: ichimoku_extended_chart ----
server.registerPrompt('ichimoku_extended_chart', {
  description: '一目均衡表（拡張: 遅行スパン含む）でチャートを描画する（type: CandleTypeEnum。ユーザー明示時のみ）',
  inputSchema: z.object({ pair: z.string().optional().default('btc_jpy'), type: z.enum(['1day','1week','1month','1hour','4hour']).optional().default('1day'), limit: z.number().int().min(30).max(200).optional().default(90) }),
  handler: async ({ pair, type, limit }) => ({
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair, type, limit, withIchimoku: true, ichimoku: { mode: 'extended' }, withSMA: [] } }] }],
  }),
});

// Backward-compat prompts (light/full) → map to default/extended
server.registerPrompt('ichimoku_light_chart', {
  description: '[deprecated] Use ichimoku_default_chart',
  inputSchema: z.object({ pair: z.string().optional().default('btc_jpy'), type: z.string().optional().default('1day'), limit: z.number().int().min(30).max(200).optional().default(90) }),
  handler: async ({ pair, type, limit }) => ({
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair, type, limit, withIchimoku: true, ichimoku: { mode: 'default' }, withSMA: [] } }] }],
  }),
});
server.registerPrompt('ichimoku_full_chart', {
  description: '[deprecated] Use ichimoku_extended_chart',
  inputSchema: z.object({ pair: z.string().optional().default('btc_jpy'), type: z.string().optional().default('1day'), limit: z.number().int().min(30).max(200).optional().default(90) }),
  handler: async ({ pair, type, limit }) => ({
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair, type, limit, withIchimoku: true, ichimoku: { mode: 'extended' }, withSMA: [] } }] }],
  }),
});

// ---- Prompt: bb_light_chart ----
server.registerPrompt('bb_light_chart', {
  description: 'ボリンジャーバンド（標準: ±2σ）でチャートを描画する（bbMode=default, type: CandleTypeEnum）',
  inputSchema: z.object({
    pair: z.string().optional().default('btc_jpy'),
    type: z.enum(['1day','1week','1month','1hour','4hour']).optional().default('1day'),
    limit: z.number().int().min(30).max(365).optional().default(90),
  }),
  handler: async ({ pair, type, limit }) => {
    return {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_code',
              tool_name: 'render_chart_svg',
              tool_input: { pair, type, limit, withBB: true, bbMode: 'default', withSMA: [] },
            },
          ],
        },
      ],
    };
  },
});

// ---- Prompt: bb_full_chart ----
server.registerPrompt('bb_full_chart', {
  description: 'ボリンジャーバンド（拡張: ±1/±2/±3σ）でチャートを描画する（bbMode=extended, type: CandleTypeEnum）',
  inputSchema: z.object({
    pair: z.string().optional().default('btc_jpy'),
    type: z.enum(['1day','1week','1month','1hour','4hour']).optional().default('1day'),
    limit: z.number().int().min(30).max(365).optional().default(90),
  }),
  handler: async ({ pair, type, limit }) => {
    return {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_code',
              tool_name: 'render_chart_svg',
              tool_input: { pair, type, limit, withBB: true, bbMode: 'extended', withSMA: [] },
            },
          ],
        },
      ],
    };
  },
});

// ---- Prompt: visualize_svg_chart ----
server.registerPrompt(
  'visualize_svg_chart',
  {
    description: 'Generates and displays a candlestick chart as an SVG image.',
    inputSchema: z.object({
      pair: z.string().optional().default('btc_jpy').describe('e.g., btc_jpy'),
      type: z
        .enum(['1day', '1week', '1month', '1hour', '4hour'])
        .optional()
        .default('1day'),
      limit: z.number().int().min(5).max(365).optional().default(60),
    }),
    handler: async ({ pair, type, limit }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${pair.toUpperCase()} の ${type} のチャートを、直近 ${limit} 本のデータでSVG画像として生成・表示してください。`,
            },
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_code',
                tool_name: 'render_chart_svg',
                tool_input: { pair, type, limit },
              },
            ],
          },
        ],
      };
    },
  }
);

// ---- Prompt: market_overview ----
server.registerPrompt(
  'market_overview',
  {
    description:
      'Get a market overview by combining ticker, orderbook, and indicators.',
    inputSchema: z.object({
      pair: z.string().describe('e.g., btc_jpy'),
    }),
    handler: async ({ pair }) => {
      const safePair = pair || 'btc_jpy'; // フォールバックは念のため残す
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${safePair.toUpperCase()}の現在の市場概況を報告してください。

1. \`get_ticker\`で最新価格を取得。
2. \`get_orderbook\`で現在のスプレッドを確認。
3. \`get_indicators\`（日足）でRSIとトレンドを取得。

上記3つの情報をまとめて、簡潔に状況を説明してください。`,
            },
          },
        ],
      };
    },
  }
);

// ---- Prompt: visualize_chart ----
server.registerPrompt(
  'visualize_chart',
  {
    description:
      'Visualizes candle data as a chart by using the `render_chart_html` tool.',
    inputSchema: z.object({
      pair: z.string().optional().default('btc_jpy').describe('e.g., btc_jpy'),
      type: z.enum(['1min','5min','15min','30min','1hour','4hour','8hour','12hour','1day','1week','1month']).optional().default('1day'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(90)
        .describe('Number of candles to render'),
    }),
    handler: async ({ pair, type, limit }) => {
      const safePair = pair || 'btc_jpy';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${safePair.toUpperCase()}の${type}チャートをHTMLとして描画してください。

\`render_chart_html\`ツールを使い、直近${limit}本分のデータを描画したHTMLを生成してください（ライブラリを埋め込むために \`embedLib: true\` を指定してください）。

実行後、返された\`data.html\`の内容をそのまま提示してください。`,
            },
          },
        ],
      };
    },
  }
);

// === stdio ===
const transport = new StdioServerTransport();
await server.connect(transport);
