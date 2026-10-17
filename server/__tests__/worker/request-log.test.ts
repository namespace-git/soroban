import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAgentEntry, handleRpcEntry, requestLogLine, type EntryEnv } from '../../entry'

// 入口（server/entry.ts）が 1 リクエストごとに出す計測のログ 1 行：
//   [rpc] <method> status=<HTTP の状態> queries=<SQL の本数> db_ms=<DB の合計> total_ms=<全体>
// DB の接続（postgres.js）と業務の処理（handleRpc / handleAgent）は偽物。入口の処理は本物を通す。
// 確かめるのは「本数と時間が合う」ことと、「秘密がログに入らない」こと。

const holder = vi.hoisted(() => ({
  /** createPostgresSql に渡された options（onQuery を取り出して、偽の処理から呼ぶ） */
  options: undefined as undefined | { onQuery?: (ms: number) => void; prepare?: boolean },
  /** 偽の handleRpc / handleAgent の中身。onQuery を何回か呼んで、応答を返す（投げてもよい） */
  work: undefined as undefined | ((onQuery: (ms: number) => void) => Promise<Response>),
}))

vi.mock('../../db/postgres', () => ({
  createPostgresSql: (_url: string, options: { onQuery?: (ms: number) => void; prepare?: boolean }) => {
    holder.options = options
    return { end: async () => {} }
  },
}))

vi.mock('../../rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rpc')>()
  return {
    ...actual,
    handleRpc: async () => holder.work!(holder.options!.onQuery!),
    closeAfterResponse: async (db: { end(): Promise<void> }) => {
      await db.end()
    },
  }
})

vi.mock('../../agent/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/index')>()
  return { ...actual, handleAgent: async () => holder.work!(holder.options!.onQuery!) }
})

// 環境に入っている秘密と、要求に入っている秘密。どれもログに出てはいけない
const SECRETS = {
  DATABASE_URL: 'postgres://dbuser:db-password-xyz@db.example:5432/postgres',
  SECRET_KEYS: '1:secret-keys-material-abc',
  VAPID_PRIVATE_KEY: 'vapid-private-key-material-def',
  SUPABASE_ANON_KEY: 'anon-key-material-ghi',
}
const BEARER = 'jwt-bearer-token-material-jkl'
const HOUSEHOLD = '00000000-0000-4000-8000-00000000000a'
const USER = '00000000-0000-4000-8000-0000000000a1'
const ARG = 'argument-material-mno'
const SQL_TEXT = 'select secret_column from secret_table'

const env: EntryEnv = { ...SECRETS }

let log: { mock: { calls: unknown[][] } }

beforeEach(() => {
  holder.options = undefined
  holder.work = undefined
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function post(path: string): Request {
  return new Request(`https://soroban.example${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'x-household': HOUSEHOLD, 'x-user': USER },
    body: JSON.stringify({ args: [ARG, SQL_TEXT] }),
  })
}

async function callRpc(method: string, request = post(`/api/rpc/${method}`), e: EntryEnv = env) {
  const waited: Promise<unknown>[] = []
  const response = await handleRpcEntry(request, e, method, (p) => void waited.push(p))
  await Promise.all(waited)
  return response
}

const LINE = /^\[(rpc|agent)\] (\S+) status=(\d+) queries=(\d+) db_ms=(\d+) total_ms=(\d+)$/

function lines(): string[] {
  return log.mock.calls.map((c) => c.map(String).join(' '))
}

describe('リクエストごとの計測ログ', () => {
  it('SQL の本数と DB の合計時間を数えて、応答のあとに 1 行だけ出す', async () => {
    holder.work = async (onQuery) => {
      onQuery(10.2)
      onQuery(20.1)
      onQuery(0.4)
      return Response.json({ result: 1 })
    }
    const response = await callRpc('listSales')
    expect(response.status).toBe(200)

    expect(lines()).toHaveLength(1)
    const m = LINE.exec(lines()[0])
    expect(m, lines()[0]).not.toBeNull()
    expect(m!.slice(1, 6)).toEqual(['rpc', 'listSales', '200', '3', '31']) // 10.2 + 20.1 + 0.4 = 30.7 → 31
    expect(Number(m![6])).toBeGreaterThanOrEqual(0)
  })

  it('全体の時間は、DB の時間より短くならない（DB を待っている間も全体に入る）', async () => {
    holder.work = async (onQuery) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      onQuery(25)
      return Response.json({ result: 1 })
    }
    await callRpc('listSales')
    const m = LINE.exec(lines()[0])!
    expect(Number(m[6])).toBeGreaterThanOrEqual(Number(m[5]))
    expect(Number(m[6])).toBeGreaterThanOrEqual(25)
  })

  it('SQL を流さなかった要求は queries=0 db_ms=0', async () => {
    holder.work = async () => Response.json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 })
    await callRpc('getSettings')
    const m = LINE.exec(lines()[0])!
    expect(m.slice(1, 6)).toEqual(['rpc', 'getSettings', '401', '0', '0'])
  })

  it('agent は [agent] で出る', async () => {
    holder.work = async (onQuery) => {
      onQuery(3)
      onQuery(4)
      return Response.json({ result: 1 })
    }
    const waited: Promise<unknown>[] = []
    const response = await handleAgentEntry(post('/api/agent/claim'), env, 'claim', (p) => void waited.push(p))
    await Promise.all(waited)
    expect(response.status).toBe(200)
    const m = LINE.exec(lines()[0])!
    expect(m.slice(1, 6)).toEqual(['agent', 'claim', '200', '2', '7'])
  })

  it('処理が例外で抜けたら status=500 として出し、例外はそのまま出る', async () => {
    holder.work = async (onQuery) => {
      onQuery(5)
      throw new Error(`boom ${SQL_TEXT} ${BEARER}`)
    }
    await expect(callRpc('listSales')).rejects.toThrow('boom')
    expect(lines()).toHaveLength(1)
    const m = LINE.exec(lines()[0])!
    expect(m.slice(1, 6)).toEqual(['rpc', 'listSales', '500', '1', '5'])
    // 例外の文もログに出さない
    expect(lines()[0]).not.toContain('boom')
  })

  it('POST 以外・接続先なしでは、行は出さない（DB に触っていない）', async () => {
    holder.work = async () => Response.json({})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const get = await callRpc('listSales', new Request('https://soroban.example/api/rpc/listSales', { method: 'GET' }))
    expect(get.status).toBe(405)
    const noDb = await callRpc('listSales', post('/api/rpc/listSales'), {})
    expect(noDb.status).toBe(500)
    expect(lines()).toEqual([])
  })

  it('秘密は出さない：環境変数・トークン・世帯 id・ユーザー id・引数・SQL の文・例外の文', async () => {
    holder.work = async (onQuery) => {
      onQuery(1)
      return Response.json({ result: { household: HOUSEHOLD, user: USER, token: BEARER } })
    }
    await callRpc('createSale')
    holder.work = async () => {
      throw new Error(`failed ${SQL_TEXT} ${ARG} ${USER} ${HOUSEHOLD}`)
    }
    await callRpc('createSale').catch(() => {})
    const waited: Promise<unknown>[] = []
    await handleAgentEntry(post('/api/agent/claim'), env, 'claim', (p) => void waited.push(p)).catch(() => {})

    const all = lines().join('\n')
    expect(lines().length).toBeGreaterThanOrEqual(3)
    for (const secret of [...Object.values(SECRETS), BEARER, HOUSEHOLD, USER, ARG, SQL_TEXT, 'secret_table', 'db-password', 'Bearer', 'authorization']) {
      expect(all, secret).not.toContain(secret)
    }
    // 出ているのは、入口の名前・メソッド名・状態・本数・時間だけ（形が決まっている）
    for (const l of lines()) expect(l).toMatch(LINE)
  })
})

describe('requestLogLine', () => {
  it('形：[入口] メソッド status= queries= db_ms= total_ms=（時間は四捨五入した整数）', () => {
    expect(requestLogLine('rpc', 'listSales', 200, 9, 186.6, 240.2)).toBe('[rpc] listSales status=200 queries=9 db_ms=187 total_ms=240')
    expect(requestLogLine('agent', 'claim', 401, 0, 0, 0.4)).toBe('[agent] claim status=401 queries=0 db_ms=0 total_ms=0')
  })

  it('メソッド名は URL から来る値。英数字・_・.・- の 64 文字までだけ出し、それ以外は - にする（改行を混ぜさせない）', () => {
    expect(requestLogLine('rpc', 'getSettings', 200, 1, 1, 1)).toContain('] getSettings status=')
    for (const bad of ['', 'a b', 'a\nb', 'a\r\n[rpc] forged status=200', 'x'.repeat(65), 'token=abc/def', 'こんにちは']) {
      const line = requestLogLine('rpc', bad, 404, 0, 0, 0)
      expect(line, JSON.stringify(bad)).toBe('[rpc] - status=404 queries=0 db_ms=0 total_ms=0')
      expect(line).not.toMatch(/[\r\n]/)
    }
  })
})
