import { randomUUID } from 'node:crypto'
import { withHousehold, type Ctx } from '../../context'
import { dispatch, type DispatchDeps } from '../../rpc'
// 業務ロジックの登録（registerHandler の副作用）。入口（functions/api/rpc）が読むのと同じもの
import '../../domain/index'
import { newMember, type DomainDb, type Member } from '../domain/helpers'
import { keyRing, newKey, fakeApiKey } from '../integrations/helpers'

// レシート・商品画像のアップロード（server/storage.ts・server/domain/upload.ts ほか）のテスト用の道具。
// 本物の Supabase Storage・Gemini には出ない。偽の fetch が両方の振りをして、呼ばれ方（JWT・anon キー・パス・回数）を記録する。
// Storage の「自分の世帯のフォルダしか触れない」方針（20261012001530_storage.sql）も、偽物の中で真似る。

export const SUPABASE_URL = 'https://abcdefgh.supabase.test'
export const ANON_KEY = 'anon-key-public-for-tests'

export type CallKind = 'sign' | 'signMany' | 'remove' | 'download' | 'gemini' | 'other'

export interface FakeCall {
  kind: CallKind
  bucket?: string
  /** sign・download の 1 本、signMany・remove の複数 */
  paths: string[]
  apikey: string | null
  authorization: string | null
  /** 本文（JSON）。gemini は model・APIキーのヘッダー・画像の MIME を分けて持つ */
  body?: unknown
  geminiKey?: string | null
  model?: string
}

export type FailMode = 'network' | 500 | 403

/** Gemini の応答を作る側が受け取る要求 */
export interface GeminiRequest {
  model: string
  apiKey: string | null
  mimeType: string
  base64: string
  prompt: string
}

const NOT_FOUND_BODY = JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' })

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 偽の Supabase Storage ＋ 偽の Gemini */
export class FakeBackend {
  /** `${bucket}/${path}` → 中身 */
  objects = new Map<string, Uint8Array>()
  calls: FakeCall[] = []
  /** Authorization の JWT → その人の世帯（方針の真似。知らない JWT は 401） */
  jwtHousehold = new Map<string, string>()
  failures: Partial<Record<Exclude<CallKind, 'other' | 'gemini'>, FailMode>> = {}
  /** Gemini の応答。既定は readyDraft() */
  gemini: (req: GeminiRequest) => Response | Promise<Response> = () => geminiOk(readyDraft())
  sleeps: number[] = []
  private signSeq = 0

  put(bucket: string, path: string, bytes: Uint8Array = Uint8Array.from([1, 2, 3, 4])): void {
    this.objects.set(`${bucket}/${path}`, bytes)
  }

  has(bucket: string, path: string): boolean {
    return this.objects.has(`${bucket}/${path}`)
  }

  of(kind: CallKind): FakeCall[] {
    return this.calls.filter(c => c.kind === kind)
  }

  /** Gemini の再試行の待ち。本当には待たず、待つはずだった長さを記録する */
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms)
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const bodyText = typeof init?.body === 'string' ? init.body : undefined
    const body = bodyText ? JSON.parse(bodyText) : undefined

    if (url.hostname === 'generativelanguage.googleapis.com') {
      const m = /\/models\/([^/:]+):generateContent$/.exec(url.pathname)
      const part = body?.contents?.[0]?.parts ?? []
      const req: GeminiRequest = {
        model: m?.[1] ?? '',
        apiKey: headers.get('x-goog-api-key'),
        mimeType: part[0]?.inline_data?.mime_type ?? '',
        base64: part[0]?.inline_data?.data ?? '',
        prompt: part[1]?.text ?? '',
      }
      this.calls.push({ kind: 'gemini', paths: [], apikey: null, authorization: null, geminiKey: req.apiKey, model: req.model, body })
      return this.gemini(req)
    }

    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith('/storage/v1/')) {
      this.calls.push({ kind: 'other', paths: [url.href], apikey: null, authorization: null })
      throw new Error(`想定外の通信: ${url.href}`)
    }
    const rest = url.pathname.slice('/storage/v1'.length)
    const method = (init?.method ?? 'GET').toUpperCase()
    const decode = (s: string) => s.split('/').map(decodeURIComponent).join('/')
    const base = { apikey: headers.get('apikey'), authorization: headers.get('authorization') }

    let kind: CallKind = 'other'
    let bucket = ''
    let paths: string[] = []
    let m: RegExpExecArray | null
    if (method === 'POST' && (m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(rest))) {
      kind = 'sign'; bucket = m[1]; paths = [decode(m[2])]
    } else if (method === 'POST' && (m = /^\/object\/sign\/([^/]+)$/.exec(rest))) {
      kind = 'signMany'; bucket = m[1]; paths = body?.paths ?? []
    } else if (method === 'DELETE' && (m = /^\/object\/([^/]+)$/.exec(rest))) {
      kind = 'remove'; bucket = m[1]; paths = body?.prefixes ?? []
    } else if (method === 'GET' && (m = /^\/object\/authenticated\/([^/]+)\/(.+)$/.exec(rest))) {
      kind = 'download'; bucket = m[1]; paths = [decode(m[2])]
    }
    this.calls.push({ kind, bucket, paths, ...base, body })
    if (kind === 'other') return json({ statusCode: '404', error: 'not_found', message: 'no route' }, 404)

    // 失敗の真似
    const fail = this.failures[kind]
    if (fail === 'network') throw new TypeError('fetch failed')
    if (typeof fail === 'number') return json({ statusCode: String(fail), error: 'x', message: 'boom' }, fail)

    // 認証：anon キーと、知っている JWT
    const jwt = /^Bearer (.+)$/.exec(base.authorization ?? '')?.[1]
    const household = jwt ? this.jwtHousehold.get(jwt) : undefined
    if (base.apikey !== ANON_KEY || !household) return json({ statusCode: '401', error: 'Unauthorized', message: 'Invalid JWT' }, 401)

    // 方針：パスの先頭のフォルダが自分の世帯のものだけ見える・消せる
    const visible = (p: string) => p.split('/')[0] === household && this.objects.has(`${bucket}/${p}`)

    switch (kind) {
      case 'sign': {
        if (!visible(paths[0])) return new Response(NOT_FOUND_BODY, { status: 400 }) // 本物は 400 ＋ 本文の statusCode "404"
        return json({ signedURL: `/object/sign/${bucket}/${paths[0]}?token=signed-${++this.signSeq}` })
      }
      case 'signMany':
        return json(paths.map(p => visible(p)
          ? { error: null, path: p, signedURL: `/object/sign/${bucket}/${p}?token=signed-${++this.signSeq}` }
          : { error: 'Either the object does not exist or you do not have access to it', path: p, signedURL: null }))
      case 'remove': {
        const removed = paths.filter(visible)
        for (const p of removed) this.objects.delete(`${bucket}/${p}`)
        return json(removed.map(name => ({ name })))
      }
      case 'download': {
        if (!visible(paths[0])) return new Response(NOT_FOUND_BODY, { status: 400 })
        const bytes = this.objects.get(`${bucket}/${paths[0]}`)!
        return new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) } })
      }
      default:
        return json({}, 404)
    }
  }
}

/** Gemini の正常な応答（候補の本文に JSON を入れる） */
export function geminiOk(payload: unknown): Response {
  return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] })
}

export function geminiError(status: number, message: string): Response {
  return json({ error: { code: status, message } }, status)
}

/** デスクトップのテスト（src/main/__tests__/ai-receipt.test.ts）と同じ入力。期待値も同じにする（同じ下書きになる証拠） */
export function readyDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shop: 'ダイソー 川崎駅前店',
    registration_no: 'T1234567890123',
    date: '2025-09-15',
    total: 880,
    tax: 80,
    lines: [
      // unit_price は実際と違う値を混ぜる。amount / quantity から計算し直すので無視されるはず
      { name: 'ビニール袋 100枚', unit_price: 999, quantity: 1, amount: 110, category: 'packaging', box_2d: [10, 20, 30, 40] },
      { name: 'OPP袋 A4', unit_price: 999, quantity: 2, amount: 220, category: 'packaging' },
      // 割り切れない：金額そのもの・数量 1 にフォールバック
      { name: '緩衝材', unit_price: 999, quantity: 3, amount: 100, category: 'noidea' },
    ],
    boxes: { shop: [0, 0, 50, 200], date: null, total: [900, 0, 950, 200] },
    warnings: ['店名の読み取りに自信がありません'],
    ...overrides,
  }
}

/** `readyDraft()` を読んだときの ReceiptDraft（店名の学習の前）。デスクトップのテストの期待値と同じ */
export function expectedDraft(): Record<string, unknown> {
  return {
    shop: 'ダイソー 川崎駅前店',
    registration_no: 'T1234567890123',
    shop_learned: false,
    occurred_at: '2025-09-15',
    total: 880,
    lines: [
      { name: 'ビニール袋 100枚', unit_price: 110, quantity: 1, category: 'packaging', box: [10, 20, 30, 40] },
      { name: 'OPP袋 A4', unit_price: 110, quantity: 2, category: 'packaging' },
      { name: '緩衝材', unit_price: 100, quantity: 1 },
    ],
    boxes: { shop: [0, 0, 50, 200], date: null, total: [900, 0, 950, 200] },
    tax: 80,
    warnings: ['店名の読み取りに自信がありません'],
    confidence: 80,
  }
}

// ------------------------------------------------------------
// 世帯 A・B
// ------------------------------------------------------------

export interface UploadMember {
  member: Member
  householdId: string
  userId: string
  /** この人のアクセストークン（偽物。偽の Storage が世帯に結ぶ） */
  jwt: string
}

export interface UploadWorld {
  backend: FakeBackend
  a: UploadMember
  b: UploadMember
  secretKeys: string
  /** 環境変数（生）。Gemini の鍵を保存・復号するための SECRET_KEYS を含む */
  env: Record<string, string>
  /** dispatch（API の入口）を、この人の JWT・偽の fetch で呼ぶ。応答の本文は JSON で返す */
  call(who: UploadMember, method: string, ...args: unknown[]): Promise<{ status: number; text: string; body: { result?: any; error?: { code: string; message: string } } }>
  /** 1 リクエスト（1 トランザクション）ぶんを、この人の JWT・偽の fetch で直接実行する。コミットの後に afterCommit が走る */
  run<T>(who: UploadMember, fn: (ctx: Ctx) => Promise<T>, opts?: { noJwt?: boolean; noAnon?: boolean }): Promise<T>
}

export async function newUploadWorld(db: DomainDb, opts: { withAnonKey?: boolean } = {}): Promise<UploadWorld> {
  const backend = new FakeBackend()
  const secretKeys = keyRing([1, newKey()])
  const env: Record<string, string> = { SUPABASE_URL, SECRET_KEYS: secretKeys }
  if (opts.withAnonKey !== false) env.SUPABASE_ANON_KEY = ANON_KEY

  const make = async (name: string): Promise<UploadMember> => {
    const member = await newMember(db, name)
    const jwt = `fake.jwt.${randomUUID()}`
    backend.jwtHousehold.set(jwt, member.householdId)
    return { member, householdId: member.householdId, userId: member.userId, jwt }
  }
  const a = await make('A')
  const b = await make('B')

  const deps = (who: UploadMember): Omit<DispatchDeps, 'handlers'> => ({
    root: db.root,
    identity: { householdId: who.householdId, userId: who.userId },
    env,
    userJwt: who.jwt,
    fetch: backend.fetch,
    sleep: backend.sleep,
  })
  return {
    backend, a, b, secretKeys, env,
    async call(who, method, ...args) {
      const response = await dispatch(method, args, deps(who))
      const text = await response.text()
      return { status: response.status, text, body: JSON.parse(text) }
    },
    run(who, fn, o = {}) {
      return withHousehold(db.root, {
        householdId: who.householdId, userId: who.userId,
        userJwt: o.noJwt ? null : who.jwt,
        env: { ...serverEnvOf(env), SUPABASE_ANON_KEY: o.noAnon ? null : env.SUPABASE_ANON_KEY ?? null },
        fetch: backend.fetch, sleep: backend.sleep,
      }, fn)
    },
  }
}

function serverEnvOf(raw: Record<string, string>) {
  return {
    SUPABASE_URL: raw.SUPABASE_URL ?? null, SUPABASE_ANON_KEY: raw.SUPABASE_ANON_KEY ?? null,
    VAPID_PUBLIC_KEY: null, VAPID_PRIVATE_KEY: null, VAPID_SUBJECT: null, SECRET_KEYS: raw.SECRET_KEYS ?? null,
  }
}

/** Gemini の API キーを保存する（入口経由。暗号化されて DB に入る）。保存した平文のキーを返す */
export async function saveGeminiKey(world: UploadWorld, who: UploadMember): Promise<string> {
  const key = fakeApiKey()
  const r = await world.call(who, 'setGeminiApiKey', key)
  if (r.status !== 200) throw new Error(`Gemini のキーを保存できません: ${r.text}`)
  return key
}

/** 経費を 1 件作って id を返す */
export async function addExpense(world: UploadWorld, who: UploadMember, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await world.call(who, 'createExpense', { occurred_at: '2026-09-10', category: 'packaging', amount: 880, shop: 'ダイソー', ...extra })
  if (r.status !== 200) throw new Error(`経費を作れません: ${r.text}`)
  return r.body.result as string
}

/** prepareUpload で置き場所をもらい、偽の Storage に置く（画面が Storage へ直接上げるのと同じ）。パスを返す */
export async function upload(
  world: UploadWorld, who: UploadMember, kind: 'receipt' | 'product', ext: 'jpg' | 'png' | 'webp' = 'jpg',
  bytes?: Uint8Array,
): Promise<string> {
  const r = await world.call(who, 'prepareUpload', kind, ext)
  if (r.status !== 200) throw new Error(`置き場所をもらえません: ${r.text}`)
  const { bucket, path } = r.body.result as { bucket: string; path: string }
  world.backend.put(bucket, path, bytes)
  return path
}

export const receiptPath = (who: UploadMember, name = randomUUID(), ext = 'jpg'): string =>
  `${who.householdId}/receipt/${name}.${ext}`
export const productPath = (who: UploadMember, name = randomUUID(), ext = 'jpg'): string =>
  `${who.householdId}/product/${name}.${ext}`
