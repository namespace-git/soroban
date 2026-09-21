import { BrowserWindow, session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import * as db from './db'
import { extractCode, extractMaterial } from './code'
import { buildUserAgent, isChallengeText, randomWait } from './collector'
import { todayLocal } from '../shared/date'
import type {
  CollectorRun, Fulfillment, Material, PurchaseDraftInput, PurchaseInput, PurchaseLineInput,
} from '../shared/types'

// ============================================================
// メロジョイ（仕入先）のログイン窓・注文履歴の取得
//
// 注文履歴の取得は実DOMを見てから。P-07
//
// 約束：
//   * 認証情報は保存しない。保存するのは persist パーティション（Cookie）だけ
//   * 書き込み操作は一切しない
//   * アカウントごとに別プロファイル（partitionFor）にして混線させない
//   * 連続アクセスしない。ページ間はランダム待ち、1回の実行で開くページ数に上限
//   * 取得0件は「成功」ではなく empty（異常の疑い）として記録する
//   * 紐付け・確定は自動でしない。金額が確定できない注文は draft のまま人に渡す
// ============================================================

const LOGIN_URL = 'https://www.mellojoyjapan.com/account/login'
const ORDERS_URL = 'https://www.mellojoyjapan.com/account'

/** 1回の収集で開くページ数の上限（一覧1＋詳細最大5）。超えたら次回に回す */
const MAX_PAGES_PER_RUN = 6
/** 1回の実行で開く注文詳細の上限 */
const MAX_DETAILS_PER_RUN = 5
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 15000

const AUTH_MESSAGE =
  'メロジョイのログインが切れています。設定 → 仕入先 → ログイン から入り直してください'

/** アカウントごとに別プロファイルにする。Cookieを混ぜない */
export function partitionFor(shopAccountId: string): string {
  return `persist:mellojoy-${shopAccountId}`
}

/** UA・Accept-Language を通常の Chrome に合わせる（collector.ts と同じ） */
export function ensureShopSession(shopAccountId: string): void {
  const s = session.fromPartition(partitionFor(shopAccountId))
  const chromeMajor = process.versions.chrome.split('.')[0]
  const ua = buildUserAgent(process.platform, chromeMajor)
  s.setUserAgent(ua, 'ja,en-US;q=0.9,en;q=0.8')
}

function createShopWindow(shopAccountId: string, show: boolean): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    show,
    title: 'メロジョイ',
    webPreferences: {
      partition: partitionFor(shopAccountId),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
}

/**
 * ログイン用ウィンドウを開く。
 * ユーザーが手でログインし、Cookieがそのアカウントのプロファイルに残る。
 */
export function openShopLoginWindow(shopAccountId: string): Promise<void> {
  ensureShopSession(shopAccountId)

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      title: 'メロジョイ',
      webPreferences: {
        partition: partitionFor(shopAccountId),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    win.loadURL(LOGIN_URL)
    win.on('closed', () => resolve())
  })
}

/**
 * アカウント削除時にログイン状態を消す。プロファイルを残さない。
 */
export async function clearShopSession(shopAccountId: string): Promise<void> {
  const s = session.fromPartition(partitionFor(shopAccountId))
  await s.clearStorageData()
  await s.clearCache()
}

// ------------------------------------------------------------
// HTML の下ごしらえ（electron に依存しない純粋関数）
// ------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim()
}

/**
 * `startIndex` が指す `<div ...>` の開始タグから、対応する閉じタグまでを
 * div の入れ子を数えて切り出す。クラス名に依存せず構造だけで境界を決めるための土台。
 */
function extractDivBlock(html: string, startIndex: number): string | null {
  const openTagEnd = html.indexOf('>', startIndex)
  if (openTagEnd === -1) return null

  const tagRe = /<div[\s>]|<\/div>/g
  tagRe.lastIndex = openTagEnd + 1
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('<div')) depth++
    else depth--
    if (depth === 0) return html.slice(startIndex, m.index + m[0].length)
  }
  return null
}

/** `html` 内で role 属性が一致する `<div>` の開始位置をすべて返す */
function findRoleDivStarts(html: string, role: string): number[] {
  const re = new RegExp(`<div[^>]*\\brole="${role}"[^>]*>`, 'g')
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) starts.push(m.index)
  return starts
}

/**
 * MoneyLine の金額セル（小計・配送・割引・合計）を解析する。
 * `￥1,234` / `¥1,234`（全角・半角どちらも）ならその額。
 * 実際の注文で「配送 無料」のように金額表記が無いことがあり、これを読めない扱いにすると
 * 配送料0円の注文が下書きに落ちてしまう。「無料」「送料無料」「Free」「¥0」「￥0」の
 * いずれかを含むセルは 0 円として扱う。どちらでもなければ null（読めない）
 */
function parseMoneyCell(cellBlock: string | null): number | null {
  if (!cellBlock) return null
  const amountMatch = /[¥￥]([\d,]+)/.exec(cellBlock)
  if (amountMatch) return parseInt(amountMatch[1].replace(/,/g, ''), 10)
  const text = stripTags(cellBlock)
  if (/無料|Free/i.test(text)) return 0
  return null
}

// ------------------------------------------------------------
// 注文一覧
// ------------------------------------------------------------

export interface OrderListRow {
  /** '#268526' の形（# 込み） */
  orderNo: string
  /** 相対 or 絶対の詳細ページ href */
  href: string
  status: string
  total: number | null
}

/**
 * 注文一覧ページの HTML から各注文を抜く。キャンセル済みも含めて返すので、
 * 呼び出し側でフィルタする。aria-hidden の重複ブロックがあるため注文番号で重複排除する。
 */
export function parseOrderListHtml(html: string): OrderListRow[] {
  const rows = new Map<string, OrderListRow>()
  const articleRe = /<article[^>]*aria-labelledby="order-(#\d+)"[^>]*>([\s\S]*?)<\/article>/g

  let m: RegExpExecArray | null
  while ((m = articleRe.exec(html))) {
    const orderNo = m[1]
    if (rows.has(orderNo)) continue
    const block = m[2]

    const linkTagMatch = /<a\b[^>]*aria-label="注文を表示する[^"]*"[^>]*>/.exec(block)
    const hrefMatch = linkTagMatch ? /href="([^"]*)"/.exec(linkTagMatch[0]) : null
    const href = hrefMatch ? decodeEntities(hrefMatch[1]) : ''

    const statusMatch = /<h2\b[^>]*role="presentation"[^>]*>([^<]*)<\/h2>/.exec(block)
    const status = statusMatch ? decodeEntities(statusMatch[1]).trim() : ''

    const totalMatch = /￥([\d,]+)\s*JPY/.exec(block)
    const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : null

    rows.set(orderNo, { orderNo, href, status, total })
  }

  return Array.from(rows.values())
}

/**
 * 注文一覧の状態表示から到着状態を判定する。詳細ページは開かず一覧だけで済ませる。
 * キャンセル・空・未知の表記は null（不明）扱い。
 */
export function fulfillmentFromStatus(text: string): Fulfillment | null {
  if (text.includes('配達済み') || text.includes('受け取り済み') || text.includes('完了')) {
    return 'delivered'
  }
  if (text.includes('配達中') || text.includes('発送済み') || text.includes('出荷済み')) {
    return 'shipped'
  }
  if (text.includes('確認済み')) return 'pending'
  return null
}

// ------------------------------------------------------------
// 注文詳細
// ------------------------------------------------------------

export interface OrderDetailLine {
  title: string
  variant: string | null
  quantity: number
  price: number
}

export interface OrderDetail {
  orderNo: string | null
  confirmedAtText: string | null
  lines: OrderDetailLine[]
  subtotal: number | null
  shipping: number | null
  discount: number
  total: number | null
  /** 小計・配送・合計・割引以外の未知の行（label や label=金額）。confirmed の妨げ */
  unknownRows: string[]
}

/** 注文アイテム表の1行（role="cell" 3つ）を組み立てる */
function parseOrderItemRow(rowHtml: string): OrderDetailLine | null {
  const cellStarts = findRoleDivStarts(rowHtml, 'cell')
  const cells = cellStarts
    .map(i => extractDivBlock(rowHtml, i))
    .filter((c): c is string => c !== null)
  if (cells.length < 3) return null

  // セル1：数量。バリアント名の '2 * ボックス' と食い違うことがあるが、こちらを優先する
  const qtyMatch = /数量<\/span>\s*(\d+)/.exec(cells[0])
  const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1

  // セル2：商品名 + <small> のバリアント名
  const titleMatch = /<span[^>]*>([^<]*)<\/span>/.exec(cells[1])
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''

  const smallMatch = /<small\b[^>]*>([\s\S]*?)<\/small>/.exec(cells[1])
  const variant = smallMatch ? stripTags(smallMatch[1]) || null : null

  // セル3：金額（単価か行合計かはこの時点では分からない）
  const priceMatch = /￥([\d,]+)/.exec(cells[2])
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : NaN

  if (!title || Number.isNaN(price)) return null
  return { title, variant, quantity, price }
}

/**
 * 注文詳細ページの HTML から明細・注文合計表を抜く。
 * クラス名（ハッシュ）には依存せず、role 属性と見出し文言だけで境界を決める。
 */
export function parseOrderDetailHtml(html: string): OrderDetail {
  const orderNoMatch = /<h1\b[^>]*>\s*注文\s*\(#(\d+)\)\s*<\/h1>/.exec(html)
  const orderNo = orderNoMatch ? `#${orderNoMatch[1]}` : null

  const confirmedMatch = /(確認日:\s*[^<]+)/.exec(html)
  const confirmedAtText = confirmedMatch ? decodeEntities(confirmedMatch[1]).trim() : null

  const lines: OrderDetailLine[] = []
  const itemsTableMatch = /<div role="table" aria-labelledby="ResourceList[^"]*"[^>]*>/.exec(html)
  if (itemsTableMatch) {
    const tableBlock = extractDivBlock(html, itemsTableMatch.index)
    if (tableBlock) {
      for (const start of findRoleDivStarts(tableBlock, 'row')) {
        const rowBlock = extractDivBlock(tableBlock, start)
        if (!rowBlock) continue
        const line = parseOrderItemRow(rowBlock)
        if (line) lines.push(line)
      }
    }
  }

  let subtotal: number | null = null
  let shipping: number | null = null
  let discount = 0
  let total: number | null = null
  const unknownRows: string[] = []

  const moneyTableMatch = /<div role="table" aria-labelledby="MoneyLine-Heading[^"]*"[^>]*>/.exec(html)
  if (moneyTableMatch) {
    const tableBlock = extractDivBlock(html, moneyTableMatch.index)
    if (tableBlock) {
      for (const start of findRoleDivStarts(tableBlock, 'row')) {
        const rowBlock = extractDivBlock(tableBlock, start)
        if (!rowBlock) continue

        const headerStarts = findRoleDivStarts(rowBlock, 'rowheader')
        if (headerStarts.length === 0) continue // 見出し行（columnheader）は飛ばす
        const headerBlock = extractDivBlock(rowBlock, headerStarts[0])
        const label = headerBlock ? stripTags(headerBlock) : ''

        const cellStarts = findRoleDivStarts(rowBlock, 'cell')
        const cellBlock = cellStarts.length > 0 ? extractDivBlock(rowBlock, cellStarts[0]) : null
        const amount = parseMoneyCell(cellBlock)

        if (label.startsWith('小計')) {
          subtotal = amount
        } else if (label.includes('配送')) {
          shipping = amount
        } else if (label.includes('ディスカウント') || label.includes('割引')) {
          discount = amount ?? 0
        } else if (label === '合計') {
          total = amount
        } else if (label) {
          unknownRows.push(amount !== null ? `${label}=${amount}` : label)
        }
      }
    }
  }

  return { orderNo, confirmedAtText, lines, subtotal, shipping, discount, total, unknownRows }
}

/**
 * '確認日: 9月19日' のような表記から日付を推定する。年が無ければ「今年」とし、
 * それが `now` より1日を超えて未来なら前年（年末年始をまたいだ確認日）とみなす。
 */
export function inferOrderDate(text: string, now: Date): string | null {
  const m = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/.exec(text)
  if (!m) return null

  const month = Number(m[2])
  const day = Number(m[3])
  let year = m[1] ? Number(m[1]) : now.getFullYear()

  if (!m[1]) {
    const candidate = new Date(year, month - 1, day)
    const oneDayMs = 24 * 60 * 60 * 1000
    if (candidate.getTime() - now.getTime() > oneDayMs) year -= 1
  }

  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

// ------------------------------------------------------------
// 注文詳細 → 仕入（確定 or 下書き）
// ------------------------------------------------------------

/**
 * 明細の金額セルが「単価」か「行合計」かを判定し、単価の配列を返す。
 * どちらとも決められなければ null（下書きに回す）。
 */
function decideUnitPrices(detail: OrderDetail): { unitPrices: number[] | null; reason?: string } {
  const { lines, subtotal } = detail
  if (lines.length === 0) return { unitPrices: null, reason: '明細が読めません' }
  if (subtotal === null) return { unitPrices: null, reason: '小計が読めません' }

  const sumAsLineTotal = lines.reduce((s, l) => s + l.price, 0)
  const sumAsUnitPrice = lines.reduce((s, l) => s + l.price * l.quantity, 0)

  if (sumAsLineTotal === subtotal) {
    const unitPrices: number[] = []
    for (const l of lines) {
      if (l.quantity <= 0 || l.price % l.quantity !== 0) {
        return { unitPrices: null, reason: '単価が割り切れません' }
      }
      unitPrices.push(l.price / l.quantity)
    }
    return { unitPrices }
  }

  if (sumAsUnitPrice === subtotal) {
    return { unitPrices: lines.map(l => l.price) }
  }

  return {
    unitPrices: null,
    reason: `明細の合計が小計と一致しません（小計${subtotal}、行合計${sumAsLineTotal}、単価想定${sumAsUnitPrice}）`,
  }
}

function buildName(line: OrderDetailLine): string {
  return [line.title, line.variant].filter(Boolean).join(' ')
}

function buildCodeAndMaterial(line: OrderDetailLine): { model_code: string | null; series_code: string | null; material: Material | null } {
  const code = extractCode(line.title, line.variant)
  const material = extractMaterial((line.variant ?? '') + line.title)
  return {
    model_code: code?.model_code ?? null,
    series_code: code?.series_code ?? null,
    material,
  }
}

/**
 * 注文詳細から仕入の入力を組み立てる。
 * confirmed の条件：全明細の単価が整数で決まり、小計・合計が取れ、
 * 小計 + 配送 − 割引 == 合計、未知の行なし。満たさなければ draft（人が仕入タブで確定する）。
 */
export function toPurchaseInput(
  detail: OrderDetail,
  opts: { shopAccountId: string; orderedAt: string; orderNo: string; fulfillment?: Fulfillment | null },
): { kind: 'confirmed'; input: PurchaseInput } | { kind: 'draft'; input: PurchaseDraftInput; reason: string } {
  const importKey = `mellojoy:${opts.orderNo}`
  const { unitPrices, reason: priceReason } = decideUnitPrices(detail)

  const reasons: string[] = []
  if (priceReason) reasons.push(priceReason)
  if (detail.unknownRows.length > 0) reasons.push(`不明な行があります（${detail.unknownRows.join('、')}）`)
  if (detail.shipping === null) reasons.push('配送料が読めません')
  if (detail.total === null) reasons.push('合計が読めません')

  let totalsMatch = false
  if (unitPrices && detail.subtotal !== null && detail.shipping !== null && detail.total !== null) {
    const computedSubtotal = detail.lines.reduce((s, l, i) => s + unitPrices[i] * l.quantity, 0)
    const lhs = detail.subtotal + detail.shipping - detail.discount
    totalsMatch = lhs === detail.total && computedSubtotal === detail.subtotal
    if (!totalsMatch) {
      reasons.push(
        `合計が一致しません（小計${detail.subtotal}+配送${detail.shipping}−割引${detail.discount}≠合計${detail.total}）`,
      )
    }
  }

  const confirmed = unitPrices !== null && totalsMatch && reasons.length === 0

  if (confirmed && unitPrices) {
    const input: PurchaseInput = {
      shop_account_id: opts.shopAccountId,
      ordered_at: opts.orderedAt,
      order_no: opts.orderNo,
      shipping_fee: detail.shipping ?? 0,
      discount: detail.discount,
      alloc_method: 'by_amount',
      note: '注文履歴から自動取得',
      import_key: importKey,
      fulfillment: opts.fulfillment ?? null,
      lines: detail.lines.map((l, i): PurchaseLineInput => ({
        name: buildName(l),
        unit_price: unitPrices[i],
        quantity: l.quantity,
        ...buildCodeAndMaterial(l),
      })),
    }
    return { kind: 'confirmed', input }
  }

  const reason = reasons.join('。')
  const draftInput: PurchaseDraftInput = {
    import_key: importKey,
    shop_account_id: opts.shopAccountId,
    ordered_at: opts.orderedAt,
    order_no: opts.orderNo,
    shipping_fee: detail.shipping ?? undefined,
    discount: detail.discount,
    fulfillment: opts.fulfillment ?? null,
    lines: detail.lines.map((l, i) => ({
      name: buildName(l),
      quantity: l.quantity,
      unit_price: unitPrices ? unitPrices[i] : undefined,
      ...buildCodeAndMaterial(l),
    })),
    note: reason ? `注文履歴から自動取得（下書き）：${reason}` : '注文履歴から自動取得（下書き）',
  }
  return { kind: 'draft', input: draftInput, reason }
}

/**
 * 口座の import_keywords で確定済みの仕入を絞り込む。confirmed / draft の判定は
 * 絞り込む前の注文全体で終わっているので、ここでは既に確定した PurchaseInput の
 * 明細を削るだけ（判定のやり直しはしない）。
 *
 * - keywords が空なら input をそのまま返す（絞り込みなし）
 * - 一致する明細が1つも無ければ null（その注文は取り込まない）
 * - 一部だけ一致するなら、一致した明細だけに絞り、送料・割引は注文全体の金額比
 *   （一致した明細の小計 ÷ 全明細の小計）で按分する。小計が0なら按分せず0
 */
export function filterPurchaseInputByKeywords(
  input: PurchaseInput, keywords: string[],
): PurchaseInput | null {
  if (keywords.length === 0) return input

  const matched = input.lines.filter(l => db.matchesAnyKeyword(l.name, keywords))
  if (matched.length === 0) return null
  if (matched.length === input.lines.length) return input

  const fullSubtotal = input.lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const matchedSubtotal = matched.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const ratio = fullSubtotal > 0 ? matchedSubtotal / fullSubtotal : 0

  const excluded = input.lines.length - matched.length
  const addition = `キーワード不一致の明細 ${excluded} 件を除外（送料・割引は金額比で按分）`

  return {
    ...input,
    lines: matched,
    shipping_fee: Math.round((input.shipping_fee ?? 0) * ratio),
    discount: Math.round((input.discount ?? 0) * ratio),
    note: input.note ? `${input.note}\n${addition}` : addition,
  }
}

/**
 * 下書き版。下書きは単価が確定していない（quantity当たりの金額が分からない）ことがあるため、
 * 金額比の按分はできない。送料・割引は注文全体の値のまま残し、note で「確定時に見直してください」
 * と伝える。私物だけの注文が価格未入力の下書きとして要対応に出続けないよう、confirmed と同じく
 * 一致0件は null（取り込まない）にする。
 */
export function filterPurchaseDraftByKeywords(
  input: PurchaseDraftInput, keywords: string[],
): PurchaseDraftInput | null {
  if (keywords.length === 0) return input

  const matched = input.lines.filter(l => db.matchesAnyKeyword(l.name, keywords))
  if (matched.length === 0) return null
  if (matched.length === input.lines.length) return input

  const excluded = input.lines.length - matched.length
  const addition =
    `キーワード不一致の明細 ${excluded} 件を除外（送料・割引は注文全体の値。確定時に見直してください）`

  return {
    ...input,
    lines: matched,
    note: input.note ? `${input.note}\n${addition}` : addition,
  }
}

/**
 * 詳細ページの描画がまだで明細が1行も取れていない場合に true。
 * この場合は下書きも作らない（import_key 付きの空 draft が既取込扱いになり
 * 二度と取り直せなくなるのを避ける）。次回に再試行する。
 */
export function shouldSkipDetail(detail: OrderDetail): boolean {
  return detail.lines.length === 0
}

// ------------------------------------------------------------
// ログイン判定
// ------------------------------------------------------------

/** URL がログイン・認証系のページかを判定する */
export function isShopLoginUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }

  if (u.hostname === 'accounts.shopify.com') return true
  if (/\/login(\/|$)/i.test(u.pathname)) return true
  if (/\/authentication(\/|$)/i.test(u.pathname)) return true
  return false
}

// ------------------------------------------------------------
// 収集本体（electron に依存する）
// ------------------------------------------------------------

/** 現在のページが CAPTCHA・本人確認を求めていないかを見る（collector.ts と同じ流儀） */
async function isChallenge(win: BrowserWindow): Promise<boolean> {
  const url = win.webContents.getURL()
  const bodyText = await win.webContents
    .executeJavaScript(`document.body ? document.body.innerText : ''`)
    .catch(() => '') as string
  const hasCaptchaFrame = await win.webContents.executeJavaScript(`
    !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="arkose"], [data-sitekey]'
    )
  `).catch(() => false) as boolean
  return isChallengeText(url, bodyText, hasCaptchaFrame)
}

/**
 * SPA の描画を待つ。注文カードが出るか、ログインに飛ばされるか、空表示になるまで
 * 1秒間隔で最大15秒ポーリングする（クリック等はしない。見るだけ）。
 */
async function waitForOrdersReady(win: BrowserWindow): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (isShopLoginUrl(win.webContents.getURL())) return

    const ready = await win.webContents.executeJavaScript(`
      (() => {
        if (document.querySelector('article[aria-labelledby^="order-"]')) return true;
        const t = document.body ? document.body.innerText : '';
        return /注文がありません|no orders/i.test(t);
      })()
    `).catch(() => false) as boolean
    if (ready) return

    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * 詳細ページも SPA なので描画を待つ。明細表（ResourceList）が出るか、
 * ログインに飛ばされるまで 1秒間隔で最大15秒ポーリングする（クリック等はしない）。
 */
async function waitForDetailReady(win: BrowserWindow): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (isShopLoginUrl(win.webContents.getURL())) return

    const ready = await win.webContents.executeJavaScript(`
      !!document.querySelector('div[role="table"][aria-labelledby^="ResourceList"]')
    `).catch(() => false) as boolean
    if (ready) return

    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * メロジョイの注文履歴を読み、`purchase` に積む（確定 or 下書き）。
 * @param silent true なら画面を出さない
 */
export async function collectShopOrders(shopAccountId: string, silent: boolean): Promise<CollectorRun> {
  ensureShopSession(shopAccountId)
  const runId = db.startRun('mellojoy', shopAccountId)
  const win = createShopWindow(shopAccountId, !silent)
  let pagesOpened = 0
  const importKeywords = db.parseKeywords(db.getShopAccount(shopAccountId)?.import_keywords ?? '')

  try {
    await win.loadURL(ORDERS_URL)
    pagesOpened++
    await randomWait()
    await waitForOrdersReady(win)

    if (isShopLoginUrl(win.webContents.getURL())) {
      return db.finishRun(runId, 'auth_required', 0, 0, AUTH_MESSAGE)
    }
    if (await isChallenge(win)) {
      return db.finishRun(runId, 'auth_required', 0, 0, AUTH_MESSAGE)
    }

    const listUrl = win.webContents.getURL()
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML') as string
    const list = parseOrderListHtml(html)

    if (list.length === 0) {
      return db.finishRun(
        runId, 'empty', 0, 0,
        '0件でした。画面構造が変わった可能性があります',
      )
    }

    const active = list.filter(o => !o.status.includes('キャンセル'))
    const cancelledCount = list.length - active.length

    const importKeys = active.map(o => `mellojoy:${o.orderNo}`)
    const known = db.existingImportKeys(importKeys)
    const fresh = active.filter(o => !known.has(`mellojoy:${o.orderNo}`))
    const alreadyImported = active.length - fresh.length

    // 既取込の注文は詳細ページを開かず、一覧の状態表示だけで到着状態を更新する
    let fulfillmentUpdated = 0
    for (const order of active) {
      const key = `mellojoy:${order.orderNo}`
      if (!known.has(key)) continue
      if (db.updatePurchaseFulfillment(key, fulfillmentFromStatus(order.status))) {
        fulfillmentUpdated++
      }
    }

    const budget = Math.max(0, Math.min(MAX_DETAILS_PER_RUN, MAX_PAGES_PER_RUN - pagesOpened))
    const targets = fresh.slice(0, budget)

    let confirmedCount = 0
    let draftCount = 0
    let skippedByKeyword = 0
    const failures: string[] = []

    for (const order of targets) {
      if (pagesOpened >= MAX_PAGES_PER_RUN) break

      try {
        const detailUrl = new URL(order.href, listUrl).toString()
        await win.loadURL(detailUrl)
        pagesOpened++
        await randomWait()
        await waitForDetailReady(win)

        if (isShopLoginUrl(win.webContents.getURL())) {
          return db.finishRun(
            runId, 'auth_required', list.length, confirmedCount + draftCount, AUTH_MESSAGE,
          )
        }
        if (await isChallenge(win)) {
          return db.finishRun(
            runId, 'auth_required', list.length, confirmedCount + draftCount, AUTH_MESSAGE,
          )
        }

        const detailHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML') as string
        const detail = parseOrderDetailHtml(detailHtml)

        if (shouldSkipDetail(detail)) {
          failures.push(`${order.orderNo}：明細が読めませんでした（次回に再試行）`)
          continue
        }

        const orderedAt = inferOrderDate(detail.confirmedAtText ?? '', new Date()) ?? todayLocal()

        const result = toPurchaseInput(detail, {
          shopAccountId, orderedAt, orderNo: order.orderNo,
          fulfillment: fulfillmentFromStatus(order.status),
        })

        if (result.kind === 'confirmed') {
          const filtered = filterPurchaseInputByKeywords(result.input, importKeywords)
          if (filtered === null) {
            skippedByKeyword++
            continue
          }
          db.createPurchase(filtered)
          confirmedCount++
        } else {
          const filteredDraft = filterPurchaseDraftByKeywords(result.input, importKeywords)
          if (filteredDraft === null) {
            skippedByKeyword++
            continue
          }
          db.createPurchaseDraft(filteredDraft)
          draftCount++
        }
      } catch (e) {
        failures.push(`${order.orderNo}：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const parts = [
      `確定 ${confirmedCount}・下書き ${draftCount}・既取込 ${alreadyImported}・キャンセル ${cancelledCount}`,
    ]
    if (fulfillmentUpdated > 0) parts.push(`到着状態の更新 ${fulfillmentUpdated}`)
    if (skippedByKeyword > 0) parts.push(`キーワード不一致で除外 ${skippedByKeyword} 件`)
    if (fresh.length > targets.length) parts.push(`残り ${fresh.length - targets.length} 件は次回`)
    if (failures.length > 0) parts.push(`失敗：${failures.join('、')}`)

    return db.finishRun(runId, 'ok', list.length, confirmedCount + draftCount, parts.join('。'))

  } catch (e) {
    return db.finishRun(
      runId, 'failed', 0, 0,
      e instanceof Error ? e.message : String(e),
    )
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
