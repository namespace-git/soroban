import { app, dialog, shell, type BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync,
  readdirSync, readSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import * as db from './db'
import * as applog from './applog'
import type { AutoBackupStatus } from '../shared/types'

// ============================================================
// バックアップ（zip）と復元
//
// DBがローカル1ファイルなので、退避手段は必ず用意しておく（CLAUDE.md）。
// zip には soroban.db（better-sqlite3 の backup API で取った整合済みコピー）・
// thumbs/（レシート画像・サムネ）・meta.json（バージョン等）を入れる。
// 不具合の報告もこのファイル1本で足りるようにする（操作ログは soroban.db の中の
// app_log テーブルに入っている）。
//
// 復元は「今のデータを退避 → 入れ替え → 再起動」。取り違いで壊しても、
// userData/backup-before-restore-<日時>/ に必ず戻せるコピーを残す。
// ============================================================

const SQLITE_HEADER = 'SQLite format 3\u0000'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** zip の既定ファイル名（例：soroban-backup-2026-09-21-1530.zip） */
function backupFileName(d: Date = new Date()): string {
  return `soroban-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.zip`
}

/** 復元前の退避フォルダ名（例：backup-before-restore-20260921-153045） */
function restoreDirName(d: Date = new Date()): string {
  return `backup-before-restore-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** ファイル先頭 length バイトを読む。開けなければ null */
function readHead(filePath: string, length: number): Buffer | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, 0)
    return buf.subarray(0, n)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function isSqliteBuffer(buf: Buffer): boolean {
  return buf.subarray(0, SQLITE_HEADER.length).toString('latin1') === SQLITE_HEADER
}

function isSqliteFile(filePath: string): boolean {
  const head = readHead(filePath, SQLITE_HEADER.length)
  return !!head && isSqliteBuffer(head)
}

function thumbsDirPath(): string {
  return join(app.getPath('userData'), 'thumbs')
}

/**
 * zip を作る（純粋。テストから直接呼べる）。dbPath は既に整合が取れたコピー
 * （db.backup() の出力等）をそのまま soroban.db として zip に入れる。
 * thumbsDir が無ければ thumbs/ は入れない。
 */
export function writeBackupZip(
  outPath: string,
  opts: { dbPath: string; thumbsDir: string; meta: object },
): void {
  const zip = new AdmZip()
  zip.addLocalFile(opts.dbPath, '', 'soroban.db')

  if (existsSync(opts.thumbsDir)) {
    const names = readdirSync(opts.thumbsDir).filter((name) => {
      try {
        return statSync(join(opts.thumbsDir, name)).isFile()
      } catch {
        return false
      }
    })
    for (const name of names) {
      zip.addLocalFile(join(opts.thumbsDir, name), 'thumbs')
    }
  }

  zip.addFile('meta.json', Buffer.from(JSON.stringify(opts.meta, null, 2), 'utf-8'))
  zip.writeZip(outPath)
}

/**
 * zip（または旧形式の .db 単体）の中身を検証する（純粋。テストから直接呼べる）。
 * 壊れている・そもそも zip でないファイルでも例外は投げず、全部 false で返す。
 */
export function readBackupZip(zipPath: string): {
  hasDb: boolean
  hasThumbs: boolean
  meta: object | null
  legacyDb: boolean
} {
  if (isSqliteFile(zipPath)) {
    return { hasDb: true, hasThumbs: false, meta: null, legacyDb: true }
  }

  try {
    const zip = new AdmZip(zipPath)
    const dbEntry = zip.getEntry('soroban.db')
    const hasDb = !!dbEntry && !dbEntry.isDirectory && isSqliteBuffer(dbEntry.getData())
    const hasThumbs = zip.getEntries().some(e => e.entryName.startsWith('thumbs/') && !e.isDirectory)

    let meta: object | null = null
    const metaEntry = zip.getEntry('meta.json')
    if (metaEntry) {
      try {
        meta = JSON.parse(metaEntry.getData().toString('utf-8'))
      } catch {
        meta = null
      }
    }

    return { hasDb, hasThumbs, meta, legacyDb: false }
  } catch {
    return { hasDb: false, hasThumbs: false, meta: null, legacyDb: false }
  }
}

/**
 * バックアップを zip で保存する。保存先を選ぶダイアログでキャンセルされたら null。
 * DB は better-sqlite3 の backup API（WAL のチェックポイントを待たずに整合したコピーが取れる）で
 * 一時ファイルに取ってから zip に入れ、終わったら一時ファイルを消す。
 */
export async function backupToZip(win: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: 'バックアップを保存',
    defaultPath: backupFileName(),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null

  const tmpDbPath = join(app.getPath('temp'), `soroban-backup-${randomUUID()}.db`)
  try {
    await db.getDb().backup(tmpDbPath)

    const settings = db.getSettings()
    const meta = {
      app: 'soroban',
      version: app.getVersion(),
      schema_version: settings.schema_version ? Number(settings.schema_version) : null,
      platform: process.platform,
      created_at: new Date().toISOString(),
    }

    writeBackupZip(result.filePath, { dbPath: tmpDbPath, thumbsDir: thumbsDirPath(), meta })
    applog.log('main', 'backup', 'バックアップを保存しました', { path: result.filePath })
    return result.filePath
  } finally {
    try {
      unlinkSync(tmpDbPath)
    } catch {
      // 一時ファイルが無い・消せない場合は無視
    }
  }
}

/** backupDir に退避した soroban.db・thumbs を dbPath・thumbsDir へ書き戻す（復元に失敗したときの後始末） */
function restoreSavedFiles(backupDir: string, dbPath: string, thumbsDir: string): void {
  try {
    const savedDb = join(backupDir, 'soroban.db')
    if (existsSync(savedDb)) copyFileSync(savedDb, dbPath)

    const savedThumbs = join(backupDir, 'thumbs')
    if (existsSync(savedThumbs)) {
      rmSync(thumbsDir, { recursive: true, force: true })
      cpSync(savedThumbs, thumbsDir, { recursive: true })
    }
  } catch (e) {
    console.error('退避したデータの復旧に失敗しました', e)
  }
}

/** dbPath 本体・-wal・-shm をまとめて消す（無ければ無視） */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix)
    } catch {
      // 無ければ無視
    }
  }
}

/** zip 内の thumbs/ をまるごと thumbsDir に展開する（既存は消してから入れ替え） */
function replaceThumbsFromZip(zip: AdmZip, thumbsDir: string): void {
  rmSync(thumbsDir, { recursive: true, force: true })
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('thumbs/')) continue
    const name = entry.entryName.slice('thumbs/'.length)
    // zip slip 対策：thumbs 直下のファイル名だけ受け付ける（サブフォルダ・親への脱出・絶対パスは捨てる）
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) continue
    const dest = join(thumbsDir, name)
    if (!dest.startsWith(thumbsDir)) continue
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, entry.getData())
  }
}

/**
 * zip（または旧形式の .db 単体）から復元する。選ぶダイアログでキャンセルなら null。
 * 確認ダイアログでキャンセルしても null。
 *
 * 手順：今の DB・thumbs を userData/backup-before-restore-<日時>/ へ退避 →
 * DB接続を閉じる → 今の soroban.db（本体・-wal・-shm）を消す → zip（または .db）の中身を置く →
 * thumbs はバックアップにあれば入れ替え（無ければ今のまま）→ 再起動。
 * 置き換えの途中で失敗したら、退避したものを戻してDBを開き直し、Errorを投げる（アプリは落とさない）。
 */
export async function restoreFromZip(win: BrowserWindow | null): Promise<{ restarting: true } | null> {
  const openOptions = {
    title: 'バックアップから復元',
    filters: [{ name: 'バックアップ', extensions: ['zip', 'db'] }],
    properties: ['openFile' as const],
  }
  const opened = win ? await dialog.showOpenDialog(win, openOptions) : await dialog.showOpenDialog(openOptions)
  if (opened.canceled || opened.filePaths.length === 0) return null
  const srcPath = opened.filePaths[0]

  const parsed = readBackupZip(srcPath)
  if (!parsed.hasDb) {
    throw new Error('選んだファイルにデータベースが見つかりません（soroban.db が無いか壊れています）')
  }
  const metaApp = (parsed.meta as { app?: string } | null)?.app
  if (metaApp !== undefined && metaApp !== 'soroban') {
    throw new Error('そろばんのバックアップではないようです')
  }

  const confirmOptions = {
    type: 'warning' as const,
    buttons: ['続ける', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    title: 'バックアップから復元',
    message: '今のデータを退避してから、バックアップの内容に置き換えます。アプリは再起動します。よろしいですか？',
  }
  const confirmed = win ? await dialog.showMessageBox(win, confirmOptions) : await dialog.showMessageBox(confirmOptions)
  if (confirmed.response !== 0) return null

  const dbPath = db.getDbPath()
  const thumbsDir = thumbsDirPath()
  const backupDir = join(app.getPath('userData'), restoreDirName())
  mkdirSync(backupDir, { recursive: true })

  // 退避（DBはまだ開いているうちにbackup APIで整合したコピーを取る）
  await db.getDb().backup(join(backupDir, 'soroban.db'))
  if (existsSync(thumbsDir)) {
    cpSync(thumbsDir, join(backupDir, 'thumbs'), { recursive: true })
  }

  applog.log('main', 'restore', '復元します', { src: srcPath, backupDir })

  try {
    db.getDb().close()
    removeDbFiles(dbPath)

    if (parsed.legacyDb) {
      copyFileSync(srcPath, dbPath)
    } else {
      const zip = new AdmZip(srcPath)
      const dbEntry = zip.getEntry('soroban.db')!
      writeFileSync(dbPath, dbEntry.getData())
      if (parsed.hasThumbs) replaceThumbsFromZip(zip, thumbsDir)
    }
  } catch (e) {
    restoreSavedFiles(backupDir, dbPath, thumbsDir)
    try {
      db.initDb()
    } catch {
      // ここでも開けなければ、次回起動時のエラーダイアログに委ねる
    }
    throw new Error(`復元に失敗しました。データは元に戻しました。\n${e instanceof Error ? e.message : String(e)}`)
  }

  app.relaunch()
  app.exit(0)
  return { restarting: true }
}

// ============================================================
// 自動バックアップ（週1回）
//
// 手動の「バックアップを保存」（backupToZip）と中身は同じ（writeBackupZip を共有）。
// 保存先は userData/backups 固定、ファイル名は日時から機械的に決め、5世代だけ残す。
// 起動を止めない・失敗させないことを最優先にする（maybeRunAutoBackup を参照）。
// ============================================================

const AUTO_BACKUP_ENABLED_KEY = 'auto_backup'
const AUTO_BACKUP_LAST_AT_KEY = 'auto_backup_last_at'
const AUTO_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const AUTO_BACKUP_GENERATIONS = 5
const AUTO_BACKUP_FILE_RE = /^soroban-backup-\d{8}-\d{4}\.zip$/

function backupsDirPath(): string {
  return join(app.getPath('userData'), 'backups')
}

/** 自動バックアップの既定ファイル名（例：soroban-backup-20260921-1530.zip） */
function autoBackupFileName(d: Date = new Date()): string {
  return `soroban-backup-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.zip`
}

function isAutoBackupEnabled(): boolean {
  return (db.getSettings()[AUTO_BACKUP_ENABLED_KEY] ?? '1') !== '0'
}

/** 自動バックアップのファイルを新しい順（ファイル名の降順＝日時の降順）で返す。無ければ空配列 */
function listAutoBackupFiles(dir: string): Array<{ name: string; size: number; created_at: string }> {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter(name => AUTO_BACKUP_FILE_RE.test(name))
  const withStat = names.map((name) => {
    const st = statSync(join(dir, name))
    return { name, size: st.size, created_at: st.mtime.toISOString() }
  })
  withStat.sort((a, b) => b.name.localeCompare(a.name))
  return withStat
}

/** 5世代を超えた古いファイルを消す。消せなくても失敗にしない */
function pruneOldAutoBackups(dir: string): void {
  const files = listAutoBackupFiles(dir)
  for (const f of files.slice(AUTO_BACKUP_GENERATIONS)) {
    try {
      unlinkSync(join(dir, f.name))
    } catch {
      // 消せなくても続行する
    }
  }
}

/** 設定・最後に取った日時・保存先・直近5本を返す */
export function getAutoBackupStatus(): AutoBackupStatus {
  const dir = backupsDirPath()
  return {
    enabled: isAutoBackupEnabled(),
    last_at: db.getSettings()[AUTO_BACKUP_LAST_AT_KEY] ?? null,
    dir,
    files: listAutoBackupFiles(dir).slice(0, AUTO_BACKUP_GENERATIONS),
  }
}

export function setAutoBackupEnabled(enabled: boolean): void {
  db.setSetting(AUTO_BACKUP_ENABLED_KEY, enabled ? '1' : '0')
}

/** バックアップの保存フォルダを OS のファイラで開く（無ければ作ってから） */
export async function openBackupFolder(): Promise<void> {
  const dir = backupsDirPath()
  mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
}

/**
 * 自動バックアップを取る。force=false（起動時のスケジュール実行）は
 * 「入」かつ前回から7日以上たっているときだけ取り、取らなかったときは '' を返す。
 * force=true（「いま取る」）は条件を無視して必ず取り、取れたファイルのパスを返す。
 * 取ったら auto_backup_last_at を更新し、5世代を超えた古いものを消す。
 */
export async function runAutoBackup(force: boolean): Promise<string> {
  if (!force) {
    if (!isAutoBackupEnabled()) return ''
    const lastAt = db.getSettings()[AUTO_BACKUP_LAST_AT_KEY]
    const elapsed = lastAt ? Date.now() - new Date(lastAt).getTime() : Infinity
    if (elapsed < AUTO_BACKUP_INTERVAL_MS) return ''
  }

  const dir = backupsDirPath()
  mkdirSync(dir, { recursive: true })
  const outPath = join(dir, autoBackupFileName())

  const tmpDbPath = join(app.getPath('temp'), `soroban-auto-backup-${randomUUID()}.db`)
  try {
    await db.getDb().backup(tmpDbPath)

    const settings = db.getSettings()
    const meta = {
      app: 'soroban',
      version: app.getVersion(),
      schema_version: settings.schema_version ? Number(settings.schema_version) : null,
      platform: process.platform,
      created_at: new Date().toISOString(),
    }

    writeBackupZip(outPath, { dbPath: tmpDbPath, thumbsDir: thumbsDirPath(), meta })
  } finally {
    try {
      unlinkSync(tmpDbPath)
    } catch {
      // 一時ファイルが無い・消せない場合は無視
    }
  }

  db.setSetting(AUTO_BACKUP_LAST_AT_KEY, new Date().toISOString())
  pruneOldAutoBackups(dir)
  applog.log('main', 'backup', '自動バックアップを保存しました', { path: outPath })
  return outPath
}

/**
 * 起動時に呼ぶ用。失敗してもアプリの起動は止めない（console.error と app_log に残すだけ）。
 * db.initDb() の後、他の起動処理をブロックしない場所から呼ぶこと（await しない）
 */
export async function maybeRunAutoBackup(): Promise<void> {
  try {
    await runAutoBackup(false)
  } catch (e) {
    console.error('自動バックアップに失敗しました', e)
    applog.log('main', 'backup', '自動バックアップに失敗しました', undefined, {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
