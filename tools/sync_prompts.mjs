#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

// Single source: keep the same definitions as server.ts registerPromptSafe calls
const prompts = {
  bb_light_chart: {
    description: 'Render chart with Bollinger Bands light (±2σ).',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [ { role: 'assistant', content: [ { type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'light', withSMA: [] } } ] } ]
  },
  bb_full_chart: {
    description: 'Render chart with Bollinger Bands full (±1/±2/±3σ). Use only if user explicitly requests full.',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [ { role: 'assistant', content: [ { type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'full', withSMA: [] } } ] } ]
  },
  ichimoku_default_chart: {
    description: 'Render chart with Ichimoku default (Tenkan/Kijun/Cloud only).',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [ { role: 'assistant', content: [ { type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withIchimoku: true, ichimoku: { mode: 'default' }, withSMA: [] } } ] } ]
  },
  ichimoku_extended_chart: {
    description: 'Render chart with Ichimoku extended (includes Chikou). Use only if user explicitly requests extended.',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [ { role: 'assistant', content: [ { type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withIchimoku: true, ichimoku: { mode: 'extended' }, withSMA: [] } } ] } ]
  }
};

async function main() {
  const outPath = path.join(root, 'prompts.json');
  await fs.writeFile(outPath, JSON.stringify({ prompts }, null, 2));
  console.log(`Updated ${path.relative(root, outPath)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });


