import { BrowserWindow, session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import * as db from './db'
import type { CollectorRun } from '../shared/types'
import { todayLocal } from '../shared/date'

// ============================================================
// メルカリの売却済み一覧を読み取る
//
// 約束：
//   * 認証情報は保存しない。保存するのは persist パーティション（Cookie）だけ
//   * 書き込み操作は一切しない。読み取り専用
//   * 連続アクセスしない。ページ間はランダム待ち、1回の実行で開くページ数に上限
//   * 取得0件は「成功」ではなく empty（異常の疑い）として記録する
//   * 普通の Chrome として見える（UA・Accept-Language・通常ウィンドウ）。
//     自動化を示すものは足さない
//   * CAPTCHA・本人確認が出たら即座に止めて人に渡す。自動突破はしない
// ============================================================

const PARTITION = 'persist:mercari'
const LISTINGS_URL = 'https://jp.mercari.com/mypage/listings/completed'
const LOGIN_URL = 'https://jp.mercari.com/login'

/** 1回の収集で開くページ数の上限（一覧1＋詳細最大5）。超えたら次回に回す */
const MAX_PAGES_PER_RUN = 6

const CHALLENGE_MESSAGE =
  'メルカリが本人確認を求めています。「メルカリにログイン」から画面を開いて、手で進めてください'

/** CAPTCHA・本人確認を示す語。URL・本文どちらに出ても止める */
const CHALLENGE_WORDS = [
  'captcha', 'recaptcha', 'hcaptcha', 'challenge',
  '本人確認', '認証コード', 'ロボットではありません',
]

export interface ScrapedSale {
  mercariItemId: string
  title: string
  price: number
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
 * URL・本文テキストから CAPTCHA・本人確認の兆候を判定する（大文字小文字無視）。
 * electron に依存しない純粋関数。
 */
export function isChallengeText(url: string, bodyText: string): boolean {
  const haystack = `${url} ${bodyText}`.toLowerCase()
  return CHALLENGE_WORDS.some(w => haystack.includes(w.toLowerCase()))
}

/**
 * 販売詳細のテキストから手数料・送料の実額を抜く。
 * `販売手数料 ¥390` `送料 210円` のような、ラベルの近くにある金額を拾う。
 * 見つからなければ null（0 を実額として返さない）。
 * electron に依存しない純粋関数。
 */
export function parseDetailText(text: string): { fee: number | null; shippingFee: number | null } {
  return {
    fee: amountAfterLabel(text, /販売手数料/),
    shippingFee: amountAfterLabel(text, /送料/),
  }
}

/**
 * ラベル（例：「販売手数料」）が現れた直後の狭い範囲から ¥1,234 / 1,234円 の
 * どちらの表記でも金額を拾う。見つからない・0円は null（実額として扱わない）。
 */
function amountAfterLabel(text: string, label: RegExp): number | null {
  const m = label.exec(text)
  if (!m) return null
  const rest = text.slice(m.index, m.index + 30)
  const am = rest.match(/[¥￥]\s?([\d,]+)/) || rest.match(/([\d,]+)\s?円/)
  if (!am) return null
  const n = parseInt(am[1].replace(/,/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
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
  return isChallengeText(url, bodyText)
}

/**
 * 売却済み一覧から取引を抽出する。
 *
 * ⚠ セレクタは推測を含む。初回導入時に DevTools で実際のDOMを確認し、
 *   ここを必ず調整すること。
 *
 * 方針：
 *   * 商品リンク（/item/m...）を起点にする。クラス名に依存しない
 *   * タイトルは img[alt] から取る。これが最も安定している
 *   * 価格は正規表現で拾う（¥1,234 と 1,234円 の両方）
 */
async function scrape(win: BrowserWindow): Promise<ScrapedSale[]> {
  const raw = await win.webContents.executeJavaScript(`
    (() => {
      const out = [];
      const anchors = Array.from(
        document.querySelectorAll('a[href*="/item/m"], a[href*="/transaction/"]')
      );

      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/m\\d{9,}/);
        if (!m) continue;

        const root = a.closest('li, article, [data-testid]') || a;
        const text = (root.textContent || '').replace(/\\s+/g, ' ').trim();

        const pm = text.match(/[¥￥]\\s?([\\d,]+)/) || text.match(/([\\d,]+)\\s?円/);
        const price = pm ? parseInt(pm[1].replace(/,/g, ''), 10) : null;

        const img = root.querySelector('img[alt]');
        const title = img
          ? img.getAttribute('alt')
          : (a.getAttribute('aria-label') || a.textContent || '').trim();

        if (!price || !title) continue;
        out.push({ mercariItemId: m[0], title: String(title).slice(0, 200), price });
      }

      const seen = new Set();
      return out.filter(x => {
        if (seen.has(x.mercariItemId)) return false;
        seen.add(x.mercariItemId);
        return true;
      });
    })()
  `) as Array<{ mercariItemId: string; title: string; price: number }>

  // 一覧に販売日は出ないことが多いので、取得日で代用する。
  // 正確な日付が必要なら取引画面を個別に開く必要があるが、
  // アクセス回数が増えるのでここではやらない
  const today = todayLocal()
  return raw.map(r => ({ ...r, soldAt: today }))
}

/**
 * 販売詳細ページから手数料・送料の実額と説明文を読む。
 *
 * ⚠ セレクタ・キーワードは未検証。DevTools で実際のDOMを確認して調整すること。
 *
 * 方針：
 *   * 本文テキストから「販売手数料」「送料」の近くの金額を正規表現で拾う
 *   * 説明文は description 系のテスト属性・section・article のうち最も長いテキストを採る
 *   * 取れなければ null（空や0を実額として保存しない）
 */
async function scrapeDetail(
  win: BrowserWindow,
): Promise<{ fee: number | null; shippingFee: number | null; description: string | null } | null> {
  const bodyText = await win.webContents
    .executeJavaScript(`document.body ? document.body.innerText : ''`)
    .catch(() => null) as string | null
  if (!bodyText) return null

  const { fee, shippingFee } = parseDetailText(bodyText)

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

  return { fee, shippingFee, description }
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

    const sales = await scrape(win)

    if (sales.length === 0) {
      // 0件を成功にしない。DOM変更で壊れたとき静かに欠損すると
      // 数ヶ月気づけないので、明示的に異常として残す
      return db.finishRun(
        runId, 'empty', 0, 0,
        '0件でした。画面構造が変わってセレクタが壊れている可能性があります',
      )
    }

    const known = db.existingMercariIds(sales.map(s => s.mercariItemId))
    const fresh = sales.filter(s => !known.has(s.mercariItemId))
    const inserted = fresh.length > 0 ? db.insertCollected(fresh) : 0

    // 未入力（送料未確定）の販売に限って詳細を開き、実額を取りにいく。
    // 差分取得の一環：既に確定済みの販売は開かない
    const pending = db.listSales({ onlyPending: true })
      .filter(s => s.is_shipping_confirmed === 0 && s.mercari_item_id)
      .slice(0, Math.max(0, MAX_PAGES_PER_RUN - pagesOpened))

    let detailsRead = 0
    let actualsApplied = 0

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
      if (!detail) continue

      const actuals: { fee?: number; shipping_fee?: number } = {}
      if (detail.fee !== null) actuals.fee = detail.fee
      if (detail.shippingFee !== null) actuals.shipping_fee = detail.shippingFee
      if (Object.keys(actuals).length > 0) {
        db.applySaleActuals(s.id, actuals)
        actualsApplied++
      }
      // 説明文からの型番追記（extractCodes）は、db.ts に追記用の関数が
      // ないため今回は未実装。次の波で appendModelCodes 相当を足してから対応する
    }

    const message = pending.length > 0
      ? `詳細 ${detailsRead} 件を読み、実額 ${actualsApplied} 件を反映しました`
      : undefined

    return db.finishRun(runId, 'ok', sales.length, inserted, message)

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
