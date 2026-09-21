import { safeStorage } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import * as db from './db'
import { todayLocal } from '../shared/date'
import type { AiStatus, ExpenseCategory, ReceiptBox, ReceiptDraft } from '../shared/types'

// ============================================================
// レシート画像の読み取り（Gemini、利用者が自分の API キーで使う）。
//
// キーは safeStorage で暗号化して setting.gemini_api_key_enc に保存する
// （平文では持たない。安全な保存が使えない環境では保存自体を断る）。
// 画像は Google に送られる（CLAUDE.md「外部サービスなし」の唯一の例外。
// メルカリへの書き込み・認証情報の保存はしない方針は変えない）。
// ============================================================

const DEFAULT_MODEL = 'gemini-2.5-pro'
const SETTING_KEY_ENC = 'gemini_api_key_enc'
const SETTING_MODEL = 'ai_model'
const TIMEOUT_MS = 60_000
const MAX_BYTES = 10 * 1024 * 1024
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const CATEGORIES: ExpenseCategory[] = ['packaging', 'shipping', 'supplies', 'fee', 'other']

const PROMPT = '日本のレシート。次を JSON で：shop（店名。チェーン名＋店舗名）、registration_no（T＋13 桁、無ければ null）、date（YYYY-MM-DD）、total（税込の合計。円、整数）、tax（内消費税の額、無ければ null）、lines（品名・単価・数量・金額・category・box_2d）、boxes（shop・date・total それぞれの box_2d）、warnings（事業に関係なさそうな行、合計が合わない、読めない箇所）。box_2d は [ymin, xmin, ymax, xmax]（画像上でその文字を読んだ位置。0〜1000 の正規化座標）。読めなければ null。category は packaging（袋・箱・緩衝材・テープ・シール等の梱包資材）／shipping（送料・切手・レターパック・宅急便・ゆうパケット等）／supplies（文具・電池等の消耗品）／fee（手数料）／other。数字は半角整数。読めないものは null'

/** box_2d（[ymin, xmin, ymax, xmax]、0〜1000）。読めなければ null */
const BOX_SCHEMA = { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true }

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    shop: { type: 'STRING', nullable: true },
    registration_no: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true },
    total: { type: 'INTEGER', nullable: true },
    tax: { type: 'INTEGER', nullable: true },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          unit_price: { type: 'INTEGER', nullable: true },
          quantity: { type: 'INTEGER', nullable: true },
          amount: { type: 'INTEGER', nullable: true },
          category: { type: 'STRING', enum: CATEGORIES, nullable: true },
          box_2d: BOX_SCHEMA,
        },
        required: ['name'],
      },
    },
    boxes: {
      type: 'OBJECT',
      properties: {
        shop: BOX_SCHEMA,
        date: BOX_SCHEMA,
        total: BOX_SCHEMA,
      },
      nullable: true,
    },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['lines', 'warnings'],
}

/** Gemini が非 2xx を返したときのエラー。ステータスで文言を出し分けるために使う */
class GeminiHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// ------------------------------------------------------------
// キー・モデルの設定（setting テーブル）
// ------------------------------------------------------------

function getModel(): string {
  return db.getSettings()[SETTING_MODEL] || DEFAULT_MODEL
}

/** setting から暗号化済みのキー（base64）を取る。未設定・削除後は null */
function getEncodedKey(): string | null {
  const encoded = db.getSettings()[SETTING_KEY_ENC]
  return encoded ? encoded : null
}

/** 復号したAPIキー。復号できなければ null（呼び出し側で「設定がありません」に丸める） */
function decryptStoredKey(encoded: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch (e) {
    console.error('API キーの復号に失敗しました', e)
    return null
  }
}

export function getAiStatus(): AiStatus {
  return {
    configured: getEncodedKey() !== null,
    model: getModel(),
    safe_storage: safeStorage.isEncryptionAvailable(),
  }
}

/**
 * API キーを暗号化して保存する（null で削除）。安全な保存（safeStorage）が
 * 使えない環境では保存を断る（平文で持たない）
 */
export function setGeminiApiKey(apiKey: string | null): void {
  if (apiKey === null || apiKey === '') {
    db.setSetting(SETTING_KEY_ENC, '')
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('この環境では安全に保存できません')
  }
  const encrypted = safeStorage.encryptString(apiKey)
  db.setSetting(SETTING_KEY_ENC, encrypted.toString('base64'))
}

/** モデル名を保存する。空文字なら既定（gemini-2.5-pro）に戻す */
export function setAiModel(model: string): void {
  db.setSetting(SETTING_MODEL, model || DEFAULT_MODEL)
}

/** 保存済みキーを復号して返す。無ければ「設定がありません」の日本語エラー */
function requireApiKey(): string {
  const encoded = getEncodedKey()
  const key = encoded ? decryptStoredKey(encoded) : null
  if (!key) throw new Error('AI 読み取りの設定がありません（設定 → AI 読み取り）')
  return key
}

// ------------------------------------------------------------
// Gemini 呼び出し
// ------------------------------------------------------------

async function callGemini(model: string, apiKey: string, body: unknown): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GeminiHttpError(res.status, text || `HTTP ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function extractResponseText(json: unknown): string {
  const text = (json as any)?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text !== 'string' || !text) throw new Error('AI の応答が空でした')
  return text
}

/** エラーを短い日本語の文言に丸める。元のエラーは呼び出し側で console.error 済み */
function toAiErrorMessage(e: unknown): string {
  if (e instanceof GeminiHttpError) {
    if (e.status === 401 || e.status === 403) return 'API キーが無効です'
    if (e.status === 429) return '無料枠の上限に達しました。設定 → AI 読み取り でモデルを gemini-flash-latest に変えるか、明日また'
    return 'AI の応答を読めませんでした'
  }
  if (e instanceof Error && e.name === 'AbortError') return 'ネットに接続できません'
  if (e instanceof Error && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(e.message)) {
    return 'ネットに接続できません'
  }
  return 'AI の応答を読めませんでした'
}

/** 保存したキーで最小の要求を送って疎通を確かめる */
export async function testGemini(): Promise<{ ok: boolean; message: string }> {
  let apiKey: string
  try {
    apiKey = requireApiKey()
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'AI 読み取りの設定がありません（設定 → AI 読み取り）' }
  }

  try {
    const model = getModel()
    const json = await callGemini(model, apiKey, {
      contents: [{ parts: [{ text: 'ok とだけ返してください' }] }],
    })
    extractResponseText(json)
    return { ok: true, message: '接続できました' }
  } catch (e) {
    console.error('Gemini への疎通確認に失敗しました', e)
    return { ok: false, message: toAiErrorMessage(e) }
  }
}

// ------------------------------------------------------------
// 画像 → ReceiptDraft
// ------------------------------------------------------------

function loadImage(filePath: string): { mimeType: string; base64: string } {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.heic' || ext === '.heif') {
    throw new Error('HEIC は読めません。JPEG か PNG にしてください')
  }
  const mimeType = MIME_BY_EXT[ext]
  if (!mimeType) throw new Error('この画像の形式は読めません（JPEG・PNG・WebP のみ）')
  if (statSync(filePath).size > MAX_BYTES) throw new Error('画像は 10MB までにしてください')
  const base64 = readFileSync(filePath).toString('base64')
  return { mimeType, base64 }
}

/** 未来日・2020年より前は無効な日付として null にする（receipt-parse.ts の判定を踏襲） */
function normalizeDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1])
  if (year < 2020) return null
  if (raw > todayLocal()) return null
  return raw
}

function normalizeRegistrationNo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/T\s*(\d{13})/)
  return m ? `T${m[1]}` : null
}

function normalizeAmount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.round(raw)
}

function normalizeCategory(raw: unknown): ExpenseCategory | undefined {
  return typeof raw === 'string' && (CATEGORIES as string[]).includes(raw) ? (raw as ExpenseCategory) : undefined
}

/** box_2d（[ymin, xmin, ymax, xmax]）。4要素の数字でなければ null。範囲外は 0〜1000 に丸める */
function normalizeBox(raw: unknown): ReceiptBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const nums = raw.map(v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null))
  if (nums.some(n => n === null)) return null
  const [ymin, xmin, ymax, xmax] = nums.map(n => Math.min(1000, Math.max(0, n as number)))
  return [ymin, xmin, ymax, xmax]
}

/**
 * lines の1行を ReceiptDraft の形へ。amount（行の金額）と quantity から単価を逆算する
 * （AI が返す unit_price は使わず、amount / quantity が割り切れればそれ、割り切れなければ
 * 金額そのもの・数量1にする。receipt-parse.ts の extractItems と同じ考え方）
 */
function toDraftLine(raw: any): ReceiptDraft['lines'][number] {
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : '品名不明'
  const quantityRaw = typeof raw?.quantity === 'number' && raw.quantity > 0 ? Math.round(raw.quantity) : 1
  const amount = normalizeAmount(raw?.amount) ?? normalizeAmount(raw?.unit_price) ?? 0

  let quantity = quantityRaw
  let unit_price: number
  if (quantity > 0 && amount % quantity === 0) {
    unit_price = amount / quantity
  } else {
    unit_price = amount
    quantity = 1
  }

  const category = normalizeCategory(raw?.category)
  const box = normalizeBox(raw?.box_2d)
  const line: ReceiptDraft['lines'][number] = { name, unit_price, quantity }
  if (category) line.category = category
  if (box) line.box = box
  return line
}

function toReceiptDraft(parsed: any, rawText: string): ReceiptDraft {
  const lines = Array.isArray(parsed?.lines) ? parsed.lines.map(toDraftLine) : []
  const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : []
  return {
    shop: typeof parsed?.shop === 'string' && parsed.shop.trim() ? parsed.shop.trim() : null,
    registration_no: normalizeRegistrationNo(parsed?.registration_no),
    shop_learned: false,
    occurred_at: normalizeDate(parsed?.date),
    total: normalizeAmount(parsed?.total),
    lines,
    boxes: {
      shop: normalizeBox(parsed?.boxes?.shop),
      date: normalizeBox(parsed?.boxes?.date),
      total: normalizeBox(parsed?.boxes?.total),
    },
    tax: normalizeAmount(parsed?.tax),
    warnings,
    raw_text: rawText,
    confidence: 80,
  }
}

/** レシート画像を Gemini で読み取り、経費の下書きにする。キー未設定なら Error */
export async function readReceiptWithGemini(filePath: string): Promise<ReceiptDraft> {
  const apiKey = requireApiKey()
  const model = getModel()
  const { mimeType, base64 } = loadImage(filePath)

  try {
    const json = await callGemini(model, apiKey, {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: PROMPT },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    })
    const text = extractResponseText(json)
    const parsed = JSON.parse(text)
    return toReceiptDraft(parsed, text)
  } catch (e) {
    console.error('Gemini でのレシート読み取りに失敗しました', e)
    throw new Error(toAiErrorMessage(e))
  }
}
