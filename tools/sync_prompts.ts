import fs from 'fs/promises';
import path from 'path';

// server.ts の定義と整合させた最小エクスポート（将来は抽出を自動化）
const prompts = {
  bb_light_chart: {
    description: 'Render chart with Bollinger Bands default (±2σ).',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'default', withSMA: [] } }] }]
  },
  bb_full_chart: {
    description: 'Render chart with Bollinger Bands extended (±1/±2/±3σ). Use only if user explicitly requests extended.',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: true, bbMode: 'extended', withSMA: [] } }] }]
  },
  ichimoku_default_chart: {
    description: 'Render chart with Ichimoku default (Tenkan/Kijun/Cloud only).',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withIchimoku: true, ichimoku: { mode: 'default' }, withSMA: [] } }] }]
  },
  ichimoku_extended_chart: {
    description: 'Render chart with Ichimoku extended (includes Chikou). Use only if user explicitly requests extended.',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [{ role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withIchimoku: true, ichimoku: { mode: 'extended' }, withSMA: [] } }] }]
  },
  patterns_analysis: {
    description: 'Render chart then detect classic patterns. Do not self-render; explain candidates only.',
    input: { pair: 'btc_jpy', type: '1day', limit: 90 },
    messages: [
      { role: 'system', content: [{ type: 'text', text: '自前描画は禁止。まず render_chart_svg を実行し、続けて detect_patterns を呼び出して候補のみを解説してください。追加実行は行わず、返却 svg/filePath をそのまま表示します。' }] },
      { role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}' } }] },
      { role: 'assistant', content: [{ type: 'tool_code', tool_name: 'detect_patterns', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}' } }] }
    ]
  },
  candles_only_chart: {
    description: 'Render plain candlestick chart only (no indicators).',
    input: { pair: 'btc_jpy', type: '1day', limit: 60 },
    messages: [
      { role: 'system', content: [{ type: 'text', text: '追加の指標は取得・描画しないでください。ろうそく足のみ。render_chart_svg を呼び、withBB=false, withSMA=[], withIchimoku=false を指定します。' }] },
      { role: 'assistant', content: [{ type: 'tool_code', tool_name: 'render_chart_svg', tool_input: { pair: '{{pair}}', type: '{{type}}', limit: '{{limit}}', withBB: false, withSMA: [], withIchimoku: false } }] }
    ]
  }
};

async function main() {
  const outPath = path.join(process.cwd(), 'prompts.json');
  await fs.writeFile(outPath, JSON.stringify({ prompts }, null, 2));
  console.log(`Updated ${path.relative(process.cwd(), outPath)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });


