import { describe, expect, it } from 'vitest'
import {
  createImageShrinker, jpegOrientation, JPEG_QUALITY, KEEP_AS_IS_BYTES, MAX_EDGE,
  type ImageFactory, type ImageHandle,
} from '../agent/shrink-image'
import { detectImage } from '../agent/media'

// 上げる前に画像を小さくする判断（長辺 640px・JPEG 品質 80・小さければそのまま・透過は PNG のまま…）。
// electron の nativeImage は偽物に差し替える（画素は持たない。大きさと透過の有無だけ）

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]

function filled(head: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(9)
  bytes.set(head.slice(0, size))
  return bytes
}
const jpegBytes = (size: number): Uint8Array => filled(JPEG_HEAD, size)
const pngBytes = (size: number): Uint8Array => filled(PNG_HEAD, size)

interface FakeOptions {
  width: number
  height: number
  transparent?: boolean
  /** 書き出す大きさ（既定は画素数に比例） */
  jpegSize?: (w: number, h: number) => number
  pngSize?: (w: number, h: number) => number
  empty?: boolean
}

function setup(opts: FakeOptions) {
  const log: string[] = []
  const decoded: Uint8Array[] = []
  function handle(width: number, height: number): ImageHandle {
    return {
      isEmpty: () => opts.empty === true,
      getSize: () => ({ width, height }),
      resize: (o) => {
        log.push(`resize ${o.width}x${o.height} ${o.quality}`)
        return handle(o.width ?? width, o.height ?? height)
      },
      toJPEG: (q) => {
        log.push(`toJPEG ${q}`)
        return jpegBytes((opts.jpegSize ?? ((w, h) => Math.floor(w * h / 8)))(width, height))
      },
      toPNG: () => {
        log.push('toPNG')
        return pngBytes((opts.pngSize ?? ((w, h) => Math.floor(w * h / 3)))(width, height))
      },
      toBitmap: () => {
        log.push('toBitmap')
        const bitmap = new Uint8Array(width * height * 4).fill(255)
        if (opts.transparent) bitmap[3] = 120 // 1 画素だけ透けている
        return bitmap
      },
    }
  }
  const factory: ImageFactory = {
    createFromBuffer: (buffer) => {
      decoded.push(new Uint8Array(buffer))
      log.push('createFromBuffer')
      return handle(opts.width, opts.height)
    },
  }
  return { log, decoded, shrink: createImageShrinker(factory) }
}

const JPG = { ext: 'jpg', mime: 'image/jpeg' }
const PNG = { ext: 'png', mime: 'image/png' }

// 本物の nativeImage が ImageFactory の形に合うこと（型検査で確かめる。electron は読み込まない）。
// service.ts は `createImageShrinker(nativeImage)` と渡すだけでよい
const asFactory = (native: typeof import('electron').nativeImage): ImageFactory => native

describe('定数', () => {
  it('electron の nativeImage をそのまま factory として渡せる形になっている（型）', () => {
    expect(asFactory).toBeTypeOf('function')
  })

  it('長辺 640px・品質 80・120KB', () => {
    expect(MAX_EDGE).toBe(640)
    expect(JPEG_QUALITY).toBe(80)
    expect(KEEP_AS_IS_BYTES).toBe(120 * 1024)
  })
})

describe('JPEG', () => {
  it('長辺が 640px より大きければ、比を保って長辺 640px に縮めて JPEG（品質 80）で返す', async () => {
    const original = jpegBytes(2_000_000)
    const { log, decoded, shrink } = setup({ width: 2000, height: 1500 })
    const out = await shrink(original, JPG)
    expect(out).not.toBeNull()
    expect(detectImage(out!)).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(out!.byteLength).toBe(Math.floor(640 * 480 / 8))
    expect(out!.byteLength).toBeLessThan(original.byteLength)
    expect(log).toEqual(['createFromBuffer', 'resize 640x480 good', 'toJPEG 80'])
    // 元のバイト列がそのまま読まれる（2MB の全要素比較は遅いので、大きさと先頭だけ）
    expect(decoded[0].byteLength).toBe(original.byteLength)
    expect(Array.from(decoded[0].subarray(0, 12))).toEqual(JPEG_HEAD)
  })

  it('縦長は高さを 640px に合わせる（長辺で決める）', async () => {
    const { log, shrink } = setup({ width: 1500, height: 2000 })
    await shrink(jpegBytes(2_000_000), JPG)
    expect(log).toContain('resize 480x640 good')
  })

  it('端数は四捨五入し、1px 未満にはならない（極端な縦横比）', async () => {
    const odd = setup({ width: 1001, height: 999 })
    await odd.shrink(jpegBytes(900_000), JPG)
    expect(odd.log).toContain('resize 640x639 good') // 999 * 640/1001 = 638.7…

    const thin = setup({ width: 10_000, height: 3 })
    await thin.shrink(jpegBytes(900_000), JPG)
    expect(thin.log).toContain('resize 640x1 good')
  })

  it('長辺がちょうど 640px で 120KB 以下なら、再圧縮せずそのまま（null）', async () => {
    const { log, shrink } = setup({ width: 640, height: 400 })
    expect(await shrink(jpegBytes(KEEP_AS_IS_BYTES), JPG)).toBeNull()
    expect(log).toEqual(['createFromBuffer']) // 縮めも書き出しもしない
  })

  it('長辺が 640px 以下でも 120KB を超えるなら、大きさはそのままで JPEG 品質 80 に再圧縮する', async () => {
    const { log, shrink } = setup({ width: 600, height: 600 })
    const out = await shrink(jpegBytes(KEEP_AS_IS_BYTES + 1), JPG)
    expect(out).not.toBeNull()
    expect(log).toEqual(['createFromBuffer', 'toJPEG 80'])
  })

  it('再圧縮の結果が元より大きい（同じ）なら、元を使う（null）', async () => {
    const bigger = setup({ width: 3000, height: 2000, jpegSize: () => 500_000 })
    expect(await bigger.shrink(jpegBytes(300_000), JPG)).toBeNull()

    const same = setup({ width: 3000, height: 2000, jpegSize: () => 300_000 })
    expect(await same.shrink(jpegBytes(300_000), JPG)).toBeNull()
  })

  it('向き（EXIF Orientation）が付いた JPEG は触らない（nativeImage で作り直すと向きが消えて横倒しになる）', async () => {
    const { log, shrink } = setup({ width: 4000, height: 3000 })
    expect(await shrink(jpegWithOrientation(6, false), JPG)).toBeNull()
    expect(log).toEqual([]) // 読みにもいかない
  })

  it('向きが 1（そのまま）と明記された JPEG は縮める', async () => {
    const { shrink } = setup({ width: 4000, height: 3000 })
    const out = await shrink(jpegWithOrientation(1, false, 900_000), JPG)
    expect(out).not.toBeNull()
  })
})

describe('PNG', () => {
  it('透過がなければ JPEG にして縮める（PNG の写真は JPEG の方がずっと小さい）', async () => {
    const { log, shrink } = setup({ width: 1600, height: 1200 })
    const out = await shrink(pngBytes(1_500_000), PNG)
    expect(out).not.toBeNull()
    expect(detectImage(out!)?.ext).toBe('jpg')
    expect(log).toEqual(['createFromBuffer', 'resize 640x480 good', 'toBitmap', 'toJPEG 80'])
  })

  it('透過があれば、長辺だけ縮めて PNG のまま返す（JPEG にすると背景が黒くなる）', async () => {
    const { log, shrink } = setup({ width: 1600, height: 1200, transparent: true })
    const out = await shrink(pngBytes(1_500_000), PNG)
    expect(out).not.toBeNull()
    expect(detectImage(out!)?.ext).toBe('png')
    expect(log).toEqual(['createFromBuffer', 'resize 640x480 good', 'toBitmap', 'toPNG'])
    expect(log).not.toContain('toJPEG 80')
  })

  it('透過があって、長辺が 640px 以下なら触らない（null）', async () => {
    const { log, shrink } = setup({ width: 500, height: 500, transparent: true })
    expect(await shrink(pngBytes(400_000), PNG)).toBeNull()
    expect(log).not.toContain('toPNG')
    expect(log).not.toContain('toJPEG 80')
  })

  it('小さい PNG（640px 以下・120KB 以下）はそのまま', async () => {
    const { log, shrink } = setup({ width: 300, height: 300 })
    expect(await shrink(pngBytes(50_000), PNG)).toBeNull()
    expect(log).toEqual(['createFromBuffer'])
  })

  it('縮めた結果が元より大きいなら、元を使う（null）', async () => {
    const { shrink } = setup({ width: 1600, height: 1200, transparent: true, pngSize: () => 2_000_000 })
    expect(await shrink(pngBytes(1_500_000), PNG)).toBeNull()
  })

  it('透過を調べられない（画素が取れない）ときは、JPEG にせず PNG の側に倒す', async () => {
    const factory: ImageFactory = {
      createFromBuffer: () => {
        const handle: ImageHandle = {
          isEmpty: () => false,
          getSize: () => ({ width: 1600, height: 1200 }),
          resize: () => handle,
          toJPEG: () => { throw new Error('JPEG にしてはいけない') },
          toPNG: () => pngBytes(100_000),
          toBitmap: () => new Uint8Array(0),
        }
        return handle
      },
    }
    const out = await createImageShrinker(factory)(pngBytes(1_500_000), PNG)
    expect(detectImage(out!)?.ext).toBe('png')
  })
})

describe('その他の形式・失敗', () => {
  it('GIF は触らない（動く画像かもしれない）。読みにもいかない', async () => {
    const { log, shrink } = setup({ width: 4000, height: 4000 })
    expect(await shrink(new Uint8Array(1_000_000).fill(1), { ext: 'gif', mime: 'image/gif' })).toBeNull()
    expect(log).toEqual([])
  })

  it('WebP・AVIF も、大きければ縮める（透過がなければ JPEG）', async () => {
    const { log, shrink } = setup({ width: 2000, height: 2000 })
    const out = await shrink(new Uint8Array(900_000).fill(1), { ext: 'webp', mime: 'image/webp' })
    expect(detectImage(out!)?.ext).toBe('jpg')
    expect(log).toEqual(['createFromBuffer', 'resize 640x640 good', 'toBitmap', 'toJPEG 80'])
  })

  it('読めない画像（デコードが空）は例外にする（media.ts が元のまま上げる）', async () => {
    const { shrink } = setup({ width: 0, height: 0, empty: true })
    await expect(Promise.resolve().then(() => shrink(jpegBytes(300_000), JPG))).rejects.toThrow('読み込めません')
  })

  it('大きさが 0 の画像は例外にする', async () => {
    const { shrink } = setup({ width: 0, height: 100 })
    await expect(Promise.resolve().then(() => shrink(jpegBytes(300_000), JPG))).rejects.toThrow('大きさ')
  })

  it('書き出しが空なら例外にする', async () => {
    const { shrink } = setup({ width: 3000, height: 2000, jpegSize: () => 0 })
    await expect(Promise.resolve().then(() => shrink(jpegBytes(300_000), JPG))).rejects.toThrow('書き出せません')
  })

  it('factory の例外はそのまま投げる', async () => {
    const shrink = createImageShrinker({ createFromBuffer: () => { throw new Error('native failure') } })
    await expect(Promise.resolve().then(() => shrink(jpegBytes(300_000), JPG))).rejects.toThrow('native failure')
  })

  it('Buffer の余りの領域ではなく、渡したバイト列の範囲だけを読む', async () => {
    const pool = new Uint8Array(400_000).fill(5)
    const original = pool.subarray(1000, 301_000)
    const seen: number[] = []
    const shrink = createImageShrinker({
      createFromBuffer: (buffer) => {
        seen.push(buffer.byteLength)
        throw new Error('stop')
      },
    })
    await expect(Promise.resolve().then(() => shrink(original, JPG))).rejects.toThrow('stop')
    expect(seen).toEqual([original.byteLength])
  })

  it('maxEdge・quality・keepBytes は差し替えられる', async () => {
    const log: string[] = []
    const factory: ImageFactory = {
      createFromBuffer: () => {
        const handle = (w: number, h: number): ImageHandle => ({
          isEmpty: () => false,
          getSize: () => ({ width: w, height: h }),
          resize: (o) => { log.push(`resize ${o.width}x${o.height}`); return handle(o.width!, o.height!) },
          toJPEG: (q) => { log.push(`toJPEG ${q}`); return jpegBytes(1000) },
          toPNG: () => pngBytes(1000),
          toBitmap: () => new Uint8Array(w * h * 4).fill(255),
        })
        return handle(1000, 500)
      },
    }
    await createImageShrinker(factory, { maxEdge: 200, quality: 60, keepBytes: 10 })(jpegBytes(50_000), JPG)
    expect(log).toEqual(['resize 200x100', 'toJPEG 60'])
  })
})

// --- JPEG の向き ---

/** APP1(Exif) に Orientation を持つ最小の JPEG。little: II（リトルエンディアン）／ false: MM */
function jpegWithOrientation(orientation: number, little: boolean, size = 400_000): Uint8Array {
  const u16 = (v: number): number[] => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff])
  const u32 = (v: number): number[] => (little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff])
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(1), // エントリ 1 つ
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u32(0),
  ]
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const length = exif.length + 2
  const head = [0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...exif, 0xff, 0xdb, 0, 4, 0, 0]
  const bytes = new Uint8Array(size).fill(9)
  bytes.set(head)
  return bytes
}

describe('jpegOrientation', () => {
  it('Exif の Orientation を読む（リトルエンディアン・ビッグエンディアンの両方）', () => {
    for (const little of [true, false]) {
      for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
        expect(jpegOrientation(jpegWithOrientation(o, little, 1000)), `${little ? 'II' : 'MM'} ${o}`).toBe(o)
      }
    }
  })

  it('Exif が無い・壊れている・JPEG でない・短すぎるなら 1（そのままの向き）', () => {
    expect(jpegOrientation(jpegBytes(1000))).toBe(1)
    expect(jpegOrientation(new Uint8Array([]))).toBe(1)
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8]))).toBe(1)
    expect(jpegOrientation(pngBytes(1000))).toBe(1)
    // 範囲外の値
    expect(jpegOrientation(jpegWithOrientation(9, true, 1000))).toBe(1)
    expect(jpegOrientation(jpegWithOrientation(0, false, 1000))).toBe(1)
    // 途中で切れている
    expect(jpegOrientation(jpegWithOrientation(6, true, 1000).subarray(0, 20))).toBe(1)
    expect(jpegOrientation(jpegWithOrientation(6, true, 1000).subarray(0, 12))).toBe(1)
  })

  it('Exif の前に別の APP セグメントがあっても読める', () => {
    const exifPart = jpegWithOrientation(8, false, 1000)
    // SOI のあとに JFIF(APP0: 長さ 16) を挟む
    const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
    const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...exifPart.subarray(2)])
    expect(jpegOrientation(bytes)).toBe(8)
  })
})
