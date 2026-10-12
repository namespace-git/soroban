import type { Sql } from '../../server/db/sql'
import { UsageError } from './args'
import { normalizeSupabaseUrl } from './images'

// 本番に書くための値を集める（zip の形）。環境変数があればそれを優先し、なければ手元のファイルか入力から。
//   公開してよい値   … SUPABASE_URL・SUPABASE_ANON_KEY（wrangler.jsonc の vars）
//   データベースの接続 … supabase/.temp/pooler-url（パスワード無し）＋ 入力したパスワード
//   ログイン          … Supabase Auth のパスワード認証 → JWT（Storage に画像を置くのに使う）
//   世帯              … ログインした人の user id → app.household_of_user
// 秘密（パスワード・JWT・接続文字列）は、ここでは返すだけ。ファイルにも画面にも出さない

// ------------------------------------------------------------
// wrangler.jsonc（公開してよい値）
// ------------------------------------------------------------

/**
 * コメント（// と /* *\/）と末尾のカンマを許す JSON（wrangler.jsonc）を読む。
 * 文字列の中の // や , は触らない（"https://…" の // をコメントと間違えない）
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let pendingComma = -1 // out の中の、まだ「末尾のカンマか」決まっていないカンマの位置
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (c === '"') {
      inString = true
      pendingComma = -1
      out += c
      i++
      continue
    }
    if (c === ',') {
      pendingComma = out.length
      out += c
      i++
      continue
    }
    if (c === '}' || c === ']') {
      if (pendingComma >= 0) out = out.slice(0, pendingComma) + out.slice(pendingComma + 1)
      pendingComma = -1
    } else if (!/\s/.test(c)) {
      pendingComma = -1
    }
    out += c
    i++
  }
  return JSON.parse(out)
}

/** wrangler.jsonc の vars（文字列のものだけ）。読めなければ空 */
export function parseWranglerVars(text: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = parseJsonc(text)
  } catch {
    return {}
  }
  const vars = (parsed as { vars?: unknown } | null)?.vars
  if (typeof vars !== 'object' || vars === null) return {}
  return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

export interface PublicConfig {
  supabaseUrl: string
  anonKey: string
}

/** SUPABASE_URL・SUPABASE_ANON_KEY。環境変数が優先、なければ wrangler.jsonc の vars */
export function resolvePublicConfig(env: Record<string, string | undefined>, wranglerText: string | null): PublicConfig {
  const vars = wranglerText === null ? {} : parseWranglerVars(wranglerText)
  const pick = (name: string): string => (env[name]?.trim() || vars[name]?.trim() || '')
  const supabaseUrl = pick('SUPABASE_URL')
  const anonKey = pick('SUPABASE_ANON_KEY')
  const missing = [supabaseUrl === '' ? 'SUPABASE_URL' : '', anonKey === '' ? 'SUPABASE_ANON_KEY' : ''].filter(Boolean)
  if (missing.length > 0) {
    throw new UsageError(
      `${missing.join('・')} が見つかりません。リポジトリ直下の wrangler.jsonc の vars に入っているはずです` +
        '（別のフォルダから実行したなら --repo-root で指してください）。環境変数で渡してもかまいません',
    )
  }
  try {
    normalizeSupabaseUrl(supabaseUrl)
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
  return { supabaseUrl, anonKey }
}

// ------------------------------------------------------------
// データベースの接続文字列
// ------------------------------------------------------------

export interface DatabaseTarget {
  user: string
  host: string
  port: string
  database: string
}

/**
 * Session pooler の接続先（supabase/.temp/pooler-url。パスワードは入っていない）を読む。
 * 貼り付けた接続文字列でもよい（パスワードの部分は捨てる。[YOUR-PASSWORD] のままでもよい）。形が違えば null
 */
export function parsePoolerUrl(text: string): DatabaseTarget | null {
  const trimmed = text.trim()
  if (!/^postgres(?:ql)?:\/\//i.test(trimmed)) return null
  // [YOUR-PASSWORD] の括弧は URL として読めないので、先に外す
  const readable = trimmed.replace(/\[YOUR[-_ ]?PASSWORD\]/gi, 'x')
  let url: URL
  try {
    url = new URL(readable)
  } catch {
    return null
  }
  if (url.username === '' || url.hostname === '') return null
  const database = url.pathname.replace(/^\//, '')
  return {
    user: decodeURIComponent(url.username),
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: database === '' ? 'postgres' : decodeURIComponent(database),
  }
}

/** 接続文字列を組み立てる。ユーザー名とパスワードは URL エンコードする（@ : / # ? % などが入っていても壊れない） */
export function buildDatabaseUrl(target: DatabaseTarget, password: string): string {
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host
  return `postgresql://${encodeURIComponent(target.user)}:${encodeURIComponent(password)}@${host}:${target.port}/${encodeURIComponent(target.database)}`
}

/** 接続の失敗が、パスワードの間違いか（もう一度聞く価値があるか） */
export function isAuthFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === '28P01' || code === '28000') return true
  const message = e instanceof Error ? e.message : ''
  return /password authentication failed|authentication error|tenant or user not found|invalid password/i.test(message)
}

/** 画面に出してよい失敗の理由（コードか種類だけ。メッセージは出さない＝接続文字列が混ざりうる） */
export function describeConnectError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(code)) return code
  return e instanceof Error && /^[A-Za-z]{3,30}$/.test(e.name) ? e.name : 'error'
}

// ------------------------------------------------------------
// ログイン（Supabase Auth）
// ------------------------------------------------------------

/** ログインできなかった。message は利用者にそのまま見せてよい。retryable ならもう一度聞いてよい */
export class LoginError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'LoginError'
  }
}

export interface LoginResult {
  accessToken: string
  userId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST {SUPABASE_URL}/auth/v1/token?grant_type=password（apikey は anon キー）。1 回だけ送る（再試行しない。
 * 間違ったパスワードを重ねて送ると、ロックされることがある）。パスワードと JWT は、エラーの文にも出さない
 */
export async function loginWithPassword(options: {
  fetch: typeof fetch
  supabaseUrl: string
  anonKey: string
  email: string
  password: string
}): Promise<LoginResult> {
  const base = normalizeSupabaseUrl(options.supabaseUrl)
  let res: Response
  try {
    res = await options.fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: options.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: options.email, password: options.password }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new LoginError('ログインできませんでした（通信できません）。ネットワークを確かめてください', false)
  }
  if (res.status === 400 || res.status === 401) throw new LoginError('メールアドレスかパスワードが違います', true)
  if (res.status === 429) throw new LoginError('ログインの試行が多すぎます。しばらく待ってから、もう一度実行してください', false)
  if (!res.ok) throw new LoginError(`ログインできませんでした（Supabase が ${res.status} を返しました）`, false)

  let body: { access_token?: unknown; user?: { id?: unknown } | null }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new LoginError('ログインの応答を読めませんでした', false)
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  const userId = typeof body.user?.id === 'string' && UUID.test(body.user.id) ? body.user.id : (jwtSubject(accessToken) ?? '')
  if (accessToken === '' || userId === '') throw new LoginError('ログインの応答に、必要な値がありませんでした', false)
  return { accessToken, userId }
}

/** JWT の sub（ユーザー id）。読めなければ null（中身は検証しない。Storage と DB が検証する） */
export function jwtSubject(jwt: string): string | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const sub = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown }).sub
    return typeof sub === 'string' && UUID.test(sub) ? sub : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// 世帯
// ------------------------------------------------------------

/**
 * ユーザー id から世帯 id を引く。API と同じ関数（app.household_of_user）を呼ぶ。
 * 呼べなければ（権限など）、同じ並びで app.household_member を引く。どちらも引けなければ例外、世帯が無ければ null
 */
export async function findHousehold(sql: Sql, userId: string): Promise<string | null> {
  if (!UUID.test(userId)) throw new Error('ユーザーの id が uuid の形ではありません')
  try {
    const row = await sql.get<{ id: string | null }>('select app.household_of_user(?::uuid)::text as id', userId)
    return row?.id ?? null
  } catch {
    // 関数を呼ぶ権限がない接続。メンバー表を直接引く（household_of_user と同じ並び）
    const row = await sql.get<{ id: string }>(
      `select m.household_id::text as id
         from app.household_member m
         left join app.household h on h.id = m.household_id
        where m.user_id = ?::uuid
        order by coalesce(h.created_at, m.created_at), m.created_at, m.household_id
        limit 1`,
      userId,
    )
    return row?.id ?? null
  }
}
