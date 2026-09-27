import { BrowserWindow } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import * as db from './db'
import { buildUserAgent, randomWait } from './collector'
import type { Fulfillment } from '../shared/types'

// ============================================================
// 17TRACK（https://t.17track.net/）で仕入の配送状況を読む。
//
// メロジョイの注文詳細は「確認済み（発送準備中）」→「配達中」までしか出さず、
// 「配達済み」を出さない。追跡番号（tracking_number）は既に purchase に保存済みなので、
// それを 17TRACK に渡して「配達完了」と到着日を読み、到着状態に反映する。
//
// 約束：
//   * 読み取り専用。番号の入力欄に打ち込むような操作はしない
//     （URL のハッシュ `#nums=<番号>` に載せて開くだけ）
//   * ログインしない・認証情報を保存しない（17TRACK はログイン不要）
//   * 到着状態の更新は前に進む方向だけ（db.applyTrackingResult が noDowngrade で守る）
//   * CAPTCHA・レート制限等で止められたら、その場で諦めて人に伝える。
//     自動突破・即時再試行は書かない（同じ番号を再試行しない）
//   * 収集頻度を上げない（呼び出し側の20時間間隔・limit に従うだけ。ここでは連打しない）
// ============================================================

const PARTITION = 'persist:tracking'

/** #yq-tracking-progress を待つ間隔・上限（この1ページだけ。リトライではない） */
const POLL_INTERVAL_MS = 500
const POLL_TIMEOUT_MS = 25000

/** 1回のバッチ実行で見に行く仕入の上限 */
const DEFAULT_BATCH_LIMIT = 3

export const TRACKING_BLOCKED_MESSAGE =
  '17TRACK に読み込みを止められました（アクセスが多いと判定された可能性があります）。'
  + '時間を置いてからもう一度お試しください'

/** 17TRACK がその場で読ませない（ファイヤーウォール等）ことを言っている語 */
const BLOCKED_WORDS = [
  'ファイヤーウォール', '認証コード', '追跡が頻繁すぎます', '異常なリクエスト', '検証に失敗しました',
]

const DELIVERED_WORDS = ['配達完了', '配達済み', 'Delivered']
const SHIPPED_WORDS = [
  '輸送中', '引受', '未配達', '異常', 'In Transit', 'Pickup', 'Out for Delivery', 'Undelivered', 'Alert',
]
const PENDING_WORDS = ['Info received', '情報を受け取りました']

/** 追跡番号から 17TRACK の URL を組み立てる。番号入力欄には触らず、開くだけ */
export function trackingUrl(trackingNumber: string): string {
  return `https://t.17track.net/ja#nums=${encodeURIComponent(trackingNumber)}`
}

/**
 * `#yq-tracking-progress` の innerText から、状態の言葉と到着日を取る。
 *   - statusText：最初の意味のある行（空行・`-` だけの行は捨てる）。無ければ null
 *   - deliveredAt：`Time of delivery:` の後に出てくる最初の `YYYY-MM-DD`。
 *     見当たらなければテキスト全体から最初の `YYYY-MM-DD` を拾う（無ければ null）
 */
export function parseTrackingProgress(text: string): { statusText: string | null; deliveredAt: string | null } {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l !== '-')
  const statusText = lines.length > 0 ? lines[0] : null

  let deliveredAt: string | null = null
  const labelIdx = text.indexOf('Time of delivery:')
  if (labelIdx !== -1) {
    const after = text.slice(labelIdx + 'Time of delivery:'.length)
    const m = /(\d{4}-\d{2}-\d{2})/.exec(after)
    if (m) deliveredAt = m[1]
  }
  if (deliveredAt === null) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(text)
    if (m) deliveredAt = m[1]
  }

  return { statusText, deliveredAt }
}

/**
 * 17TRACK の状態の言葉を、そろばんの到着状態に対応づける。日本語・英語が混ざって
 * 出ることがある。分からない言葉は null（＝呼び出し側で状態を変えない）。
 * 「未配達」を「配達」の部分一致で delivered に誤判定しないよう、配達済みの語は
 * 完全な語（配達完了・配達済み・Delivered）だけで判定する。
 */
export function trackingFulfillment(statusText: string | null): Fulfillment | null {
  if (!statusText) return null
  if (DELIVERED_WORDS.some(w => statusText.includes(w))) return 'delivered'
  if (SHIPPED_WORDS.some(w => statusText.includes(w))) return 'shipped'
  if (PENDING_WORDS.some(w => statusText.includes(w))) return 'pending'
  return null
}

/** ページ本文（`document.body.innerText`）が「止められた」ことを言っていないか */
export function isTrackingBlocked(bodyText: string): boolean {
  return BLOCKED_WORDS.some(w => bodyText.includes(w))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // 並列で他サイトの取り込み窓が同時に開くため、見分けられるようそろばん共通の型に揃える。
    // 実際には show: false 固定で人の目に触れないが、万一表示されても分かるようにしておく
    title: 'そろばん — 配送状況（17TRACK）',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  const chromeMajor = process.versions.chrome.split('.')[0]
  win.webContents.setUserAgent(buildUserAgent(process.platform, chromeMajor))
  return win
}

/**
 * 読み込み直後は空（Next.js のクライアント描画）なので、`#yq-tracking-progress` の
 * 中身が埋まるまで 0.5 秒おきに最大 25 秒待つ。このポーリングは1ページにつきこの範囲
 * だけで、失敗しても同じページを開き直して再試行はしない。
 * 本文テキスト（止められた判定用）は、進捗が埋まる前でも読めるように毎回まとめて取る
 * （1回の executeJavaScript で両方返す）。止められた文言が見えたらポーリングを打ち切る。
 */
async function readTrackingPage(win: BrowserWindow): Promise<{ statusText: string | null; deliveredAt: string | null; bodyText: string }> {
  const start = Date.now()
  let progressText = ''
  let bodyText = ''

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const result = await win.webContents.executeJavaScript(`
      (() => ({
        progress: document.querySelector('#yq-tracking-progress')?.innerText ?? '',
        body: document.body?.innerText ?? '',
      }))()
    `).catch(() => ({ progress: '', body: '' })) as { progress: string; body: string }

    progressText = result.progress
    bodyText = result.body

    if (progressText.trim().length > 0) break
    if (isTrackingBlocked(bodyText)) break

    await sleep(POLL_INTERVAL_MS)
  }

  const { statusText, deliveredAt } = parseTrackingProgress(progressText)
  return { statusText, deliveredAt, bodyText }
}

interface TrackingRead {
  statusText: string | null
  deliveredAt: string | null
  /** 止められたと判定したか（statusText が読めていれば false。読めていないときだけ判定する） */
  blocked: boolean
}

/**
 * 1つの追跡番号について、ウィンドウを開いて閉じるところまでやる。db には触れない
 * （checkTracking / checkTrackingBatch がそれぞれの流儀で反映する）。
 *
 * 止められた判定の順序：`statusText` が読めていれば、本文にノイズの語が混ざっていても
 * 「止められていない」扱いにする。読めていない（タイムアウト or 空）ときだけ、本文に
 * BLOCKED_WORDS が含まれるかで止められたと判定する。
 */
async function readTrackingOnce(trackingNumber: string): Promise<TrackingRead> {
  const win = createWindow()
  try {
    await win.loadURL(trackingUrl(trackingNumber))
    const { statusText, deliveredAt, bodyText } = await readTrackingPage(win)
    const blocked = statusText === null && isTrackingBlocked(bodyText)
    return { statusText, deliveredAt, blocked }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

// 画面のメンテナンスボタン（checkTracking）と裏の収集（checkTrackingBatch）が同時に
// ウィンドウを開かないよう、直列に並べる。dedup（同じ Promise を返す）ではなく、
// 呼び出しごとに正しい戻り値を返したいのでキュー（前の呼び出しの完了を待ってから走る）にする
let trackingChain: Promise<unknown> = Promise.resolve()

function withTrackingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = trackingChain.then(fn, fn)
  trackingChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 1件だけ今すぐ確認する（画面のメンテナンス用ボタンから）。追跡番号が無ければ何もせず null。
 * 止められたときは TRACKING_BLOCKED_MESSAGE を持つ例外を投げる（呼び出し側が画面に出す）。
 */
export async function checkTracking(
  purchaseId: string,
): Promise<{ status_text: string | null; delivered_at: string | null } | null> {
  return withTrackingLock(async () => {
    const trackingNumber = db.getPurchaseTrackingNumber(purchaseId)
    if (!trackingNumber) return null

    const { statusText, deliveredAt, blocked } = await readTrackingOnce(trackingNumber)
    if (blocked) throw new Error(TRACKING_BLOCKED_MESSAGE)

    const fulfillment = trackingFulfillment(statusText)
    const delivered_at = fulfillment === 'delivered' ? deliveredAt : null
    db.applyTrackingResult(purchaseId, { status_text: statusText, fulfillment, delivered_at })
    return { status_text: statusText, delivered_at }
  })
}

/**
 * 裏の収集から呼ぶ。`db.trackingCheckCandidates` の対象を既定 3 件まで、1件ずつ
 * ウィンドウを開いて読む（件の間は randomWait で待つ。連打しない）。
 * 1件が読めなくても続ける（failed++。ただし同じ件を再試行はしない＝
 * applyTrackingResult で tracking_checked_at を進めて次回に回す）。
 * 止められたら残りは読まずに打ち切り、打ち切った分は applyTrackingResult を呼ばない
 * （次回また対象になる）。対象0件ならウィンドウを開かない。
 */
export async function checkTrackingBatch(
  limit: number = DEFAULT_BATCH_LIMIT,
): Promise<{ checked: number; delivered: number; failed: number; blocked: boolean }> {
  return withTrackingLock(async () => {
    const candidates = db.trackingCheckCandidates(limit)
    if (candidates.length === 0) return { checked: 0, delivered: 0, failed: 0, blocked: false }

    let checked = 0
    let delivered = 0
    let failed = 0
    let blocked = false

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      const { statusText, deliveredAt, blocked: isBlocked } = await readTrackingOnce(candidate.tracking_number)

      if (isBlocked) {
        blocked = true
        break
      }

      if (statusText === null) failed++

      const fulfillment = trackingFulfillment(statusText)
      const delivered_at = fulfillment === 'delivered' ? deliveredAt : null
      const changed = db.applyTrackingResult(candidate.id, { status_text: statusText, fulfillment, delivered_at })
      checked++
      if (fulfillment === 'delivered' && changed) delivered++

      if (i < candidates.length - 1) await randomWait()
    }

    return { checked, delivered, failed, blocked }
  })
}
