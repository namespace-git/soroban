// Web 版の画像アップロード（画面側）。レシート・商品画像を「選ぶ → 縮める → Storage に上げる」。
// auth/boot.ts が動的 import する api/web.ts から使う（Electron 版のビルドには入らない）。
//
//   デスクトップの attachReceipt / readReceiptImage / setProductImage は main でファイル選択ダイアログを開く。
//   Web 版では同じ呼び出しで、スマホならカメラ／写真から、パソコンならファイルを選ぶ（<input type="file" accept="image/*">）。
//
//   1. 選ぶ    見えない <input> を作って click()。**呼ばれたその場（最初の await より前）で click する**。
//              スマホのブラウザは、操作の直後でないとファイル選択を開かないため
//   2. 縮める  canvas で JPEG にする（レシートは長辺 2,000px・商品画像は 1,200px・品質 0.85）。
//              EXIF の向きを反映し、位置情報などの EXIF は落ちる。読めない形式・10MB 超は日本語のエラーで断る
//   3. 上げる  prepareUpload でもらった bucket / path に、ログイン中の人の権限で上げる
//              （Storage の方針で自分の世帯のフォルダにしか書けない）。パスは画面で組み立てない
//
// ブラウザに触る部分（ImageEnv・PickerEnv）は差し替えられる。テストはこの 2 つを偽物にして回す
import type { UploadExt, UploadKind, UploadTarget } from '../../shared/web-types'

/** 選んだ画像・縮めたあとの画像のどちらにも掛ける上限 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 縮める寸法（長辺 px）と JPEG の品質。レシートは小さな字を読むので大きめ */
export const SHRINK: Record<UploadKind, { longEdge: number; quality: number }> = {
  receipt: { longEdge: 2000, quality: 0.85 },
  product: { longEdge: 1200, quality: 0.85 },
}

/** 上げる先（prepareUpload の bucket）の取り違え防止。レシートを公開の media に置かない */
const BUCKET_OF: Record<UploadKind, UploadTarget['bucket']> = { receipt: 'receipts', product: 'media' }

/** 上げるのにかける時間の上限。圏外などで固まったままにしない */
export const UPLOAD_TIMEOUT_MS = 90_000

const MSG_UNREADABLE = 'この形式の画像は読めません。JPEG か PNG で選んでください'
const MSG_TOO_LARGE = '画像が大きすぎます（10MB まで）。サイズの小さい画像を選んでください'
const MSG_ENCODE = '画像を縮められませんでした。別の画像で試してください'
const MSG_BAD_TARGET = '画像の置き場所を正しく受け取れませんでした。もう一度お試しください'
const MSG_TIMEOUT = '画像を上げるのに時間がかかっています。通信の状態を確かめて、もう一度お試しください'

/** 画面（トースト）にそのまま出してよい日本語のエラー */
export class UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

// ------------------------------------------------------------
// 1. 選ぶ
// ------------------------------------------------------------

export interface PickerInput {
  readonly files: ArrayLike<File> | null
  addEventListener(type: 'change' | 'cancel', listener: () => void): void
  click(): void
  remove(): void
}

/** ファイル選択に使うブラウザの部品 */
export interface PickerEnv {
  /** 見えない <input type="file" accept="image/*"> を作って画面に付けて返す */
  createInput(): PickerInput
  /** 窓がいったん離れて（blur）戻った（focus）ときに onReturn を呼ぶ。戻り値は解除 */
  watchReturn(onReturn: () => void): () => void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

/** 窓が戻ってから change が来るまでに待つ時間。cancel を出さない古いブラウザで「選ばなかった」と見なす */
export const RETURN_GRACE_MS = 3000

/**
 * 画像を 1 枚選ばせる。選ばなければ（cancel）null。
 * **同期的に input.click() まで進む**ので、クリックの処理の中で、最初の await より前に呼ぶこと。
 */
export function pickImageFile(env: PickerEnv): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const input = env.createInput()
    let settled = false
    let timer: unknown = null
    let unwatch: () => void = () => {}

    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      if (timer !== null) env.clearTimeout(timer)
      unwatch()
      input.remove()
      resolve(file)
    }
    const chosen = () => input.files?.[0] ?? null

    input.addEventListener('change', () => finish(chosen()))
    // 新しいブラウザは選ばずに閉じると cancel を出す
    input.addEventListener('cancel', () => finish(null))
    // cancel を出さないブラウザの保険：窓が戻ったのに change が来なければ、選ばなかったと見なす。
    // blur を経ない環境（スマホのシート）では動かない。そこでは cancel だけが頼り
    unwatch = env.watchReturn(() => {
      if (timer !== null) env.clearTimeout(timer)
      timer = env.setTimeout(() => finish(chosen()), RETURN_GRACE_MS)
    })

    input.click()
  })
}

export function browserPickerEnv(): PickerEnv {
  return {
    createInput() {
      const input = document.createElement('input')
      input.type = 'file'
      // image/* で、スマホは「写真を撮る／フォトライブラリ／ファイル」が出る。capture は付けない（撮る一択にしない）
      input.accept = 'image/*'
      input.tabIndex = -1
      input.setAttribute('aria-hidden', 'true')
      // display:none だと、ブラウザによって click() や change が効かないことがあるので、画面の端に透明で置く
      input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
      document.body.appendChild(input)
      return input
    },
    watchReturn(onReturn) {
      let blurred = false
      const onBlur = () => { blurred = true }
      const onFocus = () => {
        if (!blurred) return
        blurred = false
        onReturn()
      }
      window.addEventListener('blur', onBlur)
      window.addEventListener('focus', onFocus)
      return () => {
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('focus', onFocus)
      }
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
  }
}

// ------------------------------------------------------------
// 2. 縮める
// ------------------------------------------------------------

export interface DecodedImage {
  /** EXIF の向きを反映したあとの寸法 */
  width: number
  height: number
  /** canvas に描ける元（ImageBitmap か HTMLImageElement） */
  source: CanvasImageSource
  close(): void
}

/** 画像の読み込み・書き出しに使うブラウザの部品 */
export interface ImageEnv {
  /** 画像を選ばせる（pickImageFile）。呼ばれたその場で選択を開くこと */
  pickFile(): Promise<File | null>
  /** 画像として読む。読めなければ reject */
  decode(file: File): Promise<DecodedImage>
  /** width × height の JPEG にする。できなければ null */
  encodeJpeg(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob | null>
}

/** 長辺が longEdge に収まるように縮めた寸法。小さいものは拡大しない。比率は保ち、各辺は 1px 以上の整数 */
export function fitWithin(width: number, height: number, longEdge: number): { width: number; height: number } {
  if (Math.max(width, height) <= longEdge) return { width, height }
  if (width >= height) return { width: longEdge, height: Math.max(1, Math.round((height * longEdge) / width)) }
  return { width: Math.max(1, Math.round((width * longEdge) / height)), height: longEdge }
}

/** 選んだ画像を JPEG に縮める。読めない形式・大きすぎるものは UploadError */
export async function shrinkImage(file: File, kind: UploadKind, env: Pick<ImageEnv, 'decode' | 'encodeJpeg'>): Promise<Blob> {
  if (file.size > MAX_IMAGE_BYTES) throw new UploadError(MSG_TOO_LARGE)
  if (file.size === 0) throw new UploadError(MSG_UNREADABLE)

  let image: DecodedImage
  try {
    image = await env.decode(file)
  } catch {
    throw new UploadError(MSG_UNREADABLE)
  }
  try {
    if (!(image.width > 0) || !(image.height > 0)) throw new UploadError(MSG_UNREADABLE)
    const { longEdge, quality } = SHRINK[kind]
    const size = fitWithin(image.width, image.height, longEdge)
    let blob: Blob | null
    try {
      blob = await env.encodeJpeg(image, size.width, size.height, quality)
    } catch {
      blob = null
    }
    if (!blob || blob.size === 0) throw new UploadError(MSG_ENCODE)
    if (blob.size > MAX_IMAGE_BYTES) throw new UploadError(MSG_TOO_LARGE)
    return blob
  } finally {
    image.close()
  }
}

async function decodeWithImg(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode'))
      el.src = url
    })
    // <img> は EXIF の向きを反映した寸法・描画になる（image-orientation: from-image が既定）
    return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

async function decodeInBrowser(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
    } catch {
      // 読めない形式、または imageOrientation の指定を知らないブラウザ。<img> でも試す（それでも読めなければ reject）
    }
  }
  return decodeWithImg(file)
}

async function encodeInBrowser(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // JPEG は透明を持てない。透過 PNG が黒くならないよう、白を敷いてから描く
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image.source, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  // iOS Safari は canvas のメモリを溜めやすい。使い終わったら 0 にして返す
  canvas.width = 0
  canvas.height = 0
  return blob
}

export function browserImageEnv(): ImageEnv {
  const picker = browserPickerEnv()
  return {
    pickFile: () => pickImageFile(picker),
    decode: decodeInBrowser,
    encodeJpeg: encodeInBrowser,
  }
}

// ------------------------------------------------------------
// 3. 上げる
// ------------------------------------------------------------

/** supabase-js の `supabase.storage` のうち、使うところだけ */
export interface StorageLike {
  from(bucket: string): {
    upload(
      path: string,
      body: Blob,
      options: { contentType: string; upsert: boolean },
    ): Promise<{ error: { message?: string; status?: number | string; statusCode?: number | string } | null }>
    remove(paths: string[]): Promise<{ error: unknown }>
  }
}

function uploadFailureMessage(error: { message?: string; status?: number | string; statusCode?: number | string } | null): string {
  const status = Number(error?.statusCode ?? error?.status)
  const text = (error?.message ?? '').toLowerCase()
  if (status === 413 || /too large|exceeded the maximum|payload/.test(text)) {
    return '画像が大きすぎて上げられませんでした。サイズの小さい画像を選んでください'
  }
  if (status === 401 || status === 403 || /row-level security|jwt|unauthorized|not authorized/.test(text)) {
    return '画像を上げる権限がありません。ログインし直してください'
  }
  // 英語の生のエラー（Failed to fetch・Load failed など）は出さない
  return '画像を上げられませんでした。通信の状態を確かめて、もう一度お試しください'
}

export type PrepareUpload = (kind: UploadKind, ext: UploadExt) => Promise<UploadTarget>

export interface ImageUploader {
  /**
   * 画像を選ばせ、縮め、prepare（WebApi.prepareUpload）でもらった場所に上げる。選ばなければ null。
   * **同期的にファイル選択を開く**ので、クリックの処理の中で、最初の await より前に呼ぶこと
   */
  pickAndUpload(kind: UploadKind, prepare: PrepareUpload): Promise<UploadTarget | null>
  /** 上げたものを消す（読み取りに失敗したときなど）。消せなくても何も投げない */
  discard(target: UploadTarget): Promise<void>
}

export interface ImageUploaderOptions {
  timeoutMs?: number
}

export function createImageUploader(
  storage: StorageLike,
  env: ImageEnv = browserImageEnv(),
  options: ImageUploaderOptions = {},
): ImageUploader {
  const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS

  async function put(kind: UploadKind, target: UploadTarget, blob: Blob): Promise<void> {
    // 置き場所は prepareUpload の戻りそのまま使う。ただし、レシートが公開の media に行くような取り違えは止める
    if (target.bucket !== BUCKET_OF[kind] || !target.path || target.path.startsWith('/') || target.path.includes('..')) {
      throw new UploadError(MSG_BAD_TARGET)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UploadError(MSG_TIMEOUT)), timeoutMs)
    })
    try {
      const sent = storage
        .from(target.bucket)
        .upload(target.path, blob, { contentType: 'image/jpeg', upsert: false })
        .then(
          (res) => {
            if (res.error) throw new UploadError(uploadFailureMessage(res.error))
          },
          (e: unknown) => {
            if (e instanceof UploadError) throw e
            throw new UploadError(uploadFailureMessage(e as { message?: string }))
          },
        )
      await Promise.race([sent, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async pickAndUpload(kind, prepare) {
      // async 関数の本体は最初の await までは同期で動く。選択を開くのは、必ずその前
      const picked = env.pickFile()
      const file = await picked
      if (!file) return null
      const blob = await shrinkImage(file, kind, env)
      // 縮められる画像と分かってから場所をもらう（読めない画像で置き場所を作らない）。縮めた結果は常に JPEG
      const target = await prepare(kind, 'jpg')
      await put(kind, target, blob)
      return target
    },

    async discard(target) {
      try {
        await storage.from(target.bucket).remove([target.path])
      } catch {
        // 消せなくても、元の失敗を人に伝えるほうを優先する
      }
    },
  }
}
