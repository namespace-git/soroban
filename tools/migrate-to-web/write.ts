import type { Sql } from '../../server/db/sql'
import type { ColumnInfoMap, ConvertedData, ConvertedRow, ConvertedTable } from './convert'
import { EMPTY_CHECK_TABLES, INITIAL_SHIPPING_METHODS, TABLE_SPECS } from './spec'

// Postgres への書き込み。呼び出し側が 1 つのトランザクション（withHouseholdRole）の中で呼ぶ。
// 世帯の文脈（soroban_api ＋ app.household_id）で書くので、RLS が他の世帯への書き込みを止める

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 世帯のトランザクション（API と同じ入り方：soroban_api に切り替えて、世帯を渡す）。fn が投げたら全部ロールバック */
export async function withHouseholdRole<T>(root: Sql, householdId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (!UUID.test(householdId)) throw new Error('世帯の id が uuid の形ではありません')
  return root.tx(async (sql) => {
    await sql.run('set local search_path = app, public')
    await sql.run('set local role soroban_api')
    await sql.get("select set_config('app.household_id', ?, true)", householdId.toLowerCase())
    return fn(sql)
  })
}

/** Postgres のスキーマから、移す表の列の型を読む */
export async function loadColumnInfo(sql: Sql): Promise<(table: string) => ColumnInfoMap> {
  const tables = TABLE_SPECS.map((t) => t.name)
  const rows = await sql.all<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    `select table_name::text as table_name, column_name::text as column_name, data_type::text as data_type, is_nullable::text as is_nullable
       from information_schema.columns
      where table_schema = 'app' and table_name::text = any(?::text[])`,
    tables,
  )
  const byTable = new Map<string, ColumnInfoMap>()
  for (const r of rows) {
    const m = byTable.get(r.table_name) ?? new Map()
    m.set(r.column_name, { type: r.data_type, nullable: r.is_nullable === 'YES' })
    byTable.set(r.table_name, m)
  }
  for (const t of tables) {
    if (!byTable.has(t)) throw new Error(`Postgres に表 app.${t} がありません（マイグレーションを流してください）`)
  }
  return (table) => byTable.get(table) as ColumnInfoMap
}

export class HouseholdNotEmptyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HouseholdNotEmptyError'
  }
}

const TABLE_LABELS: Record<string, string> = {
  sale: '販売', purchase: '仕入', inventory_item: '在庫', purchase_line: '仕入の明細', sale_line: '販売の紐付け',
  listing: '出品', expense: '経費', tag: 'タグ', shop_account: '仕入先',
}

/**
 * 書き込み先の世帯が空かを確かめる。移す表のどれかに 1 行でもあれば断る（二重に流す事故を防ぐ）。
 * 発送方法は、世帯を作ったときの初期データ（INITIAL_SHIPPING_METHODS）と同じ中身のときだけ置き換えてよい
 * （Web 版で手を入れたものを黙って消さない）。戻り値は置き換える発送方法の行数
 */
export async function assertHouseholdEmpty(sql: Sql, householdId: string): Promise<number> {
  const exists = await sql.get<{ id: string }>('select id from app.household where id = ?', householdId.toLowerCase())
  if (!exists) throw new Error('書き込み先の世帯が見つかりません（世帯の id を確かめてください）')

  const found: string[] = []
  for (const table of EMPTY_CHECK_TABLES) {
    const row = await sql.get<{ n: number }>(`select count(*)::integer as n from app.${table}`)
    if (row && row.n > 0) found.push(`${TABLE_LABELS[table] ?? table} ${row.n} 件`)
  }
  if (found.length > 0) {
    throw new HouseholdNotEmptyError(
      `書き込み先の世帯に、すでにデータがあります（${found.join('、')}）。二重に流さないよう止めました。` +
        '移行は空の世帯にだけ行えます（Web 版の画面から入れたデータがあるなら、先に消すか、新しい世帯を作ってください）',
    )
  }

  const methods = await sql.all<{ name: string; carrier: string | null; fee: number; sort_order: number; is_active: number }>(
    'select name, carrier, fee, sort_order, is_active from app.shipping_method order by sort_order, name collate "C"',
  )
  // 名前の並びは SQLite のバイト順（collate "C"）にそろえる。localeCompare は環境で変わるので使わない
  const initial = [...INITIAL_SHIPPING_METHODS].sort((a, b) => a.sort_order - b.sort_order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const same =
    methods.length === initial.length &&
    methods.every((m, i) =>
      m.name === initial[i].name && m.carrier === initial[i].carrier && m.fee === initial[i].fee &&
      m.sort_order === initial[i].sort_order && m.is_active === 1)
  if (!same && methods.length > 0) {
    throw new HouseholdNotEmptyError(
      `書き込み先の世帯の発送方法が、世帯を作ったときの初期値と違います（${methods.length} 行）。` +
        'Web 版で編集した発送方法を消してしまわないよう止めました',
    )
  }
  return methods.length
}

const PARAM_LIMIT = 30_000
const MAX_ROWS_PER_STATEMENT = 500

function castOf(type: string): string {
  switch (type) {
    case 'uuid': return '::uuid'
    case 'integer': return '::integer'
    case 'bigint': return '::bigint'
    case 'smallint': return '::smallint'
    case 'date': return '::date'
    case 'timestamp with time zone': return '::timestamptz'
    case 'jsonb': return '::jsonb'
    case 'ARRAY': return '::text[]'
    default: return ''
  }
}

const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`

export function buildInsert(table: string, columns: string[], info: ColumnInfoMap, rowCount: number, onConflict = ''): string {
  const placeholders = columns.map((c) => `?${castOf((info.get(c) as { type: string }).type)}`).join(', ')
  const rows = Array.from({ length: rowCount }, () => `(${placeholders})`).join(', ')
  return `insert into app.${table} (${columns.map(quote).join(', ')}) values ${rows}${onConflict}`
}

function wrap(table: string, label: string | null, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${table} への書き込みに失敗しました${label === null ? '' : `（${label}）`}: ${reason}`, { cause })
}

async function insertRows(
  sql: Sql, table: string, columns: string[], info: ColumnInfoMap, rows: ConvertedRow[], onConflict: string, perStatement: number,
): Promise<void> {
  const size = Math.max(1, Math.min(perStatement, Math.floor(PARAM_LIMIT / Math.max(1, columns.length))))
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    const run = (target: Sql, part: ConvertedRow[]): Promise<unknown> =>
      target.run(buildInsert(table, columns, info, part.length, onConflict), ...part.flatMap((r) => r.values))
    if (chunk.length === 1) {
      // 1 行だけなら、落ちた行がどれかは明らか（savepoint の往復も要らない）
      try {
        await run(sql, chunk)
      } catch (e) {
        throw wrap(table, chunk[0].label, e)
      }
      continue
    }
    try {
      await sql.tx((inner) => run(inner, chunk))
    } catch (e) {
      // まとめて入れて落ちた。1 行ずつ入れ直して、落ちる行を特定する（どの行かを言えるように）
      for (const row of chunk) {
        try {
          await sql.tx((inner) => run(inner, [row]))
        } catch (e2) {
          throw wrap(table, row.label, e2)
        }
      }
      // 1 行ずつなら全部通った（まれ）。chunk は入っている
    }
  }
}

export interface WriteResult {
  /** 置き換えた発送方法の行数（世帯を作ったときの初期データ） */
  replacedShippingMethods: number
  /** 上書きする前の設定（初期データ）。読み戻しの期待値に使う */
  settingsBefore: Map<string, string>
}

/**
 * 全部書く。順番は spec の順（外部キーの順）。
 * * shipping_method … 世帯の初期データを消して、SQLite の行を同じ id で入れる（sale.shipping_method_id などが SQLite の id を指す）
 * * setting … 初期値をキーで上書き（upsert）
 * * sale_line … SQLite の rowid 順に 1 行ずつ（allocation_order がこの順に振られる）
 */
export async function writeAll(
  sql: Sql, householdId: string, data: ConvertedData, columns: (table: string) => ColumnInfoMap,
): Promise<WriteResult> {
  const hh = householdId.toLowerCase()
  let replacedShippingMethods = 0
  let settingsBefore = new Map<string, string>()

  for (const t of data.tables) {
    const info = columns(t.table)
    switch (t.table) {
      case 'shipping_method': {
        const removed = await sql.run('delete from app.shipping_method where household_id = ?', hh)
        replacedShippingMethods = removed.changes
        await insertRows(sql, t.table, t.columns, info, t.rows, '', MAX_ROWS_PER_STATEMENT)
        break
      }
      case 'setting': {
        const before = await sql.all<{ key: string; value: string }>('select key, value from app.setting where household_id = ?', hh)
        settingsBefore = new Map(before.map((r) => [r.key, r.value]))
        await insertRows(sql, t.table, t.columns, info, t.rows,
          ' on conflict (household_id, key) do update set value = excluded.value', MAX_ROWS_PER_STATEMENT)
        break
      }
      default:
        // 並びを identity の番号で持つ表は 1 行ずつ。番号が、配列の順（＝SQLite の rowid 順）で振られることを保証する
        await insertRows(sql, t.table, t.columns, info, t.rows, '', t.orderColumn ? 1 : MAX_ROWS_PER_STATEMENT)
        if (t.table === 'sale_line') await restoreInventoryUpdatedAt(sql, hh, data.tables)
    }
  }
  return { replacedShippingMethods, settingsBefore }
}

/**
 * sale_line を入れると、トリガー（trg_sline_sold）が在庫の updated_at を「いま」に書き換える。
 * 在庫の updated_at は SQLite のままにしたいので、紐付いた在庫の分だけ元の値に戻す。
 * （status はトリガーが 'sold' にする。SQLite でも同じトリガーなので同じはず。違えば読み戻しの突き合わせで落ちる。
 * landed_cost には触らない）
 */
async function restoreInventoryUpdatedAt(sql: Sql, hh: string, tables: ConvertedTable[]): Promise<void> {
  const items = tables.find((t) => t.table === 'inventory_item')
  const lines = tables.find((t) => t.table === 'sale_line')
  if (!items || !lines) return
  const idCol = items.columns.indexOf('id')
  const updCol = items.columns.indexOf('updated_at')
  const itemCol = lines.columns.indexOf('inventory_item_id')
  if (idCol < 0 || updCol < 0 || itemCol < 0) return

  const updatedAt = new Map(items.rows.map((r) => [r.values[idCol] as string, r.values[updCol] as string | null]))
  const ids: string[] = []
  const stamps: string[] = []
  for (const line of lines.rows) {
    const id = line.values[itemCol] as string
    const stamp = updatedAt.get(id)
    if (stamp) {
      ids.push(id)
      stamps.push(stamp)
    }
  }
  for (let i = 0; i < ids.length; i += 1000) {
    await sql.run(
      `update app.inventory_item i set updated_at = v.u
         from unnest(?::uuid[], ?::timestamptz[]) as v(id, u)
        where i.household_id = ? and i.id = v.id`,
      ids.slice(i, i + 1000), stamps.slice(i, i + 1000), hh,
    )
  }
}
