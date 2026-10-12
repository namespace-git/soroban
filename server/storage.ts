import type { UploadExt, UploadKind } from '../src/shared/web-types'
import type { Ctx } from './context'
import { UserError } from './errors'

// ============================================================
// Supabase Storage の REST（画像の署名つき URL・削除・読み出し）。
//
// **要求してきた人の JWT（Ctx.userJwt）＋ anon キー（ServerEnv.SUPABASE_ANON_KEY）で呼ぶ**。service_role キーは使わない。
// 方針（supabase/migrations/20261012001530_storage.sql）で「パスの先頭のフォルダが自分の世帯の id」のものしか
// 触れないので、サーバーのバグで他の世帯の画像を触ろうとしても Storage 側が断る。
//
// バケット：media（公開。商品の画像）／ receipts（非公開。レシート。見るときだけ署名つき URL）。
// パス：<世帯の id>/<receipt|product>/<乱数の uuid>.<jpg|png|webp>。パスはサーバーが作る（画面は組み立てない）。
//
// **JWT・anon キーはログにも、例外のメッセージにも、応答にも出さない**（出すのはメソッド名とステータスだけ）。
// 通信の失敗は日本語の UserError（404 は「見つかりません」）。
// ============================================================

export type StorageBucket = 'media' | 'receipts'

/** 署名つき URL の期限（秒）。一覧を開くたびに取り直すので、1 時間 */
export const SIGNED_URL_TTL_SECONDS = 3600

const TIMEOUT_MS = 15_000

// ------------------------------------------------------------
// 接続の設定
// ------------------------------------------------------------

/** Storage を呼ぶのに要るもの。メモリだけで持ち、ログ・応答に出さない */
export interface StorageConfig {
  /** 例 https://xxxx.supabase.co（末尾のスラッシュなし） */
  base: string
  anonKey: string
  /** 要求した人のアクセストークン */
  jwt: string
}

/** 設定が揃っていれば返す。SUPABASE_URL・SUPABASE_ANON_KEY が無い、またはログインした人の JWT が無い（agent・定期実行）なら null */
export function storageConfigOf(ctx: Pick<Ctx, 'env' | 'userJwt'>): StorageConfig | null {
  const base = ctx.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const anonKey = ctx.env.SUPABASE_ANON_KEY
  if (!base || !anonKey || !ctx.userJwt) return null
  return { base, anonKey, jwt: ctx.userJwt }
}

/** 設定が無ければ、利用者に見せる日本語で断る（画像の保存先が使えない） */
export function requireStorageConfig(ctx: Pick<Ctx, 'env' | 'userJwt'>): StorageConfig {
  const cfg = storageConfigOf(ctx)
  if (!cfg) {
    throw new UserError('画像の保存先が使えません（サーバーの SUPABASE_ANON_KEY の設定と、ログインを確認してください）')
  }
  return cfg
}

// ------------------------------------------------------------
// 置き場所（パス）
// ------------------------------------------------------------

const BUCKET_OF_KIND: Record<UploadKind, StorageBucket> = { receipt: 'receipts', product: 'media' }
export const UPLOAD_KINDS: readonly UploadKind[] = ['receipt', 'product']
export const UPLOAD_EXTS: readonly UploadExt[] = ['jpg', 'png', 'webp']

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function bucketOfKind(kind: UploadKind): StorageBucket {
  return BUCKET_OF_KIND[kind]
}

/** 新しい置き場所のパス。`<世帯の id>/<種類>/<乱数の uuid>.<拡張子>` */
export function newUploadPath(ctx: Pick<Ctx, 'householdId'>, kind: UploadKind, ext: UploadExt): string {
  return `${ctx.householdId}/${kind}/${crypto.randomUUID()}.${ext}`
}

/**
 * 画面から受け取ったパスを検査する。**`<自分の世帯の id>/<kind>/<uuid>.<jpg|png|webp>` の形だけ**を通す
 * （他の世帯・`..`・別の種類・形式違いは 400）。通ったパスを返す
 */
export function assertUploadPath(ctx: Pick<Ctx, 'householdId'>, kind: UploadKind, path: unknown): string {
  const re = new RegExp(`^${ctx.householdId}/${kind}/${UUID_PATTERN}\\.(jpg|png|webp)$`)
  if (typeof path !== 'string' || !re.test(path)) {
    throw new UserError('画像の置き場所が正しくありません。もう一度アップロードしてください')
  }
  return path
}

/** このパスが、自分の世帯の `<kind>` のフォルダの中か（消してよい画像かの判定。移行で入った拡張子違いも通す） */
export function isOwnPath(ctx: Pick<Ctx, 'householdId'>, kind: UploadKind, path: string | null | undefined): path is string {
  if (!path) return false
  const prefix = `${ctx.householdId}/${kind}/`
  return path.startsWith(prefix) && path.length > prefix.length && !path.split('/').includes('..')
}

// ------------------------------------------------------------
// REST
// ------------------------------------------------------------

export interface StorageClient {
  /** 署名つき URL 1 本。object が無ければ not_found の UserError（存在の確認にも使える） */
  signUrl(bucket: StorageBucket, path: string, expiresIn?: number): Promise<string>
  /** 署名つき URL をまとめて（**1 回の通信**）。署名できなかった（無い・権限なし）パスは null */
  signUrls(bucket: StorageBucket, paths: string[], expiresIn?: number): Promise<Map<string, string | null>>
  /** 消す。無いものは無視（何度呼んでも同じ） */
  remove(bucket: StorageBucket, paths: string[]): Promise<void>
  /** 読み出す（非公開バケットも、人の権限で）。maxBytes を超えたら UserError */
  download(bucket: StorageBucket, path: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }>
}

const NETWORK_MESSAGE = '画像の保存先に接続できません。しばらくしてからもう一度お試しください'
const NOT_FOUND_MESSAGE = '画像が見つかりません'

/** `fetchImpl` を省略するとグローバルの fetch（Workers では取り出して別名で呼ぶと Illegal invocation になるので、呼ぶたびに引く） */
export function storageClient(cfg: StorageConfig, fetchImpl?: typeof fetch): StorageClient {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init))

  async function send(op: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await doFetch(`${cfg.base}/storage/v1${path}`, {
        method,
        headers: {
          apikey: cfg.anonKey,
          authorization: `Bearer ${cfg.jwt}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      // 原因（URL・ヘッダー）は出さない
      console.error(`[storage] ${op}: 通信に失敗しました`)
      throw new UserError(NETWORK_MESSAGE)
    } finally {
      clearTimeout(timer)
    }
    if (res.ok) return res
    throw await statusError(op, res)
  }

  return {
    async signUrl(bucket, path, expiresIn = SIGNED_URL_TTL_SECONDS) {
      const res = await send('sign', 'POST', `/object/sign/${bucket}/${encodePath(path)}`, { expiresIn })
      const json = await readJson(res)
      const signed = (json as { signedURL?: unknown } | null)?.signedURL
      return absoluteUrl(cfg, signed)
    },

    async signUrls(bucket, paths, expiresIn = SIGNED_URL_TTL_SECONDS) {
      const map = new Map<string, string | null>()
      const unique = [...new Set(paths)]
      if (unique.length === 0) return map
      unique.forEach(assertSafePath)
      const res = await send('signMany', 'POST', `/object/sign/${bucket}`, { expiresIn, paths: unique })
      const json = await readJson(res)
      const items: unknown[] = Array.isArray(json) ? json : []
      for (const p of unique) map.set(p, null)
      for (const item of items) {
        const o = (item ?? {}) as { path?: unknown; signedURL?: unknown; signedUrl?: unknown; error?: unknown }
        if (typeof o.path !== 'string' || !map.has(o.path) || o.error) continue
        try {
          map.set(o.path, absoluteUrl(cfg, o.signedURL ?? o.signedUrl))
        } catch {
          // 形の違う応答は、その 1 本だけ署名なしにする
        }
      }
      return map
    },

    async remove(bucket, paths) {
      const unique = [...new Set(paths)]
      if (unique.length === 0) return
      unique.forEach(assertSafePath)
      await send('remove', 'DELETE', `/object/${bucket}`, { prefixes: unique })
    },

    async download(bucket, path, maxBytes) {
      const res = await send('download', 'GET', `/object/authenticated/${bucket}/${encodePath(path)}`)
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) throw new UserError('画像は 10MB までにしてください')
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await res.arrayBuffer())
      } catch {
        console.error('[storage] download: 読み出しに失敗しました')
        throw new UserError(NETWORK_MESSAGE)
      }
      if (bytes.byteLength > maxBytes) throw new UserError('画像は 10MB までにしてください')
      return { bytes, contentType: res.headers.get('content-type') }
    },
  }
}

/** バイト列を base64 に（Gemini に画像を送る用。大きい画像でも引数が溢れないよう小分けにして文字にする） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** パスの各区間を URL 用に包む（`/` は残す） */
function encodePath(path: string): string {
  assertSafePath(path)
  return path.split('/').map(encodeURIComponent).join('/')
}

/** 呼び出し側（assertUploadPath など）が検査済みのはず。ここは最後の砦：空・先頭の `/`・`..`・`\`・NUL は通さない */
function assertSafePath(path: string): void {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\u0000')
    || path.split('/').some(seg => seg === '' || seg === '..' || seg === '.')) {
    throw new UserError('画像の置き場所が正しくありません')
  }
}

/** 署名の応答（`/object/sign/<bucket>/<path>?token=…`）を、画面がそのまま `<img src>` に使える URL にする */
function absoluteUrl(cfg: StorageConfig, signed: unknown): string {
  if (typeof signed !== 'string' || signed === '') throw new UserError(NOT_FOUND_MESSAGE, 'not_found')
  if (/^https?:\/\//i.test(signed)) {
    // 絶対 URL で返ってきても、自分の Supabase 以外は使わない
    if (!signed.startsWith(`${cfg.base}/`)) throw new UserError('画像の保存先から想定外の応答が返りました')
    return signed
  }
  const path = signed.startsWith('/storage/v1') ? signed : `/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`
  return `${cfg.base}${path}`
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new UserError('画像の保存先から想定外の応答が返りました')
  }
}

/**
 * 非 2xx を日本語の UserError にする。Supabase Storage は存在しない object を HTTP 400 ＋ 本文の statusCode "404" で
 * 返すことがあるので、本文も見る。**本文はメッセージに入れない**（ログにも出さない）
 */
async function statusError(op: string, res: Response): Promise<UserError> {
  let bodyStatus: number | null = null
  try {
    const body = (await res.json()) as { statusCode?: unknown } | null
    const code = Number(body?.statusCode)
    if (Number.isInteger(code)) bodyStatus = code
  } catch {
    // 本文が JSON でなければ、HTTP のステータスだけで決める
  }
  const status = res.status === 400 && bodyStatus !== null ? bodyStatus : res.status
  console.error(`[storage] ${op}: ステータス ${status}`)
  if (status === 404) return new UserError(NOT_FOUND_MESSAGE, 'not_found')
  if (status === 401 || status === 403) {
    return new UserError('画像の保存先を使う権限がありません。ログインし直してください')
  }
  return new UserError(`画像の保存先でエラーが起きました（${status}）。しばらくしてからもう一度お試しください`)
}

// ------------------------------------------------------------
// コミットの後に消す
// ------------------------------------------------------------

/**
 * Storage のファイルを、**トランザクションがコミットされた後に**消す（`ctx.afterCommit`）。
 * ロールバックされたら消さない。消せなくても（保存先の設定が無い・通信の失敗）帳簿は巻き戻さない：失敗はログに残すだけ
 * （どこからも参照されないファイルは後で回収する）。
 * **自分の世帯のフォルダ（`<世帯の id>/…`）のパスしか消さない**（他は黙って除く）
 */
export function removeAfterCommit(
  ctx: Pick<Ctx, 'householdId' | 'env' | 'userJwt' | 'fetch' | 'afterCommit'>,
  bucket: StorageBucket,
  paths: Array<string | null | undefined>,
): void {
  const own = [...new Set(paths)].filter((p): p is string =>
    typeof p === 'string' && p.startsWith(`${ctx.householdId}/`) && !p.split('/').some(seg => seg === '' || seg === '..'))
  if (own.length === 0) return
  const cfg = storageConfigOf(ctx)
  const fetchImpl = ctx.fetch
  ctx.afterCommit(async () => {
    if (!cfg) {
      console.warn(`[storage] 画像 ${own.length} 件を消せませんでした（保存先の設定かログインの情報がありません）`)
      return
    }
    await storageClient(cfg, fetchImpl).remove(bucket, own)
  })
}
