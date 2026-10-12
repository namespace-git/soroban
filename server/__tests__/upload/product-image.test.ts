import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createShopAccount } from '../../domain/master'
import { productImageFiles } from '../../domain/derive'
import { getProductImage, setProductImageAuto, setProductImagePath } from '../../domain/product'
import { handlers } from '../../rpc'
import { spyConsole } from '../integrations/helpers'
import { openDomainDb, type DomainDb } from '../domain/helpers'
import { ANON_KEY, newUploadWorld, productPath, upload, type UploadMember, type UploadWorld } from './helpers'

// 商品（型番）の画像：人がセットした画像（公開バケット media の <世帯>/product/…）にする・自動に戻す・自動を固定する。
// 自動画像（仕入先・出品・販売の画像）を固定するときはコピーせず同じパスを指す＝あとで外しても元のファイルは消えない。

let db: DomainDb
let world: UploadWorld

beforeAll(async () => {
  db = await openDomainDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  world = await newUploadWorld(db)
})

const CODE = 'Q001'

const imageOf = (who: UploadMember = world.a, code = CODE) =>
  world.run(who, async ctx => (await productImageFiles(ctx, [code])).get(code))

const rowOf = (who: UploadMember = world.a, code = CODE) =>
  world.run(who, ctx => getProductImage(ctx, code))

/** 仕入先（メロジョイ）の商品画像を持つ仕入明細を 1 つ作る（＝自動画像の②）。その画像は media に置く */
async function seedAutoImage(who: UploadMember, code = CODE): Promise<string> {
  const path = `${who.householdId}/purchase-line/${randomUUID()}.jpg`
  world.backend.put('media', path)
  await world.run(who, async (ctx) => {
    const shop = await createShopAccount(ctx, `店 ${randomUUID().slice(0, 6)}`)
    const purchase = await ctx.sql.get<{ id: string }>('insert into purchase (shop_account_id, ordered_at) values (?, ?) returning id', shop, '2026-09-01')
    await ctx.sql.run(
      'insert into purchase_line (purchase_id, name, unit_price, quantity, model_code, image_path) values (?, ?, ?, ?, ?, ?)',
      purchase!.id, '商品', 100, 1, code, path,
    )
  })
  return path
}

describe('setProductImagePath：人がセットした画像にする', () => {
  it('セットすると人の画像（manual）になり、自動画像より優先される。前の人の画像はコミットの後に消す', async () => {
    const auto = await seedAutoImage(world.a)
    expect(await imageOf()).toEqual({ path: auto, manual: false })

    const p1 = await upload(world, world.a, 'product')
    world.backend.calls.length = 0
    const r1 = await world.call(world.a, 'setProductImagePath', CODE, p1)
    expect(r1).toMatchObject({ status: 200, body: { result: true } })
    expect(await imageOf()).toEqual({ path: p1, manual: true })
    // 存在の確認（署名）だけ。消すものは無い（前は自動画像で、人の画像ではない）
    expect(world.backend.calls.map(c => c.kind)).toEqual(['sign'])
    expect(world.backend.calls[0]).toMatchObject({ bucket: 'media', apikey: ANON_KEY, authorization: `Bearer ${world.a.jwt}` })
    expect(world.backend.has('media', auto)).toBe(true)

    const p2 = await upload(world, world.a, 'product', 'png')
    world.backend.calls.length = 0
    expect((await world.call(world.a, 'setProductImagePath', CODE, p2)).status).toBe(200)
    expect(await imageOf()).toEqual({ path: p2, manual: true })
    expect(world.backend.calls.map(c => c.kind)).toEqual(['sign', 'remove']) // 署名 → コミット → 消す
    expect(world.backend.of('remove')[0]).toMatchObject({ bucket: 'media', paths: [p1], authorization: `Bearer ${world.a.jwt}` })
    expect(world.backend.has('media', p1)).toBe(false)
    expect(world.backend.has('media', p2)).toBe(true)
    expect(world.backend.has('media', auto)).toBe(true)
  })

  it('固定した自動画像（<世帯>/product/ の外）を人の画像で置き換えても、元の画像は消えない', async () => {
    const auto = await seedAutoImage(world.a)
    await world.call(world.a, 'setProductImageAuto', CODE, false)
    expect((await rowOf())?.path).toBe(auto)
    const p = await upload(world, world.a, 'product')
    world.backend.calls.length = 0
    expect((await world.call(world.a, 'setProductImagePath', CODE, p)).status).toBe(200)
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('media', auto)).toBe(true)
    expect((await rowOf())?.path).toBe(p)
  })

  it('同じ画像をもう一度セットしても何も消えない。別の型番が使っている画像は使えない（409）', async () => {
    const p = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, p)
    world.backend.calls.length = 0
    expect((await world.call(world.a, 'setProductImagePath', CODE, p)).status).toBe(200)
    expect(world.backend.calls).toEqual([])

    const other = await world.call(world.a, 'setProductImagePath', 'Q002', p)
    expect(other.status).toBe(409)
    expect(other.body.error?.message).toBe('この画像はすでに別の商品に使われています')
    expect(await rowOf(world.a, 'Q002')).toBeNull()
    expect(world.backend.has('media', p)).toBe(true)
  })

  it('上げていない（Storage に無い）画像は結ばない：404。今の画像も消えない', async () => {
    const p1 = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, p1)
    world.backend.calls.length = 0
    const spy = spyConsole()
    let r
    try {
      r = await world.call(world.a, 'setProductImagePath', CODE, productPath(world.a))
    } finally {
      spy.restore()
    }
    expect(r.status).toBe(404)
    expect(r.body.error?.message).toBe('アップロードした画像が見つかりません。もう一度アップロードしてください')
    expect((await rowOf())?.path).toBe(p1)
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('media', p1)).toBe(true)
  })

  it('型番が空・文字でなければ 400。保存先の設定やログインが無ければ日本語で断る', async () => {
    const p = await upload(world, world.a, 'product')
    for (const code of ['', '   ', null, 1]) {
      expect((await world.call(world.a, 'setProductImagePath', code, p)).status, String(code)).toBe(400)
    }
    for (const opts of [{ noAnon: true }, { noJwt: true }]) {
      await expect(world.run(world.a, ctx => setProductImagePath(ctx, CODE, p), opts)).rejects.toMatchObject({
        message: expect.stringContaining('画像の保存先が使えません'),
      })
    }
    expect(await rowOf()).toBeNull()
  })

  it('巻き戻ったら前の画像は消さない。消せなくても（Storage の不調）セットは成功し、失敗はログだけ', async () => {
    const p1 = await upload(world, world.a, 'product')
    const p2 = await upload(world, world.a, 'product')
    const p3 = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, p1)
    world.backend.calls.length = 0

    await expect(world.run(world.a, async (ctx) => {
      await setProductImagePath(ctx, CODE, p2)
      throw new Error('このあとで失敗')
    })).rejects.toThrow('このあとで失敗')
    expect((await rowOf())?.path).toBe(p1)
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('media', p1)).toBe(true)

    world.backend.failures.remove = 500
    const spy = spyConsole()
    let r
    try {
      r = await world.call(world.a, 'setProductImagePath', CODE, p3)
    } finally {
      spy.restore()
    }
    expect(r.status).toBe(200)
    expect((await rowOf())?.path).toBe(p3)
    expect(world.backend.has('media', p1)).toBe(true) // 残った（後で回収する）
    expect(spy.text()).toContain('後始末に失敗しました')
    expect(spy.text()).not.toContain(world.a.jwt)
  })
})

describe('setProductImageAuto：自動に戻す／自動を固定する', () => {
  it('true：人の画像を外して自動に戻す。人の画像（<世帯>/product/）はコミットの後に消す。何も無ければ何もしない', async () => {
    const auto = await seedAutoImage(world.a)
    const p = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, p)
    world.backend.calls.length = 0

    expect((await world.call(world.a, 'setProductImageAuto', CODE, true)).status).toBe(200)
    expect(await rowOf()).toBeNull()
    expect(await imageOf()).toEqual({ path: auto, manual: false })
    expect(world.backend.calls.map(c => c.kind)).toEqual(['remove'])
    expect(world.backend.has('media', p)).toBe(false)
    expect(world.backend.has('media', auto)).toBe(true)

    world.backend.calls.length = 0
    expect((await world.call(world.a, 'setProductImageAuto', CODE, true)).status).toBe(200) // もう人の画像は無い
    expect(world.backend.calls).toEqual([])
  })

  it('false：今の自動画像を、コピーせず同じパスを指す人の画像として固定する。外しても元の画像は消えない', async () => {
    const auto = await seedAutoImage(world.a)
    world.backend.calls.length = 0
    expect((await world.call(world.a, 'setProductImageAuto', CODE, false)).status).toBe(200)
    expect(world.backend.calls).toEqual([]) // コピーも署名もしない
    expect(await rowOf()).toEqual({ path: auto })
    expect(await imageOf()).toEqual({ path: auto, manual: true })

    // 元の仕入明細の画像が変わっても追従しない（固定された）
    const newer = `${world.a.householdId}/purchase-line/${randomUUID()}.jpg`
    await world.run(world.a, ctx => ctx.sql.run('update purchase_line set image_path = ? where model_code = ?', newer, CODE))
    expect(await imageOf()).toEqual({ path: auto, manual: true })

    // 自動に戻す：行は消えるが、元のファイルは <世帯>/product/ の外なので消えない
    expect((await world.call(world.a, 'setProductImageAuto', CODE, true)).status).toBe(200)
    expect(await rowOf()).toBeNull()
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('media', auto)).toBe(true)
    expect(await imageOf()).toEqual({ path: newer, manual: false })
  })

  it('false：自動画像が無い・すでに人の画像なら何もしない', async () => {
    expect((await world.call(world.a, 'setProductImageAuto', CODE, false)).status).toBe(200)
    expect(await rowOf()).toBeNull()

    await seedAutoImage(world.a)
    const p = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, p)
    world.backend.calls.length = 0
    expect((await world.call(world.a, 'setProductImageAuto', CODE, false)).status).toBe(200)
    expect((await rowOf())?.path).toBe(p) // 人の画像のまま
    expect(world.backend.calls).toEqual([])
  })

  it('引数が違えば 400。巻き戻ったら人の画像は消さない', async () => {
    for (const auto of ['yes', 1, null, undefined]) {
      expect((await world.call(world.a, 'setProductImageAuto', CODE, auto)).status, String(auto)).toBe(400)
    }
    expect((await world.call(world.a, 'setProductImageAuto', '', true)).status).toBe(400)

    const p = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, p)
    world.backend.calls.length = 0
    await expect(world.run(world.a, async (ctx) => {
      await setProductImageAuto(ctx, CODE, true)
      throw new Error('巻き戻す')
    })).rejects.toThrow('巻き戻す')
    expect((await rowOf())?.path).toBe(p)
    expect(world.backend.calls).toEqual([])
    expect(world.backend.has('media', p)).toBe(true)
  })

  it('ファイルを選ぶダイアログの setProductImage は Web では登録しない（501）。Web 用の 2 本は登録されている', async () => {
    expect((await world.call(world.a, 'setProductImage', CODE)).status).toBe(501)
    expect(typeof handlers.setProductImagePath).toBe('function')
    expect(typeof handlers.setProductImageAuto).toBe('function')
    expect(typeof handlers.prepareUpload).toBe('function')
    expect(typeof handlers.attachReceiptPath).toBe('function')
    expect(typeof handlers.readReceiptAt).toBe('function')
    expect(typeof handlers.readReceipt).toBe('function')
    expect(typeof handlers.removeReceipt).toBe('function')
    expect(handlers.attachReceipt).toBeUndefined()
    expect(handlers.readReceiptImage).toBeUndefined()
  })
})

describe('世帯の分離：世帯 B から A の商品画像には触れない', () => {
  it('B は A の画像のパスを結べず、A の型番の画像を外せない。A の画像は無傷', async () => {
    const pa = await upload(world, world.a, 'product')
    await world.call(world.a, 'setProductImagePath', CODE, pa)
    const pb = await upload(world, world.b, 'product')
    world.backend.calls.length = 0

    expect((await world.call(world.b, 'setProductImagePath', CODE, pa)).status).toBe(400)
    expect((await world.call(world.b, 'setProductImagePath', CODE, `${world.a.householdId}/product/../../${world.b.householdId}/product/${randomUUID()}.jpg`)).status).toBe(400)
    // 同じ型番名でも B の行は別。B が自動に戻しても A の行は残り、Storage にも触れない
    expect((await world.call(world.b, 'setProductImageAuto', CODE, true)).status).toBe(200)
    expect((await rowOf(world.a))?.path).toBe(pa)
    expect(world.backend.calls).toEqual([])

    // B 自身は同じ型番名に自分の画像をセットできる（A の行を上書きしない）
    expect((await world.call(world.b, 'setProductImagePath', CODE, pb)).status).toBe(200)
    expect((await rowOf(world.a))?.path).toBe(pa)
    expect((await rowOf(world.b))?.path).toBe(pb)
    expect(world.backend.has('media', pa)).toBe(true)
    expect(world.backend.of('remove')).toEqual([])

    // B の JWT は、サーバーのバグがあっても A のフォルダには届かない（Storage の方針）
    expect(world.backend.of('sign').map(c => c.authorization)).toEqual([`Bearer ${world.b.jwt}`])
  })
})
