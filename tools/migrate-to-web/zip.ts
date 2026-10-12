import AdmZip from 'adm-zip'
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPlainFileName } from './images'

// デスクトップ版の「バックアップ」の zip を、一時フォルダに取り出す（src/main/backup.ts の writeBackupZip の形）。
//   soroban.db  … SQLite（整合済みのコピー）
//   thumbs/*    … 画像
//   meta.json   … バージョンなど（中身は使わない。app が違うときだけ断る）
// zip は信用しない：../ や絶対パスを含む項目が 1 つでもあれば全体を断る。取り出すのは soroban.db と thumbs/ 直下のファイル
// だけで、ほかは何も書かない。中のスクリプトは実行しない（書きもしない）。一時フォルダは cleanup() で消す

/** zip が使えない。message は利用者にそのまま見せてよい（zip の中身は出さない） */
export class BackupZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupZipError'
  }
}

/** 取り出す大きさの上限（宣言された展開後の合計）。zip 爆弾でメモリとディスクを食われないように */
export const MAX_EXTRACT_BYTES = 2 * 1024 ** 3

const SQLITE_HEADER = 'SQLite format 3\u0000'

export interface ExtractedBackup {
  /** 取り出した先（この道具が作った一時フォルダ） */
  dir: string
  sqliteFile: string
  imagesDir: string
  /** 取り出した画像の数 */
  imageFiles: number
  /** thumbs/ の中で、普通のファイル名でないため取り出さなかった項目の数 */
  skippedEntries: number
  /** 一時フォルダを消す。何度呼んでもよい */
  cleanup(): void
}

export interface ExtractOptions {
  /** 一時フォルダを作る場所。既定は OS の一時フォルダ */
  tmpRoot?: string
  maxBytes?: number
}

/** 項目名が危ない（フォルダの外を指す）理由。安全なら null */
export function unsafeEntryReason(name: string): string | null {
  if (name.includes('\0')) return '名前に NUL が入っている'
  if (name.startsWith('/') || name.startsWith('\\')) return '絶対パス'
  if (/^[A-Za-z]:/.test(name)) return 'ドライブ名つきの絶対パス'
  if (name.split(/[\\/]/).some((segment) => segment === '..')) return '親のフォルダへ出る（..）'
  return null
}

/** 画面に出す項目名。長さを切り、制御文字を外す（zip の中身が画面を乱さないように） */
function showName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f]/g, '?')
  return JSON.stringify(flat.length > 60 ? `${flat.slice(0, 60)}…` : flat)
}

function readHead(file: string, length: number): Buffer {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    throw new BackupZipError(`バックアップの zip を開けません: ${file}`)
  }
  try {
    const buf = Buffer.alloc(length)
    return buf.subarray(0, readSync(fd, buf, 0, length, 0))
  } finally {
    closeSync(fd)
  }
}

/**
 * zip を一時フォルダに取り出す。失敗したら一時フォルダを消して投げる。
 * 成功したら呼び出し側が cleanup() を呼ぶ（終わりに必ず）
 */
export function extractBackupZip(zipFile: string, options: ExtractOptions = {}): ExtractedBackup {
  try {
    if (!statSync(zipFile).isFile()) throw new Error('not a file')
  } catch {
    throw new BackupZipError(`バックアップの zip が見つかりません: ${zipFile}`)
  }
  const head = readHead(zipFile, 4)
  if (head.toString('latin1') === SQLITE_HEADER.slice(0, 4)) {
    throw new BackupZipError('これは zip ではなく SQLite のファイルです。バックアップの zip をそのまま渡すか、soroban.db と thumbs のフォルダを渡してください')
  }
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
    throw new BackupZipError('zip として読めません（zip のファイルではありません）')
  }

  let entries: AdmZip.IZipEntry[]
  try {
    // 項目の一覧は getEntries で初めて読まれる（壊れた zip・名前が重なる zip はここで投げる）
    entries = new AdmZip(zipFile).getEntries()
  } catch {
    throw new BackupZipError('zip として読めません（壊れているか、同じ名前の項目が重なっています）')
  }

  // 1. 危ない項目が 1 つでもあれば、全体を断る（取り出す・取り出さないに関わらず）
  for (const entry of entries) {
    const reason = unsafeEntryReason(entry.entryName)
    if (reason) {
      throw new BackupZipError(`zip の中に危ない項目があります（${reason}）: ${showName(entry.entryName)}。何も取り出さずに止めました`)
    }
  }

  const named = entries.map((entry) => ({ entry, name: entry.entryName.replace(/\\/g, '/') }))

  // 2. バックアップの印（あれば）
  const meta = named.find((n) => n.name === 'meta.json' && !n.entry.isDirectory)
  if (meta) {
    let app: unknown
    try {
      app = (JSON.parse(meta.entry.getData().toString('utf8')) as { app?: unknown }).app
    } catch {
      app = undefined // 読めない meta.json は無視（ほかが揃っていれば使える）
    }
    if (app !== undefined && app !== 'soroban') throw new BackupZipError('そろばんのバックアップではないようです（meta.json の app が違います）')
  }

  // 3. 必要なもの：soroban.db と thumbs/ 直下のファイル
  const dbEntries = named.filter((n) => n.name === 'soroban.db' && !n.entry.isDirectory)
  if (dbEntries.length === 0) throw new BackupZipError('zip にデータベース（soroban.db）が見つかりません。デスクトップ版の「バックアップ」で作った zip を渡してください')
  if (dbEntries.length > 1) throw new BackupZipError('zip に soroban.db が複数あります。どれを使うか決められないので止めました')

  let skippedEntries = 0
  const images: Array<{ file: string; entry: AdmZip.IZipEntry }> = []
  for (const { entry, name } of named) {
    if (!name.startsWith('thumbs/') || entry.isDirectory) continue
    const file = name.slice('thumbs/'.length)
    if (isPlainFileName(file)) images.push({ file, entry })
    else skippedEntries++
  }

  const declared = dbEntries[0].entry.header.size + images.reduce((sum, i) => sum + i.entry.header.size, 0)
  const maxBytes = options.maxBytes ?? MAX_EXTRACT_BYTES
  if (declared > maxBytes) {
    throw new BackupZipError(`zip の中身が大きすぎます（展開後 ${(declared / 1024 ** 2).toFixed(0)} MB。上限 ${(maxBytes / 1024 ** 2).toFixed(0)} MB）`)
  }

  // 4. 一時フォルダに書く（自分だけが読める場所。帳簿が丸ごと入る）
  const dir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'soroban-web-migrate-'))
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // 消せなかったときは、フォルダの場所を言うのは呼び出し側（ここでは落とさない）
    }
  }
  try {
    const sqliteFile = join(dir, 'soroban.db')
    const imagesDir = join(dir, 'thumbs')
    mkdirSync(imagesDir)

    let dbData: Buffer
    try {
      dbData = dbEntries[0].entry.getData()
    } catch {
      throw new BackupZipError('zip の中の soroban.db を読めません（壊れているようです）')
    }
    if (dbData.subarray(0, SQLITE_HEADER.length).toString('latin1') !== SQLITE_HEADER) {
      throw new BackupZipError('zip の中の soroban.db が SQLite のファイルではありません')
    }
    writeFileSync(sqliteFile, dbData, { mode: 0o600 })

    for (const { file, entry } of images) {
      let data: Buffer
      try {
        data = entry.getData()
      } catch {
        throw new BackupZipError(`zip の中の画像を読めません（壊れているようです）: ${showName(file)}`)
      }
      writeFileSync(join(imagesDir, file), data, { mode: 0o600 })
    }
    return { dir, sqliteFile, imagesDir, imageFiles: images.length, skippedEntries, cleanup }
  } catch (e) {
    cleanup()
    throw e
  }
}
