import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  contentTypeOf, encodeObjectPath, extensionOf, folderImageSource, isPlainFileName, normalizeSupabaseUrl, planImages,
  removeUploaded, SupabaseStorageUploader, uploadImages,
} from '../../../tools/migrate-to-web/images'
import { memoryImages, recordingUploader, sequentialIds } from './helpers'

// 画像の対応表（元のファイル → 新しいパス）と、Supabase Storage の REST。実際の通信はしない（fetch は偽物）

/** 失敗するはずの処理のエラーを返す（失敗しなければテストが落ちる） */
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run
  } catch (e) {
    return e as Error
  }
  throw new Error('失敗するはずが成功しました')
}

const HH = '11111111-2222-4333-8444-555555555555'
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ.SIGNATURE-SECRET-PART'
const ANON = 'sb_publishable_ANON-KEY-VALUE'

describe('画像の対応表', () => {
  const tables = {
    sale: [{ id: 's1', thumb_file: 'm100.jpg' }, { id: 's2', thumb_file: null }, { id: 's3', thumb_file: 'm300.JPG' }],
    listing: [{ mercari_item_id: 'm100', thumb_file: 'm100.jpg' }], // 販売と同じファイルを指している
    purchase_line: [{ id: 'p1', image_file: 'pl.png' }, { id: 'p2', image_file: '' }],
    product_image: [{ model_code: 'A037', file: 'product-A037.webp' }],
    expense: [{ id: 'e1', receipt_file: 'receipt-e1.jpeg' }],
  }
  const files = { 'm100.jpg': 10, 'm300.JPG': 20, 'pl.png': 30, 'product-A037.webp': 40, 'receipt-e1.jpeg': 50 }

  it('参照ごとに別のパスを決める（同じファイルを複数の行が指していても共有しない）', async () => {
    const plan = await planImages({ tables }, HH, memoryImages(files), sequentialIds())
    expect(plan.entries).toHaveLength(6) // s2（null）と p2（空）は参照ではない
    const sale = plan.pathFor('sale', 's1')
    const listing = plan.pathFor('listing', 'm100')
    expect(sale).not.toBeNull()
    expect(listing).not.toBeNull()
    expect(sale).not.toBe(listing)
    expect(new Set(plan.entries.map((e) => e.path)).size).toBe(6)
  })

  it('パス：<世帯>/<種類>/<ランダムな uuid>.<拡張子（小文字）>。レシートだけ receipts', async () => {
    const plan = await planImages({ tables }, HH, memoryImages(files), sequentialIds())
    expect(plan.pathFor('sale', 's3')).toMatch(new RegExp(`^${HH}/sale/[0-9a-f-]{36}\\.jpg$`))
    expect(plan.pathFor('purchase_line', 'p1')).toMatch(new RegExp(`^${HH}/purchase-line/[0-9a-f-]{36}\\.png$`))
    expect(plan.pathFor('product_image', 'A037')).toMatch(new RegExp(`^${HH}/product/[0-9a-f-]{36}\\.webp$`))
    expect(plan.pathFor('expense', 'e1')).toMatch(new RegExp(`^${HH}/receipt/[0-9a-f-]{36}\\.jpeg$`))
    expect(plan.entries.filter((e) => e.bucket === 'receipts').map((e) => e.table)).toEqual(['expense'])
    expect(plan.entries.filter((e) => e.bucket === 'media')).toHaveLength(5)
  })

  it('既定のパスは推測できない（実行のたびに違う。crypto.randomUUID）', async () => {
    const a = await planImages({ tables }, HH, memoryImages(files))
    const b = await planImages({ tables }, HH, memoryImages(files))
    expect(a.pathFor('sale', 's1')).not.toBe(b.pathFor('sale', 's1'))
  })

  it('ファイルが無い・空・名前が不正なものは、パスを決めず（null）、理由つきで数える', async () => {
    const bad = {
      sale: [
        { id: 'a', thumb_file: 'gone.jpg' }, { id: 'b', thumb_file: 'empty.jpg' },
        { id: 'c', thumb_file: '../secret.jpg' }, { id: 'd', thumb_file: 'sub/dir.jpg' }, { id: 'e', thumb_file: '.hidden' },
        { id: 'f', thumb_file: 'ok.jpg' },
      ],
    }
    const plan = await planImages({ tables: bad }, HH, memoryImages({ 'empty.jpg': 0, 'ok.jpg': 5, '../secret.jpg': 9, 'sub/dir.jpg': 9 }))
    expect(plan.missing.map((m) => `${m.rowKey}:${m.status}`)).toEqual(['a:missing', 'b:empty', 'c:unsafe_name', 'd:unsafe_name', 'e:unsafe_name'])
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(plan.pathFor('sale', id)).toBeNull()
    expect(plan.pathFor('sale', 'f')).not.toBeNull()
    expect(plan.ready).toHaveLength(1)
  })

  it('拡張子と Content-Type', () => {
    expect(extensionOf('A.JPG')).toBe('jpg')
    expect(extensionOf('noext')).toBe('bin')
    expect(extensionOf('weird.<script>')).toBe('bin')
    expect(contentTypeOf('x.webp')).toBe('image/webp')
    expect(contentTypeOf('x.unknown')).toBe('application/octet-stream')
    expect(isPlainFileName('a.jpg')).toBe(true)
    expect(isPlainFileName('a\\b.jpg')).toBe(false)
  })
})

describe('フォルダから読む', () => {
  let dir = ''
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('ファイルの有無・大きさ・中身。フォルダの外は読まない', async () => {
    dir = await mkdtemp(join(tmpdir(), 'soroban-migrate-test-'))
    await writeFile(join(dir, 'a.jpg'), new Uint8Array([1, 2, 3]))
    await mkdir(join(dir, 'sub'))
    const src = folderImageSource(dir)
    expect(await src.stat('a.jpg')).toEqual({ size: 3 })
    expect(await src.stat('none.jpg')).toBeNull()
    expect(await src.stat('sub')).toBeNull() // フォルダはファイルではない
    expect([...(await src.read('a.jpg'))]).toEqual([1, 2, 3])
    await expect(src.stat('../a.jpg')).rejects.toThrow(/不正/)
    await expect(src.read('sub/../../x')).rejects.toThrow(/不正/)
  })
})

describe('Storage に置く（uploadImages）', () => {
  const tables = { sale: [1, 2, 3].map((n) => ({ id: `s${n}`, thumb_file: `f${n}.jpg` })) }
  const source = memoryImages({ 'f1.jpg': 11, 'f2.jpg': 22, 'f3.jpg': 33 })

  it('ready の画像を 1 つずつ。置いた数と大きさを返す', async () => {
    const plan = await planImages({ tables }, HH, source, sequentialIds())
    const up = recordingUploader()
    const r = await uploadImages(plan, source, up)
    expect(r.uploaded).toHaveLength(3)
    expect(r.bytes).toBe(66)
    expect(up.uploaded.map((u) => u.size)).toEqual([11, 22, 33])
    expect(up.uploaded.every((u) => u.bucket === 'media' && u.contentType === 'image/jpeg')).toBe(true)
  })

  it('途中で失敗したら、置いた分を片付けて、失敗の理由を言う', async () => {
    const plan = await planImages({ tables }, HH, source, sequentialIds())
    const up = recordingUploader({ failAt: 3 })
    await expect(uploadImages(plan, source, up)).rejects.toThrow(/2 \/ 3 件目まで保存済み.*保存に失敗（試験）/s)
    expect(up.removed.flatMap((r) => r.paths)).toEqual(up.uploaded.map((u) => u.path))
  })

  it('片付けられなかったパスは、エラーの文に残す（黙って残さない）', async () => {
    const plan = await planImages({ tables }, HH, source, sequentialIds())
    const up = recordingUploader({ failAt: 2 })
    up.remove = async () => {
      throw new Error('消せない')
    }
    await expect(uploadImages(plan, source, up)).rejects.toThrow(/片付けられなかった画像.*media\/.*\/sale\//s)
  })

  it('remove が無い置き場でも、置いたパスを言う', async () => {
    const left = await removeUploaded({ upload: async () => {} }, [{ bucket: 'media', path: 'p' } as never])
    expect(left).toEqual(['media/p'])
  })
})

describe('Supabase Storage の REST（偽の fetch）', () => {
  function fakeFetch(statuses: number[]): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]
      return new Response(JSON.stringify({ message: status >= 400 ? `エラー${status}` : 'ok' }), { status })
    }) as typeof fetch
    return { fetch: fetchFn, calls }
  }
  const item = { bucket: 'media' as const, path: `${HH}/sale/aaaa bbbb.jpg`, contentType: 'image/jpeg', bytes: new Uint8Array([9, 8, 7]) }

  it('POST {url}/storage/v1/object/<bucket>/<path>。Authorization: Bearer <JWT>、apikey: <anon>、上書きしない', async () => {
    const f = fakeFetch([200])
    const up = new SupabaseStorageUploader({ url: 'https://abc.supabase.co/', anonKey: ANON, jwt: JWT, fetch: f.fetch, retryDelayMs: 0 })
    await up.upload(item)
    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0]
    expect(url).toBe(`https://abc.supabase.co/storage/v1/object/media/${HH}/sale/aaaa%20bbbb.jpg`)
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe(`Bearer ${JWT}`)
    expect(h.apikey).toBe(ANON)
    expect(h['Content-Type']).toBe('image/jpeg')
    expect(h['x-upsert']).toBe('false')
    expect([...(init.body as Uint8Array)]).toEqual([9, 8, 7])
  })

  it('レシートは receipts のバケット', async () => {
    const f = fakeFetch([200])
    const up = new SupabaseStorageUploader({ url: 'https://abc.supabase.co', anonKey: ANON, jwt: JWT, fetch: f.fetch })
    await up.upload({ ...item, bucket: 'receipts', path: `${HH}/receipt/x.png` })
    expect(f.calls[0].url).toBe(`https://abc.supabase.co/storage/v1/object/receipts/${HH}/receipt/x.png`)
  })

  it('4xx は再試行しない。エラーの文に JWT・キーを出さない', async () => {
    const f = fakeFetch([403])
    const up = new SupabaseStorageUploader({ url: 'https://abc.supabase.co', anonKey: ANON, jwt: JWT, fetch: f.fetch, retryDelayMs: 0 })
    const err = await failure(up.upload(item))
    expect(f.calls).toHaveLength(1)
    expect(err.message).toContain('403')
    expect(err.message).not.toContain(JWT)
    expect(err.message).not.toContain('SIGNATURE-SECRET-PART')
    expect(err.message).not.toContain(ANON)
  })

  it('5xx は 2 回まで再試行して、通れば成功。続けて失敗すれば 3 回で止める', async () => {
    const ok = fakeFetch([500, 503, 200])
    await new SupabaseStorageUploader({ url: 'https://abc.supabase.co', anonKey: ANON, jwt: JWT, fetch: ok.fetch, retryDelayMs: 0 }).upload(item)
    expect(ok.calls).toHaveLength(3)
    const bad = fakeFetch([502])
    await expect(new SupabaseStorageUploader({ url: 'https://abc.supabase.co', anonKey: ANON, jwt: JWT, fetch: bad.fetch, retryDelayMs: 0 }).upload(item))
      .rejects.toThrow(/502/)
    expect(bad.calls).toHaveLength(3)
  })

  it('通信の失敗でも、エラーの文に URL・鍵は出さない', async () => {
    const fetchFn = (async () => {
      throw new TypeError(`fetch failed https://abc.supabase.co Bearer ${JWT}`)
    }) as unknown as typeof fetch
    const up = new SupabaseStorageUploader({ url: 'https://abc.supabase.co', anonKey: ANON, jwt: JWT, fetch: fetchFn, retryDelayMs: 0 })
    const err = await failure(up.upload(item))
    expect(err.message).toContain('通信に失敗')
    expect(err.message).not.toContain(JWT)
  })

  it('remove：DELETE {url}/storage/v1/object/<bucket> に prefixes を JSON で', async () => {
    const f = fakeFetch([200])
    const up = new SupabaseStorageUploader({ url: 'https://abc.supabase.co', anonKey: ANON, jwt: JWT, fetch: f.fetch })
    await up.remove('media', ['a/b.jpg', 'c/d.png'])
    expect(f.calls[0].url).toBe('https://abc.supabase.co/storage/v1/object/media')
    expect(f.calls[0].init.method).toBe('DELETE')
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ prefixes: ['a/b.jpg', 'c/d.png'] })
  })

  it('Project URL は https のみ（ローカルの開発用だけ http を許す）', () => {
    expect(normalizeSupabaseUrl('https://abc.supabase.co/')).toBe('https://abc.supabase.co')
    expect(normalizeSupabaseUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321')
    expect(() => normalizeSupabaseUrl('http://abc.supabase.co')).toThrow(/https/)
    expect(() => normalizeSupabaseUrl('abc')).toThrow(/URL/)
    expect(encodeObjectPath('a b/c#d/é.jpg')).toBe('a%20b/c%23d/%C3%A9.jpg')
  })
})
