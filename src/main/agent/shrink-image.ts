// ============================================================
// Storage に上げる前に、画像を小さくする（取り込み担当の PC）
//
// 画面は一覧の 40〜64px のサムネイルに使うだけなのに、元の画像は平均 216KB・最大 2.5MB ある。スマホで最初に開くときが
// 重いので、上げる前に「長辺 640px 以内・JPEG（品質 80）」に縮める。media.ts がアップロードの直前に呼ぶ。
//
// このファイルは electron に依存しない。実際の画像処理（Electron の nativeImage）は呼び出し側（service.ts）が
// `createImageShrinker(nativeImage)` で渡す。テストでは偽物の factory に差し替える。
//
// 縮めない（＝元のまま上げる）とき：
//  - GIF（動く画像かもしれない。形を壊さない）
//  - 向き（EXIF Orientation）が付いた JPEG（nativeImage で作り直すと向きの情報が消えて、横倒しに見える）
//  - 長辺が 640px 以下で、120KB 以下（再圧縮の効果が薄く、画質だけ落ちる）
//  - 縮めた結果が元と同じか大きい
//  - 透過のある画像で、長辺が 640px 以下（JPEG にすると背景が黒くなる。PNG のまま作り直しても得るものがない）
// 読めない・書き出せないときは例外を投げる（media.ts が受けて、原因だけログに残し、元のまま上げる）。
// ============================================================

/** 縮めたあとの長辺（px） */
export const MAX_EDGE = 640
/** JPEG の品質 */
export const JPEG_QUALITY = 80
/** 長辺が MAX_EDGE 以下で、これ以下の大きさなら再圧縮しない（バイト） */
export const KEEP_AS_IS_BYTES = 120 * 1024

/**
 * 縮める処理。縮めた画像のバイト列を返す。縮めなくてよい（元のまま上げる）ときは null。
 * 失敗は例外（media.ts が元のまま上げる）。
 */
export type ImageShrinker = (
  bytes: Uint8Array,
  image: { ext: string; mime: string },
) => Uint8Array | null | Promise<Uint8Array | null>

/** Electron の NativeImage のうち使う部分（偽物に差し替えられるよう、形だけを決めておく） */
export interface ImageHandle {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): ImageHandle
  toJPEG(quality: number): Uint8Array
  toPNG(): Uint8Array
  /** 1 画素 4 バイト（BGRA か RGBA）。4 バイト目が透明度 */
  toBitmap(): Uint8Array
}

/** Electron の nativeImage に当たる */
export interface ImageFactory {
  createFromBuffer(buffer: Buffer): ImageHandle
}

export interface ShrinkOptions {
  /** 縮めたあとの長辺（px） */
  maxEdge?: number
  /** JPEG の品質（1〜100） */
  quality?: number
  /** 長辺が maxEdge 以下で、これ以下なら再圧縮しない（バイト） */
  keepBytes?: number
}

function u16(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  if (at < 0 || at + 2 > bytes.length) return -1
  return littleEndian ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]
}

function u32(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  if (at < 0 || at + 4 > bytes.length) return -1
  const b0 = bytes[at], b1 = bytes[at + 1], b2 = bytes[at + 2], b3 = bytes[at + 3]
  return littleEndian ? (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0 : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0
}

/** APP1 セグメントの中（"Exif\0\0" から始まる）から Orientation（1〜8）を読む。無い・壊れていれば 1 */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number {
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  if (end > bytes.length || start + exif.length > end) return 1
  for (let i = 0; i < exif.length; i++) if (bytes[start + i] !== exif[i]) return 1
  const tiff = start + exif.length
  const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  const be = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d
  if (!le && !be) return 1
  if (u16(bytes, tiff + 2, le) !== 42) return 1
  const ifdOffset = u32(bytes, tiff + 4, le)
  if (ifdOffset < 0) return 1
  const ifd = tiff + ifdOffset
  const count = u16(bytes, ifd, le)
  if (count < 0) return 1
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12
    if (entry + 12 > end) return 1
    if (u16(bytes, entry, le) === 0x0112) {
      const value = u16(bytes, entry + 8, le)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

/** JPEG の向き（EXIF Orientation。1〜8）。付いていない・読めなければ 1（そのままの向き） */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let i = 2
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return 1
    const marker = bytes[i + 1]
    if (marker === 0xff) { i += 1; continue } // 詰め物
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue } // 長さを持たない
    if (marker === 0xda || marker === 0xd9) return 1 // 画像データの手前まで見て、無ければ付いていない
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (length < 2) return 1
    if (marker === 0xe1) {
      const orientation = exifOrientation(bytes, i + 4, i + 2 + length)
      if (orientation !== 1) return orientation
    }
    i += 2 + length
  }
  return 1
}

/** 1 画素でも透けていれば true。調べられなければ true（JPEG にして背景を黒くしない側に倒す） */
function hasTransparency(image: ImageHandle): boolean {
  const bitmap = image.toBitmap()
  if (bitmap.length === 0 || bitmap.length % 4 !== 0) return true
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] !== 255) return true
  return false
}

export function createImageShrinker(factory: ImageFactory, options: ShrinkOptions = {}): ImageShrinker {
  const maxEdge = options.maxEdge ?? MAX_EDGE
  const quality = options.quality ?? JPEG_QUALITY
  const keepBytes = options.keepBytes ?? KEEP_AS_IS_BYTES

  return (bytes, image) => {
    if (image.ext === 'gif') return null
    if (image.ext === 'jpg' && jpegOrientation(bytes) !== 1) return null

    // Buffer の余りの領域を読まないよう、バイト列の範囲だけを渡す
    const decoded = factory.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (decoded.isEmpty()) throw new Error('画像を読み込めませんでした')
    const { width, height } = decoded.getSize()
    if (!(width > 0 && height > 0)) throw new Error('画像の大きさを読めませんでした')

    const longEdge = Math.max(width, height)
    const needResize = longEdge > maxEdge
    if (!needResize && bytes.byteLength <= keepBytes) return null

    let scaled = decoded
    if (needResize) {
      const scale = maxEdge / longEdge
      scaled = decoded.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      })
    }

    // JPEG は透過を持てない。透過のある画像（PNG・WebP・AVIF）は、縮める必要があるときだけ PNG のまま縮める
    const transparent = image.ext !== 'jpg' && hasTransparency(scaled)
    if (transparent && !needResize) return null
    const out = transparent ? scaled.toPNG() : scaled.toJPEG(quality)
    if (out.byteLength === 0) throw new Error('画像を書き出せませんでした')
    // 縮めたのに大きくなる（もともとよく圧縮されている）なら元を使う
    return out.byteLength < bytes.byteLength ? new Uint8Array(out) : null
  }
}
