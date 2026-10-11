import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { Sql } from './db/sql'
import { ApiError } from './errors'

/** Cloudflare の環境変数のうち、認証に使うもの */
export interface AuthEnv {
  /** 例 https://xxxx.supabase.co 。JWKS の場所（`/auth/v1/.well-known/jwks.json`）と、`iss` の期待値（`/auth/v1`）を作る */
  SUPABASE_URL?: string
}

export interface Identity {
  userId: string
  householdId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * リクエストの持ち主を確かめて、世帯を引く。
 *
 *   1. `Authorization: Bearer <JWT>` を検証 … 失敗は 401
 *   2. `app.household_member` から世帯を引く … 1 件も無ければ 403
 *
 * 2 は **`set role` する前の接続ロールで行う**（`withHousehold` の外）。`root` はトランザクションの外の Sql。
 * 世帯に属さない人は、サインアップが誤って有効になっていても何も見えない。
 */
export async function authenticate(request: Request, root: Sql, env: AuthEnv): Promise<Identity> {
  const token = bearerToken(request)
  if (!token) throw new ApiError('unauthorized', 'ログインが必要です')
  const userId = await verifyAccessToken(token, env)
  return { userId, householdId: await findHousehold(root, userId) }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  const m = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null
  return m ? m[1] : null
}

const AUDIENCE = 'authenticated'
const ROLE = 'authenticated'
// 許す署名方式を固定する（トークン側の alg に従わない）。none・HS256（公開鍵を HMAC の秘密に見せかける攻撃）は通さない。
// 対称鍵（HS256）の経路は作らない。Supabase の新しい非対称鍵（JWKS）だけに対応する
const ALGORITHMS = ['ES256', 'RS256']

/**
 * JWT を検証して user id（`sub`）を返す。鍵は `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`（非対称鍵）だけ。
 *
 * 見るもの：署名（alg は ES256 / RS256 のみ）・`iss`（`${SUPABASE_URL}/auth/v1`）・`aud`（authenticated）・
 * `exp`（必須）・`nbf`（あれば）・`sub`（必須・uuid）・`role`（authenticated）。
 * anon キー・service_role キーは role が違う／sub が無いので通らない。
 */
export async function verifyAccessToken(token: string, env: AuthEnv): Promise<string> {
  const base = supabaseBase(env)
  try {
    const { payload } = await jwtVerify(token, jwksFor(base), {
      algorithms: ALGORITHMS,
      issuer: `${base}/auth/v1`,
      audience: AUDIENCE,
      requiredClaims: ['exp', 'sub'],
    })
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub) || payload.role !== ROLE) {
      throw new ApiError('unauthorized', 'ログインが必要です')
    }
    return payload.sub.toLowerCase()
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (e instanceof errors.JWTExpired) throw new ApiError('unauthorized', 'ログインの期限が切れました。もう一度ログインしてください')
    // トークンのせいではなく、鍵の取得に失敗した（Supabase に届かない等）。ログアウトさせず 500 にする
    if (!(e instanceof errors.JOSEError) || e instanceof errors.JWKSTimeout || e instanceof errors.JWKSInvalid || e.code === 'ERR_JOSE_GENERIC') throw e
    throw new ApiError('unauthorized', 'ログインが必要です')
  }
}

function supabaseBase(env: AuthEnv): string {
  const base = env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  if (!base) throw new Error('SUPABASE_URL が設定されていません')
  return base
}

// Workers の isolate は複数のリクエストで使い回されるので、JWKS（鍵の一覧）は取りすぎないよう覚えておく。
// jose は kid が見つからないときだけ取り直す（cooldownDuration の間は取り直さない）
const jwksCache = new Map<string, JWTVerifyGetKey>()

function jwksFor(base: string): JWTVerifyGetKey {
  const url = `${base}/auth/v1/.well-known/jwks.json`
  let jwks = jwksCache.get(url)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 10 * 60 * 1000 })
    jwksCache.set(url, jwks)
  }
  return jwks
}

/**
 * user id から世帯を引く。複数の世帯に入っている人は household_id の昇順で最初の 1 つ（並びを固定して、毎回同じ世帯にする）。
 * **1 件も無ければ 403。**
 */
export async function findHousehold(root: Sql, userId: string): Promise<string> {
  const row = await root.get<{ household_id: string }>(
    'select household_id from app.household_member where user_id = ? order by household_id limit 1',
    userId,
  )
  if (!row || typeof row.household_id !== 'string' || !UUID.test(row.household_id)) {
    throw new ApiError('forbidden', 'この帳簿を使う権限がありません')
  }
  return row.household_id.toLowerCase()
}
