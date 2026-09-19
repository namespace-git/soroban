---
version: 1
slug: "src-renderer-app-vue"
primary_target: "src/renderer/App.vue"
related_targets: ["src/renderer/views/Dashboard.vue","src/renderer/views/Sales.vue","src/renderer/views/Purchases.vue","src/renderer/views/Inventory.vue","src/renderer/views/Settings.vue","src/renderer/style.css"]
---

# そろばん — 全画面（アプリシェル + 5画面）

## Scope

- 対象：`src/renderer/` 全体（App.vue、views/*、style.css、新設 components/）。全画面の再設計（redesign）。旧い見た目は反面教師。
- モード：**Operate**。家族が説明なしに毎日の入力（発送方法・紐付け・仕入登録）を終える道具。
- 残すもの：機能・文言・データ構造・IPC契約（`src/shared/types.ts`）・色の意味（利益=緑／損失=赤／要対応=琥珀）。
- 触らないもの：`src/main/`、`src/preload/`、`src/shared/`。

## Audience and job

- 作者本人と家族。13〜15インチのノートPC。発送前後にさっと開く。
- 毎日：売上で「発送方法を選ぶ」→「紐付ける」の2操作、1件10秒。クリック数を増やす提案は却下。
- 月1：月次の確認、バックアップ、滞留在庫の確認。

## Direction contract

THESIS: 日本の業務SaaS標準（マネーフォワード クラウド級）を、そろばんの5画面で正確に演じる。奇をてらわない配置を、細部の精度で「汎用」から引き離す。拒むもの：同サイズのアイコン＋見出し＋本文カードの並び、hero-metric テンプレ、カード内カード、モーダル頼み、絵文字・Unicode記号のアイコン。

OWN-WORLD: ライト。地は薄い寒色グレー（キャンバス）、コンテンツは白面、1pxの罫で区切る。インクは濃いスレート、補助文はスレートグレー（グレー地ではなく地色から導く）。ブランド青は主ボタン・選択・フォーカスにだけ。利益=緑／損失=赤／要対応=琥珀 は数字とチップに限定し、装飾に使わない。書体は日本語システム系1族（Hiragino Sans / Yu Gothic UI / Meiryo）を見出しから数字まで通し、金額は tabular-nums で右端の1本の軸に揃える。段階は 12/13/14/16/20/28px の固定スケール。アイコンは authored SVG（1.5px ストローク、20px グリッド）で1系統。左サイドナビ（220px）＋上部バー（48px）＋コンテンツ。状態語彙：hover／focus-visible（青2px）／disabled／loading（スケルトン）／empty（教えるコピー）／error。角丸 6px、影は offset+blur を持つ1段のみ（ドロワー・ポップオーバー）。

STORY: 開いた瞬間に「今日やることが何件か」が読める。売上へ移り、行の中で発送方法を選ぶと粗利の欄が「未確定」から数字へ変わる。原価の欄を押すと右からドロワーが出て、在庫を1つチェックするたびに下端の粗利が動く。「紐付ける」で閉じ、行が確定色になる。家族はこの2操作しか覚えなくてよい。

FIRST VIEWPORT（ホーム、1366×768）: 左220pxにナビ（ホーム／売上／仕入／在庫／月次／設定。売上には要対応件数のバッジ）。上部48pxのバーに「そろばん」、右に最終取り込みの状態テキスト、「メルカリにログイン」（secondary）、「取り込む」（primary）。コンテンツ先頭は「要対応」の帯：白面に「送料が未入力 N件」「仕入が未紐付け N件」の2つの行アクション（琥珀の数字、右端に→）。要対応0件なら緑のチェックと1行のコピー。その下に「今月の転売」を1枚の白面に4列（売上／原価／手数料・送料／粗利）で、数字は20px、粗利だけ28pxで色付き、右下に件数。その下に「在庫」（未販売点数／寝ている資金／長期滞留）を同じ白面の続きとして1行で。最後に取り込み状況の1行。主要アクションはナビの「売上」バッジと要対応の行。

FORM: 標準の出口（canon）。自前候補リストの1位は「宅配の複写伝票」、ロールは6位「荷札と値札」だったが、ユーザーが canon を選択。seed key: **85adf745**。品質基準：マネーフォワード クラウド。

SIGNATURE INTERACTION: 売上テーブル行内の「発送方法」セレクト変更 → 同じ行の「粗利」セルが 180ms で「未確定」から色付きの数字へ入れ替わる（一操作で全部が確定する）。紐付けドロワーではチェックのたびに下端の「原価／粗利」が即時更新され、確定でドロワーが右へ 200ms で退き、行の状態チップが「未紐付け」→ 消える。

MOTION GRAMMAR: 150〜200ms、ease-out、transform+opacity のみ。ページロード演出なし。ドロワーのスライドと数値の入れ替わりの2つだけが動く。`prefers-reduced-motion` で全て即時。

BUILD NOTES（実装時の判断。契約からの逸脱はここに理由を書く）:
- ワードマーク「そろばん」は上部バーではなく左サイドナビの先頭に置いた。マネーフォワード型の慣行に合わせ、上部バーは取り込み状態と2つのアクションに専念させるため。
- 在庫の統計は当初「今月の転売」と別カードにしていたが、finish review の指摘で契約どおり同じ白面の続き（1px 罫で区切る）に戻した。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Structure (agreed restructuring)

- ナビ6項目：ホーム／売上／仕入／在庫／月次／設定。「在庫」内サブタブだった月次は独立ページに。
- 紐付けはモーダルをやめ、右ドロワー（幅 560px、テーブルは背後に見える）。
- 販売の手入力・仕入登録は「＋ 登録」ボタンでページ上部に展開するインラインフォーム（現状踏襲、部品を新世界で作り直す）。
- 削除は行末のアイコンボタン（SVG）＋ confirm。

## States and ranges

- 売上：月20〜50件。未処理のみ既定。0件の空状態は「未処理はありません」＋全件へのリンク。
- 紐付け候補：30〜100点。類似度順、検索欄が先頭、上位が見える。0点は「先に仕入を登録」の教えるコピー。
- 取り込み：ok／empty／auth_required／failed を上部バーの状態テキストとトーストで。empty は琥珀で目立たせる。
- ローディング：スケルトン行（テーブル）／スケルトン数値（ホーム）。

## Constraints

- CSP `default-src 'self'`：外部フォント・CDN不可。システム書体、SVGはインライン。
- 金額は integer、レンダラーで再計算しない（紐付けプレビューだけ例外、packaging_cost も引く）。
- `window.soroban.*` 以外の経路なし。IPC契約は変えない。
- ダークモードは今回スコープ外（トークンは意味で命名し、後から `prefers-color-scheme` 層を足せる形にする）。
- 本文 14px 未満を増やさない。フォーカスは常に可視。

## Open decisions (builder must not invent)

- なし。上記で決定済み。
