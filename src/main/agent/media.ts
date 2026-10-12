import type { FetchFn } from './http'

// ============================================================
// 画像を Supabase Storage の `media` バケットに上げる（取り込み担当の PC → Storage）
//
// 収集は今まで通りローカルの userData/thumbs にファイルを落とす。リモートの store（store/remote.ts）は、
// そのファイルをここで Storage に上げてから、**上げたパス**を API（saveThumb / saveLineImage）に渡す。
//
//   POST {supabaseUrl}/storage/v1/object/media/<世帯の id>/<sale|listing|purchase-line>/<乱数>.<拡張子>
//   Authorization: Bearer <人の JWT>   apikey: <anon キー>   Content-Type: <画像の種類>
//
// 通すのは人の JWT ＋ anon キーだけ（Storage の方針が、パスの先頭＝自分の世帯の id のときだけ書かせる。
// supabase/migrations/…_storage.sql）。上げられなければ**例外を投げる**＝収集のコードがその画像を飛ばす
// （収集は続ける）。パスは乱数なので推測できない。どこからも参照されないファイルは後で回収する（設計どおり）。
// ============================================================

export type MediaKind = 'sale' | 'listing' | 'purchase-line'

export interface MediaCredentials {
  /** 人の JWT（Web 版のログイン。メモリだけ） */
  accessToken: string
  /** Supabase の Project URL（https の origin） */
  supabaseUrl: string
  anonKey: string
}

export interface MediaUploader {
  /** ローカルのファイル名（userData/thumbs の中）を Storage に上げて、パス（バケットの中）を返す */
  upload(kind: MediaKind, file: string): Promise<string>
}

export interface MediaUploaderOptions {
  householdId: string
  /** 呼ぶたびに今の資格を返す（トークンは更新される）。無ければ null＝上げない */
  credentials: () => MediaCredentials | null
  fetch: FetchFn
  /** userData/thumbs の中のファイルを読む */
  readFile: (file: string) => Promise<Uint8Array>
  /** パスに使う乱数（推測できないもの） */
  randomId: () => string
  /** 1 枚の上限（バイト）。サムネイルは小さいので、これを超えるものは画像ではないとみなす */
  maxBytes?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const RANDOM_ID = /^[A-Za-z0-9-]{8,64}$/
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 60_000

/** 先頭のバイトで画像の種類を決める（拡張子や Content-Type は信用しない。HTML のエラーページを画像として上げない） */
export function detectImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  const at = (i: number): number => bytes[i] ?? -1
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { ext: 'png', mime: 'image/png' }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return { ext: 'gif', mime: 'image/gif' }
  // WebP … "RIFF"????"WEBP"
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return { ext: 'webp', mime: 'image/webp' }
  // AVIF … ????"ftypavif"
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70
    && at(8) === 0x61 && at(9) === 0x76 && at(10) === 0x69 && at(11) === 0x66) return { ext: 'avif', mime: 'image/avif' }
  return null
}

function upstreamMessage(status: number): string {
  if (status === 401 || status === 403) return '画像を上げられませんでした（ログインの権限がありません）'
  return `画像を上げられませんでした（${status}）`
}

export function createMediaUploader(options: MediaUploaderOptions): MediaUploader {
  if (!UUID.test(options.householdId)) throw new Error('世帯の id が正しくありません')
  const householdId = options.householdId.toLowerCase()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  /** 1 回送る。5xx・通信切れは { retry: true } で返す（呼び出し側が 1 度だけやり直す） */
  async function putOnce(
    creds: MediaCredentials, path: string, bytes: Uint8Array, mime: string,
  ): Promise<{ ok: true } | { ok: false; retry: boolean; message: string }> {
    let res: Response
    try {
      res = await options.fetch(`${creds.supabaseUrl}/storage/v1/object/media/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          apikey: creds.anonKey,
          'Content-Type': mime,
          // パスは乱数で、中身は変わらない（差し替えるときは別のパスを使う）
          'cache-control': 'max-age=31536000',
          'x-upsert': 'false',
        },
        // Uint8Array をそのまま送る（Buffer の余りの領域を送らない）
        body: bytes as unknown as BodyInit,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return { ok: false, retry: true, message: '画像を上げられませんでした（通信できません）' }
    }
    if (res.ok) return { ok: true }
    return { ok: false, retry: res.status >= 500, message: upstreamMessage(res.status) }
  }

  return {
    async upload(kind, file) {
      if (!SAFE_FILE.test(file) || file.includes('..')) throw new Error('画像のファイル名が正しくありません')
      const creds = options.credentials()
      if (!creds) throw new Error('画像を上げられませんでした（Web 版のログインが届いていません）')

      const bytes = await options.readFile(file)
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error('画像のサイズが正しくありません')
      const image = detectImage(bytes)
      if (!image) throw new Error('画像の形式が読めません')

      // 失敗しても 1 度だけ別のパスでやり直す（5xx・通信切れのみ）。応答だけが失われた場合に孤児が 1 つ残りうる
      // が、どこからも参照されないファイルは後で回収する設計
      let last = ''
      for (let i = 0; i < 2; i++) {
        const id = options.randomId()
        if (!RANDOM_ID.test(id)) throw new Error('画像のパスを作れませんでした')
        const path = `${householdId}/${kind}/${id}.${image.ext}`
        const r = await putOnce(creds, path, bytes, image.mime)
        if (r.ok) return path
        last = r.message
        if (!r.retry) break
      }
      throw new Error(last)
    },
  }
}
