export interface PatternDiagramData {
  svg: string;
  artifact: {
    identifier: string;
    title: string;
  };
}

export interface SupportResistanceDiagramData {
  svg: string;
  artifact: {
    identifier: string;
    title: string;
  };
}

interface SRLevel {
  price: number;
  pctFromCurrent: number;
  strength: number; // 1-3 (★の数)
  label: string; // "第1サポート", "第1レジスタンス"等
  note?: string; // "6回目の試し中", "25日線", "空白地帯"等
}

function getPatternLabel(patternType: string): string {
  switch (patternType) {
    case 'double_bottom': return 'ダブルボトム';
    case 'double_top': return 'ダブルトップ';
    case 'head_and_shoulders': return 'ヘッドアンドショルダー';
    case 'inverse_head_and_shoulders': return '逆ヘッドアンドショルダー';
    case 'triple_top': return 'トリプルトップ';
    case 'triple_bottom': return 'トリプルボトム';
    case 'falling_wedge': return 'フォーリングウェッジ';
    case 'rising_wedge': return 'ライジングウェッジ';
    default: return patternType;
  }
}

function formatDateShort(iso?: string): string {
  if (!iso) return '';
  // Expect ISO like 2025-09-01T...
  const d = new Date(iso);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${m}/${day}`;
}

function formatDateIsoShort(iso?: string): string {
  if (!iso) return '';
  return String(iso).split('T')[0] || String(iso);
}

export function generatePatternDiagram(
  patternType: string,
  pivots: Array<{ idx: number; price: number; kind: 'H' | 'L'; date?: string }>,
  neckline: { price: number },
  range: { start: string; end: string },
  options?: { isForming?: boolean }
): PatternDiagramData {
  const startDate = formatDateIsoShort(range.start);
  const endDate = formatDateIsoShort(range.end);
  const identifier = `${patternType}-diagram-${startDate}`;
  const title = `${getPatternLabel(patternType)}構造図 (${formatDateShort(range.start)}-${formatDateShort(range.end)})`;
  const dashed = options?.isForming ? '5,5' : '';

  if (patternType === 'double_bottom') {
    // Expect order: valley1 (L), peak (H), valley2 (L)
    const v1 = pivots.find(p => p.kind === 'L');
    const pk = pivots.find(p => p.kind === 'H');
    const rest = pivots.filter(p => p.kind === 'L' && p !== v1);
    const v2 = rest.length ? rest[0] : undefined;
    const valley1Date = formatDateShort(v1?.date);
    const peakDate = formatDateShort(pk?.date);
    const valley2Date = formatDateShort(v2?.date);
    const necklinePrice = Math.round(neckline.price).toLocaleString();
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <line x1="50" y1="100" x2="550" y2="100" stroke="#666" stroke-width="2" stroke-dasharray="5,5"/>
  <text x="350" y="95" fill="#555" font-size="12">ネックライン: ${necklinePrice}円</text>
  <polyline points="150,250 250,100 350,250" fill="none" stroke="#ccc" stroke-width="2"/>
  <line x1="50" y1="50" x2="150" y2="250" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="350" y1="250" x2="550" y2="50" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <circle cx="150" cy="250" r="6" fill="#3b82f6"/>
  <text x="150" y="280" text-anchor="middle" fill="#333" font-size="14">谷: ${valley1Date}</text>
  <circle cx="250" cy="100" r="6" fill="#3b82f6"/>
  <text x="250" y="80" text-anchor="middle" fill="#333" font-size="14">山: ${peakDate}</text>
  <circle cx="350" cy="250" r="6" fill="#3b82f6"/>
  <text x="350" y="280" text-anchor="middle" fill="#333" font-size="14">谷: ${valley2Date}</text>
  <text x="300" y="30" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${formatDateShort(range.start)}-${formatDateShort(range.end)})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'double_top') {
    // Expect order: peak1 (H), valley (L), peak2 (H)
    const p1 = pivots.find(p => p.kind === 'H');
    const vl = pivots.find(p => p.kind === 'L');
    const rest = pivots.filter(p => p.kind === 'H' && p !== p1);
    const p2 = rest.length ? rest[0] : undefined;
    const peak1Date = formatDateShort(p1?.date);
    const valleyDate = formatDateShort(vl?.date);
    const peak2Date = formatDateShort(p2?.date);
    const necklinePrice = Math.round(neckline.price).toLocaleString();
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <line x1="50" y1="200" x2="550" y2="200" stroke="#666" stroke-width="2" stroke-dasharray="5,5"/>
  <text x="350" y="215" fill="#555" font-size="12">ネックライン: ${necklinePrice}円</text>
  <polyline points="150,70 250,200 350,70" fill="none" stroke="#ccc" stroke-width="2"/>
  <line x1="50" y1="250" x2="150" y2="70" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="350" y1="70" x2="550" y2="250" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <circle cx="150" cy="70" r="6" fill="#3b82f6"/>
  <text x="150" y="55" text-anchor="middle" fill="#333" font-size="14">山: ${peak1Date}</text>
  <circle cx="250" cy="200" r="6" fill="#3b82f6"/>
  <text x="250" y="235" text-anchor="middle" fill="#333" font-size="14">谷: ${valleyDate}</text>
  <circle cx="350" cy="70" r="6" fill="#3b82f6"/>
  <text x="350" y="55" text-anchor="middle" fill="#333" font-size="14">山: ${peak2Date}</text>
  <text x="300" y="30" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${formatDateShort(range.start)}-${formatDateShort(range.end)})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'inverse_head_and_shoulders') {
    // Expect order: left shoulder (L), peak1 (H), head (L), peak2 (H), right shoulder (L)
    const leftShoulder = pivots[0];
    const peak1 = pivots[1];
    const head = pivots[2];
    const peak2 = pivots[3];
    const rightShoulder = pivots[4];
    const lsDate = formatDateShort((leftShoulder as any)?.date);
    const p1Date = formatDateShort((peak1 as any)?.date);
    const headDate = formatDateShort((head as any)?.date);
    const p2Date = formatDateShort((peak2 as any)?.date);
    const rsDate = formatDateShort((rightShoulder as any)?.date);
    // ネックライン: 山1/山2の平均価格（表示用）
    const nlVal = (((peak1?.price ?? 0) + (peak2?.price ?? 0)) / 2);
    const necklinePrice = Math.round(nlVal).toLocaleString();
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <!-- Neckline (peaks average) -->
  <line x1="50" y1="80" x2="550" y2="80" stroke="#666" stroke-width="2" stroke-dasharray="5,5"/>
  <text x="300" y="95" text-anchor="middle" fill="#555" font-size="12">ネックライン: ${necklinePrice}円</text>
  <!-- Structural polyline: L1 -> H1 -> L(head) -> H2 -> L3 -->
  <polyline points="100,180 200,80 300,240 400,80 500,180" fill="none" stroke="#ccc" stroke-width="2"/>
  <!-- Trend guide lines (left/right) -->
  <line x1="50" y1="40" x2="100" y2="180" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="500" y1="180" x2="550" y2="40" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <!-- Pivot markers -->
  <circle cx="100" cy="180" r="6" fill="#3b82f6"/>
  <text x="100" y="205" text-anchor="middle" fill="#333" font-size="14">左肩: ${lsDate}</text>
  <circle cx="200" cy="80" r="6" fill="#3b82f6"/>
  <text x="200" y="65" text-anchor="middle" fill="#333" font-size="14">山1: ${p1Date}</text>
  <circle cx="300" cy="240" r="6" fill="#3b82f6"/>
  <text x="300" y="265" text-anchor="middle" fill="#333" font-size="14">谷: ${headDate}</text>
  <circle cx="400" cy="80" r="6" fill="#3b82f6"/>
  <text x="400" y="65" text-anchor="middle" fill="#333" font-size="14">山2: ${p2Date}</text>
  <circle cx="500" cy="180" r="6" fill="#3b82f6"/>
  <text x="500" y="205" text-anchor="middle" fill="#333" font-size="14">右肩: ${rsDate}</text>
  <text x="300" y="20" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${formatDateShort(range.start)}-${formatDateShort(range.end)})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'head_and_shoulders') {
    // Expect order: left shoulder (H), valley1 (L), head (H), valley2 (L), right shoulder (H)
    const leftShoulder = pivots[0];
    const valley1 = pivots[1];
    const head = pivots[2];
    const valley2 = pivots[3];
    const rightShoulder = pivots[4];
    const lsDate = formatDateShort((leftShoulder as any)?.date);
    const v1Date = formatDateShort((valley1 as any)?.date);
    const headDate = formatDateShort((head as any)?.date);
    const v2Date = formatDateShort((valley2 as any)?.date);
    const rsDate = formatDateShort((rightShoulder as any)?.date);
    // ネックライン: 谷1/谷2の平均価格（表示用）
    const nlVal = (((valley1?.price ?? 0) + (valley2?.price ?? 0)) / 2);
    const necklinePrice = Math.round(nlVal).toLocaleString();
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <!-- Neckline (valleys average) -->
  <line x1="50" y1="220" x2="550" y2="220" stroke="#666" stroke-width="2" stroke-dasharray="5,5"/>
  <text x="300" y="210" text-anchor="middle" fill="#555" font-size="12">ネックライン: ${necklinePrice}円</text>
  <!-- Structural polyline: H1 -> L1 -> H(head) -> L2 -> H3 -->
  <polyline points="100,120 200,220 300,60 400,220 500,120" fill="none" stroke="#ccc" stroke-width="2"/>
  <!-- Trend guide lines (left/right) -->
  <line x1="50" y1="260" x2="100" y2="120" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="500" y1="120" x2="550" y2="260" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <!-- Pivot markers -->
  <circle cx="100" cy="120" r="6" fill="#3b82f6"/>
  <text x="100" y="105" text-anchor="middle" fill="#333" font-size="14">左肩: ${lsDate}</text>
  <circle cx="200" cy="220" r="6" fill="#3b82f6"/>
  <text x="200" y="245" text-anchor="middle" fill="#333" font-size="14">谷1: ${v1Date}</text>
  <circle cx="300" cy="60" r="6" fill="#3b82f6"/>
  <text x="300" y="45" text-anchor="middle" fill="#333" font-size="14">山: ${headDate}</text>
  <circle cx="400" cy="220" r="6" fill="#3b82f6"/>
  <text x="400" y="245" text-anchor="middle" fill="#333" font-size="14">谷2: ${v2Date}</text>
  <circle cx="500" cy="120" r="6" fill="#3b82f6"/>
  <text x="500" y="105" text-anchor="middle" fill="#333" font-size="14">右肩: ${rsDate}</text>
  <text x="300" y="20" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${formatDateShort(range.start)}-${formatDateShort(range.end)})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'triple_bottom') {
    // Expect order: L1, H1, L2, H2, L3
    const valley1 = pivots[0];
    const peak1 = pivots[1];
    const valley2 = pivots[2];
    const peak2 = pivots[3];
    const valley3 = pivots[4];
    const v1Date = formatDateShort((valley1 as any)?.date);
    const p1Date = formatDateShort((peak1 as any)?.date);
    const v2Date = formatDateShort((valley2 as any)?.date);
    const p2Date = formatDateShort((peak2 as any)?.date);
    const v3Date = formatDateShort((valley3 as any)?.date);
    const nlVal = (((peak1?.price ?? 0) + (peak2?.price ?? 0)) / 2);
    const necklinePrice = Math.round(nlVal).toLocaleString();
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <!-- Neckline (peaks average) -->
  <line x1="50" y1="120" x2="550" y2="120" stroke="#666" stroke-width="2" stroke-dasharray="5,5"/>
  <text x="450" y="135" text-anchor="start" fill="#555" font-size="12">ネックライン: ${necklinePrice}円</text>
  <!-- Structural polyline: L1 -> H1 -> L2 -> H2 -> L3 -->
  <polyline points="80,250 165,120 250,250 335,120 420,250" fill="none" stroke="#ccc" stroke-width="2"/>
  <!-- Trend guide lines -->
  <line x1="30" y1="80" x2="80" y2="250" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="420" y1="250" x2="570" y2="80" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <!-- Pivots -->
  <circle cx="80" cy="250" r="6" fill="#3b82f6"/><text x="80" y="275" text-anchor="middle" fill="#333" font-size="14">谷1: ${v1Date}</text>
  <circle cx="165" cy="120" r="6" fill="#3b82f6"/><text x="165" y="105" text-anchor="middle" fill="#333" font-size="14">山1: ${p1Date}</text>
  <circle cx="250" cy="250" r="6" fill="#3b82f6"/><text x="250" y="275" text-anchor="middle" fill="#333" font-size="14">谷2: ${v2Date}</text>
  <circle cx="335" cy="120" r="6" fill="#3b82f6"/><text x="335" y="105" text-anchor="middle" fill="#333" font-size="14">山2: ${p2Date}</text>
  <circle cx="420" cy="250" r="6" fill="#3b82f6"/><text x="420" y="275" text-anchor="middle" fill="#333" font-size="14">谷3: ${v3Date}</text>
  <text x="300" y="20" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${formatDateShort(range.start)}-${formatDateShort(range.end)})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'triple_top') {
    // Expect order: H1, L1, H2, L2, H3
    const peak1 = pivots[0];
    const valley1 = pivots[1];
    const peak2 = pivots[2];
    const valley2 = pivots[3];
    const peak3 = pivots[4];
    const p1Date = formatDateShort((peak1 as any)?.date);
    const v1Date = formatDateShort((valley1 as any)?.date);
    const p2Date = formatDateShort((peak2 as any)?.date);
    const v2Date = formatDateShort((valley2 as any)?.date);
    const p3Date = formatDateShort((peak3 as any)?.date);
    const nlVal = (((valley1?.price ?? 0) + (valley2?.price ?? 0)) / 2);
    const necklinePrice = Math.round(nlVal).toLocaleString();
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <!-- Neckline (valleys average) -->
  <line x1="50" y1="210" x2="550" y2="210" stroke="#666" stroke-width="2" stroke-dasharray="5,5"/>
  <text x="480" y="200" text-anchor="start" fill="#555" font-size="12">ネックライン: ${necklinePrice}円</text>
  <!-- Structural polyline: H1 -> L1 -> H2 -> L2 -> H3 -->
  <polyline points="80,80 165,210 250,80 335,210 420,80" fill="none" stroke="#ccc" stroke-width="2"/>
  <!-- Trend guide lines -->
  <line x1="30" y1="250" x2="80" y2="80" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="420" y1="80" x2="570" y2="250" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <!-- Pivots -->
  <circle cx="80" cy="80" r="6" fill="#3b82f6"/><text x="80" y="65" text-anchor="middle" fill="#333" font-size="14">山1: ${p1Date}</text>
  <circle cx="165" cy="210" r="6" fill="#3b82f6"/><text x="165" y="235" text-anchor="middle" fill="#333" font-size="14">谷1: ${v1Date}</text>
  <circle cx="250" cy="80" r="6" fill="#3b82f6"/><text x="250" y="65" text-anchor="middle" fill="#333" font-size="14">山2: ${p2Date}</text>
  <circle cx="335" cy="210" r="6" fill="#3b82f6"/><text x="335" y="235" text-anchor="middle" fill="#333" font-size="14">谷2: ${v2Date}</text>
  <circle cx="420" cy="80" r="6" fill="#3b82f6"/><text x="420" y="65" text-anchor="middle" fill="#333" font-size="14">山3: ${p3Date}</text>
  <text x="300" y="20" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${formatDateShort(range.start)}-${formatDateShort(range.end)})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'falling_wedge') {
    // テンプレート図（600x300）。上側/下側の収束ライン、主要タッチ、アペックス、上抜け矢印を描画
    // 傾きや位置はサンプル配置（視覚的分かりやすさ優先）
    const startShort = formatDateShort(range.start);
    const endShort = formatDateShort(range.end);
    // 主要タッチポイント（間引き想定、固定配置）
    const touchPoints = [
      { x: 100, y: 80 }, { x: 200, y: 100 }, { x: 300, y: 120 }, { x: 400, y: 140 }, { x: 500, y: 160 },
      { x: 150, y: 180 }, { x: 250, y: 200 }, { x: 350, y: 220 }, { x: 450, y: 240 },
    ];
    const zigzag = '100,80 150,180 200,100 250,200 300,120 350,220 400,140 450,240 500,160';
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <!-- 収束ライン（上側・下側） -->
  <line x1="100" y1="80" x2="500" y2="180" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="100" y1="180" x2="500" y2="240" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <!-- 構造ジグザグ -->
  <polyline points="${zigzag}" fill="none" stroke="#bbb" stroke-width="2"/>
  <!-- アペックス（右端やや先） -->
  <circle cx="550" cy="210" r="8" fill="#f97316"/>
  <text x="550" y="230" text-anchor="middle" fill="#333" font-size="12">収束点</text>
  <!-- ブレイクアウト矢印（上方向） -->
  <path d="M 520 160 L 520 100 L 510 110 M 520 100 L 530 110" stroke="#16a34a" stroke-width="3" fill="none"/>
  <text x="540" y="100" fill="#16a34a" font-size="14">上抜け期待</text>
  <!-- 主要タッチポイント（間引き） -->
  ${touchPoints.slice(0, 5).map(p => `<circle cx="${p.x}" cy="${p.y}" r="6" fill="#3b82f6"/>`).join('')}
  <text x="300" y="30" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${startShort}-${endShort})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  if (patternType === 'rising_wedge') {
    // テンプレート図（600x300）。上側/下側の収束ライン、主要タッチ、アペックス、下抜け矢印を描画
    const startShort = formatDateShort(range.start);
    const endShort = formatDateShort(range.end);
    const touchPoints = [
      { x: 100, y: 240 }, { x: 200, y: 220 }, { x: 300, y: 200 }, { x: 400, y: 180 }, { x: 500, y: 160 },
      { x: 150, y: 200 }, { x: 250, y: 180 }, { x: 350, y: 160 }, { x: 450, y: 140 },
    ];
    const zigzag = '100,240 150,200 200,220 250,180 300,200 350,160 400,180 450,140 500,160';
    const svg =
      `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <!-- 収束ライン（上側・下側） -->
  <line x1="100" y1="200" x2="500" y2="100" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <line x1="100" y1="240" x2="500" y2="140" stroke="#ccc" stroke-width="2" stroke-dasharray="${dashed}"/>
  <!-- 構造ジグザグ -->
  <polyline points="${zigzag}" fill="none" stroke="#bbb" stroke-width="2"/>
  <!-- アペックス（右端やや先） -->
  <circle cx="550" cy="110" r="8" fill="#f97316"/>
  <text x="550" y="95" text-anchor="middle" fill="#333" font-size="12">収束点</text>
  <!-- ブレイクアウト矢印（下方向） -->
  <path d="M 520 160 L 520 220 L 510 210 M 520 220 L 530 210" stroke="#ef4444" stroke-width="3" fill="none"/>
  <text x="540" y="230" fill="#ef4444" font-size="14">下抜け期待</text>
  <!-- 主要タッチポイント（間引き） -->
  ${touchPoints.slice(0, 5).map(p => `<circle cx="${p.x}" cy="${p.y}" r="6" fill="#3b82f6"/>`).join('')}
  <text x="300" y="30" text-anchor="middle" fill="#111" font-size="14">${getPatternLabel(patternType)} (${startShort}-${endShort})</text>
</svg>`;
    return { svg, artifact: { identifier, title } };
  }

  // Fallback (other patterns not yet implemented)
  const svg =
    `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="300" fill="#f8f9fa"/>
  <text x="300" y="150" text-anchor="middle" fill="#111" font-size="16">${getPatternLabel(patternType)} 構造図は準備中です</text>
</svg>`;
  return { svg, artifact: { identifier, title } };
}

export function generateSupportResistanceDiagram(
  currentPrice: number,
  supports: SRLevel[],
  resistances: SRLevel[],
  options?: {
    highlightNearestSupport?: boolean;
    highlightNearestResistance?: boolean;
  }
): SupportResistanceDiagramData {
  const identifier = `support-resistance-diagram-${Date.now()}`;
  const title = `サポート・レジスタンス構造図`;

  // 価格帯を正規化（現在価格を中心に配置）
  const allLevels = [
    ...resistances.map(r => ({ ...r, type: 'resistance' as const })),
    { price: currentPrice, pctFromCurrent: 0, strength: 0, label: '現在価格', note: undefined, type: 'current' as const },
    ...supports.map(s => ({ ...s, type: 'support' as const }))
  ].sort((a, b) => b.price - a.price); // 価格降順

  // SVG設定
  const width = 700;
  const height = 600;
  const margin = { top: 60, right: 150, bottom: 100, left: 100 };
  const plotHeight = height - margin.top - margin.bottom;

  // 価格レンジ計算
  const maxPrice = allLevels[0].price;
  const minPrice = allLevels[allLevels.length - 1].price;
  const priceRange = maxPrice - minPrice;
  const priceScale = plotHeight / priceRange;

  // Y座標計算関数
  const getY = (price: number) => {
    return margin.top + (maxPrice - price) * priceScale;
  };

  // ライン描画データ生成
  const lines = allLevels.map((level, idx) => {
    const y = getY(level.price);
    const priceStr = Math.round(level.price).toLocaleString();
    const pctStr = level.pctFromCurrent !== 0
      ? `(${level.pctFromCurrent > 0 ? '+' : ''}${level.pctFromCurrent.toFixed(1)}%)`
      : '';

    let color = '#666';
    let strokeWidth = 2;
    let dashArray = '5,5';
    let emoji = '';

    if (level.type === 'resistance') {
      color = '#ef4444';
      strokeWidth = level.strength + 1;
      emoji = '🔴';
      const resistanceIdx = resistances.findIndex(r => r.price === level.price);
      if (options?.highlightNearestResistance && resistanceIdx === 0) {
        strokeWidth = 5;
      }
    } else if (level.type === 'support') {
      color = '#22c55e';
      strokeWidth = level.strength + 1;
      emoji = '🟢';
      const supportIdx = supports.findIndex(s => s.price === level.price);
      if (options?.highlightNearestSupport && supportIdx === 0) {
        strokeWidth = 5;
      }
    } else if (level.type === 'current') {
      color = '#3b82f6';
      strokeWidth = 3;
      dashArray = '';
      emoji = '📍';
    }

    const stars = level.strength > 0 ? ' ' + '★'.repeat(level.strength) + '☆'.repeat(3 - level.strength) : '';
    const labelText = `${emoji} ${level.label}: ${priceStr}円 ${pctStr}${stars}`;

    return {
      y,
      color,
      strokeWidth,
      dashArray,
      labelText,
      note: level.note,
      type: level.type,
      price: level.price
    };
  });

  // 矢印と距離ラベル描画（隣接レベル間）
  const arrows = [];
  for (let i = 0; i < allLevels.length - 1; i++) {
    const current = allLevels[i];
    const next = allLevels[i + 1];
    const y1 = getY(current.price);
    const y2 = getY(next.price);
    const midY = (y1 + y2) / 2;
    const pctDiff = Math.abs(((next.price - current.price) / current.price) * 100);

    // 特殊な距離（空白地帯など）を強調
    let distanceColor = '#666';
    let distanceLabel = `${pctDiff.toFixed(1)}%`;

    if (current.type === 'current' && next.type === 'support') {
      if (pctDiff > 2) {
        distanceColor = '#ef4444';
        distanceLabel = `${pctDiff.toFixed(1)}% (空白)`;
      }
    }

    arrows.push({
      x: margin.left - 40,
      y1: y1 + 5,
      y2: y2 - 5,
      midY,
      label: distanceLabel,
      color: distanceColor
    });
  }

  // SVG生成
  const lineElements = lines.map((line, idx) => `
  <line x1="${margin.left}" y1="${line.y}" x2="${width - margin.right + 30}" y2="${line.y}" 
        stroke="${line.color}" stroke-width="${line.strokeWidth}" ${line.dashArray ? `stroke-dasharray="${line.dashArray}"` : ''} />
  <text x="${width - margin.right + 40}" y="${line.y + 5}" fill="${line.color}" font-size="13" font-weight="bold">
    ${line.labelText}
  </text>
  ${line.note ? `<text x="${width - margin.right + 40}" y="${line.y + 20}" fill="#666" font-size="11">
    (${line.note})
  </text>` : ''}`).join('');

  const arrowElements = arrows.map(arrow => `
  <line x1="${arrow.x}" y1="${arrow.y1}" x2="${arrow.x}" y2="${arrow.y2}" 
        stroke="${arrow.color}" stroke-width="1.5" marker-end="url(#arrowhead-${arrow.color.replace('#', '')})" />
  <text x="${arrow.x - 35}" y="${arrow.midY + 4}" fill="${arrow.color}" font-size="11" text-anchor="end">
    ${arrow.label}
  </text>`).join('');

  // リスク距離の警告レベル判定
  const nearestSupportPct = supports[0]?.pctFromCurrent || 0;
  const nearestResistancePct = resistances[0]?.pctFromCurrent || 0;
  const maxDownsidePct = supports[supports.length - 1]?.pctFromCurrent || 0;
  const maxUpsidePct = resistances[resistances.length - 1]?.pctFromCurrent || 0;

  const supportWarning = Math.abs(nearestSupportPct) < 1 ? ' ⚠️ 非常に近い' :
    Math.abs(nearestSupportPct) < 2 ? ' (注意)' : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrowhead-ef4444" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
      <polygon points="0 0, 10 5, 0 10" fill="#ef4444" />
    </marker>
    <marker id="arrowhead-666" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
      <polygon points="0 0, 10 5, 0 10" fill="#666" />
    </marker>
  </defs>
  <rect width="${width}" height="${height}" fill="#fafafa"/>
  
  <!-- タイトル -->
  <text x="${width / 2}" y="30" text-anchor="middle" fill="#111" font-size="18" font-weight="bold">${title}</text>
  
  <!-- ライン -->
  ${lineElements}
  
  <!-- 距離矢印 -->
  ${arrowElements}
  
  <!-- リスク距離ボックス -->
  <rect x="30" y="${height - 90}" width="280" height="80" fill="white" stroke="#ccc" stroke-width="1" rx="5"/>
  <text x="40" y="${height - 70}" fill="#111" font-size="13" font-weight="bold">リスク距離</text>
  <text x="40" y="${height - 50}" fill="#22c55e" font-size="11">最も近いサポート: ${nearestSupportPct.toFixed(1)}%${supportWarning}</text>
  <text x="40" y="${height - 35}" fill="#ef4444" font-size="11">最も近いレジスタンス: +${nearestResistancePct.toFixed(1)}%</text>
  <text x="40" y="${height - 20}" fill="#666" font-size="11">最大下落リスク: ${maxDownsidePct.toFixed(1)}% / 上昇余地: +${maxUpsidePct.toFixed(1)}%</text>
</svg>`;

  return { svg, artifact: { identifier, title } };
}


