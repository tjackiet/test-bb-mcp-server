import 'dotenv/config';

// src/server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  getTicker,
  getOrderbook,
  getCandles,
  getIndicators,
  renderChartHtml,
  renderChartSvg,
  getSimpleTrend,
} from '../tools/index.js';
import { logToolRun, logError } from '../lib/logger.js';

const server = new McpServer({ name: 'bitbank-mcp', version: '0.1.0' });

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
    inputSchema: {
      pair: z.string().optional().default('btc_jpy').describe('e.g., btc_jpy'),
    },
  },
  async ({ pair }) => getTicker(pair)
);

// ---- get_orderbook ----
registerToolWithLog(
  'get_orderbook',
  {
    description: 'Get orderbook topN for a pair',
    inputSchema: {
      pair: z.string().describe('e.g., btc_jpy'),
      topN: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(10)
        .describe('Top levels to return'),
    },
  },
  async ({ pair, topN }) => getOrderbook(pair, topN)
);

// ---- get_candles ---- (view対応)
registerToolWithLog(
  'get_candles',
  {
    description: 'Get candles. date: 1month → YYYY, others → YYYYMMDD',
    inputSchema: {
      pair: z.string().describe('e.g., btc_jpy'),
      type: z.enum([
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
      ]),
      date: z.string().describe('YYYY (1month) or YYYYMMDD (others)'),
      limit: z.number().int().min(1).max(1000).optional().default(200),
      view: z
        .enum(['full', 'items'])
        .optional()
        .default('full')
        .describe('full: all fields / items: ".data.normalized.items" only'),
    },
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
        .describe('Number of candles to use for calculation'),
    },
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
      'ローソク足チャートをSVG画像形式で描画します。インジケータの表示も可能です。',
    inputSchema: {
      pair: z.string().optional().default('btc_jpy'),
      type: z.string().optional().default('1day'),
      limit: z.number().int().min(5).max(365).optional().default(60),
      withSMA: z
        .array(z.number().int())
        .optional()
        .default([25, 75])
        .describe('描画する単純移動平均線の期間を配列で指定。空配列[]で非表示。'),
      withBB: z
        .boolean()
        .optional()
        .default(true)
        .describe('ボリンジャーバンドを描画するかどうか'),
      withIchimoku: z
        .boolean()
        .optional()
        .default(false)
        .describe('一目均衡表を描画するかどうか'),
    },
  },
  async (args) => renderChartSvg(args)
);

// ---- get_simple_trend ----
registerToolWithLog(
  'get_simple_trend',
  {
    description: '20期間MAと一目均衡表に基づいたシンプルな市場トレンド（強気/弱気/中立）を取得します。',
    inputSchema: {
      pair: z.string().optional().default('btc_jpy'),
      type: z.string().optional().default('1day'),
      limit: z.number().int().min(30).max(365).optional().default(100),
    },
  },
  async (args) => getSimpleTrend(args)
);

// ---- Prompt: analyze_simple_trend ----
server.registerPrompt('analyze_simple_trend', {
  description:
    'シンプルなインジケータ（20期間MAと一目均衡表）を用いて市場トレンドを分析し、初心者向けに解説します。',
  inputSchema: z.object({
    pair: z
      .string()
      .optional()
      .default('btc_jpy')
      .describe('分析する通貨ペア (例: btc_jpy)'),
    type: z
      .string()
      .optional()
      .default('1day')
      .describe('ローソク足の時間軸 (例: 1day)'),
  }),
  handler: async ({ pair, type }) => {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `
${pair.toUpperCase()} の市場トレンドを分析してください。

1. \`get_simple_trend\` ツールを呼び出し、現在のトレンド（bullish/bearish/neutral）と、その根拠となる短いコメントを取得します。
2. ツールの返却値を事実のベースとして利用し、特に初心者にも分かりやすいように、専門用語を避けながら平易な日本語で解説を作成してください。

ユーザーの元の質問が「ビットコインは上がる？下がる？」のような非常に曖昧なものであっても、上記の手順に従って分析的な回答を生成してください。`,
          },
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
