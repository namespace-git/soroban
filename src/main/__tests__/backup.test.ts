import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

// backup.ts・db.ts は electron（app.getPath 等）に依存する。:memory: ではなくファイルDBを
// 使うテストなので、パスは自前で組み立てて initDb() に渡す（app.getPath は使わせない）
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '9.9.9' },
}))

import * as db from '../db'
import * as backup from '../backup'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'soroban-backup-'))
})

afterEach(() => {
  try {
    db.closeDb()
  } catch {
    // 既に閉じていてもよい
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('writeBackupZip / readBackupZip', () => {
  it('zip に soroban.db・thumbs・meta.json が入り、readBackupZip で読める', () => {
    const dbPath = join(tmpDir, 'soroban.db')
    db.initDb(dbPath)
    const methodCount = (db.getDb().prepare('SELECT COUNT(*) AS c FROM shipping_method').get() as { c: number }).c
    expect(methodCount).toBeGreaterThan(0)

    const thumbsDir = join(tmpDir, 'thumbs')
    mkdirSync(thumbsDir, { recursive: true })
    writeFileSync(join(thumbsDir, 'm111.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    writeFileSync(join(thumbsDir, 'm222.jpg'), Buffer.from([0xff, 0xd8, 0xff]))

    // 実際の運用と同じく、DBのバックアップAPIで整合したコピーを取ってから zip に入れる
    const snapshotPath = join(tmpDir, 'snapshot.db')
    return db.getDb().backup(snapshotPath).then(() => {
      const outZip = join(tmpDir, 'out.zip')
      backup.writeBackupZip(outZip, {
        dbPath: snapshotPath,
        thumbsDir,
        meta: { app: 'soroban', version: '1.2.3', schema_version: 22 },
      })

      const parsed = backup.readBackupZip(outZip)
      expect(parsed.hasDb).toBe(true)
      expect(parsed.hasThumbs).toBe(true)
      expect(parsed.legacyDb).toBe(false)
      expect(parsed.meta).toEqual({ app: 'soroban', version: '1.2.3', schema_version: 22 })

      // zip内の soroban.db を取り出して開き直せる。件数が元と一致する
      const zip = new AdmZip(outZip)
      const extractedPath = join(tmpDir, 'extracted.db')
      writeFileSync(extractedPath, zip.getEntry('soroban.db')!.getData())

      db.closeDb()
      db.initDb(extractedPath)
      const extractedCount = (db.getDb().prepare('SELECT COUNT(*) AS c FROM shipping_method').get() as { c: number }).c
      expect(extractedCount).toBe(methodCount)
    })
  })

  it('thumbsDir が無ければ hasThumbs は false', () => {
    const dbPath = join(tmpDir, 'soroban.db')
    db.initDb(dbPath)
    const snapshotPath = join(tmpDir, 'snapshot.db')
    return db.getDb().backup(snapshotPath).then(() => {
      const outZip = join(tmpDir, 'out-no-thumbs.zip')
      backup.writeBackupZip(outZip, {
        dbPath: snapshotPath,
        thumbsDir: join(tmpDir, 'no-such-thumbs-dir'),
        meta: { app: 'soroban', version: '1.2.3' },
      })
      const parsed = backup.readBackupZip(outZip)
      expect(parsed.hasDb).toBe(true)
      expect(parsed.hasThumbs).toBe(false)
    })
  })

  it('.db 単体（旧形式）を渡すと legacyDb: true', () => {
    const dbPath = join(tmpDir, 'legacy.db')
    db.initDb(dbPath)
    db.closeDb()

    const parsed = backup.readBackupZip(dbPath)
    expect(parsed.legacyDb).toBe(true)
    expect(parsed.hasDb).toBe(true)
    expect(parsed.hasThumbs).toBe(false)
    expect(parsed.meta).toBeNull()
  })

  it('zipでもsoroban.dbでもないファイルは全部falseで返す（例外を投げない）', () => {
    const junkPath = join(tmpDir, 'junk.txt')
    writeFileSync(junkPath, 'これはzipでもdbでもない')
    const parsed = backup.readBackupZip(junkPath)
    expect(parsed).toEqual({ hasDb: false, hasThumbs: false, meta: null, legacyDb: false })
  })

  it('存在しないファイルでも例外を投げない', () => {
    const parsed = backup.readBackupZip(join(tmpDir, 'not-exists.zip'))
    expect(parsed).toEqual({ hasDb: false, hasThumbs: false, meta: null, legacyDb: false })
  })
})
