// ============================================================
// ヘルプのスクリーンショット
//
// 画像は `scripts/make-help-shots.mjs` が **mock（架空データ）** から撮って
// `help/shots/*.png` に書く。**本番のDBからは撮らない**（購入者名や実際の金額を
// アプリの中に焼き込んで配布してしまうため）。
//
// 画面を直したらヘルプの画像は嘘になる。そのときは撮り直すこと：
//   node scripts/make-help-shots.mjs
//
// ここは import.meta.glob でフォルダを丸ごと拾うので、**画像を足すだけで使える**
// （この一覧を手で増やす必要はない）。CSP は default-src 'self' なので、
// Vite が bundle した資産としてしか出せない＝外部URLは書けない
// ============================================================

const modules = import.meta.glob('./shots/*.png', { eager: true, import: 'default' }) as Record<
  string,
  string
>

/** ファイル名（拡張子なし）→ bundle 後のURL。例 SHOTS['dashboard-todo'] */
export const SHOTS: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [
    path.replace(/^\.\/shots\//, '').replace(/\.png$/, ''),
    url,
  ]),
)

/** 画像が1枚もないとき（撮る前）に画面を壊さないための目印 */
export const HAS_SHOTS = Object.keys(SHOTS).length > 0

/**
 * ヘルプの1枚。
 * - `id` … `help/shots/<id>.png` のファイル名。無い id を書いたら
 *   `node scripts/make-help-shots.mjs` が名指しで教えてくれる
 * - `caption` … 画像の下に出す一言。**画像が出ない環境でもこれだけで意味が通る**ように書く
 *   （alt にも使う。「スクリーンショット」のような中身のない言葉にしない）
 * - `step` … 対応する手順の番号（1 始まり）。あると「手順 2」と結び付けて見せられる
 */
export type HelpShot = {
  id: string
  caption: string
  step?: number
}

/** その id の画像があるか（無い分は画面に出さず、枠だけ残さない） */
export function hasShot(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SHOTS, id)
}

// ------------------------------------------------------------
// 説明の図（SVG）
//
// スクショは「どこを押すか」を見せる。図は「**なぜそうなるか**」を見せる
// （粗利の式、仕入→在庫→販売の流れ、まとめ売り、按分、実績と見込みの違い…）。
//
// **ラスタ画像ではなく SVG** にする理由：
//   1. CSP が default-src 'self' なので外部画像は出せない
//   2. SVG なら `var(--…)` でアプリの配色トークンを使える＝**ダークモードで崩れない**
//   3. 文字が潰れない。ファイルも軽い
//
// `?raw` で文字列として読み込み、DOM に**インラインで**差し込む（<img> だと
// 中の var(--…) がアプリのテーマを受け取れない）。差し込むのはビルド時の
// 自前ファイルだけで、利用者の入力は一切通らない
// ------------------------------------------------------------

const diagramModules = import.meta.glob('./diagrams/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/** ファイル名（拡張子なし）→ SVG の中身そのまま。例 DIAGRAMS['gross-profit'] */
export const DIAGRAMS: Record<string, string> = Object.fromEntries(
  Object.entries(diagramModules).map(([path, svg]) => [
    path.replace(/^\.\/diagrams\//, '').replace(/\.svg$/, ''),
    svg,
  ]),
)

export function hasDiagram(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIAGRAMS, id)
}

/**
 * ヘルプに出す図。`kind` で絵の種類を分ける。
 * - `shot` … 画面のスクショ（`help/shots/<id>.png`）。「どこを押すか」
 * - `diagram` … 説明の図（`help/diagrams/<id>.svg`）。「なぜそうなるか」
 */
export type HelpFigure = {
  kind: 'shot' | 'diagram'
  id: string
  caption: string
  step?: number
}
