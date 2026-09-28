import { todayLocal } from '../shared/date'
import type { Fulfillment } from '../shared/types'

// ============================================================
// 17TRACK 公式 API（https://api.17track.net/track/v2.4）で
// 仕入の配送状況・到着日を読む。
//
// 経緯：最初は t.17track.net の画面（DOM）を読む実装を試したが、
// URL のハッシュ（#nums=...）では問い合わせが走らず、ページに最初から
// 入っている見本データ（無関係な追跡番号の結果）が返ってきた。
// 「読めたつもりで別の番号のデータを書き込む」事故になりかねないため、
// 公式 API に切り替える。
//
// 最重要の原則：応答が「自分が問い合わせた番号」の結果だと確認できない
// ものは、絶対に呼び出し側へ返さない。分からないときは分からないと返す。
//
// 約束：
//   * DB に触らない・BrowserWindow を使わない（API を叩いて整えて返すだけ）
//   * 1リクエストの追跡番号は40件まで、1秒に3リクエストまで
//   * 429（レート制限）でループしない。429・4xx は再試行しない
//   * APIキーはログにも例外メッセージにも出さない
// ============================================================

const API_BASE = 'https://api.17track.net/track/v2.4'
const BATCH_SIZE = 40
/** 1秒に3リクエストまで。バッチ間はこの間隔だけ空ける（40件程度しか無いので数回で済む） */
const BATCH_INTERVAL_MS = 350
const TIMEOUT_MS = 30_000

/** register のときだけ成功として扱うコード（すでに登録済み。課金もされない） */
const ALREADY_REGISTERED_CODE = -18019901

/** 17TRACK が返す最新状態（9種類）。知らない文字列は 'Unknown' に丸める */
export type Track17Status =
  | 'NotFound' | 'InfoReceived' | 'InTransit' | 'Expired' | 'AvailableForPickup'
  | 'OutForDelivery' | 'DeliveryFailure' | 'Delivered' | 'Exception' | 'Unknown'

const KNOWN_STATUSES: Track17Status[] = [
  'NotFound', 'InfoReceived', 'InTransit', 'Expired', 'AvailableForPickup',
  'OutForDelivery', 'DeliveryFailure', 'Delivered', 'Exception',
]

function toTrack17Status(raw: unknown): Track17Status {
  return typeof raw === 'string' && (KNOWN_STATUSES as string[]).includes(raw) ? (raw as Track17Status) : 'Unknown'
}

/** 1件ぶんの読み取り結果 */
export interface Track17Read {
  /** 問い合わせた番号（応答の number と一致したものだけ入る） */
  number: string
  status: Track17Status
  subStatus: string | null
  /** 到着日（YYYY-MM-DD、日本時間）。status が Delivered のときだけ入る。他は null */
  deliveredAt: string | null
  /** 最新の出来事の日時（ISO）。分からなければ null */
  latestEventAt: string | null
  /** この番号について 17TRACK が返したエラー（読めなかった理由）。無ければ null */
  error: { code: number; message: string } | null
}

/**
 * 17TRACK が非2xxを返した、またはAPIレベルのエラーコードを返したときの例外。
 * message は既に日本語で、次に何をすればよいかまで含む（画面がそのまま出す）。
 * status は HTTP ステータス（fetch 自体が失敗したなら 0）、apiCode は 17TRACK の
 * エラーコード（分からなければ null）
 */
export class Track17Error extends Error {
  readonly status: number
  readonly apiCode: number | null

  constructor(message: string, status: number, apiCode: number | null) {
    super(message)
    this.name = 'Track17Error'
    this.status = status
    this.apiCode = apiCode
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** numbers を40件ずつのバッチに分ける */
function toBatches(numbers: string[]): string[][] {
  const batches: string[][] = []
  for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
    batches.push(numbers.slice(i, i + BATCH_SIZE))
  }
  return batches
}

/**
 * HTTP・API レベルのエラーを日本語メッセージへ丸める。ai-receipt.ts の
 * toAiErrorMessage と同じ考え方（HTTP と API 側の理由で出し分け、次にどうすればよいかを書く）。
 * apiCode は 17TRACK の応答の code（HTTPエラーで分からなければ null）
 */
function buildErrorMessage(status: number, apiCode: number | null, apiMessage: string | null): string {
  if (apiCode === -18010002) {
    return '17TRACK の API キーが正しくありません。設定でキーを入れ直してください'
  }
  if (status === 401 || status === 403) {
    return '17TRACK の API キーが正しくないか、権限がありません。設定でキーを入れ直してください'
  }
  if (status === 429) {
    return '17TRACK が混み合っています（アクセスが多いと判定されました）。時間を置いてからもう一度お試しください'
  }
  if (status >= 500) {
    return '17TRACK 側で一時的な障害が起きています。少し待ってから、もう一度お試しください'
  }
  if (apiCode !== null) {
    return `17TRACK の応答を解釈できませんでした（コード ${apiCode}${apiMessage ? `：${apiMessage}` : ''}）`
  }
  return '17TRACK の応答を解釈できませんでした'
}

/** 再試行してよいか（5xx・fetch自体の一時的な失敗だけ。429・4xxは再試行しない） */
function isRetryable(e: unknown): boolean {
  if (e instanceof Track17Error) return e.status >= 500
  return e instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT/i.test(e.message)
}

/** 5xx・通信失敗だけ、短く数回自動再試行する（ai-receipt.ts の RETRY_DELAYS_MS と同じ考え方） */
const RETRY_DELAYS_MS = [2_000, 5_000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

/** 応答本文から17TRACKのエラー（code・message）を読む。JSONでなければ null */
function parseApiError(bodyText: string): { code: number; message: string } | null {
  try {
    const json = JSON.parse(bodyText)
    const code = typeof json?.code === 'number' ? json.code : null
    if (code === null) return null
    const message = typeof json?.data?.errors?.[0]?.message === 'string' ? json.data.errors[0].message : null
    return { code, message: message ?? '' }
  } catch {
    return null
  }
}

/** 1回だけ叩く。JSONとして読めなければ Track17Error（「解釈できませんでした」） */
async function callOnce(path: string, apiKey: string, body: unknown): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        '17token': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')

    if (!res.ok) {
      const apiError = parseApiError(text)
      throw new Track17Error(
        buildErrorMessage(res.status, apiError?.code ?? null, apiError?.message ?? null),
        res.status,
        apiError?.code ?? null,
      )
    }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new Track17Error('17TRACK の応答を解釈できませんでした', res.status, null)
    }

    if (typeof json?.code !== 'number') {
      throw new Track17Error('17TRACK の応答を解釈できませんでした', res.status, null)
    }
    if (json.code !== 0) {
      throw new Track17Error(buildErrorMessage(res.status, json.code, null), res.status, json.code)
    }
    return json
  } catch (e) {
    if (e instanceof Track17Error) throw e
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Track17Error('17TRACK に接続できませんでした（タイムアウト）', 0, null)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 5xx・通信失敗だけ再試行する */
async function call(path: string, apiKey: string, body: unknown): Promise<any> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOnce(path, apiKey, body)
    } catch (e) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(e)) {
        if (e instanceof Track17Error) throw e
        throw new Track17Error('17TRACK に接続できませんでした（通信エラー）', 0, null)
      }
      await sleep(RETRY_DELAYS_MS[attempt - 1])
    }
  }
  // ここには到達しない（ループ内で必ず return か throw する）。
  // それでも人に見える文言にしておく（英語の内部用語を画面に出さないため）
  throw new Track17Error('17TRACK に接続できませんでした（通信エラー）', 0, null)
}

/**
 * 追跡番号を 17TRACK に登録する。40件ずつに分け、1秒に3回を超えないよう
 * バッチ間に間を置く。carrier は送らない（17TRACK に自動判別させる）。
 * -18019901（すでに登録済み）は accepted 扱い（課金もされないため）
 */
export async function registerNumbers(apiKey: string, numbers: string[]): Promise<{
  accepted: string[]
  rejected: Array<{ number: string; code: number; message: string }>
}> {
  const accepted: string[] = []
  const rejected: Array<{ number: string; code: number; message: string }> = []
  const batches = toBatches(numbers)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const json = await call('/register', apiKey, batch.map(number => ({ number })))
    const data = json?.data ?? {}
    const acceptedItems: any[] = Array.isArray(data.accepted) ? data.accepted : []
    const rejectedItems: any[] = Array.isArray(data.rejected) ? data.rejected : []

    for (const item of acceptedItems) {
      if (typeof item?.number === 'string') accepted.push(item.number)
    }
    for (const item of rejectedItems) {
      const number = typeof item?.number === 'string' ? item.number : ''
      const code = typeof item?.error?.code === 'number' ? item.error.code : 0
      const message = typeof item?.error?.message === 'string' ? item.error.message : ''
      if (code === ALREADY_REGISTERED_CODE) {
        accepted.push(number)
      } else {
        rejected.push({ number, code, message })
      }
    }

    if (i < batches.length - 1) await sleep(BATCH_INTERVAL_MS)
  }

  return { accepted, rejected }
}

/** event が「配達された event」か（sub_status か stage のどちらかで当たればよい） */
function isDeliveredEvent(event: any): boolean {
  return event?.sub_status === 'Delivered_Other' || event?.stage === 'Delivered'
}

/**
 * event の時刻を「並び替え用」の ms へ。実物は time_utc（文字列）・time_iso（文字列）・
 * time_raw（文字列 or { date, time, timezone }）のどれかを持つ。複数の配達 event が
 * あるとき「いちばん新しいもの」を選ぶためだけに使う。読めなければ NaN
 */
function eventTimestampMs(event: any): number {
  for (const raw of [event?.time_utc, event?.time_iso]) {
    if (typeof raw !== 'string' || !raw) continue
    const t = new Date(raw).getTime()
    if (!Number.isNaN(t)) return t
  }
  const timeRaw = event?.time_raw
  if (typeof timeRaw === 'string' && timeRaw) {
    const t = new Date(timeRaw).getTime()
    if (!Number.isNaN(t)) return t
  }
  if (timeRaw && typeof timeRaw === 'object') {
    const date = typeof timeRaw.date === 'string' ? timeRaw.date : ''
    const time = typeof timeRaw.time === 'string' ? timeRaw.time : '00:00:00'
    const timezone = typeof timeRaw.timezone === 'string' ? timeRaw.timezone : ''
    if (date) {
      const t = new Date(`${date}T${time}${timezone}`).getTime()
      if (!Number.isNaN(t)) return t
    }
  }
  return Number.NaN
}

/** 時刻の文字列（ISO・「YYYY-MM-DD HH:mm:ss」等）を JST の YYYY-MM-DD へ。読めなければ null */
function toLocalDate(raw: string | null): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return todayLocal(d)
}

/**
 * 1件の event から到着日（YYYY-MM-DD）を取り出す。優先順位：
 *   1. time_raw.date（配達場所の壁時計の日付。実行環境のタイムゾーン設定に一切左右されない）
 *   2. time_raw が文字列ならそれを toLocalDate へ（time_raw をオブジェクトで返さない配送会社向け）
 *   3. time_iso（文字列）→ toLocalDate
 *   4. time_utc（文字列）→ toLocalDate
 * どれも読めなければ null
 */
function extractEventDate(event: any): string | null {
  const timeRaw = event?.time_raw
  if (timeRaw && typeof timeRaw === 'object' && typeof timeRaw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(timeRaw.date)) {
    return timeRaw.date
  }
  if (typeof timeRaw === 'string' && timeRaw) {
    const local = toLocalDate(timeRaw)
    if (local) return local
  }
  const isoLocal = toLocalDate(typeof event?.time_iso === 'string' ? event.time_iso : null)
  if (isoLocal) return isoLocal
  return toLocalDate(typeof event?.time_utc === 'string' ? event.time_utc : null)
}

/**
 * providers[].events[] から「配達された event」（sub_status が Delivered_Other、
 * または stage が Delivered）を探す。複数あれば最も新しいものの到着日を返す。
 * 無ければ null
 */
function findDeliveredEventDate(trackInfo: any): string | null {
  const providers: any[] = trackInfo?.tracking?.providers ?? []
  let best: any = null
  let bestTime = Number.NEGATIVE_INFINITY
  for (const provider of providers) {
    const events: any[] = Array.isArray(provider?.events) ? provider.events : []
    for (const event of events) {
      if (!isDeliveredEvent(event)) continue
      const t = eventTimestampMs(event)
      const rank = Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
      if (!best || rank > bestTime) {
        best = event
        bestTime = rank
      }
    }
  }
  return best ? extractEventDate(best) : null
}

/** 1件の accepted 要素を Track17Read へ整える */
function toTrack17Read(item: any): Track17Read {
  const number = typeof item?.number === 'string' ? item.number : ''
  const trackInfo = item?.track_info ?? {}
  const latestStatus = trackInfo?.latest_status ?? {}
  const status = toTrack17Status(latestStatus?.status)
  const subStatus = typeof latestStatus?.sub_status === 'string' ? latestStatus.sub_status : null

  const latestEventRaw = trackInfo?.latest_event?.time_iso ?? trackInfo?.latest_event?.time_utc ?? null
  const latestEventAt = typeof latestEventRaw === 'string' ? latestEventRaw : null

  let deliveredAt: string | null = null
  if (status === 'Delivered') {
    // 「配達された event」自身の日付を優先。無ければ latest_event を予備に使う
    // （latest_event についても同じ優先順位＝time_raw.date を先に見る）
    deliveredAt = findDeliveredEventDate(trackInfo) ?? extractEventDate(trackInfo?.latest_event)
  }

  return { number, status, subStatus, deliveredAt, latestEventAt, error: null }
}

/**
 * 登録済みの番号の状況を読む。40件ずつ。gettrackinfo は問い合わせを起こさず、
 * 登録済みのデータを読むだけ（register が先）。
 *
 * 最重要：応答の number が問い合わせた番号のどれとも一致しないものは捨てる
 * （大文字小文字の違いだけは同一とみなす。別物を書き込まないための最終防波堤）
 */
export async function getTrackInfo(apiKey: string, numbers: string[]): Promise<Track17Read[]> {
  const requested = new Set(numbers.map(n => n.toUpperCase()))
  const results: Track17Read[] = []
  const batches = toBatches(numbers)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const json = await call('/gettrackinfo', apiKey, batch.map(number => ({ number })))
    const data = json?.data ?? {}
    const acceptedItems: any[] = Array.isArray(data.accepted) ? data.accepted : []
    const rejectedItems: any[] = Array.isArray(data.rejected) ? data.rejected : []

    for (const item of acceptedItems) {
      const number = typeof item?.number === 'string' ? item.number : ''
      if (!requested.has(number.toUpperCase())) continue // 自分が問い合わせた番号でなければ捨てる
      results.push(toTrack17Read(item))
    }
    for (const item of rejectedItems) {
      const number = typeof item?.number === 'string' ? item.number : ''
      if (!requested.has(number.toUpperCase())) continue
      const code = typeof item?.error?.code === 'number' ? item.error.code : 0
      const message = typeof item?.error?.message === 'string' ? item.error.message : ''
      results.push({ number, status: 'Unknown', subStatus: null, deliveredAt: null, latestEventAt: null, error: { code, message } })
    }

    if (i < batches.length - 1) await sleep(BATCH_INTERVAL_MS)
  }

  return results
}

/**
 * 17TRACK の状態を、そろばんの到着状態に対応づける。分からないものは null（＝変えない）。
 * 到着状態の更新は前に進む方向だけなので、ここでは delivered 以外を安易に確定させない
 * （DeliveryFailure・Exception は「輸送はしている」扱いで shipped に留める）
 */
export function track17Fulfillment(status: Track17Status): Fulfillment | null {
  if (status === 'Delivered') return 'delivered'
  if (status === 'InTransit' || status === 'OutForDelivery' || status === 'AvailableForPickup' || status === 'DeliveryFailure' || status === 'Exception') {
    return 'shipped'
  }
  if (status === 'InfoReceived') return 'pending'
  return null // NotFound / Expired / Unknown
}

const SUB_STATUS_LABELS: Record<string, string> = {
  Exception_Lost: '紛失',
  Exception_Damage: '破損',
  Exception_Returned: '返送',
  Exception_Delay: '遅延',
}

/** 画面に出す日本語のラベル（purchase.tracking_status に入る。表示用） */
export function track17Label(status: Track17Status, subStatus?: string | null): string {
  const base = (() => {
    switch (status) {
      case 'Delivered': return '配達完了'
      case 'InTransit': return '輸送中'
      case 'OutForDelivery': return '配達中'
      case 'AvailableForPickup': return '受け取り待ち'
      case 'DeliveryFailure': return '配達できず'
      case 'Exception': return '異常あり'
      case 'InfoReceived': return '受付済み'
      case 'NotFound': return '情報が見つかりません'
      case 'Expired': return '期限切れ'
      default: return '不明'
    }
  })()
  const reason = subStatus ? SUB_STATUS_LABELS[subStatus] : undefined
  return reason ? `${base}（${reason}）` : base
}
