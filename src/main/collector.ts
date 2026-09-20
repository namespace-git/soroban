import { BrowserWindow, app, session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as db from './db'
import { extractCodes } from './code'
import type { CollectorRun } from '../shared/types'

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
const LOGIN_URL = 'https://jp.mercari.com/login'

/** 1回の収集で開くページ数の上限（一覧1＋詳細最大5）。超えたら次回に回す */
const MAX_PAGES_PER_RUN = 6

/**
 * 1回の収集でサムネイルを保存する上限。新規1件につき画像1枚（ユーザー承認済み）。
 * 既知の販売では再取得しない＝「一度だけ」の約束。残りは諦めてよく、次回への
 * 持ち越しはしない（失敗・上限超過を再試行しない）
 */
const MAX_THUMBS_PER_RUN = 30

const CHALLENGE_MESSAGE =
  'メルカリが本人確認を求めています。「メルカリにログイン」から画面を開いて、手で進めてください'

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
}

/**
 * 「出品した商品 › 出品中」タブ（`https://jp.mercari.com/mypage/listings`）の
 * HTML から出品を抜く（jsdom なしの簡易パース。fixture テスト用）。
 *
 * ⚠ セレクタは実DOM（fixtures/mercari-listings.html）に基づくが、クラス名はハッシュで
 *   変わるため使っていない。商品リンク（`a[href*="/item/m"]`、data-testid="listed-item"）
 *   を起点にし、タイトルは `[data-testid="item-label"]`、価格は `[data-testid="price"]`
 *   の数字、サムネイルは `img[src]` から拾う。「公開停止中」の文字列があれば suspended。
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

    rows.push({
      mercariItemId: idMatch[0],
      title,
      price: parseInt(priceDigits, 10),
      suspended: /公開停止中/.test(content),
      thumbUrl: imgMatch ? imgMatch[1] : null,
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
} {
  return {
    mercariItemId: s.mercariItemId,
    title: s.title,
    price: s.price,
    soldAt: s.soldAt,
    fee: s.fee,
    shippingFee: s.shippingFee,
    otherCost: s.otherCost,
  }
}

/** サムネイル保存先ディレクトリ（無ければ作る） */
function ensureThumbDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 一覧に写っているサムネイルを1枚取得してファイルに保存し、ファイル名を返す。
 * 書き込み操作ではない（画像のGETのみ）。session.fetch を使うことで、
 * 普通のブラウザの画像取得と同じ Cookie/UA に見える。
 */
async function downloadThumbFile(mercariItemId: string, url: string): Promise<string> {
  const res = await session.fromPartition(PARTITION).fetch(url)
  if (!res.ok) throw new Error(`サムネイル取得に失敗しました（${res.status}）: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const file = `${mercariItemId}.jpg`
  await writeFile(join(ensureThumbDir(), file), buf)
  return file
}

async function downloadThumb(saleId: string, mercariItemId: string, url: string): Promise<void> {
  const file = await downloadThumbFile(mercariItemId, url)
  db.setSaleThumb(saleId, file)
}

/**
 * サムネイルをまだ持っていない販売（新規に取り込んだ分＋実DBに元からあって今回の
 * 一覧にも出ている分）に、1枚だけ保存する（対象1件につき画像1枚、ユーザー承認済みの
 * 追加アクセス）。サムネイルを既に保存済みの販売では再取得しない＝「一度だけ」の約束。
 * 各画像の間に 300〜800ms 待つ（連打しない）。失敗しても再試行せず、収集全体も失敗にしない。
 * 上限 `MAX_THUMBS_PER_RUN` を超えた分・失敗した分は諦める。ただし失敗した分は
 * `thumb_file` が NULL のままなので、その販売が今後も一覧に出ている限りは次回また
 * 対象になる（一覧から消えれば対象にもならないため、実質は数回の収集で止まる）。
 */
/** 保存に成功した数（saved）と、実際にリクエストを試みた数（attempted）。予算は attempted で減らす */
export interface ThumbSaveResult {
  saved: number
  attempted: number
}

async function saveNewThumbs(
  targets: Array<{ id: string; mercariItemId: string }>,
  scraped: ScrapedSale[],
  limit = MAX_THUMBS_PER_RUN,
): Promise<ThumbSaveResult> {
  const thumbByItemId = new Map(scraped.map(s => [s.mercariItemId, s.thumbUrl]))
  const seen = new Set<string>()

  const withUrl = targets
    .filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true))) // id重複を除く
    .map(t => ({ ...t, thumbUrl: thumbByItemId.get(t.mercariItemId) ?? null }))
    .filter((t): t is { id: string; mercariItemId: string; thumbUrl: string } => !!t.thumbUrl)
    .slice(0, Math.max(0, limit))

  let saved = 0
  let attempted = 0
  for (const t of withUrl) {
    attempted++
    try {
      await downloadThumb(t.id, t.mercariItemId, t.thumbUrl)
      saved++
    } catch {
      // 一度だけの約束を優先。失敗しても再試行しない
    }
    await sleep(300 + Math.floor(Math.random() * 500))
  }
  return { saved, attempted }
}

/**
 * 出品（listing）版のサムネイル保存。saveNewThumbs と同じ約束（一度だけ・連打しない・
 * 失敗を再試行しない）で、`db.setListingThumb` に書く。予算は呼び出し側が
 * `saveNewThumbs` と合算で管理する（1回の収集でサムネイルは合計 `MAX_THUMBS_PER_RUN` 枚まで）。
 */
async function saveNewListingThumbs(
  targets: string[],
  scraped: ScrapedListing[],
  limit: number,
): Promise<ThumbSaveResult> {
  const thumbByItemId = new Map(scraped.map(l => [l.mercariItemId, l.thumbUrl]))

  const withUrl = targets
    .map(id => ({ id, thumbUrl: thumbByItemId.get(id) ?? null }))
    .filter((t): t is { id: string; thumbUrl: string } => !!t.thumbUrl)
    .slice(0, Math.max(0, limit))

  let saved = 0
  let attempted = 0
  for (const t of withUrl) {
    attempted++
    try {
      const file = await downloadThumbFile(t.id, t.thumbUrl)
      db.setListingThumb(t.id, file)
      saved++
    } catch {
      // 一度だけの約束を優先。失敗しても再試行しない
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

  try {
    await win.loadURL(LISTINGS_URL)
    pagesOpened++
    await randomWait()

    if (await isChallenge(win)) {
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

    if (!salesEmpty) {
      const known = db.existingMercariIds(sales.map(s => s.mercariItemId))
      const freshSales = sales.filter(s => !known.has(s.mercariItemId))
      const knownRows = sales.filter(s => known.has(s.mercariItemId)).map(toRow)

      const insertedRows = freshSales.length > 0 ? db.insertCollected(freshSales.map(toRow)) : []
      inserted = insertedRows.length
      updated = knownRows.length > 0 ? db.updateCollectedActuals(knownRows) : 0

      // サムネイル対象：新規に入れた分 ＋ 今回の一覧に出ていてまだ保存していない既存分。
      // 実DBに元からあった販売は「新規」ではないので、後者を含めないと永久にサムネが付かない
      const knownWithoutThumb = db.salesWithoutThumb(knownRows.map(r => r.mercariItemId))
      const thumbsResult = await saveNewThumbs([...insertedRows, ...knownWithoutThumb], sales)
      thumbsSaved = thumbsResult.saved
      thumbsAttempted = thumbsResult.attempted
    }

    // 出品した商品「出品中」タブ（1ページ）。売却済みの後に読む。販売が0件でも読む
    // （販売0件イコール出品も何も変化していない、とは限らないため）。
    // キーワード設定があればタイトルが一致するものだけ取り込む
    let listingInserted = 0
    let listingUpdated = 0
    let listingThumbsSaved = 0
    let listingsScraped = 0
    let listingBrokenMessage: string | null = null

    if (pagesOpened < MAX_PAGES_PER_RUN) {
      await win.loadURL(MY_LISTINGS_URL)
      pagesOpened++
      await randomWait()

      if (await isChallenge(win)) {
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
        })))
        listingInserted = result.inserted
        listingUpdated = result.updated

        // 残りのサムネイル予算（サムネイルは1回の収集で販売・出品合わせて30枚まで。
        // 「保存できた数」ではなく「試みた数」で減らす。失敗が多いと2倍のリクエストに
        // なってしまうため（Codexレビュー指摘）
        const listingsNoThumb = db.listingsWithoutThumb(targetListings.map(l => l.mercariItemId))
        const listingThumbsResult = await saveNewListingThumbs(
          listingsNoThumb, targetListings, MAX_THUMBS_PER_RUN - thumbsAttempted,
        )
        listingThumbsSaved = listingThumbsResult.saved
      }
    }

    // 詳細を開く対象：未紐付けの転売で model_codes が空のものだけ
    // （説明文に型番があれば紐付けを救える）。実額のためには開かない
    const pending = db.listSales({ onlyPending: true })
      .filter(s => s.mercari_item_id
        && s.kind === 'resale' && s.unmatched === 1 && s.model_codes.length === 0)
      .slice(0, Math.max(0, MAX_PAGES_PER_RUN - pagesOpened))

    let detailsRead = 0
    let codesApplied = 0

    for (const s of pending) {
      if (pagesOpened >= MAX_PAGES_PER_RUN) break

      await win.loadURL(`https://jp.mercari.com/item/${s.mercari_item_id}`)
      pagesOpened++
      await randomWait()

      if (await isChallenge(win)) {
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

    if (salesEmpty && listingsScraped === 0) {
      // 販売・出品どちらも0件。0件を成功にしない（DOM変更で壊れたとき静かに欠損すると
      // 数ヶ月気づけないので、明示的に異常として残す）。listingBrokenMessage は
      // status に関わらず必ず message に残す
      const parts = ['0件でした。画面構造が変わってセレクタが壊れている可能性があります']
      if (listingBrokenMessage) parts.push(listingBrokenMessage)
      return db.finishRun(runId, 'empty', 0, 0, parts.join('。'))
    }

    // status は販売側の結果に従う（ここまで来ていれば ok。出品中タブの構造異常は
    // status を落とさず message にだけ残す＝Codexレビュー指摘）
    const parts = [salesEmpty ? '販売 0 件' : `新規 ${inserted}・更新 ${updated}`]
    const totalThumbsSaved = thumbsSaved + listingThumbsSaved
    if (totalThumbsSaved > 0) parts.push(`サムネイル ${totalThumbsSaved} 枚`)
    if (pending.length > 0) parts.push(`型番の追記 ${codesApplied}（詳細 ${detailsRead} 件）`)
    parts.push(`出品 新規 ${listingInserted}・更新 ${listingUpdated}`)
    if (listingBrokenMessage) parts.push(listingBrokenMessage)
    if (totalCount !== null && totalCount !== sales.length) {
      parts.push(`一覧に ${totalCount} 件、取得 ${sales.length} 件`)
    }

    return db.finishRun(runId, 'ok', sales.length, inserted, parts.join('。'))

  } catch (e) {
    return db.finishRun(
      runId, 'failed', 0, 0,
      e instanceof Error ? e.message : String(e),
    )
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export function ensureSession(): void {
  const s = session.fromPartition(PARTITION)
  const chromeMajor = process.versions.chrome.split('.')[0]
  const ua = buildUserAgent(process.platform, chromeMajor)
  s.setUserAgent(ua, 'ja,en-US;q=0.9,en;q=0.8')
}
