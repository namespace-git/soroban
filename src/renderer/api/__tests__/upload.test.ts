// api/upload.ts：ファイルを選ぶ・縮める・Storage に上げる。ブラウザに触る部分（PickerEnv・ImageEnv）は偽物で回す
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { UploadKind, UploadTarget } from '../../../shared/web-types'
import {
  MAX_IMAGE_BYTES, RETURN_GRACE_MS, SHRINK, UPLOAD_TIMEOUT_MS, UploadError,
  createImageUploader, fitWithin, pickImageFile, shrinkImage,
} from '../upload'
import type { DecodedImage, ImageEnv, PickerEnv, PickerInput, StorageLike } from '../upload'

const jpg = (bytes = 1000, name = 'a.jpg') => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })

// ---------------- ファイルを選ぶ ----------------

function fakePicker() {
  const log: string[] = []
  const listeners: Record<string, Array<() => void>> = {}
  let files: File[] | null = null
  const input: PickerInput = {
    get files() { return files },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); log.push(`listen:${type}`) },
    click() { log.push('click') },
    remove() { log.push('remove') },
  }
  let onReturn: (() => void) | null = null
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 1
  const env: PickerEnv = {
    createInput: () => { log.push('create'); return input },
    watchReturn: (cb) => { onReturn = cb; log.push('watch'); return () => { onReturn = null; log.push('unwatch') } },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { timers.delete(id as number) },
  }
  return {
    env, log, timers,
    choose(f: File) { files = [f]; listeners.change?.forEach(fn => fn()) },
    cancel() { listeners.cancel?.forEach(fn => fn()) },
    windowReturned() { onReturn?.() },
    runTimers() { [...timers.values()].forEach(t => t.fn()) },
  }
}

describe('pickImageFile', () => {
  it('呼んだその場で（await より前に）click する。input は選び終わったら外す', async () => {
    const p = fakePicker()
    const result = pickImageFile(p.env)
    // ここまで await を一度も挟んでいない
    expect(p.log).toEqual(['create', 'listen:change', 'listen:cancel', 'watch', 'click'])
    const f = jpg()
    p.choose(f)
    expect(await result).toBe(f)
    expect(p.log.slice(-2)).toEqual(['unwatch', 'remove'])
  })

  it('cancel（選ばずに閉じた）は null', async () => {
    const p = fakePicker()
    const result = pickImageFile(p.env)
    p.cancel()
    expect(await result).toBeNull()
    expect(p.log.slice(-2)).toEqual(['unwatch', 'remove'])
  })

  it('cancel を出さないブラウザ：窓が戻って待っても change が来なければ null', async () => {
    const p = fakePicker()
    const result = pickImageFile(p.env)
    p.windowReturned()
    expect([...p.timers.values()].map(t => t.ms)).toEqual([RETURN_GRACE_MS])
    p.runTimers()
    expect(await result).toBeNull()
  })

  it('窓が戻ったあとに change が来たら、待ちを捨てて選んだファイルを返す', async () => {
    const p = fakePicker()
    const result = pickImageFile(p.env)
    p.windowReturned()
    const f = jpg()
    p.choose(f)
    expect(p.timers.size).toBe(0)
    expect(await result).toBe(f)
  })

  it('二重に終わらない（change のあとの cancel は無視）', async () => {
    const p = fakePicker()
    const result = pickImageFile(p.env)
    const f = jpg()
    p.choose(f)
    p.cancel()
    expect(await result).toBe(f)
    expect(p.log.filter(l => l === 'remove')).toHaveLength(1)
  })
})

// ---------------- 縮める ----------------

function fakeImageEnv(dim = { width: 4000, height: 3000 }, over: Partial<ImageEnv> = {}) {
  const closed: number[] = []
  const encoded: Array<{ width: number; height: number; quality: number }> = []
  const env: Pick<ImageEnv, 'decode' | 'encodeJpeg'> = {
    decode: async () => {
      const img: DecodedImage = { ...dim, source: {} as CanvasImageSource, close: () => { closed.push(1) } }
      return img
    },
    encodeJpeg: async (_img, width, height, quality) => {
      encoded.push({ width, height, quality })
      return new Blob([new Uint8Array(500)], { type: 'image/jpeg' })
    },
    ...over,
  }
  return { env, closed, encoded }
}

describe('fitWithin（長辺に収める）', () => {
  it.each([
    [4000, 3000, 2000, 2000, 1500],
    [3000, 4000, 2000, 1500, 2000],
    [4032, 3024, 1200, 1200, 900],
    [1000, 800, 2000, 1000, 800], // 小さいものは拡大しない
    [2000, 1000, 2000, 2000, 1000], // ちょうどは変えない
    [10000, 10, 2000, 2000, 2], // 細長くても 1px 以上の整数
    [10000, 1, 2000, 2000, 1],
    [3, 3000, 1200, 1, 1200],
  ])('%i×%i を長辺 %i → %i×%i', (w, h, edge, ew, eh) => {
    expect(fitWithin(w, h, edge)).toEqual({ width: ew, height: eh })
  })
})

describe('shrinkImage', () => {
  it('レシートは長辺 2,000px・品質 0.85。EXIF の向きを反映した後の寸法で計算する', async () => {
    const { env, encoded, closed } = fakeImageEnv({ width: 3024, height: 4032 }) // 縦長（向き反映後）
    const blob = await shrinkImage(jpg(), 'receipt', env)
    expect(blob.type).toBe('image/jpeg')
    expect(encoded).toEqual([{ width: 1500, height: 2000, quality: 0.85 }])
    expect(closed).toHaveLength(1)
  })

  it('商品画像は長辺 1,200px・品質 0.85', async () => {
    const { env, encoded } = fakeImageEnv({ width: 4032, height: 3024 })
    await shrinkImage(jpg(), 'product', env)
    expect(encoded).toEqual([{ width: 1200, height: 900, quality: 0.85 }])
    expect(SHRINK).toEqual({ receipt: { longEdge: 2000, quality: 0.85 }, product: { longEdge: 1200, quality: 0.85 } })
  })

  it('10MB を超える画像は読み込む前に断る', async () => {
    const decode = vi.fn()
    const { env } = fakeImageEnv(undefined, { decode })
    await expect(shrinkImage(jpg(MAX_IMAGE_BYTES + 1), 'receipt', env)).rejects.toThrow('画像が大きすぎます（10MB まで）')
    expect(decode).not.toHaveBeenCalled()
    // ちょうど 10MB は通す
    await expect(shrinkImage(jpg(MAX_IMAGE_BYTES), 'receipt', fakeImageEnv().env)).resolves.toBeInstanceOf(Blob)
  })

  it('読めない形式（HEIC を読めないブラウザなど）は、日本語のエラー', async () => {
    const { env } = fakeImageEnv(undefined, { decode: async () => { throw new Error('InvalidStateError') } })
    const e = await shrinkImage(jpg(1000, 'a.heic'), 'receipt', env).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UploadError)
    expect((e as Error).message).toBe('この形式の画像は読めません。JPEG か PNG で選んでください')
  })

  it('空のファイル・寸法が 0 の画像も同じ「読めません」。読み込んだものは必ず閉じる', async () => {
    await expect(shrinkImage(jpg(0), 'receipt', fakeImageEnv().env)).rejects.toThrow('この形式の画像は読めません')
    const zero = fakeImageEnv({ width: 0, height: 100 })
    await expect(shrinkImage(jpg(), 'receipt', zero.env)).rejects.toThrow('この形式の画像は読めません')
    expect(zero.closed).toHaveLength(1)
  })

  it('JPEG にできなかったとき（null・例外）は日本語のエラーで、閉じる', async () => {
    const a = fakeImageEnv(undefined, { encodeJpeg: async () => null })
    await expect(shrinkImage(jpg(), 'receipt', a.env)).rejects.toThrow('画像を縮められませんでした')
    expect(a.closed).toHaveLength(1)
    const b = fakeImageEnv(undefined, { encodeJpeg: async () => { throw new Error('x') } })
    await expect(shrinkImage(jpg(), 'receipt', b.env)).rejects.toThrow('画像を縮められませんでした')
  })

  it('縮めたあとが 10MB を超えるなら断る', async () => {
    const big = fakeImageEnv(undefined, { encodeJpeg: async () => new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)]) })
    await expect(shrinkImage(jpg(), 'receipt', big.env)).rejects.toThrow('画像が大きすぎます')
  })
})

// ---------------- 上げる ----------------

function fakeStorage(result: { error: unknown } | (() => Promise<{ error: unknown }>) = { error: null }) {
  const uploads: Array<{ bucket: string; path: string; body: Blob; options: unknown }> = []
  const removed: Array<{ bucket: string; paths: string[] }> = []
  let removeError: unknown = null
  const storage: StorageLike = {
    from: (bucket) => ({
      upload: async (path, body, options) => {
        uploads.push({ bucket, path, body, options })
        return (typeof result === 'function' ? await result() : result) as { error: null }
      },
      remove: async (paths) => {
        removed.push({ bucket, paths })
        if (removeError) throw removeError
        return { error: null }
      },
    }),
  }
  return { storage, uploads, removed, failRemove() { removeError = new Error('denied') } }
}

function pickingEnv(file: File | null, dim = { width: 4000, height: 3000 }) {
  const calls: string[] = []
  const inner = fakeImageEnv(dim)
  const env: ImageEnv = {
    pickFile: () => { calls.push('pick'); return Promise.resolve(file) },
    ...inner.env,
  }
  return { env, calls, closed: inner.closed, encoded: inner.encoded }
}

const target = (kind: UploadKind, ext = 'jpg'): UploadTarget => kind === 'receipt'
  ? { bucket: 'receipts', path: `hh-1/receipt/abc.${ext}` }
  : { bucket: 'media', path: `hh-1/product/abc.${ext}` }

describe('createImageUploader', () => {
  it('pickAndUpload は呼んだその場でファイル選択を開く（await の前）', () => {
    const { env, calls } = pickingEnv(jpg())
    const up = createImageUploader(fakeStorage().storage, env)
    void up.pickAndUpload('receipt', async (k) => target(k))
    expect(calls).toEqual(['pick'])
  })

  it('選ばなければ null：縮めない・置き場所ももらわない・何も上げない', async () => {
    const { env, encoded } = pickingEnv(null)
    const s = fakeStorage()
    const prepare = vi.fn()
    expect(await createImageUploader(s.storage, env).pickAndUpload('receipt', prepare)).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
    expect(encoded).toEqual([])
    expect(s.uploads).toEqual([])
  })

  it('縮めた JPEG を prepareUpload の戻りの bucket / path にそのまま上げる（upsert なし・image/jpeg）', async () => {
    const { env, encoded } = pickingEnv(jpg())
    const s = fakeStorage()
    const prepare = vi.fn(async (k: UploadKind) => target(k))
    const got = await createImageUploader(s.storage, env).pickAndUpload('receipt', prepare)
    expect(prepare).toHaveBeenCalledWith('receipt', 'jpg')
    expect(got).toEqual({ bucket: 'receipts', path: 'hh-1/receipt/abc.jpg' })
    expect(encoded).toEqual([{ width: 2000, height: 1500, quality: 0.85 }])
    expect(s.uploads).toHaveLength(1)
    expect(s.uploads[0]).toMatchObject({
      bucket: 'receipts', path: 'hh-1/receipt/abc.jpg', options: { contentType: 'image/jpeg', upsert: false },
    })
    expect(s.uploads[0].body.size).toBe(500)
  })

  it('商品画像は media に、長辺 1,200px で', async () => {
    const { env, encoded } = pickingEnv(jpg())
    const s = fakeStorage()
    const got = await createImageUploader(s.storage, env).pickAndUpload('product', async (k) => target(k))
    expect(got).toEqual({ bucket: 'media', path: 'hh-1/product/abc.jpg' })
    expect(s.uploads[0].bucket).toBe('media')
    expect(encoded[0]).toEqual({ width: 1200, height: 900, quality: 0.85 })
  })

  it('読めない画像・大きすぎる画像では、置き場所をもらわない', async () => {
    const prepare = vi.fn()
    const big = pickingEnv(jpg(MAX_IMAGE_BYTES + 1))
    await expect(createImageUploader(fakeStorage().storage, big.env).pickAndUpload('receipt', prepare)).rejects.toThrow('10MB')
    const bad = pickingEnv(jpg())
    bad.env.decode = async () => { throw new Error('x') }
    await expect(createImageUploader(fakeStorage().storage, bad.env).pickAndUpload('receipt', prepare)).rejects.toThrow('読めません')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('prepareUpload の失敗はそのまま投げる（何も上げない）', async () => {
    const { env } = pickingEnv(jpg())
    const s = fakeStorage()
    await expect(createImageUploader(s.storage, env).pickAndUpload('receipt', async () => { throw new Error('ログインが必要です') }))
      .rejects.toThrow('ログインが必要です')
    expect(s.uploads).toEqual([])
  })

  it('レシートが公開の media に行く・商品画像が receipts に行くような置き場所は断る（上げない）', async () => {
    const { env } = pickingEnv(jpg())
    const s = fakeStorage()
    const up = createImageUploader(s.storage, env)
    await expect(up.pickAndUpload('receipt', async () => ({ bucket: 'media', path: 'hh-1/receipt/x.jpg' }))).rejects.toThrow('置き場所を正しく受け取れません')
    await expect(up.pickAndUpload('product', async () => ({ bucket: 'receipts', path: 'hh-1/product/x.jpg' }))).rejects.toThrow('置き場所')
    await expect(up.pickAndUpload('receipt', async () => ({ bucket: 'receipts', path: '' }))).rejects.toThrow('置き場所')
    await expect(up.pickAndUpload('receipt', async () => ({ bucket: 'receipts', path: 'hh-1/../hh-2/x.jpg' }))).rejects.toThrow('置き場所')
    expect(s.uploads).toEqual([])
  })

  describe('Storage の失敗は日本語のエラー', () => {
    const run = (error: unknown) => {
      const { env } = pickingEnv(jpg())
      return createImageUploader(fakeStorage({ error }).storage, env).pickAndUpload('receipt', async (k) => target(k))
    }

    it('権限（RLS）', async () => {
      await expect(run({ message: 'new row violates row-level security policy', statusCode: '403' })).rejects.toThrow('画像を上げる権限がありません')
    })

    it('大きすぎる（413）', async () => {
      await expect(run({ message: 'The object exceeded the maximum allowed size', statusCode: '413' })).rejects.toThrow('画像が大きすぎて上げられませんでした')
    })

    it('それ以外（Failed to fetch など）は英語の生のメッセージを出さない', async () => {
      const e = await run({ message: 'Failed to fetch' }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(UploadError)
      expect((e as Error).message).toBe('画像を上げられませんでした。通信の状態を確かめて、もう一度お試しください')
    })

    it('upload が例外を投げても同じ', async () => {
      const { env } = pickingEnv(jpg())
      const s = fakeStorage(async () => { throw new TypeError('Load failed') })
      await expect(createImageUploader(s.storage, env).pickAndUpload('receipt', async (k) => target(k))).rejects.toThrow('画像を上げられませんでした')
    })
  })

  describe('上げるのに時間がかかりすぎたとき', () => {
    afterEach(() => { vi.useRealTimers() })

    it('上限（90 秒）で日本語のエラーにして、固まったままにしない', async () => {
      vi.useFakeTimers()
      const { env } = pickingEnv(jpg())
      const s = fakeStorage(() => new Promise(() => {}))
      const p = createImageUploader(s.storage, env).pickAndUpload('receipt', async (k) => target(k))
      const assertion = expect(p).rejects.toThrow('時間がかかっています')
      await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS + 1)
      await assertion
    })

    it('間に合えば何も起きない（タイマーも残らない）', async () => {
      vi.useFakeTimers()
      const { env } = pickingEnv(jpg())
      const s = fakeStorage()
      const p = createImageUploader(s.storage, env).pickAndUpload('receipt', async (k) => target(k))
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toEqual(target('receipt'))
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('discard：上げたものを消す。消せなくても投げない', async () => {
    const s = fakeStorage()
    const up = createImageUploader(s.storage, pickingEnv(null).env)
    await up.discard(target('receipt'))
    expect(s.removed).toEqual([{ bucket: 'receipts', paths: ['hh-1/receipt/abc.jpg'] }])
    s.failRemove()
    await expect(up.discard(target('receipt'))).resolves.toBeUndefined()
  })
})
