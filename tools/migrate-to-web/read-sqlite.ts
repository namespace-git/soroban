import Database from 'better-sqlite3'
import { SKIPPED_TABLES, TABLE_SPECS } from './spec'
import { VIEW_NAMES, type Row, type SourceSnapshot } from './types'

// SQLite（デスクトップ版の帳簿）を読む。**読み取り専用**で開く（書き換えない）。
// better-sqlite3 は Electron 向けにビルドされているので、素の Node では開けない。
// ELECTRON_RUN_AS_NODE=1 の Electron（run.mjs が起動する）で動かす。変換・書き込みはこのファイルに依らない

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

export function readSqlite(file: string): SourceSnapshot {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const names = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>)
      .map((r) => r.name)
    const have = new Set(names)

    const tables: Record<string, Row[]> = {}
    for (const spec of TABLE_SPECS) {
      // rowid の昇順＝挿入順。sale_line はこの順が「紐付けた順」（まとめ売りの端数をどの行に寄せるか）を決める
      tables[spec.name] = have.has(spec.name) ? (db.prepare(`select * from ${quote(spec.name)} order by rowid`).all() as Row[]) : []
    }

    const migrated = new Set(TABLE_SPECS.map((t) => t.name))
    const skippedTables: Record<string, number> = {}
    const unknownTables: Record<string, number> = {}
    for (const name of names) {
      if (migrated.has(name)) continue
      const rows = (db.prepare(`select count(*) as n from ${quote(name)}`).get() as { n: number }).n
      if (name in SKIPPED_TABLES) skippedTables[name] = rows
      else unknownTables[name] = rows
    }

    const views = {} as SourceSnapshot['views']
    for (const view of VIEW_NAMES) {
      if (!db.prepare("select 1 from sqlite_master where type = 'view' and name = ?").get(view)) {
        throw new Error(`SQLite にビュー ${view} がありません（デスクトップ版で一度開いて、最新にしてから使ってください）`)
      }
      views[view] = db.prepare(`select * from ${quote(view)}`).all() as Row[]
    }

    const version = tables.setting.find((r) => r.key === 'schema_version')?.value
    const schemaVersion = typeof version === 'string' && /^\d+$/.test(version) ? Number(version) : null
    return { tables, views, skippedTables, unknownTables, schemaVersion }
  } finally {
    db.close()
  }
}
