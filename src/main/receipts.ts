import { app, dialog, type BrowserWindow } from 'electron'
import { join, extname } from 'node:path'
import { mkdirSync, copyFileSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as db from './db'
import { recognizeImage } from './ocr'
import { parseReceiptText } from './receipt-parse'
import type { ReceiptDraft, ReceiptRead } from '../shared/types'

// ============================================================
// 経費（レシート）画像の添付・削除・OCR読み取り。
//
// 画像はユーザーが選んだファイルをコピーするだけ（読み取り専用のダイアログ操作）。
// userData/thumbs は collector.ts が保存するサムネイルと同じディレクトリを共有する。
// ファイル名は receipt-<経費id>.<拡張子> なので soroban-thumb:// の禁止文字
// （'/' '\\' '..'）に触れない。
//
// OCRの一時ファイルは receipt-tmp-<uuid>.<拡張子>。createExpense/updateExpense で
// receipt_temp_file に渡すと db.ts 側が receipt-<経費id>.<拡張子> にリネームして本添付になる
// ============================================================

const MAX_BYTES = 10 * 1024 * 1024
const TEMP_PREFIX = 'receipt-tmp-'
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** parseReceiptText が registration_no を抜けなかったときの保険。生テキストから T＋13桁を拾う */
function extractRegistrationNoFallback(text: string): string | null {
  const m = text.normalize('NFKC').match(/T\s*(\d{13})/)
  return m ? `T${m[1]}` : null
}

/**
 * 登録番号が学習済み（shop_alias）なら店名を上書きする。当たらなければそのまま
 * （shop_learned はそのまま false／parseReceiptText の判定を尊重）
 */
function applyShopAlias(draft: ReceiptDraft): ReceiptDraft {
  const registrationNo = draft.registration_no ?? extractRegistrationNoFallback(draft.raw_text)
  if (!registrationNo) return draft
  const learned = db.lookupShopAlias(registrationNo)
  if (!learned) return { ...draft, registration_no: registrationNo }
  return { ...draft, registration_no: registrationNo, shop: learned, shop_learned: true }
}

/** サムネイル保存先ディレクトリ（無ければ作る） */
function ensureThumbDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function toThumbUrl(file: string | null): string | null {
  return db.toThumbUrl ? db.toThumbUrl(file) : (file ? `soroban-thumb://${file}` : null)
}

/** レシート画像を選ぶダイアログ。キャンセルなら null。10MB を超えたら Error */
async function pickImageFile(win: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: 'レシート画像を選ぶ',
    filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic'] }],
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

/** 前回の readReceiptImage で放置された一時ファイル（1日より古いもの）を消す */
function cleanupOldTempFiles(): void {
  const dir = ensureThumbDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > TEMP_MAX_AGE_MS) unlinkSync(path)
    } catch {
      // 既に無い・消せない場合は無視
    }
  }
}

/**
 * レシート画像をファイル選択で添付する。選んだファイルを userData/thumbs にコピーし、
 * DB にファイル名を記録する。キャンセルなら null。
 * 前のレシートがあり拡張子が変わる場合は古いファイルを消す（同じ拡張子なら上書き）
 */
export async function attachReceipt(id: string, win: BrowserWindow | null): Promise<string | null> {
  const srcPath = await pickImageFile(win)
  if (!srcPath) return null

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

/** 画像ファイルを OCR して下書きを作る（アプリ内・オフライン） */
async function ocrDraft(filePath: string): Promise<ReceiptDraft> {
  const { text, confidence } = await recognizeImage(filePath)
  const draft: ReceiptDraft = { ...parseReceiptText(text), raw_text: text, confidence }
  return applyShopAlias(draft)
}

/**
 * レシート画像をファイル選択で読み取る。userData/thumbs に一時ファイル
 * （receipt-tmp-<uuid>.<拡張子>）としてコピーしてから OCR する。キャンセルなら null。
 * temp_file は createExpense/updateExpense の receipt_temp_file にそのまま渡せる
 */
export async function readReceiptImage(win: BrowserWindow | null): Promise<ReceiptRead | null> {
  cleanupOldTempFiles()

  const srcPath = await pickImageFile(win)
  if (!srcPath) return null

  const ext = extname(srcPath).toLowerCase()
  const file = `${TEMP_PREFIX}${randomUUID()}${ext}`
  const dir = ensureThumbDir()
  const destPath = join(dir, file)
  copyFileSync(srcPath, destPath)

  const draft = await ocrDraft(destPath)
  return { temp_file: file, receipt_url: toThumbUrl(file) as string, draft }
}

/** 添付済みのレシートを OCR する。レシートが無ければ Error */
export async function readReceipt(id: string): Promise<ReceiptDraft> {
  const file = db.getExpenseReceiptFile(id)
  if (!file) throw new Error('レシートが添付されていません')
  const path = join(app.getPath('userData'), 'thumbs', file)
  return ocrDraft(path)
}
