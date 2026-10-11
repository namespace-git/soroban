import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import type { Bucket, ImageKind, Row, SourceSnapshot } from './types'

// 画像の移行。デスクトップ版の userData/thumbs のファイル名 → Supabase Storage のパス。
//   media    （公開）  <世帯>/<種類>/<ランダムな uuid>.<拡張子>   … 販売・出品・仕入明細・商品の写真
//   receipts （非公開）<世帯>/receipt/<ランダムな uuid>.<拡張子>  … レシート
// パスは**参照ごとに**新しく決める（同じファイルを複数の行が指していても共有しない。
// 後から片方を差し替え・削除したとき、もう片方の画像が消えないように）

/** 画像のファイルを読む口。本番は userData/thumbs のコピー（フォルダ）、テストは偽物 */
export interface ImageSource {
  /** ファイルがあれば大きさ（バイト）、無ければ null */
  stat(name: string): Promise<{ size: number } | null>
  read(name: string): Promise<Uint8Array>
}

/** Storage に置く口。本番は Supabase Storage の REST（SupabaseStorageUploader）、テストは偽物 */
export interface ImageUploader {
  upload(item: { bucket: Bucket; path: string; contentType: string; bytes: Uint8Array }): Promise<void>
  /** 失敗したときに、置いた分を片付ける（できる範囲で）。無ければ片付けない */
  remove?(bucket: Bucket, paths: string[]): Promise<void>
}

/** SQLite のどの列の画像を、どこへ置くか */
export interface ImageColumnSpec {
  /** SQLite の表 */
  table: string
  /** ファイル名の列（SQLite） */
  column: string
  kind: ImageKind
  bucket: Bucket
  /** 行を指す列（SQLite）。参照ごとの対応を引くための鍵 */
  keyColumn: string
}

export const IMAGE_COLUMNS: ImageColumnSpec[] = [
  { table: 'sale', column: 'thumb_file', kind: 'sale', bucket: 'media', keyColumn: 'id' },
  { table: 'listing', column: 'thumb_file', kind: 'listing', bucket: 'media', keyColumn: 'mercari_item_id' },
  { table: 'purchase_line', column: 'image_file', kind: 'purchase-line', bucket: 'media', keyColumn: 'id' },
  { table: 'product_image', column: 'file', kind: 'product', bucket: 'media', keyColumn: 'model_code' },
  { table: 'expense', column: 'receipt_file', kind: 'receipt', bucket: 'receipts', keyColumn: 'id' },
]

export type ImageStatus = 'ready' | 'missing' | 'unsafe_name' | 'empty'

/** 画像 1 つぶんの対応（元のファイル → 新しいパス） */
export interface PlannedImage {
  table: string
  column: string
  /** 行を指す値（sale なら sale.id、product_image なら model_code） */
  rowKey: string
  kind: ImageKind
  bucket: Bucket
  sourceFile: string
  /** 新しいパス。ファイルが見つからない・名前が安全でないときは null（行の参照も null にする） */
  path: string | null
  status: ImageStatus
  size: number
  contentType: string
}

export interface ImagePlan {
  entries: PlannedImage[]
  /** 行の参照に入れる新しいパス。画像の無い行・見つからなかった行は null */
  pathFor(table: string, rowKey: string): string | null
  /** 見つからなかった（参照を null にした）もの */
  missing: PlannedImage[]
  /** 置く予定の画像（status = ready） */
  ready: PlannedImage[]
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
}

export function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.')
  const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : ''
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin'
}

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extensionOf(file)] ?? 'application/octet-stream'
}

/** ファイル名がフォルダの外を指していない（ただの名前）か */
export function isPlainFileName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name) && !name.startsWith('.')
}

/**
 * 画像の対応表を作る。ファイルを読みはしない（大きさを調べるだけ）。
 * newId はパスの「ランダムな uuid」。推測できないこと（既定は crypto.randomUUID）
 */
export async function planImages(
  snapshot: Pick<SourceSnapshot, 'tables'>,
  householdId: string,
  source: ImageSource,
  newId: () => string = randomUUID,
): Promise<ImagePlan> {
  const entries: PlannedImage[] = []
  for (const spec of IMAGE_COLUMNS) {
    for (const row of snapshot.tables[spec.table] ?? []) {
      const file = row[spec.column]
      if (file === null || file === undefined || file === '') continue
      if (typeof file !== 'string') {
        throw new Error(`${spec.table}.${spec.column} がファイル名（文字列）ではありません（${spec.keyColumn} = ${String(row[spec.keyColumn])}）`)
      }
      const entry: PlannedImage = {
        table: spec.table, column: spec.column, rowKey: String(row[spec.keyColumn]), kind: spec.kind, bucket: spec.bucket,
        sourceFile: file, path: null, status: 'ready', size: 0, contentType: contentTypeOf(file),
      }
      if (!isPlainFileName(file)) {
        entry.status = 'unsafe_name'
      } else {
        const info = await source.stat(file)
        if (info === null) entry.status = 'missing'
        else if (info.size === 0) entry.status = 'empty'
        else entry.size = info.size
      }
      if (entry.status === 'ready') entry.path = `${householdId}/${spec.kind}/${newId()}.${extensionOf(file)}`
      entries.push(entry)
    }
  }
  const byKey = new Map(entries.map((e) => [`${e.table}\u0000${e.rowKey}`, e]))
  return {
    entries,
    pathFor: (table, rowKey) => byKey.get(`${table}\u0000${rowKey}`)?.path ?? null,
    missing: entries.filter((e) => e.status !== 'ready'),
    ready: entries.filter((e) => e.status === 'ready'),
  }
}

/** フォルダ（userData/thumbs のコピー）から読む ImageSource */
export function folderImageSource(dir: string): ImageSource {
  const resolve = (name: string): string => {
    const full = join(dir, name)
    const rel = relative(dir, full)
    if (!isPlainFileName(name) || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`画像のファイル名が不正です: ${name}`)
    return full
  }
  return {
    async stat(name) {
      try {
        const s = await stat(resolve(name))
        return s.isFile() ? { size: s.size } : null
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null
        throw e
      }
    },
    async read(name) {
      return new Uint8Array(await readFile(resolve(name)))
    },
  }
}

export interface UploadResult {
  uploaded: PlannedImage[]
  bytes: number
}

/**
 * ready の画像を 1 つずつ置く。途中で失敗したら、置いた分を片付けて（uploader.remove があれば）投げ直す。
 * 片付けに失敗しても、元のエラーを隠さない（片付けられなかったパスは message に残す）
 */
export async function uploadImages(
  plan: ImagePlan,
  source: ImageSource,
  uploader: ImageUploader,
  onProgress?: (done: number, total: number) => void,
): Promise<UploadResult> {
  const done: PlannedImage[] = []
  let bytes = 0
  try {
    for (const image of plan.ready) {
      const data = await source.read(image.sourceFile)
      await uploader.upload({ bucket: image.bucket, path: image.path as string, contentType: image.contentType, bytes: data })
      done.push(image)
      bytes += data.byteLength
      onProgress?.(done.length, plan.ready.length)
    }
  } catch (e) {
    const leftover = await removeUploaded(uploader, done)
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `画像の保存に失敗しました（${done.length} / ${plan.ready.length} 件目まで保存済み）: ${reason}` +
        (leftover.length > 0 ? `\n片付けられなかった画像（Storage に残っています）:\n${leftover.map((p) => `  ${p}`).join('\n')}` : ''),
      { cause: e },
    )
  }
  return { uploaded: done, bytes }
}

/** 置いた画像を消す（DB への書き込みが失敗したとき）。消せなかったパスを返す */
export async function removeUploaded(uploader: ImageUploader, images: PlannedImage[]): Promise<string[]> {
  if (images.length === 0) return []
  if (!uploader.remove) return images.map((i) => `${i.bucket}/${i.path}`)
  const left: string[] = []
  for (const bucket of ['media', 'receipts'] as const) {
    const paths = images.filter((i) => i.bucket === bucket).map((i) => i.path as string)
    if (paths.length === 0) continue
    try {
      await uploader.remove(bucket, paths)
    } catch {
      left.push(...paths.map((p) => `${bucket}/${p}`))
    }
  }
  return left
}

export interface SupabaseStorageOptions {
  /** Project URL（https://xxxx.supabase.co）。末尾の / は付けない */
  url: string
  /** anon（publishable）キー。ブラウザに出る前提の公開鍵 */
  anonKey: string
  /** 利用者のログイン済み JWT（Storage の書き込み権限は RLS が見る） */
  jwt: string
  /** テスト用。既定は globalThis.fetch */
  fetch?: typeof fetch
  /** テスト用。再試行の待ち（ミリ秒）。既定 1000 */
  retryDelayMs?: number
}

/**
 * Supabase Storage の REST で置く。
 *   POST {url}/storage/v1/object/<bucket>/<path>   Authorization: Bearer <JWT>  apikey: <anon キー>
 * 4xx は再試行しない。5xx と通信失敗だけ短く 2 回まで。**JWT・キーは応答やエラーの文に出さない**
 */
export class SupabaseStorageUploader implements ImageUploader {
  private readonly base: string
  private readonly anonKey: string
  private readonly jwt: string
  private readonly doFetch: typeof fetch
  private readonly retryDelayMs: number

  constructor(options: SupabaseStorageOptions) {
    this.base = normalizeSupabaseUrl(options.url)
    this.anonKey = options.anonKey
    this.jwt = options.jwt
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.retryDelayMs = options.retryDelayMs ?? 1000
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.jwt}`, apikey: this.anonKey, ...extra }
  }

  async upload(item: { bucket: Bucket; path: string; contentType: string; bytes: Uint8Array }): Promise<void> {
    const url = `${this.base}/storage/v1/object/${item.bucket}/${encodeObjectPath(item.path)}`
    await this.send(`${item.bucket}/${item.path}`, () =>
      this.doFetch(url, {
        method: 'POST',
        // upsert しない（同じパスが既にあれば 409 で止める＝他人の画像を上書きしない）
        headers: this.headers({ 'Content-Type': item.contentType, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' }),
        body: item.bytes as unknown as BodyInit,
      }),
    )
  }

  async remove(bucket: Bucket, paths: string[]): Promise<void> {
    const url = `${this.base}/storage/v1/object/${bucket}`
    await this.send(`${bucket}（${paths.length} 件の削除）`, () =>
      this.doFetch(url, {
        method: 'DELETE',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: paths }),
      }),
    )
  }

  private async send(what: string, request: () => Promise<Response>): Promise<void> {
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt))
      let res: Response
      try {
        res = await request()
      } catch (e) {
        lastError = `通信に失敗しました（${e instanceof Error ? e.name : 'error'}）`
        continue
      }
      if (res.ok) return
      const detail = await readErrorMessage(res)
      lastError = `${res.status}${detail ? ` ${detail}` : ''}`
      if (res.status < 500) break
    }
    throw new Error(`Storage への保存に失敗しました: ${what}: ${lastError}`)
  }
}

/** Project URL の検査と整形。https のみ（ローカルの開発用 http://localhost だけ許す） */
export function normalizeSupabaseUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('SUPABASE_URL が URL として読めません')
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new Error('SUPABASE_URL は https:// で始まる Project URL にしてください')
  }
  return `${u.origin}`
}

/** パスの各区間を URL エンコードする（'/' は残す） */
export function encodeObjectPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Row
    const message = body.message ?? body.error ?? ''
    return typeof message === 'string' ? message.slice(0, 200) : ''
  } catch {
    return ''
  }
}
