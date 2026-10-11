import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { asApi } from '../schema/helpers'

// ビューのパリティテスト用の道具。
// fixtures/expected.json は、SQLite（いまの帳簿）に見本のデータを db.ts の関数で入れて、
// 「テーブルの中身」と「5 本のビューの出力」を書き出したもの（書き出した使い捨てのテストは消してある）。
// ここではテーブルの中身を同じ id のまま Postgres に写して、ビューの出力を突き合わせる

export type Row = Record<string, unknown>

export const VIEW_NAMES = [
  'sale_profit', 'monthly_summary', 'inventory_view', 'sale_line_share', 'variant_summary',
] as const
export type ViewName = (typeof VIEW_NAMES)[number]

export interface Fixture {
  /** 期待値を書き出した日（日本時間）。inventory_view.aging_days はこの日を「今日」として出ている */
  generated_on: string
  sqlite_version: string
  /** SQLite の行そのまま（rowid の昇順）。sale_line の順が、そのまま紐付けた順（allocation_order） */
  tables: Record<string, Row[]>
  views: Record<ViewName, Row[]>
}

export function loadFixture(): Fixture {
  const path = fileURLToPath(new URL('./fixtures/expected.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture
}

// ------------------------------------------------------------
// SQLite の行 → Postgres の行（列名・型の違いを写す）
// ------------------------------------------------------------

/** 列名が変わったもの（テーブルごと）。ここに無い列は同じ名前で写す。Postgres に無い列は例外 */
const RENAMES: Record<string, Record<string, string>> = {
  sale: { mercari_item_id: 'channel_item_id', thumb_file: 'thumb_path' },
  listing: { mercari_item_id: 'channel_item_id', thumb_file: 'thumb_path' },
  purchase_line: { image_file: 'image_path' },
  expense: { receipt_file: 'receipt_path' },
}

/** 外部キーの順（親が先）。sale_line は SQLite の rowid 順のまま入れる */
const INSERT_ORDER = [
  'shop_account', 'shipping_method', 'purchase', 'purchase_line', 'inventory_item', 'sale',
  'sale_line', 'listing', 'listing_line', 'product_name', 'expense', 'expense_line', 'month_book',
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 世帯 B にも同じ見本を入れるための id の写し（主キーは世帯をまたいで重ならない）。先頭 8 桁だけ置き換える */
export function remapUuid(s: string): string {
  return 'bbbbbbbb' + s.slice(8)
}

export function mapIds<T>(value: T, f: (s: string) => string): T {
  if (typeof value === 'string') return (UUID.test(value) ? f(value) : value) as T
  if (Array.isArray(value)) return value.map((v) => mapIds(v, f)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapIds(v, f)])) as T
  }
  return value
}

/** 出品の uuid。SQLite の listing は主キーが商品 ID だったので、Postgres 側で振る */
function listingUuid(index: number, tag: string): string {
  return `${tag}0000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`
}

/**
 * SQLite の日時の文字列 → timestamptz に渡せる文字列。
 * * 'YYYY-MM-DD HH:MM:SS'      … datetime('now')。UTC
 * * ISO（Z 付き）              … new Date().toISOString()。そのまま
 * * purchased_at だけ          … 日本時間のまま保存されている。日付だけの行はその日の 0:00（日本時間）
 */
export function toTimestamptz(column: string, s: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}Z`
  if (column === 'purchased_at') return jstToIso(s)
  throw new Error(`想定外の日時の形です: ${column} = ${s}`)
}

/** 日本時間の 'YYYY-MM-DD' か 'YYYY-MM-DDTHH:mm' → UTC の ISO 文字列 */
export function jstToIso(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+09:00`).toISOString()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return new Date(`${s}:00+09:00`).toISOString()
  throw new Error(`想定外の日時の形です: ${s}`)
}

async function columnTypes(tx: Transaction, table: string): Promise<Map<string, string>> {
  const { rows } = await tx.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_schema = 'app' and table_name = $1`,
    [table],
  )
  return new Map(rows.map((r) => [r.column_name, r.data_type]))
}

async function insertRows(
  tx: Transaction,
  table: string,
  rows: Row[],
  extra?: (row: Row) => Row,
): Promise<void> {
  const types = await columnTypes(tx, table)
  const renames = RENAMES[table] ?? {}
  for (const row of rows) {
    const cols: string[] = []
    const holders: string[] = []
    const params: unknown[] = []
    const all: Row = { ...row, ...(extra ? extra(row) : {}) }
    for (const [k, v] of Object.entries(all)) {
      const col = renames[k] ?? k
      const type = types.get(col)
      if (!type) throw new Error(`Postgres の ${table} に列 ${col}（SQLite の ${k}）がありません`)
      cols.push(col)
      params.push(convert(col, type, v))
      const n = params.length
      if (type === 'jsonb') holders.push(`$${n}::text::jsonb`)
      else if (type === 'ARRAY') holders.push(`array(select jsonb_array_elements_text($${n}::text::jsonb))`)
      else holders.push(`$${n}`)
    }
    await tx.query(`insert into app.${table} (${cols.join(', ')}) values (${holders.join(', ')})`, params)
  }
}

function convert(column: string, type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (type === 'date') {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw new Error(`日付ではありません: ${column} = ${String(v)}`)
    return v.slice(0, 10)
  }
  if (type === 'timestamp with time zone') return toTimestamptz(column, String(v))
  // model_codes は JSON の文字列 → text[]。raw は JSON の文字列 → jsonb（どちらも文字列のまま渡して SQL 側で変換）
  if (type === 'ARRAY' || type === 'jsonb') return String(v)
  return v
}

/**
 * 見本を 1 世帯ぶん Postgres に入れる（API と同じ入り方：soroban_api＋世帯を渡す）。
 * remap を渡すと、全部の uuid を写して入れる（別の世帯に同じ見本を入れるため）
 */
export async function loadFixtureInto(
  db: PGlite,
  householdId: string,
  fx: Fixture,
  remap: ((s: string) => string) | null = null,
): Promise<void> {
  const f = remap ? (s: string) => remap(s) : null
  const tables = f ? (mapIds(fx.tables, f) as Fixture['tables']) : fx.tables
  const tag = remap ? 'b' : 'a'

  await asApi(db, householdId, async (tx) => {
    // 出品：SQLite の主キー（商品 ID）に対して uuid を振る
    const listingIds = new Map<string, string>()
    ;(tables.listing ?? []).forEach((l, i) => listingIds.set(String(l.mercari_item_id), listingUuid(i, tag)))

    for (const table of INSERT_ORDER) {
      const rows = tables[table] ?? []
      if (table === 'listing') {
        await insertRows(tx, table, rows, (r) => ({ id: listingIds.get(String(r.mercari_item_id)) }))
      } else if (table === 'listing_line') {
        await insertRows(tx, table, rows, (r) => ({ listing_id: listingIds.get(String(r.listing_id)) }))
      } else {
        await insertRows(tx, table, rows)
      }
    }
  })
}

/**
 * 基準の実装（CLAUDE.md の「按分」）：total を count 個に均等に割る。
 * floor(total / count) を配って、余り r（0 <= r < count）を「末尾の r 行」に 1 円ずつ。
 * 負の total でも床の割り算（1,001 円 ÷ 3 → 333/334/334、-2,002 円 ÷ 3 → -668/-667/-667）
 */
export function evenly(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const rem = total - base * count
  return Array.from({ length: count }, (_, i) => base + (i >= count - rem ? 1 : 0))
}

// ------------------------------------------------------------
// ビューの読み出しと比較
// ------------------------------------------------------------

const SORT_KEYS: Record<ViewName, string[]> = {
  sale_profit: ['id'],
  monthly_summary: ['month', 'kind'],
  inventory_view: ['id'],
  sale_line_share: ['sale_line_id'],
  variant_summary: ['model_code'],
}

export function sortRows(view: ViewName, rows: Row[]): Row[] {
  const keys = SORT_KEYS[view]
  const key = (r: Row) => keys.map((k) => String(r[k])).join('\u0000')
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

/**
 * ビューの全行を JSON として読む。to_jsonb にすると、列の型がそのまま JSON の型になる：
 * integer → number、date → 'YYYY-MM-DD'、text[] → 配列、timestamptz → ISO 文字列。
 * （bigint や numeric が混ざると、ここで JSON の数にならず文字列になる→比較で落ちる）
 */
export async function readView(tx: Transaction, view: ViewName): Promise<Row[]> {
  const { rows } = await tx.query<{ r: Row }>(`select to_jsonb(v) as r from app.${view} v`)
  return rows.map((x) => x.r)
}

/** Postgres の行を比べる形にする：household_id を外し（別に確かめる）、日時を UTC の ISO にそろえる */
export function normalizePg(view: ViewName, rows: Row[], householdId: string): Row[] {
  return rows.map((r) => {
    const { household_id, ...rest } = r
    if (household_id !== householdId) throw new Error(`${view} に別の世帯の行が混ざっています: ${String(household_id)}`)
    if (view === 'sale_profit' && typeof rest.purchased_at === 'string') {
      rest.purchased_at = new Date(rest.purchased_at).toISOString()
    }
    return rest
  })
}

/** SQLite の行を Postgres の列名・型に正規化する（正規化の内容は報告に書いてある） */
export function normalizeSqlite(view: ViewName, rows: Row[]): Row[] {
  return rows.map((src) => {
    const r: Row = { ...src }
    if (view === 'sale_profit' || view === 'inventory_view') {
      rename(r, 'thumb_file', 'thumb_path')
    }
    if (view === 'sale_profit') {
      rename(r, 'mercari_item_id', 'channel_item_id')
      r.model_codes = JSON.parse(String(r.model_codes)) as unknown
      if (typeof r.purchased_at === 'string') r.purchased_at = jstToIso(r.purchased_at)
    }
    return r
  })
}

function rename(r: Row, from: string, to: string): void {
  if (!(from in r)) throw new Error(`SQLite の行に ${from} がありません`)
  r[to] = r[from]
  delete r[from]
}
