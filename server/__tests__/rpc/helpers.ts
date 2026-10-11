import net from 'node:net'
import type { PGlite } from '@electric-sql/pglite'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { vi } from 'vitest'
import { createPostgresSql } from '../../db/postgres'
import { openPglite, type PgliteSql } from '../../db/pglite'
import type { Sql } from '../../db/sql'

export const HOUSEHOLD_A = '00000000-0000-4000-8000-00000000000a'
export const HOUSEHOLD_B = '00000000-0000-4000-8000-00000000000b'
export const USER_A = '00000000-0000-4000-8000-0000000000a1'
export const USER_B = '00000000-0000-4000-8000-0000000000b1'
export const USER_NOBODY = '00000000-0000-4000-8000-0000000000ff'

/**
 * テスト用の最小のスキーマ（本物のスキーマは supabase/migrations。ここは土台の検証に要るものだけ）。
 * - `app` スキーマ、BYPASSRLS を持たない NOLOGIN の `soroban_api` ロール
 * - `app.household_member`（soroban_api には読ませない＝世帯の解決は set role の前に行うことの確認）と、
 *   それを引くだけの `app.household_of_user`（本物は security definer。世帯の解決はこの関数だけを通る）
 * - `app.note`（RLS つき）、`public.typed`（型の読み出しの確認用）
 */
export async function setupSchema(pg: PGlite): Promise<void> {
  await pg.exec(`
    create schema app;
    create role soroban_api nologin;
    grant usage on schema app to soroban_api;

    create table app.household_member (
      household_id uuid not null,
      user_id uuid not null,
      primary key (household_id, user_id)
    );

    -- 本物（supabase/migrations/20261012000700）の代わり。auth.ts はこの関数だけを通して世帯を引く
    create function app.household_of_user(p_user_id uuid) returns uuid
    language sql stable security definer set search_path = app, pg_temp
    as $$ select household_id from app.household_member where user_id = p_user_id order by household_id limit 1 $$;

    create table app.note (
      id int generated always as identity primary key,
      household_id uuid not null default (current_setting('app.household_id')::uuid),
      body text not null
    );
    alter table app.note enable row level security;
    create policy household_isolation on app.note
      using (household_id = current_setting('app.household_id', true)::uuid)
      with check (household_id = current_setting('app.household_id', true)::uuid);
    grant select, insert, update, delete on app.note to soroban_api;
    grant usage on all sequences in schema app to soroban_api;

    create table public.typed (
      id int primary key,
      amount int not null,
      d date,
      ts timestamptz,
      plain_ts timestamp,
      tags text[],
      price numeric(10, 2)
    );
  `)
  await pg.query(`insert into app.household_member (household_id, user_id) values ($1, $2), ($3, $4)`, [
    HOUSEHOLD_A,
    USER_A,
    HOUSEHOLD_B,
    USER_B,
  ])
}

export interface Bridge {
  url: string
  close(): Promise<void>
}

/**
 * PGlite を TCP の Postgres サーバーに見せる（wire protocol をそのまま PGlite に渡す）。
 * 本物の postgres.js で `server/db/postgres.ts` を通すためのもの。接続は 1 本ずつ順に処理する。
 */
export async function startBridge(pg: PGlite): Promise<Bridge> {
  let chain: Promise<unknown> = Promise.resolve()
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (data) => {
      const chunk = data as Buffer
      // Terminate（'X'）は PGlite に渡さない（PGlite の接続は 1 本で、切れてはいけない）
      if (chunk.length === 5 && chunk[0] === 0x58) {
        socket.end()
        return
      }
      chain = chain.then(async () => {
        try {
          socket.write(await pg.execProtocolRaw(new Uint8Array(chunk)))
        } catch (e) {
          console.error('[bridge]', e)
          socket.destroy()
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export interface NamedSql {
  name: string
  sql: Sql
}

export interface TestDb {
  pg: PGlite
  pglite: PgliteSql
  /** 同じ DB を PGlite のアダプタと、postgres.js（TCP のブリッジ経由）の両方から触れる */
  drivers: NamedSql[]
  close(): Promise<void>
}

export async function openTestDb(): Promise<TestDb> {
  const pglite = await openPglite()
  await setupSchema(pglite.pg)
  const bridge = await startBridge(pglite.pg)
  const ends: Array<() => Promise<void>> = []
  const withEnd = (name: string, options: { prepare: boolean }): NamedSql => {
    const db = createPostgresSql(bridge.url, options)
    ends.push(() => db.end())
    return { name, sql: db }
  }
  return {
    pg: pglite.pg,
    pglite,
    drivers: [
      { name: 'PGlite', sql: pglite },
      withEnd('postgres.js (prepare あり)', { prepare: true }),
      withEnd('postgres.js (prepare なし)', { prepare: false }),
    ],
    close: async () => {
      for (const end of ends) await end()
      await bridge.close()
      await pglite.close()
    },
  }
}


// ---- 認証のテスト用：ES256 の鍵と、JWKS の取得の差し替え ----

export const SUPABASE_URL = 'https://abcdefgh.supabase.test'
export const ISSUER = `${SUPABASE_URL}/auth/v1`
export const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`

export interface KeyPair {
  kid: string
  privateKey: CryptoKey
  publicJwk: JWK
}

export async function makeKey(kid: string, alg: 'ES256' | 'RS256' = 'ES256'): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true })
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' }
  return { kid, privateKey, publicJwk }
}

/** global の fetch を差し替えて、JWKS の URL には keys を返す。呼ばれた回数を数える */
export function stubJwks(keys: KeyPair[], url: string = JWKS_URL) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const requested = String(input)
      calls.push(requested)
      if (requested !== url) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

export interface TokenOptions {
  key: KeyPair
  alg?: 'ES256' | 'RS256'
  sub?: string | null
  iss?: string
  aud?: string | null
  role?: string | null
  /** 秒。既定は 1 時間後 */
  exp?: number | null
  nbf?: number
}

export async function signToken(opts: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = {}
  if (opts.role !== null) claims.role = opts.role ?? 'authenticated'
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: opts.key.kid })
    .setIssuedAt(now)
    .setIssuer(opts.iss ?? ISSUER)
  if (opts.sub !== null) jwt = jwt.setSubject(opts.sub ?? USER_A)
  if (opts.aud !== null) jwt = jwt.setAudience(opts.aud ?? 'authenticated')
  if (opts.exp !== null) jwt = jwt.setExpirationTime(opts.exp ?? now + 3600)
  if (opts.nbf !== undefined) jwt = jwt.setNotBefore(opts.nbf)
  return jwt.sign(opts.key.privateKey)
}
