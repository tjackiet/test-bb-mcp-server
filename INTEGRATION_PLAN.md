# detect_patterns & detect_forming_patterns 統合計画

**作成日**: 2025-12-04  
**目的**: 2つのパターン検出ツールを統合し、一貫性のある高品質な検出を実現

---

## 📋 現状の問題点

### 1. 検出結果の不一致
| ツール | Falling Wedge 期間 | ブレイク | 結果 |
|--------|-------------------|----------|------|
| `detect_patterns` | 9/23〜11/14 | 下方（11/14） | 失敗 ❌ |
| `detect_forming_patterns` | 11/2〜11/26 | 上方（11/26） | 成功 ✅ |

**根本原因**: ピボット検出ロジックとトレンドライン検出の実装が異なる

### 2. 保守性の問題
- 3400行の `detect_forming_patterns.ts` と 2500行の `detect_patterns.ts`
- 重複したロジック、独立した改善が困難
- バグ修正が両方に必要

### 3. ユーザー体験の問題
- Claude が2つのツールを呼び出す必要がある
- 結果の解釈に混乱（どちらが正しい？）
- プロンプトが複雑

---

## 🎯 統合後の目標

### 単一のツール `detect_patterns`
```typescript
detect_patterns(pair, type, limit, {
  patterns: ['falling_wedge', 'rising_wedge', ...],
  includeForming: true,      // 形成中パターンを含める
  includeCompleted: true,    // 完成済みパターンを含める
  includeInvalid: false,     // 無効化済みパターンを含める（デフォルトoff）
  // ... 既存のオプション
})
```

### 出力フォーマット
```typescript
{
  type: 'falling_wedge',
  status: 'forming' | 'completed' | 'invalid',
  confidence: 0.95,
  range: { start: '2025-11-02', end: '2025-11-26' },
  breakoutDirection?: 'up' | 'down',
  outcome?: 'success' | 'failure',
  apexDate?: '2025-11-30',
  daysToApex?: 4,
  // ...
}
```

### 期待される動作
- **9/23〜11/14** と **11/2〜11/26** の**両方**を検出
- 重複除去で最適なものを1つ選択（ユーザー設定可能）
- ライフサイクル全体を追跡：形成中 → 完成 → ブレイク/無効化

---

## 📐 統合戦略

### Option A: detect_patterns を拡張（推奨）✅
**理由**:
- 既にピボットベース検出が完成
- 9/23-11/14 の Falling Wedge を正確に検出
- 完成済みパターンのロジックが成熟

**作業**:
1. `status` 管理機能を追加
2. ブレイク検出ロジックを統合（forming からコピー）
3. 形成中フィルタを追加

### Option B: detect_forming_patterns を拡張
**理由**:
- 形成中パターンのロジックが充実
- ただし、11/2-11/26 の検出が不正確

**問題**: 基盤となる検出精度が低い

---

## 🛠️ 実装計画（8ステップ）

### ステップ1: 現状分析 📊
**タスク**:
- [ ] 両ツールのピボット検出ロジックを比較
- [ ] トレンドライン検出の差分を特定
- [ ] ブレイク検出ロジックの差分を特定
- [ ] 重複コード箇所をリストアップ

**成果物**: 差分レポート（Markdown）

---

### ステップ2: 統合仕様の策定 📝
**タスク**:
- [ ] `status` フィールドの定義
  - `forming`: 形成中（ブレイク未検出、アペックス未到達）
  - `near_completion`: アペックス接近（10日以内）
  - `completed`: ブレイク成功
  - `invalid`: ブレイク失敗または無効化
- [ ] `includeForming/Completed/Invalid` オプションの動作定義
- [ ] 出力フォーマットの統一
- [ ] 重複除去ポリシーの決定

**成果物**: 統合仕様書（このドキュメントに追記）

---

### ステップ3: detect_patterns にステータス管理追加 🔧
**タスク**:
- [ ] `status` フィールドを追加
- [ ] `apexDate`, `daysToApex` 計算ロジックを追加
- [ ] `includeForming/Completed/Invalid` オプションを追加
- [ ] フィルタリングロジックを実装

**テスト**:
```bash
# デフォルト（完成済みのみ）
detect_patterns(pair, type, limit)

# 形成中も含める
detect_patterns(pair, type, limit, { includeForming: true })

# 無効化済みも含める
detect_patterns(pair, type, limit, { includeInvalid: true })
```

**成果物**: 更新された `detect_patterns.ts`

---

### ステップ4: ピボット検出ロジックの統一 🎯
**タスク**:
- [ ] `detect_forming_patterns` のピボット検出を `detect_patterns` 基準に統一
  - `swingDepth`: 形成中検出では 1 → 6（日足）
  - `findUpperTrendline/findLowerTrendline`: 基準を統一
- [ ] タッチ判定閾値を統一（0.5%）
- [ ] タッチ間隔フィルタ（25本以内）
- [ ] 開始日ギャップフィルタ（10本以内）

**テスト**:
```bash
# 9/23-11/14 が検出されること
# 11/2-11/26 も検出されること（重複除去前）
```

**成果物**: 統一された検出ロジック

---

### ステップ5: ブレイク検出ロジックの統合 💥
**タスク**:
- [ ] `detect_forming_patterns` のブレイク検出を `detect_patterns` にマージ
  - 上方/下方ブレイクの区別
  - トレンドライン乖離ベース（2%）
  - 持続的ブレイクの判定
- [ ] `breakoutDirection`, `outcome` フィールドを追加
- [ ] ブレイク日を `range.end` に反映

**テスト**:
```bash
# 11/26 の上方ブレイクが検出されること
# breakoutDirection: 'up', outcome: 'success' であること
```

**成果物**: 完全なブレイク検出機能

---

### ステップ6: テスト実行 ✅
**テストケース**:

#### 6.1. 基本検出
- [ ] Falling Wedge 9/23-11/14（下方ブレイク、失敗）が検出される
- [ ] Falling Wedge 11/2-11/26（上方ブレイク、成功）が検出される
- [ ] 両方が検出された場合、重複除去で適切なものが選ばれる

#### 6.2. ステータス管理
- [ ] `includeForming: false` → 形成中パターンが除外される
- [ ] `includeCompleted: true` → 完成済みパターンが含まれる
- [ ] `includeInvalid: false` → 無効化済みが除外される

#### 6.3. ブレイク検出
- [ ] 上方ブレイク → `status: 'completed'`, `outcome: 'success'`
- [ ] 下方ブレイク → `status: 'invalid'`, `outcome: 'failure'`
- [ ] ブレイク日が正確

#### 6.4. エッジケース
- [ ] アペックス到達済みだがブレイク未発生 → `status: 'near_completion'`
- [ ] 複数のウェッジが重複 → 適切な優先順位で選択

**テストスクリプト**: `tools/test_integration.ts`

---

### ステップ7: プロンプト更新 📄
**タスク**:
- [ ] `src/prompts.ts` の「中級：BTCのパターン分析をして」を更新
  - `detect_patterns` のみを呼び出す
  - `includeForming: true, includeCompleted: true`
  - `detect_forming_chart_patterns` の呼び出しを削除
- [ ] 出力フォーマットを調整
  - `status` に応じて表示を分ける
  - 形成中 / 完成済み / 無効化済み のセクション

**テスト**:
```bash
# Claude に「BTCのパターン分析をして」を依頼
# 形成中と完成済みが両方表示されること
# 11/2-11/26 の上方ブレイク成功が表示されること
```

**成果物**: 更新された `src/prompts.ts`

---

### ステップ8: クリーンアップ 🧹
**タスク**:
- [ ] `detect_forming_patterns.ts` を deprecated にマーク
- [ ] README に移行ガイドを追記
- [ ] 一定期間後に `detect_forming_patterns.ts` を削除
- [ ] 不要なテストファイルを削除

**成果物**: クリーンなコードベース

---

## 📊 リスクと対策

### リスク1: 既存機能の破壊
**対策**:
- 段階的な実装（各ステップでテスト）
- 既存のテストケースを保持
- `detect_forming_patterns` は残して並行運用

### リスク2: 性能劣化
**対策**:
- ベンチマークテストを実施
- 必要に応じて最適化

### リスク3: 統合後のバグ
**対策**:
- 充実したテストスイート
- ユーザーフィードバック収集期間

---

## 📈 成功指標

- [ ] 9/23-11/14 と 11/2-11/26 の両方が正しく検出される
- [ ] ブレイク方向と結果が正確
- [ ] プロンプトがシンプルになる（ツール呼び出し1回）
- [ ] コード行数が削減される（目標: -30%）
- [ ] テストカバレッジ向上

---

## 🚀 実装スケジュール

| ステップ | 予想時間 | 状態 |
|---------|---------|------|
| 1. 現状分析 | 30分 | ⬜ 未着手 |
| 2. 仕様策定 | 30分 | ⬜ 未着手 |
| 3. ステータス管理追加 | 1時間 | ⬜ 未着手 |
| 4. ピボット統一 | 1.5時間 | ⬜ 未着手 |
| 5. ブレイク統合 | 1時間 | ⬜ 未着手 |
| 6. テスト実行 | 1時間 | ⬜ 未着手 |
| 7. プロンプト更新 | 30分 | ⬜ 未着手 |
| 8. クリーンアップ | 30分 | ⬜ 未着手 |
| **合計** | **約6-7時間** | |

---

## 📝 備考

- このドキュメントは実装中に随時更新
- 各ステップ完了時にチェックボックスを更新
- 問題や変更があれば「備考」に記録

---

**次のステップ**: ステップ1（現状分析）から開始

---

## 📊 ステップ1: 現状分析結果

### ファイルサイズ
| ファイル | 行数 |
|----------|------|
| detect_patterns.ts | 2,532 |
| detect_forming_patterns.ts | 3,582 |
| **合計** | **6,114** |

### 差分サマリー

#### 1. ピボット検出
| 項目 | detect_patterns | detect_forming_patterns |
|------|-----------------|-------------------------|
| swingDepth | **6**（日足） | **1**（前後1本のみ） |
| 判定方法 | 前後6本すべてと比較 | 前後1本との単純比較 |
| ピボット数 | 少ない（15H, 17L） | 多い（76H, 79L） |

**影響**: forming は多くのピボットを検出するため、より多くのウィンドウでパターンを見つけられる。しかし、ノイズも多い。

#### 2. トレンドライン検出
| 項目 | detect_patterns | detect_forming_patterns |
|------|-----------------|-------------------------|
| 候補分割 | 1/3, 2/3 | 1/2 |
| 条件 | 厳格 | 緩い |

**影響**: forming は緩い条件のため、より多くのパターンを検出するが、品質は低い可能性。

#### 3. ブレイク検出
| 項目 | detect_patterns | detect_forming_patterns |
|------|-----------------|-------------------------|
| 閾値 | トレンドライン ± 2% | ATR × 0.5 |
| 価格参照 | ローソク本体 | close のみ |
| ブレイク判定 | 即座に確定 | シーケンス管理あり |

**影響**: 
- patterns: よりシンプルで一貫性がある
- forming: ATR ベースは市場環境に適応するが、複雑

### 統合方針（確定）

**detect_patterns のロジックをベースにする理由**:
1. ピボット検出が厳格で、高品質なパターンを検出
2. トレンドライン検出が安定
3. ブレイク検出がシンプルで一貫性がある
4. 9/23-11/14 のパターンを正確に検出済み

**detect_forming_patterns から取り込む機能**:
1. `status` 管理（forming/completed/invalid）
2. `apexDate`, `daysToApex` 計算
3. ブレイク方向の区別（上方/下方）
4. `breakoutResult`（success/failure）

### 重複コード箇所

以下は統合時に削除可能な重複コード:
- `findUpperTrendline` / `findLowerTrendline` 関数
- `makeLine` ヘルパー
- タッチ判定ロジック
- 収束度計算ロジック
- アペックス計算ロジック

**削減見込み**: 約 1,500-2,000 行

---

## 📝 ステップ2: 統合仕様書

### 新しいオプション

```typescript
interface DetectPatternsOptions {
  // 既存オプション
  patterns?: string[];
  swingDepth?: number;
  tolerancePct?: number;
  minBarsBetweenSwings?: number;
  currentRelevanceDays?: number;
  requireCurrentInPattern?: boolean;
  
  // 新規オプション（統合用）
  includeForming?: boolean;    // デフォルト: false
  includeCompleted?: boolean;  // デフォルト: true
  includeInvalid?: boolean;    // デフォルト: false
}
```

### status フィールドの定義

```typescript
type PatternStatus = 
  | 'forming'           // 形成中（ブレイク未検出、アペックス未到達）
  | 'near_completion'   // アペックス接近（10日以内）
  | 'completed'         // ブレイク成功
  | 'invalid';          // ブレイク失敗または無効化
```

### 出力フォーマット（ウェッジ系）

```typescript
interface WedgePattern {
  type: 'falling_wedge' | 'rising_wedge';
  status: PatternStatus;
  confidence: number;           // 0.0 - 1.0
  
  range: {
    start: string;              // ISO8601
    end: string;                // ISO8601（ブレイク日 or 最新日）
  };
  
  // ブレイク情報
  breakoutDirection?: 'up' | 'down';
  outcome?: 'success' | 'failure';
  breakoutDate?: string;        // ISO8601
  
  // 形成中情報
  apexDate?: string;            // ISO8601
  daysToApex?: number;
  completionPct?: number;       // 0-100
  
  // トレンドライン情報
  upperLine?: { slope: number; intercept: number; valueAt: (idx: number) => number };
  lowerLine?: { slope: number; intercept: number; valueAt: (idx: number) => number };
  
  // 価格情報
  currentPrice?: number;
  breakoutTarget?: number;
  invalidationPrice?: number;
}
```

### フィルタリング動作

| オプション | 形成中 | 完成済み | 無効化済み |
|-----------|--------|----------|------------|
| デフォルト | ❌ | ✅ | ❌ |
| includeForming: true | ✅ | ✅ | ❌ |
| includeInvalid: true | ❌ | ✅ | ✅ |
| 全て表示 | ✅ | ✅ | ✅ |

### 重複除去ポリシー

同じタイプのパターンで期間が50%以上重複する場合:

1. **ブレイク済み** > **形成中**
2. ブレイク日が**早い**ものを優先
3. **confidence** が高いものを優先

### Claude 向けの説明文

```
detect_patterns:
  パターン検出ツール（統合版）。
  形成中・完成済み・無効化済みのパターンを一元管理。
  
  オプション:
  - includeForming: true → 形成中パターンを含める
  - includeCompleted: true（デフォルト）→ 完成済みを含める
  - includeInvalid: true → 無効化済みを含める（参考情報として）
  
  status の解釈:
  - forming: 現在形成中（監視継続）
  - near_completion: アペックス接近（注意深く監視）
  - completed: ブレイク成功（シグナル発生）
  - invalid: ブレイク失敗または期限切れ（無視してよい）
```

