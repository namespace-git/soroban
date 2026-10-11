// そろばん Web 版の service worker（vite.config.web.ts が dist-web/sw.js として出力する）。
//
// やること
//   1. 画面の殻（HTML・JS・CSS・フォント）をキャッシュする。ホーム画面から開いたときの立ち上がりを速くするため
//   2. Push 通知を受けて出す（push）／通知を押したら画面を開く（notificationclick）
//
// **API（/api/）は絶対にキャッシュしない。** 帳簿の数字が古いまま出るのが、この製品でいちばん怖い。
// 殻のキャッシュは「許可リスト」方式（ナビゲーションと /assets/ だけ）。それ以外は何もしない（ネットワークへそのまま）。
//
// tsconfig は lib に WebWorker を入れていない（DOM と衝突する）ので、使う分の型だけここで宣言する。
// 依存を持たない（import しない）こと。ビルドは esbuild で 1 ファイルに変換するだけ。

interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request
  respondWith(response: Response | Promise<Response>): void
}
interface SwPushEvent extends SwExtendableEvent {
  readonly data: { json(): unknown; text(): string } | null
}
interface SwNotificationEvent extends SwExtendableEvent {
  readonly notification: Notification
}
interface SwWindowClient {
  readonly url: string
  focus(): Promise<SwWindowClient>
  postMessage(message: unknown): void
}
interface SwScope {
  readonly location: Location
  readonly registration: ServiceWorkerRegistration
  readonly clients: {
    claim(): Promise<void>
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<SwWindowClient[]>
    openWindow(url: string): Promise<SwWindowClient | null>
  }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void
  addEventListener(type: 'push', listener: (event: SwPushEvent) => void): void
  addEventListener(type: 'notificationclick', listener: (event: SwNotificationEvent) => void): void
}

const sw = self as unknown as SwScope

// ビルドごとに vite.config.web.ts が差し替える。古い版のキャッシュを activate で捨てるための目印
const CACHE_PREFIX = 'soroban-shell-'
const CACHE = `${CACHE_PREFIX}__BUILD_ID__`
const ICON = '/icon-192.png'

// --- 殻のキャッシュ ---

/** index.html と、そこから参照される /assets/ のファイルを先に取っておく（初回の読み込みは SW の管轄外だったため） */
async function precacheShell(): Promise<void> {
  try {
    const cache = await caches.open(CACHE)
    const res = await fetch('/', { cache: 'reload' })
    if (!res.ok) return
    const html = await res.clone().text()
    await cache.put('/', res)
    const assets = new Set<string>()
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) assets.add(m[1])
    await Promise.all([...assets].map((url) => cache.add(url).catch(() => undefined)))
  } catch {
    // オフラインなどで取れなくても、SW 自体は入れる（次に開いたとき実行時キャッシュが育つ）
  }
}

/** 画面（HTML）は、つながるなら常に最新を取る。つながらないときだけキャッシュを出す */
async function pageNetworkFirst(request: Request): Promise<Response> {
  try {
    const res = await fetch(request)
    if (res.ok) {
      const cache = await caches.open(CACHE)
      await cache.put('/', res.clone())
    }
    return res
  } catch {
    const cached = await caches.match('/')
    if (cached) return cached
    return new Response('オフラインです。電波の良いところでもう一度開いてください。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

/** /assets/ のファイル名は中身のハッシュ入りなので、あればそれを使ってよい */
async function assetCacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request)
  if (cached) return cached
  const res = await fetch(request)
  if (res.ok && res.type === 'basic') {
    const cache = await caches.open(CACHE)
    await cache.put(request, res.clone())
  }
  return res
}

sw.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => sw.skipWaiting()))
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  )
})

sw.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) return
  // 帳簿の数字。キャッシュに入れない・キャッシュから出さない（ここで必ず抜ける）
  if (url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(pageNetworkFirst(request))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetCacheFirst(request))
  }
})

// --- Push 通知 ---

type PushPayload = { title?: string; body?: string; url?: string }

function readPayload(event: SwPushEvent): PushPayload {
  if (!event.data) return {}
  try {
    const json = event.data.json()
    return json && typeof json === 'object' ? (json as PushPayload) : {}
  } catch {
    // JSON でなければ本文だけの通知として扱う
    return { body: event.data.text() }
  }
}

/** 通知から開く先は同じオリジンの中だけ。外のサイトへは飛ばさない */
function safeTarget(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  try {
    const u = new URL(raw, sw.location.origin)
    return u.origin === sw.location.origin ? `${u.pathname}${u.search}${u.hash}` : '/'
  } catch {
    return '/'
  }
}

sw.addEventListener('push', (event) => {
  const payload = readPayload(event)
  // iOS は push のたびに通知を出すことを求める（出さないと購読が外される）。中身が読めなくても必ず出す
  event.waitUntil(
    sw.registration.showNotification(payload.title || 'そろばん', {
      body: payload.body || '',
      icon: ICON,
      data: { url: safeTarget(payload.url) },
    }),
  )
})

sw.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = safeTarget((event.notification.data as { url?: string } | null)?.url)
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((w) => new URL(w.url).origin === sw.location.origin)
      if (open) {
        // 開いている窓があればそこへ。画面側が受け取って行き先を切り替える
        await open.focus()
        open.postMessage({ type: 'soroban:open', url: target })
        return
      }
      await sw.clients.openWindow(target)
    }),
  )
})

export {}
