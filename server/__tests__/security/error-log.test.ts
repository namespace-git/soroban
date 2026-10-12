import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatch, type Handlers } from '../../rpc'
import { describeError } from '../../errors'
import type { Sql } from '../../db/sql'
import { handleAgent, type AgentHandlers } from '../../agent/index'
import { openDomainDb, newWorld, type DomainDb, type World } from '../domain/helpers'
import { closeFixture, openFixture, registerPc, resetWorld, type Fixture } from '../collect/helpers'

// 想定外のエラーを、オブジェクトのままログに出さない（20261012001900）。
// postgres.js のエラーは SQL の引数（個人データ・API キー）や接続の情報を持ちうるので、オブジェクトを丸ごと console.error に渡すと
// ログに載る。出してよいのは、名前・コード・メッセージ・スタックだけ（describeError）

const SECRET = 'SECRET-PERSONAL-DATA-0123'

/** postgres.js のエラーに似せた、SQL と引数を持つエラー */
function dbError(): Error {
  return Object.assign(new Error('relation "foo" does not exist'), {
    name: 'PostgresError',
    code: '42P01',
    query: `insert into expense (note) values ('${SECRET}')`,
    parameters: [SECRET, 'api-key-xyz'],
    detail: `Key (note)=(${SECRET}) already exists.`,
    where: `SQL statement "insert ... ${SECRET}"`,
    host: 'db.example.supabase.co',
  })
}

describe('describeError', () => {
  it('名前・コード・メッセージ・スタックだけ。SQL・引数・detail・接続の情報は載せない', () => {
    const out = describeError(dbError())
    expect(Object.keys(out).sort()).toEqual(['code', 'message', 'name', 'stack'])
    expect(out).toMatchObject({ name: 'PostgresError', code: '42P01', message: 'relation "foo" does not exist' })
    expect(typeof out.stack).toBe('string')
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain('api-key-xyz')
    expect(JSON.stringify(out)).not.toContain('db.example.supabase.co')
  })

  it('Error でないもの（文字列・オブジェクト・null）は、文字にして value に入れる', () => {
    expect(describeError('boom')).toEqual({ value: 'boom' })
    expect(describeError(null)).toEqual({ value: 'null' })
    expect(describeError({ parameters: [SECRET] })).toEqual({ value: '[object Object]' })
  })
})

describe('server/rpc.ts のログ', () => {
  let dom: DomainDb
  let w: World
  let spy: ReturnType<typeof vi.spyOn>

  // DB は 1 つを使い回す（テストごとに作ると、全体を並べて回したときの負荷が増える）
  beforeAll(async () => {
    dom = await openDomainDb()
    w = await newWorld(dom)
  })
  afterAll(async () => {
    await dom.close()
  })
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    spy.mockRestore()
  })

  /** console.error に渡された引数のうち、Error のオブジェクトそのもの・SQL の引数を持つものが無いこと */
  function expectNoRawErrors(): void {
    expect(spy).toHaveBeenCalled()
    for (const call of spy.mock.calls) {
      for (const arg of call.slice(1)) {
        expect(arg instanceof Error).toBe(false)
        expect(Object.keys((arg ?? {}) as object)).not.toEqual(expect.arrayContaining(['parameters']))
      }
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
    expect(JSON.stringify(spy.mock.calls)).not.toContain('api-key-xyz')
  }

  it('想定外の例外（予期しないエラー）：名前・コード・メッセージ・スタックだけを出し、応答は丸めた 500', async () => {
    const handlers: Handlers = { getDashboard: async () => { throw dbError() } }
    const res = await dispatch('getDashboard', [], { root: dom.root, identity: { householdId: w.a.householdId, userId: w.a.userId }, handlers })
    expect(res.status).toBe(500)
    const body = JSON.parse(await res.text())
    expect(body.error.code).toBe('internal')
    expect(JSON.stringify(body)).not.toContain(SECRET)
    expect(JSON.stringify(body)).not.toContain('42P01')

    const logged = spy.mock.calls.find((c) => String(c[0]).includes('予期しないエラー'))!
    expect(logged[0]).toContain('getDashboard')
    expect(logged[1]).toMatchObject({ name: 'PostgresError', code: '42P01', message: 'relation "foo" does not exist' })
    expect(Object.keys(logged[1] as object).sort()).toEqual(['code', 'message', 'name', 'stack'])
    expectNoRawErrors()
  })

  it('JSON にできない戻り値：TypeError の名前とメッセージだけを出す', async () => {
    const handlers: Handlers = { getDashboard: async () => ({ n: 1n }) }
    const res = await dispatch('getDashboard', [], { root: dom.root, identity: { householdId: w.a.householdId, userId: w.a.userId }, handlers })
    expect(res.status).toBe(500)
    const logged = spy.mock.calls.find((c) => String(c[0]).includes('応答を JSON にできません'))!
    expect(logged[1]).toMatchObject({ name: 'TypeError' })
    expect(Object.keys(logged[1] as object).sort()).toEqual(['code', 'message', 'name', 'stack'])
    expectNoRawErrors()
  })

  it('操作ログ（app_log）が書けなかったとき：リクエストは成功のまま、エラーのオブジェクトは出さない', async () => {
    // 書き込み系のメソッド（getDashboard は読み取りだけで記録しない）として、操作ログの書き込み（savepoint = sql.tx）で例外を投げる
    const handlers: Handlers = { snoozeReminder: async () => undefined }
    const failingRoot: Sql = {
      ...dom.root,
      get: dom.root.get.bind(dom.root),
      all: dom.root.all.bind(dom.root),
      run: dom.root.run.bind(dom.root),
      tx: (fn) => dom.root.tx((sql) => fn({
        get: sql.get.bind(sql),
        all: sql.all.bind(sql),
        run: sql.run.bind(sql),
        tx: async () => { throw dbError() },
      })),
    }
    const res = await dispatch('snoozeReminder', [], { root: failingRoot, identity: { householdId: w.a.householdId, userId: w.a.userId }, handlers })
    expect(res.status).toBe(200)
    const logged = spy.mock.calls.find((c) => String(c[0]).includes('操作ログの書き込みに失敗しました'))!
    expect(Object.keys(logged[1] as object).sort()).toEqual(['code', 'message', 'name', 'stack'])
    expectNoRawErrors()
  })
})

describe('server/agent/handler.ts のログ（同じ形）', () => {
  let f: Fixture
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    f = await openFixture()
    await resetWorld(f)
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(async () => {
    spy.mockRestore()
    await closeFixture(f)
  })

  it('想定外の例外：名前・コード・メッセージ・スタックだけ。応答は丸めた 500', async () => {
    const pc = await registerPc(f, f.world.a)
    const handlers: AgentHandlers = { claim: async () => { throw dbError() } }
    const res = await handleAgent(
      new Request('http://localhost/api/agent/claim', { method: 'POST', headers: { authorization: `Agent ${pc.token}` }, body: '{"args":[]}' }),
      'claim', { root: f.dom.root, env: {}, handlers },
    )
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain(SECRET)
    const logged = spy.mock.calls.find((c) => String(c[0]).includes('予期しないエラー'))!
    expect(Object.keys(logged[1] as object).sort()).toEqual(['code', 'message', 'name', 'stack'])
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
    // 鍵もログに出ない
    expect(JSON.stringify(spy.mock.calls)).not.toContain(pc.token)
  })
})
