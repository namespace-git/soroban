import { describe, expect, it } from 'vitest'
import { createMediaUploader, detectImage, type MediaCredentials } from '../agent/media'
import type { FetchFn } from '../agent/http'
import type { ImageShrinker } from '../agent/shrink-image'

// 画像を Supabase Storage の media バケットに上げる：パスの形（<世帯の id>/<種類>/<乱数>.<拡張子>）、
// 人の JWT ＋ anon キー、画像かどうかの確認、失敗の扱い。偽の fetch だけを使う

const HOUSEHOLD = '22222222-2222-4222-8222-222222222222'
const CREDS: MediaCredentials = { accessToken: `eyJ.${'t'.repeat(60)}.sig`, supabaseUrl: 'https://abcd.supabase.co', anonKey: `anon-${'k'.repeat(40)}` }

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
const HTML = new TextEncoder().encode('<!doctype html><html>ログインしてください</html>')

interface Put { url: string; headers: Record<string, string>; body: Uint8Array; init: RequestInit }

function setup(opts: {
  respond?: (n: number) => Response | Error
  files?: Record<string, Uint8Array>
  creds?: MediaCredentials | null
  shrink?: ImageShrinker
  log?: (message: string) => void
} = {}) {
  const puts: Put[] = []
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003']
  let idIndex = 0
  const fetch: FetchFn = async (url, init) => {
    puts.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array, init })
    const r = opts.respond ? opts.respond(puts.length) : new Response('{}', { status: 200 })
    if (r instanceof Error) throw r
    return r
  }
  const uploader = createMediaUploader({
    householdId: HOUSEHOLD,
    credentials: () => (opts.creds === undefined ? CREDS : opts.creds),
    fetch,
    readFile: async (file) => {
      const bytes = opts.files?.[file]
      if (!bytes) throw new Error('ENOENT')
      return bytes
    },
    randomId: () => ids[idIndex++ % ids.length],
    shrink: opts.shrink,
    log: opts.log,
  })
  return { puts, uploader }
}

/** 先頭が JPEG で、指定の大きさ（バイト）の画像 */
function jpegOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(7)
  bytes.set(JPEG)
  return bytes
}

/** 先頭が PNG で、指定の大きさ（バイト）の画像 */
function pngOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(7)
  bytes.set(PNG)
  return bytes
}

describe('detectImage：先頭のバイトで画像の種類を決める', () => {
  it('jpeg・png・gif・webp・avif を見分ける。HTML などは null', () => {
    expect(detectImage(JPEG)).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(detectImage(PNG)).toEqual({ ext: 'png', mime: 'image/png' })
    expect(detectImage(GIF)).toEqual({ ext: 'gif', mime: 'image/gif' })
    expect(detectImage(WEBP)).toEqual({ ext: 'webp', mime: 'image/webp' })
    expect(detectImage(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toEqual({ ext: 'avif', mime: 'image/avif' })
    expect(detectImage(HTML)).toBeNull()
    expect(detectImage(new Uint8Array([]))).toBeNull()
    expect(detectImage(new Uint8Array([0xff, 0xd8]))).toBeNull()
  })
})

describe('画像を Storage に上げる', () => {
  it('<世帯の id>/<種類>/<乱数>.<拡張子> のパスに、人の JWT ＋ anon キーで上げ、パスを返す', async () => {
    const { puts, uploader } = setup({ files: { 'm123-ab12cd34.jpg': JPEG } })
    const path = await uploader.upload('sale', 'm123-ab12cd34.jpg')
    expect(path).toBe(`${HOUSEHOLD}/sale/aaaaaaaa-0000-4000-8000-000000000001.jpg`)
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe(`https://abcd.supabase.co/storage/v1/object/media/${path}`)
    expect(puts[0].init.method).toBe('POST')
    expect(puts[0].headers.Authorization).toBe(`Bearer ${CREDS.accessToken}`)
    expect(puts[0].headers.apikey).toBe(CREDS.anonKey)
    expect(puts[0].headers['Content-Type']).toBe('image/jpeg')
    expect(puts[0].headers['x-upsert']).toBe('false')
    expect(puts[0].body).toEqual(JPEG)
    expect(puts[0].init.redirect).toBe('error')
  })

  it('種類は sale・listing・purchase-line。拡張子は中身で決める（ファイル名の拡張子は信用しない）', async () => {
    const { uploader } = setup({ files: { 'a.jpg': PNG, 'b.png': WEBP, 'c.php': GIF } })
    expect(await uploader.upload('listing', 'a.jpg')).toMatch(new RegExp(`^${HOUSEHOLD}/listing/[^/]+\\.png$`))
    expect(await uploader.upload('purchase-line', 'b.png')).toMatch(new RegExp(`^${HOUSEHOLD}/purchase-line/[^/]+\\.webp$`))
    expect(await uploader.upload('sale', 'c.php')).toMatch(/\.gif$/)
  })

  it('画像でないファイル（HTML のエラーページ）・空・大きすぎるものは上げない（通信もしない）', async () => {
    const { puts, uploader } = setup({ files: { 'x.jpg': HTML, 'empty.jpg': new Uint8Array([]), 'big.jpg': new Uint8Array(9 * 1024 * 1024).fill(0xff) } })
    await expect(uploader.upload('sale', 'x.jpg')).rejects.toThrow('画像の形式')
    await expect(uploader.upload('sale', 'empty.jpg')).rejects.toThrow('サイズ')
    await expect(uploader.upload('sale', 'big.jpg')).rejects.toThrow('サイズ')
    expect(puts).toHaveLength(0)
  })

  it('上限は Storage の media バケットと同じ 5MB：ちょうど 5MB は上げ、1 バイトでも超えたら送らない', async () => {
    const LIMIT = 5 * 1024 * 1024
    const sized = (n: number): Uint8Array => {
      const bytes = new Uint8Array(n)
      bytes.set(JPEG) // 先頭は JPEG（画像として読める形）
      return bytes
    }
    const ok = setup({ files: { 'edge.jpg': sized(LIMIT) } })
    await expect(ok.uploader.upload('sale', 'edge.jpg')).resolves.toMatch(/\.jpg$/)
    expect(ok.puts).toHaveLength(1)

    const over = setup({ files: { 'over.jpg': sized(LIMIT + 1) } })
    await expect(over.uploader.upload('sale', 'over.jpg')).rejects.toThrow('サイズ')
    expect(over.puts).toHaveLength(0)
  })

  it('ファイル名にパス区切り・.. ・変な文字があれば読まずに断る', async () => {
    const { puts, uploader } = setup({ files: { 'a.jpg': JPEG } })
    for (const bad of ['../a.jpg', 'a/b.jpg', 'a\\b.jpg', '..', '.hidden.jpg', '', 'a b.jpg', 'a..b.jpg']) {
      await expect(uploader.upload('sale', bad), bad).rejects.toThrow('ファイル名')
    }
    expect(puts).toHaveLength(0)
  })

  it('ファイルが無ければ投げる（収集のコードがその画像を飛ばす）', async () => {
    const { puts, uploader } = setup({ files: {} })
    await expect(uploader.upload('sale', 'gone.jpg')).rejects.toThrow()
    expect(puts).toHaveLength(0)
  })

  it('Web 版のログインが届いていない（資格が無い）なら上げない', async () => {
    const { puts, uploader } = setup({ files: { 'a.jpg': JPEG }, creds: null })
    await expect(uploader.upload('sale', 'a.jpg')).rejects.toThrow('ログイン')
    expect(puts).toHaveLength(0)
  })

  it('4xx（権限・重複など）はやり直さず、日本語のエラーにする（JWT は文言に出さない）', async () => {
    const { puts, uploader } = setup({ files: { 'a.jpg': JPEG }, respond: () => new Response('{"error":"nope"}', { status: 403 }) })
    const err = await uploader.upload('sale', 'a.jpg').catch(e => e)
    expect(err.message).toContain('画像を上げられませんでした')
    expect(err.message).not.toContain(CREDS.accessToken)
    expect(puts).toHaveLength(1)
  })

  it('5xx・通信切れは、別のパスで 1 度だけやり直す。それでも失敗なら投げる', async () => {
    const flaky = setup({
      files: { 'a.jpg': JPEG },
      respond: n => (n === 1 ? new Response('', { status: 503 }) : new Response('{}', { status: 200 })),
    })
    const path = await flaky.uploader.upload('sale', 'a.jpg')
    expect(flaky.puts).toHaveLength(2)
    expect(path).toContain('aaaaaaaa-0000-4000-8000-000000000002') // 2 回目のパス
    expect(flaky.puts[0].url).not.toBe(flaky.puts[1].url)

    const down = setup({ files: { 'a.jpg': JPEG }, respond: () => new TypeError('fetch failed') })
    const err = await down.uploader.upload('sale', 'a.jpg').catch(e => e)
    expect(down.puts).toHaveLength(2)
    expect(err.message).toContain('通信')
    expect(err.message).not.toContain('fetch failed')
  })

  it('remove：自分の世帯のパスを DELETE で消す（人の JWT ＋ anon キー）', async () => {
    const { puts, uploader } = setup()
    const path = `${HOUSEHOLD}/sale/aaaaaaaa-0000-4000-8000-000000000001.jpg`
    await uploader.remove(path)
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe(`https://abcd.supabase.co/storage/v1/object/media/${path}`)
    expect(puts[0].init.method).toBe('DELETE')
    expect(puts[0].headers.Authorization).toBe(`Bearer ${CREDS.accessToken}`)
    expect(puts[0].headers.apikey).toBe(CREDS.anonKey)
    expect(puts[0].init.redirect).toBe('error')
  })

  it('remove：消せなくても例外にしない（4xx・5xx・通信切れ）。他の世帯・.. のパス・資格なしは通信しない', async () => {
    const path = `${HOUSEHOLD}/sale/aaaaaaaa-0000-4000-8000-000000000001.jpg`
    for (const respond of [() => new Response('', { status: 403 }), () => new Response('', { status: 500 }), () => new TypeError('fetch failed')]) {
      const { puts, uploader } = setup({ respond })
      await expect(uploader.remove(path)).resolves.toBeUndefined()
      expect(puts).toHaveLength(1)
    }

    const { puts, uploader } = setup()
    await uploader.remove('33333333-3333-4333-8333-333333333333/sale/x.jpg')
    await uploader.remove(`${HOUSEHOLD}/../other/x.jpg`)
    await uploader.remove('')
    expect(puts).toHaveLength(0)

    const noCreds = setup({ creds: null })
    await expect(noCreds.uploader.remove(path)).resolves.toBeUndefined()
    expect(noCreds.puts).toHaveLength(0)
  })

  it('世帯の id が UUID でなければ作れない', () => {
    expect(() => createMediaUploader({
      householdId: 'x', credentials: () => CREDS, fetch: async () => new Response('{}'), readFile: async () => JPEG, randomId: () => 'aaaaaaaa',
    })).toThrow('世帯')
  })
})

describe('上げる前に画像を縮める（shrink）', () => {
  it('縮められたら、縮めたものを JPEG として上げる（元は送らない）。shrink には元のバイト列と形式が渡る', async () => {
    const original = jpegOf(2_000_000)
    const small = jpegOf(40_000)
    const calls: Array<{ bytes: Uint8Array; image: { ext: string; mime: string } }> = []
    const { puts, uploader } = setup({
      files: { 'big.jpg': original },
      shrink: (bytes, image) => { calls.push({ bytes, image }); return small },
    })
    const path = await uploader.upload('sale', 'big.jpg')
    expect(calls).toHaveLength(1)
    expect(calls[0].bytes).toBe(original)
    expect(calls[0].image).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(path).toBe(`${HOUSEHOLD}/sale/aaaaaaaa-0000-4000-8000-000000000001.jpg`)
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toBe(small)
    expect(puts[0].body.byteLength).toBe(40_000)
    expect(puts[0].headers['Content-Type']).toBe('image/jpeg')
    expect(puts[0].headers['cache-control']).toBe('max-age=31536000')
    expect(puts[0].headers['x-upsert']).toBe('false')
  })

  it('非同期の shrink でもよい', async () => {
    const small = jpegOf(30_000)
    const { puts, uploader } = setup({ files: { 'a.jpg': jpegOf(500_000) }, shrink: async () => small })
    await uploader.upload('listing', 'a.jpg')
    expect(puts[0].body).toBe(small)
  })

  it('PNG が JPEG になって返ったら、パスの拡張子も Content-Type も JPEG になる（ファイル名や元の形式ではなく、上げる中身で決める）', async () => {
    const { puts, uploader } = setup({ files: { 'shot.png': pngOf(900_000) }, shrink: () => jpegOf(60_000) })
    const path = await uploader.upload('purchase-line', 'shot.png')
    expect(path).toMatch(new RegExp(`^${HOUSEHOLD}/purchase-line/[^/]+\\.jpg$`))
    expect(puts[0].headers['Content-Type']).toBe('image/jpeg')
  })

  it('PNG が PNG のまま縮んで返ったら、.png と image/png のまま', async () => {
    const { puts, uploader } = setup({ files: { 'logo.png': pngOf(900_000) }, shrink: () => pngOf(120_000) })
    const path = await uploader.upload('sale', 'logo.png')
    expect(path).toMatch(/\.png$/)
    expect(puts[0].headers['Content-Type']).toBe('image/png')
    expect(puts[0].body.byteLength).toBe(120_000)
  })

  it('縮めなくてよい（null）なら、元のまま上げる（小さい JPEG・GIF など）', async () => {
    const small = jpegOf(50_000)
    const { puts, uploader } = setup({ files: { 'a.jpg': small, 'g.gif': GIF }, shrink: () => null })
    expect(await uploader.upload('sale', 'a.jpg')).toMatch(/\.jpg$/)
    expect(await uploader.upload('sale', 'g.gif')).toMatch(/\.gif$/)
    expect(puts[0].body).toBe(small)
    expect(puts[1].body).toBe(GIF)
    expect(puts[1].headers['Content-Type']).toBe('image/gif')
  })

  it('縮めた結果が元と同じか大きいなら、元を使う（空も同じ）', async () => {
    const original = jpegOf(100_000)
    for (const shrunk of [jpegOf(100_001), jpegOf(100_000), jpegOf(250_000), new Uint8Array([])]) {
      const { puts, uploader } = setup({ files: { 'a.jpg': original }, shrink: () => shrunk })
      await uploader.upload('sale', 'a.jpg')
      expect(puts[0].body, String(shrunk.byteLength)).toBe(original)
      expect(puts[0].headers['Content-Type']).toBe('image/jpeg')
    }
  })

  it('縮められなかった（例外）ときは、元のまま上げて続ける。ログには原因だけで、中身・パス・トークンを出さない', async () => {
    const original = jpegOf(300_000)
    const logs: string[] = []
    const { puts, uploader } = setup({
      files: { 'm123-ab12cd34.jpg': original },
      shrink: () => { throw new Error('画像を読み込めませんでした') },
      log: m => logs.push(m),
    })
    const path = await uploader.upload('sale', 'm123-ab12cd34.jpg')
    expect(path).toMatch(/\.jpg$/)
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toBe(original)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('元のまま')
    expect(logs[0]).toContain('画像を読み込めませんでした')
    for (const secret of [CREDS.accessToken, CREDS.anonKey, 'm123-ab12cd34', 'supabase.co', HOUSEHOLD]) {
      expect(logs[0]).not.toContain(secret)
    }
  })

  it('shrink が Error でないものを投げても、非同期で失敗しても、元のまま上げる', async () => {
    const original = jpegOf(300_000)
    const logs: string[] = []
    const a = setup({ files: { 'a.jpg': original }, shrink: () => { throw 'boom' }, log: m => logs.push(m) })
    await a.uploader.upload('sale', 'a.jpg')
    expect(a.puts[0].body).toBe(original)
    const b = setup({ files: { 'a.jpg': original }, shrink: async () => { throw new Error('native failure') }, log: m => logs.push(m) })
    await b.uploader.upload('sale', 'a.jpg')
    expect(b.puts[0].body).toBe(original)
    expect(logs).toHaveLength(2)
  })

  it('縮めた結果が画像として読めない（壊れている）ときも、元のまま上げる', async () => {
    const original = jpegOf(300_000)
    const logs: string[] = []
    const { puts, uploader } = setup({
      files: { 'a.jpg': original },
      shrink: () => new Uint8Array(1000).fill(3), // 画像の先頭ではない
      log: m => logs.push(m),
    })
    await uploader.upload('sale', 'a.jpg')
    expect(puts[0].body).toBe(original)
    expect(logs).toHaveLength(1)
  })

  it('log が例外を投げても、上げるのは続ける', async () => {
    const original = jpegOf(300_000)
    const { puts, uploader } = setup({
      files: { 'a.jpg': original },
      shrink: () => { throw new Error('x') },
      log: () => { throw new Error('log failed') },
    })
    await expect(uploader.upload('sale', 'a.jpg')).resolves.toMatch(/\.jpg$/)
    expect(puts[0].body).toBe(original)
  })

  it('5xx のやり直しでは、縮め直さず同じ縮めたものを別のパスで送る', async () => {
    const small = jpegOf(30_000)
    let calls = 0
    const { puts, uploader } = setup({
      files: { 'a.jpg': jpegOf(800_000) },
      shrink: () => { calls++; return small },
      respond: n => (n === 1 ? new Response('', { status: 503 }) : new Response('{}', { status: 200 })),
    })
    const path = await uploader.upload('sale', 'a.jpg')
    expect(calls).toBe(1)
    expect(puts).toHaveLength(2)
    expect(puts[0].body).toBe(small)
    expect(puts[1].body).toBe(small)
    expect(path).toContain('aaaaaaaa-0000-4000-8000-000000000002')
  })

  it('画像でない・空・大きすぎるファイルは、縮める前に断る（shrink は呼ばない）', async () => {
    let calls = 0
    const { puts, uploader } = setup({
      files: { 'x.jpg': HTML, 'empty.jpg': new Uint8Array([]), 'big.jpg': new Uint8Array(9 * 1024 * 1024).fill(0xff) },
      shrink: () => { calls++; return null },
    })
    await expect(uploader.upload('sale', 'x.jpg')).rejects.toThrow('画像の形式')
    await expect(uploader.upload('sale', 'empty.jpg')).rejects.toThrow('サイズ')
    await expect(uploader.upload('sale', 'big.jpg')).rejects.toThrow('サイズ')
    expect(calls).toBe(0)
    expect(puts).toHaveLength(0)
  })

  it('shrink を渡さなければ縮めない（元のまま）', async () => {
    const original = jpegOf(300_000)
    const { puts, uploader } = setup({ files: { 'a.jpg': original } })
    await uploader.upload('sale', 'a.jpg')
    expect(puts[0].body).toBe(original)
  })
})
