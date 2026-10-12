import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkTracking, getAiStatus, getLastTrackingSummary, getTrackingApiStatus, listGeminiModels, requireGeminiCredentials,
  setAiModel, setGeminiApiKey, setTrack17ApiKey, testGemini, TRACKING_QUEUED_TEXT, type IntegrationCtx,
} from '../../domain/integrations'
import { getSettings, setSetting } from '../../domain/master'
import { UserError } from '../../errors'
import { handlers } from '../../rpc'
import { newWorld, openDomainDb, type DomainDb, type Member, type World } from '../domain/helpers'
import { addPurchase, fakeApiKey, fakeClock, jsonResponse, keyRing, newKey, spyConsole, stateOf, withEnv } from './helpers'

// 画面の口（getTrackingApiStatus ほか 9 本）。SECRET_KEYS・外部への通信は Ctx 経由で渡す（テストでは直接渡す）

let db: DomainDb
let world: World
let secretKeys: string

beforeAll(async () => {
  db = await openDomainDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  world = await newWorld(db)
  secretKeys = keyRing([1, newKey()])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const env = (extra: { secretKeys?: string | null; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) =>
  ({ secretKeys, ...extra })
const call = <T>(m: Member, fn: (ctx: IntegrationCtx) => Promise<T>, extra?: Parameters<typeof env>[0]): Promise<T> =>
  m.run(ctx => fn(withEnv(ctx, env(extra))))

describe('登録されている口', () => {
  it('契約の 9 本が API に登録されている。環境（SECRET_KEYS）が無い入口では、保存を断り、状態は safe_storage:false で伝える', async () => {
    for (const name of [
      'getTrackingApiStatus', 'setTrack17ApiKey', 'checkTracking', 'getLastTrackingSummary',
      'getAiStatus', 'setGeminiApiKey', 'setAiModel', 'testGemini', 'listGeminiModels',
    ] as const) {
      expect(typeof handlers[name], name).toBe('function')
    }
    // 入口（dispatch）経由：Ctx に SECRET_KEYS がまだ渡っていない
    const status = await world.a.call('getAiStatus')
    expect(status).toMatchObject({ status: 200, body: { result: { configured: false, model: 'gemini-flash-latest', safe_storage: false } } })
    const save = await world.a.call('setGeminiApiKey', fakeApiKey())
    expect(save.status).toBe(400)
    expect(save.body.error?.message).toMatch(/安全に保存できません/)
    expect((await world.a.call('getTrackingApiStatus')).body.result).toMatchObject({ configured: false, safe_storage: false })
  })
})

describe('API キーの保存（17TRACK・Gemini）', () => {
  it('保存すると configured になる。暗号文だけが DB に入り、getSettings に出ない。null・空文字で消せる', async () => {
    const t17 = fakeApiKey()
    const gem = fakeApiKey()
    expect(await call(world.a, getTrackingApiStatus)).toEqual({ configured: false, safe_storage: true, unregistered: 0, watching: 0 })
    expect(await call(world.a, getAiStatus)).toEqual({ configured: false, model: 'gemini-flash-latest', safe_storage: true })

    await call(world.a, ctx => setTrack17ApiKey(ctx, t17))
    await call(world.a, ctx => setGeminiApiKey(ctx, `  ${gem}  `)) // 前後の空白は落とす
    expect((await call(world.a, getTrackingApiStatus)).configured).toBe(true)
    expect((await call(world.a, getAiStatus)).configured).toBe(true)
    expect((await call(world.a, requireGeminiCredentials)).apiKey).toBe(gem)

    const settings = await world.a.run(ctx => getSettings(ctx))
    expect(JSON.stringify(settings)).not.toContain(t17)
    expect(JSON.stringify(settings)).not.toContain(gem)
    expect(Object.keys(settings).filter(k => /api_key|secret|_enc/i.test(k))).toEqual([])
    const stored = await db.pg.query<{ t: string }>(`select row_to_json(s)::text as t from app.setting_secret s where household_id = $1`, [world.a.householdId])
    expect(stored.rows).toHaveLength(2)
    for (const r of stored.rows) {
      expect(r.t).not.toContain(t17)
      expect(r.t).not.toContain(gem)
    }
    const inSetting = await db.pg.query(`select 1 from app.setting where household_id = $1 and (key ilike '%api_key%' or value like $2 or value like $3)`, [world.a.householdId, `%${t17}%`, `%${gem}%`])
    expect(inSetting.rows).toEqual([])

    await call(world.a, ctx => setTrack17ApiKey(ctx, null))
    await call(world.a, ctx => setGeminiApiKey(ctx, ''))
    expect((await call(world.a, getTrackingApiStatus)).configured).toBe(false)
    expect((await call(world.a, getAiStatus)).configured).toBe(false)
  })

  it('画面から *_enc の設定を書いても、getSettings には出ない（万一入っても出さない）', async () => {
    await world.a.run(ctx => ctx.sql.run(`insert into setting (key, value) values ('track17_api_key_enc', 'LEAK-ME')`))
    const settings = await world.a.run(ctx => getSettings(ctx))
    expect(JSON.stringify(settings)).not.toContain('LEAK-ME')
    await expect(world.a.run(ctx => setSetting(ctx, 'gemini_api_key_enc', 'x'))).rejects.toBeInstanceOf(UserError)
  })

  it('世帯 B からは世帯 A のキーが見えない・使えない。B の保存は A に影響しない', async () => {
    const mine = fakeApiKey()
    await call(world.a, ctx => setGeminiApiKey(ctx, mine))
    await call(world.a, ctx => setTrack17ApiKey(ctx, fakeApiKey()))
    expect((await call(world.b, getAiStatus)).configured).toBe(false)
    expect((await call(world.b, getTrackingApiStatus)).configured).toBe(false)
    await expect(call(world.b, requireGeminiCredentials)).rejects.toThrow(/設定がありません/)

    const theirs = fakeApiKey()
    await call(world.b, ctx => setGeminiApiKey(ctx, theirs))
    expect((await call(world.a, requireGeminiCredentials)).apiKey).toBe(mine)
    expect((await call(world.b, requireGeminiCredentials)).apiKey).toBe(theirs)
    await call(world.b, ctx => setGeminiApiKey(ctx, null))
    expect((await call(world.a, getAiStatus)).configured).toBe(true) // A の分は残る
  })

  it('SECRET_KEYS が無い・形が違う環境では保存を断る（平文で持たない）。消すことはできる', async () => {
    const spy = spyConsole()
    try {
      for (const bad of [null, undefined, '', 'broken', `1:${newKey().slice(0, 10)}`]) {
        const key = fakeApiKey()
        const err = await call(world.a, ctx => setGeminiApiKey(ctx, key), { secretKeys: bad }).catch(e => e)
        expect(err, String(bad)).toBeInstanceOf(UserError)
        expect((err as Error).message).toMatch(/安全に保存できません/)
        expect((err as Error).message).not.toContain(key)
        expect(await call(world.a, getAiStatus, { secretKeys: bad })).toMatchObject({ configured: false, safe_storage: false })
      }
      const rows = await db.pg.query(`select 1 from app.setting_secret where household_id = $1`, [world.a.householdId])
      expect(rows.rows).toEqual([])
    } finally {
      spy.restore()
    }
    await call(world.a, ctx => setGeminiApiKey(ctx, fakeApiKey()))
    await call(world.a, ctx => setGeminiApiKey(ctx, null), { secretKeys: null })
    expect((await call(world.a, getAiStatus)).configured).toBe(false)
  })

  it('変な形のキー（空白入り・改行・日本語・長すぎ・文字でない）は断る。メッセージにキーを出さない', async () => {
    for (const bad of ['has space', 'new\nline', 'ひらがな', 'x'.repeat(301), 'a\tb']) {
      const err = await call(world.a, ctx => setTrack17ApiKey(ctx, bad)).catch(e => e)
      expect(err, bad).toBeInstanceOf(UserError)
      expect((err as Error).message).not.toContain(bad)
    }
    await expect(call(world.a, ctx => setTrack17ApiKey(ctx, 123 as unknown as string))).rejects.toBeInstanceOf(UserError)
    expect((await call(world.a, getTrackingApiStatus)).configured).toBe(false)
  })

  it('復号できないキーは configured:false（入れ直してもらう）。使おうとすると日本語で案内する', async () => {
    await call(world.a, ctx => setGeminiApiKey(ctx, fakeApiKey()))
    const other = keyRing([5, newKey()]) // 別の SECRET_KEYS で動く環境
    expect((await call(world.a, getAiStatus, { secretKeys: other })).configured).toBe(false)
    await expect(call(world.a, requireGeminiCredentials, { secretKeys: other })).rejects.toThrow(/入れ直してください/)
    expect(await call(world.a, testGemini, { secretKeys: other })).toMatchObject({ ok: false, message: expect.stringMatching(/入れ直してください/) })
  })

  it('鍵を回しても読める（古い版）。読んだときに新しい版に書き直される', async () => {
    const k1 = newKey()
    const old = keyRing([1, k1])
    const gem = fakeApiKey()
    await call(world.a, ctx => setGeminiApiKey(ctx, gem), { secretKeys: old })
    const rotated = keyRing([2, newKey()], [1, k1])
    expect((await call(world.a, getAiStatus, { secretKeys: rotated })).configured).toBe(true)
    const row = await db.pg.query<{ key_version: number }>(`select key_version from app.setting_secret where household_id = $1`, [world.a.householdId])
    expect(row.rows[0].key_version).toBe(2)
    expect((await call(world.a, requireGeminiCredentials, { secretKeys: rotated })).apiKey).toBe(gem)
  })

  it('キーは getSettings だけでなく、状態・エラー・ログのどこにも出ない', async () => {
    const spy = spyConsole()
    const t17 = fakeApiKey()
    try {
      await call(world.a, ctx => setTrack17ApiKey(ctx, t17))
      const status = await call(world.a, getTrackingApiStatus)
      const ai = await call(world.a, getAiStatus)
      expect(JSON.stringify([status, ai])).not.toContain(t17)
      await call(world.a, getTrackingApiStatus, { secretKeys: keyRing([7, newKey()]) }) // 復号できない経路のログ
      expect(spy.text()).not.toContain(t17)
    } finally {
      spy.restore()
    }
  })
})

describe('checkTracking（積むだけ。すぐには 17TRACK に聞かない）', () => {
  beforeEach(async () => {
    // 通信が起きたら失敗にする（checkTracking は fetch を持たない）
    vi.stubGlobal('fetch', () => {
      throw new Error('checkTracking が通信しました')
    })
    await call(world.a, ctx => setTrack17ApiKey(ctx, fakeApiKey()))
  })

  it('キューに積んで「次の定期実行で確かめます」と返す。積み直しても位置は変わらない', async () => {
    const id = await addPurchase(world.a, { number: 'JP1', queued: false, registered: true })
    const r = await call(world.a, ctx => checkTracking(ctx, id))
    expect(r).toEqual({ status_text: TRACKING_QUEUED_TEXT, delivered_at: null })
    expect(TRACKING_QUEUED_TEXT).toMatch(/次の定期実行で確かめます/)
    expect(await stateOf(world.a, id)).toMatchObject({ queued: true, checked: false, tracking_status: null })

    const first = await world.a.run(ctx => ctx.sql.get<{ t: string }>('select tracking_queued_at as t from purchase where id = ?', id))
    await new Promise(resolve => setTimeout(resolve, 15))
    await call(world.a, ctx => checkTracking(ctx, id))
    const second = await world.a.run(ctx => ctx.sql.get<{ t: string }>('select tracking_queued_at as t from purchase where id = ?', id))
    expect(second?.t).toBe(first?.t)
  })

  it('追跡番号が無い・存在しない仕入は null。到着済みは保存済みの状態を返して積まない', async () => {
    const none = await addPurchase(world.a, { number: null, queued: false })
    const blank = await addPurchase(world.a, { number: '  ', queued: false })
    expect(await call(world.a, ctx => checkTracking(ctx, none))).toBeNull()
    expect(await call(world.a, ctx => checkTracking(ctx, blank))).toBeNull()
    expect(await call(world.a, ctx => checkTracking(ctx, '00000000-0000-4000-8000-000000000999'))).toBeNull()
    expect(await call(world.a, ctx => checkTracking(ctx, 'not-a-uuid'))).toBeNull()

    const done = await addPurchase(world.a, { number: 'JP2', queued: false, registered: true, fulfillment: 'delivered' })
    await world.a.run(ctx => ctx.sql.run(`update purchase set tracking_status = '配達完了' where id = ?`, done))
    expect(await call(world.a, ctx => checkTracking(ctx, done))).toEqual({ status_text: '配達完了', delivered_at: null })
    expect((await stateOf(world.a, done)).queued).toBe(false)
  })

  it('世帯 B の仕入は積めない（null）', async () => {
    const theirs = await addPurchase(world.b, { number: 'JPB', queued: false })
    expect(await call(world.a, ctx => checkTracking(ctx, theirs))).toBeNull()
    expect((await stateOf(world.b, theirs)).queued).toBe(false)
  })

  it('API キーが無い・読み出せない・安全に保存できない環境では、人に読める日本語で断る（積まない）', async () => {
    const id = await addPurchase(world.b, { number: 'JP3', queued: false })
    await expect(call(world.b, ctx => checkTracking(ctx, id))).rejects.toThrow(/17TRACK の設定がありません/)
    await expect(call(world.a, ctx => checkTracking(ctx, id), { secretKeys: null })).resolves.toBeNull() // 他の世帯の仕入
    const mine = await addPurchase(world.a, { number: 'JP4', queued: false })
    await expect(call(world.a, ctx => checkTracking(ctx, mine), { secretKeys: null })).rejects.toThrow(/安全に保存できません/)
    await expect(call(world.a, ctx => checkTracking(ctx, mine), { secretKeys: keyRing([9, newKey()]) })).rejects.toThrow(/入れ直してください/)
    expect((await stateOf(world.b, id)).queued).toBe(false)
    expect((await stateOf(world.a, mine)).queued).toBe(false)
  })

  it('設定 track_shipping がオフでも、1 件の「今すぐ確認」は積める（デスクトップと同じ。オフにするのは自動確認）', async () => {
    await world.a.run(ctx => setSetting(ctx, 'track_shipping', '0'))
    const id = await addPurchase(world.a, { number: 'JP5', queued: false })
    expect(await call(world.a, ctx => checkTracking(ctx, id))).toEqual({ status_text: TRACKING_QUEUED_TEXT, delivered_at: null })
    expect((await stateOf(world.a, id)).queued).toBe(true)
  })

  it('getTrackingApiStatus の件数：未登録と確認待ち（到着済みは数えない）', async () => {
    await addPurchase(world.a, { number: 'U1', queued: false })
    await addPurchase(world.a, { number: 'U2', queued: false })
    await addPurchase(world.a, { number: 'W1', queued: false, registered: true })
    await addPurchase(world.a, { number: 'D1', queued: false, registered: true, fulfillment: 'delivered' })
    expect(await call(world.a, getTrackingApiStatus)).toEqual({ configured: true, safe_storage: true, unregistered: 2, watching: 1 })
    expect(await call(world.b, getTrackingApiStatus)).toMatchObject({ unregistered: 0, watching: 0 })
  })

  it('getLastTrackingSummary：まだ確認していなければ null', async () => {
    expect(await call(world.a, getLastTrackingSummary)).toBeNull()
  })
})

describe('Gemini', () => {
  const gemini = (handler: (url: string, init: RequestInit, index: number) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; key: string | null; body: unknown }> = []
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(input), key: headers.get('x-goog-api-key'), body: init?.body ? JSON.parse(String(init.body)) : null })
      return handler(String(input), init ?? {}, calls.length - 1)
    }) as typeof fetch
    return { fetch: fetchFn, calls }
  }
  const okText = (text: string) => jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] })

  it('モデル：既定は gemini-flash-latest。変えられる。空文字で既定に戻る。変な名前は断る', async () => {
    expect((await call(world.a, getAiStatus)).model).toBe('gemini-flash-latest')
    await call(world.a, ctx => setAiModel(ctx, 'gemini-2.5-pro'))
    expect((await call(world.a, getAiStatus)).model).toBe('gemini-2.5-pro')
    expect((await call(world.b, getAiStatus)).model).toBe('gemini-flash-latest') // 世帯ごと
    await call(world.a, ctx => setAiModel(ctx, ''))
    expect((await call(world.a, getAiStatus)).model).toBe('gemini-flash-latest')
    for (const bad of ['../etc', 'a/b', 'x?y=1', 'has space', 'あ', 'x'.repeat(101)]) {
      await expect(call(world.a, ctx => setAiModel(ctx, bad)), bad).rejects.toBeInstanceOf(UserError)
    }
    // 設定に不正な値が入っていても使わない（URL に入れない）
    await world.a.run(ctx => ctx.sql.run(`insert into setting (key, value) values ('ai_model', '../x') on conflict (household_id, key) do update set value = excluded.value`))
    expect((await call(world.a, getAiStatus)).model).toBe('gemini-flash-latest')
  })

  it('testGemini：キーが無ければ ok:false で日本語。通信しない', async () => {
    const g = gemini(() => okText('ok'))
    expect(await call(world.a, testGemini, { fetch: g.fetch })).toEqual({ ok: false, message: 'AI 読み取りの設定がありません（設定 → AI 読み取り）' })
    expect(g.calls).toHaveLength(0)
  })

  it('testGemini：保存したキー・モデルで 1 回だけ小さな要求を送る。キーはヘッダーだけ', async () => {
    const key = fakeApiKey()
    await call(world.a, ctx => setGeminiApiKey(ctx, key))
    await call(world.a, ctx => setAiModel(ctx, 'gemini-2.5-pro'))
    const g = gemini(() => okText('ok'))
    expect(await call(world.a, testGemini, { fetch: g.fetch })).toEqual({ ok: true, message: '接続できました' })
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    expect(g.calls[0].key).toBe(key)
    expect(g.calls[0].url).not.toContain(key)
    expect(JSON.stringify(g.calls[0].body)).not.toContain(key)
    // pro は thinkingBudget を付けない／flash は付ける
    expect((g.calls[0].body as { generationConfig: object }).generationConfig).toEqual({})
    await call(world.a, ctx => setAiModel(ctx, 'gemini-flash-latest'))
    const g2 = gemini(() => okText('ok'))
    await call(world.a, testGemini, { fetch: g2.fetch })
    expect((g2.calls[0].body as { generationConfig: object }).generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } })
  })

  it('testGemini：失敗は例外にせず ok:false。無効なキー（400）・429 は再試行しない。メッセージにキーが出ない', async () => {
    const key = fakeApiKey()
    await call(world.a, ctx => setGeminiApiKey(ctx, key))
    const spy = spyConsole()
    try {
      const bad = gemini(() => jsonResponse({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400))
      const r1 = await call(world.a, testGemini, { fetch: bad.fetch })
      expect(r1).toEqual({ ok: false, message: 'API キーが無効です（AI Studio で作り直してください）' })
      expect(bad.calls).toHaveLength(1)

      const limited = gemini(() => jsonResponse({ error: { code: 429, message: 'quota' } }, 429))
      const r2 = await call(world.a, testGemini, { fetch: limited.fetch })
      expect(r2.ok).toBe(false)
      expect(r2.message).toMatch(/無料枠の上限/)
      expect(limited.calls).toHaveLength(1)

      const empty = gemini(() => jsonResponse({ candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }] }))
      expect((await call(world.a, testGemini, { fetch: empty.fetch })).message).toMatch(/考えすぎ/)

      for (const r of [r1, r2]) expect(r.message).not.toContain(key)
      expect(spy.text()).not.toContain(key)
    } finally {
      spy.restore()
    }
  })

  it('testGemini：503 だけ 3 秒・8 秒待って 3 回まで試す（待ちは差し替えた偽の時計）', async () => {
    await call(world.a, ctx => setGeminiApiKey(ctx, fakeApiKey()))
    const clock = fakeClock()
    const down = gemini(() => jsonResponse({ error: { code: 503, message: 'overloaded' } }, 503))
    const spy = spyConsole()
    try {
      const r = await call(world.a, testGemini, { fetch: down.fetch, sleep: clock.sleep })
      expect(down.calls).toHaveLength(3)
      expect(clock.sleeps).toEqual([3000, 8000])
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/混み合っています/)
    } finally {
      spy.restore()
    }
    const recovers = gemini((_u, _i, index) => (index === 0 ? jsonResponse({ error: { code: 503, message: 'x' } }, 503) : okText('ok')))
    expect((await call(world.a, testGemini, { fetch: recovers.fetch, sleep: clock.sleep })).ok).toBe(true)
  })

  it('listGeminiModels：generateContent 対応の gemini 系だけ。-latest が先頭、次に 2.5 系', async () => {
    await call(world.a, ctx => setGeminiApiKey(ctx, fakeApiKey()))
    const g = gemini(() => jsonResponse({
      models: [
        { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', description: 'd0', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-flash-latest', displayName: 'Flash (latest)', description: 'newest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/other', supportedGenerationMethods: ['generateContent'] },
      ],
    }))
    const list = await call(world.a, listGeminiModels, { fetch: g.fetch })
    expect(list.map(m => m.name)).toEqual(['gemini-flash-latest', 'gemini-2.5-pro', 'gemini-2.0-flash'])
    expect(list[1]).toEqual({ name: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', description: '' })
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100')
  })

  it('listGeminiModels：キー未設定は日本語の UserError。Google のエラーも日本語にしてキーを出さない', async () => {
    await expect(call(world.a, listGeminiModels)).rejects.toThrow(/AI 読み取りの設定がありません/)
    const key = fakeApiKey()
    await call(world.a, ctx => setGeminiApiKey(ctx, key))
    const spy = spyConsole()
    try {
      const denied = gemini(() => jsonResponse({ error: { code: 403, message: 'denied' } }, 403))
      const err = await call(world.a, listGeminiModels, { fetch: denied.fetch }).catch(e => e)
      expect(err).toBeInstanceOf(UserError)
      expect((err as Error).message).toMatch(/権限がありません/)
      expect((err as Error).message).not.toContain(key)
      expect(spy.text()).not.toContain(key)
    } finally {
      spy.restore()
    }
  })
})
