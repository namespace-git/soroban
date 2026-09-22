import { BrowserWindow, app, session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as db from './db'
import { extractCodes } from './code'
import { todayLocal } from '../shared/date'
import type { CollectorRun, SaleStatus } from '../shared/types'

// ============================================================
// メルカリの販売履歴を読み取る
//
// 約束：
//   * 認証情報は保存しない。保存するのは persist パーティション（Cookie）だけ
//   * 書き込み操作は一切しない。読み取り専用
//   * 連続アクセスしない。ページ間はランダム待ち、1回の実行で開くページ数に上限
//   * 取得0件は「成功」ではなく empty（異常の疑い）として記録する
//   * 普通の Chrome として見える（UA・Accept-Language・通常ウィンドウ）。
//     自動化を示すものは足さない
//   * CAPTCHA・本人確認の「本物の兆候」が出たら即座に止めて人に渡す。
//     ただし「本人確認前」のような通常のマイページ文言では止めない
// ============================================================

const PARTITION = 'persist:mercari'
// 販売履歴ページ：商品タイトル・価格・販売手数料・送料・他費用・購入完了日が表で並ぶ。
// 一覧（/mypage/listings/completed）より情報量が多く、実額の取得源として正とする
const LISTINGS_URL = 'https://jp.mercari.com/mypage/listings/sold'
// 出品した商品「出品中」タブ。ここから出品と在庫の引き当てを取り込む
const MY_LISTINGS_URL = 'https://jp.mercari.com/mypage/listings'
// 出品した商品「取引中」タブ。購入されたが未入金〜発送待ち〜受取評価待ちの取引がここに出る。
// 「発送してください」は放置すると評価が下がるので、ここから状態を拾ってホームで目立たせる
const IN_PROGRESS_URL = 'https://jp.mercari.com/mypage/listings/in_progress'
const LOGIN_URL = 'https://jp.mercari.com/login'

/** 1回の収集で開くページ数の上限（一覧1＋詳細最大5）。超えたら次回に回す */
const MAX_PAGES_PER_RUN = 6

/**
 * 1回の収集でサムネイルを保存する上限。新規1件につき画像1枚（ユーザー承認済み）。
 * 既に保存済みの販売は、画像URLが変わっていなければ再取得しない＝
 * 「画像が変わったときだけもう一度」の約束。残りは諦めてよく、次回への
 * 持ち越しはしない（失敗・上限超過を再試行しない）
 */
const MAX_THUMBS_PER_RUN = 30

/**
 * 1回の収集で購入日時を取りに行く取引画面（/transaction/）の上限。
 * まだ取れていない販売だけを対象にし、一度試みたら null でも「試行済み」として
 * 記録し、再試行しない（サムネイルと同じ流儀）
 */
const MAX_PURCHASED_AT_PER_RUN = 3

export const CHALLENGE_MESSAGE =
  '本人確認（CAPTCHA）が出ました。開いたウィンドウで完了してから、もう一度「取り込む」を押してください'

export interface ScrapedSale {
  mercariItemId: string
  title: string
  price: number
  /** 販売手数料。取れなければ null */
  fee: number | null
  /** 送料。0（着払い等）も正当な実額。取れなければ（'---'）null */
  shippingFee: number | null
  /** 他費用。列は増やさないので raw に残すだけに使う */
  otherCost: number | null
  soldAt: string
  /** 商品サムネイルのURL。取れなければ null */
  thumbUrl: string | null
}

/**
 * ページ遷移後の待機ミリ秒（2,000〜6,000のランダム）。
 * 連打しないための間でもある。
 */
export function randomWaitMs(): number {
  return 2000 + Math.floor(Math.random() * (6000 - 2000 + 1))
}

/** ページ遷移後のランダム待ち。並列アクセスを避けるため呼び出し側は直列に待つこと */
export function randomWait(): Promise<void> {
  return sleep(randomWaitMs())
}

/**
 * 同じ Chromium メジャーバージョンの、通常の Chrome の UA 文字列を組み立てる。
 * Electron 既定の UA（Electron/soroban を含む）は自動化がバレやすいので使わない。
 */
export function buildUserAgent(platform: NodeJS.Platform, chromeMajor: string): string {
  if (platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 `
      + `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 `
    + `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
}

/**
 * URL・本文テキストから CAPTCHA・本人確認の「本物の兆候」を判定する。
 *
 * マイページの本文には（サイドメニューやバッジで）「本人確認」という語が
 * 普通に出るため、その語だけでは止めない。締めた条件：
 *   * URL に captcha / challenge / verify / /auth/ が含まれる
 *   * CAPTCHA の iframe・data-sitekey が DOM にある（hasCaptchaFrame。isChallenge(win) 側で判定）
 *   * 本文が短い（1500文字未満）かつ「ロボットではありません」「captcha」「認証コード」を含む
 *     （本文が長い通常のマイページで、これらの語がノイズとして混ざるのを避ける）
 *
 * electron に依存しない純粋関数。
 */
export function isChallengeText(url: string, bodyText: string, hasCaptchaFrame = false): boolean {
  if (hasCaptchaFrame) return true

  if (/captcha|challenge|verify|\/auth\//i.test(url)) return true

  if (bodyText.length < 1500) {
    const lower = bodyText.toLowerCase()
    if (lower.includes('ロボットではありません') || lower.includes('captcha') || lower.includes('認証コード')) {
      return true
    }
  }

  return false
}

/** 販売履歴テーブルの1行（parseSoldHtml の要素） */
export type SoldRow = ScrapedSale

/**
 * 金額セルのテキストから整数を抜く。「---」は未確定（null）、それ以外の数字は
 * 0 を含めてそのまま実額として扱う（送料 ¥0 ＝着払いは正当な値）。
 */
function parseAmountCell(text: string | undefined): number | null {
  if (!text) return null
  if (text.includes('---')) return null
  const digits = text.replace(/[^\d]/g, '')
  return digits ? parseInt(digits, 10) : null
}

/** 'YYYY/MM/DD' → 'YYYY-MM-DD'。読めなければ null */
function parseSoldDateCell(text: string | undefined): string | null {
  const m = text ? /(\d{4})\/(\d{2})\/(\d{2})/.exec(text) : null
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * 販売履歴テーブルの1行を組み立てる。ブラウザ内 JS（scrape）と同じロジックを
 * 文字列ベースで再現したもの。fixture のテストに使う。
 *
 * @param href 商品リンクの href（`/transaction/mXXXXXXXXXX`）
 * @param titleText リンクの textContent
 * @param cellTexts `<td>` の並び。0=商品タイトル欄, 1=商品価格, 2=販売手数料, 3=送料,
 *   4=他費用, 5=税率, 6=販売利益, 7=寄付, 8=購入完了日（0・5・6・7 は使わない）
 * @param thumbUrl 行内 `img[src]` から拾ったサムネイルURL。取れなければ null
 */
export function parseSoldRow(
  href: string, titleText: string, cellTexts: string[], thumbUrl: string | null = null,
): SoldRow | null {
  const idMatch = /m\d{9,}/.exec(href)
  if (!idMatch) return null

  const title = titleText.trim()
  if (!title) return null

  const price = parseAmountCell(cellTexts[1])
  const soldAt = parseSoldDateCell(cellTexts[8])
  if (price === null || !soldAt) return null

  return {
    mercariItemId: idMatch[0],
    title,
    price,
    fee: parseAmountCell(cellTexts[2]),
    shippingFee: parseAmountCell(cellTexts[3]),
    otherCost: parseAmountCell(cellTexts[4]),
    soldAt,
    thumbUrl,
  }
}

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
 * 販売履歴ページの HTML から行を抜く（jsdom なしの簡易パース）。
 * 実ブラウザの DOM 構造とは別経路だが、fixture を使ったテストのために用意する。
 * クラス名は使わず、data-testid・href・列の並びだけに依存する。
 */
export function parseSoldHtml(html: string): SoldRow[] {
  const bodyMatch = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)
  if (!bodyMatch) return []
  const tbodyHtml = bodyMatch[1]

  const rows: SoldRow[] = []
  const trRe = /<tr>([\s\S]*?)<\/tr>/g
  let trMatch: RegExpExecArray | null
  while ((trMatch = trRe.exec(tbodyHtml))) {
    const rowHtml = trMatch[1]

    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
    let soldLink: RegExpExecArray | null = null
    let am: RegExpExecArray | null
    while ((am = anchorRe.exec(rowHtml))) {
      if (/data-testid="sold-item-link"/.test(am[1])) { soldLink = am; break }
    }
    if (!soldLink) continue

    const hrefMatch = /href="([^"]*)"/.exec(soldLink[1])
    const href = hrefMatch ? hrefMatch[1] : ''
    const titleText = stripTags(soldLink[2])

    // サムネイルは <img src="..."> が行内に1つだけある（タイトルのリンクの外、同じ<td>内）
    const imgMatch = /<img\b[^>]*\bsrc="([^"]*)"/.exec(rowHtml)
    const thumbUrl = imgMatch ? imgMatch[1] : null

    const cellTexts: string[] = []
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g
    let tm: RegExpExecArray | null
    while ((tm = tdRe.exec(rowHtml))) cellTexts.push(stripTags(tm[1]))

    const row = parseSoldRow(href, titleText, cellTexts, thumbUrl)
    if (row) rows.push(row)
  }
  return rows
}

/** 「1件～18件（全18件）」のような表示から総件数を抜く。読めなければ null */
export function extractTotalCount(bodyText: string): number | null {
  const m = /全([\d,]+)件/.exec(bodyText)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null
}

/** 出品した商品「出品中」タブの1件（parseListingsHtml の要素） */
export interface ScrapedListing {
  mercariItemId: string
  title: string
  price: number
  /** 「公開停止中」の表示があるか */
  suspended: boolean
  /** 商品サムネイルのURL。取れなければ null */
  thumbUrl: string | null
  /** 「17日前に更新」等の表示。出品日（listed_at）の推定に使う。取れなければ null */
  updatedText: string | null
  /** いいね数。取れなければ null */
  likes: number | null
}

/**
 * 「出品した商品 › 出品中」タブ（`https://jp.mercari.com/mypage/listings`）の
 * HTML から出品を抜く（jsdom なしの簡易パース。fixture テスト用）。
 *
 * ⚠ セレクタは実DOM（fixtures/mercari-listings.html）に基づくが、クラス名はハッシュで
 *   変わるため使っていない。商品リンク（`a[href*="/item/m"]`、data-testid="listed-item"）
 *   を起点にし、タイトルは `[data-testid="item-label"]`、価格は `[data-testid="price"]`
 *   の数字、サムネイルは `img[src]` から拾う。「公開停止中」の文字列があれば suspended。
 *   更新日時は「n日前に更新」等のテキストをそのまま拾う（listed_at の推定は db.ts 側）。
 *   いいね数はアイコン付きの3つの数字（コメント・閲覧・いいね）のうち、更新日時の直前に
 *   並ぶ最後の数字（svg の直後）を使う。
 */
export function parseListingsHtml(html: string): ScrapedListing[] {
  const listMatch = /<ul\b[^>]*data-testid="listed-item-list"[^>]*>([\s\S]*?)<\/ul>/.exec(html)
  if (!listMatch) return []
  const listHtml = listMatch[1]

  const rows: ScrapedListing[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let am: RegExpExecArray | null
  while ((am = anchorRe.exec(listHtml))) {
    const attrs = am[1]
    if (!/data-testid="listed-item"/.test(attrs)) continue
    const content = am[2]

    const hrefMatch = /href="([^"]*)"/.exec(attrs)
    const idMatch = hrefMatch ? /m\d{9,}/.exec(hrefMatch[1]) : null
    if (!idMatch) continue

    const titleMatch = /<p\b[^>]*data-testid="item-label"[^>]*>([\s\S]*?)<\/p>/.exec(content)
    const title = titleMatch ? stripTags(titleMatch[1]) : ''
    if (!title) continue

    // 価格は ¥ と数字が別 span のことがある（<span data-testid="price">…<span>¥</span>
    // <span>2,350</span></span>）。外側の <span> の中身をまるごと拾ってから数字だけ抜く
    const priceMatch = /<span\b[^>]*data-testid="price"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(content)
    const priceDigits = priceMatch ? stripTags(priceMatch[1]).replace(/[^\d]/g, '') : ''
    if (!priceDigits) continue

    const imgMatch = /<img\b[^>]*\bsrc="([^"]*)"/.exec(content)

    const updatedMatch = /(\d+(?:日|時間|分)前に更新)/.exec(content)
    const updatedText = updatedMatch ? updatedMatch[1] : null

    // アイコン＋数字（コメント・閲覧・いいね）が並ぶ。クラス名はハッシュなので使わず、
    // 「svg の直後の数字」を順に拾い、最後（更新日時の直前）をいいね数とする
    const svgNumRe = /<svg\b[^>]*>\s*<\/svg>\s*<span\b[^>]*>(\d+)<\/span>/g
    let likes: number | null = null
    let sm: RegExpExecArray | null
    while ((sm = svgNumRe.exec(content))) likes = parseInt(sm[1], 10)

    rows.push({
      mercariItemId: idMatch[0],
      title,
      price: parseInt(priceDigits, 10),
      suspended: /公開停止中/.test(content),
      thumbUrl: imgMatch ? imgMatch[1] : null,
      updatedText,
      likes,
    })
  }
  return rows
}

/** 「出品した商品」の総件数（`data-testid="total-item-count"` の「22件」）。読めなければ null */
export function extractListingTotal(html: string): number | null {
  const pMatch = /<p\b[^>]*data-testid="total-item-count"[^>]*>([\s\S]*?)<\/p>/.exec(html)
  if (!pMatch) return null
  const m = /([\d,]+)件/.exec(pMatch[1])
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null
}

/** 取引中タブの1件（parseInProgressHtml の要素） */
export interface ScrapedTransaction {
  mercariItemId: string
  title: string
  price: number
  /** 状態の生の文言（「発送してください」等）。status が読めなくても記録は残す */
  statusText: string
  /** 文言から解釈した状態。未知の文言なら null（waiting_shipment 等に決め打たない） */
  status: SaleStatus | null
  /** 「3時間前に更新」等の表示。取れなければ null */
  updatedText: string | null
  /** 商品サムネイルのURL。取れなければ null */
  thumbUrl: string | null
}

/**
 * 取引中タブ（`/mypage/listings/in_progress`）の状態文言から SaleStatus を判定する。
 *   支払いをしてください／支払い待ち   → waiting_payment（購入されたが未入金）
 *   発送してください／発送待ち         → waiting_shipment（入金済み。こちらが発送する）
 *   受取評価待ち                       → shipped（発送済み。買い手の受取待ち）
 *   評価をしてください                 → delivered（買い手が受取評価済み。こちらの評価待ち）
 * 未知の文言（i18n・表記ゆれ等）は null を返す。waiting_shipment に決め打つと
 * 実際には発送不要な取引まで「要対応」に出てしまうため
 */
function mapInProgressStatusText(text: string): SaleStatus | null {
  if (text.includes('支払い')) return 'waiting_payment'
  if (text.includes('発送してください') || text.includes('発送待ち')) return 'waiting_shipment'
  if (text.includes('受取評価待ち')) return 'shipped'
  if (text.includes('評価をしてください')) return 'delivered'
  return null
}

/**
 * 「出品した商品 › 取引中」タブの HTML から取引を抜く（jsdom なしの簡易パース。fixture テスト用）。
 *
 * ⚠ セレクタは実DOM（fixtures/mercari-in-progress.html）に基づくが、クラス名はハッシュで
 *   変わるため使っていない。parseListingsHtml と同じ流儀：商品リンク（`a[href*="/transaction/m"]`、
 *   data-testid="listed-item"）を起点にし、タイトルは `[data-testid="item-label"]`、価格は
 *   `[data-testid="price"]` の数字、サムネイルは `img[src]` から拾う。状態の文言は
 *   「n日前／n時間前／n分前に更新」の直後に来る最初の `<span>` のテキスト（受取評価待ち等）。
 */
export function parseInProgressHtml(html: string): ScrapedTransaction[] {
  const listMatch = /<ul\b[^>]*data-testid="listed-item-list"[^>]*>([\s\S]*?)<\/ul>/.exec(html)
  if (!listMatch) return []
  const listHtml = listMatch[1]

  const rows: ScrapedTransaction[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let am: RegExpExecArray | null
  while ((am = anchorRe.exec(listHtml))) {
    const attrs = am[1]
    if (!/data-testid="listed-item"/.test(attrs)) continue
    const content = am[2]

    const hrefMatch = /href="([^"]*)"/.exec(attrs)
    const idMatch = hrefMatch ? /m\d{9,}/.exec(hrefMatch[1]) : null
    if (!idMatch) continue

    const titleMatch = /<p\b[^>]*data-testid="item-label"[^>]*>([\s\S]*?)<\/p>/.exec(content)
    const title = titleMatch ? stripTags(titleMatch[1]) : ''
    if (!title) continue

    const priceMatch = /<span\b[^>]*data-testid="price"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(content)
    const priceDigits = priceMatch ? stripTags(priceMatch[1]).replace(/[^\d]/g, '') : ''
    if (!priceDigits) continue

    const imgMatch = /<img\b[^>]*\bsrc="([^"]*)"/.exec(content)

    const updatedMatch = /(\d+(?:日|時間|分)前に更新)/.exec(content)
    const updatedText = updatedMatch ? updatedMatch[1] : null

    // 状態の文言は更新日時の直後に来る最初の <span> のテキスト
    let statusText = ''
    if (updatedMatch) {
      const rest = content.slice(updatedMatch.index + updatedMatch[0].length)
      const statusMatch = /<span\b[^>]*>([\s\S]*?)<\/span>/.exec(rest)
      statusText = statusMatch ? stripTags(statusMatch[1]) : ''
    }

    rows.push({
      mercariItemId: idMatch[0],
      title,
      price: parseInt(priceDigits, 10),
      statusText,
      status: mapInProgressStatusText(statusText),
      updatedText,
      thumbUrl: imgMatch ? imgMatch[1] : null,
    })
  }
  return rows
}

/** 取引中タブの総件数（`data-testid="transaction-filter-menu"` 内の「4件」）。読めなければ null */
export function extractInProgressTotal(html: string): number | null {
  const m = /data-testid="transaction-filter-menu"[\s\S]*?<span\b[^>]*>([\d,]+)件<\/span>/.exec(html)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null
}

function pad2(n: string): string {
  return n.padStart(2, '0')
}

/** ラベルの後ろに続く日時テキストから 'YYYY-MM-DDTHH:mm'（時刻なしなら 'YYYY-MM-DD'）を組み立てる */
function parseDateTimeAfterLabel(text: string): string | null {
  // 'YYYY/MM/DD'（+ 任意の 'HH:MM'）。区切りは改行・空白・コロン混じりでもよい
  const slash = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[^\d]{0,10}?(\d{1,2}):(\d{2}))?/.exec(text)
  // 'YYYY年M月D日'（+ 任意の 'HH:MM'）
  const kanji = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:[^\d]{0,10}?(\d{1,2}):(\d{2}))?/.exec(text)
  const m = slash ?? kanji
  if (!m) return null

  const date = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
  if (m[4] && m[5]) return `${date}T${pad2(m[4])}:${pad2(m[5])}`
  return date
}

/**
 * 取引画面（`https://jp.mercari.com/transaction/mXXXXXXXXXX`）の本文（innerText）から
 * 「購入日時」の値を読む。ラベルは「購入日時」→「購入日」の順で探す。
 * 「購入完了日」は別物（出品者側の完了操作日）なので、先に取り除いてから探す。
 * 見つからなければ null。
 */
export function parsePurchasedAt(text: string): string | null {
  const cleaned = text.replace(/購入完了日/g, '')

  for (const label of ['購入日時', '購入日']) {
    const idx = cleaned.indexOf(label)
    if (idx === -1) continue
    const rest = cleaned.slice(idx + label.length, idx + label.length + 60)
    const parsed = parseDateTimeAfterLabel(rest)
    if (parsed) return parsed
  }
  return null
}

function createWindow(show: boolean): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    show,
    title: 'メルカリ',
    webPreferences: {
      partition: PARTITION,
      // メルカリのページを読むだけ。Node統合は切る
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
}

/**
 * ログイン用ウィンドウを開く。
 * ユーザーが手でログインし、Cookieがプロファイルに残る。
 */
export function openLoginWindow(): Promise<void> {
  return new Promise((resolve) => {
    const win = createWindow(true)
    win.loadURL(LOGIN_URL)
    win.on('closed', () => resolve())
  })
}

/**
 * ログイン済みかを判定する。
 * URLがログインページへ飛ばされていないかで見るのが最も壊れにくい。
 */
async function isLoggedIn(win: BrowserWindow): Promise<boolean> {
  const url = win.webContents.getURL()
  if (url.includes('/login') || url.includes('/signin')) return false

  const hasMain = await win.webContents
    .executeJavaScript(`!!document.querySelector('main')`)
    .catch(() => false)
  return Boolean(hasMain)
}

/**
 * silent 実行中に CAPTCHA・本人確認が出たら、そのウィンドウを表示して人に渡す。
 * タイトルを差し替えて「これは何のウィンドウか」を分かるようにする。
 * 呼び出し側は、これを呼んだら finally での `destroy()` をスキップしてウィンドウを
 * 残すこと（人が完了して自分で閉じる。閉じたら何もしない）。
 */
export function revealForChallenge(win: BrowserWindow): void {
  win.setTitle('そろばん — 本人確認を完了してください')
  if (!win.isVisible()) win.show()
}

/** 現在のページが CAPTCHA・本人確認を求めていないかを見る */
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
 * 販売履歴（表）から取引と、ページ上部の総件数を抽出する。
 *
 * ⚠ セレクタは実DOM（fixtures/mercari-sold.html）に基づくが、クラス名はハッシュで
 *   変わるため使っていない。data-testid・href・列の並びが変わったら要調整。
 *
 * 方針：
 *   * 商品リンクは `a[data-testid="sold-item-link"]` を起点にする
 *   * 列の並び（価格・手数料・送料・他費用・購入完了日）はヘッダの順で固定と仮定する
 *   * 金額セルは ¥ と数字が別 span のことがあるため textContent から数字だけを拾う。
 *     「---」は null（送料 ¥0 は正当な実額として 0 を返す）
 */
async function scrape(win: BrowserWindow): Promise<{ sales: ScrapedSale[]; totalCount: number | null }> {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const parseAmount = (text) => {
        if (!text || text.includes('---')) return null;
        const digits = text.replace(/[^\\d]/g, '');
        return digits ? parseInt(digits, 10) : null;
      };

      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const out = [];
      for (const tr of rows) {
        const a = tr.querySelector('a[data-testid="sold-item-link"]');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const m = href.match(/m\\d{9,}/);
        if (!m) continue;

        const title = (a.textContent || '').trim();
        const tds = Array.from(tr.querySelectorAll('td'));
        const cellText = (i) => (tds[i] ? (tds[i].textContent || '').trim() : '');

        const price = parseAmount(cellText(1));
        const fee = parseAmount(cellText(2));
        const shippingFee = parseAmount(cellText(3));
        const otherCost = parseAmount(cellText(4));

        const dm = cellText(8).match(/(\\d{4})\\/(\\d{2})\\/(\\d{2})/);
        const soldAt = dm ? \`\${dm[1]}-\${dm[2]}-\${dm[3]}\` : null;

        const img = tr.querySelector('img[src]');
        const thumbUrl = img ? img.getAttribute('src') : null;

        if (!title || price === null || !soldAt) continue;
        out.push({
          mercariItemId: m[0], title: title.slice(0, 200), price, fee, shippingFee, otherCost, soldAt,
          thumbUrl,
        });
      }

      const seen = new Set();
      const sales = out.filter(x => {
        if (seen.has(x.mercariItemId)) return false;
        seen.add(x.mercariItemId);
        return true;
      });

      const bodyText = document.body ? document.body.innerText : '';
      const tm = bodyText.match(/全([\\d,]+)件/);
      const totalCount = tm ? parseInt(tm[1].replace(/,/g, ''), 10) : null;

      return { sales, totalCount };
    })()
  `) as { sales: ScrapedSale[]; totalCount: number | null }

  return result
}

/**
 * 販売詳細ページから説明文だけを読む（型番救済のため）。
 * 実額はここでは取らない（販売履歴の表を正とする）。
 *
 * ⚠ セレクタは未検証。DevTools で実際のDOMを確認して調整すること。
 */
async function scrapeDetail(win: BrowserWindow): Promise<{ description: string | null } | null> {
  const description = await win.webContents.executeJavaScript(`
    (() => {
      const els = Array.from(
        document.querySelectorAll('[data-testid*="description"], section, article')
      );
      let best = '';
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t.length > best.length) best = t;
      }
      return best || null;
    })()
  `).catch(() => null) as string | null

  if (description === null) return null
  return { description }
}

function toRow(s: ScrapedSale): {
  mercariItemId: string
  title: string
  price: number
  soldAt: string
  fee?: number | null
  shippingFee?: number | null
  otherCost?: number | null
  status?: SaleStatus | null
} {
  return {
    mercariItemId: s.mercariItemId,
    title: s.title,
    price: s.price,
    soldAt: s.soldAt,
    fee: s.fee,
    shippingFee: s.shippingFee,
    otherCost: s.otherCost,
    // 販売履歴（sold）タブに出ている時点で取引完了（購入完了日つき）
    status: 'completed',
  }
}

/** サムネイル保存先ディレクトリ（無ければ作る） */
function ensureThumbDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * サムネイルのファイル名。`${mercariItemId}-${hash8}.jpg`（hash8 は正規化後URLの
 * sha1 先頭8桁）。同じ画像（正規化後のURLが同じ）なら常に同じ名前になり、画像が
 * 変わった（＝URLが変わった）ときだけ別名になる＝差し替えを検知できる。
 */
export function thumbFileName(mercariItemId: string, url: string): string {
  const src = db.normalizeThumbSrc(url)
  const hash8 = createHash('sha1').update(src).digest('hex').slice(0, 8)
  return `${mercariItemId}-${hash8}.jpg`
}

/**
 * 同じ mercariItemId の旧サムネイルファイル（今回保存したもの以外）を消す。
 * `${id}.jpg`（旧形式）・`${id}-*.jpg`（旧ハッシュ）のどちらも対象。
 * 失敗しても収集全体は止めない（消し損ねても次回また試みればよい）。
 */
async function cleanupOldThumbFiles(dir: string, mercariItemId: string, keepFile: string): Promise<void> {
  try {
    const names = await readdir(dir)
    const stale = names.filter(n =>
      n !== keepFile && (n === `${mercariItemId}.jpg` || n.startsWith(`${mercariItemId}-`)))
    await Promise.all(stale.map(n => unlink(join(dir, n)).catch(() => {})))
  } catch {
    // ディレクトリが読めない等は無視
  }
}

/**
 * 一覧に写っているサムネイルを1枚取得してファイルに保存し、ファイル名と正規化後URL
 * （DB保存用）を返す。書き込み操作ではない（画像のGETのみ）。session.fetch を使うことで、
 * 普通のブラウザの画像取得と同じ Cookie/UA に見える。保存できたら、同じ商品IDの
 * 旧ファイルを削除する。
 */
async function downloadThumbFile(
  mercariItemId: string, url: string,
): Promise<{ file: string; src: string }> {
  const res = await session.fromPartition(PARTITION).fetch(url)
  if (!res.ok) throw new Error(`サムネイル取得に失敗しました（${res.status}）: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const file = thumbFileName(mercariItemId, url)
  const src = db.normalizeThumbSrc(url)
  const dir = ensureThumbDir()
  await writeFile(join(dir, file), buf)
  await cleanupOldThumbFiles(dir, mercariItemId, file)
  return { file, src }
}

async function downloadThumb(saleId: string, mercariItemId: string, url: string): Promise<void> {
  const { file, src } = await downloadThumbFile(mercariItemId, url)
  db.setSaleThumb(saleId, file, src)
}

/** 保存に成功した数（saved）と、実際にリクエストを試みた数（attempted）。予算は attempted で減らす */
export interface ThumbSaveResult {
  saved: number
  attempted: number
}

/**
 * サムネイルを保存する。対象は `db.salesNeedingThumb` が返す「まだ取れていない」
 * 「画像URLが変わった」販売（未取得が先に並ぶ）。上限は呼び出し側が `limit` で切る
 * （試みた数で減らす＝失敗が多くても2倍のリクエストにはならない）。各画像の間に
 * 300〜800ms 待つ（連打しない）。失敗しても再試行せず、収集全体も失敗にしない。
 */
async function saveNewThumbs(
  targets: Array<{ id: string; mercariItemId: string; thumbUrl: string }>,
  limit: number,
): Promise<ThumbSaveResult> {
  const list = targets.slice(0, Math.max(0, limit))

  let saved = 0
  let attempted = 0
  for (const t of list) {
    attempted++
    try {
      await downloadThumb(t.id, t.mercariItemId, t.thumbUrl)
      saved++
    } catch {
      // 失敗しても再試行しない
    }
    await sleep(300 + Math.floor(Math.random() * 500))
  }
  return { saved, attempted }
}

/**
 * 出品（listing）版のサムネイル保存。saveNewThumbs と同じ約束（画像が変わったときだけ
 * もう一度・連打しない・失敗を再試行しない）で、`db.setListingThumb` に書く。予算は
 * 呼び出し側が `saveNewThumbs` と合算で管理する（1回の収集でサムネイルは合計
 * `MAX_THUMBS_PER_RUN` 枚まで）。
 */
async function saveNewListingThumbs(
  targets: Array<{ id: string; thumbUrl: string }>,
  limit: number,
): Promise<ThumbSaveResult> {
  const list = targets.slice(0, Math.max(0, limit))

  let saved = 0
  let attempted = 0
  for (const t of list) {
    attempted++
    try {
      const { file, src } = await downloadThumbFile(t.id, t.thumbUrl)
      db.setListingThumb(t.id, file, src)
      saved++
    } catch {
      // 失敗しても再試行しない
    }
    await sleep(300 + Math.floor(Math.random() * 500))
  }
  return { saved, attempted }
}

/**
 * 収集を1回実行する。
 * @param silent true なら画面を出さない（起動時の自動実行）
 */
export async function collect(silent: boolean): Promise<CollectorRun> {
  const runId = db.startRun('mercari')
  const win = createWindow(!silent)
  let pagesOpened = 0
  // CAPTCHA・本人確認が出たときは、非表示で走っていてもウィンドウを見せて残す
  // （finally での destroy をスキップする）
  let keepWindowOpen = false

  try {
    await win.loadURL(LISTINGS_URL)
    pagesOpened++
    await randomWait()

    if (await isChallenge(win)) {
      keepWindowOpen = true
      revealForChallenge(win)
      return db.finishRun(runId, 'auth_required', 0, 0, CHALLENGE_MESSAGE)
    }

    if (!(await isLoggedIn(win))) {
      // 自動ログインは試みない。2段階認証もあるし、
      // 認証情報を持たない設計にしている
      return db.finishRun(
        runId, 'auth_required', 0, 0,
        'セッションが切れています。「メルカリにログイン」から入り直してください',
      )
    }

    const { sales, totalCount } = await scrape(win)
    // 販売0件は即 empty にしない（Codexレビュー指摘）。出品中タブも読んでから、
    // 両方0件のときだけ「異常の疑い」として empty にする
    const salesEmpty = sales.length === 0

    let inserted = 0
    let updated = 0
    let thumbsSaved = 0
    let thumbsAttempted = 0
    let excludedByKeyword = 0
    let excludedDeleted = 0
    let excludedKnownByKeyword = 0

    if (!salesEmpty) {
      const known = db.existingMercariIds(sales.map(s => s.mercariItemId))
      const freshSalesAll = sales.filter(s => !known.has(s.mercariItemId))
      const knownScraped = sales.filter(s => known.has(s.mercariItemId))

      // 削除した販売（sale_exclusion）は再取り込みしない。挿入の前に弾く
      const freshSalesNotDeleted = freshSalesAll.filter(s => !db.isMercariItemExcluded(s.mercariItemId))
      excludedDeleted += freshSalesAll.length - freshSalesNotDeleted.length

      // キーワードが設定されていれば、出品中タブと同じ規則（タイトル一致）で絞る。
      // 不一致のものは insertCollected に渡さない＝詳細ページもサムネイルも取りに行かない
      const keywords = db.parseKeywords(db.getSettings().mercari_keyword ?? '')
      const freshSales = keywords.length > 0
        ? freshSalesNotDeleted.filter(s => db.matchesAnyKeyword(s.title, keywords))
        : freshSalesNotDeleted
      excludedByKeyword = freshSalesNotDeleted.length - freshSales.length

      const insertedRows = freshSales.length > 0 ? db.insertCollected(freshSales.map(toRow)) : []
      inserted = insertedRows.length
      const knownRows = knownScraped.map(toRow)
      updated = knownRows.length > 0 ? db.updateCollectedActuals(knownRows) : 0

      // サムネイル対象：新規に入れた分 ＋ 今回の一覧に出ていて画像がまだ／画像URLが
      // 変わった既存分（db.salesNeedingThumb が判定する）。実DBに元からあった販売は
      // 「新規」ではないので、後者を含めないと永久にサムネが付かない。既知分は
      // 「現在のキーワードに一致する」ものだけを対象にする（キーワードを変えた後、
      // 既に取り込んだ不一致の販売にサムネを取りに行かないため。判定は新規と同じ関数）
      const knownScrapedMatched = keywords.length > 0
        ? knownScraped.filter(s => db.matchesAnyKeyword(s.title, keywords))
        : knownScraped
      excludedKnownByKeyword = knownScraped.length - knownScrapedMatched.length

      const thumbTargets = db.salesNeedingThumb([...freshSales, ...knownScrapedMatched])
      const thumbsResult = await saveNewThumbs(thumbTargets, MAX_THUMBS_PER_RUN)
      thumbsSaved = thumbsResult.saved
      thumbsAttempted = thumbsResult.attempted
    }

    // 出品した商品「出品中」タブ（1ページ）。売却済みの後に読む。販売が0件でも読む
    // （販売0件イコール出品も何も変化していない、とは限らないため）。
    // キーワード設定があればタイトルが一致するものだけ取り込む
    let listingInserted = 0
    let listingUpdated = 0
    let listingThumbsSaved = 0
    let listingThumbsAttempted = 0
    let listingsScraped = 0
    let listingBrokenMessage: string | null = null

    if (pagesOpened < MAX_PAGES_PER_RUN) {
      await win.loadURL(MY_LISTINGS_URL)
      pagesOpened++
      await randomWait()

      if (await isChallenge(win)) {
        keepWindowOpen = true
        revealForChallenge(win)
        return db.finishRun(runId, 'auth_required', sales.length, inserted, CHALLENGE_MESSAGE)
      }

      const listingsHtml = await win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .catch(() => '') as string
      const scrapedListings = parseListingsHtml(listingsHtml)
      listingsScraped = scrapedListings.length
      const listingTotal = extractListingTotal(listingsHtml)

      if (scrapedListings.length === 0 && listingTotal !== null && listingTotal >= 1) {
        // 総数（「n件」）は読めているのに1件も解析できない＝一覧の入れ物（listed-item-list）
        // の構造が変わった疑い。空を握りつぶさず記録する
        listingBrokenMessage =
          `出品中タブの構造が変わった可能性（総数 ${listingTotal} 件・解析 0 件）`
      } else if (scrapedListings.length === 0 && !listingsHtml.includes('data-testid="mypage-main-content"')) {
        // ページの入れ物ごと見つからない＝セレクタが壊れている疑い
        listingBrokenMessage = '出品中タブの構造が変わっている可能性があります'
      } else {
        const keywords = db.parseKeywords(db.getSettings().mercari_keyword ?? '')
        const targetListings = keywords.length > 0
          ? scrapedListings.filter(l => db.matchesAnyKeyword(l.title, keywords))
          : scrapedListings

        const result = db.upsertListings(targetListings.map(l => ({
          mercariItemId: l.mercariItemId,
          title: l.title,
          price: l.price,
          suspended: l.suspended,
          thumbUrl: l.thumbUrl,
          updatedText: l.updatedText,
          likes: l.likes,
        })))
        listingInserted = result.inserted
        listingUpdated = result.updated

        // 残りのサムネイル予算（サムネイルは1回の収集で販売・出品合わせて30枚まで。
        // 「保存できた数」ではなく「試みた数」で減らす。失敗が多いと2倍のリクエストに
        // なってしまうため（Codexレビュー指摘）
        const listingThumbTargets = db.listingsNeedingThumb(
          targetListings.map(l => ({ mercariItemId: l.mercariItemId, thumbUrl: l.thumbUrl })),
        )
        const listingThumbsResult = await saveNewListingThumbs(
          listingThumbTargets, MAX_THUMBS_PER_RUN - thumbsAttempted,
        )
        listingThumbsSaved = listingThumbsResult.saved
        listingThumbsAttempted = listingThumbsResult.attempted
      }
    }

    // 出品した商品「取引中」タブ（1ページ）。出品中タブの後に読む。購入されたが未入金〜
    // 発送待ち〜受取評価待ちの取引がここに出る。既知の販売は状態だけ更新、未知は
    // 新しい販売として取り込む（soldAt は今日。本当の購入完了日は売却済み一覧が来たら直す）
    let inProgressScraped = 0
    let inProgressIds = new Set<string>()
    let inProgressNew = 0
    let inProgressUpdated = 0
    let inProgressUnknownStatus = 0
    let inProgressThumbsSaved = 0
    let inProgressBrokenMessage: string | null = null

    if (pagesOpened < MAX_PAGES_PER_RUN) {
      await win.loadURL(IN_PROGRESS_URL)
      pagesOpened++
      await randomWait()

      if (await isChallenge(win)) {
        keepWindowOpen = true
        revealForChallenge(win)
        return db.finishRun(runId, 'auth_required', sales.length, inserted, CHALLENGE_MESSAGE)
      }

      const inProgressHtml = await win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .catch(() => '') as string
      const scrapedTransactions = parseInProgressHtml(inProgressHtml)
      inProgressScraped = scrapedTransactions.length
      inProgressIds = new Set(scrapedTransactions.map(t => t.mercariItemId))
      const inProgressTotal = extractInProgressTotal(inProgressHtml)

      if (scrapedTransactions.length === 0 && inProgressTotal !== null && inProgressTotal >= 1) {
        // 総数は読めているのに1件も解析できない＝一覧の入れ物の構造が変わった疑い
        inProgressBrokenMessage =
          `取引中タブの構造が変わった可能性（総数 ${inProgressTotal} 件・解析 0 件）`
      } else if (scrapedTransactions.length === 0 && !inProgressHtml.includes('data-testid="mypage-main-content"')) {
        inProgressBrokenMessage = '取引中タブの構造が変わっている可能性があります'
      } else {
        const keywords = db.parseKeywords(db.getSettings().mercari_keyword ?? '')
        const targetTransactions = keywords.length > 0
          ? scrapedTransactions.filter(t => db.matchesAnyKeyword(t.title, keywords))
          : scrapedTransactions

        const knownIds = db.existingMercariIds(targetTransactions.map(t => t.mercariItemId))
        const freshTransactionsAll = targetTransactions.filter(t => !knownIds.has(t.mercariItemId))
        // 削除した販売は取引中タブからも再取り込みしない
        const freshTransactions = freshTransactionsAll.filter(t => !db.isMercariItemExcluded(t.mercariItemId))
        excludedDeleted += freshTransactionsAll.length - freshTransactions.length

        for (const t of targetTransactions) {
          if (t.status === null) inProgressUnknownStatus++
          if (!knownIds.has(t.mercariItemId) || !t.status) continue
          if (db.updateSaleStatus(t.mercariItemId, t.status)) inProgressUpdated++
        }

        const insertedRows = freshTransactions.length > 0
          ? db.insertCollected(freshTransactions.map(t => ({
              mercariItemId: t.mercariItemId,
              title: t.title,
              price: t.price,
              soldAt: todayLocal(),
              status: t.status,
            })))
          : []
        inProgressNew = insertedRows.length

        const transactionThumbTargets = db.salesNeedingThumb(targetTransactions)
        const inProgressThumbsResult = await saveNewThumbs(
          transactionThumbTargets, MAX_THUMBS_PER_RUN - thumbsAttempted - listingThumbsAttempted,
        )
        inProgressThumbsSaved = inProgressThumbsResult.saved
      }
    }

    // 詳細を開く対象：未紐付けの転売で model_codes が空のものだけ
    // （説明文に型番があれば紐付けを救える）。実額のためには開かない。
    // キーワードを変えた後は、取り込み時点では resale だったが現在のキーワードには
    // 一致しない販売が残っていることがあるため、ここでも同じ関数で絞る
    const pendingKeywords = db.parseKeywords(db.getSettings().mercari_keyword ?? '')
    const pendingAll = db.listSales({ onlyPending: true })
      .filter(s => s.mercari_item_id
        && s.kind === 'resale' && s.unmatched === 1 && s.model_codes.length === 0)
    const pendingMatched = pendingKeywords.length > 0
      ? pendingAll.filter(s => db.matchesAnyKeyword(s.title, pendingKeywords))
      : pendingAll
    const excludedPendingByKeyword = pendingAll.length - pendingMatched.length
    const pending = pendingMatched.slice(0, Math.max(0, MAX_PAGES_PER_RUN - pagesOpened))

    let detailsRead = 0
    let codesApplied = 0

    for (const s of pending) {
      if (pagesOpened >= MAX_PAGES_PER_RUN) break

      await win.loadURL(`https://jp.mercari.com/item/${s.mercari_item_id}`)
      pagesOpened++
      await randomWait()

      if (await isChallenge(win)) {
        keepWindowOpen = true
        revealForChallenge(win)
        return db.finishRun(runId, 'auth_required', sales.length, inserted, CHALLENGE_MESSAGE)
      }

      const detail = await scrapeDetail(win)
      detailsRead++
      if (!detail?.description) continue

      const codes = extractCodes(detail.description)
      if (codes.length > 0 && db.appendModelCodes(s.id, codes)) {
        codesApplied++
      }
    }

    // 購入日時：型番救済の詳細の後、残りページ予算の範囲で最大 MAX_PURCHASED_AT_PER_RUN 件、
    // 取引画面を開いて拾う。null が返っても「試行済み」として記録し、再試行しない
    const purchasedAtBudget = Math.max(
      0, Math.min(MAX_PURCHASED_AT_PER_RUN, MAX_PAGES_PER_RUN - pagesOpened),
    )
    const purchasedAtTargets = purchasedAtBudget > 0 ? db.salesNeedingPurchasedAt(purchasedAtBudget) : []
    let purchasedAtRead = 0

    for (const s of purchasedAtTargets) {
      if (pagesOpened >= MAX_PAGES_PER_RUN) break

      await win.loadURL(`https://jp.mercari.com/transaction/${s.mercari_item_id}`)
      pagesOpened++
      await randomWait()

      if (await isChallenge(win)) {
        keepWindowOpen = true
        revealForChallenge(win)
        return db.finishRun(runId, 'auth_required', sales.length, inserted, CHALLENGE_MESSAGE)
      }

      const bodyText = await win.webContents
        .executeJavaScript(`document.body ? document.body.innerText : ''`)
        .catch(() => '') as string
      db.setSalePurchasedAt(s.id, parsePurchasedAt(bodyText))
      purchasedAtRead++
    }

    if (salesEmpty && listingsScraped === 0 && inProgressScraped === 0) {
      // 販売・出品・取引中のどれも0件。0件を成功にしない（DOM変更で壊れたとき静かに欠損すると
      // 数ヶ月気づけないので、明示的に異常として残す）。listingBrokenMessage は
      // status に関わらず必ず message に残す
      const parts = ['0件でした。画面構造が変わってセレクタが壊れている可能性があります']
      if (listingBrokenMessage) parts.push(listingBrokenMessage)
      return db.finishRun(runId, 'empty', 0, 0, parts.join('。'))
    }

    // status は販売側の結果に従う（ここまで来ていれば ok。出品中・取引中タブの構造異常は
    // status を落とさず message にだけ残す＝Codexレビュー指摘）
    const parts = [salesEmpty ? '販売 0 件' : `新規 ${inserted}・更新 ${updated}`]
    if (excludedByKeyword > 0) parts.push(`キーワード不一致で除外 ${excludedByKeyword} 件`)
    if (excludedKnownByKeyword > 0) parts.push(`既知の不一致でサムネ対象外 ${excludedKnownByKeyword} 件`)
    if (excludedDeleted > 0) parts.push(`削除済み ${excludedDeleted} 件`)
    const totalThumbsSaved = thumbsSaved + listingThumbsSaved + inProgressThumbsSaved
    if (totalThumbsSaved > 0) parts.push(`サムネイル ${totalThumbsSaved} 枚`)
    if (excludedPendingByKeyword > 0) parts.push(`既知の不一致で詳細対象外 ${excludedPendingByKeyword} 件`)
    if (pending.length > 0) parts.push(`型番の追記 ${codesApplied}（詳細 ${detailsRead} 件）`)
    if (purchasedAtRead > 0) parts.push(`購入日時 ${purchasedAtRead} 件`)
    parts.push(`出品 新規 ${listingInserted}・更新 ${listingUpdated}`)
    if (listingBrokenMessage) parts.push(listingBrokenMessage)
    parts.push(`取引中 ${inProgressScraped}件（新規 ${inProgressNew}・更新 ${inProgressUpdated}）`)
    if (inProgressUnknownStatus > 0) parts.push(`取引中の文言不明 ${inProgressUnknownStatus} 件`)
    if (inProgressBrokenMessage) parts.push(inProgressBrokenMessage)
    if (totalCount !== null && totalCount !== sales.length) {
      parts.push(`一覧に ${totalCount} 件、取得 ${sales.length} 件`)
    }

    // fetched / inserted は売却済み一覧と取引中タブの合計（同じ商品IDは重複除去）。
    // 取引中タブだけで取り込んでも 0 件扱いにならないようにする（Codexレビュー指摘）
    const observedIds = new Set([...sales.map(s => s.mercariItemId), ...inProgressIds])
    const totalFetched = observedIds.size
    const totalInserted = inserted + inProgressNew

    return db.finishRun(runId, 'ok', totalFetched, totalInserted, parts.join('。'))

  } catch (e) {
    return db.finishRun(
      runId, 'failed', 0, 0,
      e instanceof Error ? e.message : String(e),
    )
  } finally {
    if (!keepWindowOpen && !win.isDestroyed()) win.destroy()
  }
}

/**
 * メンテ用：1件の販売について、取引画面を1ページだけ開いて購入日時を取り直す。
 * `collect()` の定期取り込みとは別に、人が明示的に呼ぶ想定（同時に `collect()` が
 * 走っていても、別ウィンドウ・1ページだけなので抑止しない）。
 */
export async function refetchSaleDates(saleId: string): Promise<{ purchased_at: string | null }> {
  const mercariItemId = db.saleMercariItemId(saleId)
  if (!mercariItemId) throw new Error('メルカリの取引ではありません')

  const win = createWindow(false)
  let keepWindowOpen = false

  try {
    await win.loadURL(`https://jp.mercari.com/transaction/${mercariItemId}`)
    await randomWait()

    if (await isChallenge(win)) {
      keepWindowOpen = true
      revealForChallenge(win)
      throw new Error(CHALLENGE_MESSAGE)
    }

    const bodyText = await win.webContents
      .executeJavaScript(`document.body ? document.body.innerText : ''`)
      .catch(() => '') as string
    const purchasedAt = parsePurchasedAt(bodyText)
    db.setSalePurchasedAt(saleId, purchasedAt)
    return { purchased_at: purchasedAt }
  } finally {
    if (!keepWindowOpen && !win.isDestroyed()) win.destroy()
  }
}

export function ensureSession(): void {
  const s = session.fromPartition(PARTITION)
  const chromeMajor = process.versions.chrome.split('.')[0]
  const ua = buildUserAgent(process.platform, chromeMajor)
  s.setUserAgent(ua, 'ja,en-US;q=0.9,en;q=0.8')
}
