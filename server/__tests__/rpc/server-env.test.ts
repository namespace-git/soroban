import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { dispatchAgent, type AgentHandlers } from '../../agent/index'
import { EMPTY_SERVER_ENV, serverEnvFrom, withHousehold, type RawServerEnv } from '../../context'
import { dispatch, type Handlers } from '../../rpc'
// 業務ロジックの登録（registerHandler の副作用）。入口（functions/api/rpc）が読むのと同じもの
import '../../domain/index'
import { MEDIA_BASE, SUPABASE_URL, newWorld, openDomainDb, type DomainDb, type Member, type World } from '../domain/helpers'
import { fakeApiKey, keyRing, newKey, spyConsole } from '../integrations/helpers'
import { makeVapid, type TestVapid } from '../push/helpers'

// 環境変数（VAPID_*・SECRET_KEYS・SUPABASE_URL）が、入口 → dispatch / dispatchAgent → Ctx.env の順に渡ること。
// 渡った値で、通知の公開鍵が返り、API キーが保存できること。そして、秘密の値が応答・ログのどこにも出ないこと。
// 本物のマイグレーションを流した PGlite を使う（Cloudflare にも Supabase にも出ない）。

let dom: DomainDb
let w: World
let vapid: TestVapid

beforeAll(async () => {
  dom = await openDomainDb()
  vapid = await makeVapid()
})
afterAll(async () => {
  await dom.close()
})
beforeEach(async () => {
  w = await newWorld(dom)
})

interface Reply {
  status: number
  text: string
  body: { result?: unknown; error?: { code: string; message: string } }
}

/** 入口と同じ形で（生の環境変数を渡して）API を呼ぶ */
async function call(m: Member, env: RawServerEnv, method: string, ...args: unknown[]): Promise<Reply> {
  const response = await dispatch(method, args, { root: dom.root, identity: { householdId: m.householdId, userId: m.userId }, env })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) }
}

describe('serverEnvFrom・Ctx.env', () => {
  it('前後の空白を落とす。空・文字でないもの・無いものは null。何も渡さなければ全部 null', () => {
    expect(serverEnvFrom(undefined)).toEqual(EMPTY_SERVER_ENV)
    expect(serverEnvFrom(null)).toEqual(EMPTY_SERVER_ENV)
    expect(serverEnvFrom({
      SUPABASE_URL: ' https://x.supabase.test ', VAPID_PUBLIC_KEY: '   ', VAPID_SUBJECT: 'mailto:a@example.test', SECRET_KEYS: '',
      SUPABASE_ANON_KEY: ' anon ',
    })).toEqual({
      SUPABASE_URL: 'https://x.supabase.test', SUPABASE_ANON_KEY: 'anon', VAPID_PUBLIC_KEY: null, VAPID_PRIVATE_KEY: null,
      VAPID_SUBJECT: 'mailto:a@example.test', SECRET_KEYS: null,
    })
    // Cloudflare の env にはバインディング（文字でない値）も入る。拾わない
    expect(serverEnvFrom({ SECRET_KEYS: { binding: 1 } as unknown as string }).SECRET_KEYS).toBeNull()
    expect(Object.isFrozen(EMPTY_SERVER_ENV)).toBe(true)
  })

  it('withHousehold は env を ctx に載せる。渡さなければ全部 null。mediaBase は SUPABASE_URL から作る（直接渡せばそちらが先）', async () => {
    const ids = { householdId: w.a.householdId, userId: w.a.userId }
    expect(await withHousehold(dom.root, ids, async (ctx) => ({ env: ctx.env, base: ctx.mediaBase }))).toEqual({ env: EMPTY_SERVER_ENV, base: null })

    const env = serverEnvFrom({ SUPABASE_URL, SECRET_KEYS: '1:x' })
    const got = await withHousehold(dom.root, { ...ids, env }, async (ctx) => ({ env: ctx.env, base: ctx.mediaBase }))
    expect(got.env).toBe(env)
    expect(got.base).toBe(MEDIA_BASE)

    const direct = await withHousehold(dom.root, { ...ids, env, mediaBase: 'https://cdn.test/m' }, async (ctx) => ctx.mediaBase)
    expect(direct).toBe('https://cdn.test/m')
    expect(await withHousehold(dom.root, { ...ids, env, mediaBase: null }, async (ctx) => ctx.mediaBase)).toBeNull()
  })
})

describe('入口の env が Ctx.env に渡る', () => {
  it('dispatch：生の環境変数が整って ctx.env に入り、画像の URL の頭も同じ SUPABASE_URL から作られる', async () => {
    const handlers: Handlers = { getSettings: async (ctx) => ({ env: ctx.env, base: ctx.mediaBase }) }
    const response = await dispatch('getSettings', [], {
      root: dom.root,
      identity: { householdId: w.a.householdId, userId: w.a.userId },
      env: { SUPABASE_URL: ` ${SUPABASE_URL} `, VAPID_PUBLIC_KEY: ' pub ', SECRET_KEYS: '' },
      handlers,
    })
    expect(JSON.parse(await response.text())).toEqual({
      result: {
        env: { SUPABASE_URL, SUPABASE_ANON_KEY: null, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: null, VAPID_SUBJECT: null, SECRET_KEYS: null },
        base: MEDIA_BASE,
      },
    })
    // env を渡さない呼び出し（テスト）は全部 null
    const none = await dispatch('getSettings', [], { root: dom.root, identity: { householdId: w.a.householdId, userId: w.a.userId }, handlers })
    expect(JSON.parse(await none.text())).toEqual({ result: { env: EMPTY_SERVER_ENV, base: null } })
  })

  it('dispatchAgent：agent の文脈にも env が入る', async () => {
    const handlers: AgentHandlers = { heartbeat: async (ctx) => ({ vapid: ctx.env.VAPID_PUBLIC_KEY, subject: ctx.env.VAPID_SUBJECT, base: ctx.mediaBase }) }
    const agentId = randomUUID()
    const response = await dispatchAgent('heartbeat', [], {
      root: dom.root,
      agent: { agentId, householdId: w.a.householdId },
      env: { SUPABASE_URL, VAPID_PUBLIC_KEY: vapid.env.VAPID_PUBLIC_KEY, VAPID_SUBJECT: vapid.env.VAPID_SUBJECT },
      handlers,
    })
    expect(JSON.parse(await response.text())).toEqual({
      result: { vapid: vapid.env.VAPID_PUBLIC_KEY, subject: vapid.env.VAPID_SUBJECT, base: MEDIA_BASE },
    })
  })
})

describe('渡った env を使う口', () => {
  it('getPushConfig：入口の VAPID_PUBLIC_KEY を返す。無ければ null。秘密鍵は応答に出ない', async () => {
    const r = await call(w.a, { SUPABASE_URL, ...vapid.env }, 'getPushConfig')
    expect(r.status).toBe(200)
    expect(r.body.result).toEqual({ vapid_public_key: vapid.env.VAPID_PUBLIC_KEY })
    expect(r.text).not.toContain(vapid.env.VAPID_PRIVATE_KEY)

    expect((await call(w.a, { SUPABASE_URL }, 'getPushConfig')).body.result).toEqual({ vapid_public_key: null })
  })

  it('setGeminiApiKey：入口の SECRET_KEYS で保存できる。SECRET_KEYS が無い入口では断る（平文で持たない）', async () => {
    const ring = keyRing([1, newKey()])
    const apiKey = fakeApiKey()
    const spy = spyConsole()
    try {
      const refused = await call(w.a, { SUPABASE_URL }, 'setGeminiApiKey', apiKey)
      expect(refused.status).toBe(400)
      expect(refused.body.error?.message).toMatch(/安全に保存できません/)
      expect(refused.text).not.toContain(apiKey)
      expect((await call(w.a, { SUPABASE_URL }, 'getAiStatus')).body.result).toMatchObject({ configured: false, safe_storage: false })

      const saved = await call(w.a, { SUPABASE_URL, SECRET_KEYS: ring }, 'setGeminiApiKey', apiKey)
      expect(saved.status).toBe(200)
      expect((await call(w.a, { SUPABASE_URL, SECRET_KEYS: ring }, 'getAiStatus')).body.result)
        .toMatchObject({ configured: true, safe_storage: true })
      // 暗号文だけが DB に入る
      const stored = await dom.pg.query<{ t: string }>(
        `select row_to_json(s)::text as t from app.setting_secret s where household_id = $1`, [w.a.householdId])
      expect(stored.rows).toHaveLength(1)
      expect(stored.rows[0].t).not.toContain(apiKey)
      // 別の鍵の束の入口では読み出せない（入れ直しになる）
      expect((await call(w.a, { SUPABASE_URL, SECRET_KEYS: keyRing([1, newKey()]) }, 'getAiStatus')).body.result)
        .toMatchObject({ configured: false, safe_storage: true })
    } finally {
      spy.restore()
    }
  })
})

describe('秘密の値（VAPID_PRIVATE_KEY・SECRET_KEYS）が出ない', () => {
  it('設定が正しくても壊れていても無くても、応答・console・操作ログ（app_log）のどこにも出ない', async () => {
    const SENTINEL = 'SENTINEL-NOT-A-REAL-SECRET'
    const ringKey = newKey()
    const geminiKey = fakeApiKey()
    const track17Key = fakeApiKey()
    const secrets = [vapid.env.VAPID_PRIVATE_KEY, ringKey, SENTINEL, geminiKey, track17Key]

    const envs: RawServerEnv[] = [
      // 正しい設定
      { SUPABASE_URL, ...vapid.env, SECRET_KEYS: keyRing([1, ringKey]) },
      // 壊れた設定（読み取りの失敗のメッセージに、値が入らないこと）
      { SUPABASE_URL, ...vapid.env, VAPID_PRIVATE_KEY: SENTINEL, SECRET_KEYS: `1:${SENTINEL}` },
      // 無い
      { SUPABASE_URL },
    ]
    const calls: Array<[string, unknown[]]> = [
      ['getSettings', []], ['getPushConfig', []], ['getAiStatus', []], ['getTrackingApiStatus', []],
      ['setGeminiApiKey', [geminiKey]], ['setTrack17ApiKey', [track17Key]], ['sendTestPush', []],
      ['updateSale', ['x', {}]], ['noSuchMethod', []],
    ]

    const spy = spyConsole()
    const texts: string[] = []
    try {
      for (const env of envs) {
        for (const [method, args] of calls) texts.push((await call(w.a, env, method, ...args)).text)
      }
    } finally {
      spy.restore()
    }

    const everything = `${texts.join('\n')}\n${spy.text()}`
    for (const s of secrets) expect(everything, s.slice(0, 6)).not.toContain(s)

    const logs = await dom.pg.query<{ t: string }>(
      `select coalesce(string_agg(l::text, ''), '') as t from app.app_log l where household_id = $1`, [w.a.householdId])
    for (const s of secrets) expect(logs.rows[0].t, s.slice(0, 6)).not.toContain(s)
    // 壊れた設定は、原因（どの変数か）を日本語で伝える
    expect(texts.join('\n')).toContain('VAPID_PRIVATE_KEY')
  })
})
