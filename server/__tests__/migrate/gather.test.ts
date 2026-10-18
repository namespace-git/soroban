import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import nodePostgres from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { secretsOf, UsageError } from '../../../tools/migrate-to-web/args'
import {
  buildDatabaseUrl, describeConnectError, findHousehold, isAuthFailure, jwtSubject, LoginError, loginWithPassword,
  parseJsonc, parsePoolerUrl, parseWranglerVars, resolvePublicConfig,
} from '../../../tools/migrate-to-web/gather'
import type { Sql } from '../../db/sql'
import { createMigratedDb } from '../../test/migrate'
import { createHouseholdFor, db } from './helpers'

// 本番に書くための値の集め方（環境変数が優先・wrangler.jsonc の vars・接続文字列の組み立て・Auth・世帯の引き方）を、偽の入力で確かめる

const ROOT = join(__dirname, '..', '..', '..')
const UID = '0b9f2c1e-7d3a-4e55-8a61-3f2d9c4b7a10'

describe('wrangler.jsonc の vars', () => {
  it('コメントと末尾のカンマを許し、文字列の中の // は触らない', () => {
    const text = `// 先頭のコメント
{
  /* ブロック */
  "name": "soroban", // 行末
  "vars": {
    "SUPABASE_URL": "https://abc.supabase.co", // https:// の // はコメントではない
    "SUPABASE_ANON_KEY": "sb_publishable_x,]}", /* 文字列の中の ,]} も触らない */
    "N": 3,
  },
  "list": ["a", "b",],
}`
    expect(parseJsonc(text)).toEqual({
      name: 'soroban',
      vars: { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x,]}', N: 3 },
      list: ['a', 'b'],
    })
    expect(parseWranglerVars(text)).toEqual({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x,]}' })
  })

  it('壊れたファイル・vars が無いファイルは空', () => {
    expect(parseWranglerVars('{ not json')).toEqual({})
    expect(parseWranglerVars('{ "name": "x" }')).toEqual({})
    expect(parseWranglerVars('{ "vars": [1] }')).toEqual({})
  })

  it('このリポジトリの wrangler.jsonc から、公開してよい 2 つの値が読める', () => {
    const pub = resolvePublicConfig({}, readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'))
    expect(pub.supabaseUrl).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/)
    expect(pub.anonKey.length).toBeGreaterThan(10)
  })
})

describe('公開の値（SUPABASE_URL・SUPABASE_ANON_KEY）', () => {
  const wrangler = '{ "vars": { "SUPABASE_URL": "https://file.supabase.co", "SUPABASE_ANON_KEY": "file-anon-key" } }'

  it('環境変数が優先。無ければ wrangler.jsonc', () => {
    expect(resolvePublicConfig({}, wrangler)).toEqual({ supabaseUrl: 'https://file.supabase.co', anonKey: 'file-anon-key' })
    expect(resolvePublicConfig({ SUPABASE_URL: ' https://env.supabase.co ', SUPABASE_ANON_KEY: 'env-anon-key' }, wrangler))
      .toEqual({ supabaseUrl: 'https://env.supabase.co', anonKey: 'env-anon-key' })
    expect(resolvePublicConfig({ SUPABASE_URL: 'https://env.supabase.co' }, wrangler))
      .toEqual({ supabaseUrl: 'https://env.supabase.co', anonKey: 'file-anon-key' })
    expect(resolvePublicConfig({ SUPABASE_URL: '', SUPABASE_ANON_KEY: ' ' }, wrangler).supabaseUrl).toBe('https://file.supabase.co')
  })

  it('どちらにも無ければ、足りない名前を言って止まる（日本語）。http:// は断る', () => {
    expect(() => resolvePublicConfig({}, null)).toThrow(UsageError)
    expect(() => resolvePublicConfig({}, null)).toThrow(/SUPABASE_URL・SUPABASE_ANON_KEY.*wrangler\.jsonc/)
    expect(() => resolvePublicConfig({ SUPABASE_URL: 'https://a.supabase.co' }, '{}')).toThrow(/SUPABASE_ANON_KEY が見つかりません/)
    expect(() => resolvePublicConfig({ SUPABASE_URL: 'http://a.supabase.co', SUPABASE_ANON_KEY: 'k' }, null)).toThrow(/https:\/\//)
  })
})

describe('接続文字列の組み立て', () => {
  it('pooler-url（パスワード無し）を読む。貼り付けた文字列のパスワードの部分は捨てる', () => {
    const t = parsePoolerUrl('postgresql://postgres.erugfqqphgdaebpvbzhs@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres\n')
    expect(t).toEqual({ user: 'postgres.erugfqqphgdaebpvbzhs', host: 'aws-0-ap-southeast-1.pooler.supabase.com', port: '5432', database: 'postgres' })
    expect(parsePoolerUrl('postgresql://postgres.ref:[YOUR-PASSWORD]@h.example.com:5432/postgres')).toEqual({
      user: 'postgres.ref', host: 'h.example.com', port: '5432', database: 'postgres',
    })
    expect(parsePoolerUrl('postgres://u:realpw@h.example.com/db')).toEqual({ user: 'u', host: 'h.example.com', port: '5432', database: 'db' })
    expect(parsePoolerUrl('mysql://u@h/db')).toBeNull()
    expect(parsePoolerUrl('')).toBeNull()
    expect(parsePoolerUrl('postgresql://h.example.com/db')).toBeNull() // ユーザー名が無い
  })

  const target = { user: 'postgres.ref', host: 'aws-0.pooler.supabase.com', port: '5432', database: 'postgres' }

  it('パスワードの記号（@ : / # ? % 空白 日本語 など）を URL エンコードして、元のパスワードに戻る', () => {
    const passwords = ['plain-Pass_1', 'p@ss:w/ord#1?x=y&z', '100%real%40', 'sp ace', 'a!b*c(d)e\'f~g', '日本語パスワード', '[YOUR-PASSWORD]', '\\back\\slash', '+plus=eq']
    for (const pw of passwords) {
      const url = buildDatabaseUrl(target, pw)
      const parsed = new URL(url)
      expect(decodeURIComponent(parsed.password), pw).toBe(pw)
      expect(decodeURIComponent(parsed.username)).toBe('postgres.ref')
      expect(parsed.hostname).toBe('aws-0.pooler.supabase.com')
      expect(parsed.port).toBe('5432')
      expect(parsed.pathname).toBe('/postgres')
      // 生のパスワードが、URL の中に（記号つきのまま）入っていない
      if (/[@:/#? %]/.test(pw)) expect(url).not.toContain(pw)
    }
  })

  it('node-postgres（pg）が読んだパスワード・ユーザーも、元の値になる（実際に接続はしない）', () => {
    for (const pw of ['p@ss:w/ord#1?x=y&z', '100%real%40', '日本語パスワード']) {
      // new しただけでは接続しない（connect() を呼ぶまで）
      const client = new nodePostgres.Client(buildDatabaseUrl(target, pw))
      expect(client.password).toBe(pw)
      expect(client.user).toBe('postgres.ref')
      expect(client.host).toBe('aws-0.pooler.supabase.com')
      expect(client.port).toBe(5432)
      expect(client.database).toBe('postgres')
    }
  })

  it('組み立てた接続文字列の秘密（パスワード）は、画面に出さない対象に入る', () => {
    const pw = 'p@ss:w/ord#1?x'
    const secrets = secretsOf({ databaseUrl: buildDatabaseUrl(target, pw), supabaseUrl: '', anonKey: '', jwt: '' })
    expect(secrets).toContain(pw)
    expect(secrets).toContain(encodeURIComponent(pw))
  })

  it('パスワードの間違いと、通信の失敗を見分ける。失敗の理由はコードだけを出す', () => {
    expect(isAuthFailure(Object.assign(new Error('x'), { code: '28P01' }))).toBe(true)
    expect(isAuthFailure(new Error('password authentication failed for user "postgres.ref"'))).toBe(true)
    expect(isAuthFailure(new Error('Tenant or user not found'))).toBe(true)
    expect(isAuthFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false)
    expect(describeConnectError(Object.assign(new Error('postgresql://u:SECRET@h/db'), { code: '28P01' }))).toBe('28P01')
    expect(describeConnectError(new Error('postgresql://u:SECRET@h/db'))).toBe('Error')
    expect(describeConnectError('x')).toBe('error')
  })
})

describe('ログイン（Supabase Auth）', () => {
  const opts = { supabaseUrl: 'https://abc.supabase.co/', anonKey: 'sb_publishable_ANON-KEY', email: 'me@example.test', password: 'login-PASSWORD-1' }
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: UID, exp: 4_102_444_800 })).toString('base64url')}.sig`

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('パスワード認証の URL・ヘッダー・本文で 1 回だけ送り、JWT とユーザー id を返す', async () => {
    const fetchMock = vi.fn(async () => json(200, { access_token: jwt, refresh_token: 'r', user: { id: UID, email: 'me@example.test' } }))
    const result = await loginWithPassword({ ...opts, fetch: fetchMock as unknown as typeof fetch })
    expect(result).toEqual({ accessToken: jwt, userId: UID })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://abc.supabase.co/auth/v1/token?grant_type=password')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).apikey).toBe('sb_publishable_ANON-KEY')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'me@example.test', password: 'login-PASSWORD-1' })
    // パスワードや anon キーを URL に載せない
    expect(url).not.toContain('PASSWORD')
    expect(url).not.toContain('ANON')
  })

  it('user.id が無くても、JWT の sub から取る。どちらも無ければ断る', async () => {
    const ok = vi.fn(async () => json(200, { access_token: jwt }))
    expect((await loginWithPassword({ ...opts, fetch: ok as unknown as typeof fetch })).userId).toBe(UID)
    const none = vi.fn(async () => json(200, { access_token: 'abc' }))
    await expect(loginWithPassword({ ...opts, fetch: none as unknown as typeof fetch })).rejects.toThrow(/必要な値がありません/)
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }))
    await expect(loginWithPassword({ ...opts, fetch: notJson as unknown as typeof fetch })).rejects.toThrow(LoginError)
  })

  it('メールアドレスかパスワードが違うとき（400・401）は、そう言う。もう一度聞いてよい。再送しない', async () => {
    for (const status of [400, 401]) {
      const fetchMock = vi.fn(async () => json(status, { code: status, error_code: 'invalid_credentials', msg: 'Invalid login credentials me@example.test' }))
      const err = await loginWithPassword({ ...opts, fetch: fetchMock as unknown as typeof fetch }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LoginError)
      expect((err as LoginError).message).toBe('メールアドレスかパスワードが違います')
      expect((err as LoginError).retryable).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('429・5xx・通信の失敗は別の言葉で、もう一度は聞かない。パスワード・anon キーは文に出ない', async () => {
    const cases: Array<[() => Promise<Response>, RegExp]> = [
      [async () => json(429, {}), /試行が多すぎます/],
      [async () => json(500, { msg: 'login-PASSWORD-1' }), /500/],
      [async () => { throw new TypeError('fetch failed: sb_publishable_ANON-KEY login-PASSWORD-1') }, /通信できません/],
    ]
    for (const [impl, pattern] of cases) {
      const fetchMock = vi.fn(impl)
      const err = await loginWithPassword({ ...opts, fetch: fetchMock as unknown as typeof fetch }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LoginError)
      expect((err as LoginError).message).toMatch(pattern)
      expect((err as LoginError).retryable).toBe(false)
      expect((err as LoginError).message).not.toContain('PASSWORD')
      expect((err as LoginError).message).not.toContain('ANON')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('JWT の sub を読む', () => {
    expect(jwtSubject(jwt)).toBe(UID)
    expect(jwtSubject('abc')).toBeNull()
    expect(jwtSubject(`h.${Buffer.from(JSON.stringify({ sub: 'not-a-uuid' })).toString('base64url')}.s`)).toBeNull()
  })
})

describe('世帯の引き方（app.household_of_user）', () => {
  let pg: PGlite
  let hh: string
  let userId: string
  let loner: string

  beforeAll(async () => {
    pg = await createMigratedDb()
    const made = await createHouseholdFor(pg, 'うち')
    hh = made.householdId
    userId = made.userId
    loner = (await createHouseholdFor(pg, 'べつ')).userId
    // 世帯に入っていない人
    await pg.query('delete from app.household_member where user_id = $1', [loner])
  })

  afterAll(async () => {
    await pg.close()
  })

  it('ユーザー id から世帯 id を引く。世帯に入っていない人・知らない人は null', async () => {
    expect(await findHousehold(db(pg), userId)).toBe(hh)
    expect(await findHousehold(db(pg), loner)).toBeNull()
    expect(await findHousehold(db(pg), '00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('接続のユーザーが soroban_gateway（SOROBAN_DATABASE_URL にゲートウェイの接続文字列を渡したとき）でも、同じ世帯が引ける', async () => {
    await pg.exec('set session authorization soroban_gateway')
    try {
      expect(await findHousehold(db(pg), userId)).toBe(hh)
      expect(await findHousehold(db(pg), loner)).toBeNull()
    } finally {
      await pg.exec('set session authorization postgres')
    }
  })

  it('uuid でない値は引かずに断る', async () => {
    await expect(findHousehold(db(pg), "x'; drop table app.sale; --")).rejects.toThrow(/uuid/)
  })

  it('関数を呼べない接続では、メンバーの表を同じ並びで引く', async () => {
    const sql = db(pg)
    const guarded: Sql = {
      ...sql,
      get: (async (text: string, ...params: unknown[]) => {
        if (text.includes('household_of_user')) throw new Error('permission denied for function household_of_user')
        return sql.get(text, ...params)
      }) as Sql['get'],
    }
    expect(await findHousehold(guarded, userId)).toBe(hh)
    expect(await findHousehold(guarded, loner)).toBeNull()
  })

  it('両方とも引けなければ、例外のまま返す（黙って null にしない）', async () => {
    const broken = { get: async () => { throw new Error('connection lost') } } as unknown as Sql
    await expect(findHousehold(broken, userId)).rejects.toThrow(/connection lost/)
  })
})
