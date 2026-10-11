import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPglite, type PgliteSql } from '../../db/pglite'
import { UserError } from '../../errors'
import { API_METHOD_NAMES, dispatch, handleRpc, handlers, registerHandler, type Handlers } from '../../rpc'
import {
  HOUSEHOLD_A,
  HOUSEHOLD_B,
  SUPABASE_URL,
  USER_A,
  USER_B,
  USER_NOBODY,
  makeKey,
  setupSchema,
  signToken,
  stubJwks,
  type KeyPair,
} from './helpers'

let db: PgliteSql
let key: KeyPair
const env = { SUPABASE_URL }

beforeAll(async () => {
  db = await openPglite()
  await setupSchema(db.pg)
  // collect_job の部分ユニーク索引と同じ名前の索引（一意制約違反を「取り込み中です」に写す確認用）
  await db.pg.exec(`
    create table app.cj (id int);
    create unique index collect_job_one_active on app.cj ((true));
    grant insert on app.cj to soroban_api;
  `)
  key = await makeKey('rpc-key')
  stubJwks([key])
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await db.close()
})

beforeEach(async () => {
  await db.pg.exec('truncate app.note; truncate app.cj')
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function call(method: string, body: unknown = { args: [] }, options: { user?: string; token?: string | null; handlers?: Handlers } = {}) {
  const token = options.token === undefined ? await signToken({ key, sub: options.user ?? USER_A }) : options.token
  const request = new Request(`http://localhost/api/rpc/${method}`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await handleRpc(request, method, { root: db, env, handlers: options.handlers })
  const text = await response.text()
  return { response, status: response.status, text, json: JSON.parse(text) as { result?: unknown; error?: { code: string; message: string } } }
}

describe('認証', () => {
  it('トークンが無ければ 401', async () => {
    const r = await call('getDashboard', undefined, { token: null })
    expect(r.status).toBe(401)
    expect(r.json.error?.code).toBe('unauthorized')
  })

  it('無効なトークンなら 401', async () => {
    const r = await call('getDashboard', undefined, { token: 'garbage' })
    expect(r.status).toBe(401)
    expect(r.json.error?.code).toBe('unauthorized')
  })

  it('世帯に属さないユーザーは 403', async () => {
    const r = await call('getDashboard', undefined, { user: USER_NOBODY, handlers: { getDashboard: async () => ({}) } })
    expect(r.status).toBe(403)
    expect(r.json.error?.code).toBe('forbidden')
  })

  it('認証はメソッド名より先：トークンが無ければ、知らないメソッド名でも 401（メソッドの有無を見せない）', async () => {
    const r = await call('noSuchMethod', undefined, { token: null })
    expect(r.status).toBe(401)
  })
})

describe('メソッド名', () => {
  it('SorobanApi に無い名前は 404', async () => {
    const r = await call('noSuchMethod')
    expect(r.status).toBe(404)
    expect(r.json.error?.code).toBe('not_found')
  })

  it('継承されたキー（constructor・__proto__ など）や空の名前では、何も呼べない', async () => {
    const methods = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '']
    for (const method of methods) {
      const r = await call(method, undefined, { handlers: {} })
      expect(r.status, method).toBe(404)
      expect(r.json.error?.code, method).toBe('not_found')
    }
  })

  it('契約にあるがまだ移植していないものは 501（メッセージにメソッド名）', async () => {
    const r = await call('listSales', undefined, { handlers: {} })
    expect(r.status).toBe(501)
    expect(r.json.error).toEqual({ code: 'not_implemented', message: 'Web 版ではまだ使えません：listSales' })
  })

  it('契約の全メソッドが、ハンドラが無ければ 501', async () => {
    expect(API_METHOD_NAMES.length).toBeGreaterThan(100)
    const identity = { userId: USER_A, householdId: HOUSEHOLD_A }
    for (const method of API_METHOD_NAMES) {
      const r = await dispatch(method, [], { root: db, identity, handlers: {} })
      expect(r.status, method).toBe(501)
    }
  })

  it('テーブルに無いキー（prototype 経由）はハンドラとして使わない', async () => {
    // 差し替えたテーブルが Object.create(別のテーブル) でも、自分のキーしか見ない
    const inherited = Object.create({ getSettings: async () => 'leak' }) as Handlers
    const r = await call('getSettings', undefined, { handlers: inherited })
    expect(r.status).toBe(501)
  })
})

describe('本文', () => {
  const okHandlers: Handlers = { getSettings: async () => ({}) }

  it('JSON でなければ 400', async () => {
    const r = await call('getSettings', '{not json', { handlers: okHandlers })
    expect(r.status).toBe(400)
    expect(r.json.error?.code).toBe('bad_request')
  })

  it('空の本文は 400', async () => {
    const r = await call('getSettings', '', { handlers: okHandlers })
    expect(r.status).toBe(400)
  })

  it('args が配列でなければ 400', async () => {
    for (const body of [{}, { args: 'x' }, { args: { 0: 1 } }, { args: null }, [], null, 'null', 42]) {
      const r = await call('getSettings', typeof body === 'string' ? body : JSON.stringify(body), { handlers: okHandlers })
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.error?.code).toBe('bad_request')
    }
  })
})

describe('ハンドラの実行', () => {
  it('登録したハンドラで 200。引数は順に渡り、戻り値は result に入る', async () => {
    const seen: unknown[] = []
    const r = await call('createTag', { args: ['新品', 3, null, { a: [1] }] }, {
      handlers: {
        createTag: async (_ctx, ...args) => {
          seen.push(...args)
          return 'tag-1'
        },
      },
    })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ result: 'tag-1' })
    expect(seen).toEqual(['新品', 3, null, { a: [1] }])
  })

  it('undefined は null になる（戻り値の無いメソッド）', async () => {
    const r = await call('deleteTag', { args: ['x'] }, { handlers: { deleteTag: async () => undefined } })
    expect(r.status).toBe(200)
    expect(r.text).toBe('{"result":null}')
  })

  it('応答は JSON で、キャッシュさせない', async () => {
    const r = await call('getSettings', undefined, { handlers: { getSettings: async () => ({ a: 'b' }) } })
    expect(r.response.headers.get('content-type')).toContain('application/json')
    expect(r.response.headers.get('cache-control')).toBe('no-store')
  })

  it('ハンドラは世帯の文脈の中：soroban_api で、世帯・ユーザーが渡り、RLS が効く', async () => {
    await db.pg.query(`insert into app.note (household_id, body) values ($1, 'A-note'), ($2, 'B-note')`, [HOUSEHOLD_A, HOUSEHOLD_B])
    const handler = async (ctx: import('../../context').Ctx) => ({
      who: (await ctx.sql.get<{ u: string }>('select current_user as u'))?.u,
      householdId: ctx.householdId,
      userId: ctx.userId,
      notes: (await ctx.sql.all<{ body: string }>('select body from note order by body')).map((n) => n.body),
    })
    const a = await call('getSettings', undefined, { user: USER_A, handlers: { getSettings: handler } })
    expect(a.json.result).toEqual({ who: 'soroban_api', householdId: HOUSEHOLD_A, userId: USER_A, notes: ['A-note'] })
    const b = await call('getSettings', undefined, { user: USER_B, handlers: { getSettings: handler } })
    expect(b.json.result).toEqual({ who: 'soroban_api', householdId: HOUSEHOLD_B, userId: USER_B, notes: ['B-note'] })
  })

  it('1 リクエスト＝1 トランザクション：例外ならそのリクエストの書き込みは全部戻る。成功すれば確定', async () => {
    const failing = await call('createTag', { args: [] }, {
      handlers: {
        createTag: async (ctx) => {
          await ctx.sql.run(`insert into note (body) values ('will be rolled back')`)
          throw new UserError('途中で失敗しました')
        },
      },
    })
    expect(failing.status).toBe(400)
    expect((await db.pg.query(`select 1 from app.note where body = 'will be rolled back'`)).rows).toHaveLength(0)

    const ok = await call('createTag', { args: [] }, {
      handlers: {
        createTag: async (ctx) => {
          await ctx.sql.run(`insert into note (body) values ('committed')`)
          return 'ok'
        },
      },
    })
    expect(ok.status).toBe(200)
    expect((await db.pg.query(`select household_id from app.note where body = 'committed'`)).rows).toEqual([{ household_id: HOUSEHOLD_A }])
  })

  it('registerHandler で型つきに登録すると、既定のテーブル（handlers）から呼ばれる', async () => {
    try {
      registerHandler('getSettings', async (ctx) => ({ household: ctx.householdId }))
      const r = await call('getSettings')
      expect(r.json).toEqual({ result: { household: HOUSEHOLD_A } })
    } finally {
      delete handlers.getSettings
    }
    expect((await call('getSettings')).status).toBe(501)
  })
})

describe('エラーの出し方', () => {
  it('UserError は日本語のメッセージがそのまま出る（code は既定 bad_request）', async () => {
    const r = await call('deleteSale', { args: ['x'] }, {
      handlers: {
        deleteSale: async () => {
          throw new UserError('販売が見つかりません', 'not_found')
        },
      },
    })
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ error: { code: 'not_found', message: '販売が見つかりません' } })

    const dup = await call('createPurchase', { args: [{}] }, {
      handlers: {
        createPurchase: async () => {
          throw new UserError('同じ注文番号がすでにあります')
        },
      },
    })
    expect(dup.status).toBe(400)
    expect(dup.json.error).toEqual({ code: 'bad_request', message: '同じ注文番号がすでにあります' })

    const busy = await call('collect', undefined, {
      handlers: {
        collect: async () => {
          throw new UserError('取り込み中です', 'conflict')
        },
      },
    })
    expect(busy.status).toBe(409)
    expect(busy.json.error).toEqual({ code: 'conflict', message: '取り込み中です' })
  })

  it('素の Error は internal に丸める。メッセージ・SQL・スタックは出さず、原因はログに出す', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await call('getSettings', { args: ['SECRET-API-KEY-123'] }, {
      handlers: {
        getSettings: async () => {
          throw new Error('販売が見つかりません: select * from sale where id = $1')
        },
      },
    })
    expect(r.status).toBe(500)
    expect(r.json.error?.code).toBe('internal')
    expect(r.text).not.toContain('select')
    expect(r.text).not.toContain('販売が見つかりません')
    expect(r.text).not.toContain('at ')
    expect(log).toHaveBeenCalled()
    // ログに引数（API キーが入りうる）を載せない
    expect(String(log.mock.calls[0][0])).not.toContain('SECRET-API-KEY-123')
  })

  it('DB のエラー（存在しない表）は internal。SQL・表の名前を出さない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await call('getSettings', undefined, {
      handlers: { getSettings: async (ctx) => ctx.sql.get('select * from secret_table_name where password = ?', 'x') },
    })
    expect(r.status).toBe(500)
    expect(r.json.error?.code).toBe('internal')
    expect(r.text).not.toContain('secret_table_name')
    expect(r.text).not.toContain('does not exist')
    expect(r.text).not.toContain('password')
  })

  it('JSON にできない戻り値（bigint）も internal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await call('getSettings', undefined, { handlers: { getSettings: async () => ({ n: 10n }) } })
    expect(r.status).toBe(500)
    expect(r.json.error?.code).toBe('internal')
  })

  it('設定の不備（SUPABASE_URL が無い）は internal で、設定の名前も出さない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const token = await signToken({ key })
    const request = new Request('http://localhost/api/rpc/getSettings', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{"args":[]}',
    })
    const response = await handleRpc(request, 'getSettings', { root: db, env: {}, handlers: { getSettings: async () => 1 } })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('SUPABASE_URL')
  })

  describe('Postgres の例外を写す', () => {
    it('DB 関数が SB で始まる SQLSTATE で投げた日本語は、そのまま 409（detail もつく）', async () => {
      const r = await call('collect', undefined, {
        handlers: {
          collect: async (ctx) => {
            await ctx.sql.run(`do $$ begin raise exception '前回の取り込みから10分たっていません' using errcode = 'SB002', detail = 'あと 42 秒'; end $$`)
          },
        },
      })
      expect(r.status).toBe(409)
      expect(r.json.error).toEqual({ code: 'conflict', message: '前回の取り込みから10分たっていません（あと 42 秒）' })
    })

    it('collect_job_one_active への 2 本目の挿入（一意制約違反）は「取り込み中です」の 409', async () => {
      const insert = { collect: async (ctx: import('../../context').Ctx) => void (await ctx.sql.run('insert into cj (id) values (1)')) }
      expect((await call('collect', undefined, { handlers: insert })).status).toBe(200)
      const r = await call('collect', undefined, { handlers: insert })
      expect(r.status).toBe(409)
      expect(r.json.error?.code).toBe('conflict')
      expect(r.json.error?.message).toContain('取り込み中です')
      expect(r.text).not.toContain('collect_job_one_active')
    })

    it('SB 以外の SQLSTATE の英語メッセージは出さない', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const r = await call('collect', undefined, {
        handlers: { collect: async (ctx) => void (await ctx.sql.run(`do $$ begin raise exception 'internal detail xyz' using errcode = 'P0001'; end $$`)) },
      })
      expect(r.status).toBe(500)
      expect(r.text).not.toContain('xyz')
    })
  })
})
