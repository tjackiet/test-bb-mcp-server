// src/server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import getTicker from "../tools/get_ticker.js";
import getOrderbook from "../tools/get_orderbook.js";
import getCandles from "../tools/get_candles.js";

const server = new McpServer({ name: "bitbank-mcp", version: "0.1.0" });

const respond = (result) => ({
  content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  structuredContent: result,
});

// ---- get_ticker ----
server.registerTool(
  "get_ticker",
  {
    description: "Get ticker for a pair (e.g., btc_jpy)",
    inputSchema: {
      pair: z.string().optional().default("btc_jpy").describe("e.g., btc_jpy"),
    },
  },
  async ({ pair }) => respond(await getTicker(pair))
);

// ---- get_orderbook ----
server.registerTool(
  "get_orderbook",
  {
    description: "Get orderbook topN for a pair",
    inputSchema: {
      pair: z.string().describe("e.g., btc_jpy"),
      topN: z.number().int().min(1).max(1000).optional().default(10)
            .describe("Top levels to return"),
    },
  },
  async ({ pair, topN }) => respond(await getOrderbook(pair, topN))
);

// ---- get_candles ---- (view対応)
server.registerTool(
  "get_candles",
  {
    description:
      "Get candles. date: 1month → YYYY, others → YYYYMMDD",
    inputSchema: {
      pair: z.string().describe("e.g., btc_jpy"),
      type: z.enum([
        "1min","5min","15min","30min",
        "1hour","4hour","8hour","12hour",
        "1day","1week","1month",
      ]),
      date: z.string().describe("YYYY (1month) or YYYYMMDD (others)"),
      limit: z.number().int().min(1).max(1000).optional().default(200),
      view: z.enum(["full", "items"]).optional().default("full")
            .describe('full: all fields / items: ".data.normalized.items" only'),
    },
  },
  async ({ pair, type, date, limit, view }) => {
    const result = await getCandles(pair, type, date, limit);
    if (view === "items") {
      const items = result?.data?.normalized?.items ?? [];
      return {
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
        structuredContent: items,
      };
    }
    return respond(result);
  }
);

// === stdio ===
const transport = new StdioServerTransport();
await server.connect(transport);
