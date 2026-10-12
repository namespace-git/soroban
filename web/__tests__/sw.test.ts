// service worker（web/sw.ts）の振る舞いを固定する。
// ビルドと同じく esbuild で変換し、偽の self（Cache・Clients・Notification）の上で動かす。
//   - /api/ は絶対にキャッシュしない（帳簿の数字が古くなる）
//   - push は {title, body, url} を通知にする。読めなくても必ず通知を出す（iOS の決まり）
//   - 通知を押したら、開いている窓へ／無ければ url を開く。外のサイトへは飛ばさない
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const ORIGIN = 'https://soroban.example'

type Listener = (event: Record<string, unknown>) => void
type Harness = {
  fire(type: string, event: Record<string, unknown>): Promise<void>
  showNotification: ReturnType<typeof vi.fn>
  clients: { claim: ReturnType<typeof vi.fn>; matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> }
  cache: Map<string, Map<string, Response>>
  fetch: ReturnType<typeof vi.fn>
}

let swCode = ''

async function loadSw(): Promise<Harness> {
  const listeners: Record<string, Listener> = {}
  const cache = new Map<string, Map<string, Response>>()
  const key = (r: Request | string) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname
  const fakeCaches = {
    open: async (name: string) => {
      if (!cache.has(name)) cache.set(name, new Map())
      const store = cache.get(name)!
      return {
        put: async (r: Request | string, res: Response) => { store.set(key(r), res) },
        add: async (r: string) => { store.set(key(r), new Response('asset')) },
        keys: async () => [...store.keys()].map((p) => new Request(ORIGIN + p)),
      }
    },
    match: async (r: Request | string) => {
      for (const store of cache.values()) if (store.has(key(r))) return store.get(key(r))!.clone()
      return undefined
    },
    keys: async () => [...cache.keys()],
    delete: async (name: string) => cache.delete(name),
  }
  const showNotification = vi.fn(async () => undefined)
  const clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => [] as unknown[]),
    openWindow: vi.fn(async () => null),
  }
  const fetchMock = vi.fn(async () => new Response('<html></html>', { status: 200 }))
  const self = {
    location: new URL(ORIGIN),
    registration: { showNotification },
    clients,
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, l: Listener) => { listeners[type] = l },
  }
  vm.runInNewContext(swCode, { self, caches: fakeCaches, fetch: fetchMock, URL, Response, Request, Set, Promise, console })
  return {
    async fire(type, event) {
      const waits: Promise<unknown>[] = []
      listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { waits.push(p) } })
      await Promise.all(waits)
    },
    showNotification,
    clients,
    cache,
    fetch: fetchMock,
  }
}

function fetchEvent(url: string, init: { method?: string; mode?: string } = {}) {
  const respondWith = vi.fn()
  const request = { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }
  return { event: { request, respondWith }, respondWith }
}

function pushEvent(data: string | null) {
  return { data: data === null ? null : { json: () => JSON.parse(data), text: () => data } }
}

beforeEach(async () => {
  const source = readFileSync(resolve(__dirname, '../sw.ts'), 'utf8')
  const { code } = await transformWithEsbuild(source, 'sw.ts', { loader: 'ts', format: 'iife', target: 'es2020' })
  swCode = code.replaceAll('__BUILD_ID__', 'test')
})

describe('fetch（殻のキャッシュ。許可リスト方式）', () => {
  it('/api/ は絶対に横取りしない（キャッシュに入れない・キャッシュから出さない）', async () => {
    const sw = await loadSw()
    for (const [url, init] of [
      [`${ORIGIN}/api/rpc/getDashboard`, {}],
      [`${ORIGIN}/api/rpc/getDashboard`, { mode: 'navigate' }],
      [`${ORIGIN}/api/anything`, {}],
    ] as const) {
      const { event, respondWith } = fetchEvent(url, init)
      await sw.fire('fetch', event)
      expect(respondWith).not.toHaveBeenCalled()
    }
    expect([...sw.cache.values()].flatMap((m) => [...m.keys()]).some((p) => p.startsWith('/api'))).toBe(false)
  })

  it('POST・別オリジン（Supabase など）・その他のパスは何もしない', async () => {
    const sw = await loadSw()
    for (const [url, init] of [
      [`${ORIGIN}/assets/a.js`, { method: 'POST' }],
      ['https://xxxx.supabase.co/auth/v1/token', {}],
      [`${ORIGIN}/something.json`, {}],
    ] as const) {
      const { event, respondWith } = fetchEvent(url, init)
      await sw.fire('fetch', event)
      expect(respondWith).not.toHaveBeenCalled()
    }
  })

  it('画面（ナビゲーション）は通信を優先し、取れたら / としてキャッシュ。つながらなければキャッシュを出す', async () => {
    const sw = await loadSw()
    const online = fetchEvent(`${ORIGIN}/`, { mode: 'navigate' })
    await sw.fire('fetch', online.event)
    expect(online.respondWith).toHaveBeenCalledTimes(1)
    const res1 = await online.respondWith.mock.calls[0][0]
    expect(res1.status).toBe(200)
    expect([...sw.cache.values()][0].has('/')).toBe(true)

    sw.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const offline = fetchEvent(`${ORIGIN}/sales`, { mode: 'navigate' })
    await sw.fire('fetch', offline.event)
    const res2 = await offline.respondWith.mock.calls[0][0]
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe('<html></html>')
  })

  it('キャッシュも無いオフラインは、日本語の 503', async () => {
    const sw = await loadSw()
    sw.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { event, respondWith } = fetchEvent(`${ORIGIN}/`, { mode: 'navigate' })
    await sw.fire('fetch', event)
    const res = await respondWith.mock.calls[0][0]
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('オフラインです')
  })

  it('/assets/（ハッシュ付き）は、あればキャッシュから。無ければ取って入れる', async () => {
    const sw = await loadSw()
    // ブラウザの同一オリジンの応答は type が 'basic'（Node の Response は 'default' なので差し替える）
    const asset = new Response('js')
    Object.defineProperty(asset, 'type', { value: 'basic' })
    sw.fetch.mockResolvedValueOnce(asset)
    const first = fetchEvent(`${ORIGIN}/assets/index-abc.js`)
    await sw.fire('fetch', first.event)
    await first.respondWith.mock.calls[0][0]
    expect(sw.fetch).toHaveBeenCalledTimes(1)
    // 2 回目は通信しない
    const second = fetchEvent(`${ORIGIN}/assets/index-abc.js`)
    await sw.fire('fetch', second.event)
    await second.respondWith.mock.calls[0][0]
    expect(sw.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('activate（古い版のキャッシュを捨てる）', () => {
  it('soroban-shell- で始まる古いものだけ消す', async () => {
    const sw = await loadSw()
    sw.cache.set('soroban-shell-old', new Map())
    sw.cache.set('other-app', new Map())
    sw.cache.set('soroban-shell-test', new Map())
    await sw.fire('activate', {})
    expect([...sw.cache.keys()].sort()).toEqual(['other-app', 'soroban-shell-test'])
    expect(sw.clients.claim).toHaveBeenCalled()
  })
})

describe('push（通知を出す）', () => {
  it('{title, body, url} を通知にする', async () => {
    const sw = await loadSw()
    await sw.fire('push', pushEvent(JSON.stringify({ title: '売れました', body: '【A040】もこ山 スクイーズ ¥5,750', url: '/?tab=sales' })))
    expect(sw.showNotification).toHaveBeenCalledWith('売れました', {
      body: '【A040】もこ山 スクイーズ ¥5,750',
      icon: '/icon-192.png',
      data: { url: '/?tab=sales' },
    })
  })

  it('tag（event id）があれば通知に付ける＝同じ出来事の通知は置き換わる。無ければ付けない', async () => {
    const sw = await loadSw()
    const eventId = '3f1c2a9e-0000-4000-8000-000000000001'
    await sw.fire('push', pushEvent(JSON.stringify({ title: '売れました', body: '', url: '/', tag: eventId })))
    expect(sw.showNotification).toHaveBeenLastCalledWith('売れました', {
      body: '', icon: '/icon-192.png', data: { url: '/' }, tag: eventId,
    })
    // 同じ tag で 2 回届いても、ブラウザが 1 つに置き換える（出す側は同じ tag を渡し続ける）
    await sw.fire('push', pushEvent(JSON.stringify({ title: '売れました', body: '', url: '/', tag: eventId })))
    const tags = sw.showNotification.mock.calls.map((c) => (c[1] as { tag?: string }).tag)
    expect(tags).toEqual([eventId, eventId])
    // tag が空・文字列でないときは付けない（空の tag を渡すと別々の通知として扱われる）
    for (const tag of ['', 42, null]) {
      await sw.fire('push', pushEvent(JSON.stringify({ title: 't', tag })))
      expect(sw.showNotification.mock.lastCall![1]).not.toHaveProperty('tag')
    }
    // 長すぎる tag は切る
    await sw.fire('push', pushEvent(JSON.stringify({ title: 't', tag: 'x'.repeat(300) })))
    expect((sw.showNotification.mock.lastCall![1] as { tag: string }).tag).toHaveLength(100)
  })

  it('JSON でなければ本文だけの通知。データが無くても必ず通知を出す（iOS は出さないと購読を外す）', async () => {
    const sw = await loadSw()
    await sw.fire('push', pushEvent('発送してください：2 件'))
    expect(sw.showNotification).toHaveBeenLastCalledWith('そろばん', expect.objectContaining({ body: '発送してください：2 件', data: { url: '/' } }))
    await sw.fire('push', pushEvent(null))
    expect(sw.showNotification).toHaveBeenLastCalledWith('そろばん', expect.objectContaining({ body: '', data: { url: '/' } }))
    expect(sw.showNotification).toHaveBeenCalledTimes(2)
  })

  it('開く先は同じオリジンの中だけ。外のサイトや javascript: は / にする', async () => {
    const sw = await loadSw()
    for (const url of ['https://evil.example/x', 'javascript:alert(1)', '//evil.example/x', 42]) {
      await sw.fire('push', pushEvent(JSON.stringify({ title: 't', url })))
      expect(sw.showNotification).toHaveBeenLastCalledWith('t', expect.objectContaining({ data: { url: '/' } }))
    }
    await sw.fire('push', pushEvent(JSON.stringify({ title: 't', url: `${ORIGIN}/inventory?x=1#a` })))
    expect(sw.showNotification).toHaveBeenLastCalledWith('t', expect.objectContaining({ data: { url: '/inventory?x=1#a' } }))
  })
})

describe('notificationclick（押したらそこへ）', () => {
  function clickEvent(url: string | undefined) {
    const close = vi.fn()
    return { event: { notification: { close, data: url === undefined ? null : { url } } }, close }
  }

  it('開いている窓があればそこへ（フォーカスして行き先を知らせる）。新しい窓は開かない', async () => {
    const sw = await loadSw()
    const win = { url: `${ORIGIN}/`, focus: vi.fn(async () => win), postMessage: vi.fn() }
    sw.clients.matchAll.mockResolvedValueOnce([{ url: 'https://other.example/', focus: vi.fn(), postMessage: vi.fn() }, win])
    const { event, close } = clickEvent('/?tab=sales')
    await sw.fire('notificationclick', event)
    expect(close).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(win.postMessage).toHaveBeenCalledWith({ type: 'soroban:open', url: '/?tab=sales' })
    expect(sw.clients.openWindow).not.toHaveBeenCalled()
  })

  it('窓が無ければ url を開く。url が壊れていれば /', async () => {
    const sw = await loadSw()
    await sw.fire('notificationclick', clickEvent('/inventory').event)
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith('/inventory')
    await sw.fire('notificationclick', clickEvent(undefined).event)
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith('/')
    await sw.fire('notificationclick', clickEvent('https://evil.example/').event)
    expect(sw.clients.openWindow).toHaveBeenLastCalledWith('/')
  })
})
