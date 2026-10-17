import type { Sql } from '../../server/db/sql'
import type { ColumnInfoMap, ConvertedData, ConvertedTable } from './convert'
import { daysBetween, readInstant, toInstant } from './dates'
import type { ImagePlan } from './images'
import type { InvariantCheck, Mismatch, MonthlyCheck, SumCheck, TableCheck, ViewCheck } from './report'
import { VIEW_NAMES, type Row, type SourceSnapshot, type ViewName } from './types'

// 突き合わせ。2 通り：
//  1. 表：書いた値を Postgres から読み戻して、書いたものと 1 行ずつ比べる（トリガーが値を変えていないか、型の変換で欠けていないか）
//  2. ビュー：SQLite 自身のビューの出力（いまの帳簿の数字）と、Postgres のビューの出力を、全行・全列で比べる
// 1 つでも違えば呼び出し側が失敗として終わる（トランザクションを巻き戻す）

export interface VerifyInput {
  /** 世帯のトランザクションの中の Sql */
  sql: Sql
  householdId: string
  snapshot: SourceSnapshot
  data: ConvertedData
  columns: (table: string) => ColumnInfoMap
  images: ImagePlan
  /** 設定を上書きする前の Postgres の値（世帯の初期データ） */
  settingsBefore: Map<string, string>
}

export interface VerifyResult {
  tables: TableCheck[]
  sums: SumCheck[]
  monthly: MonthlyCheck[]
  views: ViewCheck[]
  invariants: InvariantCheck[]
}

const MAX_MISMATCHES_SHOWN = 10
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function verifyMigration(input: VerifyInput): Promise<VerifyResult> {
  const hh = input.householdId.toLowerCase()
  const tables = await checkTables(input, hh)
  const pgViews = await readViews(input.sql)
  const views: ViewCheck[] = []
  const sums: SumCheck[] = []
  const normalized = {} as Record<ViewName, { sqlite: Row[]; pg: Row[] }>
  for (const view of VIEW_NAMES) {
    const sqlite = normalizeSqliteView(view, input.snapshot.views[view] ?? [], input.images)
    const pg = normalizePgView(view, pgViews[view], hh)
    normalized[view] = { sqlite, pg }
    views.push(compareView(view, sqlite, pg))
  }
  sums.push(...saleProfitSums(normalized.sale_profit.sqlite, normalized.sale_profit.pg))
  const monthly = monthlyChecks(normalized.monthly_summary.sqlite, normalized.monthly_summary.pg)
  const invariants = await checkInvariants(input, hh, normalized.inventory_view.pg)
  return { tables, sums, monthly, views, invariants }
}

// ------------------------------------------------------------
// 表：読み戻し
// ------------------------------------------------------------

/** 比べるために形をそろえる。書いた側（written）と読んだ側（read）で、jsonb の持ち方だけ違う */
function canon(type: string, v: unknown, side: 'written' | 'read'): unknown {
  if (v === null || v === undefined) return null
  switch (type) {
    case 'timestamp with time zone':
      return typeof v === 'string' ? (readInstant(v) ?? `?${v}`) : v
    case 'date':
      return typeof v === 'string' ? v.slice(0, 10) : v
    case 'jsonb':
      return stable(side === 'written' && typeof v === 'string' ? JSON.parse(v) : v)
    case 'ARRAY':
      return JSON.stringify(v)
    case 'uuid':
      return String(v).toLowerCase()
    default:
      return v
  }
}

/** キーの順を固めた JSON（jsonb は列の順を覚えないので） */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const t = s === undefined ? 'undefined' : s
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

async function checkTables(input: VerifyInput, hh: string): Promise<TableCheck[]> {
  const { sql, snapshot, data } = input
  const out: TableCheck[] = []
  for (const t of data.tables) {
    const info = input.columns(t.table)
    const sourceCount = (snapshot.tables[t.table] ?? []).length
    const expected = t.table === 'setting' ? withInitialSettings(t, input.settingsBefore) : t
    const dropped = data.droppedRows.get(t.table) ?? 0
    const skippedSettings = t.table === 'setting' ? data.settings.skipped.length : 0

    const written = new Map<string, Row>()
    for (const r of expected.rows) {
      const rec: Row = {}
      expected.columns.forEach((c, i) => {
        rec[c] = canon((info.get(c) as { type: string }).type, r.values[i], 'written')
      })
      written.set(keyOf(expected.key, rec), rec)
    }
    const read = await sql.all<{ r: Row }>(`select to_jsonb(t) as r from app.${t.table} t where t.household_id = ?`, hh)

    let mismatched = 0
    for (const { r } of read) {
      const rec: Row = {}
      for (const c of expected.columns) rec[c] = canon((info.get(c) as { type: string }).type, r[c], 'read')
      const key = keyOf(expected.key, rec)
      const want = written.get(key)
      if (!want) {
        mismatched++
        continue
      }
      written.delete(key)
      if (expected.columns.some((c) => want[c] !== rec[c])) mismatched++
    }
    mismatched += written.size // 書いたはずなのに読み戻せなかった行

    const notes: string[] = []
    if (dropped > 0) notes.push(`画像が無く移さなかった ${dropped} 行`)
    if (t.table === 'setting') {
      notes.push(`移さなかった ${skippedSettings} 件、世帯の初期値 ${input.settingsBefore.size} 件と合算`)
    }
    const accounted = t.rows.length + dropped + skippedSettings
    out.push({
      table: t.table,
      sqlite: sourceCount,
      postgres: read.length,
      mismatched,
      ok: mismatched === 0 && read.length === expected.rows.length && accounted === sourceCount,
      note: notes.join('、'),
    })
  }
  return out
}

function keyOf(key: string[], rec: Row): string {
  return key.map((k) => String(rec[k])).join('\u0000')
}

/** 設定は、世帯の初期値（Postgres）に SQLite の値を重ねたものが、書いたあとの姿 */
function withInitialSettings(t: ConvertedTable, before: Map<string, string>): ConvertedTable {
  const merged = new Map(before)
  for (const r of t.rows) merged.set(r.values[0] as string, r.values[1] as string)
  return { ...t, rows: [...merged].map(([k, v]) => ({ values: [k, v], label: k })) }
}

// ------------------------------------------------------------
// ビュー
// ------------------------------------------------------------

interface ViewSpec {
  key: string[]
  /** 比べない列。aging_days は「今日」で変わるので SQLite の値とは比べず、Postgres の中で別に確かめる */
  ignore: string[]
  /**
   * この差までは一致とみなす列（円）。variant_summary の avg_price / avg_profit は表示用の平均で、分割した箱の重み
   * （1/n）を倍精度で足すため、平均がちょうど x.5 のときに SQLite（補償加算）と Postgres（単純加算）で四捨五入の向きが
   * 割れることがある（実データで B001 が 6551 / 6550）。帳簿の金額・合計には使っていないので ±1 円は許す
   */
  tolerance?: Record<string, number>
}

const VIEW_SPECS: Record<ViewName, ViewSpec> = {
  sale_profit: { key: ['id'], ignore: [] },
  monthly_summary: { key: ['month', 'kind'], ignore: [] },
  inventory_view: { key: ['id'], ignore: ['aging_days'] },
  sale_line_share: { key: ['sale_line_id'], ignore: [] },
  variant_summary: { key: ['model_code'], ignore: [], tolerance: { avg_price: 1, avg_profit: 1 } },
}

async function readViews(sql: Sql): Promise<Record<ViewName, Row[]>> {
  const out = {} as Record<ViewName, Row[]>
  for (const view of VIEW_NAMES) {
    out[view] = (await sql.all<{ r: Row }>(`select to_jsonb(v) as r from app.${view} v`)).map((x) => x.r)
  }
  return out
}

function lowerUuids(r: Row): Row {
  for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && UUID.test(v)) r[k] = v.toLowerCase()
  return r
}

/** Postgres の行：household_id を外し（別に確かめる）、日時を UTC の ISO にそろえる */
function normalizePgView(view: ViewName, rows: Row[], hh: string): Row[] {
  return rows.map((src) => {
    const { household_id, ...rest } = src
    if (household_id !== hh) throw new Error(`${view} に別の世帯の行が混ざっています: ${String(household_id)}`)
    if (view === 'sale_profit' && typeof rest.purchased_at === 'string') {
      rest.purchased_at = readInstant(rest.purchased_at) ?? rest.purchased_at
    }
    return lowerUuids(rest)
  })
}

/**
 * SQLite の行を、Postgres の列名・型に直す：
 * * thumb_file → thumb_path（値は画像の対応表の新しいパス。参照が無い・見つからなかったものは null）
 * * mercari_item_id → channel_item_id、model_codes（JSON の文字列）→ 配列
 * * purchased_at（日本時間の素の文字列）→ UTC の ISO
 */
function normalizeSqliteView(view: ViewName, rows: Row[], images: ImagePlan): Row[] {
  return rows.map((src) => {
    const r: Row = { ...src }
    if (view === 'sale_profit' || view === 'inventory_view') {
      const saleId = view === 'sale_profit' ? r.id : r.sold_sale_id
      renameColumn(r, 'thumb_file', 'thumb_path')
      r.thumb_path = r.thumb_path === null || r.thumb_path === undefined || saleId === null || saleId === undefined
        ? null
        : images.pathFor('sale', String(saleId))
    }
    if (view === 'sale_profit') {
      renameColumn(r, 'mercari_item_id', 'channel_item_id')
      r.model_codes = JSON.parse(String(r.model_codes)) as unknown
      if (typeof r.purchased_at === 'string') {
        const t = toInstant(r.purchased_at)
        if (!t) throw new Error('sale_profit.purchased_at が日時として読めません')
        r.purchased_at = t.value
      }
    }
    return lowerUuids(r)
  })
}

function renameColumn(r: Row, from: string, to: string): void {
  if (!(from in r)) throw new Error(`SQLite のビューの行に ${from} がありません`)
  r[to] = r[from]
  delete r[from]
}

const same = (a: unknown, b: unknown): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b))

function withinTolerance(spec: ViewSpec, column: string, a: unknown, b: unknown): boolean {
  const tol = spec.tolerance?.[column]
  return tol !== undefined && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol
}

function compareView(view: ViewName, sqlite: Row[], pg: Row[]): ViewCheck {
  const spec = VIEW_SPECS[view]
  const sqliteMap = new Map(sqlite.map((r) => [keyOf(spec.key, r), r]))
  const pgMap = new Map(pg.map((r) => [keyOf(spec.key, r), r]))
  const mismatches: Mismatch[] = []
  let count = 0
  const add = (m: Mismatch): void => {
    count++
    if (mismatches.length < MAX_MISMATCHES_SHOWN) mismatches.push(m)
  }

  const columns = new Set<string>()
  for (const [key, a] of sqliteMap) {
    const b = pgMap.get(key)
    if (!b) {
      add({ key: key.replace(/\u0000/g, ' / '), problem: 'missing_in_postgres', columns: [] })
      continue
    }
    const names = new Set([...Object.keys(a), ...Object.keys(b)].filter((c) => !spec.ignore.includes(c)))
    names.forEach((c) => columns.add(c))
    const diffs = [...names]
      .filter((c) => !(c in a) || !(c in b) || !(same(a[c], b[c]) || withinTolerance(spec, c, a[c], b[c])))
      .map((c) => ({ column: c, sqlite: c in a ? show(a[c]) : '(列なし)', postgres: c in b ? show(b[c]) : '(列なし)' }))
    if (diffs.length > 0) add({ key: key.replace(/\u0000/g, ' / '), problem: 'different', columns: diffs })
  }
  for (const key of pgMap.keys()) {
    if (!sqliteMap.has(key)) add({ key: key.replace(/\u0000/g, ' / '), problem: 'extra_in_postgres', columns: [] })
  }
  return {
    view, sqliteRows: sqlite.length, postgresRows: pg.length, columns: columns.size,
    mismatchCount: count, mismatches, ok: count === 0,
  }
}

const SALE_PROFIT_SUMS = ['price', 'fee', 'shipping_fee', 'packaging_cost', 'cost', 'gross_profit'] as const

function sumOf(rows: Row[], column: string): number {
  return rows.reduce((total, r) => (typeof r[column] === 'number' ? total + (r[column] as number) : Number.NaN), 0)
}

function saleProfitSums(sqlite: Row[], pg: Row[]): SumCheck[] {
  const rows: SumCheck[] = [
    { view: 'sale_profit', name: '販売の件数', sqlite: sqlite.length, postgres: pg.length, ok: sqlite.length === pg.length },
  ]
  for (const column of SALE_PROFIT_SUMS) {
    const a = sumOf(sqlite, column)
    const b = sumOf(pg, column)
    rows.push({ view: 'sale_profit', name: column, sqlite: a, postgres: b, ok: a === b })
  }
  return rows
}

function monthlyChecks(sqlite: Row[], pg: Row[]): MonthlyCheck[] {
  const key = (r: Row): string => `${String(r.month)}\u0000${String(r.kind)}`
  const a = new Map(sqlite.map((r) => [key(r), r.gross_profit as number]))
  const b = new Map(pg.map((r) => [key(r), r.gross_profit as number]))
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((k) => {
    const [month, kind] = k.split('\u0000')
    const x = a.get(k) ?? null
    const y = b.get(k) ?? null
    return { month, kind, sqlite: x, postgres: y, ok: x !== null && x === y }
  })
}

// ------------------------------------------------------------
// そのほかの確認
// ------------------------------------------------------------

async function checkInvariants(input: VerifyInput, hh: string, inventoryView: Row[]): Promise<InvariantCheck[]> {
  const { sql, data } = input
  const out: InvariantCheck[] = []

  // 1. 並びを identity の番号で持つ表（sale_line.allocation_order、liability_settlement.settle_order）が、
  //    SQLite の rowid 順のまま。sale_line は、まとめ売りの端数をどの行に寄せるかがこの順で決まる（変わるとお金がずれる）
  for (const t of data.tables) {
    if (!t.orderColumn || !input.columns(t.table).has(t.orderColumn)) continue
    const idCol = t.columns.indexOf('id')
    const wanted = t.rows.map((r) => String(r.values[idCol]))
    const got = (await sql.all<{ id: string }>(`select id from app.${t.table} where household_id = ? order by ${t.orderColumn}`, hh))
      .map((r) => r.id)
    const orderOk = wanted.length === got.length && wanted.every((id, i) => id === got[i])
    const label = t.table === 'sale_line' ? '紐付けた順' : '消込の順'
    out.push({ name: `${label}（${t.table}）が SQLite の rowid 順のまま`, ok: orderOk, detail: `${got.length} 行` })
  }

  // 2. まとめ売りの按分：1 点あたりの合計が、販売の価格・粗利と 1 円も違わない
  const bad = await sql.get<{ n: number }>(
    `select count(*)::integer as n
       from app.sale_profit p
       join (select sale_id, sum(price_share)::integer as sp, sum(profit_share)::integer as pf
               from app.sale_line_share group by sale_id) s on s.sale_id = p.id
      where s.sp <> p.price or s.pf <> p.gross_profit`,
  )
  out.push({ name: '按分した 1 点あたりの売上・粗利の合計が、販売の価格・粗利と一致', ok: (bad?.n ?? -1) === 0, detail: `ずれた販売 ${bad?.n ?? '?'} 件` })

  // 3. 滞留日数：日本時間の今日 − 仕入日（SQLite の値とは比べない。時刻帯と日付の変わり目に依るため）
  const today = (await sql.get<{ d: string }>("select to_char((now() at time zone 'Asia/Tokyo')::date, 'YYYY-MM-DD') as d"))?.d ?? ''
  const wrongAging = inventoryView.filter((r) => r.aging_days !== daysBetween(today, String(r.acquired_at))).length
  out.push({ name: '在庫の滞留日数が、日本時間の今日 − 仕入日と一致', ok: wrongAging === 0, detail: `基準日 ${today}、ずれた在庫 ${wrongAging} 件` })

  // 4. 在庫コードの採番：これから発行する S-xxxx が、移した在庫のコードとぶつからない
  const items = data.tables.find((t) => t.table === 'inventory_item')
  const codeCol = items ? items.columns.indexOf('item_code') : -1
  const maxCode = items
    ? items.rows.reduce((m, r) => Math.max(m, Number(/^S-(\d+)$/.exec(String(r.values[codeCol]))?.[1] ?? 0)), 0)
    : 0
  const seqRow = await sql.get<{ value: string }>("select value from app.setting where household_id = ? and key = 'item_code_seq'", hh)
  const seq = Number(seqRow?.value)
  out.push({
    name: '在庫コードの採番（item_code_seq）が、移した在庫のコードの最大以上',
    ok: Number.isInteger(seq) && seq >= maxCode,
    detail: `採番 ${Number.isFinite(seq) ? seq : '?'}、在庫コードの最大 ${maxCode}`,
  })

  return out
}
