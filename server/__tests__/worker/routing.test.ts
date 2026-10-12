import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type WorkerEnv } from '../../../worker/index'
import { fakeCtx } from './helpers'

// Workers の入口（worker/index.ts）の振り分けと、定期実行。Cloudflare にも DB にも出ない。
// DB の接続（postgres.js）と、業務の処理（handleRpc / handleAgent）と、定期実行の中身（runCron）は偽物に差し替える。
// 入口の処理（server/entry.ts）と、振り分け（worker/index.ts）は本物を通す。

const holder = vi.hoisted(() => ({
  created: [] as Array<{ url: string; options: unknown }>,
  ended: 0,
  rpc: [] as Array<{ method: string; request: Request }>,
  agent: [] as Array<{ method: string; request: Request }>,
  assets: [] as Request[],
  runCron: vi.fn(),
  events: [] as string[],
}))

vi.mock('../../db/postgres', () => ({
  createPostgresSql: (url: string, options: unknown) => {
    holder.created.push({ url, options })
    return {
      end: async () => {
        holder.ended++
        holder.events.push('end')
      },
    }
  },
}))

vi.mock('../../rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rpc')>()
  return {
    ...actual,
    handleRpc: async (request: Request, method: string) => {
      holder.rpc.push({ method, request })
      return Response.json({ result: `rpc:${method}` })
    },
    // 通知の送信は別のテスト（after-response）で確かめる。ここでは接続を閉じるだけ
    closeAfterResponse: async (db: { end(): Promise<void> }) => {
      await db.end()
    },
  }
})

vi.mock('../../agent/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/index')>()
  return {
    ...actual,
    handleAgent: async (request: Request, method: string) => {
      holder.agent.push({ method, request })
      return Response.json({ result: `agent:${method}` })
    },
  }
})

vi.mock('../../../workers/cron/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../workers/cron/index')>()
  return { ...actual, runCron: (...args: unknown[]) => holder.runCron(...args) }
})

const HTML = '<!doctype html><title>soroban</title>'

function makeEnv(extra: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    DATABASE_URL: 'postgres://u:p@db.example:5432/postgres',
    ASSETS: {
      fetch: async (request: Request) => {
        holder.assets.push(request)
        return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      },
    },
    ...extra,
  }
}

async function call(path: string, init: RequestInit = { method: 'POST', body: '{"args":[]}' }, env: WorkerEnv = makeEnv()) {
  const request = new Request(`https://soroban.example${path}`, init)
  const { ctx, done } = fakeCtx()
  const response = await worker.fetch(request, env, ctx)
  await done()
  return { request, response, text: await response.text() }
}

beforeEach(() => {
  holder.created.length = 0
  holder.ended = 0
  holder.rpc.length = 0
  holder.agent.length = 0
  holder.assets.length = 0
  holder.events.length = 0
  holder.runCron.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetch の振り分け', () => {
  it('/api/rpc/<method> は handleRpc へ（method は URL から取る）', async () => {
    const r = await call('/api/rpc/listSales')
    expect(r.response.status).toBe(200)
    expect(JSON.parse(r.text)).toEqual({ result: 'rpc:listSales' })
    expect(holder.rpc).toHaveLength(1)
    expect(holder.rpc[0].method).toBe('listSales')
    expect(holder.rpc[0].request).toBe(r.request)
    expect(holder.agent).toHaveLength(0)
    expect(holder.assets).toHaveLength(0)
  })

  it('/api/agent/<method> は handleAgent へ', async () => {
    const r = await call('/api/agent/claim')
    expect(r.response.status).toBe(200)
    expect(JSON.parse(r.text)).toEqual({ result: 'agent:claim' })
    expect(holder.agent).toHaveLength(1)
    expect(holder.agent[0].method).toBe('claim')
    expect(holder.agent[0].request).toBe(r.request)
    expect(holder.rpc).toHaveLength(0)
    expect(holder.assets).toHaveLength(0)
  })

  it('クエリは method に入らない。パーセントエンコードは戻す（Pages Functions の [method] と同じ）', async () => {
    await call('/api/rpc/getSettings?x=1')
    await call('/api/rpc/get%53ettings')
    expect(holder.rpc.map((c) => c.method)).toEqual(['getSettings', 'getSettings'])
  })

  it('それ以外の /api/* は 404 の JSON。DB にも画面にも触らない', async () => {
    for (const path of [
      '/api/other', '/api/', '/api/rpc', '/api/rpc/', '/api/rpc/a/b', '/api/agent', '/api/agent/', '/api/agent/a/b',
      '/api/rpcx/getSettings', '/api/RPC/getSettings', '/api/rpc/%E0%A4%A',
    ]) {
      const r = await call(path)
      expect(r.response.status, path).toBe(404)
      expect(r.response.headers.get('content-type'), path).toBe('application/json; charset=utf-8')
      expect(r.response.headers.get('cache-control'), path).toBe('no-store')
      expect(JSON.parse(r.text), path).toEqual({ error: { code: 'not_found', message: 'そのAPIはありません' } })
    }
    expect(holder.created).toHaveLength(0)
    expect(holder.rpc).toHaveLength(0)
    expect(holder.agent).toHaveLength(0)
    expect(holder.assets).toHaveLength(0)
  })

  it('GET など POST 以外は 405（Allow: POST）。接続は作らない', async () => {
    for (const path of ['/api/rpc/getSettings', '/api/agent/claim']) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const r = await call(path, { method })
        expect(r.response.status, `${method} ${path}`).toBe(405)
        expect(r.response.headers.get('allow')).toBe('POST')
      }
    }
    expect(holder.created).toHaveLength(0)
    expect(holder.rpc).toHaveLength(0)
  })

  it('それ以外のパスは画面（env.ASSETS）。要求をそのまま渡し、応答をそのまま返す', async () => {
    for (const path of ['/', '/sales', '/sales/123?tab=lines', '/assets/index-abc123.js', '/sw.js', '/manifest.webmanifest', '/api', '/apix', '/apiary/rpc/x']) {
      holder.assets.length = 0
      const r = await call(path, { method: 'GET' })
      expect(r.response.status, path).toBe(200)
      expect(r.text, path).toBe(HTML)
      expect(holder.assets, path).toHaveLength(1)
      expect(holder.assets[0], path).toBe(r.request)
    }
    expect(holder.created).toHaveLength(0)
    expect(holder.rpc).toHaveLength(0)
    expect(holder.agent).toHaveLength(0)
  })

  it('画面のパスは、POST でも API に回さない', async () => {
    const r = await call('/sales', { method: 'POST', body: '{}' })
    expect(r.response.status).toBe(200)
    expect(holder.assets).toHaveLength(1)
    expect(holder.rpc).toHaveLength(0)
  })
})

describe('接続の設定（Worker でも Pages と同じ）', () => {
  it('1 リクエスト 1 接続で、応答のあとに閉じる。HYPERDRIVE があれば DATABASE_URL より先に使う', async () => {
    await call('/api/rpc/getSettings')
    await call('/api/agent/claim', undefined, makeEnv({ HYPERDRIVE: { connectionString: 'postgres://hd@abc.hyperdrive.local:5432/postgres' } }))
    expect(holder.created).toEqual([
      { url: 'postgres://u:p@db.example:5432/postgres', options: { prepare: true } },
      { url: 'postgres://hd@abc.hyperdrive.local:5432/postgres', options: { prepare: true } },
    ])
    expect(holder.ended).toBe(2)
  })

  it('接続先（HYPERDRIVE も DATABASE_URL も）が無ければ 500 internal。画面は出る', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = makeEnv({ DATABASE_URL: undefined, HYPERDRIVE: undefined })
    for (const path of ['/api/rpc/getSettings', '/api/agent/claim']) {
      const r = await call(path, undefined, env)
      expect(r.response.status, path).toBe(500)
      expect(JSON.parse(r.text).error.code, path).toBe('internal')
      expect(r.text, path).not.toContain('HYPERDRIVE')
      expect(r.text, path).not.toContain('DATABASE_URL')
    }
    expect(log).toHaveBeenCalledTimes(2)
    expect(holder.created).toHaveLength(0)

    const page = await call('/', { method: 'GET' }, env)
    expect(page.response.status).toBe(200)
    expect(page.text).toBe(HTML)
  })

  it('waitUntil は ctx に結び付けて呼ぶ（外して呼ぶと Workers は Illegal invocation で断る）', async () => {
    // fakeCtx は this が ctx でなければ投げる。通れば結び付いている。登録された後始末は 1 リクエストに 1 つ
    const { ctx, waited, done } = fakeCtx()
    const response = await worker.fetch(new Request('https://soroban.example/api/rpc/getSettings', { method: 'POST', body: '{"args":[]}' }), makeEnv(), ctx)
    expect(response.status).toBe(200)
    expect(waited).toHaveLength(1)
    await done()
    expect(holder.ended).toBe(1)
  })
})

describe('scheduled（定期実行）', () => {
  const event = { cron: '*/5 * * * *', scheduledTime: 0 }

  it('HYPERDRIVE の接続で 1 本つなぎ、runCron を呼び、そのあとで閉じる', async () => {
    holder.runCron.mockImplementation(async () => {
      holder.events.push('runCron')
      return { reaped: 0, push: null, tracking: null, failed: [] }
    })
    const env = makeEnv({ HYPERDRIVE: { connectionString: 'postgres://hd@abc.hyperdrive.local:5432/postgres' }, VAPID_PUBLIC_KEY: 'pub' })
    await worker.scheduled(event, env)

    expect(holder.created).toEqual([{ url: 'postgres://hd@abc.hyperdrive.local:5432/postgres', options: { prepare: true } }])
    expect(holder.runCron).toHaveBeenCalledTimes(1)
    const [db, passedEnv] = holder.runCron.mock.calls[0]
    expect(typeof db.end).toBe('function')
    expect(passedEnv).toBe(env)
    expect(holder.events).toEqual(['runCron', 'end'])
  })

  it('HYPERDRIVE が無ければ何もしないでログに出す（DATABASE_URL があっても使わない）', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await worker.scheduled(event, makeEnv({ HYPERDRIVE: undefined }))
    expect(holder.runCron).not.toHaveBeenCalled()
    expect(holder.created).toHaveLength(0)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toContain('[cron] HYPERDRIVE が設定されていません')
  })

  it('runCron が投げても接続は閉じる', async () => {
    holder.runCron.mockRejectedValue(new Error('boom'))
    const env = makeEnv({ HYPERDRIVE: { connectionString: 'postgres://hd@abc.hyperdrive.local:5432/postgres' } })
    await expect(worker.scheduled(event, env)).rejects.toThrow('boom')
    expect(holder.ended).toBe(1)
  })
})
