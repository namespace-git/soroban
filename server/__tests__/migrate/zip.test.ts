import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupZipError, extractBackupZip, unsafeEntryReason } from '../../../tools/migrate-to-web/zip'

// バックアップの zip を、そのまま受ける。zip は信用しない（../ や絶対パスを含む項目は全体を断る）。
// 危ない名前の zip は adm-zip で作ると名前を直されることがあるので、生のバイト列から組み立てる

const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.from('rest-of-database')])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 名前をそのまま持つ zip（無圧縮）を組み立てる */
function rawZip(entries: Array<{ name: string; data?: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = e.data ?? Buffer.alloc(0)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // 名前は UTF-8
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

let work: string
let tmpRoot: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'soroban-zip-test-'))
  // 取り出し先の親。空のまま使い、「失敗したら何も残らない」を readdirSync で確かめる
  tmpRoot = join(work, 'tmp')
  mkdirSync(tmpRoot)
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

function writeZip(name: string, bytes: Buffer): string {
  const file = join(work, name)
  writeFileSync(file, bytes)
  return file
}

/** バックアップの形（src/main/backup.ts の writeBackupZip と同じ）の zip を adm-zip で作る */
function backupZip(options: { thumbs?: Record<string, string>; meta?: object | null; db?: Buffer | null } = {}): string {
  const zip = new AdmZip()
  if (options.db !== null) zip.addFile('soroban.db', options.db ?? SQLITE)
  for (const [name, text] of Object.entries(options.thumbs ?? { 'a.jpg': 'AAA', 'b.png': 'BBBB' })) {
    zip.addFile(`thumbs/${name}`, Buffer.from(text))
  }
  if (options.meta !== null) zip.addFile('meta.json', Buffer.from(JSON.stringify(options.meta ?? { app: 'soroban', schema_version: 34 })))
  const file = join(work, 'backup.zip')
  zip.writeZip(file)
  return file
}

describe('zip の取り出し', () => {
  it('soroban.db と thumbs/ の中身を一時フォルダに取り出し、cleanup で消える', () => {
    const out = extractBackupZip(backupZip(), { tmpRoot })
    expect(out.imageFiles).toBe(2)
    expect(out.skippedEntries).toBe(0)
    expect(readFileSync(out.sqliteFile).equals(SQLITE)).toBe(true)
    expect(readFileSync(join(out.imagesDir, 'a.jpg'), 'utf8')).toBe('AAA')
    expect(readFileSync(join(out.imagesDir, 'b.png'), 'utf8')).toBe('BBBB')
    expect(out.dir.startsWith(tmpRoot)).toBe(true)
    // meta.json など、使わないものは書かない
    expect(readdirSync(out.dir).sort()).toEqual(['soroban.db', 'thumbs'])

    out.cleanup()
    expect(existsSync(out.dir)).toBe(false)
    out.cleanup() // 何度呼んでもよい
  })

  it('thumbs/ が無い zip でも取り出せる（画像 0 枚）', () => {
    const out = extractBackupZip(backupZip({ thumbs: {} }), { tmpRoot })
    expect(out.imageFiles).toBe(0)
    expect(readdirSync(out.imagesDir)).toEqual([])
    out.cleanup()
  })

  it('thumbs/ の中の普通でない名前（入れ子・隠しファイル）は取り出さず、数だけ言う', () => {
    const file = writeZip('odd.zip', rawZip([
      { name: 'soroban.db', data: SQLITE },
      { name: 'thumbs/ok.jpg', data: Buffer.from('ok') },
      { name: 'thumbs/sub/nested.jpg', data: Buffer.from('n') },
      { name: 'thumbs/.hidden', data: Buffer.from('h') },
      { name: 'run.bat', data: Buffer.from('echo evil') },
      { name: 'evil.js', data: Buffer.from('process.exit(1)') },
    ]))
    const out = extractBackupZip(file, { tmpRoot })
    expect(out.imageFiles).toBe(1)
    expect(out.skippedEntries).toBe(2)
    expect(readdirSync(out.imagesDir)).toEqual(['ok.jpg'])
    // 中のスクリプトは書き出さない（実行もしない）
    expect(readdirSync(out.dir).sort()).toEqual(['soroban.db', 'thumbs'])
    out.cleanup()
  })

  it('../ や絶対パスを含む項目が 1 つでもあれば、全体を断る（何も書かず、一時フォルダも残さない）', () => {
    const bad = ['../evil.txt', 'thumbs/../../evil.txt', '/etc/passwd', '\\evil.txt', 'C:\\evil.txt', 'c:/evil.txt', 'thumbs\\..\\..\\evil.txt', 'a/../../x']
    for (const name of bad) {
      const file = writeZip('bad.zip', rawZip([
        { name: 'soroban.db', data: SQLITE },
        { name, data: Buffer.from('boom') },
      ]))
      expect(() => extractBackupZip(file, { tmpRoot }), name).toThrow(BackupZipError)
      expect(() => extractBackupZip(file, { tmpRoot }), name).toThrow(/危ない項目/)
      expect(readdirSync(tmpRoot), `${name} の後に一時フォルダが残った`).toEqual([])
      expect(existsSync(join(work, 'evil.txt'))).toBe(false)
    }
  })

  it('危ない名前の判定（項目名の途中の .. や . で始まる名前は危なくない）', () => {
    expect(unsafeEntryReason('soroban.db')).toBeNull()
    expect(unsafeEntryReason('thumbs/a..b.jpg')).toBeNull()
    expect(unsafeEntryReason('thumbs/..hidden')).toBeNull()
    expect(unsafeEntryReason('..')).not.toBeNull()
    expect(unsafeEntryReason('thumbs/../x')).not.toBeNull()
    expect(unsafeEntryReason('a\0b')).not.toBeNull()
    expect(unsafeEntryReason('/abs')).not.toBeNull()
    expect(unsafeEntryReason('Z:x')).not.toBeNull()
  })

  it('エラーの文に、zip の中の長い名前や制御文字をそのまま出さない', () => {
    const name = `../${'x'.repeat(200)}\u0007`
    const file = writeZip('bad.zip', rawZip([{ name, data: Buffer.from('b') }]))
    try {
      extractBackupZip(file, { tmpRoot })
      expect.unreachable()
    } catch (e) {
      const message = (e as Error).message
      expect(message.length).toBeLessThan(250)
      expect(message).not.toContain('\u0007')
    }
  })

  it('soroban.db が無い・SQLite でない・同じ名前が重なっている zip は断る', () => {
    expect(() => extractBackupZip(backupZip({ db: null }), { tmpRoot })).toThrow(/soroban\.db.*見つかりません/)
    expect(() => extractBackupZip(backupZip({ db: Buffer.from('not sqlite at all') }), { tmpRoot })).toThrow(/SQLite のファイルではありません/)
    const dup = writeZip('dup.zip', rawZip([
      { name: 'soroban.db', data: SQLITE },
      { name: 'soroban.db', data: SQLITE },
    ]))
    expect(() => extractBackupZip(dup, { tmpRoot })).toThrow(BackupZipError)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('そろばん以外のバックアップ（meta.json の app が違う）は断る。meta.json が壊れていても、ほかが揃っていれば使える', () => {
    expect(() => extractBackupZip(backupZip({ meta: { app: 'other' } }), { tmpRoot })).toThrow(/そろばんのバックアップではない/)
    const broken = writeZip('broken-meta.zip', rawZip([
      { name: 'soroban.db', data: SQLITE },
      { name: 'meta.json', data: Buffer.from('{not json') },
    ]))
    const out = extractBackupZip(broken, { tmpRoot })
    expect(out.imageFiles).toBe(0)
    out.cleanup()
  })

  it('zip でないファイル・存在しないファイル・SQLite のファイルそのものは、わかる言葉で断る', () => {
    expect(() => extractBackupZip(join(work, 'nope.zip'), { tmpRoot })).toThrow(/見つかりません/)
    expect(() => extractBackupZip(writeZip('text.zip', Buffer.from('hello world')), { tmpRoot })).toThrow(/zip として読めません/)
    expect(() => extractBackupZip(writeZip('soroban.db', SQLITE), { tmpRoot })).toThrow(/zip ではなく SQLite/)
    expect(() => extractBackupZip(work, { tmpRoot })).toThrow(BackupZipError)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('展開後の大きさが上限を超える zip は断る（zip 爆弾）', () => {
    const file = backupZip({ thumbs: { 'a.jpg': 'x'.repeat(5000) } })
    expect(() => extractBackupZip(file, { tmpRoot, maxBytes: 1000 })).toThrow(/大きすぎます/)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('壊れた中身（CRC が合わない）は、一時フォルダを残さずに断る', () => {
    const bytes = rawZip([{ name: 'soroban.db', data: SQLITE }])
    // データ部分を 1 バイト書き換える（CRC が合わなくなる）
    const at = bytes.indexOf(Buffer.from('rest-of-database'))
    bytes[at] ^= 0xff
    expect(() => extractBackupZip(writeZip('crc.zip', bytes), { tmpRoot })).toThrow(BackupZipError)
    expect(readdirSync(tmpRoot)).toEqual([])
  })
})
