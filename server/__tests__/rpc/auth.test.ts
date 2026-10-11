import { SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { authenticate, findHousehold, verifyAccessToken } from '../../auth'
import { openPglite, type PgliteSql } from '../../db/pglite'
import { ApiError } from '../../errors'
import {
  HOUSEHOLD_A,
  HOUSEHOLD_B,
  ISSUER,
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
let rsaKey: KeyPair
let otherKey: KeyPair
const env = { SUPABASE_URL }

beforeAll(async () => {
  db = await openPglite()
  await setupSchema(db.pg)
  key = await makeKey('key-es256', 'ES256')
  rsaKey = await makeKey('key-rs256', 'RS256')
  otherKey = await makeKey('key-unknown', 'ES256') // JWKS に載せない鍵
  stubJwks([key, rsaKey])
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await db.close()
})

afterEach(() => {
  // 各テストの前に JWKS の差し替えを戻しておく（beforeAll の stub は jose が覚えた鍵でも通る）
  stubJwks([key, rsaKey])
})

const request = (token?: string, scheme = 'Bearer') =>
  new Request('http://localhost/api/rpc/getDashboard', {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `${scheme} ${token}` },
    body: '{"args":[]}',
  })

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ApiError)
  expect((err as ApiError).code).toBe(code)
}

describe('認証：ES256 / RS256 の JWT（JWKS）', () => {
  it('正しいトークンで通り、user id と世帯が返る', async () => {
    const token = await signToken({ key })
    expect(await authenticate(request(token), db, env)).toEqual({ userId: USER_A, householdId: HOUSEHOLD_A })
  })

  it('RS256 でも通る', async () => {
    const token = await signToken({ key: rsaKey, alg: 'RS256', sub: USER_B })
    expect(await authenticate(request(token), db, env)).toEqual({ userId: USER_B, householdId: HOUSEHOLD_B })
  })

  it('SUPABASE_URL の末尾のスラッシュは許す', async () => {
    const token = await signToken({ key })
    await expect(verifyAccessToken(token, { SUPABASE_URL: `${SUPABASE_URL}/` })).resolves.toBe(USER_A)
  })

  it('nbf が過去なら通る（Supabase のトークンには無いが、あれば見る）', async () => {
    const token = await signToken({ key, nbf: Math.floor(Date.now() / 1000) - 60 })
    await expect(verifyAccessToken(token, env)).resolves.toBe(USER_A)
  })

  describe('401', () => {
    it('Authorization ヘッダーが無い', async () => {
      await expectCode(authenticate(request(), db, env), 'unauthorized')
    })

    it('Bearer 以外の方式', async () => {
      const token = await signToken({ key })
      await expectCode(authenticate(request(token, 'Basic'), db, env), 'unauthorized')
    })

    it('JWT の形をしていない', async () => {
      await expectCode(authenticate(request('not-a-jwt'), db, env), 'unauthorized')
    })

    it('期限切れ', async () => {
      const token = await signToken({ key, exp: Math.floor(Date.now() / 1000) - 3600 })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('exp が無い', async () => {
      const token = await signToken({ key, exp: null })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('nbf が未来', async () => {
      const token = await signToken({ key, nbf: Math.floor(Date.now() / 1000) + 3600 })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('aud が違う', async () => {
      const token = await signToken({ key, aud: 'anon' })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('aud が無い', async () => {
      const token = await signToken({ key, aud: null })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('iss が違う（別の Supabase プロジェクトのトークン）', async () => {
      const token = await signToken({ key, iss: 'https://other.supabase.test/auth/v1' })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('role が authenticated でない（anon・service_role）', async () => {
      for (const role of ['anon', 'service_role']) {
        const token = await signToken({ key, role })
        await expectCode(authenticate(request(token), db, env), 'unauthorized')
      }
    })

    it('role が無い', async () => {
      const token = await signToken({ key, role: null })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('sub が無い／uuid でない', async () => {
      await expectCode(authenticate(request(await signToken({ key, sub: null })), db, env), 'unauthorized')
      await expectCode(authenticate(request(await signToken({ key, sub: 'not-a-uuid' })), db, env), 'unauthorized')
    })

    it('HS256 で署名したトークン（JWKS の公開鍵を秘密に見せかける攻撃も含め、対称鍵の経路は無い）', async () => {
      const secret = new TextEncoder().encode('0123456789-0123456789-0123456789-0123456789')
      const token = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256', kid: key.kid })
        .setIssuer(ISSUER)
        .setAudience('authenticated')
        .setSubject(USER_A)
        .setExpirationTime('1h')
        .sign(secret)
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('alg: none（署名なし）', async () => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const now = Math.floor(Date.now() / 1000)
      const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISSUER, aud: 'authenticated', sub: USER_A, role: 'authenticated', exp: now + 3600 })}.`
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('JWKS に無い kid（知らない鍵で署名）', async () => {
      const token = await signToken({ key: otherKey })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('kid は正しいが署名が違う（改ざん）', async () => {
      const forged = { ...otherKey, kid: key.kid }
      const token = await signToken({ key: forged })
      await expectCode(authenticate(request(token), db, env), 'unauthorized')
    })

    it('本文を改ざんしたトークン', async () => {
      const token = await signToken({ key })
      const [h, , s] = token.split('.')
      const now = Math.floor(Date.now() / 1000)
      const body = Buffer.from(
        JSON.stringify({ iss: ISSUER, aud: 'authenticated', sub: USER_B, role: 'authenticated', exp: now + 3600 }),
      ).toString('base64url')
      await expectCode(authenticate(request(`${h}.${body}.${s}`), db, env), 'unauthorized')
    })
  })

  describe('403', () => {
    it('トークンは正しいが、世帯に属していないユーザー', async () => {
      const token = await signToken({ key, sub: USER_NOBODY })
      await expectCode(authenticate(request(token), db, env), 'forbidden')
    })

    it('複数の世帯に入っていれば household_id の昇順で最初の 1 つ（毎回同じ）', async () => {
      const multi = '00000000-0000-4000-8000-0000000000c1'
      const hLow = '00000000-0000-4000-8000-000000000001'
      const hHigh = '00000000-0000-4000-8000-0000000000ff'
      await db.pg.query(`insert into app.household_member (household_id, user_id) values ($1, $3), ($2, $3)`, [hHigh, hLow, multi])
      expect(await findHousehold(db, multi)).toBe(hLow)
      expect(await findHousehold(db, multi)).toBe(hLow)
    })
  })

  describe('鍵の取得', () => {
    it('JWKS は覚えておく（何度検証しても取りに行かない）', async () => {
      const base = 'https://cache.supabase.test'
      const k = await makeKey('cache-key')
      const calls = stubJwks([k], `${base}/auth/v1/.well-known/jwks.json`)
      const token = await signToken({ key: k, iss: `${base}/auth/v1` })
      for (let i = 0; i < 5; i++) await verifyAccessToken(token, { SUPABASE_URL: base })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toBe(`${base}/auth/v1/.well-known/jwks.json`)
    })

    it('JWKS が取れない（Supabase に届かない）のはトークンのせいではないので 401 にしない', async () => {
      const base = 'https://down.supabase.test'
      vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))
      const token = await signToken({ key, iss: `${base}/auth/v1` })
      const err = await verifyAccessToken(token, { SUPABASE_URL: base }).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(ApiError)
    })

    it('SUPABASE_URL が無ければ設定の不備（ApiError ではなく例外）', async () => {
      const token = await signToken({ key })
      const err = await verifyAccessToken(token, {}).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(ApiError)
    })
  })
})
