import type { Ctx } from '../context'
import { UserError } from '../errors'
import { assertQty as assertQtyRaw, assertYen as assertYenRaw } from '../../src/main/money'
import type { SalesChannel, SearchHit, Tag } from '../../src/shared/types'

// ============================================================
// ドメイン共通の道具（src/main/db.ts の小さな部品の移植）
//
// 第 1 引数は ctx（SQL を投げるもの）。日付は **Workers が UTC** なので、すべて日本時間（+9 時間）で数える。
// `new Date().getDate()` や `src/shared/date.ts` の `todayLocal()` は使わない（サーバーの時計に依る）。
// ============================================================

// 純粋な計算は写さずに、デスクトップ版と同じものを使う（electron に依存しない）。
// money.ts の assertYen / assertQty は素の Error を投げる（API では 500 に丸められる）ので、
// 下で UserError に包んだ版を出す。allocate も按分できないとき素の Error を投げるので、呼ぶ側で扱うこと
export { allocate, splitEvenly, calcFee } from '../../src/main/money'
export type { LineForAlloc } from '../../src/main/money'
export {
  extractCode, extractCodes, extractCodeQuantities, extractItemCodes, extractMaterial, extractQuantity,
  displayName, CODE_RE, CODE_LOOSE_RE, ITEM_CODE_RE,
} from '../../src/main/code'
export { isRealized, forecastTotals, realizedTotals } from '../../src/shared/recognition'

// ------------------------------------------------------------
// 文字・検索
// ------------------------------------------------------------

/** 記号と空白を落として比較用のキーを作る */
export function normalizeName(s: string): string {
  return s.replace(/[\s　【】\[\]（）()／/・,、。]/g, '').toLowerCase()
}

export function normalizeSearchText(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/** query を空白区切りにした語（terms）が haystacks のどれかに全部含まれるか（AND） */
export function matchesQuery(haystacks: Array<string | null | undefined>, terms: string[]): boolean {
  if (terms.length === 0) return true
  const normalized = haystacks.filter((h): h is string => !!h).map(normalizeSearchText)
  return terms.every(term => normalized.some(h => h.includes(term)))
}

/** date（YYYY-MM-DD 等）降順に並べ、種類ごとの上限で切る */
export function sortAndSlice(hits: SearchHit[], perKind: number): SearchHit[] {
  return hits
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, perKind)
}

// ------------------------------------------------------------
// 日付（日本時間）
// ------------------------------------------------------------

// 日本に夏時間は無い。+9 時間ずらした UTC の暦日が、そのまま日本の暦日になる
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 日本時間の今日（YYYY-MM-DD）。UTC の 15:00〜23:59 は、もう日本では翌日 */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 日本時間の今月（YYYY-MM） */
export function thisMonthJst(now: Date = new Date()): string {
  return todayJst(now).slice(0, 7)
}

/** base（YYYY-MM-DD）から days 日前の日付（YYYY-MM-DD）。暦の計算だけで、時計には依らない（負の days なら後の日付） */
export function subtractDaysJst(base: string, days: number): string {
  assertDateText('基準の日付', base)
  if (!Number.isSafeInteger(days)) throw new UserError('日数は整数で入力してください')
  const [y, m, d] = base.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
}

/** いまの時刻の ISO 文字列（UTC）。timestamptz の列に入れる／返す形 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

/** 月（YYYY-MM）の最初の日と最後の日。`${month}-31` は Postgres の date に入らない月（2 月など）があるので、これを使う */
export function monthBounds(month: string): { start: string; end: string } {
  assertMonthText('月', month)
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

// ------------------------------------------------------------
// 入力・金額
// ------------------------------------------------------------

/** integer 列に入る最大（Postgres の integer は 32 ビット）。これを超える数は DB で 22003 になる */
export const MAX_INT4 = 2_147_483_647

/** 金額を桁区切りの「¥2,699」形式にする（Workers の Intl に頼らず自前で区切る） */
export function yenText(n: number): string {
  const sign = n < 0 ? '-' : ''
  const [int, frac] = String(Math.abs(n)).split('.')
  return `¥${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`
}

/**
 * 画面からの入力で金額（円）を検証する。安全な整数で 0 以上でなければ UserError。
 * money.ts の assertYen と同じ規則と文言（素の Error を UserError に包んだ）に、integer 列に入る上限を足したもの
 */
export function assertYen(name: string, v: unknown): asserts v is number {
  if (typeof v !== 'number') throw new UserError(`${name}は整数で入力してください`)
  try {
    assertYenRaw(name, v)
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : `${name}は整数で入力してください`)
  }
  if (v > MAX_INT4) throw new UserError(`${name}が大きすぎます`)
}

/** 数量を検証する。1 以上の整数でなければ UserError（money.ts の assertQty を UserError に包んだ） */
export function assertQty(name: string, v: unknown): asserts v is number {
  if (typeof v !== 'number') throw new UserError(`${name}は1以上の整数で入力してください`)
  try {
    assertQtyRaw(name, v)
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : `${name}は1以上の整数で入力してください`)
  }
  if (v > MAX_INT4) throw new UserError(`${name}が大きすぎます`)
}

export function assertDateText(name: string, v: unknown): asserts v is string {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null
  const ok = m !== null && (() => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dt = new Date(Date.UTC(y, mo - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  })()
  if (!ok) throw new UserError(`${name}はYYYY-MM-DDの形式で入力してください`)
}

export function assertMonthText(name: string, v: unknown): asserts v is string {
  // 1900 年より前は Date.UTC が年を読み替える（0〜99 年が 1900 年代になる）ので、最後の日の計算が狂う。月次で使う範囲だけ通す
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v) || Number(v.slice(0, 4)) < 1900) {
    throw new UserError(`${name}はYYYY-MMの形式で入力してください`)
  }
}

/** 0 円は入出金にも債務にも意味がないので、assertYen（0 以上）に加えて 1 以上を求める */
export function assertPositiveYen(name: string, v: unknown): asserts v is number {
  assertYen(name, v)
  if (v < 1) throw new UserError(`${name}は1円以上で入力してください`)
}

/** 前後の空白を除く。空・空白だけは null */
export function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

/** ツール分の額。根拠（粗利 × 割合）から floor で決める。円未満は払わない側に寄せて整数にする */
export function toolShareAmount(basisAmount: number, rateBp: number): number {
  return Math.floor(basisAmount * rateBp / 10000)
}

// ------------------------------------------------------------
// 引数の検査
//
// 画面から JSON で来る引数は信用しない。型・範囲が違えば UserError（400）にして、SQL まで流さない（500 にしない）。
// name は利用者に見せる項目名（「金額」「タグ名」など）。
//
//   argX         … 必須。無い・null も UserError
//   argOptX      … null と undefined を同じ「無い」として undefined を返す（位置引数の省略。HTTP は途中の undefined を null で送る）
//   argNullableX … undefined は undefined（変えない）、null は null（消す）、値は検査して返す（patch の項目用）
// ------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEXT_MAX_DEFAULT = 10_000
const ARRAY_MAX_DEFAULT = 10_000

const absent = (v: unknown): v is null | undefined => v === undefined || v === null

export interface TextOptions {
  /** 文字数の上限（既定 10,000） */
  max?: number
}

/** 文字列。空文字は通す（空かどうかは、呼ぶ側が自分の文言で断る）。前後の空白は除かない。NUL 文字は断る */
export function argText(name: string, v: unknown, opts: TextOptions = {}): string {
  if (absent(v)) throw new UserError(`${name}を入力してください`)
  if (typeof v !== 'string') throw new UserError(`${name}は文字で入力してください`)
  const max = opts.max ?? TEXT_MAX_DEFAULT
  if (v.length > max) throw new UserError(`${name}は${max}文字以内で入力してください`)
  if (v.includes('\u0000')) throw new UserError(`${name}に使えない文字が含まれています`)
  return v
}
export const argOptText = (name: string, v: unknown, opts?: TextOptions): string | undefined =>
  absent(v) ? undefined : argText(name, v, opts)
export const argNullableText = (name: string, v: unknown, opts?: TextOptions): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : argText(name, v, opts)

export interface IntOptions {
  /** 既定 -2,147,483,647（integer 列に入る範囲） */
  min?: number
  /** 既定 2,147,483,647 */
  max?: number
}

/** 整数（安全な整数で、integer 列に入る範囲） */
export function argInt(name: string, v: unknown, opts: IntOptions = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new UserError(`${name}は整数で入力してください`)
  const min = opts.min ?? -MAX_INT4
  const max = opts.max ?? MAX_INT4
  if (v < min || v > max) throw new UserError(`${name}は${min}以上${max}以下で入力してください`)
  return v
}
export const argOptInt = (name: string, v: unknown, opts?: IntOptions): number | undefined =>
  absent(v) ? undefined : argInt(name, v, opts)
export const argNullableInt = (name: string, v: unknown, opts?: IntOptions): number | null | undefined =>
  v === undefined ? undefined : v === null ? null : argInt(name, v, opts)

/** 金額（円）。0 以上の整数で、integer 列に入る範囲 */
export function argYen(name: string, v: unknown): number {
  assertYen(name, v)
  return v
}
export const argOptYen = (name: string, v: unknown): number | undefined => (absent(v) ? undefined : argYen(name, v))
export const argNullableYen = (name: string, v: unknown): number | null | undefined =>
  v === undefined ? undefined : v === null ? null : argYen(name, v)

/** uuid の形か（検査するだけ。値は変えない） */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** id（uuid）。小文字にして返す */
export function argId(name: string, v: unknown): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new UserError(`${name}の指定が正しくありません`)
  return v.toLowerCase()
}
export const argOptId = (name: string, v: unknown): string | undefined => (absent(v) ? undefined : argId(name, v))
export const argNullableId = (name: string, v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : argId(name, v)

/** id（uuid）の配列。重複は除かない（呼ぶ側で `new Set` する）。既定で 1,000 個まで */
export function argIds(name: string, v: unknown, opts: { max?: number } = {}): string[] {
  return argArray(name, v, { max: opts.max ?? 1000 }).map(x => argId(name, x))
}

export function argBool(name: string, v: unknown): boolean {
  if (typeof v !== 'boolean') throw new UserError(`${name}は true か false で指定してください`)
  return v
}
export const argOptBool = (name: string, v: unknown): boolean | undefined => (absent(v) ? undefined : argBool(name, v))

/** 0/1 のフラグ（is_active など。契約は number）。true / false も受けて 0 / 1 にする */
export function argFlag(name: string, v: unknown): 0 | 1 {
  if (v === true || v === 1) return 1
  if (v === false || v === 0) return 0
  throw new UserError(`${name}は 0 か 1 で指定してください`)
}
export const argOptFlag = (name: string, v: unknown): 0 | 1 | undefined => (absent(v) ? undefined : argFlag(name, v))

export function argArray(name: string, v: unknown, opts: { max?: number } = {}): unknown[] {
  if (!Array.isArray(v)) throw new UserError(`${name}の形が正しくありません`)
  const max = opts.max ?? ARRAY_MAX_DEFAULT
  if (v.length > max) throw new UserError(`${name}は${max}個以内で指定してください`)
  return v
}
export const argOptArray = (name: string, v: unknown, opts?: { max?: number }): unknown[] | undefined =>
  absent(v) ? undefined : argArray(name, v, opts)

/** 素のオブジェクト（配列・null は断る）。項目ごとに自分で検査すること */
export function argObject(name: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new UserError(`${name}の形が正しくありません`)
  return v as Record<string, unknown>
}
export const argOptObject = (name: string, v: unknown): Record<string, unknown> | undefined =>
  absent(v) ? undefined : argObject(name, v)

/** 決まった値のどれか */
export function argEnum<T extends string>(name: string, v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new UserError(`${name}の値が正しくありません`)
  return v as T
}
export const argOptEnum = <T extends string>(name: string, v: unknown, allowed: readonly T[]): T | undefined =>
  absent(v) ? undefined : argEnum(name, v, allowed)
export const argNullableEnum = <T extends string>(name: string, v: unknown, allowed: readonly T[]): T | null | undefined =>
  v === undefined ? undefined : v === null ? null : argEnum(name, v, allowed)

/** 日付（YYYY-MM-DD。実在する日だけ） */
export function argDate(name: string, v: unknown): string {
  assertDateText(name, v)
  return v
}
export const argOptDate = (name: string, v: unknown): string | undefined => (absent(v) ? undefined : argDate(name, v))
export const argNullableDate = (name: string, v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : argDate(name, v)

/** 月（YYYY-MM） */
export function argMonth(name: string, v: unknown): string {
  assertMonthText(name, v)
  return v
}
export const argOptMonth = (name: string, v: unknown): string | undefined => (absent(v) ? undefined : argMonth(name, v))
export const argNullableMonth = (name: string, v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : argMonth(name, v)

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------

/** 行の配列をCSV文字列にする。0件は空文字（呼び出し元はこれを「対象なし」として扱う） */
export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ]
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + lines.join('\r\n')
}

// ------------------------------------------------------------
// 画像
// ------------------------------------------------------------

/**
 * Storage のパス（`<世帯>/<種類>/<ランダム>.<拡張子>`）を、画面が `<img src>` にそのまま渡せる URL にする
 * （デスクトップ版の `toThumbUrl` の置き換え）。公開バケット media のものだけ。
 * path が null・空、または SUPABASE_URL が無い（`ctx.mediaBase` が null）なら null
 */
export function mediaUrl(ctx: Pick<Ctx, 'mediaBase'>, path: string | null | undefined): string | null {
  if (!path || !ctx.mediaBase) return null
  const encoded = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
  return `${ctx.mediaBase}/${encoded}`
}

// ------------------------------------------------------------
// 設定
// ------------------------------------------------------------

export async function setting(ctx: Ctx, key: string, fallback: number): Promise<number> {
  const r = await ctx.sql.get<{ value: string }>('select value from setting where key = ?', key)
  return r ? Number(r.value) : fallback
}

export async function settingStr(ctx: Ctx, key: string, fallback = ''): Promise<string> {
  const r = await ctx.sql.get<{ value: string }>('select value from setting where key = ?', key)
  return r ? r.value : fallback
}

/**
 * 出品先ごとの転売/私物判定キーワード。mercari は設定 mercari_keyword、yahoo は yahoo_keyword
 * （出品先ごとに扱う商品が違うことがあるため独立）。
 */
export async function keywordsFor(ctx: Ctx, channel: SalesChannel): Promise<string[]> {
  return parseKeywords(await settingStr(ctx, channel === 'yahoo' ? 'yahoo_keyword' : 'mercari_keyword', ''))
}

/**
 * mercari_keyword を「,」「、」空白（全角/半角）・改行区切りの複数語として解釈する。
 * 前後の空白は除去、空要素は無視、大小文字は無視する。
 */
export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,、\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
}

/** text がキーワードのどれか1つでも含んでいれば true（大小無視） */
export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k))
}

// ------------------------------------------------------------
// タグ
// ------------------------------------------------------------

type TagTable = 'sale_tag' | 'inventory_tag' | 'purchase_tag' | 'product_tag' | 'shop_account_tag'
type TagOwnerColumn = 'sale_id' | 'inventory_item_id' | 'purchase_id' | 'model_code' | 'shop_account_id'

/**
 * タグを持つテーブル（sale_tag / inventory_tag / purchase_tag / product_tag / shop_account_tag）
 * から、対象idごとのタグ配列をまとめて1クエリで引く（N+1にしない）。
 * product_tag だけは持ち主が model_code（文字列）、他は uuid。
 */
export async function loadTagsFor(
  ctx: Ctx,
  table: TagTable,
  column: TagOwnerColumn,
  ids: string[],
): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>()
  if (ids.length === 0) return map

  const arrayType = column === 'model_code' ? 'text[]' : 'uuid[]'
  const rows = await ctx.sql.all<{ owner_id: string; id: string; name: string; sort_order: number }>(`
    select x.${column} as owner_id, t.id, t.name, t.sort_order
      from ${table} x
      join tag t on t.household_id = x.household_id and t.id = x.tag_id
     where x.${column} = any(?::${arrayType})
     order by t.sort_order, t.name collate "C"
  `, ids)

  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/**
 * 派生タグを、優先順位 purchase > product > inventory で1つにまとめる
 * （同じタグが複数の経路から来ても重複させない）。直接タグ（directIds）は除く。
 * sources は既に優先順に並べて渡すこと（先勝ち）。
 *
 * 名前の並びは文字コード順（ロケールに依らない。SQL の `collate "C"` と同じ）。
 */
export function mergeInheritedTags(
  directIds: Set<string>,
  sources: Array<{ from: NonNullable<Tag['from']>; tags: Tag[] }>,
): Tag[] {
  const seen = new Map<string, Tag>()
  for (const { from, tags } of sources) {
    for (const t of tags) {
      if (directIds.has(t.id) || seen.has(t.id)) continue
      seen.set(t.id, { ...t, from })
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * 渡したタグがすべてこの世帯にあることを確かめる（無ければ UserError・404）。
 * 他の世帯のタグは RLS で見えないので「無い」になる。外部キー違反（500）にせず、日本語で断るために先に呼ぶ
 */
export async function assertTagsExist(ctx: Ctx, tagIds: string[]): Promise<void> {
  const unique = [...new Set(tagIds)]
  if (unique.length === 0) return
  const r = await ctx.sql.get<{ n: number }>('select count(*) as n from tag where id = any(?::uuid[])', unique)
  if (!r || r.n !== unique.length) throw new UserError('タグが見つかりません', 'not_found')
}
