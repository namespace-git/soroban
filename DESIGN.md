---
name: そろばん（Soroban）
description: メルカリ転売の利益を家族が10秒で確定させる、業務SaaS標準型のライトUI
colors:
  canvas: "#f3f5f8"
  surface: "#ffffff"
  surface-hi: "#f7f9fc"
  surface-nav: "#ffffff"
  line: "#dfe4ea"
  line-soft: "#eaeef3"
  text: "#1f2933"
  text-dim: "#52606d"
  text-faint: "#7b8794"
  accent: "#2b62c7"
  accent-hover: "#2453ab"
  accent-soft: "#e8effb"
  profit: "#1e7f47"
  profit-bg: "#e6f4ea"
  loss: "#c8322b"
  loss-bg: "#fbe9e7"
  warn: "#9a6700"
  warn-bg: "#fff4d6"
  warn-line: "#e6b84a"
typography:
  display:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.6
    fontFeature: "tnum"
  headline:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.6
  title:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: "0.04em"
  body:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.6
  panel-title:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: "0.02em"
rounded:
  sm: "4px"
  md: "6px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page-x: "28px"
  empty: "48px"
components:
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hi}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-hi}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.loss}"
    rounded: "{rounded.sm}"
    height: "32px"
  button-sm:
    typography: "{typography.body-sm}"
    padding: "3px 8px"
  button-icon:
    padding: "0"
    width: "28px"
    height: "28px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "32px"
  input-invalid:
    backgroundColor: "{colors.warn-bg}"
  checkbox:
    width: "14px"
    height: "14px"
    padding: "0"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "16px 20px"
  chip-neutral:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  chip-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  chip-ok:
    backgroundColor: "{colors.profit-bg}"
    textColor: "{colors.profit}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  chip-info:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  nav-item-hover:
    backgroundColor: "{colors.surface-hi}"
  nav-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  nav-badge:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 5px"
    height: "18px"
  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    padding: "8px 12px"
  table-cell:
    padding: "10px 12px"
  table-row-hover:
    backgroundColor: "{colors.surface-hi}"
  table-row-selected:
    backgroundColor: "{colors.accent-soft}"
  drawer:
    backgroundColor: "{colors.surface}"
    width: "560px"
  toast-ok:
    backgroundColor: "{colors.profit-bg}"
    textColor: "{colors.profit}"
    typography: "{typography.body-sm}"
    padding: "8px 16px"
  toast-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.body-sm}"
    padding: "8px 16px"
---

# Design System: そろばん（Soroban）

## Overview

**Creative North Star: "帳簿係の机上"**

そろばんは、日本の業務SaaS標準（品質基準：マネーフォワード クラウド）を5画面で正確に演じる道具である。寒色グレーの地の上に白い面を置き、1px の罫で区切る。奇をてらった配置はどこにもなく、代わりに数字の桁揃え、罫の階調（`line` と `line-soft` の2段）、状態語彙の一貫性といった細部の精度で「汎用テンプレート」から自分を引き離す。開いた瞬間に「今日やることが何件か」が読め、売上表の行内で発送方法を選び、右ドロワーで在庫にチェックを入れるだけで粗利が確定する。家族が説明なしにこの2操作を終えられることが、すべての視覚判断の基準になる。

密度は「ノートPC 13〜15インチで読む帳簿」。本文 14px、表のセルは 10px/12px のパディング、コンテンツ幅は最大 1100px。色は意味を持つ場所（利益＝緑／損失＝赤／要対応＝琥珀）と操作を持つ場所（ブランド青）にしか現れず、面や罫は無彩色に近い寒色スレートで統一する。書体は日本語システム系1族を見出しから数字まで通し、外部フォントは CSP（`default-src 'self'`）により読めない。

この世界が拒むもの（direction contract で確認済み）：同サイズのアイコン＋見出し＋本文カードの並び、hero-metric テンプレート、カード内カード、モーダル頼み、絵文字・Unicode 記号のアイコン。

**Key Characteristics:**
- 寒色グレーの地（canvas）＋白面（surface）＋1px 罫。影は面ではなく「浮いた層」（ドロワー）にだけ
- ブランド青は主ボタン・選択・フォーカス・アクティブナビの4か所だけ
- 意味色（緑／赤／琥珀）は数字とチップとトーストに限定。装飾には使わない
- 固定タイプスケール 12/13/14/16/20/28px、行間 1.6、ウェイトは 400/500/600 の3段
- 金額は integer 円、`¥` 付き 3桁区切り、tabular-nums。表の中では右端の1本の軸に揃える
- 動くのは2つだけ：ドロワーのスライドと、粗利セルの「未確定→数字」の入れ替わり（180ms ease-out）
- アイコンは authored SVG 1系統（20px グリッド、1.5px ストローク、currentColor）

## Colors

寒色スレートの無彩色が地と罫とインクを担い、彩度を持つ色はブランド青1色と意味色3色だけという、きわめて倹約的なパレット。

### Primary
- **ブランド青（accent）**：主ボタン（「取り込む」「販売を登録」「紐付ける」）の面、`:focus-visible` の 2px アウトライン、キャレット、チェックボックスの `accent-color`。hover は **accent-hover** に沈む。
- **淡い青（accent-soft）**：アクティブなナビ項目の地、選択行（`tr.selected`）、ドロワー内でチェックした候補行、テキスト選択の地。「今ここを選んでいる」を面で示すための色で、装飾には使わない。

### Secondary（意味色）
- **利益の緑（profit / profit-bg）**：正の粗利の数字、`ok` チップ（取り込み「正常」）、`ok` トーストの地。ホームの「要対応なし」のチェックアイコンにも使う。
- **損失の赤（loss / loss-bg）**：負の粗利の数字と `button.danger` の文字だけ。地色（loss-bg）は定義済みだが現在の画面では使われていない。
- **要対応の琥珀（warn / warn-bg / warn-line）**：要対応の件数、ナビの未処理バッジ、`warn` チップ（0件・ログイン必要・失敗）、`warn` トースト、送料未入力のセレクト（`input.invalid` の地と枠）、「紐付け」ボタン。`warn` の文字色は白地で 4.5:1 を満たすよう暗めに取ってある。

### Neutral
- **地（canvas）**：画面全体の背景。薄い寒色グレー。
- **面（surface / surface-nav）**：パネル、表、ボタン、入力、上部バー、サイドナビ。すべて純白。
- **サブ面（surface-hi）**：hover 行、ボタン hover、ニュートラルチップ、スケルトン、按分の注記ブロック。
- **罫（line）**：パネル枠、表のヘッダー下、ナビ右端、上部バー下、ドロワーのヘッダー／フッター。
- **行罫（line-soft）**：表の行と行の間、要対応の行、ホームの「今月の転売」と「在庫」の区切り。`line` より1段薄い。
- **インク（text）**：本文と主要な数字。濃いスレート。
- **補助インク（text-dim）**：ラベル、表ヘッダー、パネル見出し、原価や手数料のような主役でない数字。
- **かすれインク（text-faint）**：単位（「点」「×2」）、日付、件数、ヒント、空状態の補足、行末アクションアイコンの待機色。

### Named Rules
**The Four Doors Rule.** ブランド青が現れてよいのは、主ボタン・選択状態・フォーカス・アクティブナビの4か所だけ。見出しやリンク装飾に青を使わない。

**The Numbers-and-Chips Rule.** 緑／赤／琥珀は数字・チップ・トースト・その入力の枠にだけ塗る。面全体やアイコン飾りには使わない。ホームの琥珀は「件数の数字」だけが色付きで、続く文言はインク色のまま。

**The No-Hex-Elsewhere Rule.** 16進の色値は `style.css` の `:root` 以外に書かない。コンポーネントは `var(--name)` で参照する。唯一の例外はドロワーのスクリム `rgba(31,41,51,.32)`（インク色の透過）。

## Typography

**Display Font:** Hiragino Sans（with Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui）
**Body Font:** 同上（1族で通す）
**Label/Mono Font:** なし。数字は本文書体に `tabular-nums` を効かせる

**Character:** 日本語システム書体1族を見出しから数字まで通す。個性は書体ではなく、ウェイトの3段（400/500/600）と桁揃えの規律で出す。CSP により外部フォントは読めないため、Windows では Yu Gothic UI / Meiryo、macOS では Hiragino Sans で描画される。

### Hierarchy
- **Display**（600, 28px, 1.6, tabular-nums）：ホームの「粗利」1か所だけ。色付き（profit / loss）。
- **Headline**（600, 20px, 1.6）：ページタイトル（`page-title`）、統計の数値（`stat-value`）、要対応の件数。
- **Title**（600, 16px, 1.6, letter-spacing .04em）：ワードマーク「そろばん」。ドロワーのタイトルも 16px/600（字間は通常）。
- **Body**（400, 14px, 1.6）：本文、表のセル、入力、ボタン、ナビ項目。
- **Body-sm**（400, 13px, 1.6）：ツールバー、上部バーの状態テキスト、トースト、`button.sm`、空状態のヒント、ドロワー下端の計算行。
- **Label**（500, 12px, 1.6）：表ヘッダー（500）、フィールドラベル、統計ラベル、チップ、ナビバッジ（600）、単位、注記。
- **Panel title**（600, 13px, letter-spacing .02em, text-dim）：白面の中の小見出し（「要対応」「今月の転売」「在庫」）。

### Named Rules
**The Fixed Ladder Rule.** サイズは 12/13/14/16/20/28 の6段だけ。`clamp()` や rem 比率を持ち込まない。本文 14px 未満の文字を増やさない（12/13 はラベル・補助にのみ）。

**The One Axis Rule.** `.num` は tabular-nums ＋ 右揃え ＋ nowrap。表の中では金額列すべてが右端の1本の軸に揃う。統計ブロック（`.stat`）の中では `.num` は左揃えに戻し、ラベルと同じ左端に並べる。右端の軸は表の中だけの規律。

**The Signed Yen Rule.** 金額は `¥` ＋ 3桁区切り。負の値は全角マイナス「−」を前置し（`−¥2,268`）、控除項目（手数料）は表の中でも「−」付きで薄く出す。単位「点」「件」「×2」は 12px の `text-faint` で数字の後ろに添える。

## Layout

固定シェル＋スクロールする本文。左サイドナビ 220px（`--nav-w`、右に 1px 罫、白面）、上部バー 48px（`--topbar-h`、下に 1px 罫、白面）、残りが `canvas` 色の本文でここだけが縦スクロールする。ワードマーク「そろばん」はナビ先頭（16px/600、字間 .04em）、上部バーは右寄せで「最終取り込み」の状態テキスト → secondary「メルカリにログイン」→ primary「取り込む」の順。

本文は `.page`（max-width 1100px、padding 24px 28px）。先頭に `.page-head`（タイトル 20px と右端の主アクション、gap 12px、下余白 16px）、次に `.toolbar`（13px、text-dim、下余白 12px）、次に白面（`.panel`）。パネル同士は 16px 空ける。パネル内の統計は `grid-auto-flow: column` の等幅列で gap 24px。同じ白面の続きとして別セクションを置くときは `line-soft` の 1px で区切り、上下 16px ずつ取る（ホームの「今月の転売」→「在庫」）。カード内カードは作らない。

スペーシングは 2/4/8/12/16/24 が基本、加えてページ左右 28px と空状態の上下 48px。表はパネルの padding を 0 にして（`.table-panel`）罫が面の端まで届くようにし、ヘッダーは `position: sticky`。

登録フォームはページ上部に展開するインラインパネル（`.panel.form`、フィールドは `flex-wrap` gap 16px、行間 14px）。紐付けは右ドロワー（560px、`max-width: 92vw`、背後の表がスクリム越しに見える）。モーダルは使わない。

**ブレークポイントは 1099px 以下の1つだけ。** ナビは 56px のアイコン帯に畳まれ、ワードマークとラベルが消え、要対応バッジはアイコンの右上に重なる。売上表は日付列 56px／金額列 88px／発送列 176px に詰め、商品名とチップが2段に戻る。それより狭い幅は想定しない。

## Elevation & Depth

基本は**罫による層分け**で、影は「浮いた層」の存在にだけ使う。地（canvas）の上に白面（surface）が乗り、白面はごく薄い `shadow-1` で紙1枚ぶんだけ地から離れる。表の行、ナビ、上部バー、パネル同士の境界はすべて 1px の罫（`line` / `line-soft`）で示し、影で区切らない。hover や選択は影ではなく面色の変化（surface-hi / accent-soft）で表す。

### Shadow Vocabulary
- **紙1枚（`box-shadow: 0 1px 2px rgba(31,41,51,.06)`）**：`.panel` / `.card` の静止状態。ほぼ見えないが、白面が canvas に溶けるのを防ぐ。
- **浮いた層（`box-shadow: 0 8px 24px rgba(31,41,51,.14), 0 2px 6px rgba(31,41,51,.08)`）**：ドロワーだけ。将来ポップオーバーを作るならこれを使う。
- **スクリム（`rgba(31,41,51,.32)`）**：ドロワーの背後。インク色の透過で、背後の表を読める程度に残す。

### Named Rules
**The One Lift Rule.** 影の段は2つだけで、`shadow-2` を使ってよいのは画面の上に一時的に浮く層（ドロワー・ポップオーバー）に限る。ボタン、カード、hover に影を足さない。オフセットの硬い影（neobrutalist 型）はこの世界にない。

## Shapes

角丸は 3段だけ：**6px**（`--radius`、パネル・カード）、**4px**（`--radius-sm`、ボタン・入力・ナビ項目・候補行・スケルトン）、**999px**（チップ・バッジ・スクロールバーのつまみ）。枠線はすべて 1px。ドロワーは角丸なしで画面右端に密着する。

アイコンは authored SVG（`Icon.vue`、20px viewBox、`stroke="currentColor"`、`stroke-width="1.5"`、round cap/join、`fill="none"`）で1系統。ナビは 18px、ボタン内は 16px、状態テキストや行内は 14px で描く。語彙は 20 種（home／sales／purchase／inventory／monthly／settings／plus／close／trash／link／unlink／check／alert／search／arrow-right／refresh／login／external／folder／download）。絵文字・Unicode 記号・アイコンフォントは使わない。

ロゴ・アプリアイコンは未作成（2026-09-19 時点）。ワードマークはテキストのみ。

## Components

部品の性格は「控えめで正確」。高さ 32px の1列にボタンと入力が並び、状態は面色と枠色の変化だけで示す。

### Buttons
- **Shape:** 小さな角丸（4px）、1px 枠、高さ 32px、padding 6px 12px。アイコンを含むときは `inline-flex` gap 6px。
- **Secondary（既定 `button`）:** 白面に `line` の枠、インク色の文字。hover で `surface-hi`。上部バーの「メルカリにログイン」がこれ。
- **Primary（`.primary`）:** `accent` の面と枠、白文字。hover で `accent-hover`。1画面に1〜2個（「取り込む」「販売を登録」「紐付ける」「登録」）。
- **Ghost（`.ghost`）:** 面も枠も透明、`text-dim` の文字。hover で `surface-hi`。トーストの「閉じる」、ドロワーの×。
- **Danger（`.danger`）:** 文字だけ `loss`。面は白のまま。
- **Small（`.sm`）:** 13px、padding 3px 8px、高さ auto。行内の「紐付け」（琥珀の面・枠・文字の `link-btn` 変種）。
- **Icon（`.icon`）:** 28×28px、padding 0。行末の削除（trash）、ドロワーの閉じる。行末アイコンは `text-faint` で待機し、行 hover で `text-dim` に上がる。
- **Disabled:** opacity .45。**Focus:** `accent` の 2px アウトライン、offset 2px。**Transition:** background / border-color / color を 180ms。

### Chips（`StatusChip`、props `tone` / `label`）
- **Style:** 12px、padding 1px 8px、pill。文字と地の2色で枠なし。
- **Tones:** `neutral`（surface-hi / text-dim：「転売」）、`info`（accent-soft / accent：「私物」）、`warn`（warn-bg / warn：「0件（要確認）」「ログインが必要」「失敗」）、`ok`（profit-bg / profit：「正常」）。
- **Legacy:** `style.css` の `.badge` / `.badge.warn|ok|personal` も同じ見た目。新規は `StatusChip` を使う。
- **Nav badge:** 18px 高の pill、warn-bg / warn、600、tabular-nums。ナビ「売上」の未処理件数だけに使う。

### Cards / Containers（`.panel` / `.card`）
- **Corner Style:** 6px。
- **Background:** surface（白）。
- **Shadow Strategy:** `shadow-1`（紙1枚）。
- **Border:** 1px `line`。
- **Internal Padding:** 16px 20px。表を入れる `.table-panel` は padding 0 ＋ `overflow: hidden`。小見出しは `.panel-title`（13px/600、text-dim、字間 .02em、下余白 12px）。

### Inputs / Fields
- **Style:** 白面、1px `line`、4px 角丸、高さ 32px、padding 6px 10px。`type=number` は右揃え＋tabular-nums。ラベルは `label.field`（縦積み、gap 4px、12px、text-dim）。
- **Focus:** 枠が `accent` に変わる（180ms）＋ `:focus-visible` アウトライン（offset −1px で枠に重ねる）。
- **Invalid（`.invalid`）:** 枠 `warn-line`、地 `warn-bg`。送料未入力のセレクトがこれ。赤ではなく琥珀（「要対応」の意味）。
- **Checkbox / Radio:** 14×14px、padding 0、margin 0、`accent-color: accent`、`flex-shrink: 0`。高さ 32px の入力既定を継がない。
- **表内の編集セル（設定）:** 枠と地を透明にし、hover / focus で枠 `line`・地 `surface` に戻す。
- **検索欄（ドロワー）:** `search-field` は枠を外側の flex 箱に持たせ、内側の input は枠なし。左に search アイコン（text-faint）。

### Tables
- **Header:** 12px/500、text-dim、padding 8px 12px、下罫 `line`、白面、sticky。左揃え。金額列は `th.num` で右揃え。
- **Cell:** padding 10px 12px（`.table-panel` では 8px 12px、`.compact` では 6px 12px）、下罫 `line-soft`。
- **Row states:** hover で `surface-hi`、選択で `accent-soft`。
- **Actions column（`td.actions`）:** 右揃え、`text-faint`、行 hover で `text-dim`。
- **Column widths:** `table-layout: fixed` で列幅を px 指定（売上：日付 72／金額 100／発送 220／梱包 80／操作 40）。
- **Empty / Loading:** 0件は `EmptyState`（title 14px text-dim ＋ hint 13px text-faint、上下 48px、中央揃え、任意の action スロット）。読み込み中は `Skeleton`（`kind="table"` は 5列の 14px バー、`kind="stats"` は 90×20px のバー、`surface-hi`、1.2s の opacity パルス）。

### Navigation
- **Style:** 白面のサイドナビ（220px、右罫、padding 12px 12px 16px）。項目は高さ 36px、4px 角丸、gap 10px、14px、text-dim、アイコン 18px。項目間 2px。
- **States:** hover `surface-hi`；active `accent-soft` ＋ `accent` の文字、`aria-current="page"`。
- **Narrow（≤1099px）:** 56px のアイコン帯。ラベル非表示、バッジはアイコン右上に重ねる。
- **Top bar:** 48px、白面、下罫、padding 0 20px、gap 12px。左は空、右に状態テキスト（13px、text-dim、警告時は `warn` ＋ alert アイコン）と2つのボタン。

### Toast
- 上部バー直下に `position: sticky` で出る帯。13px、padding 8px 16px、下罫 `line`。`ok` は profit-bg / profit（5秒で自動消滅）、`warn` は warn-bg / warn（手動で閉じる）。右端に ghost の「閉じる」。

### Drawer（`Drawer`、props `open` / `title` / `width=560`、slots default / `header-sub` / `footer`）
署名コンポーネント。`Teleport to="body"`、スクリム `rgba(31,41,51,.32)`、右端に密着した白面（`shadow-2`、角丸なし）。ヘッダー（padding 16px 20px、下罫、タイトル 16px/600、任意のサブ行、右に ghost icon の×）、スクロールする本文（padding 16px 20px）、フッター（padding 14px 20px、上罫）。開くと本文の最初のフォーカス可能要素へ、閉じると元の要素へフォーカスを返す。Esc と スクリムのクリックで閉じる。

**Motion:** 開閉とも 180ms（`--dur`）、`cubic-bezier(.2,.8,.2,1)`（`--ease`）。スクリムは opacity、パネルは `translateX(100%)` → 0。`prefers-reduced-motion` で即時。

**紐付けの中身:** 検索欄 → 紐付け済みブロック（下罫 `line-soft`） → 候補リスト（`.item`：gap 10px、padding 6px 8px、4px 角丸、hover `surface-hi`、選択 `accent-soft`、チェックボックス 14px、右に経過日数と原価の `.num`）。フッターは左に「N点 原価 ¥x 粗利 ±¥y」の計算行（13px、粗利は profit / loss）、右に primary「紐付ける」。

### Signature interaction：粗利の確定
売上表の「粗利」セルは `Transition name="settle" mode="out-in"`。「未確定」（text-faint）は 80ms で消え、色付きの数字が opacity 0 → 1 と `translateY(4px)` → 0 で 180ms かけて座る。発送方法の選択・紐付けの確定のどちらでも同じ動きが起きる。これとドロワー以外は動かない。ページロード演出、hover の transform、リストのスタガーはない。

## Do's and Don'ts

### Do:
- **Do** 色は `style.css` の `:root` にだけ定義し、コンポーネントは `var(--name)` で参照する。トークン名は意味（canvas / surface / text-dim / warn）で付け、後から `prefers-color-scheme` 層を足せる形を保つ。
- **Do** 金額は integer 円のまま `¥` ＋ 3桁区切りで表示し、`.num`（tabular-nums、右揃え、nowrap）を表のセルと `th` に付ける。負は全角「−」。
- **Do** 統計ブロックでは `.stat .num { text-align: left }` を守り、右端の軸は表の中だけにする。
- **Do** 文字サイズは 12/13/14/16/20/28 の6段から選ぶ。本文と操作部品は 14px。
- **Do** ボタンと入力は高さ 32px、4px 角丸、1px 枠で1列に揃える。チェックボックスは 14px、`accent-color` を青にする。
- **Do** 状態は hover（surface-hi）／focus-visible（青 2px）／disabled（opacity .45）／loading（Skeleton）／empty（EmptyState の教えるコピー）／error（トースト warn）の6語彙で表す。
- **Do** アイコンは `Icon.vue` の 20 種から選び、必要なら同じ規格（20px グリッド、1.5px、round）で追加する。
- **Do** 動きは `--dur` 180ms ＋ `--ease` の ease-out、transform と opacity だけ。`prefers-reduced-motion` で即時にする。
- **Do** 要対応・未入力・0件は琥珀で目立たせ、「正常に見える異常」を作らない。

### Don't:
- **Don't** 外部フォント・CDN・アイコンライブラリを読み込まない（CSP `default-src 'self'`）。書体はシステム日本語1族、SVG はインライン。
- **Don't** ブランド青を主ボタン・選択・フォーカス・アクティブナビ以外に使わない。見出しやリンクを青くしない。
- **Don't** 緑／赤／琥珀を面全体や装飾に塗らない。数字・チップ・トースト・invalid 入力の枠に限る。
- **Don't** ボタンやカードや hover に影を付けない。`shadow-2` はドロワー・ポップオーバーだけ。
- **Don't** カード内カード、hero-metric テンプレート、同サイズのアイコン＋見出し＋本文カードの並びを作らない。
- **Don't** モーダルで解決しない。編集はインライン展開か右ドロワー。
- **Don't** 絵文字・Unicode 記号・アイコンフォントをアイコンに使わない。
- **Don't** 14px 未満の本文を増やさない。12/13px はラベル・補助・チップに限る。
- **Don't** 1099px 以外にブレークポイントを足さない。外部モニタや縦長画面のための調整は行わない。
- **Don't** レンダラーで利益を再計算しない（紐付けプレビューだけ例外）。表示の色分けは DB のビューが返した値の符号で決める。
- **Don't** ダークモードを部分的に実装しない。今回スコープ外。足すときは `:root` の意味トークンに `prefers-color-scheme` 層を重ねる。
