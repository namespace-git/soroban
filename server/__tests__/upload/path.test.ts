import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareUpload } from '../../domain/upload'
import { UserError } from '../../errors'
import { assertUploadPath, bucketOfKind, isOwnPath, newUploadPath } from '../../storage'
import { openDomainDb, type DomainDb } from '../domain/helpers'
import { addExpense, newUploadWorld, productPath, receiptPath, type UploadWorld } from './helpers'

// 置き場所（prepareUpload）と、受け取るパスの検査（assertUploadPath）。
// パスは `<自分の世帯の id>/<receipt|product>/<uuid>.<jpg|png|webp>` の形だけを通す（他の世帯・`..`・別の種類・形式違いは 400）。

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

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

describe('prepareUpload', () => {
  it('レシートは receipts、商品画像は media。パスは <世帯>/<種類>/<乱数の uuid>.<拡張子>（毎回違う）', async () => {
    for (const ext of ['jpg', 'png', 'webp'] as const) {
      const r = await world.call(world.a, 'prepareUpload', 'receipt', ext)
      expect(r.status).toBe(200)
      expect(r.body.result.bucket).toBe('receipts')
      expect(r.body.result.path).toMatch(new RegExp(`^${world.a.householdId}/receipt/${UUID}\\.${ext}$`))
      const p = await world.call(world.a, 'prepareUpload', 'product', ext)
      expect(p.body.result.bucket).toBe('media')
      expect(p.body.result.path).toMatch(new RegExp(`^${world.a.householdId}/product/${UUID}\\.${ext}$`))
    }
    const paths = await Promise.all(Array.from({ length: 5 }, () => world.call(world.a, 'prepareUpload', 'receipt', 'jpg')))
    expect(new Set(paths.map(r => r.body.result.path)).size).toBe(5)
  })

  it('世帯 B には B のフォルダが返る。何も書き込まない（行も作らず、Storage にも触れない）', async () => {
    const r = await world.call(world.b, 'prepareUpload', 'product', 'jpg')
    expect(r.body.result.path.startsWith(`${world.b.householdId}/product/`)).toBe(true)
    expect(r.body.result.path.startsWith(world.a.householdId)).toBe(false)
    expect(world.backend.calls).toEqual([])
  })

  it('種類・形式が違えば 400（SQL まで届かない）。文字でないものも断る', async () => {
    const cases: Array<[unknown, unknown]> = [
      ['sale', 'jpg'], ['receipts', 'jpg'], ['', 'jpg'], [null, 'jpg'], [undefined, 'jpg'], [1, 'jpg'], [{}, 'jpg'],
      ['receipt', 'gif'], ['receipt', 'jpeg'], ['receipt', 'heic'], ['receipt', 'JPG'], ['receipt', ''], ['receipt', null],
      ['receipt', '../x'], ['receipt', 'jpg/../../x'],
    ]
    for (const [kind, ext] of cases) {
      const r = await world.call(world.a, 'prepareUpload', kind, ext)
      expect(r.status, `${String(kind)} ${String(ext)}`).toBe(400)
    }
    expect((await world.call(world.a, 'prepareUpload')).status).toBe(400)
  })

  it('直接呼んでも同じ（ctx の世帯のフォルダの中に作る）', async () => {
    const t = await world.run(world.a, (ctx) => prepareUpload(ctx, 'receipt', 'png'))
    expect(t.bucket).toBe(bucketOfKind('receipt'))
    expect(t.path.startsWith(`${world.a.householdId}/receipt/`)).toBe(true)
    expect(() => assertUploadPath({ householdId: world.a.householdId }, 'receipt', t.path)).not.toThrow()
  })
})

describe('assertUploadPath：<自分の世帯の id>/<kind>/<uuid>.<jpg|png|webp> の形だけ', () => {
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const ctx = { householdId: a }
  const id = randomUUID()

  it('正しい形は通り、そのままのパスを返す', () => {
    for (const kind of ['receipt', 'product'] as const) {
      for (const ext of ['jpg', 'png', 'webp']) {
        const p = `${a}/${kind}/${id}.${ext}`
        expect(assertUploadPath(ctx, kind, p)).toBe(p)
      }
    }
    expect(assertUploadPath(ctx, 'receipt', newUploadPath(ctx, 'receipt', 'jpg'))).toMatch(/\.jpg$/)
  })

  it('他の世帯・`..`・別の種類・形式違いは 400（UserError）', () => {
    const bad: unknown[] = [
      `${b}/receipt/${id}.jpg`, // 他の世帯
      `${a.toUpperCase()}/receipt/${id}.jpg`, // 大文字（世帯の id は小文字で比べる）
      `${a}/product/${id}.jpg`, // 別の種類
      `${a}/sale/${id}.jpg`,
      `${a}/receipt/../${b}/receipt/${id}.jpg`,
      `${a}/receipt/${id}.jpg/../x.jpg`,
      `../${a}/receipt/${id}.jpg`,
      `/${a}/receipt/${id}.jpg`, // 先頭のスラッシュ
      `${a}//receipt/${id}.jpg`,
      `${a}/receipt/${id}.gif`, `${a}/receipt/${id}.jpeg`, `${a}/receipt/${id}.heic`, `${a}/receipt/${id}.JPG`, `${a}/receipt/${id}`,
      `${a}/receipt/${id}.jpg.png`, `${a}/receipt/${id}.jpg/`,
      `${a}/receipt/${id}.jpg\n`, `${a}/receipt/${id}.jpg `, ` ${a}/receipt/${id}.jpg`,
      `${a}/receipt/not-a-uuid.jpg`, `${a}/receipt/${id.slice(1)}.jpg`, `${a}/receipt/${id}x.jpg`,
      `${a}/receipt/sub/${id}.jpg`, `${a}/receipt/${id}%2e.jpg`, `${a}\\receipt\\${id}.jpg`,
      '', ' ', `${a}/receipt/`, `${a}/receipt`, a,
      null, undefined, 1, true, {}, [], [`${a}/receipt/${id}.jpg`],
    ]
    for (const p of bad) {
      expect(() => assertUploadPath(ctx, 'receipt', p), JSON.stringify(p)).toThrow(UserError)
      try {
        assertUploadPath(ctx, 'receipt', p)
      } catch (e) {
        expect((e as UserError).code).toBe('bad_request')
        expect((e as UserError).message).toBe('画像の置き場所が正しくありません。もう一度アップロードしてください')
      }
    }
    // 商品画像側も同じ（レシートの形は通らない）
    expect(() => assertUploadPath(ctx, 'product', `${a}/receipt/${id}.jpg`)).toThrow(UserError)
  })

  it('isOwnPath：消してよい画像かの判定は自分の世帯の <kind> のフォルダだけ（移行で入った拡張子違いも通す。`..` は通さない）', () => {
    expect(isOwnPath(ctx, 'receipt', `${a}/receipt/${id}.jpg`)).toBe(true)
    expect(isOwnPath(ctx, 'receipt', `${a}/receipt/${id}.heic`)).toBe(true)
    expect(isOwnPath(ctx, 'receipt', `${b}/receipt/${id}.jpg`)).toBe(false)
    expect(isOwnPath(ctx, 'receipt', `${a}/product/${id}.jpg`)).toBe(false)
    expect(isOwnPath(ctx, 'product', `${a}/purchase-line/${id}.jpg`)).toBe(false)
    expect(isOwnPath(ctx, 'receipt', `${a}/receipt/`)).toBe(false)
    expect(isOwnPath(ctx, 'receipt', `${a}/receipt/../${b}/receipt/x.jpg`)).toBe(false)
    expect(isOwnPath(ctx, 'receipt', null)).toBe(false)
    expect(isOwnPath(ctx, 'receipt', undefined)).toBe(false)
  })
})

describe('受け取る口はどれも同じ検査を通す（400。DB にも Storage にも触れない）', () => {
  it('attachReceiptPath・readReceiptAt・setProductImagePath・createExpense/updateExpense の receipt_temp_file', async () => {
    const expense = await addExpense(world, world.a)
    const theirs = receiptPath(world.b)
    const bads = [
      theirs, // 他の世帯のパス
      `${world.a.householdId}/receipt/../${world.b.householdId}/receipt/${randomUUID()}.jpg`,
      `${world.a.householdId}/receipt/${randomUUID()}.gif`,
      'receipt-tmp-x.jpg', // デスクトップの一時ファイル名
    ]
    world.backend.calls.length = 0
    for (const p of bads) {
      const label = p.slice(0, 80)
      expect((await world.call(world.a, 'attachReceiptPath', expense, p)).status, `attach ${label}`).toBe(400)
      expect((await world.call(world.a, 'readReceiptAt', p)).status, `read ${label}`).toBe(400)
      expect((await world.call(world.a, 'setProductImagePath', 'Q001', p)).status, `product ${label}`).toBe(400)
      expect((await world.call(world.a, 'createExpense', {
        occurred_at: '2026-09-10', category: 'other', amount: 1, receipt_temp_file: p,
      })).status, `create ${label}`).toBe(400)
      expect((await world.call(world.a, 'updateExpense', expense, {
        occurred_at: '2026-09-10', category: 'other', amount: 1, receipt_temp_file: p,
      })).status, `update ${label}`).toBe(400)
    }
    // 別の種類：レシートの口に商品画像のパスは通らない。商品画像の口にレシートのパスも通らない
    const product = productPath(world.a)
    expect((await world.call(world.a, 'attachReceiptPath', expense, product)).status).toBe(400)
    expect((await world.call(world.a, 'readReceiptAt', product)).status).toBe(400)
    expect((await world.call(world.a, 'createExpense', { occurred_at: '2026-09-10', category: 'other', amount: 1, receipt_temp_file: product })).status).toBe(400)
    expect((await world.call(world.a, 'setProductImagePath', 'Q001', receiptPath(world.a))).status).toBe(400)
    expect(world.backend.calls).toEqual([])
    // 断られた経費は作られていない
    const n = await world.run(world.a, (ctx) => ctx.sql.get<{ c: number }>('select count(*) as c from expense'))
    expect(n?.c).toBe(1)
  })
})
