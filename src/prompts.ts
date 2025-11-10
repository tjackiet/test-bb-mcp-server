// MCP Prompts 定義（既存の server 側プロンプトを集約）
import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 型定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export enum PromptLevel {
  BEGINNER = 'beginner',
  INTERMEDIATE = 'intermediate',
  ADVANCED = 'advanced',
}

export enum PromptCategory {
  ANALYSIS = 'analysis',
  VISUALIZATION = 'visualization',
  EDUCATION = 'education',
  WORKFLOW = 'workflow',
}

export interface PromptMetadata {
  level: PromptLevel;
  category: PromptCategory;
  estimatedTime?: string;
  prerequisites?: string[];
  tags?: string[];
}

export interface PromptDef {
  name: string;
  description: string;
  // server 側 register 用: 既存 messages をそのまま移行
  messages: Array<{
    role: 'system' | 'assistant' | 'user';
    content: any[];
  }>;
  // 表示用の引数メタ（存在しない既存もあるため任意）
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  metadata?: PromptMetadata;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 用語解説データベース（Phase 1 要求分のみ）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface TermExplanation {
  shortDef: string;
  analogy: string;
  ranges: Record<string, string>;
  usage: string;
  warning: string;
  related: string[];
}

export const termExplanations: Record<string, TermExplanation> = {
  RSI: {
    shortDef: '買われすぎ・売られすぎを数値化した指標',
    analogy: 'お店の人気度メーター',
    ranges: { '70': '買われすぎ（そろそろ下がるかも）', '30': '売られすぎ（そろそろ上がるかも）', default: '中立（どちらでもない）' },
    usage: '70以上で売り検討、30以下で買い検討',
    warning: '強いトレンドでは70以上・30以下が続くことがあります',
    related: ['MACD', 'ストキャスティクス'],
  },
  MACD: {
    shortDef: 'トレンドの勢いと転換点を見る指標',
    analogy: '自動車の加速・減速メーター',
    ranges: { goldenCross: 'ゴールデンクロス（買いシグナル）', deadCross: 'デッドクロス（売りシグナル）' },
    usage: '線が交差するタイミングで売買を検討',
    warning: 'ダマシも多いため他指標と併用',
    related: ['RSI', '移動平均線'],
  },
  ボリンジャーバンド: {
    shortDef: '価格が動く範囲を帯で示したもの',
    analogy: '道路の車線のようなもの',
    ranges: { upper: '上の帯（買われすぎの可能性）', lower: '下の帯（売られすぎの可能性）', middle: '中央線（平均価格）' },
    usage: '帯の外に出たら中央へ戻る可能性を考える',
    warning: '強いトレンドでは帯に沿って動き続けることがあります',
    related: ['移動平均線', 'ATR'],
  },
  板: {
    shortDef: '今出されている買い注文と売り注文のリスト',
    analogy: 'スーパーの値札と在庫数',
    ranges: { bid: '買い注文（買いたい人の希望価格と量）', ask: '売り注文（売りたい人の希望価格と量）' },
    usage: '厚い板の価格帯は突破しにくい「壁」になりやすい',
    warning: '板は一瞬で変わるため、スナップショットと捉える',
    related: ['スプレッド', '出来高'],
  },
  スプレッド: {
    shortDef: '買える最安値と売れる最高値の差',
    analogy: '店の買取価格と販売価格の差',
    ranges: { narrow: '狭い（100円以下）: 取引しやすい', wide: '広い（500円以上）: 価格が飛びやすい' },
    usage: 'スプレッドが狭い時の方が有利',
    warning: '流動性が低い時間帯は広がりやすい',
    related: ['板', '流動性'],
  },
  出来高: {
    shortDef: '一定期間に取引された数量',
    analogy: 'お店の来客数やレジ通過数',
    ranges: { high: '多い＝活発（注目度高い）', low: '少ない＝静か（値動き出にくい）', default: '平均的' },
    usage: '急増は注目イベントの可能性、トレンドの信頼性確認に併用',
    warning: '価格変動と併せて判断（出来高単独は誤認の恐れ）',
    related: ['トレンド', 'ボラティリティ'],
  },
  ローソク足: {
    shortDef: '一定期間の値動きを1本で表すチャート要素',
    analogy: '1日の天気をアイコンで表すイメージ',
    ranges: { long: '長い＝大きな値動き', short: '短い＝小さな値動き', default: '中程度' },
    usage: '実体とヒゲで勢い・拒否・反転の手がかり',
    warning: '1本だけで結論にせず、連続性や出来高も参照',
    related: ['トレンド', '出来高'],
  },
  移動平均線: {
    shortDef: '一定期間の平均価格をつないだ線',
    analogy: '道の傾き（上り坂/下り坂）',
    ranges: { bullish: '価格＞線＝強気傾向', bearish: '価格＜線＝弱気傾向', cross: '交差＝転換の兆し' },
    usage: '25/75/200などを組み合わせて方向性・支持抵抗を確認',
    warning: '遅行性があるため急変には鈍い',
    related: ['トレンド', 'ボラティリティ'],
  },
  トレンド: {
    shortDef: '価格が続いて動く方向性',
    analogy: '川の流れ（上流→下流）',
    ranges: { up: '上昇', down: '下降', range: '横ばい' },
    usage: '上昇は押し目買い、下降は戻り売りなど方針の基礎',
    warning: '時間軸で異なる方向が出るため軸の統一が必要',
    related: ['移動平均線', '出来高'],
  },
  ボラティリティ: {
    shortDef: '価格変動の大きさ',
    analogy: '波の高さ（荒波/凪）',
    ranges: { high: '高い＝大きく動く', low: '低い＝小さく動く', default: '平均的' },
    usage: 'リスク管理・ポジションサイズの目安、指標はATRやRVなど',
    warning: '高ボラは機会とリスクが同時に増える',
    related: ['出来高', '移動平均線'],
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 既存プロンプト（server.ts から移行）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export const prompts: PromptDef[] = [
  {
    name: 'bb_default_chart',
    description: 'Render chart with Bollinger Bands default (±2σ).',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'BB(±2σ)付きチャートを表示して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair (e.g., btc_jpy)', required: false },
      { name: 'type', description: 'Timeframe (e.g., 1day, 1hour)', required: false },
      { name: 'limit', description: 'Number of candles', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.VISUALIZATION, tags: ['chart', 'bollinger-bands', 'visualization'] },
  },
  {
    name: 'candles_only_chart',
    description: 'Render plain candlestick chart only (no indicators).',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'ローソク足だけのチャートを表示して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'type', description: 'Timeframe', required: false },
      { name: 'limit', description: 'Number of candles', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.VISUALIZATION, tags: ['chart', 'candles', 'simple'] },
  },
  {
    name: 'bb_extended_chart',
    description: 'Render chart with Bollinger Bands extended (±1/±2/±3σ). Use only if user explicitly requests extended.',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'BB拡張（±1/±2/±3σ）チャートを表示して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'type', description: 'Timeframe', required: false },
      { name: 'limit', description: 'Number of candles', required: false },
    ],
    metadata: { level: PromptLevel.ADVANCED, category: PromptCategory.VISUALIZATION, tags: ['chart', 'bollinger-bands', 'extended', 'advanced'] },
  },
  {
    name: 'ichimoku_default_chart',
    description: 'Render chart with Ichimoku default (Tenkan/Kijun/Cloud only).',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '一目均衡表（標準）を表示して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'type', description: 'Timeframe', required: false },
      { name: 'limit', description: 'Number of candles', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.VISUALIZATION, tags: ['chart', 'ichimoku', 'japanese'] },
  },
  {
    name: 'ichimoku_extended_chart',
    description: 'Render chart with Ichimoku extended (includes Chikou). Use only if user explicitly requests extended.',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '一目均衡表（拡張・遅行含む）を表示して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'type', description: 'Timeframe', required: false },
      { name: 'limit', description: 'Number of candles', required: false },
    ],
    metadata: { level: PromptLevel.ADVANCED, category: PromptCategory.VISUALIZATION, tags: ['chart', 'ichimoku', 'extended', 'advanced'] },
  },
  {
    name: 'depth_analysis',
    description: 'Analyze current orderbook depth (bids/asks) and summarize liquidity/imbalance.',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '板の状況（深さ）を分析して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.ANALYSIS, tags: ['orderbook', 'depth', 'liquidity'] },
  },
  {
    name: 'depth_chart',
    description: 'Render a depth-focused analysis (calls get_depth first).',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '板の状況を見て必要なら可視化して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.VISUALIZATION, tags: ['orderbook', 'depth', 'chart'] },
  },
  {
    name: 'flow_analysis',
    description: 'Analyze recent transactions-derived flow metrics with numeric tags and concise conclusion.',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'フロー（出来高・CVD）を分析して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'limit', description: 'Number of transactions', required: false },
      { name: 'bucketMs', description: 'Bucket size in milliseconds', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.ANALYSIS, tags: ['flow', 'cvd', 'transactions'] },
  },
  {
    name: 'orderbook_pressure_analysis',
    description: 'Assess orderbook pressure in ±pct bands with numeric tags and concise conclusion.',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '板の圧力（±%帯域）を評価して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'delayMs', description: 'Delay in milliseconds', required: false },
      { name: 'bandsPct', description: 'Percentage bands', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.ANALYSIS, tags: ['orderbook', 'pressure', 'bands'] },
  },
  {
    name: 'multi_factor_signal',
    description: 'Quick multi-factor market signal: flow metrics, volatility and indicators (no chart unless asked).',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '総合シグナル（フロー/ボラ/指標）を素早く評価して' }] },
    ],
    arguments: [
      { name: 'pair', description: 'Trading pair', required: false },
      { name: 'limit', description: 'Number of data points', required: false },
      { name: 'bucketMs', description: 'Bucket size for flow analysis', required: false },
      { name: 'type', description: 'Timeframe', required: false },
      { name: 'volLimit', description: 'Limit for volatility metrics', required: false },
      { name: 'indLimit', description: 'Limit for indicators', required: false },
    ],
    metadata: { level: PromptLevel.INTERMEDIATE, category: PromptCategory.WORKFLOW, tags: ['comprehensive', 'multi-factor', 'signal'] },
  },
  // --- Phase 1-2: Beginner prompts ---
  {
    name: 'beginner_market_check',
    description: '【初心者向け】今、買い時？売り時？をわかりやすく説明',
    arguments: [
      { name: 'pair', description: '通貨ペア（例: btc_jpy, eth_jpy）', required: false },
    ],
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '今、買い時？売り時？を初心者向けに教えて' }] }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'analysis', 'buy-sell-timing'],
    },
  },
  {
    name: 'beginner_chart_view',
    description: '【初心者向け】チャートの見方を解説しながら表示',
    arguments: [
      { name: 'pair', description: '通貨ペア（例: btc_jpy, eth_jpy）', required: false },
      { name: 'days', description: '表示する日数（デフォルト: 60日）', required: false },
    ],
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'チャートを見せて。見方も初心者向けに教えて' }] }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.VISUALIZATION,
      estimatedTime: '1分',
      prerequisites: [],
      tags: ['beginner', 'chart', 'education', 'candlestick', 'moving-average'],
    },
  },
  {
    name: 'explain_term',
    description: '【初心者向け】専門用語をわかりやすく解説',
    arguments: [
      { name: 'term', description: '解説してほしい用語（例: RSI, MACD, ボリンジャーバンド, 板, スプレッド）', required: true },
    ],
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'RSIって何？（初心者向けに説明して）' }] }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.EDUCATION,
      estimatedTime: '1分',
      tags: ['beginner', 'education', 'terminology', 'glossary'],
    },
  },
  {
    name: 'getting_started',
    description: '【初心者向け】test-bbの使い方ガイド',
    arguments: [],
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'test-bbの使い方を教えて（初心者向け）' }] }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.EDUCATION,
      estimatedTime: '2分',
      tags: ['beginner', 'education', 'getting-started', 'guide', 'tutorial'],
    },
  },
  {
    name: 'beginner_volume_check',
    description: '【初心者向け】取引量から市場の活発さをチェック',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '今、取引は活発？（出来高を初心者向けに教えて）' }] }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'volume', 'activity']
    },
  },
  {
    name: 'beginner_trend_check',
    description: '【初心者向け】今の流れは上昇？下降？横ばい？',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '今のトレンドを初心者向けに教えて' }] }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'trend']
    },
  },
  {
    name: '最近のBTCの動きどう？',
    description: 'ビットコインの最近の価格動向とトレンドを初心者向けに分析',
    messages: [
      {
        role: 'assistant', content: [{
          type: 'text', text: `最近のBTCの動きどう？

【重要】専門用語は使わず、以下のように置き換えて説明してください：
- RSI → 加熱度（70以上で過熱、30以下で冷え込み）
- MACD → 勢いの変化
- ボリンジャーバンド → 価格の変動幅
- σ(シグマ) → 標準的な範囲
- SMA/移動平均線 → 平均価格
- デッドクロス/ゴールデンクロス → 勢いの転換点
- 一目均衡表 → トレンドの雲
- CVD → 買いと売りのバランス

テキストで簡潔に。チャートは不要。` }]
      }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'btc', 'trend', 'price']
    }
  },
  {
    name: '今のBTCって買い時？',
    description: '総合的な市場シグナルから今が買い時かを初心者向けに判断',
    messages: [
      {
        role: 'assistant', content: [{
          type: 'text', text: `今のBTCって買い時？

【重要】専門用語は使わず、以下のように置き換えて説明してください：
- RSI → 加熱度（70以上で過熱、30以下で冷え込み）
- MACD → 勢いの変化
- ボリンジャーバンド → 価格の変動幅
- σ(シグマ) → 標準的な範囲
- SMA/移動平均線 → 平均価格

結論（買い/売り/様子見）を先に言ってください。

テキストで判断を。チャートは不要。` }]
      }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'btc', 'buy-timing', 'signal']
    }
  },
  {
    name: '今注目されているコインある？',
    description: '出来高や価格変動から注目されている銘柄を抽出',
    messages: [
      {
        role: 'assistant', content: [{
          type: 'text', text: `今注目されているコインある？

【効率的な回答方法】
1. get_tickers_jpy を1回だけ呼び出す
2. 取得したデータから以下を抽出:
   - 取引量トップ3（取引の活発さ）
   - 24時間上昇率トップ3（価格の上がり）
3. 個別の詳細分析（analyze_market_signal等）は不要
4. 各コインの情報は簡潔に:
   - 名前
   - 価格
   - 24時間の変化率
   - 取引の活発さ（出来高）

【専門用語の扱い】
- 出来高 → 取引の活発さ
- 騰落率 → 24時間の変化率

リスト形式で。チャートは不要。` }]
      }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'ranking', 'volume', 'attention']
    }
  },
  {
    name: '今日の上昇率ランキングは？',
    description: '全銘柄の24時間騰落率ランキングトップ5を表示',
    messages: [
      {
        role: 'assistant', content: [{
          type: 'text', text: `今日の上昇率ランキングは？

【重要】専門用語は避けて説明してください：
- 騰落率 → 価格の上がり/下がり（%）
- 24h change → 24時間での変化

トップ5を数値で教えて。チャートは不要。` }]
      }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '20秒',
      tags: ['beginner', 'ranking', 'price-change', 'gainers']
    }
  },
  {
    name: 'ビットコインは買いと売りどちらが優勢？',
    description: '板情報から買い圧力と売り圧力を分析して優勢な方を判定',
    messages: [
      {
        role: 'assistant', content: [{
          type: 'text', text: `ビットコインは買いと売りどちらが優勢？

【重要】専門用語は使わず、以下のように置き換えて説明してください：
- 板の厚み → 注文の多さ
- bid/ask → 買い注文/売り注文
- スプレッド → 買値と売値の差
- CVD → 買いと売りのバランス
- orderbook pressure → 買い圧力/売り圧力

結論（買い優勢/売り優勢/拮抗）を先に言ってください。

テキストで説明して。チャートは不要。` }]
      }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      estimatedTime: '30秒',
      tags: ['beginner', 'orderbook', 'pressure', 'buy-sell']
    }
  },
  {
    name: 'test_simple',
    description: 'テスト用シンプルPrompt',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ビットコインの現在の価格を教えてください。' }
        ]
      }
    ],
    metadata: {
      level: PromptLevel.BEGINNER,
      category: PromptCategory.ANALYSIS,
      tags: ['test']
    }
  },
];
