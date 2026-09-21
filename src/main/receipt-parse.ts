import { todayLocal } from '../shared/date'
import type { ReceiptDraft } from '../shared/types'

// ============================================================
// レシートOCRのテキストから、経費の下書き（店・購入日・合計・明細）を推定する。
//
// あくまで推定。読めなかった項目は null／空にして、人が直す前提（ocr.ts が
// 生テキストと信頼度を付けて返す）。ここは電子部品を持たない純粋関数のみ。
// ============================================================

type ReceiptDraftCore = Omit<ReceiptDraft, 'raw_text' | 'confidence'>

/** OCRで数字と誤読されやすい文字→数字。並びの中でだけ使う（本文には適用しない） */
const DIGIT_LOOKALIKE: Record<string, string> = {
  O: '0', o: '0', ロ: '0', 口: '0', の: '0',
  l: '1', I: '1', '|': '1',
  S: '5',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fixLookalikes(token: string): string {
  return token.split('').map(ch => DIGIT_LOOKALIKE[ch] ?? ch).join('')
}

/** 誤読補正 → 桁区切り（,／.）除去 → 整数化。数字にならなければ null */
function toAmountNumber(token: string): number | null {
  const digits = fixLookalikes(token).replace(/[.,]/g, '')
  if (!/^\d+$/.test(digits)) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

interface AmountMatch { value: number; index: number; length: number }

// ¥ / \ / y / Y の後ろの数字（誤読補正込み）。複数あれば最後を使う
const MARKED_AMOUNT_RE = /[\\¥Yy]\s*([0-9OoIlSロ口の|.,]+)円?/g
// マークが無い行は、行末の数字（円可）を金額とみなす
const TRAILING_AMOUNT_RE = /([0-9OoIlSロ口|.,]{2,})\s*円?\s*$/

/** 行から金額を1つ抜く。除去のための位置情報も返す */
function extractAmount(line: string): AmountMatch | null {
  MARKED_AMOUNT_RE.lastIndex = 0
  let marked: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = MARKED_AMOUNT_RE.exec(line))) {
    marked = m
    if (m.index === MARKED_AMOUNT_RE.lastIndex) MARKED_AMOUNT_RE.lastIndex++
  }
  if (marked) {
    const value = toAmountNumber(marked[1])
    if (value !== null) return { value, index: marked.index, length: marked[0].length }
  }

  const trailing = TRAILING_AMOUNT_RE.exec(line)
  if (trailing) {
    const value = toAmountNumber(trailing[1])
    if (value !== null) return { value, index: trailing.index, length: trailing[0].length }
  }
  return null
}

interface QuantityMatch { quantity: number; index: number; length: number }

const QUANTITY_PATTERNS = [/(\d+)点/, /(\d+)個/, /[×xX](\d+)/]

function extractQuantity(line: string): QuantityMatch | null {
  for (const re of QUANTITY_PATTERNS) {
    const m = re.exec(line)
    if (m) {
      const quantity = Number(m[1])
      if (quantity > 0) return { quantity, index: m.index, length: m[0].length }
    }
  }
  return null
}

/** 金額・数量表記・先頭の記号を取った残りを品名にする。空なら「品名不明」 */
function buildItemName(line: string, ranges: Array<{ index: number; length: number }>): string {
  let name = line
  for (const r of [...ranges].sort((a, b) => b.index - a.index)) {
    name = name.slice(0, r.index) + name.slice(r.index + r.length)
  }
  name = name.replace(/^[\s・*\-–—•#:：]+/, '').replace(/\s+/g, ' ').trim()
  return name || '品名不明'
}

// ------------------------------------------------------------
// 日付
// ------------------------------------------------------------

interface DateCandidate { index: number; y: number; mo: number; d: number }

function findDateMatches(text: string): DateCandidate[] {
  const out: DateCandidate[] = []
  const patterns: Array<{ re: RegExp; year: (s: string) => number }> = [
    { re: /(\d{4})年(\d{1,2})月(\d{1,2})日/g, year: s => Number(s) },
    { re: /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/g, year: s => Number(s) },
    { re: /(\d{4})\.(\d{1,2})\.(\d{1,2})/g, year: s => Number(s) },
    // 令和：R8.9.15 のような略記。令和N = 2018 + N
    { re: /[Rr令和]+(\d{1,2})[./](\d{1,2})[./](\d{1,2})/g, year: s => 2018 + Number(s) },
    // 下2桁の年（26.09.15）。4桁年の中の一致を避けるため前後が数字でないことを要求
    { re: /(?<!\d)(\d{2})\.(\d{1,2})\.(\d{1,2})(?!\d)/g, year: s => 2000 + Number(s) },
  ]
  for (const { re, year } of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      out.push({ index: m.index, y: year(m[1]), mo: Number(m[2]), d: Number(m[3]) })
    }
  }
  return out
}

function isDateLine(line: string): boolean {
  return findDateMatches(line).length > 0
}

/** 最初に見つかった有効な日付（YYYY-MM-DD）。未来日・2020年より前は無効 */
function extractDate(lines: string[]): string | null {
  const candidates = findDateMatches(lines.join('\n')).sort((a, b) => a.index - b.index)
  const today = todayLocal()
  for (const c of candidates) {
    if (c.mo < 1 || c.mo > 12 || c.d < 1 || c.d > 31) continue
    if (c.y < 2020) continue
    const iso = `${c.y}-${pad2(c.mo)}-${pad2(c.d)}`
    if (iso > today) continue
    return iso
  }
  return null
}

// ------------------------------------------------------------
// 店名
// ------------------------------------------------------------

function isPhoneLine(line: string): boolean {
  return /TEL|電話|\d{2,4}-\d{2,4}-\d{4}/.test(line)
}

/** 日付・TEL・電話番号・「レシート」「領収書」だけの行を除いた最初の行 */
function extractShop(lines: string[]): string | null {
  for (const line of lines) {
    if (isDateLine(line)) continue
    if (isPhoneLine(line)) continue
    if (line === 'レシート' || line === '領収書') continue
    return line.length > 40 ? line.slice(0, 40) : line
  }
  return null
}

// ------------------------------------------------------------
// 合計
// ------------------------------------------------------------

const TOTAL_LINE_RE = /合計|お買上|お買い上げ|税込合計|お会計/
const TOTAL_EXCLUDE_RE = /お預り|お預かり|釣|ポイント|残高|税/

function extractTotal(lines: string[]): number | null {
  let last: number | null = null
  for (const line of lines) {
    if (/小計/.test(line)) continue
    if (!TOTAL_LINE_RE.test(line)) continue
    const amt = extractAmount(line)
    if (amt) last = amt.value
  }
  if (last !== null) return last

  let max: number | null = null
  for (const line of lines) {
    if (TOTAL_EXCLUDE_RE.test(line)) continue
    const amt = extractAmount(line)
    if (amt && (max === null || amt.value > max)) max = amt.value
  }
  return max
}

// ------------------------------------------------------------
// 明細
// ------------------------------------------------------------

const ITEM_CUTOFF_RE = /小計|合計|お買上/
const ITEM_EXCLUDE_RE = /小計|合計|税|預|釣|ポイント|割引|値引|クーポン|TEL|レジ|責|No\.|日/

function extractItems(lines: string[]): ReceiptDraftCore['lines'] {
  const cutoffIndex = lines.findIndex(l => ITEM_CUTOFF_RE.test(l))
  const end = cutoffIndex === -1 ? lines.length : cutoffIndex

  const items: ReceiptDraftCore['lines'] = []
  for (let i = 0; i < end; i++) {
    const line = lines[i]
    if (ITEM_EXCLUDE_RE.test(line)) continue
    const amount = extractAmount(line)
    if (!amount) continue

    const qty = extractQuantity(line)
    let quantity = qty ? qty.quantity : 1
    let unit_price: number
    if (quantity > 0 && amount.value % quantity === 0) {
      unit_price = amount.value / quantity
    } else {
      unit_price = amount.value
      quantity = 1
    }

    const ranges = [{ index: amount.index, length: amount.length }]
    if (qty) ranges.push({ index: qty.index, length: qty.length })
    const name = buildItemName(line, ranges)
    items.push({ name, unit_price, quantity })
  }
  return items
}

/**
 * OCRの生テキストから、経費の下書き（raw_text・confidence を除く）を推定する。
 * 前処理：全角英数→半角（NFKC）。金額は ¥/\/y の後ろの数字、または行末の数字（円可）。
 * 数字の並びの中の誤読（O/o/ロ/口/の→0、l/I/|→1、S→5）と桁区切り（,/.）を補正する
 */
export function parseReceiptText(text: string): ReceiptDraftCore {
  const normalized = text.normalize('NFKC')
  const lines = normalized.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)

  // 事業者登録番号（T＋13 桁）。会社ごとに固定なので店名の学習キーになる
  const reg = normalized.match(/T\s*(\d{13})/)

  return {
    shop: extractShop(lines),
    occurred_at: extractDate(lines),
    total: extractTotal(lines),
    lines: extractItems(lines),
    registration_no: reg ? `T${reg[1]}` : null,
    shop_learned: false,
  }
}
