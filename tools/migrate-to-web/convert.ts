import { randomUUID } from 'node:crypto'
import { toDateString, toInstant, shapeOf } from './dates'
import { IMAGE_COLUMNS, type ImagePlan } from './images'
import { skippedSettingReason, TABLE_SPECS, type TableSpec } from './spec'
import type { Row, SourceSnapshot } from './types'

// SQLite の行 → Postgres の行（純粋な変換。DB には触らない）。
// 列の型は Postgres のスキーマから渡される（ColumnInfoMap）。型に合わない値は、止めて理由を言う
// （黙って丸めない・推測で埋めない）。直した値は notes に数える

export interface ColumnInfo {
  /** information_schema.columns.data_type（'uuid' / 'integer' / 'date' / 'timestamp with time zone' / 'jsonb' / 'ARRAY' / 'text' …） */
  type: string
  nullable: boolean
}
export type ColumnInfoMap = Map<string, ColumnInfo>

export interface ConvertedTable {
  /** Postgres の表名 */
  table: string
  /** 行を指す列（Postgres 側） */
  key: string[]
  /** 書く列（Postgres 側）。values はこの順 */
  columns: string[]
  rows: ConvertedRow[]
  /** 並びを identity の番号で持つ表の、その列（spec.orderColumn）。1 行ずつ、rows の順に入れる */
  orderColumn?: string
}

export interface ConvertedRow {
  values: unknown[]
  /** エラー表示用の行の名前（id や型番。商品名などは入れない） */
  label: string
}

export interface ConvertedData {
  tables: ConvertedTable[]
  /** 出品の uuid。SQLite の listing は主キーが商品 ID だったので、Postgres 側で振る（SQLite の商品 ID → uuid） */
  listingIds: Map<string, string>
  /** 移した設定（キー → 値）と、移さなかったキー（理由つき。値は持たない） */
  settings: { migrated: Map<string, string>; skipped: { key: string; reason: string }[] }
  /** 値を直した件数（'表.列: 内容' → 件数）。レポートに出す */
  notes: Map<string, number>
  /** 画像が見つからず、行ごと移さなかった数（表 → 件数） */
  droppedRows: Map<string, number>
}

export interface ConvertContext {
  columns(table: string): ColumnInfoMap
  images: ImagePlan
  newId?: () => string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function convertSnapshot(snapshot: Pick<SourceSnapshot, 'tables'>, ctx: ConvertContext): ConvertedData {
  const newId = ctx.newId ?? randomUUID
  const notes = new Map<string, number>()
  const droppedRows = new Map<string, number>()
  const note = (key: string): void => void notes.set(key, (notes.get(key) ?? 0) + 1)

  // 出品の uuid（listing_line が参照する）
  const listingIds = new Map<string, string>()
  for (const row of snapshot.tables.listing ?? []) {
    const itemId = row.mercari_item_id
    if (typeof itemId !== 'string' || itemId === '') throw new Error('listing.mercari_item_id が空の出品があります')
    if (listingIds.has(itemId)) throw new Error('listing.mercari_item_id が重複しています')
    listingIds.set(itemId, newId())
  }

  const settings = convertSettings(snapshot.tables.setting ?? [])
  const tables: ConvertedTable[] = []

  for (const spec of TABLE_SPECS) {
    const sourceRows = snapshot.tables[spec.name] ?? []
    if (spec.name === 'setting') {
      tables.push({
        table: 'setting', key: spec.key, columns: ['key', 'value'],
        rows: [...settings.migrated].map(([k, v]) => ({ values: [k, v], label: k })),
      })
      continue
    }
    const info = ctx.columns(spec.name)
    const ordered = spec.name === 'inventory_item' ? parentsFirst(sourceRows) : sourceRows
    const converted = convertRows(spec, ordered, info, ctx.images, listingIds, note)
    if (converted.dropped > 0) droppedRows.set(spec.name, converted.dropped)
    tables.push(converted.table)
  }
  return { tables, listingIds, settings, notes, droppedRows }
}

function convertSettings(rows: Row[]): ConvertedData['settings'] {
  const migrated = new Map<string, string>()
  const skipped: { key: string; reason: string }[] = []
  for (const row of rows) {
    const key = row.key
    const value = row.value
    if (typeof key !== 'string' || key === '') throw new Error('setting.key が空の設定があります')
    const reason = skippedSettingReason(key)
    if (reason !== null) {
      skipped.push({ key, reason })
      continue
    }
    if (typeof value !== 'string') throw new Error(`setting.value が文字列ではありません（key = ${key}）`)
    migrated.set(key, value)
  }
  return { migrated, skipped }
}

/** 親（parent_id が指す在庫）が先に来るように並べる。同じ深さの中は元の順。循環していたら止める */
export function parentsFirst(rows: Row[]): Row[] {
  const byId = new Map(rows.map((r) => [String(r.id), r]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) throw new Error('inventory_item.parent_id が循環しています')
    visiting.add(id)
    const parent = byId.get(id)?.parent_id
    const d = typeof parent === 'string' && byId.has(parent) ? depthOf(parent) + 1 : 0
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  return rows
    .map((r, i) => ({ r, i, d: depthOf(String(r.id)) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.r)
}

function labelOf(spec: TableSpec, row: Row): string {
  const sourceName = (col: string): string => Object.entries(spec.renames ?? {}).find(([, to]) => to === col)?.[0] ?? col
  return spec.key.map((k) => String(row[sourceName(k)])).join(' / ')
}

function convertRows(
  spec: TableSpec,
  rows: Row[],
  info: ColumnInfoMap,
  images: ImagePlan,
  listingIds: Map<string, string>,
  note: (key: string) => void,
): { table: ConvertedTable; dropped: number } {
  const image = IMAGE_COLUMNS.find((c) => c.table === spec.name)
  const imageTarget = image ? (spec.renames?.[image.column] ?? image.column) : null
  const columns: string[] = []
  const converted: Array<{ values: Map<string, unknown>; label: string }> = []
  let dropped = 0

  const addColumn = (c: string): void => {
    if (!columns.includes(c)) columns.push(c)
  }

  for (const row of rows) {
    const label = labelOf(spec, row)
    const out = new Map<string, unknown>()
    for (const [sourceColumn, raw] of Object.entries(row)) {
      const column = spec.renames?.[sourceColumn] ?? sourceColumn
      const columnInfo = info.get(column)
      if (!columnInfo) {
        throw new Error(
          `Postgres の ${spec.name} に列 ${column}${column === sourceColumn ? '' : `（SQLite の ${sourceColumn}）`} がありません。` +
            'デスクトップ版でスキーマが増えた可能性があります（tools/migrate-to-web/spec.ts と supabase/migrations を揃えてください）',
        )
      }
      if (image && sourceColumn === image.column) {
        // ファイル名はそのまま入れず、画像の対応表の新しいパスを入れる（無い・見つからないときは null）
        const hasFile = raw !== null && raw !== undefined && raw !== ''
        out.set(column, hasFile ? images.pathFor(spec.name, String(row[image.keyColumn])) : null)
      } else if (spec.name === 'listing_line' && sourceColumn === 'listing_id') {
        // SQLite では出品の商品 ID。Postgres では listing.id（uuid）
        const id = listingIds.get(String(raw))
        if (!id) throw new Error(`listing_line が、存在しない出品を指しています（listing_line ${label}）`)
        out.set(column, id)
      } else {
        out.set(column, convertValue(spec.name, column, columnInfo, raw, label, note))
      }
      addColumn(column)
    }

    if (spec.name === 'listing') {
      out.set('id', listingIds.get(String(row.mercari_item_id)))
      addColumn('id')
    }
    if (spec.dropRowWhenImageMissing && imageTarget && out.get(imageTarget) === null) {
      dropped++
      continue
    }
    converted.push({ values: out, label })
  }

  return {
    table: {
      table: spec.name, key: spec.key, columns, orderColumn: spec.orderColumn,
      rows: converted.map((c) => ({ values: columns.map((col) => c.values.get(col) ?? null), label: c.label })),
    },
    dropped,
  }
}

/** 1 つの値を、Postgres の列の型に合わせる。合わなければ（どの表の・どの列の・どんな形か）を言って止める */
export function convertValue(
  table: string,
  column: string,
  info: ColumnInfo,
  raw: unknown,
  label: string,
  note: (key: string) => void,
): unknown {
  const where = `${table}.${column}（${label}）`
  if (raw === null || raw === undefined) {
    if (!info.nullable) throw new Error(`${where}が空です（Postgres では必須の列です）`)
    return null
  }

  switch (info.type) {
    case 'uuid': {
      if (typeof raw === 'string' && raw === '' && info.nullable) {
        note(`${table}.${column}: 空文字を null にした`)
        return null
      }
      if (typeof raw !== 'string' || !UUID.test(raw)) throw new Error(`${where}が uuid の形ではありません: ${shapeOf(raw)}`)
      return raw.toLowerCase()
    }
    case 'integer':
    case 'bigint':
    case 'smallint': {
      // 金額は円の整数。小数を丸めて入れない
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) throw new Error(`${where}が整数ではありません: ${shapeOf(raw)}`)
      return raw
    }
    case 'date': {
      if (typeof raw === 'string' && raw === '' && info.nullable) {
        note(`${table}.${column}: 空文字を null にした`)
        return null
      }
      const d = typeof raw === 'string' ? toDateString(raw) : null
      if (!d) throw new Error(`${where}が日付ではありません: ${shapeOf(raw)}`)
      if (d.coerced) note(`${table}.${column}: 日時の文字列から日付（日本時間）を取り出した`)
      return d.value
    }
    case 'timestamp with time zone': {
      if (typeof raw === 'string' && raw === '' && info.nullable) {
        note(`${table}.${column}: 空文字を null にした`)
        return null
      }
      const t = typeof raw === 'string' ? toInstant(raw) : null
      if (!t) throw new Error(`${where}が日時ではありません: ${shapeOf(raw)}`)
      if (t.coerced) note(`${table}.${column}: zone の無い日時を日本時間として UTC に直した`)
      return t.value
    }
    case 'jsonb': {
      if (typeof raw !== 'string') throw new Error(`${where}が JSON の文字列ではありません: ${shapeOf(raw)}`)
      try {
        const json = JSON.stringify(JSON.parse(raw))
        // jsonb は \u0000（NUL）を持てない
        if (json.includes('\\u0000')) throw new Error(`${where}に NUL 文字が含まれています（Postgres に入れられません）`)
        return json
      } catch (e) {
        if (e instanceof Error && e.message.startsWith(where)) throw e
        // 読めない JSON は、文字列のまま JSON の文字列として残す（中身を捨てない）
        note(`${table}.${column}: JSON として読めない文字列を JSON の文字列として入れた`)
        return JSON.stringify(raw)
      }
    }
    case 'ARRAY': {
      // model_codes のように、SQLite では JSON の文字列。Postgres では text[]
      if (typeof raw !== 'string') throw new Error(`${where}が JSON の配列の文字列ではありません: ${shapeOf(raw)}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error(`${where}が JSON として読めません: ${shapeOf(raw)}`)
      }
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
        throw new Error(`${where}が文字列の配列ではありません: ${shapeOf(raw)}`)
      }
      return parsed
    }
    case 'text': {
      const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw
      if (typeof text !== 'string') throw new Error(`${where}が文字列ではありません: ${shapeOf(raw)}`)
      // Postgres の text は NUL 文字（\0）を持てない
      if (text.includes('\u0000')) throw new Error(`${where}に NUL 文字が含まれています（Postgres に入れられません）`)
      return text
    }
    default:
      throw new Error(`${where}: 想定していない列の型です（${info.type}）。tools/migrate-to-web/convert.ts に追加してください`)
  }
}
