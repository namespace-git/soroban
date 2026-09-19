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
//   * 連続アクセスしない
//   * 取得0件は「成功」ではなく empty（異常の疑い）として記録する
// ============================================================

const PARTITION = 'persist:mercari'
const LISTINGS_URL = 'https://jp.mercari.com/mypage/listings/completed'
const LOGIN_URL = 'https://jp.mercari.com/login'

/** ページ遷移後の待機。連打しないための間でもある */
const NAV_WAIT_MS = 3000

export interface ScrapedSale {
  mercariItemId: string
  title: string
  price: number
  soldAt: string
}

function createWindow(show: boolean): BrowserWindow {
  return new BrowserWindow({
    width: 1100,
    height: 900,
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
 * 収集を1回実行する。
 * @param silent true なら画面を出さない（起動時の自動実行）
 */
export async function collect(silent: boolean): Promise<CollectorRun> {
  const runId = db.startRun()
  const win = createWindow(!silent)

  try {
    await win.loadURL(LISTINGS_URL)
    await sleep(NAV_WAIT_MS)

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

    return db.finishRun(runId, 'ok', sales.length, inserted)

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
  const intervalH = Number(settings.collect_interval_h ?? 6)
  if (db.hoursSinceLastOk() < intervalH) return null
  return collect(true)
}

export function ensureSession(): void {
  session.fromPartition(PARTITION)
}
