import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { fromPglite, type PgliteSql } from '../../db/pglite'
import type { ImageSource, ImageUploader } from '../../../tools/migrate-to-web/images'
import { VIEW_NAMES, type Row, type SourceSnapshot } from '../../../tools/migrate-to-web/types'
import { loadFixture, type Fixture } from '../views/helpers'

// データ移行ツールのテスト用の道具。
// 見本（views/fixtures/expected.json）は、SQLite（いまの帳簿）に db.ts の関数で見本を入れて書き出した
// 「表の中身」と「5 本のビューの出力」。ここではそれを、道具が読む SourceSnapshot の形にする

export { loadFixture }
export type { Fixture }

export function db(pg: PGlite): PgliteSql {
  return fromPglite(pg)
}

/** Supabase Auth のユーザーと、世帯（初期データつき）を作る。接続したロール（テーブルの持ち主）で */
export async function createHouseholdFor(pg: PGlite, name: string): Promise<{ householdId: string; userId: string }> {
  const userId = randomUUID()
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [userId, `${userId}@example.test`])
  const r = await pg.query<{ id: string }>('select app.create_household($1, $2::uuid[]) as id', [name, [userId]])
  return { householdId: r.rows[0].id, userId }
}

/** 見本 → SourceSnapshot（デスクトップ版の最新のスキーマで読んだ形）。tables を足したり差し替えたりできる */
export function snapshotFromFixture(
  fx: Fixture,
  patch: { tables?: Record<string, Row[]>; skippedTables?: Record<string, number>; schemaVersion?: number | null } = {},
): SourceSnapshot {
  const views = Object.fromEntries(VIEW_NAMES.map((v) => [v, structuredClone(fx.views[v])])) as SourceSnapshot['views']
  return {
    tables: { ...structuredClone(fx.tables), ...(patch.tables ?? {}) },
    views,
    skippedTables: patch.skippedTables ?? {},
    unknownTables: {},
    schemaVersion: patch.schemaVersion === undefined ? 34 : patch.schemaVersion,
  }
}

const UUID_IN_TEXT = /([0-9a-f]{8})(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g
let remapSeed = 0

/**
 * 全部の uuid の先頭 8 桁を置き換えた写し。主キー（id）は世帯をまたいで一意なので、同じ見本を別の世帯に
 * 移すには id を変える必要がある。prefix を省くと、呼ぶたびに別の値になる
 */
export function remapSnapshot(snapshot: SourceSnapshot, prefix?: string): SourceSnapshot {
  const p = prefix ?? (0xc0000000 + ++remapSeed).toString(16)
  return JSON.parse(JSON.stringify(snapshot).replace(UUID_IN_TEXT, `${p}$2`)) as SourceSnapshot
}

/** 数えるだけの id（出力を読みやすく、試験を再現できるように）。uuid の形 */
export function sequentialIds(): () => string {
  let n = 0
  return () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

/** メモリ上の画像置き場。files = ファイル名 → 大きさ（バイト）。read は大きさ分の 0 を返す */
export function memoryImages(files: Record<string, number>): ImageSource & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async stat(name) {
      return name in files ? { size: files[name] } : null
    },
    async read(name) {
      reads.push(name)
      return new Uint8Array(files[name] ?? 0)
    },
  }
}

/** 置いたものを覚えるだけの偽物（通信しない）。failAt を入れると、n 件目で失敗する */
export function recordingUploader(options: { failAt?: number } = {}): ImageUploader & {
  uploaded: Array<{ bucket: string; path: string; contentType: string; size: number }>
  removed: Array<{ bucket: string; paths: string[] }>
} {
  const uploaded: Array<{ bucket: string; path: string; contentType: string; size: number }> = []
  const removed: Array<{ bucket: string; paths: string[] }> = []
  return {
    uploaded,
    removed,
    async upload(item) {
      if (options.failAt !== undefined && uploaded.length + 1 === options.failAt) throw new Error('保存に失敗（試験）')
      uploaded.push({ bucket: item.bucket, path: item.path, contentType: item.contentType, size: item.bytes.byteLength })
    },
    async remove(bucket, paths) {
      removed.push({ bucket, paths })
    },
  }
}

/** 見本の画像のファイル名（thumb_file など）を全部ある扱いにした置き場 */
export function imagesForFixture(fx: Fixture, extra: Record<string, number> = {}): ReturnType<typeof memoryImages> {
  const files: Record<string, number> = { ...extra }
  const add = (table: string, col: string): void => {
    for (const r of fx.tables[table] ?? []) if (typeof r[col] === 'string' && r[col] !== '') files[r[col] as string] = 1234
  }
  add('sale', 'thumb_file')
  add('listing', 'thumb_file')
  add('purchase_line', 'image_file')
  add('product_image', 'file')
  add('expense', 'receipt_file')
  return memoryImages(files)
}
