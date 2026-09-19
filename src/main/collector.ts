import { BrowserWindow, session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
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
const LOGIN_URL = 'https://jp.mercari.com/login'

/** 1回の収集で開くページ数の上限（一覧1＋詳細最大5）。超えたら次回に回す */
const MAX_PAGES_PER_RUN = 6

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
 */
export function parseSoldRow(href: string, titleText: string, cellTexts: string[]): SoldRow | null {
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
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
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

    const cellTexts: string[] = []
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g
    let tm: RegExpExecArray | null
    while ((tm = tdRe.exec(rowHtml))) cellTexts.push(stripTags(tm[1]))

    const row = parseSoldRow(href, titleText, cellTexts)
    if (row) rows.push(row)
  }
  return rows
}

/** 「1件～18件（全18件）」のような表示から総件数を抜く。読めなければ null */
export function extractTotalCount(bodyText: string): number | null {
  const m = /全([\d,]+)件/.exec(bodyText)
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

        if (!title || price === null || !soldAt) continue;
        out.push({ mercariItemId: m[0], title: title.slice(0, 200), price, fee, shippingFee, otherCost, soldAt });
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

/**
 * 収集を1回実行する。
 * @param silent true なら画面を出さない（起動時の自動実行）
 */
export async function collect(silent: boolean): Promise<CollectorRun> {
  const runId = db.startRun()
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

    if (sales.length === 0) {
      // 0件を成功にしない。DOM変更で壊れたとき静かに欠損すると
      // 数ヶ月気づけないので、明示的に異常として残す
      return db.finishRun(
        runId, 'empty', 0, 0,
        '0件でした。画面構造が変わってセレクタが壊れている可能性があります',
      )
    }

    const known = db.existingMercariIds(sales.map(s => s.mercariItemId))
    const freshRows = sales.filter(s => !known.has(s.mercariItemId)).map(toRow)
    const knownRows = sales.filter(s => known.has(s.mercariItemId)).map(toRow)

    const inserted = freshRows.length > 0 ? db.insertCollected(freshRows) : 0
    const updated = knownRows.length > 0 ? db.updateCollectedActuals(knownRows) : 0

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

    const parts = [`新規 ${inserted}・更新 ${updated}`]
    if (pending.length > 0) parts.push(`型番の追記 ${codesApplied}（詳細 ${detailsRead} 件）`)
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

/** 起動時に、前回から十分時間が空いていれば収集する */
export async function collectIfDue(): Promise<CollectorRun | null> {
  const settings = db.getSettings()
  const intervalH = Number(settings.collect_interval_h ?? 1)
  if (db.hoursSinceLastOk() < intervalH) return null
  return collect(true)
}

export function ensureSession(): void {
  const s = session.fromPartition(PARTITION)
  const chromeMajor = process.versions.chrome.split('.')[0]
  const ua = buildUserAgent(process.platform, chromeMajor)
  s.setUserAgent(ua, 'ja,en-US;q=0.9,en;q=0.8')
}
