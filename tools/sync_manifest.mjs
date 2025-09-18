#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
  GetTickerInputSchema,
  GetOrderbookInputSchema,
  GetCandlesInputSchema,
  GetIndicatorsInputSchema,
  RenderChartSvgInputSchema,
} from '../src/schemas.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, '..');

function zodToSimpleJson(schema) {
  // Minimal shape (type/default/enum) for description.json
  const def = schema._def;
  if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = schema.shape;
    const out = {};
    for (const [k, v] of Object.entries(shape)) {
      out[k] = zodToSimpleJson(v);
    }
    return out;
  }
  if (def.typeName === z.ZodDefault) {
    const inner = zodToSimpleJson(def.innerType);
    inner.default = def.defaultValue();
    return inner;
  }
  if (def.typeName === z.ZodOptional) {
    const inner = zodToSimpleJson(def.innerType);
    inner.optional = true;
    return inner;
  }
  if (def.typeName === z.ZodEnum) {
    return { type: 'string', enum: def.values.slice() };
  }
  if (def.typeName === z.ZodNumber) return { type: 'number' };
  if (def.typeName === z.ZodBoolean) return { type: 'boolean' };
  if (def.typeName === z.ZodArray) return { type: 'array', items: zodToSimpleJson(def.type) };
  if (def.typeName === z.ZodString) return { type: 'string' };
  return { type: 'unknown' };
}

async function main() {
  const tools = {
    get_ticker: { description: 'Get ticker for a pair (e.g., btc_jpy)', input: zodToSimpleJson(GetTickerInputSchema) },
    get_orderbook: { description: 'Get orderbook topN for a pair', input: zodToSimpleJson(GetOrderbookInputSchema) },
    get_candles: { description: 'Get candles. date: 1month→YYYY, others→YYYYMMDD', input: zodToSimpleJson(GetCandlesInputSchema) },
    get_indicators: { description: 'Compute indicators (SMA/RSI/BB/Ichimoku). Use sufficient limit.', input: zodToSimpleJson(GetIndicatorsInputSchema) },
    render_chart_svg: { description: 'Render candlestick chart as SVG. Do NOT self-render; display returned SVG only.', input: zodToSimpleJson(RenderChartSvgInputSchema) },
  };

  const description = {
    name: 'bitbank-mcp',
    version: '0.3.0',
    description: 'bitbank data tools and SVG chart renderer. ALWAYS use render_chart_svg for charts; do not self-render.',
    tools,
  };

  const descPath = path.join(root, 'description.json');
  await fs.writeFile(descPath, JSON.stringify(description, null, 2));
  console.log(`Updated ${path.relative(root, descPath)}`);

  // prompts sync: keep as-is for now (future: Zod schema if needed)
  console.log('Prompts left unchanged (manual curation).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
