import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { createPostgresSql, type PostgresSql } from '../../db/postgres'
import type { Sql } from '../../db/sql'
import { INTERNAL_MESSAGE, UserError } from '../../errors'
import {
  BATCH_MAX_CALLS, handleRpc, handlers as realHandlers, mayQueueNotification, type Handler, type Handlers,
} from '../../rpc'
// 登録の副作用（入口の functions/api/rpc/[method].ts と同じ import）
import '../../domain/index'
import { seedItems } from '../domain/core-helpers'
import { SUPABASE_URL, newWorld, openDomainDb, type DomainDb, type World } from '../domain/helpers'
import { DRIVER_NAMES, makeKey, signToken, startBridge, stubJwks, type Bridge, type KeyPair } from './helpers'

// まとめ送り `POST /api/rpc/_batch`（server/rpc.ts の parseBatchCalls・dispatchBatch）。
// JWT → 認証 → 1 つの世帯のトランザクションの中で順に（savepoint は張らない）→ `{"results": [...]}`、までを通して確かめる。
// 失敗した 1 本が JS の例外（ApiError）なら同じトランザクションで続け、SQL のエラーなら今のトランザクションをロールバックで終わらせて
// 残りを新しいトランザクションで続ける。
// 本物のマイグレーションを流した PGlite（server/__tests__/domain/helpers.ts）と、同じ DB を TCP で見せた node-postgres の両方で流す

let dom: DomainDb
let bridge: Bridge
let key: KeyPair
let w: World
const opened: PostgresSql[] = []

beforeAll(async () => {
  dom = await openDomainDb()
  bridge = await startBridge(dom.pg)
  key = await makeKey('batch-key')
  stubJwks([key])
})

afterAll(async () => {
  vi.unstubAllGlobals()
  for (const sql of opened) await sql.end()
  await bridge.close()
  await dom.close()
})

beforeEach(async () => {
  w = await newWorld(dom)
})

type Json = { result?: unknown; error?: { code: string; message: string } }
type Item = { result: unknown } | { error: { code: string; message: string } }
type BatchBody = { results?: Item[]; error?: { code: string; message: string } }

interface Opts {
  user?: string
  token?: string | null
  handlers?: Handlers
  root?: Sql
}

async function sign(opts: Opts): Promise<string | null> {
  return opts.token === undefined ? signToken({ key, sub: opts.user ?? w.a.userId }) : opts.token
}

/** ふつうの `/api/rpc/<method>` */
async function call(method: string, args: unknown[] = [], opts: Opts = {}) {
  const token = await sign(opts)
  const request = new Request(`http://localhost/api/rpc/${method}`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify({ args }),
  })
  const response = await handleRpc(request, method, { root: opts.root ?? dom.root, env: { SUPABASE_URL }, handlers: opts.handlers ?? realHandlers })
  const text = await response.text()
  return { status: response.status, text, json: JSON.parse(text) as Json }
}

/** `/api/rpc/_batch`。body は文字列ならそのまま、そうでなければ JSON にして送る */
async function batch(body: unknown, opts: Opts = {}) {
  const token = await sign(opts)
  const request = new Request('http://localhost/api/rpc/_batch', {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await handleRpc(request, '_batch', { root: opts.root ?? dom.root, env: { SUPABASE_URL }, handlers: opts.handlers ?? realHandlers })
  const text = await response.text()
  return { response, status: response.status, text, json: JSON.parse(text) as BatchBody }
}

const calls = (...pairs: Array<[string, unknown[]?]>) => ({ calls: pairs.map(([method, args]) => ({ method, args: args ?? [] })) })

const txOf = async (ctx: Ctx) => (await ctx.sql.get<{ tx: number }>('select txid_current() as tx'))!.tx

/**
 * root を包んで、世帯のトランザクションの数・その中で張られた入れ子の tx（＝ savepoint）の数・流れた SQL の文を記録する。
 * 入れ子の tx は `sql.tx` の入れ子でしか張れない（どのドライバでも savepoint はそこから出る）ので、数えればよい
 */
function spyRoot(root: Sql) {
  const log = { transactions: 0, nested: 0, statements: [] as string[] }
  const watch = (sql: Sql): Sql => ({
    get: <T>(text: string, ...params: unknown[]) => { log.statements.push(text); return sql.get<T>(text, ...params) },
    all: <T>(text: string, ...params: unknown[]) => { log.statements.push(text); return sql.all<T>(text, ...params) },
    run: (text: string, ...params: unknown[]) => { log.statements.push(text); return sql.run(text, ...params) },
    tx: <T>(fn: (inner: Sql) => Promise<T>) => { log.nested += 1; return sql.tx(fn) },
  })
  const spied: Sql = {
    get: <T>(text: string, ...params: unknown[]) => root.get<T>(text, ...params),
    all: <T>(text: string, ...params: unknown[]) => root.all<T>(text, ...params),
    run: (text: string, ...params: unknown[]) => root.run(text, ...params),
    tx: <T>(fn: (inner: Sql) => Promise<T>) => { log.transactions += 1; return root.tx((inner) => fn(watch(inner))) },
  }
  return { root: spied, log }
}

const savepointStatement = /\bsavepoint\b/i

/** SQL のエラー（22P02）で落ちる偽のハンドラ。ふつうに呼べば bad_request「値の形が正しくありません」になる */
const sqlFailure: Handler = async (ctx) => void (await ctx.sql.get(`select 'not-a-uuid'::uuid`))
/** 今のトランザクションの識別子を返す偽のハンドラ */
const txIdentity: Handler = async (ctx) => ({ n: (await ctx.sql.get<{ n: number }>('select 41 + 1 as n'))!.n, tx: await txOf(ctx) })

/** 偽の phased ハンドラ（read → call → finish）。`registerPhasedHandler` が作るのと同じ形（`phased` 付きの関数） */
function phasedHandler(parts: NonNullable<Handler['phased']>): Handler {
  return Object.assign(async () => 'whole', { phased: parts })
}

describe('正常：ふつうに呼んだ結果と同じ', () => {
  it('3 本まとめると、それぞれをふつうに呼んだ結果と一致し、順番も同じ', async () => {
    await call('createTag', ['新品'])
    await call('createTag', ['送料込み'])
    const names: Array<[string, unknown[]]> = [['listTags', []], ['listShippingMethods', []], ['getSettings', []]]

    const separate = []
    for (const [method, args] of names) separate.push((await call(method, args)).json.result)

    const r = await batch(calls(...names))
    expect(r.status).toBe(200)
    expect(r.json.results).toEqual(separate.map((result) => ({ result })))
    expect(r.json.results!.length).toBe(3)
    // 中身が空でない（空同士の一致で通らない）
    expect(separate[0]).toHaveLength(2)
    expect((separate[1] as unknown[]).length).toBeGreaterThan(0)

    // 順番を入れ替えれば、結果も同じ順で入れ替わる
    const reversed = await batch(calls(...[...names].reverse()))
    expect(reversed.json.results).toEqual([...separate].reverse().map((result) => ({ result })))
  })

  it('応答は JSON で、キャッシュさせない。各要素は result だけ（undefined は null）', async () => {
    const r = await batch(calls(['listTags']), { handlers: { listTags: async () => undefined } })
    expect(r.response.headers.get('content-type')).toContain('application/json')
    expect(r.response.headers.get('cache-control')).toBe('no-store')
    expect(r.text).toBe('{"results":[{"result":null}]}')
  })

  it('25 本ちょうどまで受ける', async () => {
    const r = await batch({ calls: Array.from({ length: BATCH_MAX_CALLS }, () => ({ method: 'listTags', args: [] })) })
    expect(BATCH_MAX_CALLS).toBe(25)
    expect(r.status).toBe(200)
    expect(r.json.results).toHaveLength(25)
  })

  it('引数は順に渡る。同じメソッドを違う引数で複数本出せる', async () => {
    const seen: unknown[][] = []
    const r = await batch(calls(['suggestInventory', ['id-1', 3]], ['suggestInventory', ['id-2', 4]]), {
      handlers: { suggestInventory: async (_ctx, ...args) => { seen.push(args); return args[0] } },
    })
    expect(r.json.results).toEqual([{ result: 'id-1' }, { result: 'id-2' }])
    expect(seen).toEqual([['id-1', 3], ['id-2', 4]])
  })

  it('認証は 1 回・世帯のトランザクションも 1 つ（5 本で root.tx は 1 回）。全部同じトランザクション', async () => {
    const txSpy = vi.spyOn(dom.root, 'tx')
    try {
      const h: Handler = async (ctx) => txOf(ctx)
      const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns'], ['listCashAccounts'], ['listLiabilities']), {
        handlers: { listTags: h, getSettings: h, listRuns: h, listCashAccounts: h, listLiabilities: h },
      })
      expect(txSpy).toHaveBeenCalledTimes(1)
      const txs = (r.json.results as Array<{ result: number }>).map((x) => x.result)
      expect(new Set(txs).size).toBe(1)
    } finally {
      txSpy.mockRestore()
    }
  })

  it('ハンドラは世帯の文脈の中：soroban_api で、世帯・ユーザーが渡る', async () => {
    const h: Handler = async (ctx) => ({
      who: (await ctx.sql.get<{ u: string }>('select current_user as u'))?.u,
      householdId: ctx.householdId,
      userId: ctx.userId,
    })
    const r = await batch(calls(['getSettings'], ['listTags']), { handlers: { getSettings: h, listTags: h } })
    const expected = { result: { who: 'soroban_api', householdId: w.a.householdId, userId: w.a.userId } }
    expect(r.json.results).toEqual([expected, expected])
  })

  it('読み取りだけなので操作ログ（app_log）は書かない。通知も送らない', async () => {
    const before = await w.a.run((c) => c.sql.get<{ c: number }>('select count(*) as c from app_log'))
    await batch(calls(['listTags'], ['getSettings']))
    const after = await w.a.run((c) => c.sql.get<{ c: number }>('select count(*) as c from app_log'))
    expect(after).toEqual(before)
    expect(mayQueueNotification('_batch', new Response('{}', { status: 200 }))).toBe(false)
    // ふつうの書き込みは今までどおり
    expect(mayQueueNotification('createTag', new Response('{}', { status: 200 }))).toBe(true)
  })
})

// 本番のドライバ（node-postgres）でも、失敗のあとのトランザクションの扱いが同じになること。PGlite と同じ内容を、2 つで流す
const ROOTS = DRIVER_NAMES

function rootFor(name: (typeof ROOTS)[number]): Sql {
  if (name === 'PGlite') return dom.root
  const sql = createPostgresSql(bridge.url)
  opened.push(sql)
  return sql
}

describe.each(ROOTS)('1 本の失敗は、その 1 本だけ error：%s', (name) => {
  it('存在しない id の getPurchase が失敗しても、他の 2 本は返り、error の code・message はふつうに呼んだときと同じ', async () => {
    const root = rootFor(name)
    await call('createTag', ['残る'], { root })
    const missing = '00000000-0000-4000-8000-0000000000aa'
    const ordinary = await call('getPurchase', [missing], { root })
    expect(ordinary.status).toBe(404)

    const r = await batch(calls(['listTags'], ['getPurchase', [missing]], ['listShippingMethods']), { root })
    expect(r.status).toBe(200)
    const results = r.json.results!
    expect(results).toHaveLength(3)
    expect((results[0] as { result: unknown[] }).result).toHaveLength(1)
    expect(results[1]).toEqual({ error: ordinary.json.error })
    expect(results[1]).toEqual({ error: { code: 'not_found', message: '仕入が見つかりません' } })
    expect((results[2] as { result: unknown[] }).result.length).toBeGreaterThan(0)
  })

  it('正常なら savepoint を張らない：世帯のトランザクションは 1 つ、入れ子の tx は 0 回、savepoint の文も流れない', async () => {
    const spy = spyRoot(rootFor(name))
    // 通信の側からも見る（node-postgres のときだけ。PGlite のアダプタは通信を通らない）。ブリッジが DB に渡した生のバイト列から文を探す
    const wire = name === 'PGlite' ? null : vi.spyOn(dom.pg, 'execProtocolRaw')
    const sentToDb = () => (wire ? wire.mock.calls.map((c) => Buffer.from(c[0] as Uint8Array).toString('latin1')).join('\n') : '')
    try {
      // 対照：ハンドラが入れ子の tx を張れば、数にも文にも出る（数え方が効いていることの確認）
      const nested: Handler = async (ctx) => ctx.sql.tx(async (sql) => (await sql.get<{ n: number }>('select 1 as n'))!.n)
      const control = await batch(calls(['listTags'], ['getSettings']), { root: spy.root, handlers: { listTags: nested, getSettings: txIdentity } })
      expect(control.json.results![0]).toEqual({ result: 1 })
      expect(spy.log.nested).toBe(1)
      if (wire) expect(sentToDb()).toMatch(savepointStatement)

      spy.log.transactions = 0
      spy.log.nested = 0
      spy.log.statements.length = 0
      wire?.mockClear()

      const names = ['listTags', 'getSettings', 'listRuns', 'listCashAccounts', 'listLiabilities'] as const
      const r = await batch(calls(...names.map((m): [string, unknown[]] => [m, []])), {
        root: spy.root,
        handlers: { listTags: txIdentity, getSettings: txIdentity, listRuns: txIdentity, listCashAccounts: txIdentity, listLiabilities: txIdentity },
      })
      expect(r.status).toBe(200)
      const txs = (r.json.results as Array<{ result: { n: number; tx: number } }>).map((x) => x.result.tx)
      expect(txs).toHaveLength(5)
      expect(new Set(txs).size).toBe(1)
      expect(spy.log.transactions).toBe(1)
      expect(spy.log.nested).toBe(0)
      expect(spy.log.statements.length).toBeGreaterThan(0)
      expect(spy.log.statements.filter((s) => savepointStatement.test(s))).toEqual([])
      if (wire) {
        expect(sentToDb()).not.toMatch(savepointStatement)
        // begin と commit は流れている（通信を見られていることの確認）
        expect(sentToDb()).toMatch(/\bbegin\b/i)
      }
    } finally {
      wire?.mockRestore()
    }
  })

  it('UserError の 1 本のあとも、同じトランザクションで続く（新しいトランザクションを張らない）', async () => {
    const spy = spyRoot(rootFor(name))
    const userError: Handler = async (ctx) => {
      await txOf(ctx)
      throw new UserError('見つかりません', 'not_found')
    }
    const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns'], ['listCashAccounts']), {
      root: spy.root, handlers: { listTags: txIdentity, getSettings: userError, listRuns: txIdentity, listCashAccounts: txIdentity },
    })
    expect(r.status).toBe(200)
    const [a, b, c, d] = r.json.results as Array<{ result?: { n: number; tx: number }; error?: unknown }>
    expect(a.result?.n).toBe(42)
    expect(b).toEqual({ error: { code: 'not_found', message: '見つかりません' } })
    expect(c.result?.n).toBe(42)
    expect(d.result?.n).toBe(42)
    // 失敗の前後でも、同じ 1 つのトランザクション
    expect(new Set([a.result?.tx, c.result?.tx, d.result?.tx]).size).toBe(1)
    expect(spy.log.transactions).toBe(1)
    expect(spy.log.nested).toBe(0)
  })

  it('SQL が失敗した 1 本（22P02）のあと、残りは新しいトランザクションで正しく返る（「中断している」で落ちない）', async () => {
    const root = rootFor(name)
    const table: Handlers = { listTags: txIdentity, getSettings: sqlFailure, listRuns: txIdentity, listCashAccounts: sqlFailure, listLiabilities: txIdentity }

    const ordinaryBad = await call('getSettings', [], { root, handlers: table })
    expect(ordinaryBad.json.error).toEqual({ code: 'bad_request', message: '値の形が正しくありません' })

    const spy = spyRoot(root)
    const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns'], ['listCashAccounts'], ['listLiabilities']), { root: spy.root, handlers: table })
    expect(r.status).toBe(200)
    const [a, b, c, d, e] = r.json.results as Array<{ result?: { n: number; tx: number }; error?: unknown }>
    expect(a.result?.n).toBe(42)
    expect(b).toEqual({ error: ordinaryBad.json.error })
    expect(c.result?.n).toBe(42)
    expect(d).toEqual({ error: ordinaryBad.json.error })
    expect(e.result?.n).toBe(42)
    // 失敗のたびに今のトランザクションを終わらせて、残りは新しいトランザクション：a｜b を含む区切り、c｜d を含む区切り、e だけの区切り
    expect(new Set([a.result?.tx, c.result?.tx, e.result?.tx]).size).toBe(3)
    expect(spy.log.transactions).toBe(3)
    expect(spy.log.nested).toBe(0)
    // 成功した 3 本は、それぞれ 1 回だけ SQL を流した（壊れたトランザクションに入って 25P02 で落ち、やり直した、ではない）
    expect(spy.log.statements.filter((s) => s.includes('41 + 1'))).toHaveLength(3)
  })

  it('SQL が失敗したあとの呼び出しが「current transaction is aborted」（25P02）で落ちない。失敗は 1 本ずつ、残りは全部成功', async () => {
    const root = rootFor(name)
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const table: Handlers = {
        listTags: sqlFailure, getSettings: txIdentity, listRuns: sqlFailure, listCashAccounts: sqlFailure,
        listLiabilities: txIdentity, listCashEntries: txIdentity, getCashMonth: txIdentity,
      }
      const r = await batch(
        calls(['listTags'], ['getSettings'], ['listRuns'], ['listCashAccounts'], ['listLiabilities'], ['listCashEntries'], ['getCashMonth']),
        { root, handlers: table },
      )
      expect(r.status).toBe(200)
      const results = r.json.results as Array<{ result?: { n: number }; error?: { code: string; message: string } }>
      const failed = { error: { code: 'bad_request', message: '値の形が正しくありません' } }
      expect(results.map((x) => (x.error ? 'error' : x.result?.n))).toEqual(['error', 42, 'error', 'error', 42, 42, 42])
      for (const i of [0, 2, 3]) expect(results[i]).toEqual(failed)
      // 25P02・「aborted」は、応答にも（internal に丸まった形でも）ログにも出ない
      expect(r.text).not.toMatch(/aborted|25P02|internal/)
      for (const c of spyError.mock.calls) expect(JSON.stringify(c)).not.toMatch(/aborted|25P02/)
    } finally {
      spyError.mockRestore()
    }
  })

  it('SQL を握りつぶして UserError にした 1 本のあと、次の呼び出しは 25P02 で落ちず、新しいトランザクションでやり直される', async () => {
    const root = rootFor(name)
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // SQL の失敗を自分で受けて、日本語の UserError に包んで投げる（トランザクションは壊れているのに、例外は ApiError）
      const masking: Handler = async (ctx) => {
        try {
          await ctx.sql.get(`select 'not-a-uuid'::uuid`)
        } catch {
          throw new UserError('値を確かめてください')
        }
      }
      const spy = spyRoot(root)
      const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns'], ['listCashAccounts']), {
        root: spy.root, handlers: { listTags: txIdentity, getSettings: masking, listRuns: txIdentity, listCashAccounts: txIdentity },
      })
      expect(r.status).toBe(200)
      const [a, b, c, d] = r.json.results as Array<{ result?: { n: number; tx: number }; error?: { code: string; message: string } }>
      expect(a.result?.n).toBe(42)
      expect(b).toEqual({ error: { code: 'bad_request', message: '値を確かめてください' } })
      // 次の呼び出しは、落ちた呼び出しとして出さない。新しいトランザクションで本当に走る
      expect(c.result?.n).toBe(42)
      expect(d.result?.n).toBe(42)
      expect(c.result?.tx).toBe(d.result?.tx)
      expect(c.result?.tx).not.toBe(a.result?.tx)
      expect(spy.log.transactions).toBe(2)
      expect(r.text).not.toMatch(/aborted|25P02|internal/)
      for (const logged of spyError.mock.calls) expect(JSON.stringify(logged)).not.toMatch(/aborted|25P02/)
    } finally {
      spyError.mockRestore()
    }
  })

  it('素の Error（迷う例外）も、安全側で新しいトランザクションに移る。結果は元の順番', async () => {
    const root = rootFor(name)
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom: Handler = async () => {
        throw new Error('想定外')
      }
      const spy = spyRoot(root)
      const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns']), {
        root: spy.root, handlers: { listTags: txIdentity, getSettings: boom, listRuns: txIdentity },
      })
      const [a, b, c] = r.json.results as Array<{ result?: { n: number; tx: number }; error?: { code: string; message: string } }>
      expect(a.result?.n).toBe(42)
      expect(b).toEqual({ error: { code: 'internal', message: INTERNAL_MESSAGE } })
      expect(c.result?.n).toBe(42)
      expect(c.result?.tx).not.toBe(a.result?.tx)
      expect(spy.log.transactions).toBe(2)
    } finally {
      spyError.mockRestore()
    }
  })

  it('成功した本の書き込みは残る（最後にコミット）。UserError の 1 本があっても同じ', async () => {
    const root = rootFor(name)
    const failing: Handler = async () => {
      throw new UserError('途中で失敗しました', 'conflict')
    }
    const keeping: Handler = async (ctx, tagName: string) => {
      await ctx.sql.run(`insert into tag (name, sort_order) values (?, 1)`, tagName)
      return 'ok'
    }
    const r = await batch(calls(['listTags', ['残る1']], ['getSettings'], ['listRuns', ['残る2']]), {
      root, handlers: { listTags: keeping, getSettings: failing, listRuns: keeping },
    })
    expect(r.json.results).toEqual([
      { result: 'ok' },
      { error: { code: 'conflict', message: '途中で失敗しました' } },
      { result: 'ok' },
    ])
    const names = (await w.a.run((c) => c.sql.all<{ name: string }>('select name from tag order by name'))).map((t) => t.name)
    expect(names).toEqual(['残る1', '残る2'])
  })

  it('SQL が失敗した区切りはロールバックで終わる：その区切りの書き込みは残らず、新しいトランザクションの書き込みは残る', async () => {
    const root = rootFor(name)
    const keeping: Handler = async (ctx, tagName: string) => {
      await ctx.sql.run(`insert into tag (name, sort_order) values (?, 1)`, tagName)
      return 'ok'
    }
    const r = await batch(calls(['listTags', ['巻き戻る']], ['getSettings'], ['listRuns', ['残る']]), {
      root, handlers: { listTags: keeping, getSettings: sqlFailure, listRuns: keeping },
    })
    expect(r.json.results).toEqual([
      { result: 'ok' },
      { error: { code: 'bad_request', message: '値の形が正しくありません' } },
      { result: 'ok' },
    ])
    const names = (await w.a.run((c) => c.sql.all<{ name: string }>('select name from tag order by name'))).map((t) => t.name)
    expect(names).toEqual(['残る'])
  })

  it('afterCommit：SQL の失敗でロールバックした区切りの分は走らず、新しいトランザクションで成功した分はコミットのあとに走る', async () => {
    const root = rootFor(name)
    const ran: string[] = []
    const queue = (label: string): Handler => async (ctx) => {
      ctx.afterCommit(async () => void ran.push(label))
      return label
    }
    const failing: Handler = async (ctx) => {
      ctx.afterCommit(async () => void ran.push('failed'))
      await ctx.sql.get(`select 'not-a-uuid'::uuid`)
    }
    const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns'], ['listCashAccounts']), {
      root, handlers: { listTags: queue('rolled-back'), getSettings: failing, listRuns: queue('kept-1'), listCashAccounts: queue('kept-2') },
    })
    expect(r.json.results).toEqual([
      { result: 'rolled-back' },
      { error: { code: 'bad_request', message: '値の形が正しくありません' } },
      { result: 'kept-1' },
      { result: 'kept-2' },
    ])
    expect(ran).toEqual(['kept-1', 'kept-2'])
  })

  it('SQL が失敗しても phased のハンドラは走る（ふつうのハンドラのトランザクションが終わったあとで）', async () => {
    const root = rootFor(name)
    const phased = phasedHandler({ read: async () => 'in', call: async (i: string) => `${i}-called`, finish: async (_ctx, _i, c) => c })
    const r = await batch(calls(['getSettings'], ['testGemini'], ['listTags']), {
      root, handlers: { getSettings: sqlFailure, testGemini: phased, listTags: txIdentity },
    })
    const results = r.json.results as Array<{ result?: unknown; error?: unknown }>
    expect(results[0]).toEqual({ error: { code: 'bad_request', message: '値の形が正しくありません' } })
    expect(results[1]).toEqual({ result: 'in-called' })
    expect((results[2] as { result: { n: number } }).result.n).toBe(42)
  })

  it('素の Error は internal に丸まり、原因はログにだけ出る（ふつうの RPC と同じ code・message）', async () => {
    const root = rootFor(name)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom: Handler = async () => {
        throw new Error('販売が見つかりません: select * from sale where id = $1')
      }
      const ordinary = await call('getSettings', ['SECRET-API-KEY-123'], { root, handlers: { getSettings: boom } })
      const r = await batch(calls(['getSettings', ['SECRET-API-KEY-123']], ['listTags']), { root, handlers: { getSettings: boom, listTags: async () => [] } })
      expect(r.json.results).toEqual([{ error: ordinary.json.error }, { result: [] }])
      expect(r.json.results![0]).toEqual({ error: { code: 'internal', message: INTERNAL_MESSAGE } })
      expect(r.text).not.toContain('select')
      expect(spy).toHaveBeenCalled()
      for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain('SECRET-API-KEY-123')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('失敗の扱い（PGlite）', () => {
  it('ハンドラの無い読み取りメソッドは、その 1 本だけ not_implemented（ふつうの 501 と同じ文言）', async () => {
    const ordinary = await call('listTags', [], { handlers: {} })
    expect(ordinary.status).toBe(501)
    const r = await batch(calls(['listTags'], ['getSettings']), { handlers: { getSettings: async () => ({ ok: 1 }) } })
    expect(r.status).toBe(200)
    expect(r.json.results![0]).toEqual({ error: ordinary.json.error })
    expect(r.json.results![0]).toEqual({ error: { code: 'not_implemented', message: 'Web 版ではまだ使えません：listTags' } })
    expect(r.json.results![1]).toEqual({ result: { ok: 1 } })
    // 全部が未実装でも 200（トランザクションも張らない）
    const none = await batch(calls(['listTags']), { handlers: {} })
    expect(none.status).toBe(200)
  })

  it('継承されたキーはハンドラとして使わない', async () => {
    const inherited = Object.create({ getSettings: async () => 'leak' }) as Handlers
    const r = await batch(calls(['getSettings']), { handlers: inherited })
    expect(r.json.results![0]).toEqual({ error: { code: 'not_implemented', message: 'Web 版ではまだ使えません：getSettings' } })
  })

  it('JSON にできない値（bigint）を返した 1 本だけが internal。他の結果は残る', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns']), {
        handlers: { listTags: async () => ['a'], getSettings: async () => ({ n: 10n }), listRuns: async () => ['c'] },
      })
      expect(r.status).toBe(200)
      expect(r.json.results).toEqual([
        { result: ['a'] },
        { error: { code: 'internal', message: INTERNAL_MESSAGE } },
        { result: ['c'] },
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it('afterCommit は、成功した本のぶんだけがコミットのあとに走る（巻き戻した本のは走らない）', async () => {
    const ran: string[] = []
    const ok: Handler = async (ctx) => {
      ctx.afterCommit(async () => void ran.push('ok'))
      return 1
    }
    const failing: Handler = async (ctx) => {
      ctx.afterCommit(async () => void ran.push('failed'))
      throw new UserError('失敗')
    }
    const during: Handler = async (ctx) => {
      ctx.afterCommit(async () => void ran.push('late'))
      expect(ran).toEqual([]) // コミット前は走らない
      return 2
    }
    const r = await batch(calls(['listTags'], ['getSettings'], ['listRuns']), { handlers: { listTags: ok, getSettings: failing, listRuns: during } })
    expect(r.json.results).toEqual([{ result: 1 }, { error: { code: 'bad_request', message: '失敗' } }, { result: 2 }])
    expect(ran).toEqual(['ok', 'late'])
  })
})

describe('要求全体の 400（何も実行しない）', () => {
  /** 呼ばれたら記録する、読み取りの偽のハンドラ */
  function spied() {
    const seen: string[] = []
    const table: Handlers = {}
    for (const m of ['listTags', 'getSettings', 'listShippingMethods', 'getPurchase']) {
      table[m as 'listTags'] = async () => {
        seen.push(m)
        return m
      }
    }
    return { seen, table }
  }

  it('書き込みのメソッドが 1 本でも入っていたら 400。先頭でも末尾でも、読み取りは 1 本も走らない', async () => {
    for (const writeMethod of ['updateSale', 'createTag', 'deleteSale', 'setSetting', 'collect', 'createPurchase', 'linkInventory']) {
      for (const position of ['first', 'middle', 'last'] as const) {
        const { seen, table } = spied()
        const write: [string, unknown[]] = [writeMethod, ['x']]
        const read1: [string, unknown[]] = ['listTags', []]
        const read2: [string, unknown[]] = ['getSettings', []]
        const order = position === 'first' ? [write, read1, read2] : position === 'last' ? [read1, read2, write] : [read1, write, read2]
        const r = await batch(calls(...order), { handlers: table })
        expect(r.status, `${writeMethod}/${position}`).toBe(400)
        expect(r.json.error?.code).toBe('bad_request')
        expect(r.json.results).toBeUndefined()
        expect(r.json.error?.message).toContain(writeMethod)
        expect(seen, `${writeMethod}/${position}`).toEqual([])
      }
    }
  })

  it('本物のハンドラでも、書き込みは起きない（createTag をまぜても、タグは増えない）', async () => {
    const r = await batch(calls(['listTags'], ['createTag', ['書かれない']]))
    expect(r.status).toBe(400)
    expect(await w.a.run((c) => c.sql.all('select 1 from tag'))).toHaveLength(0)
    expect(await w.a.run((c) => c.sql.get<{ c: number }>('select count(*) as c from app_log'))).toEqual({ c: 0 })
  })

  it('知らないメソッド・継承されたキー・_batch 自身（入れ子）・名前でないもの', async () => {
    for (const method of ['noSuchMethod', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '_batch', '', 'LISTTAGS']) {
      const { seen, table } = spied()
      const r = await batch(calls(['listTags'], [method]), { handlers: table })
      expect(r.status, JSON.stringify(method)).toBe(400)
      expect(r.json.error?.code).toBe('bad_request')
      expect(seen).toEqual([])
    }
  })

  it('長い名前はメッセージで切る', async () => {
    const r = await batch(calls(['x'.repeat(5000)]))
    expect(r.status).toBe(400)
    expect(r.json.error!.message.length).toBeLessThan(200)
  })

  it('0 本・26 本は 400', async () => {
    const { seen, table } = spied()
    const zero = await batch({ calls: [] }, { handlers: table })
    expect(zero.status).toBe(400)
    expect(zero.json.error).toEqual({ code: 'bad_request', message: 'まとめて呼べるのは 1〜25 本です（0 本届きました）' })
    const many = await batch({ calls: Array.from({ length: BATCH_MAX_CALLS + 1 }, () => ({ method: 'listTags', args: [] })) }, { handlers: table })
    expect(many.status).toBe(400)
    expect(many.json.error?.message).toContain('26 本')
    expect(seen).toEqual([])
  })

  it('calls が配列でない・本文が JSON でない・空', async () => {
    for (const body of [{}, { calls: {} }, { calls: 'listTags' }, { calls: null }, { calls: 1 }, { args: [] }, [], null, 'null', 42, '"x"']) {
      const r = await batch(typeof body === 'string' ? body : JSON.stringify(body))
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.error?.code).toBe('bad_request')
    }
    for (const body of ['{not json', '']) {
      const r = await batch(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.error).toEqual({ code: 'bad_request', message: '要求の本文が JSON として読めません' })
    }
  })

  it('各要素の形が違う（オブジェクトでない・method が文字列でない・args が配列でない／無い）', async () => {
    const bad: unknown[] = [
      null, 'listTags', 1, [], [['listTags', []]],
      {}, { args: [] }, { method: 1, args: [] }, { method: null, args: [] }, { method: ['listTags'], args: [] },
      { method: 'listTags' }, { method: 'listTags', args: {} }, { method: 'listTags', args: 'x' }, { method: 'listTags', args: null },
      { method: 'listTags', args: { 0: 1 } },
    ]
    for (const entry of bad) {
      const { seen, table } = spied()
      const r = await batch({ calls: [{ method: 'listTags', args: [] }, entry] }, { handlers: table })
      expect(r.status, JSON.stringify(entry)).toBe(400)
      expect(r.json.error?.code).toBe('bad_request')
      expect(r.json.error?.message).toContain('2 本目')
      expect(seen).toEqual([])
    }
  })
})

describe('認証', () => {
  it('トークンが無い・無効なら 401。何も実行しない', async () => {
    for (const token of [null, 'garbage']) {
      let ran = 0
      const r = await batch(calls(['listTags']), { token, handlers: { listTags: async () => void ran++ } })
      expect(r.status).toBe(401)
      expect(r.json.error?.code).toBe('unauthorized')
      expect(ran).toBe(0)
    }
  })

  it('認証は本文の検査より先：トークンが無ければ、本文が壊れていても・書き込みが入っていても 401', async () => {
    expect((await batch('{not json', { token: null })).status).toBe(401)
    expect((await batch(calls(['updateSale', ['x']]), { token: null })).status).toBe(401)
    expect((await batch({ calls: [] }, { token: null })).status).toBe(401)
  })

  it('世帯に属さないユーザーは 403（ふつうの RPC と同じ）', async () => {
    const r = await batch(calls(['listTags']), { user: '00000000-0000-4000-8000-0000000000ee' })
    expect(r.status).toBe(403)
    expect(r.json.error?.code).toBe('forbidden')
  })
})

describe('世帯の分離', () => {
  it('A の要求のまとめの中で B の id を渡しても、B のデータは返らない', async () => {
    // B：仕入（在庫 1 点）→ 販売 → 紐付け。タグも 1 つ
    const shop = (await w.b.call('createShopAccount', 'B の店', 'mellojoy')).body.result as string
    const [itemId] = await w.b.run((c) => seedItems(c, { shopId: shop, ordered_at: '2026-09-10', lines: [{ name: 'B の商品【B100】', unit_price: 1000, quantity: 1 }] }))
    const bSale = (await w.b.call('createSale', { title: 'B の販売【B100】', sold_at: '2026-09-12', price: 3000 })).body.result as string
    expect((await w.b.call('linkInventory', bSale, [itemId])).status).toBe(200)
    const bPurchase = (await w.b.run((c) => c.sql.get<{ id: string }>('select id from purchase limit 1')))!.id
    await w.b.call('createTag', 'B のタグ')

    const sameCalls = calls(
      ['listSaleLines', [bSale]], ['listSaleLinesBulk', [[bSale]]], ['suggestInventory', [bSale, 5]], ['getAutoLinkBlockers', [bSale]],
      ['getPurchase', [bPurchase]], ['listSales'], ['listTags'], ['listInventory'],
    )

    // B 本人なら、同じ呼び出しで B のデータが返る（データがあることの確認）
    const asB = await batch(sameCalls, { user: w.b.userId })
    const b = asB.json.results as Array<{ result?: any; error?: { code: string } }>
    expect(b[0].result).toHaveLength(1)
    expect(Object.keys(b[1].result)).toEqual([bSale])
    expect(b[4].result.id).toBe(bPurchase)
    expect(b[5].result).toHaveLength(1)
    expect(b[6].result).toHaveLength(1)

    // A のまとめでは、B の id を渡しても何も返らない（ふつうに呼んだ結果とも同じ）
    const asA = await batch(sameCalls, { user: w.a.userId })
    const a = asA.json.results as Array<{ result?: any; error?: { code: string; message: string } }>
    expect(a[0]).toEqual({ result: [] })
    expect(a[1]).toEqual({ result: {} })
    expect(a[2]).toEqual({ result: [] })
    expect(a[3]).toEqual({ result: [] })
    expect(a[4]).toEqual({ error: { code: 'not_found', message: '仕入が見つかりません' } })
    expect(a[5]).toEqual({ result: [] })
    expect(a[6]).toEqual({ result: [] })
    expect(a[7]).toEqual({ result: [] })
    expect(JSON.stringify(asA.json)).not.toContain(bSale)
    expect(JSON.stringify(asA.json)).not.toContain('B のタグ')
    const ordinary = await call('getPurchase', [bPurchase], { user: w.a.userId })
    expect(a[4]).toEqual({ error: ordinary.json.error })
  })

  it('A と B のまとめを交互に出しても、世帯の文脈は混ざらない', async () => {
    const h: Handler = async (ctx) => ctx.householdId
    for (let i = 0; i < 3; i++) {
      const a = await batch(calls(['listTags'], ['getSettings']), { user: w.a.userId, handlers: { listTags: h, getSettings: h } })
      const b = await batch(calls(['listTags'], ['getSettings']), { user: w.b.userId, handlers: { listTags: h, getSettings: h } })
      expect(a.json.results).toEqual([{ result: w.a.householdId }, { result: w.a.householdId }])
      expect(b.json.results).toEqual([{ result: w.b.householdId }, { result: w.b.householdId }])
    }
  })
})

describe('phased のハンドラ（通信を挟むもの）はまとめのトランザクションに入れない', () => {
  it('前後のふつうのハンドラとは別のトランザクション。通信のあいだはトランザクションを握らない。結果は元の位置', async () => {
    const seen: { readTx?: number; finishTx?: number; during?: string } = {}
    const phased = phasedHandler({
      read: async (ctx, ...args) => {
        seen.readTx = await txOf(ctx)
        return { args }
      },
      call: async (input) => {
        // トランザクションが開いたままなら、PGlite は他の問い合わせを待たせて固まる（stuck になる）
        seen.during = await Promise.race([
          dom.root.get('select 1 as x').then(() => 'free'),
          new Promise<string>((resolve) => setTimeout(() => resolve('stuck'), 1500)),
        ])
        return { input, said: 'called' }
      },
      finish: async (ctx, _input, called) => {
        seen.finishTx = await txOf(ctx)
        return called
      },
    })
    const plain: Handler = async (ctx) => txOf(ctx)
    const r = await batch(calls(['getSettings'], ['testGemini', ['k']], ['listTags'], ['listRuns']), {
      handlers: { getSettings: plain, testGemini: phased, listTags: plain, listRuns: plain },
    })
    expect(r.status).toBe(200)
    const results = r.json.results as Array<{ result: any }>
    expect(results).toHaveLength(4)
    // ふつうの 3 本は、同じ 1 つのトランザクション。phased は元の位置（2 番目）に入る
    expect(results[0].result).toBe(results[2].result)
    expect(results[0].result).toBe(results[3].result)
    expect(results[1].result).toEqual({ input: { args: ['k'] }, said: 'called' })
    // phased の read・finish は、まとめのトランザクションでも、お互いでもない別のトランザクション
    expect(seen.readTx).toBeDefined()
    expect(seen.finishTx).toBeDefined()
    expect(seen.readTx).not.toBe(results[0].result)
    expect(seen.finishTx).not.toBe(results[0].result)
    expect(seen.readTx).not.toBe(seen.finishTx)
    expect(seen.during).toBe('free')
  })

  it('phased だけ・先頭にあっても動く。phased の失敗は、その 1 本だけ error（他は返る）', async () => {
    const failing = phasedHandler({
      read: async () => 'in',
      call: async () => {
        throw new UserError('通信に失敗しました', 'conflict')
      },
      finish: async () => 'unreachable',
    })
    const working = phasedHandler({ read: async () => 'in', call: async (i: string) => `${i}-called`, finish: async (_ctx, _i, c) => c })

    const only = await batch(calls(['testGemini']), { handlers: { testGemini: working } })
    expect(only.json.results).toEqual([{ result: 'in-called' }])

    const r = await batch(calls(['testGemini'], ['listTags'], ['listGeminiModels']), {
      handlers: { testGemini: failing, listTags: async () => ['t'], listGeminiModels: working },
    })
    expect(r.status).toBe(200)
    expect(r.json.results).toEqual([
      { error: { code: 'conflict', message: '通信に失敗しました' } },
      { result: ['t'] },
      { result: 'in-called' },
    ])
  })

  it('ふつうのハンドラが失敗しても、phased は走る（まとめのトランザクションがコミットされたあとで）', async () => {
    const order: string[] = []
    const phased = phasedHandler({
      read: async () => { order.push('read'); return 1 },
      call: async () => { order.push('call'); return 2 },
      finish: async () => { order.push('finish'); return 3 },
    })
    const failing: Handler = async () => {
      order.push('plain-failing')
      throw new UserError('失敗')
    }
    const plain: Handler = async () => {
      order.push('plain')
      return 'p'
    }
    const r = await batch(calls(['testGemini'], ['getSettings'], ['listTags']), { handlers: { testGemini: phased, getSettings: failing, listTags: plain } })
    expect(r.json.results).toEqual([{ result: 3 }, { error: { code: 'bad_request', message: '失敗' } }, { result: 'p' }])
    expect(order).toEqual(['plain-failing', 'plain', 'read', 'call', 'finish'])
  })
})
