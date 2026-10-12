// ============================================================
// Gemini（Google の生成 AI）を呼ぶ共通部分。
//
// ai-receipt.ts（Electron。キーは safeStorage）と、サーバー（Cloudflare Workers。キーは暗号化して DB）の
// 両方が使う。**Electron にも DB にも触らない**（fetch で呼んで整えて返すだけ）。
// 通信と待ちは差し替えられる（GeminiOptions。省略すれば今までの動きそのまま）。
// API キーはログにも例外メッセージにも出さない。
// ============================================================

import type { ExpenseCategory, ReceiptBox, ReceiptDraft } from '../shared/types'

export const DEFAULT_MODEL = 'gemini-flash-latest'
const TIMEOUT_MS = 60_000
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/**
 * Gemini の無料枠は 503（過負荷）が頻発する。数秒〜十数秒で通ることが多いので
 * 短く自動再試行する。待ち時間はこの配列だけで決まる（1回目3秒・2回目8秒）。
 * 呼び出し回数は初回 + この配列の長さ = 最大3回で打ち切る
 */
export const RETRY_DELAYS_MS = [3_000, 8_000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

/** 呼び方の差し替え口（サーバーとテスト用）。省略時はグローバルの fetch・setTimeout */
export interface GeminiOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/** モデル名として URL に入れてよい形か（`gemini-2.5-pro` など。パスや `?` を紛れ込ませない） */
export function isValidModelName(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)
}

/**
 * APIキーらしき20文字以上の英数字（記号込み）を文言から伏せる。
 * Google のエラー本文にキーの断片が含まれることは無い想定だが、念のため
 */
export function maskSecrets(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{20,}/g, '[masked]')
}

/**
 * Gemini が非 2xx を返したときのエラー。Google の JSON
 * （`{ error: { code, message, status, details } }`）を解析し、
 * status（HTTPコード）と apiMessage（Google側の理由）で文言を出し分ける。
 * 無効なキーでも 400 が返る（`API_KEY_INVALID`）ので、401/403 だけでは判定できない
 */
export class GeminiHttpError extends Error {
  status: number
  /** Google が返した message（JSONでなければ本文の先頭200文字）。キーは含まれない */
  apiMessage: string
  /** Google が返した error.status（例: INVALID_ARGUMENT）。JSONでなければ null */
  apiStatus: string | null
  /** error.details[].reason（例: API_KEY_INVALID）。無ければ null */
  apiReason: string | null

  constructor(status: number, bodyText: string) {
    const parsed = GeminiHttpError.parseBody(bodyText, status)
    super(parsed.apiMessage)
    this.status = status
    this.apiMessage = parsed.apiMessage
    this.apiStatus = parsed.apiStatus
    this.apiReason = parsed.apiReason
  }

  private static parseBody(
    bodyText: string,
    status: number,
  ): { apiMessage: string; apiStatus: string | null; apiReason: string | null } {
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText)
        const err = (json as any)?.error
        if (err && typeof err === 'object') {
          const message = typeof err.message === 'string' && err.message ? err.message : null
          const apiStatus = typeof err.status === 'string' ? err.status : null
          const details = Array.isArray(err.details) ? err.details : []
          const reasonEntry = details.find((d: any) => typeof d?.reason === 'string')
          const apiReason = reasonEntry ? reasonEntry.reason : null
          if (message) return { apiMessage: maskSecrets(message), apiStatus, apiReason }
        }
      } catch {
        // JSONでなければ本文をそのまま使う（下のfallbackへ）
      }
    }
    const fallback = bodyText ? bodyText.slice(0, 200) : `HTTP ${status}`
    return { apiMessage: maskSecrets(fallback), apiStatus: null, apiReason: null }
  }
}

/** 応答が空／JSONとして読めなかったときのエラー。メッセージは既に日本語で整形済み */
export class AiResponseError extends Error {}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** グローバルの fetch は呼ぶたびに引く（Workers では fetch を取り出して別の名前で呼ぶと Illegal invocation になる） */
function pickFetch(options: GeminiOptions): typeof fetch {
  return options.fetch ?? ((input, init) => fetch(input, init))
}

// ------------------------------------------------------------
// Gemini 呼び出し
// ------------------------------------------------------------

/** 再試行してよいエラーか（503/502/504、または fetch 自体の一時的な失敗） */
function isRetryable(e: unknown): boolean {
  if (e instanceof GeminiHttpError) {
    return e.status === 502 || e.status === 503 || e.status === 504
  }
  return e instanceof Error && /fetch failed|ECONNRESET/i.test(e.message)
}

/** 1回だけ呼ぶ。TIMEOUT_MS の AbortController は呼び出しごとに作り直す */
async function callGeminiOnce(model: string, apiKey: string, body: unknown, options: GeminiOptions): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await pickFetch(options)(`${API_BASE}/${model}:generateContent`, {
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

/**
 * 503/502/504 と fetch の一時的失敗だけ、短く自動再試行する（RETRY_DELAYS_MS）。
 * 429・400・401・403・404 は再試行しない（429は無料枠の上限なので連打しない）
 */
export async function callGemini(model: string, apiKey: string, body: unknown, options: GeminiOptions = {}): Promise<unknown> {
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGeminiOnce(model, apiKey, body, options)
    } catch (e) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(e)) throw e
      const label = e instanceof GeminiHttpError ? String(e.status) : 'network'
      console.warn(`[ai] Gemini ${label} を再試行 (${attempt}/${RETRY_DELAYS_MS.length})`)
      await sleep(RETRY_DELAYS_MS[attempt - 1])
    }
  }
  // ここには到達しない（ループ内で必ず return か throw する）
  throw new Error('unreachable')
}

/** 疎通確認の最小の要求（モデルの種類に合わせて思考を抑える） */
export function buildPingBody(model: string): unknown {
  const generationConfig: Record<string, unknown> = {}
  // thinking モデル（flash 系）は思考トークンだけで応答が終わることがあるので0に抑える。
  // pro 系は thinkingBudget: 0 を受け付けないため、flash を含むモデルにだけ付ける
  if (model.includes('flash')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }
  return {
    contents: [{ parts: [{ text: 'ok とだけ返してください' }] }],
    generationConfig,
  }
}

/** 並び順の優先度：-latest を先頭、次に2.5系、それ以外は名前順（同順位内は呼び出し側で名前順にする） */
function modelRank(name: string): number {
  if (name.endsWith('-latest')) return 0
  if (name.includes('2.5')) return 1
  return 2
}

/**
 * このキーで使える Gemini モデルの一覧を取る（generateContent 対応の gemini 系のみ）。
 * 失敗は GeminiHttpError か fetch の例外のまま投げる（呼び出し側が toAiErrorMessage で日本語にする）
 */
export async function fetchGeminiModels(
  apiKey: string, options: GeminiOptions = {},
): Promise<Array<{ name: string; display_name: string; description: string }>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let json: unknown
  try {
    const res = await pickFetch(options)(`${API_BASE}?pageSize=100`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GeminiHttpError(res.status, text || `HTTP ${res.status}`)
    }
    json = await res.json()
  } finally {
    clearTimeout(timer)
  }

  const models: any[] = Array.isArray((json as any)?.models) ? (json as any).models : []
  const list: Array<{ name: string; display_name: string; description: string }> = models
    .filter(
      (m: any) =>
        typeof m?.name === 'string' &&
        m.name.startsWith('models/gemini') &&
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent'),
    )
    .map((m: any) => {
      const name = m.name.replace(/^models\//, '')
      return {
        name,
        display_name: typeof m.displayName === 'string' && m.displayName ? m.displayName : name,
        description: typeof m.description === 'string' ? m.description : '',
      }
    })

  list.sort((a, b) => modelRank(a.name) - modelRank(b.name) || a.name.localeCompare(b.name))
  return list
}

/**
 * candidates[0].content.parts から最初のテキストを取る。thinkingモデル
 * （gemini-2.5-pro等）は `{ thought: true, text: '...' }` という思考partを
 * 前段に挟むことがあるため、それは飛ばして本文のpartを探す
 */
export function extractResponseText(json: unknown): string {
  const candidate = (json as any)?.candidates?.[0]
  const parts = candidate?.content?.parts
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.text && part.thought !== true) {
        return part.text
      }
    }
  }
  // maxOutputTokens を思考トークンで使い切ると、本文が空のまま finishReason だけ
  // MAX_TOKENS で返ってくることがある（thinkingConfig で抑えていないモデル）
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new AiResponseError('モデルが考えすぎて本文が空でした。別のモデル（gemini-flash-latest など）を試してください')
  }
  const snippet = maskSecrets(JSON.stringify(json ?? '')).slice(0, 120)
  throw new AiResponseError(`AI の応答を読めませんでした（${snippet}）`)
}

/** エラーを短い日本語の文言に丸める。元のエラーは呼び出し側で logAiError 済み */
export function toAiErrorMessage(e: unknown, model: string): string {
  if (e instanceof AiResponseError) return e.message
  if (e instanceof GeminiHttpError) {
    const { status, apiMessage, apiReason } = e
    if (status === 400 && (apiReason === 'API_KEY_INVALID' || /API key not valid/i.test(apiMessage))) {
      return 'API キーが無効です（AI Studio で作り直してください）'
    }
    if (status === 400) {
      return `Gemini に要求を拒否されました（400）：${apiMessage.slice(0, 120)}`
    }
    if (status === 401 || status === 403) {
      return `API キーが無効か、権限がありません（${status}）：${apiMessage}`
    }
    if (status === 404) {
      return `モデル「${model}」がこのキーでは使えません。設定 → AI 読み取り で「使えるモデルを読み込む」から選んでください`
    }
    if (status === 429) {
      return '無料枠の上限に達しました。設定 → AI 読み取り でモデルを gemini-flash-latest に変えるか、明日また'
    }
    if (status >= 500) {
      return `Gemini が混み合っています（${status}）。${RETRY_DELAYS_MS.length}回試しましたが通りませんでした。少し待ってから、もう一度「読み取る」を押してください`
    }
    return `AI の応答を読めませんでした（${apiMessage.slice(0, 120)}）`
  }
  if (e instanceof Error && e.name === 'AbortError') return 'ネットに接続できません'
  if (e instanceof Error && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(e.message)) {
    return 'ネットに接続できません'
  }
  return 'AI の応答を読めませんでした'
}

/** エラーをログに残す。GeminiHttpErrorならstatus・apiMessageを出す（キーは出さない） */
export function logAiError(label: string, e: unknown): void {
  if (e instanceof GeminiHttpError) {
    console.error(label, { status: e.status, apiStatus: e.apiStatus, apiMessage: e.apiMessage })
  } else {
    console.error(label, e)
  }
}

// ------------------------------------------------------------
// レシートの読み取り（画像 → ReceiptDraft）
//
// ai-receipt.ts（Electron）とサーバー（server/domain/monthly.ts）が同じ読み取りをするための、純粋な部分。
// プロンプト・応答の型・下書きへの変換は 1 か所だけにして、デスクトップと Web で結果が分かれないようにする。
// 「今日」は呼ぶ側が渡す（デスクトップは todayLocal()、サーバー（Workers は UTC）は todayJst()）。
// ------------------------------------------------------------

/** 読み取りに送る画像の大きさの上限 */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024

const RECEIPT_CATEGORIES: ExpenseCategory[] = ['packaging', 'shipping', 'supplies', 'fee', 'other']

export const RECEIPT_PROMPT = '日本のレシート。次を JSON で：shop（店名。チェーン名＋店舗名）、registration_no（T＋13 桁、無ければ null）、date（YYYY-MM-DD）、total（税込の合計。円、整数）、tax（内消費税の額、無ければ null）、lines（品名・単価・数量・金額・category・box_2d。**単価と金額は税込**。レシートの明細が税抜表示なら税込に直し、明細の金額の合計が total（税込）と一致するようにする。端数が出たら最後の行で合わせる）、boxes（shop・date・total それぞれの box_2d）、warnings（事業に関係なさそうな行、合計が合わない、読めない箇所）。box_2d は [ymin, xmin, ymax, xmax]（画像上でその文字を読んだ位置。0〜1000 の正規化座標）。読めなければ null。category は packaging（袋・箱・緩衝材・テープ・シール等の梱包資材）／shipping（送料・切手・レターパック・宅急便・ゆうパケット等）／supplies（文具・電池等の消耗品）／fee（手数料）／other。数字は半角整数。読めないものは null'

/** box_2d（[ymin, xmin, ymax, xmax]、0〜1000）。読めなければ null */
const BOX_SCHEMA = { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true }

export const RECEIPT_RESPONSE_SCHEMA = {
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
          category: { type: 'STRING', enum: RECEIPT_CATEGORIES, nullable: true },
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

const RECEIPT_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * 画像の拡張子（`.jpg` でも `jpg` でも、大文字小文字は問わない）から、送るときの MIME を決める。
 * 読めない形式なら、人に見せる日本語の理由を返す（呼ぶ側が Error / UserError にする）
 */
export function receiptImageType(ext: string): { mimeType: string } | { error: string } {
  const e = ext.replace(/^\./, '').toLowerCase()
  if (e === 'heic' || e === 'heif') return { error: 'HEIC は読めません。JPEG か PNG にしてください' }
  if (!Object.prototype.hasOwnProperty.call(RECEIPT_MIME_BY_EXT, e)) {
    return { error: 'この画像の形式は読めません（JPEG・PNG・WebP のみ）' }
  }
  return { mimeType: RECEIPT_MIME_BY_EXT[e] }
}

/** 未来日・2020年より前は無効な日付として null にする（receipt-parse.ts の判定を踏襲）。today は YYYY-MM-DD */
export function normalizeDate(raw: unknown, today: string): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1])
  if (year < 2020) return null
  if (raw > today) return null
  return raw
}

export function normalizeRegistrationNo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/T\s*(\d{13})/)
  return m ? `T${m[1]}` : null
}

function normalizeAmount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.round(raw)
}

function normalizeCategory(raw: unknown): ExpenseCategory | undefined {
  return typeof raw === 'string' && (RECEIPT_CATEGORIES as string[]).includes(raw) ? (raw as ExpenseCategory) : undefined
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

/** AI の応答（JSON をパースしたもの）→ 経費の下書き。today は無効な日付の判定に使う（YYYY-MM-DD） */
export function toReceiptDraft(parsed: any, rawText: string, today: string): ReceiptDraft {
  const lines = Array.isArray(parsed?.lines) ? parsed.lines.map(toDraftLine) : []
  const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : []
  return {
    shop: typeof parsed?.shop === 'string' && parsed.shop.trim() ? parsed.shop.trim() : null,
    registration_no: normalizeRegistrationNo(parsed?.registration_no),
    shop_learned: false,
    occurred_at: normalizeDate(parsed?.date, today),
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

/** テキストをJSONへ。壊れていれば先頭120文字を添えたAiResponseError */
function parseReceiptJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new AiResponseError(`AI の応答を読めませんでした（${maskSecrets(text).slice(0, 120)}）`)
  }
}

/** Gemini に送るレシート読み取りの要求本文 */
export function buildReceiptRequestBody(image: { mimeType: string; base64: string }): unknown {
  return {
    contents: [{
      parts: [
        { inline_data: { mime_type: image.mimeType, data: image.base64 } },
        { text: RECEIPT_PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RECEIPT_RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  }
}

/**
 * レシート画像を Gemini で読み、経費の下書きにする（店名の学習は含まない）。
 * 失敗は GeminiHttpError・AiResponseError・fetch の例外のまま投げる（呼ぶ側が logAiError → toAiErrorMessage で日本語にする）
 */
export async function requestReceiptDraft(
  model: string, apiKey: string, image: { mimeType: string; base64: string }, today: string, options: GeminiOptions = {},
): Promise<ReceiptDraft> {
  const json = await callGemini(model, apiKey, buildReceiptRequestBody(image), options)
  const text = extractResponseText(json)
  const parsed = parseReceiptJson(text)
  return toReceiptDraft(parsed, text, today)
}

/** AI が registration_no を抜けなかったときの保険。生テキスト（AI の応答）から T＋13桁を拾う */
export function extractRegistrationNoFallback(text: string): string | null {
  const m = text.normalize('NFKC').match(/T\s*(\d{13})/)
  return m ? `T${m[1]}` : null
}

/** 下書きの登録番号（AI が読めたもの、無ければ生テキストから拾ったもの）。無ければ null */
export function receiptRegistrationNo(draft: ReceiptDraft): string | null {
  return draft.registration_no ?? extractRegistrationNoFallback(draft.raw_text)
}

/**
 * 登録番号が学習済み（shop_alias）なら店名を上書きして shop_learned を立てる。当たらなければ登録番号だけ入れる。
 * registrationNo は `receiptRegistrationNo(draft)`、learnedShop は学習済みの店名（無ければ null）
 */
export function applyLearnedShop(draft: ReceiptDraft, registrationNo: string, learnedShop: string | null): ReceiptDraft {
  if (!learnedShop) return { ...draft, registration_no: registrationNo }
  return { ...draft, registration_no: registrationNo, shop: learnedShop, shop_learned: true }
}