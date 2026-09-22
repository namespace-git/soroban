import { app, dialog, type BrowserWindow } from 'electron'
import { join, extname } from 'node:path'
import { mkdirSync, copyFileSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as db from './db'

// ============================================================
// 商品（型番）画像。
//
// 既定は自動（①最新の出品の画像 → ②最新の販売の画像。db.ts の productImageFiles）。
// 人がファイルを選んでセットしたら（setProductImage）以後は取り込みで上書きしない
// （product_image テーブル。db.ts）。setProductImageAuto(code, true) で自動に戻せる。
//
// ファイルは userData/thumbs を collector.ts・receipts.ts のサムネイルと共有する。
// ファイル名は product-<型番>-<uuid8>.<拡張子> なので soroban-thumb:// の禁止文字
// （'/' '\\' '..'）に触れない。
// ============================================================

const MAX_BYTES = 10 * 1024 * 1024

function ensureThumbDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** ファイル名に使える形にする（型番に含まれうる記号 【】- 等を落とす） */
function safeCode(modelCode: string): string {
  return modelCode.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** product- で始まるファイルだけ削除する（自動画像のファイルを誤って消さないため） */
function removeIfProductFile(file: string | null): void {
  if (!file || !file.startsWith('product-')) return
  try {
    unlinkSync(join(app.getPath('userData'), 'thumbs', file))
  } catch {
    // 既に無い・消せない場合は無視
  }
}

/** 商品画像を選ぶダイアログ。キャンセルなら null。10MB を超えたら Error */
async function pickImageFile(win: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: '商品画像を選ぶ',
    filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile' as const],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null

  const srcPath = result.filePaths[0]
  if (statSync(srcPath).size > MAX_BYTES) {
    throw new Error('画像は 10MB までにしてください')
  }
  return srcPath
}

/**
 * 商品画像を人がセットする（ファイル選択ダイアログを開く）。選んだファイルを
 * userData/thumbs にコピーして product_image に記録する（以後、取り込みで上書きしない）。
 * 前が人のセット画像なら（product- ファイルなら）古いファイルを消す。キャンセルなら false
 */
export async function setProductImage(modelCode: string, win: BrowserWindow | null): Promise<boolean> {
  const srcPath = await pickImageFile(win)
  if (!srcPath) return false

  const ext = extname(srcPath).toLowerCase()
  const file = `product-${safeCode(modelCode)}-${randomUUID().slice(0, 8)}${ext}`
  const dir = ensureThumbDir()
  copyFileSync(srcPath, join(dir, file))

  const prev = db.getProductImage(modelCode)
  db.upsertProductImage(modelCode, file)
  if (prev && prev.file !== file) removeIfProductFile(prev.file)

  return true
}

/**
 * auto=true：人がセットした画像を捨てて自動（出品・販売の最新画像）に戻す。
 * auto=false：今の自動画像（productImageFiles。既に人がセットしていれば何もしない）を
 * コピーして product_image に固定する（以後、出品・販売の画像が変わっても追従しない）。
 * 自動画像が無ければ何もしない。
 */
export function setProductImageAuto(modelCode: string, auto: boolean): void {
  if (auto) {
    const prev = db.getProductImage(modelCode)
    if (!prev) return
    db.deleteProductImage(modelCode)
    removeIfProductFile(prev.file)
    return
  }

  const image = db.productImageFiles([modelCode]).get(modelCode)
  if (!image || image.manual) return

  const dir = ensureThumbDir()
  // 出品・販売のサムネイルは collector.ts が常に .jpg で保存する
  const file = `product-${safeCode(modelCode)}-${randomUUID().slice(0, 8)}.jpg`
  copyFileSync(join(dir, image.file), join(dir, file))
  db.upsertProductImage(modelCode, file)
}
