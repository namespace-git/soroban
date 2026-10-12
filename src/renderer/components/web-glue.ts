// Web 版の画面のつなぎで使う、ブラウザに触らない小さな関数。
// 画面（App.vue・Settings.vue・PushSettings.vue）から切り出してあるのは、ブラウザ無しで確かめられるようにするため。
import type { PushKinds } from '../../shared/web-types'

// --- 通知から開く（service worker の soroban:open と、起動時の URL） ---

export interface OpenTarget<T extends string> {
  tab: T
  /** goto に添える情報。タブを開くだけなら null */
  payload: { stage?: 'all'; focusId?: string } | null
}

/** 行の id としてそのまま使うので、セレクタに入れても安全な字だけ（UUID を含む） */
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

/**
 * 通知が指す先（`/?tab=sales&sale=<id>`・`/?tab=purchases&purchase=<id>`・`/?tab=settings` など）を読む。
 * 知らない tab・別のオリジンの URL・読めない値は null（無視する）。
 * tab と一緒に付く id は、該当の行を開くための focusId にする（売上は段階を「すべて」に開く）
 */
export function parseOpenTarget<T extends string>(
  raw: unknown, origin: string, tabs: readonly T[],
): OpenTarget<T> | null {
  if (typeof raw !== 'string' || raw === '') return null
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const wanted = url.searchParams.get('tab')
  const tab = tabs.find(t => t === wanted)
  if (!tab) return null
  const sale = url.searchParams.get('sale')
  const purchase = url.searchParams.get('purchase')
  if (tab === 'sales' && sale && ID_RE.test(sale)) return { tab, payload: { stage: 'all', focusId: sale } }
  if (tab === 'purchases' && purchase && ID_RE.test(purchase)) return { tab, payload: { focusId: purchase } }
  return { tab, payload: null }
}

// --- 通知の端末 ---

/** iPhone・iPad か。iPadOS 13 以降は UA が Mac になるので、タッチの有無で見分ける */
export function isAppleMobile(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
}

/** 通知の端末の名前の初期値。「iPhone」「Android」「Mac」「Windows」など。利用者が変えられる */
export function defaultDeviceLabel(ua: string, maxTouchPoints = 0): string {
  if (/iPhone|iPod/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  if (/CrOS/.test(ua)) return 'Chromebook'
  if (/Linux/.test(ua)) return 'Linux'
  return 'この端末'
}

export interface PushEnv {
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  /** ホーム画面から開いたか（display-mode: standalone、または iOS の navigator.standalone） */
  standalone: boolean
  ua: string
  maxTouchPoints: number
}

/**
 * この端末で通知を受け取れるか。**機能の有無で見る**（ブラウザの名前では決めない）。
 * iPhone・iPad は、ホーム画面に追加したアプリでだけ PushManager が使える（iOS 16.4 以降）ので、
 * 使えない／ホーム画面から開いていないときは「共有 → ホーム画面に追加」の案内にする
 */
export type PushSupport = 'ready' | 'needs-install' | 'unsupported'

export function pushSupport(env: PushEnv): PushSupport {
  const capable = env.hasServiceWorker && env.hasPushManager && env.hasNotification
  if (isAppleMobile(env.ua, env.maxTouchPoints) && (!capable || !env.standalone)) return 'needs-install'
  return capable ? 'ready' : 'unsupported'
}

/** VAPID の公開鍵（base64url）→ PushManager.subscribe の applicationServerKey */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=')
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** 通知の種類の表示（PushKinds のキー順 = 画面の並び） */
export const PUSH_KIND_ROWS: ReadonlyArray<{ key: keyof PushKinds; label: string; example: string }> = [
  { key: 'sale', label: '売れた', example: '売れました：【A040】もこ山 スクイーズ ¥5,750' },
  { key: 'shipping', label: '発送の番になった', example: '発送してください：2 件' },
  { key: 'collect', label: '取り込みの失敗・ログインが必要', example: 'メルカリにログインが必要です（リビングの PC）' },
  { key: 'arrival', label: '仕入が届いた', example: 'メロジョイの荷物が届きました（3 点）' },
]

export function allPushKinds(on: boolean): PushKinds {
  return { sale: on, shipping: on, collect: on, arrival: on }
}
