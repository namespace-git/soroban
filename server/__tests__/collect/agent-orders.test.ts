import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { todayJst } from '../../domain/_shared'
import { createShopAccount } from '../../domain/master'
import {
  applyFulfillmentFromShop, createPurchase, createPurchaseDraft, setPurchaseImageChecked, setPurchaseLineImageUrls,
} from '../../domain/purchase'
import type { Member } from '../domain/helpers'
import {
  closeFixture, count, leaseOf, openFixture, passCooldown, registerPc, resetWorld, startJob, type Fixture, type Pc,
} from './helpers'

// メロジョイ（仕入）の段：注文 1 件・既取込の到着状態・開き直し・画像のパス。
// 世帯 A＝agent の段、世帯 B＝ドメインを直接呼ぶ（デスクトップが db.x(...) を呼んでいたのと同じ関数）

let f: Fixture
let a: Member
let b: Member
let pc: Pc
let lease: ReturnType<typeof leaseOf>
let shopA: string
let shopB: string

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  a = f.world.a
  b = f.world.b
  pc = await registerPc(f, a)
  lease = leaseOf(await startJob(f, a, pc))
  shopA = await a.run((ctx) => createShopAccount(ctx, 'メロジョイ A', 'mellojoy'))
  shopB = await b.run((ctx) => createShopAccount(ctx, 'メロジョイ A', 'mellojoy'))
})

// ---- 入力 ----

const IMAGE = 'https://cdn.example.test/a.jpg'

const purchaseInput = (shopId: string, orderNo: string, over: Record<string, unknown> = {}) => ({
  shop_account_id: shopId, ordered_at: '2026-10-01', order_no: orderNo, shipping_fee: 500, discount: 100,
  alloc_method: 'by_amount', note: '注文履歴から自動取得', import_key: `mellojoy:${orderNo}`, fulfillment: 'shipped',
  lines: [
    { name: '【A037】もこ山 スクイーズ ピンク', unit_price: 1000, quantity: 2, model_code: 'A037', series_code: null, material: null, image_url: IMAGE },
    { name: '【A035-1】ぷにぷに', unit_price: 1500, quantity: 1, model_code: 'A035-1', series_code: null, material: null, image_url: null },
  ],
  ...over,
})

const draftInput = (shopId: string, orderNo: string) => ({
  import_key: `mellojoy:${orderNo}`, shop_account_id: shopId, ordered_at: '2026-10-01', order_no: orderNo,
  shipping_fee: 300, discount: 0, fulfillment: 'pending', note: '注文履歴から自動取得（下書き）：単価が割り切れません',
  lines: [{ name: '【A037】もこ山 スクイーズ', quantity: 2 }, { name: '【A035】ぷに', quantity: 1, unit_price: 1200 }],
})

const SHIPMENT = { status: 'shipped', shipped_at: '2026-10-02', delivered_at: null, carrier: 'SF Express', tracking_number: 'SF123' }

const order = (orderNo: string, purchase: unknown, over: Record<string, unknown> = {}) => ({
  order_no: orderNo, purchase, fulfillment: null, image_urls: [], ...over,
})

// ---- 読み出し ----

async function snap(m: Member): Promise<{ purchases: unknown[]; lines: unknown[]; items: unknown[] }> {
  const q = async (sql: string) => (await f.dom.pg.query<Record<string, unknown>>(sql, [m.householdId])).rows
  return {
    purchases: await q(`
      select import_key, order_no, status, fulfillment, ordered_at::text as ordered_at, shipping_fee, discount, other_cost,
             alloc_method, note, shipped_at::text as shipped_at, delivered_at::text as delivered_at, tracking_carrier,
             tracking_number, (image_checked_at is not null) as image_checked
        from app.purchase where household_id = $1 order by import_key`),
    lines: await q(`
      select p.import_key, pl.name, pl.unit_price, pl.quantity, pl.model_code, pl.series_code, pl.material,
             pl.allocated_cost, pl.landed_unit_cost, pl.sort_order, pl.image_url, pl.image_path
        from app.purchase_line pl join app.purchase p on p.household_id = pl.household_id and p.id = pl.purchase_id
       where pl.household_id = $1 order by p.import_key, pl.sort_order`),
    items: await q(`select item_code, name, landed_cost, model_code from app.inventory_item where household_id = $1 order by item_code`),
  }
}

const purchaseCount = (m: Member) => count(f, 'select count(*)::int as n from app.purchase where household_id = $1', m.householdId)

async function setImportKeywords(shopId: string, keywords: string): Promise<void> {
  await f.dom.pg.query('update app.shop_account set import_keywords = $1 where id = $2', [keywords, shopId])
}

describe('取り込む仕入先（getCollectPlan）', () => {
  it('有効なメロジョイのアカウントだけ。TikTok など・無効なアカウントは含まない', async () => {
    await a.run((ctx) => createShopAccount(ctx, 'TikTok Shop', 'tiktok'))
    const off = await a.run((ctx) => createShopAccount(ctx, '休止中', 'mellojoy'))
    await f.dom.pg.query('update app.shop_account set is_active = 0 where id = $1', [off])
    const r = await pc.call('getCollectPlan', lease)
    expect(r.status).toBe(200)
    expect(r.body.result).toEqual({ shop_accounts: [{ id: shopA, name: 'メロジョイ A' }] })
  })
})

describe('注文 1 件（ingestOrder）', () => {
  it('確定：createPurchase と同じ仕入・明細・在庫ができ、配送と詳細を読んだ印が付く。画像を取る明細を返す', async () => {
    const r = await pc.call('ingestOrder', lease, shopA, order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1') }, { fulfillment: SHIPMENT }))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.result).toMatchObject({ already: false, outcome: 'confirmed', fulfillment_updated: true })
    expect(r.body.result.image_targets).toEqual([{ id: expect.any(String), image_url: IMAGE }])

    // B：desktop の collectShopOrders が呼んでいた並び
    await b.run(async (ctx) => {
      const id = await createPurchase(ctx, purchaseInput(shopB, 'OD1') as never)
      await setPurchaseImageChecked(ctx, id)
      await applyFulfillmentFromShop(ctx, id, SHIPMENT as never)
    })
    const sa = await snap(a)
    expect(sa).toEqual(await snap(b))
    expect(sa.purchases).toHaveLength(1)
    expect(sa.lines).toHaveLength(2)
    expect(sa.items).toHaveLength(3)
    expect(sa.purchases[0]).toMatchObject({ status: 'confirmed', image_checked: true, tracking_number: 'SF123', shipped_at: '2026-10-02' })
    // 原価の合計は 明細 + 送料 − 割引（端数は最終行に寄せて一致）
    const total = (sa.items as Array<{ landed_cost: number }>).reduce((s, i) => s + i.landed_cost, 0)
    expect(total).toBe(1000 * 2 + 1500 + 500 - 100)
  })

  it('下書き：createPurchaseDraft と同じ（在庫は作らない）。画像の URL は名前が合う明細に入る', async () => {
    const urls = [{ name: '【A037】もこ山 スクイーズ', image_url: 'https://cdn.example.test/draft.jpg' }]
    const r = await pc.call('ingestOrder', lease, shopA, order('OD2', { kind: 'draft', input: draftInput(shopA, 'OD2') }, { image_urls: urls, fulfillment: SHIPMENT }))
    expect(r.body.result).toMatchObject({ already: false, outcome: 'draft', fulfillment_updated: true })
    expect(r.body.result.image_targets).toEqual([{ id: expect.any(String), image_url: 'https://cdn.example.test/draft.jpg' }])

    await b.run(async (ctx) => {
      const id = await createPurchaseDraft(ctx, draftInput(shopB, 'OD2') as never)
      await setPurchaseLineImageUrls(ctx, id, urls)
      await setPurchaseImageChecked(ctx, id)
      await applyFulfillmentFromShop(ctx, id, SHIPMENT as never)
    })
    const sa = await snap(a)
    expect(sa).toEqual(await snap(b))
    expect(sa.items).toEqual([])
    expect(sa.purchases[0]).toMatchObject({ status: 'draft' })
  })

  it('同じ注文を同じ取り込みで 2 回送ると済み（二重に作らない）', async () => {
    const o = order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1') })
    expect((await pc.call('ingestOrder', lease, shopA, o)).body.result).toMatchObject({ already: false })
    expect((await pc.call('ingestOrder', lease, shopA, o)).body.result).toEqual({ already: true })
    expect(await purchaseCount(a)).toBe(1)
    expect((await snap(a)).items).toHaveLength(3)
  })

  it('次の取り込みで同じ注文を送っても、すでにあれば何もしない（existing）', async () => {
    const o = order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1') })
    const first = (await pc.call('ingestOrder', lease, shopA, o)).body.result
    await pc.call('finish', lease, { status: 'failed', run_ids: [] })
    await passCooldown(f, a)
    const next = leaseOf(await startJob(f, a, pc))

    const again = await pc.call('ingestOrder', next, shopA, o)
    expect(again.body.result).toMatchObject({
      already: false, outcome: 'existing', purchase_id: first.purchase_id, fulfillment_updated: false, image_targets: [],
    })
    expect(await purchaseCount(a)).toBe(1)
    expect((await snap(a)).items).toHaveLength(3)
  })

  it('キャンセル（合計 0 円）は仕入を作らず、除外を記録する', async () => {
    const r = await pc.call('ingestOrder', lease, shopA, order('OD3', { kind: 'cancelled' }))
    expect(r.body.result).toMatchObject({ already: false, outcome: 'cancelled', purchase_id: null, image_targets: [] })
    expect(await purchaseCount(a)).toBe(0)
    expect((await pc.call('excludedOrders', lease, shopA, ['OD3', 'OD9'])).body.result).toEqual(['OD3'])
  })

  it('キーワード：一部だけ一致なら一致した明細だけにして、送料・割引は金額比で按分する（四捨五入の整数）', async () => {
    await setImportKeywords(shopA, 'a037')
    const input = purchaseInput(shopA, 'OD4', {
      lines: [
        { name: '【A037】もこ山 スクイーズ', unit_price: 1000, quantity: 2, model_code: 'A037', series_code: null, material: null, image_url: IMAGE },
        { name: '私物の本', unit_price: 1500, quantity: 1, model_code: null, series_code: null, material: null, image_url: 'https://cdn.example.test/book.jpg' },
      ],
    })
    const r = await pc.call('ingestOrder', lease, shopA, order('OD4', { kind: 'confirmed', input }))
    expect(r.body.result).toMatchObject({ outcome: 'confirmed' })

    const s = await snap(a)
    // 一致した小計 2000 ÷ 全体 3500
    const ratio = 2000 / 3500
    expect(s.purchases[0]).toMatchObject({
      shipping_fee: Math.round(500 * ratio), discount: Math.round(100 * ratio),
      note: '注文履歴から自動取得\nキーワード不一致の明細 1 件を除外（送料・割引は金額比で按分）',
    })
    expect(s.lines).toHaveLength(1)
    expect(s.items).toHaveLength(2)
    const total = (s.items as Array<{ landed_cost: number }>).reduce((sum, i) => sum + i.landed_cost, 0)
    expect(total).toBe(2000 + Math.round(500 * ratio) - Math.round(100 * ratio))
    // 画像を取る対象も、一致した明細だけ
    expect(r.body.result.image_targets).toHaveLength(1)
    expect(r.body.result.image_targets[0].image_url).toBe(IMAGE)
  })

  it('キーワードに一致する明細が無い注文は取り込まず除外を記録する。キーワードを変えれば再評価される', async () => {
    await setImportKeywords(shopA, 'a037')
    const input = purchaseInput(shopA, 'OD5', {
      lines: [{ name: '私物の本', unit_price: 1500, quantity: 1, model_code: null, series_code: null, material: null, image_url: null }],
    })
    const r = await pc.call('ingestOrder', lease, shopA, order('OD5', { kind: 'confirmed', input }))
    expect(r.body.result).toMatchObject({ outcome: 'excluded', purchase_id: null })
    expect(await purchaseCount(a)).toBe(0)

    expect((await pc.call('excludedOrders', lease, shopA, ['OD5'])).body.result).toEqual(['OD5'])
    await setImportKeywords(shopA, 'a037 本') // キーワードが変われば印が変わり、除外は再評価される
    expect((await pc.call('excludedOrders', lease, shopA, ['OD5'])).body.result).toEqual([])
    // キーワードを元に戻せば同じ印に戻る
    await setImportKeywords(shopA, 'a037')
    expect((await pc.call('excludedOrders', lease, shopA, ['OD5'])).body.result).toEqual(['OD5'])
  })

  it('下書きも同じ：一致 0 件は除外、一部一致は一致した明細だけ（按分はせず、メモで知らせる）', async () => {
    await setImportKeywords(shopA, 'a037')
    const none = draftInput(shopA, 'OD6')
    none.lines = [{ name: '私物の本', quantity: 1 }] as never
    expect((await pc.call('ingestOrder', lease, shopA, order('OD6', { kind: 'draft', input: none }))).body.result)
      .toMatchObject({ outcome: 'excluded', purchase_id: null })

    const part = draftInput(shopA, 'OD7')
    part.lines = [{ name: '【A037】もこ山', quantity: 1 }, { name: '私物の本', quantity: 1 }] as never
    const r = await pc.call('ingestOrder', lease, shopA, order('OD7', { kind: 'draft', input: part }))
    expect(r.body.result).toMatchObject({ outcome: 'draft' })
    const s = await snap(a)
    expect(s.lines).toHaveLength(1)
    expect(s.purchases[0]).toMatchObject({
      shipping_fee: 300,
      note: '注文履歴から自動取得（下書き）：単価が割り切れません\nキーワード不一致の明細 1 件を除外（送料・割引は注文全体の値。確定時に見直してください）',
    })
  })

  it('注文のキー・仕入先が合わない・形が変なら 400（何も書かない）', async () => {
    const bad: Array<[string, unknown]> = [
      ['キーが注文番号と違う', order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1', { import_key: 'mellojoy:OTHER' }) })],
      ['別の仕入先', order('OD1', { kind: 'confirmed', input: purchaseInput(shopB, 'OD1') })],
      ['種類が不明', order('OD1', { kind: 'bogus', input: purchaseInput(shopA, 'OD1') })],
      ['明細が配列でない', order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1', { lines: 'x' }) })],
      ['明細の名前が文字でない', order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1', { lines: [{ name: 1 }] }) })],
      ['単価が小数', order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1', { lines: [{ name: 'x', unit_price: 1.5, quantity: 1 }] }) })],
      ['注文番号が空', order('', { kind: 'cancelled' })],
      ['purchase が無い', { order_no: 'OD1' }],
    ]
    for (const [label, o] of bad) {
      const r = await pc.call('ingestOrder', lease, shopA, o)
      expect(r.status, label).toBe(400)
    }
    expect((await pc.call('ingestOrder', lease, shopA, null)).status).toBe(400)
    expect((await pc.call('ingestOrder', lease, 'x', order('OD1', { kind: 'cancelled' }))).status).toBe(400)
    expect(await purchaseCount(a)).toBe(0)
    // 失敗した段は記録されず、直せば送り直せる
    expect((await pc.call('ingestOrder', lease, shopA, order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1') }))).body.result)
      .toMatchObject({ already: false, outcome: 'confirmed' })
  })

  it('知らない仕入先は 404', async () => {
    const r = await pc.call('ingestOrder', lease, '00000000-0000-4000-8000-000000000999', order('OD1', { kind: 'cancelled' }))
    expect(r.status).toBe(404)
  })
})

describe('既取込の注文（一覧の状態・差分・開き直し）', () => {
  async function seedOrders(codes: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const code of codes) {
      const input = purchaseInput(shopA, code, { ordered_at: todayJst(), fulfillment: 'pending', lines: [
        { name: `【A037】${code}`, unit_price: 1000, quantity: 1, model_code: 'A037', series_code: null, material: null, image_url: null },
      ] })
      const r = await pc.call('ingestOrder', lease, shopA, order(code, { kind: 'confirmed', input }))
      ids.push(r.body.result.purchase_id)
    }
    return ids
  }

  it('existingImportKeys：取り込み済みのキーだけを返す', async () => {
    await seedOrders(['OD1', 'OD2'])
    const r = await pc.call('existingImportKeys', lease, ['mellojoy:OD1', 'mellojoy:OD2', 'mellojoy:OD9'])
    expect([...r.body.result].sort()).toEqual(['mellojoy:OD1', 'mellojoy:OD2'])
    expect((await pc.call('existingImportKeys', lease, [])).body.result).toEqual([])
    expect((await pc.call('existingImportKeys', lease, 'x')).status).toBe(400)
    expect((await pc.call('existingImportKeys', lease, [1])).status).toBe(400)
  })

  it('一覧の状態表示で到着状態を更新する：前に進む方向だけ（人が「到着済」にしたものを戻さない）', async () => {
    await seedOrders(['OD1', 'OD2'])
    await f.dom.pg.query(`update app.purchase set fulfillment = 'delivered' where import_key = 'mellojoy:OD2'`)
    const r = await pc.call('updateOrderFulfillments', lease, shopA, [
      { import_key: 'mellojoy:OD1', fulfillment: 'shipped' },
      { import_key: 'mellojoy:OD2', fulfillment: 'shipped' }, // 後戻り→無視
      { import_key: 'mellojoy:NONE', fulfillment: 'shipped' }, // 無い注文→何もしない
    ])
    expect(r.body.result).toEqual({ already: false, updated: 1 })
    const rows = (await f.dom.pg.query<{ import_key: string; fulfillment: string }>(
      'select import_key, fulfillment from app.purchase where household_id = $1 order by import_key', [a.householdId])).rows
    expect(rows).toEqual([{ import_key: 'mellojoy:OD1', fulfillment: 'shipped' }, { import_key: 'mellojoy:OD2', fulfillment: 'delivered' }])

    expect((await pc.call('updateOrderFulfillments', lease, shopA, [])).body.result).toEqual({ already: true })
  })

  it('メロジョイの注文のキー以外・状態の値が変なら 400', async () => {
    for (const updates of [
      [{ import_key: 'manual:1', fulfillment: 'shipped' }],
      [{ import_key: 'mellojoy:OD1', fulfillment: 'flying' }],
      [{ fulfillment: 'shipped' }],
      'x',
    ]) {
      const r = await pc.call('updateOrderFulfillments', lease, shopA, updates)
      expect(r.status, JSON.stringify(updates)).toBe(400)
    }
  })

  it('開き直す候補は前回の続きから。開いた注文は追跡番号が付けば候補から外れ、読めなかったときは位置だけ進む', async () => {
    const [p1, p2, p3] = await seedOrders(['OD1', 'OD2', 'OD3'])
    // 取り込み時に付いた「詳細を読んだ印」を外す（開き直しで付くことを確かめる）
    await f.dom.pg.query('update app.purchase set image_checked_at = null where household_id = $1', [a.householdId])
    const keys = ['mellojoy:OD1', 'mellojoy:OD2', 'mellojoy:OD3']
    const ids = async (): Promise<string[]> =>
      (await pc.call('purchaseRevisitCandidates', lease, shopA, keys)).body.result.map((c: { id: string }) => c.id)

    const first = await ids()
    expect([...first].sort()).toEqual([p1, p2, p3].sort())

    // 読めなかった：位置だけ進める（前回の続きになる）
    const afterFirst = await pc.call('revisitOrder', lease, shopA, first[0], null)
    expect(afterFirst.body.result).toEqual({ already: false, fulfillment_updated: false, image_targets: [] })
    expect(await ids()).toEqual([first[1], first[2], first[0]])
    // 詳細を読んだ印は付けない（次回また候補に残る）
    expect((await f.dom.pg.query('select image_checked_at from app.purchase where id = $1', [first[0]])).rows[0]).toEqual({ image_checked_at: null })

    // 読めた：追跡番号が付き、詳細を読んだ印が付く → 候補から外れる
    const read = await pc.call('revisitOrder', lease, shopA, first[1], {
      image_urls: [],
      fulfillment: { status: 'shipped', shipped_at: todayJst(), delivered_at: null, carrier: 'SF Express', tracking_number: 'SF999' },
    })
    expect(read.body.result).toMatchObject({ already: false, fulfillment_updated: true })
    const row = (await f.dom.pg.query<{ tracking_number: string; image_checked_at: unknown }>(
      'select tracking_number, image_checked_at from app.purchase where id = $1', [first[1]])).rows[0]
    expect(row.tracking_number).toBe('SF999')
    expect(row.image_checked_at).not.toBeNull()
    expect(await ids()).not.toContain(first[1])

    // 同じ注文を同じ取り込みでもう一度は済み
    expect((await pc.call('revisitOrder', lease, shopA, first[1], null)).body.result).toEqual({ already: true })
  })

  it('開き直しで画像の URL が分かり、画像を取る明細が返る。パスを確定すると対象から外れる', async () => {
    const input = purchaseInput(shopA, 'OD1', { ordered_at: todayJst(), lines: [
      { name: '【A037】もこ山', unit_price: 1000, quantity: 1, model_code: 'A037', series_code: null, material: null, image_url: null },
    ] })
    const created = await pc.call('ingestOrder', lease, shopA, order('OD1', { kind: 'confirmed', input }))
    const purchaseId = created.body.result.purchase_id

    const r = await pc.call('revisitOrder', lease, shopA, purchaseId, {
      image_urls: [{ name: '【A037】もこ山', image_url: IMAGE }, { name: '知らない明細', image_url: 'https://cdn.example.test/x.jpg' }],
      fulfillment: null,
    })
    expect(r.body.result.image_targets).toEqual([{ id: expect.any(String), image_url: IMAGE }])

    const lineId = r.body.result.image_targets[0].id
    const path = `${a.householdId}/purchases/${lineId}.jpg`
    expect((await pc.call('saveLineImage', lease, lineId, path)).body.result).toEqual({ already: false })
    expect((await f.dom.pg.query('select image_path from app.purchase_line where id = $1', [lineId])).rows[0]).toEqual({ image_path: path })
    expect((await pc.call('saveLineImage', lease, lineId, path)).body.result).toEqual({ already: true })
  })

  it('開き直しの相手が別の仕入先・知らない仕入・形の変な詳細は断る', async () => {
    const [p1] = await seedOrders(['OD1'])
    const otherShop = await a.run((ctx) => createShopAccount(ctx, '別の仕入先', 'mellojoy'))
    expect((await pc.call('revisitOrder', lease, otherShop, p1, null)).status).toBe(400)
    expect((await pc.call('revisitOrder', lease, shopA, '00000000-0000-4000-8000-000000000999', null)).status).toBe(404)
    expect((await pc.call('revisitOrder', lease, shopA, p1, 'x')).status).toBe(400)
    expect((await pc.call('revisitOrder', lease, shopA, p1, { image_urls: 'x' })).status).toBe(400)
    expect((await pc.call('revisitOrder', lease, shopA, p1, { image_urls: [{ name: 1 }] })).status).toBe(400)
  })
})

describe('明細の画像のパス（saveLineImage）', () => {
  it('他の世帯のフォルダ・.. ・相対パスは断る（400）。知らない明細は 404', async () => {
    const created = await pc.call('ingestOrder', lease, shopA, order('OD1', { kind: 'confirmed', input: purchaseInput(shopA, 'OD1') }))
    expect(created.status).toBe(200)
    const lineId = (await f.dom.pg.query<{ id: string }>('select id from app.purchase_line where household_id = $1 limit 1', [a.householdId])).rows[0].id

    for (const path of [`${b.householdId}/x.jpg`, `${a.householdId}/../x.jpg`, 'x.jpg', `${a.householdId}//x.jpg`, '', null]) {
      expect((await pc.call('saveLineImage', lease, lineId, path)).status, String(path)).toBe(400)
    }
    expect((await f.dom.pg.query('select image_path from app.purchase_line where id = $1', [lineId])).rows[0]).toEqual({ image_path: null })
    expect((await pc.call('saveLineImage', lease, '00000000-0000-4000-8000-000000000999', `${a.householdId}/x.jpg`)).status).toBe(404)
  })
})
