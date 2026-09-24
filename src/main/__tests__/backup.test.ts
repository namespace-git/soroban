import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'

// backup.ts・db.ts は electron（app.getPath 等）に依存する。:memory: ではなくファイルDBを
// 使うテストなので、DBのパスは自前で組み立てて initDb() に渡す（app.getPath('userData') は
// 使わせない）。ただし自動バックアップは userData・temp を使うので、beforeEach で
// mockPaths.dir を tmpDir に差し替える（vi.mock はホイストされるので vi.hoisted 経由で共有する）
const mockPaths = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' || name === 'temp' ? mockPaths.dir : ''),
    getVersion: () => '9.9.9',
  },
  shell: { openPath: vi.fn(async () => '') },
}))

import * as db from '../db'
import * as backup from '../backup'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'soroban-backup-'))
  mockPaths.dir = tmpDir
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

describe('自動バックアップ（runAutoBackup / getAutoBackupStatus）', () => {
  function setupDb(): void {
    db.initDb(join(tmpDir, 'soroban.db'))
  }

  it('前回から7日未満なら取らない。7日以上たっていれば取る', async () => {
    setupDb()

    const first = await backup.runAutoBackup(false)
    expect(first).not.toBe('')
    expect(backup.getAutoBackupStatus().files).toHaveLength(1)
    expect(backup.getAutoBackupStatus().last_at).not.toBeNull()

    // 直後にもう一度呼んでも、7日たっていないので取らない
    const second = await backup.runAutoBackup(false)
    expect(second).toBe('')
    expect(backup.getAutoBackupStatus().files).toHaveLength(1)

    // 前回日時を8日前にすると取る
    db.setSetting('auto_backup_last_at', new Date(Date.now() - 8 * 86400000).toISOString())
    const third = await backup.runAutoBackup(false)
    expect(third).not.toBe('')
  })

  it('force なら間隔・設定を無視して必ず取り、取れたファイルのパスを返す', async () => {
    setupDb()
    db.setSetting('auto_backup', '0') // 切でも force は取る
    const p = await backup.runAutoBackup(true)
    expect(p).not.toBe('')
    expect(backup.getAutoBackupStatus().files).toHaveLength(1)
  })

  it('auto_backup が切なら force でないときは取らない', async () => {
    setupDb()
    db.setSetting('auto_backup', '0')
    const r = await backup.runAutoBackup(false)
    expect(r).toBe('')
    expect(backup.getAutoBackupStatus().files).toHaveLength(0)
    expect(backup.getAutoBackupStatus().enabled).toBe(false)
  })

  it('5世代を超えたら古いものから消える（6本のうち5本残る）', async () => {
    setupDb()
    const dir = join(tmpDir, 'backups')
    mkdirSync(dir, { recursive: true })
    // あらかじめ古い5本を置いておく（ファイル名の日時が古い順）
    const oldNames = [
      'soroban-backup-20200101-0000.zip',
      'soroban-backup-20200102-0000.zip',
      'soroban-backup-20200103-0000.zip',
      'soroban-backup-20200104-0000.zip',
      'soroban-backup-20200105-0000.zip',
    ]
    for (const name of oldNames) {
      writeFileSync(join(dir, name), 'dummy')
    }

    // force で6本目（今日の日付）を作る → 5本を超えるので、一番古い20200101が消える
    const created = await backup.runAutoBackup(true)
    expect(created).not.toBe('')

    const status = backup.getAutoBackupStatus()
    expect(status.files).toHaveLength(5)
    expect(status.files.some(f => f.name === 'soroban-backup-20200101-0000.zip')).toBe(false)
    // 新しく作った分が一番新しい（先頭）に来る
    expect(status.files[0].name).toBe(basename(created))
  })

  it('setAutoBackupEnabled で入切を切り替えられる', () => {
    setupDb()
    expect(backup.getAutoBackupStatus().enabled).toBe(true)
    backup.setAutoBackupEnabled(false)
    expect(backup.getAutoBackupStatus().enabled).toBe(false)
    backup.setAutoBackupEnabled(true)
    expect(backup.getAutoBackupStatus().enabled).toBe(true)
  })

  it('maybeRunAutoBackup は例外を投げない（DB未初期化でも）', async () => {
    await expect(backup.maybeRunAutoBackup()).resolves.toBeUndefined()
  })

  it('openBackupFolder はフォルダが無ければ作ってから開く', async () => {
    setupDb()
    const dir = join(tmpDir, 'backups')
    expect(existsSync(dir)).toBe(false)
    await backup.openBackupFolder()
    expect(existsSync(dir)).toBe(true)
  })
})
