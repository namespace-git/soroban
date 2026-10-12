import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withHousehold } from '../../context'
import { UserError } from '../../errors'
import {
  bytesToBase64, removeAfterCommit, requireStorageConfig, storageClient, storageConfigOf, SIGNED_URL_TTL_SECONDS,
  type StorageConfig,
} from '../../storage'
import { spyConsole } from '../integrations/helpers'
import { openDomainDb, type DomainDb } from '../domain/helpers'
import { ANON_KEY, newUploadWorld, receiptPath, SUPABASE_URL, type UploadWorld } from './helpers'

// Storage の REST の呼び方（server/storage.ts）。要求した人の JWT ＋ anon キーで呼ぶ・署名はまとめて 1 回・
// 通信の失敗は日本語の UserError・JWT と anon キーはログにも例外にも出ない。偽の fetch だけで確かめる。

let db: DomainDb
let world: UploadWorld

beforeAll(async () => {
  db = await openDomainDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  world = await newUploadWorld(db)
})

const cfgOf = (w: UploadWorld, who = w.a): StorageConfig => ({ base: SUPABASE_URL, anonKey: ANON_KEY, jwt: who.jwt })

describe('設定', () => {
  const env = (extra: Record<string, string | null> = {}) => ({
    SUPABASE_URL: SUPABASE_URL as string | null, SUPABASE_ANON_KEY: ANON_KEY as string | null, VAPID_PUBLIC_KEY: null,
    VAPID_PRIVATE_KEY: null, VAPID_SUBJECT: null, SECRET_KEYS: null, ...extra,
  })

  it('SUPABASE_URL・SUPABASE_ANON_KEY・ログインした人の JWT が揃ったときだけ作れる（末尾のスラッシュは落とす）', () => {
    expect(storageConfigOf({ env: env({ SUPABASE_URL: `${SUPABASE_URL}///` }), userJwt: 'jwt' })).toEqual({ base: SUPABASE_URL, anonKey: ANON_KEY, jwt: 'jwt' })
    expect(storageConfigOf({ env: env({ SUPABASE_ANON_KEY: null }), userJwt: 'jwt' })).toBeNull()
    expect(storageConfigOf({ env: env({ SUPABASE_URL: null }), userJwt: 'jwt' })).toBeNull()
    expect(storageConfigOf({ env: env(), userJwt: null })).toBeNull() // agent・定期実行
  })

  it('requireStorageConfig：足りなければ日本語の UserError（キー・トークンの値は出さない）', () => {
    expect(() => requireStorageConfig({ env: env(), userJwt: null })).toThrow(UserError)
    expect(() => requireStorageConfig({ env: env({ SUPABASE_ANON_KEY: null }), userJwt: 'secret-jwt' })).toThrow('画像の保存先が使えません')
    try {
      requireStorageConfig({ env: env({ SUPABASE_ANON_KEY: null }), userJwt: 'secret-jwt' })
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-jwt')
    }
  })
})

describe('署名つき URL', () => {
  it('1 本：人の JWT と anon キーで呼ぶ。期限は 1 時間。絶対 URL を返す', async () => {
    const p = receiptPath(world.a)
    world.backend.put('receipts', p)
    const url = await storageClient(cfgOf(world), world.backend.fetch).signUrl('receipts', p)
    expect(url).toMatch(new RegExp(`^${SUPABASE_URL}/storage/v1/object/sign/receipts/${world.a.householdId}/receipt/[^?]+\\.jpg\\?token=signed-\\d+$`))
    expect(world.backend.calls).toHaveLength(1)
    expect(world.backend.calls[0]).toMatchObject({
      kind: 'sign', bucket: 'receipts', paths: [p], apikey: ANON_KEY, authorization: `Bearer ${world.a.jwt}`, body: { expiresIn: SIGNED_URL_TTL_SECONDS },
    })
    expect(SIGNED_URL_TTL_SECONDS).toBe(3600)
  })

  it('まとめて：1 回の通信で全部。重複は 1 つにまとめる。署名できなかったパスは null。空なら通信しない', async () => {
    const p1 = receiptPath(world.a)
    const p2 = receiptPath(world.a)
    const missing = receiptPath(world.a)
    world.backend.put('receipts', p1)
    world.backend.put('receipts', p2)
    const client = storageClient(cfgOf(world), world.backend.fetch)
    const map = await client.signUrls('receipts', [p1, p2, p1, missing])
    expect(world.backend.of('signMany')).toHaveLength(1)
    expect(world.backend.of('signMany')[0].paths).toEqual([p1, p2, missing])
    expect(world.backend.of('signMany')[0].body).toMatchObject({ expiresIn: 3600 })
    expect(map.get(p1)).toContain('/object/sign/receipts/')
    expect(map.get(p2)).toContain('/object/sign/receipts/')
    expect(map.get(missing)).toBeNull()
    expect((await client.signUrls('receipts', [])).size).toBe(0)
    expect(world.backend.calls).toHaveLength(1)
  })

  it('他の世帯の画像は、自分の JWT では署名できない（Storage の方針）：1 本は not_found、まとめては null', async () => {
    const theirs = receiptPath(world.b)
    world.backend.put('receipts', theirs)
    const client = storageClient(cfgOf(world, world.a), world.backend.fetch)
    await expect(client.signUrl('receipts', theirs)).rejects.toMatchObject({ code: 'not_found', message: '画像が見つかりません' })
    expect((await client.signUrls('receipts', [theirs])).get(theirs)).toBeNull()
    // B 自身なら署名できる
    expect(await storageClient(cfgOf(world, world.b), world.backend.fetch).signUrl('receipts', theirs)).toContain('signed-')
  })

  it('壊れたパス（`..`・先頭の `/`・空の区間）は通信の前に断る', async () => {
    const client = storageClient(cfgOf(world), world.backend.fetch)
    for (const bad of ['../x.jpg', '/a/b.jpg', `${world.a.householdId}//x.jpg`, '', `${world.a.householdId}/./x.jpg`]) {
      await expect(client.signUrl('receipts', bad), bad).rejects.toBeInstanceOf(UserError)
      await expect(client.remove('receipts', [bad]), bad).rejects.toBeInstanceOf(UserError)
      await expect(client.download('receipts', bad, 100), bad).rejects.toBeInstanceOf(UserError)
    }
    expect(world.backend.calls).toEqual([])
  })
})

describe('消す・読み出す', () => {
  it('消す：DELETE ＋ prefixes。重複は 1 つ。無いものは無視（何度呼んでも同じ）。空なら通信しない', async () => {
    const p = receiptPath(world.a)
    world.backend.put('receipts', p)
    const client = storageClient(cfgOf(world), world.backend.fetch)
    await client.remove('receipts', [p, p])
    expect(world.backend.of('remove')).toHaveLength(1)
    expect(world.backend.of('remove')[0]).toMatchObject({ bucket: 'receipts', paths: [p], apikey: ANON_KEY, authorization: `Bearer ${world.a.jwt}` })
    expect(world.backend.has('receipts', p)).toBe(false)
    await client.remove('receipts', [p])
    await client.remove('receipts', [])
    expect(world.backend.of('remove')).toHaveLength(2)
  })

  it('他の世帯の画像は、自分の JWT では消せない（Storage の方針）', async () => {
    const theirs = receiptPath(world.b)
    world.backend.put('receipts', theirs)
    await storageClient(cfgOf(world, world.a), world.backend.fetch).remove('receipts', [theirs])
    expect(world.backend.has('receipts', theirs)).toBe(true)
  })

  it('読み出す：人の JWT で。大きさの上限を超えたら断る（宣言した大きさでも、実際の大きさでも）', async () => {
    const p = receiptPath(world.a)
    world.backend.put('receipts', p, Uint8Array.from([9, 8, 7]))
    const client = storageClient(cfgOf(world), world.backend.fetch)
    const got = await client.download('receipts', p, 100)
    expect(Array.from(got.bytes)).toEqual([9, 8, 7])
    expect(world.backend.of('download')[0]).toMatchObject({ authorization: `Bearer ${world.a.jwt}`, apikey: ANON_KEY })
    await expect(client.download('receipts', p, 2)).rejects.toMatchObject({ message: '画像は 10MB までにしてください' })
    // content-length の無い応答でも、読んだ大きさで断る
    const noLength = storageClient(cfgOf(world), (async () => new Response(new Uint8Array(10))) as unknown as typeof fetch)
    await expect(noLength.download('receipts', p, 5)).rejects.toMatchObject({ message: '画像は 10MB までにしてください' })
  })

  it('base64：大きい画像でも溢れず、元に戻せる', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251)
    const b64 = bytesToBase64(bytes)
    expect(Array.from(Buffer.from(b64, 'base64'))).toEqual(Array.from(bytes))
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})

describe('通信の失敗は日本語の UserError。JWT・anon キーはメッセージにもログにも出ない', () => {
  it('404（本物は HTTP 400 ＋ 本文の statusCode）・401/403・5xx・通信できない', async () => {
    const spy = spyConsole()
    try {
      const p = receiptPath(world.a)
      const client = storageClient(cfgOf(world), world.backend.fetch)
      await expect(client.signUrl('receipts', p)).rejects.toMatchObject({ code: 'not_found', message: '画像が見つかりません' })
      await expect(client.download('receipts', p, 10)).rejects.toMatchObject({ code: 'not_found', message: '画像が見つかりません' })

      world.backend.failures.sign = 403
      await expect(client.signUrl('receipts', p)).rejects.toMatchObject({ message: expect.stringContaining('権限がありません') })
      world.backend.failures.sign = 500
      await expect(client.signUrl('receipts', p)).rejects.toMatchObject({ message: expect.stringMatching(/画像の保存先でエラーが起きました（500）/) })
      world.backend.failures.sign = 'network'
      await expect(client.signUrl('receipts', p)).rejects.toMatchObject({ message: expect.stringContaining('画像の保存先に接続できません') })
      world.backend.failures.remove = 'network'
      await expect(client.remove('receipts', [p])).rejects.toBeInstanceOf(UserError)
      world.backend.failures.signMany = 500
      await expect(client.signUrls('receipts', [p])).rejects.toBeInstanceOf(UserError)

      // 実物の応答が壊れていても UserError
      const broken = storageClient(cfgOf(world), (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch)
      await expect(broken.signUrl('receipts', p)).rejects.toBeInstanceOf(UserError)
      const foreign = storageClient(cfgOf(world), (async () => new Response(JSON.stringify({ signedURL: 'https://evil.test/x' }), { status: 200 })) as unknown as typeof fetch)
      await expect(foreign.signUrl('receipts', p)).rejects.toBeInstanceOf(UserError)
    } finally {
      spy.restore()
    }
    const logs = spy.text()
    expect(logs).not.toContain(world.a.jwt)
    expect(logs).not.toContain(ANON_KEY)
    expect(logs).toContain('[storage]')
  })

  it('例外のメッセージにも JWT・anon キーを含めない', async () => {
    const spy = spyConsole()
    const errors: string[] = []
    try {
      world.backend.failures.sign = 'network'
      const client = storageClient(cfgOf(world), world.backend.fetch)
      await client.signUrl('receipts', receiptPath(world.a)).catch((e: Error) => errors.push(`${e.name}: ${e.message}\n${e.stack}`))
      world.backend.failures.sign = 403
      await client.signUrl('receipts', receiptPath(world.a)).catch((e: Error) => errors.push(`${e.name}: ${e.message}\n${e.stack}`))
    } finally {
      spy.restore()
    }
    expect(errors).toHaveLength(2)
    for (const e of errors) {
      expect(e).not.toContain(world.a.jwt)
      expect(e).not.toContain(ANON_KEY)
    }
  })

  it('時間切れ（応答が来ない）も日本語で断る', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    const client = storageClient(cfgOf(world), hang)
    const spy = spyConsole()
    try {
      // 15 秒の待ちは実時間で待たない：タイマーを早回しにする
      const real = globalThis.setTimeout
      globalThis.setTimeout = ((fn: () => void, _ms?: number) => real(fn, 1)) as unknown as typeof setTimeout
      try {
        await expect(client.signUrl('receipts', receiptPath(world.a))).rejects.toMatchObject({ message: expect.stringContaining('接続できません') })
      } finally {
        globalThis.setTimeout = real
      }
    } finally {
      spy.restore()
    }
  })
})

describe('removeAfterCommit：コミットの後に、自分の世帯のフォルダのものだけ消す', () => {
  it('自分の世帯のパスだけ消す。他の世帯・`..`・空は黙って除く', async () => {
    const mine = receiptPath(world.a)
    const theirs = receiptPath(world.b)
    world.backend.put('receipts', mine)
    world.backend.put('receipts', theirs)
    await world.run(world.a, async (ctx) => {
      removeAfterCommit(ctx, 'receipts', [mine, theirs, `${world.a.householdId}/receipt/../x.jpg`, '', null, undefined, mine])
      expect(world.backend.calls).toEqual([]) // まだコミット前なので何もしない
    })
    expect(world.backend.of('remove')).toHaveLength(1)
    expect(world.backend.of('remove')[0].paths).toEqual([mine])
    expect(world.backend.has('receipts', mine)).toBe(false)
    expect(world.backend.has('receipts', theirs)).toBe(true)
  })

  it('消すものが無ければ通信しない。保存先の設定やログインが無ければ、消さずに警告だけ（帳簿は成功）', async () => {
    const mine = receiptPath(world.a)
    world.backend.put('receipts', mine)
    await world.run(world.a, async (ctx) => removeAfterCommit(ctx, 'receipts', [null, receiptPath(world.b)]))
    expect(world.backend.calls).toEqual([])

    const spy = spyConsole()
    try {
      await world.run(world.a, async (ctx) => removeAfterCommit(ctx, 'receipts', [mine]), { noJwt: true })
      await world.run(world.a, async (ctx) => removeAfterCommit(ctx, 'receipts', [mine]), { noAnon: true })
    } finally {
      spy.restore()
    }
    expect(world.backend.calls).toEqual([])
    expect(world.backend.has('receipts', mine)).toBe(true)
    expect(spy.text()).toContain('消せませんでした')
  })

  it('ロールバックされたら消さない。消せなくても（通信の失敗）例外は出ず、失敗はログに残る', async () => {
    const mine = receiptPath(world.a)
    world.backend.put('receipts', mine)
    await expect(world.run(world.a, async (ctx) => {
      removeAfterCommit(ctx, 'receipts', [mine])
      throw new Error('途中で失敗')
    })).rejects.toThrow('途中で失敗')
    expect(world.backend.calls).toEqual([])
    expect(world.backend.has('receipts', mine)).toBe(true)

    const spy = spyConsole()
    try {
      world.backend.failures.remove = 'network'
      await expect(world.run(world.a, async (ctx) => removeAfterCommit(ctx, 'receipts', [mine]))).resolves.toBeUndefined()
    } finally {
      spy.restore()
    }
    expect(world.backend.has('receipts', mine)).toBe(true)
    expect(spy.text()).toContain('後始末に失敗しました')
    expect(spy.text()).not.toContain(world.a.jwt)
    expect(spy.text()).not.toContain(ANON_KEY)
  })
})

describe('Ctx.afterCommit（context.ts）', () => {
  it('コミットの後に、積んだ順に走る。走るときトランザクションはもう終わっている（別の問い合わせが通り、世帯の設定は消えている）', async () => {
    const order: string[] = []
    const seen: Array<{ h: string | null | 'stuck' }> = []
    const result = await withHousehold(db.root, { householdId: world.a.householdId, userId: world.a.userId }, async (ctx) => {
      ctx.afterCommit(async () => {
        order.push('first')
        // トランザクションの中なら、PGlite は他の問い合わせを待たせて固まる（stuck になる）
        const row = await Promise.race([
          db.root.get<{ h: string | null }>("select nullif(current_setting('app.household_id', true), '') as h"),
          new Promise<'stuck'>(resolve => setTimeout(() => resolve('stuck'), 1500)),
        ])
        seen.push(row === 'stuck' ? { h: 'stuck' } : { h: row?.h ?? null })
      })
      ctx.afterCommit(async () => { order.push('second') })
      order.push('body')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(order).toEqual(['body', 'first', 'second'])
    expect(seen).toEqual([{ h: null }])
  })

  it('途中で失敗した後始末があっても、次は走り、結果は返る。ログには名前とメッセージだけ', async () => {
    const spy = spyConsole()
    const ran: string[] = []
    try {
      const result = await withHousehold(db.root, { householdId: world.a.householdId, userId: world.a.userId, userJwt: 'secret-jwt-value' }, async (ctx) => {
        ctx.afterCommit(async () => { throw new Error('消せない') })
        ctx.afterCommit(async () => { ran.push('next') })
        return 42
      })
      expect(result).toBe(42)
    } finally {
      spy.restore()
    }
    expect(ran).toEqual(['next'])
    expect(spy.text()).toContain('Error: 消せない')
    expect(spy.text()).not.toContain('secret-jwt-value')
  })

  it('ctx.userJwt は withHousehold に渡したものがそのまま入る。渡さなければ null（agent・定期実行）', async () => {
    const ids = { householdId: world.a.householdId, userId: world.a.userId }
    expect(await withHousehold(db.root, ids, async (ctx) => ctx.userJwt)).toBeNull()
    expect(await withHousehold(db.root, { ...ids, userJwt: 'abc' }, async (ctx) => ctx.userJwt)).toBe('abc')
  })
})
