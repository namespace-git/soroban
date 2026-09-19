---
name: そろばん（Soroban）
description: メルカリ転売の利益を家族が10秒で確定させる、「Milestone」風の温かい帳簿
colors:
  canvas: "#f6f6f3"
  surface: "#ffffff"
  surface-hi: "#f3f2ee"
  surface-nav: "#ffffff"
  line: "#e6e4dd"
  line-soft: "#efede8"
  text: "#26262a"
  text-dim: "#63636a"
  text-faint: "#97979e"
  brand: "#f5c842"
  brand-hover: "#ebb92a"
  brand-soft: "#fff6dd"
  brand-ink: "#7a5a00"
  primary: "#2b2b30"
  primary-hover: "#17171a"
  profit: "#2f9e5a"
  profit-bg: "#e6f6ec"
  profit-solid: "#4cba6f"
  loss: "#d9463f"
  loss-bg: "#fdeceb"
  loss-solid: "#ef5a52"
  warn: "#b45f06"
  warn-bg: "#fff0e0"
  warn-line: "#f2b26b"
  warn-solid: "#f08a24"
  info: "#2f6fcf"
  info-bg: "#e8f0fc"
  on-solid: "#ffffff"
typography:
  display:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "tnum"
  display-sm:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "tnum"
  headline:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.6
    fontFeature: "tnum"
  title-lg:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.6
  title:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.6
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
    fontWeight: 600
    lineHeight: 1.6
  label-xs:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
  panel-title:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: "0.02em"
rounded:
  lg: "14px"
  md: "10px"
  sm: "8px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
  page-x: "28px"
  empty: "48px"
components:
  button-secondary:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.line-soft}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-solid}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 18px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-hi}"
  button-danger:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.loss}"
    rounded: "{rounded.pill}"
    height: "36px"
  button-sm:
    typography: "{typography.body-sm}"
    padding: "0 10px"
    height: "28px"
  button-icon:
    padding: "0"
    width: "28px"
    height: "28px"
  button-link:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "28px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "36px"
  input-invalid:
    backgroundColor: "{colors.warn-bg}"
  checkbox:
    width: "14px"
    height: "14px"
    padding: "0"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
  stat-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.display-sm}"
    rounded: "{rounded.lg}"
    padding: "20px 22px"
  stat-card-brand:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.text}"
    typography: "{typography.display}"
    rounded: "{rounded.lg}"
    padding: "20px 22px"
  stat-card-cream:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.text}"
    typography: "{typography.display-sm}"
    rounded: "{rounded.lg}"
    padding: "20px 22px"
  section-head-icon:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    width: "28px"
    height: "28px"
  chip-neutral:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-brand:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-ok:
    backgroundColor: "{colors.profit-solid}"
    textColor: "{colors.on-solid}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-warn:
    backgroundColor: "{colors.warn-solid}"
    textColor: "{colors.on-solid}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-loss:
    backgroundColor: "{colors.loss-solid}"
    textColor: "{colors.on-solid}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  pill:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-faint}"
    typography: "{typography.label-xs}"
    rounded: "{rounded.sm}"
    padding: "0 4px"
    height: "64px"
  nav-item-hover:
    backgroundColor: "{colors.surface-hi}"
    textColor: "{colors.text-dim}"
  nav-item-active:
    textColor: "{colors.text}"
  nav-badge:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 5px"
    height: "18px"
  brand-mark:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.text}"
    typography: "{typography.title}"
    rounded: "{rounded.pill}"
    width: "36px"
    height: "36px"
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
    backgroundColor: "{colors.brand-soft}"
  total-row:
    backgroundColor: "{colors.profit-bg}"
    textColor: "{colors.profit}"
  total-row-loss:
    backgroundColor: "{colors.loss-bg}"
    textColor: "{colors.loss}"
  thumb:
    rounded: "{rounded.sm}"
    width: "40px"
    height: "40px"
  thumb-placeholder:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.brand-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    width: "40px"
    height: "40px"
  drawer:
    backgroundColor: "{colors.surface}"
    width: "560px"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    width: "420px"
  toast:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-solid}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.pill}"
    padding: "9px 18px"
---

# Design System: そろばん（Soroban）

## Overview

**Creative North Star: "温かい帳簿"**

そろばんは、業務SaaS標準型の配置（左ナビ＋上部バー＋本文、表とドロワー）を保ったまま、資金管理SaaS「Milestone」の雰囲気に寄せた温かい帳簿である（2026-09-20、ユーザーが参考画像で指名）。地は温かい薄グレー、その上に罫線のない白い角丸カード（14px）が柔らかい影で浮く。ブランド色は黄色で、ナビのロゴ丸・セクション見出しの丸アイコン・ホームの主役カードといった「印」にだけ使い、文字色には使わない。主ボタンはチャコールのピル。チップはピル型のベタ塗り。数字は大きく太く、桁を揃える。

密度は「ノートPC 13〜15インチで読む帳簿」のまま。本文 14px、表のセルは 8〜10px/12px のパディング、余白はカード内 20〜24px と旧世界より広い。色の意味は製品の約束で変わらない：**利益＝緑、損失＝赤、要対応＝橙**。黄色は「ブランド」であって「注意」ではないため、要対応は橙で、黄色と隣り合っても混同されないよう彩度と明度を分けてある。書体は日本語システム系1族を見出しから数字まで通し、外部フォントは CSP（`default-src 'self'`）により読めない。

この世界が拒むもの：旧ブルー基調（`#2b62c7`）、カードの 1px 枠線、hero-metric テンプレートの横一列並び、カード内カード、モーダル頼み（入力ダイアログ1種を除く）、絵文字・Unicode 記号のアイコン。

**Key Characteristics:**
- 温かい薄グレーの地（canvas）＋罫線なしの白い角丸カード（14px、shadow-1）。罫（line / line-soft）は表の行と入力枠にだけ
- ブランド黄は「印」：ロゴ丸、セクション見出しの 28px 丸アイコン、ホームの主役カード、`brand` チップ、チェックボックスの accent-color、入力 focus の枠。文字色には使わない
- 主ボタンはチャコール（primary）のピル。副ボタンは薄グレー（surface-hi）のピル。すべて高さ 36px
- 意味色は 2 層：文字用（profit / loss / warn）とベタ塗り用（`*-solid`、白字）。要対応＝橙、黄色は注意の意味に使わない
- 型スケール 11/12/13/14/16/20/28/36/44px の固定 9 段。数字カードは 36/44px の 700
- 88px の縦積みナビ：アイコン 20px の下に 11px のラベル、中央揃え、高さ 64px。上部バーは地と同色で境界なし
- 一覧行は「40px サムネイル → 商品名／チップ列／メモ行」の 3 段構成
- 動くのは 3 つ：ドロワーのスライド、ダイアログのスケール、粗利セルの「未確定→数字」。いずれも 180ms ease-out、reduced-motion で即時
- アイコンは authored SVG 1系統（20px グリッド、1.5px ストローク、currentColor、21 種）

## Colors

温かい無彩色（黄味を帯びたグレー）が地と罫とインクを担い、彩度を持つ色はブランド黄 1 系統、主ボタンのチャコール、意味色 4 系統（緑／赤／橙／青）だけ。意味色は文字用とベタ塗り用（`*-solid`）の 2 層を持つ。

### Primary
- **ブランド黄（brand）**：ナビのロゴ丸（36px、「そ」）、セクション見出しの丸アイコン（28px）、ホームの主役カード `.stat-card.brand`、`brand` チップ（「転売」）、チェックボックス／ラジオの `accent-color`、入力の `:focus` 枠。**文字色には使わない**（白地で 1.6:1 しかない）。hover は **brand-hover**。
- **クリーム（brand-soft）**：副次の数字カード `.stat-card.cream`、選択行（`tr.selected`、ドロワーでチェックした候補行 `.item.on`、`--accent-soft` 経由）、テキスト選択の地、サムネイルのプレースホルダの地。
- **クリーム上のインク（brand-ink）**：クリーム地の上のラベル・プレースホルダ文字。白地では使わない。
- **チャコール（primary / primary-hover）**：主ボタン（「取り込む」「販売を登録」「紐付ける」「決定」）の面、トーストの地、`:focus-visible` の 2px アウトライン、キャレット。`--accent` / `--accent-hover` はこれの別名（後方互換）。

### Secondary（意味色）
- **利益の緑（profit / profit-bg / profit-solid）**：正の粗利の数字（profit）、合計行の帯（profit-bg 地に profit の太字）、`ok` チップ（profit-solid 地に白字：「正常」「実額」）。
- **損失の赤（loss / loss-bg / loss-solid）**：負の粗利の数字（loss）、`button.danger` の文字、合計行が損失のときの帯（loss-bg / loss）、`loss` チップ（loss-solid、白字。定義済みだが現在の画面では未使用）。
- **要対応の橙（warn / warn-bg / warn-line / warn-solid）**：ホーム「要対応」の件数（warn、28px）、ナビの未処理バッジ（warn-bg / warn）、上部バーの警告状態テキスト、送料未入力のセレクト（`.invalid`：warn-line の枠と warn-bg の地）、行内の「紐付け」ボタン（`.link-btn`：warn-bg / warn-line / warn）、`warn` チップ（warn-solid 地に白字：「価格未入力」「0件（要確認）」「失敗」）、トースト内の警告アイコン（warn-solid）。
- **情報の青（info / info-bg）**：`info` チップだけ（「未着」「配送中」、タグ名）。装飾・ボタン・リンクには使わない。

### Neutral
- **地（canvas）**：画面全体と上部バーの背景。温かい薄グレー。
- **面（surface / surface-nav）**：カード、表、入力、サイドナビ、ドロワー、ダイアログ。すべて純白。
- **サブ面（surface-hi）**：副ボタンの面、hover 行、`neutral` チップと `.pill`、スケルトン、按分の注記ブロック。
- **罫（line）**：入力の枠、ドロワーとダイアログのヘッダー／フッターの区切り、月次の列グループ左罫、タグピッカーの区切り。**カードの枠には使わない。**
- **行罫（line-soft）**：表のヘッダー下と行と行の間、要対応の行、設定の危険区域の上罫。副ボタンの hover 面。
- **インク（text）**：本文、主要な数字、黄色い面の上の文字。
- **補助インク（text-dim）**：表ヘッダー、ラベル、パネル小見出し、副次の数字、ゴーストボタン、ナビの hover。
- **かすれインク（text-faint）**：単位（「件」「点」「×1」）、日付、ヒント、非アクティブなナビ、行末アクションの待機色、バージョン表示。
- **白（on-solid）**：ベタ塗り面（primary、`*-solid`）の上の文字。

### Named Rules
**The Brand-Is-a-Mark Rule.** ブランド黄は「印」（ロゴ丸・見出しの丸アイコン・主役カード・brand チップ・チェックの色・focus 枠）にだけ塗る。文字色にしない。見出しやリンクを黄色くしない。注意・警告の意味を黄色に持たせない。要対応は必ず橙（warn 系）。

**The Two-Layer Semantic Rule.** 意味色は文字用（`profit` / `loss` / `warn`）とベタ塗り用（`*-solid` ＋ 白字）の 2 層。数字と合計行の帯には文字用、ピル型チップには `*-solid`。地色（`*-bg`）は合計行・invalid 入力・ナビバッジ・紐付けボタンの淡い面に限る。面全体や装飾には塗らない。

**The No-Hex-Elsewhere Rule.** 16進の色値は `style.css` の `:root` 以外に書かない。コンポーネントは `var(--name)` で参照し、`var()` の第2引数にも 16進を置かない。例外はスクリム `rgba(38,38,42,.32)`（インク色の透過）とトースト内ボタンの hover `rgba(255,255,255,.16)`。

## Typography

**Display Font:** Hiragino Sans（with Hiragino Kaku Gothic ProN, Yu Gothic UI, Meiryo, system-ui）
**Body Font:** 同上（1族で通す）
**Label/Mono Font:** なし。数字は本文書体に `tabular-nums` を効かせる

**Character:** 日本語システム書体 1 族を見出しから数字まで通す。個性は書体ではなく、数字の大きさ（36/44px の 700）と桁揃えの規律、ラベルの小ささ（11/12px）の落差で出す。CSP により外部フォントは読めないため、Windows では Yu Gothic UI / Meiryo、macOS では Hiragino Sans で描画される。ウェイトは 400/500/600/700 の 4 段。

### Hierarchy
- **Display**（700, 44px, 1.1, tabular-nums）：ホームの主役カード（`.stat-card.brand`）の「今月の粗利」1 か所だけ。
- **Display-sm**（700, 36px, 1.1, tabular-nums）：クリームと白の数字カード（`.stat-card-value`）。単位「件」「点」は 12px/400 を 2px 空けて添える。
- **Headline**（700, 28px, tabular-nums）：ホーム「要対応」の行頭の件数（橙）、`.stat-value.lg`。
- **Title-lg**（700, 20px）：ページタイトル（`.page-title`）、横並び統計の数値（`.stat-value`）。
- **Title**（600, 16px）：セクション見出し（`.section-head` の h2）、ドロワーとダイアログのタイトル。ナビのロゴ丸の「そ」は 16px/700。
- **Body**（400, 14px, 1.6）：本文、表のセル、入力、ボタン、要対応の説明文。一覧の商品名は 14px/500。
- **Body-sm**（400, 13px）：ツールバー、状態テキスト、トースト、`button.sm`、メモ本文、ドロワー下端の計算行、空状態のヒント。
- **Label**（600, 12px）：表ヘッダー、フィールドラベル（400）、数字カードのラベル、チップ、`.pill`、ナビバッジ、ナビのワードマーク「そろばん」、単位、注記。
- **Label-xs**（400, 11px）：縦積みナビのラベルだけ。アクティブは 700。
- **Panel title**（600, 13px, letter-spacing .02em, text-dim）：`.section-head` を使わない面の小見出し（`.panel-title`）。

### Named Rules
**The Nine-Step Ladder Rule.** サイズは 11/12/13/14/16/20/28/36/44 の 9 段だけ（`--fs-*`）。`clamp()` や rem 比率を持ち込まない。11px はナビのラベル専用。本文と操作部品は 14px。

**The One Axis Rule.** `.num` は tabular-nums ＋ 右揃え ＋ nowrap。表の中では金額列すべてが右端の 1 本の軸に揃う。数字カード（`.stat-card-value`）と統計ブロック（`.stat .num`）では左揃えに戻し、ラベルと同じ左端に並べる。

**The Signed Yen Rule.** 金額は `¥` ＋ 3 桁区切り。負の値は全角マイナス「−」を前置し、控除項目（手数料）は表の中でも「−」付きで `dim` に出す。単位「点」「件」「×1」は 12px の `text-faint` で数字の後ろに添える。

## Layout

固定シェル＋スクロールする本文。左サイドナビ 88px（`--nav-w`、白面、右罫なし、`shadow-1` で地から浮く、padding 16px 10px）、上部バー 56px（`--topbar-h`、**地と同色で境界なし**、padding 0 24px）、残りが `canvas` 色の本文でここだけが縦スクロールする。ナビ先頭はロゴ（36px の黄色い丸に「そ」、その下に 12px の「そろばん」）、末尾に `v0.1`。上部バーは右寄せで「最終取り込み」の状態テキスト → primary「取り込む」。

本文は `.page`（padding 24px 28px、幅は画面に追従。設定だけ `.page.narrow` で max-width 1100px）。先頭に `.page-head`（タイトル 20px と右端の主アクション、gap 12px、下余白 16px）、次に `.toolbar`（13px、text-dim、下余白 12px）、次に白いカード（`.panel`、padding 20px 24px）。カード同士は 16px 空ける。

ホームは 2 列グリッド（`300px 1fr`、gap 20px）。左列に数字カードを縦に 3 枚（黄 → クリーム → クリーム、gap 16px）、右列に「要対応」と「型番ランキング」のカード。1099px 以下で 1 列に落ちる。

スペーシングは 2/4/6/8/10/12/14/16/20/24 が基本、加えてページ左右 28px と空状態の上下 48px。表はカードの padding を 0 にして（`.table-panel`）行罫が面の端まで届くようにし、`overflow: hidden` で角丸に収める。ヘッダーは `position: sticky`。カードの中に `.section-head` を置くときは `padding: 16px 20px 0`。

登録フォームはページ上部に展開するインラインカード（`.panel.form`、縦 gap 14px、フィールドは `.fields` の `flex-wrap` gap 16px）。紐付けは右ドロワー（560px、`max-width: 92vw`）。文字入力の問い合わせだけ中央ダイアログ（`InputDialog`、420px）。タグの付け替えは 240px のポップオーバー（`TagPicker`）。

**ブレークポイントは 1099px 以下の 1 つだけ。** ナビは常に 88px なので畳まない。ホームは 1 列、売上表は日付 56／サムネ 48／金額 80／発送 176px に詰め、在庫表は横スクロール。

## Elevation & Depth

**罫線ではなく影で層を分ける。** 地（canvas）の上に白いカードが `shadow-1` で紙 1 枚ぶん浮き、カードに枠線はない。サイドナビも同じ影で本文から浮く。上部バーは地と同色で層を持たない。罫（line / line-soft）は表の行・入力の枠・ドロワー／ダイアログの内部区切りにだけ残す。hover や選択は影ではなく面色の変化（surface-hi / brand-soft）で表す。

### Shadow Vocabulary
- **紙 1 枚（`box-shadow: 0 2px 10px rgba(40,35,20,.06)`、`--shadow-1`）**：`.panel` / `.card` / `.stat-card`（白）／サイドナビ／トーストの静止状態。影の色は温かい茶を帯びる。黄・クリームの数字カードは `box-shadow: none`（面の色だけで区別する）。
- **浮いた層（`box-shadow: 0 12px 32px rgba(40,35,20,.14), 0 2px 8px rgba(40,35,20,.06)`、`--shadow-2`）**：ドロワー、入力ダイアログ、タグピッカーのポップオーバー。
- **スクリム（`rgba(38,38,42,.32)`）**：ドロワーとダイアログの背後。インク色の透過で、背後の表を読める程度に残す。

### Named Rules
**The Borderless Card Rule.** カードは枠線を持たない（`border: none`）。地との区別は白と `shadow-1` だけで行う。表の行罫と入力枠は罫を使うが、カードの外周に罫を足さない。

**The Two Lifts Rule.** 影は 2 段だけ。`shadow-2` を使ってよいのは画面の上に一時的に浮く層（ドロワー・ダイアログ・ポップオーバー）に限る。ボタンや hover に影を足さない。オフセットの硬い影はこの世界にない。

## Shapes

角丸は 4 段：**14px**（`--radius`、カード・数字カード・ダイアログ）、**10px**（`--radius-md`、入力・セレクト・テキストエリア）、**8px**（`--radius-sm`、サムネイル・ナビ項目・候補行・スケルトン・注記ブロック・ドロワー内の検索欄）、**999px**（ボタン・チップ・ピル・バッジ・ロゴ丸・見出しの丸アイコン・スクロールバーのつまみ）。**ボタンはすべてピル**。ドロワーは角丸なしで画面右端に密着する。

丸が繰り返しモチーフ：36px のロゴ丸、28px の見出し丸アイコン、ピル型のボタン・チップ・「開く ›」。四角いのは白いカードとサムネイル、入力だけ。

アイコンは authored SVG（`Icon.vue`、20px viewBox、`stroke="currentColor"`、`stroke-width="1.5"`、round cap/join、`fill="none"`）で 1 系統、21 種（home／sales／purchase／inventory／monthly／settings／plus／close／trash／link／unlink／check／alert／search／arrow-right／refresh／login／external／folder／download／note）。ナビ 20px、見出し丸の中 16px、ボタン内 16px、状態テキストとメモ行 14px、「開く ›」の矢印 12px。絵文字・Unicode 記号・アイコンフォントは使わない。

ロゴ・アプリアイコンは未作成。ナビの「そ」の黄色い丸が暫定のマーク。

## Components

部品の性格は「丸くて温かく、数字は正確」。ボタンはピル、入力は 10px 角丸、チップはベタ塗りのピル。高さ 36px の 1 列にボタンと入力が並ぶ。

### Buttons
- **Shape:** ピル（999px）、高さ 36px、枠は 1px 透明。アイコンを含むときは `inline-flex` gap 6px、アイコン 16px。
- **Secondary（既定 `button`）:** `surface-hi` の面、インク色の文字、padding 0 16px。hover で `line-soft`。上部バーには現在 secondary はない（ツールバーの「型番で自動紐付け」など）。
- **Primary（`.primary`）:** `primary` の面、白文字、padding 0 18px。hover で `primary-hover`。1 画面に 1〜2 個（「取り込む」「販売を登録」「紐付ける」「決定」）。
- **Ghost（`.ghost`）:** 面も枠も透明、`text-dim` の文字。hover で `surface-hi`。トーストの「閉じる」、ドロワーの×、ダイアログの「キャンセル」。
- **Danger（`.danger`）:** 文字だけ `loss`。面は既定のまま。
- **Small（`.sm`）:** 13px、padding 0 10px、高さ 28px。
- **Link（`.link-btn`、`.sm` と併用）:** 行内の「紐付け」。warn-bg の面、warn-line の枠、warn の文字、link アイコン付き。要対応の橙をボタンに載せる唯一の場所。
- **Icon（`.icon`）:** 28×28px、padding 0。行末の削除（trash）、ドロワーの閉じる。行末の `.fade-btn` は opacity .35 で待機し、行 hover で 1 に上がる。
- **Text（`.cost-btn` / `.kind-toggle`）:** 面も枠も透明、padding 0、高さ auto。原価セルの数字（hover で下線）と、転売／私物チップの切り替え。
- **Disabled:** opacity .45。**Focus:** `primary`（チャコール）の 2px アウトライン、offset 2px。**Transition:** background / border-color / color を 180ms。

### Chips（`StatusChip`、props `tone` / `label`）
- **Style:** 12px/600、padding 2px 10px、pill、枠なし。文字と地の 2 色。
- **Tones:**
  - `brand`（brand / text）：「転売」。主役の印。
  - `neutral`（surface-hi / text-dim）：「私物」「自動取得」「自動紐付け」「分割」「未発送」「無効」、型番。
  - `info`（info-bg / info）：「未着」「配送中」、タグ名。
  - `ok`（profit-solid / 白）：「正常」「実額」。
  - `warn`（warn-solid / 白）：「価格未入力」「0件（要確認）」「ログインが必要」「失敗」。
  - `loss`（loss-solid / 白）：定義済み、現在未使用。
- **Pill（`.pill`）:** チップと同形の中立ピル（surface-hi / text-dim、12px/600）。ホーム要対応行の「開く ›」、件数の注記。
- **Legacy:** `style.css` の `.badge` / `.badge.warn|ok|personal` は旧世界の淡い地のチップ。新規は `StatusChip` を使う。
- **Nav badge:** 18px 高の pill、warn-bg / warn、600、tabular-nums。ナビ「売上」アイコンの右上（top 4px、right 12px）に重ねる。

### Cards / Containers（`.panel` / `.card`）
- **Corner Style:** 14px。
- **Background:** surface（白）。
- **Shadow Strategy:** `shadow-1`（紙 1 枚）。
- **Border:** なし。
- **Internal Padding:** 20px 24px。表を入れる `.table-panel` は padding 0 ＋ `overflow: hidden`。小見出しは `.section-head`（下記）か `.panel-title`。設定の `.panel-foot` は padding 12px 20px 16px。

### Stat Cards（`.stat-card` / `.brand` / `.cream`）
ホーム左列の数字カード。縦積み（gap 4〜6px、padding 20px 22px、14px 角丸）：ラベル 12px → 数字 36px/700 → 補足 12px。
- **白（既定）:** surface、shadow-1。
- **Brand（`.brand`）:** brand の面、影なし、文字はすべて text。数字だけ 44px。補足は opacity .75。「今月の粗利」1 枚だけ。
- **Cream（`.cream`）:** brand-soft の面、影なし、ラベルは brand-ink、数字は text。「要対応」「在庫」。補足の `.warn` は橙（長期滞留）。

### Section Head（`.section-head`）
カード内の小見出し。左に 28px の黄色い丸（brand 地、16px のアイコン、text 色）＋ 16px/600 のタイトル（gap 8〜10px、下余白 12〜14px）。右端に任意のアクション（セレクトや `.pill`）。「要対応」は alert、「型番ランキング」は sales のアイコン。

### Inputs / Fields
- **Style:** 白面、1px `line`、10px 角丸、高さ 36px、padding 6px 12px。`type=number` は右揃え＋tabular-nums。ラベルは `label.field`（縦積み、gap 4px、12px、text-dim）。
- **Focus:** 枠が `brand`（黄）に変わる（180ms）＋ `:focus-visible` のチャコール 2px アウトライン（offset −1px で枠に重ねる）。
- **Invalid（`.invalid`）:** 枠 `warn-line`、地 `warn-bg`。送料未入力のセレクトがこれ。橙であって黄ではない。
- **Checkbox / Radio:** 14×14px、padding 0、margin 0、`accent-color: brand`。高さ 36px の入力既定を継がない。
- **表内の編集セル（設定）:** 枠と地を透明にし、hover / focus で枠 `line`・地 `surface` に戻す。
- **検索欄（ドロワー）:** `.search-field` は枠を外側の flex 箱に持たせ（8px 角丸）、内側の input は枠なし。左に search アイコン（text-faint）。

### Tables
- **Header:** 12px/600、text-dim、padding 8px 12px、下罫 `line-soft`、白面、sticky、左揃え。金額列は `th.num` で右揃え。
- **Cell:** padding 10px 12px（`.table-panel` の売上は 8px 12px、`.compact` は 6px 12px）、下罫 `line-soft`。
- **Row states:** hover で `surface-hi`、選択で `brand-soft`。
- **Total row（`.total-row`）:** profit-bg の帯に profit の 700。損失なら `.loss` で loss-bg / loss。月次の合計行。
- **Actions column（`td.actions`）:** 右揃え、`text-faint`、行 hover で `text-dim`。
- **Column widths:** `table-layout: fixed` で列幅を px 指定（売上：日付 72／サムネ 64／金額 84／発送 200／梱包 76／操作 112）。
- **Empty / Loading:** 0 件は `EmptyState`（title 14px text-dim ＋ hint 13px text-faint、上下 48px、中央揃え、任意の action スロット）。読み込み中は `Skeleton`（`kind="table"` は 5 列の 14px バー、`kind="stats"` は 90×20px のバー、`surface-hi`、8px 角丸、1.2s の opacity パルス）。

### List Row（一覧の商品セル、売上・在庫・仕入で共通）
行頭に 40px のサムネイル、続く商品セルは意味のまとまりで 3 段に分ける。
- **Thumb（`.thumb` / `.thumb-placeholder`）:** 40×40px、8px 角丸、`object-fit: cover`。画像がないか読めないときはプレースホルダ（brand-soft の地に brand-ink の 14px/700、先頭 1 文字）。
- **1 段目 商品名（`.title-name` / `.item-name` / `.product-name`）:** 14px/500、折り返す（`word-break: break-word`）。
- **2 段目 チップ列（`.chip-row`）:** `flex-wrap`、gap 6px、上余白 4px。先頭は転売／私物（`brand` / `neutral`、押すと確認付きで切り替え）、次に「自動取得」、型番、タグ（`info`）。
- **3 段目 メモ行（`.note-row`）:** note アイコン 14px（text-faint）＋「メモ」ラベル 12px（text-faint）＋ 本文 13px（text-dim、折り返す）。メモがあるときだけ出す。商品名の続きにメモが見えないための段。

### Navigation
- **Style:** 白の縦帯（88px、`shadow-1`、padding 16px 10px）。先頭にロゴ（36px の黄色い丸「そ」16px/700 ＋ 12px/600 の「そろばん」、字間 .02em）。項目は縦積み（アイコン 20px、その下にラベル 11px、gap 4px）、中央揃え、高さ 64px、8px 角丸、項目間 2px。
- **States:** 既定 `text-faint`；hover `surface-hi` ＋ `text-dim`；active `text` の 700（面の色は変えない）、`aria-current="page"`。
- **Badge:** 「売上」だけ、アイコン右上に warn-bg / warn の件数。
- **Top bar:** 56px、地と同色、境界なし、padding 0 24px、gap 12px。左は空、右に状態テキスト（13px、text-dim、警告時は `warn` ＋ alert アイコン 14px）と primary「取り込む」（refresh アイコン）。

### Toast
上部バー直下に `position: sticky`、右寄せ（`margin-left: auto`）で出るチャコールのピル。13px、白字、padding 9px 18px、`shadow-1`。`ok` は 5 秒で自動消滅、`warn` は先頭に warn-solid の alert アイコンが付き、手動で閉じる。右端に ghost の「閉じる」（hover は白 16% の面）。

### Drawer（`Drawer`、props `open` / `title` / `width=560`、slots default / `header-sub` / `footer`）
署名コンポーネント。`Teleport to="body"`、スクリム、右端に密着した白面（`shadow-2`、角丸なし）。ヘッダー（padding 16px 20px、下罫 `line`、タイトル 16px/600、任意のサブ行、右に ghost icon の×）、スクロールする本文（padding 16px 20px）、フッター（padding 14px 20px、上罫 `line`）。開くと本文の最初のフォーカス可能要素へ、閉じると元の要素へフォーカスを返す。Esc とスクリムのクリックで閉じる。

**Motion:** 開閉とも 180ms（`--dur`）、`cubic-bezier(.2,.8,.2,1)`（`--ease`）。スクリムは opacity、パネルは `translateX(100%)` → 0。`prefers-reduced-motion` で即時。

**紐付けの中身:** 検索欄 → 紐付け済みブロック（下罫 `line-soft`） → 候補リスト（`.item`：gap 10px、padding 6px 8px、8px 角丸、hover `surface-hi`、選択 `brand-soft`、チェックボックス 14px、右に経過日数と原価の `.num`）。フッターは左に「N点 原価 ¥x 粗利 ±¥y」の計算行（13px、粗利は profit / loss）、右に primary「紐付ける」。

### Dialog（`InputDialog`）
`window.prompt()` の代わり。中央に 420px（`max-width: 92vw`、`max-height: 84vh`）の白面、14px 角丸、`shadow-2`、枠なし。ヘッダー（padding 20px 20px 0、タイトル 16px/600）、本文（padding 16px 20px、`label.field` に input か textarea）、フッター（右寄せ、gap 8px、上罫 `line`、ghost「キャンセル」＋ primary「決定」）。開閉 180ms：スクリムは opacity、パネルは `scale(.98)` → 1。IME 変換中の Enter / Esc には反応しない。

### Popover（`TagPicker`）
アンカーの直下 4px に出る 240px の `.panel`（padding 6px、`shadow-2`、position fixed）。チェックボックス付きの項目（高さ 32px、8px 角丸、hover `surface-hi`）を縦に並べ、下に `line` で区切って「新しいタグ」の入力。外側クリックと Esc で閉じる。

### Signature interaction：粗利の確定
売上表の「粗利」セルは `Transition name="settle" mode="out-in"`。「未確定」（text-faint）は 80ms で消え、色付きの数字が opacity 0 → 1 と `translateY(4px)` → 0 で 180ms かけて座る。発送方法の選択・紐付けの確定のどちらでも同じ動きが起きる。これとドロワー・ダイアログの開閉以外は動かない。ページロード演出、hover の transform、リストのスタガーはない。

## Do's and Don'ts

### Do:
- **Do** 色は `style.css` の `:root` にだけ定義し、コンポーネントは `var(--name)` で参照する。`var()` のフォールバック値にも 16進を書かない。トークン名は意味（canvas / surface / brand / warn）で付け、後から `prefers-color-scheme` 層を足せる形を保つ。
- **Do** 利益＝緑、損失＝赤、要対応＝橙を守る。黄色は「ブランド」であって「注意」ではない。要対応・未入力・0 件は橙で目立たせ、「正常に見える異常」を作らない。
- **Do** 金額は integer 円のまま `¥` ＋ 3 桁区切りで表示し、`.num`（tabular-nums、右揃え、nowrap）を表のセルと `th` に付ける。負は全角「−」。数字カードと統計ブロックでは左揃えに戻す。
- **Do** 文字サイズは 11/12/13/14/16/20/28/36/44 の 9 段（`--fs-*`）から選ぶ。本文と操作部品は 14px。数字カードは 36/44px の 700。
- **Do** ボタンはピル（999px）で高さ 36px、入力は 10px 角丸で高さ 36px、カードは 14px 角丸で枠なし＋`shadow-1`。
- **Do** チップは `StatusChip` の 6 トーンから選び、意味色はベタ塗り（`*-solid` ＋ 白字）、中立と情報は淡い地にする。
- **Do** 一覧の商品セルは「40px サムネ → 商品名／チップ列／メモ行」の 3 段で組む。幅の節約より読みやすさを優先する。
- **Do** セクション見出しは `.section-head`（黄色い 28px の丸アイコン ＋ 16px/600）で揃える。
- **Do** 状態は hover（surface-hi）／focus-visible（チャコール 2px）／disabled（opacity .45）／loading（Skeleton）／empty（EmptyState の教えるコピー）／error（warn トースト）の 6 語彙で表す。
- **Do** アイコンは `Icon.vue` の 21 種から選び、必要なら同じ規格（20px グリッド、1.5px、round）で追加する。
- **Do** 動きは `--dur` 180ms ＋ `--ease` の ease-out、transform と opacity だけ。`prefers-reduced-motion` で即時にする。

### Don't:
- **Don't** 外部フォント・CDN・アイコンライブラリを読み込まない（CSP `default-src 'self'`）。書体はシステム日本語 1 族、SVG はインライン。
- **Don't** ブランド黄を文字色に使わない。見出し・リンク・注意表示を黄色くしない。黄色い面の上の文字は `text`、クリーム地の上は `brand-ink`。
- **Don't** 旧ブルー（`#2b62c7`）を持ち込まない。青は `info` チップにだけ残る。
- **Don't** 緑／赤／橙を面全体や装飾に塗らない。数字・チップ・合計行の帯・invalid 入力・紐付けボタン・トーストに限る。
- **Don't** カードに枠線を引かない。ボタンや hover に影を付けない。`shadow-2` はドロワー・ダイアログ・ポップオーバーだけ。
- **Don't** カード内カード、hero-metric の横一列並びを作らない。ホームの数字カードは左列に縦積み。
- **Don't** 編集をモーダルで解決しない。インライン展開か右ドロワー。中央ダイアログは文字入力の問い合わせ（`InputDialog`）だけ。
- **Don't** 絵文字・Unicode 記号・アイコンフォントをアイコンに使わない。
- **Don't** 14px 未満の本文を増やさない。11px はナビのラベル、12/13px はラベル・補助・チップに限る。
- **Don't** 1099px 以外にブレークポイントを足さない。ナビは 88px 固定で畳まない。
- **Don't** レンダラーで利益を再計算しない（紐付けプレビューだけ例外）。表示の色分けは DB のビューが返した値の符号で決める。
- **Don't** ダークモードを部分的に実装しない。今回スコープ外。足すときは `:root` の意味トークンに `prefers-color-scheme` 層を重ねる。
