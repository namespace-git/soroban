import { app, dialog, type BrowserWindow } from 'electron'
import { join, extname } from 'node:path'
import { mkdirSync, copyFileSync, statSync, unlinkSync } from 'node:fs'
import * as db from './db'

// ============================================================
// 経費（レシート）画像の添付・削除。
//
// 画像はユーザーが選んだファイルをコピーするだけ（読み取り専用のダイアログ操作）。
// userData/thumbs は collector.ts が保存するサムネイルと同じディレクトリを共有する。
// ファイル名は receipt-<経費id>.<拡張子> なので soroban-thumb:// の禁止文字
// （'/' '\\' '..'）に触れない
// ============================================================

const MAX_BYTES = 10 * 1024 * 1024

/** サムネイル保存先ディレクトリ（無ければ作る） */
function ensureThumbDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function toThumbUrl(file: string | null): string | null {
  return db.toThumbUrl ? db.toThumbUrl(file) : (file ? `soroban-thumb://${file}` : null)
}

/**
 * レシート画像をファイル選択で添付する。選んだファイルを userData/thumbs にコピーし、
 * DB にファイル名を記録する。キャンセルなら null。
 * 前のレシートがあり拡張子が変わる場合は古いファイルを消す（同じ拡張子なら上書き）
 */
export async function attachReceipt(id: string, win: BrowserWindow | null): Promise<string | null> {
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: 'レシート画像を選ぶ',
        filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic'] }],
        properties: ['openFile'],
      })
    : await dialog.showOpenDialog({
        title: 'レシート画像を選ぶ',
        filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic'] }],
        properties: ['openFile'],
      })
  if (result.canceled || result.filePaths.length === 0) return null

  const srcPath = result.filePaths[0]
  if (statSync(srcPath).size > MAX_BYTES) {
    throw new Error('画像は 10MB までにしてください')
  }

  const ext = extname(srcPath).toLowerCase()
  const file = `receipt-${id}${ext}`
  const dir = ensureThumbDir()
  const destPath = join(dir, file)

  const prevFile = db.getExpenseReceiptFile(id)
  if (prevFile && prevFile !== file) {
    try {
      unlinkSync(join(dir, prevFile))
    } catch {
      // 元々無い・消せない場合は無視
    }
  }

  copyFileSync(srcPath, destPath)
  db.setExpenseReceiptFile(id, file)
  return toThumbUrl(file)
}

/** レシート画像を削除する（ファイルが無くてもエラーにしない） */
export async function removeReceipt(id: string): Promise<void> {
  const file = db.getExpenseReceiptFile(id)
  if (file) {
    try {
      unlinkSync(join(app.getPath('userData'), 'thumbs', file))
    } catch {
      // 既に無い場合は無視
    }
  }
  db.setExpenseReceiptFile(id, null)
}
