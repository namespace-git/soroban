import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setSetting } from '../../domain/master'
import { upsertListings } from '../../domain/listing'
import {
  deleteSale, insertCollected, updateCollectedActuals, updateSaleStatus, updateYahooActuals,
} from '../../domain/sale'
import { todayJst } from '../../domain/_shared'
import type { Member } from '../domain/helpers'
import {
  closeFixture, count, leaseOf, openFixture, registerPc, resetWorld, startJob, type Fixture, type Pc,
} from './helpers'

// 段の書き込みが、デスクトップで同じ呼び出しをしたときと同じ行を作る（世帯 A＝agent の段、世帯 B＝ドメインを直接呼ぶ）。
// キーワード・削除済み・画像（変わったときだけ）・型番救済・購入日時

let f: Fixture
let a: Member
let b: Member
let pc: Pc
let lease: ReturnType<typeof leaseOf>

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
})

// ---- 行 ----

const sold = (id: string, over: Record<string, unknown> = {}) => ({
  mercariItemId: id, title: `【A037】商品 ${id}`, price: 3000, fee: 300, shippingFee: 210, otherCost: 0,
  soldAt: '2026-10-05', thumbUrl: `https://static.mercdn.net/thumb/${id}_1.jpg?1700000000`, ...over,
})

/** collector.ts の toRow */
const toRow = (s: ReturnType<typeof sold>) => ({
  mercariItemId: s.mercariItemId, title: s.title, price: s.price, soldAt: s.soldAt,
  fee: s.fee as number | null, shippingFee: s.shippingFee as number | null, otherCost: s.otherCost as number | null,
  status: 'completed' as const,
})

const yahoo = (id: string, over: Record<string, unknown> = {}) => ({
  yahooItemId: id, title: `【A037】ヤフ ${id}`, titleTruncated: false, price: 4000, fee: 0, shippingFee: 700 as number | null,
  bundleCount: null as number | null, soldAt: '2026-10-06', status: 'completed' as string | null,
  thumbUrl: `https://img.yahoo.test/${id}.jpg?1` as string | null, ...over,
})

const listingRow = (id: string, over: Record<string, unknown> = {}) => ({
  mercariItemId: id, title: `【A037】出品 ${id}`, price: 3000, suspended: false, thumbUrl: `https://static.mercdn.net/l/${id}.jpg?1`,
  updatedText: '3日前に更新', likes: 2, ...over,
})

const SALE_COLUMNS = `channel, channel_item_id, title, sold_at::text as sold_at, price, kind, fee_rate_bp, fee, fee_source, source,
  raw::text as raw, is_shipping_confirmed, model_codes, shipping_fee, shipping_source, status, shipped_at::text as shipped_at,
  delivered_at::text as delivered_at, completed_at::text as completed_at, expected_item_count`

async function saleSnap(householdId: string): Promise<Record<string, unknown>[]> {
  return (await f.dom.pg.query<Record<string, unknown>>(
    `select ${SALE_COLUMNS} from app.sale where household_id = $1 order by channel, channel_item_id`, [householdId])).rows
}

const sales = (m: Member) => count(f, 'select count(*)::int as n from app.sale where household_id = $1', m.householdId)
const saleId = async (m: Member, item: string): Promise<string> =>
  (await f.dom.pg.query<{ id: string }>('select id from app.sale where household_id = $1 and channel_item_id = $2', [m.householdId, item])).rows[0].id

/**
 * 販売を消す（取り込みの販売は sale_exclusion に残る）。id は先に引く：`m.run` の中（PGlite は接続が 1 本で、
 * トランザクション中は外の pg.query を待つ）で pg.query を呼ぶと固まる
 */
async function removeSale(m: Member, item: string): Promise<void> {
  const id = await saleId(m, item)
  await m.run((ctx) => deleteSale(ctx, id))
}

const setKeyword = (m: Member, key: 'mercari_keyword' | 'yahoo_keyword', value: string) => m.run((ctx) => setSetting(ctx, key, value))

describe('販売履歴（ingestSoldPage）', () => {
  it('新規：デスクトップの insertCollected と同じ行ができる（手数料・送料の実額・取引完了・型番）', async () => {
    const rows = [
      sold('m10000000001'),
      sold('m10000000002', { title: 'もこ山 スクイーズ（型番なし）', fee: null, shippingFee: 0, price: 1500 }),
      sold('m10000000003', { title: '【A035-1】×2 セット', shippingFee: null, otherCost: 50, thumbUrl: null }),
    ]
    const r = await pc.call('ingestSoldPage', lease, 1, rows)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.result).toMatchObject({
      already: false, inserted: 3, updated: 0, excluded_by_keyword: 0, excluded_deleted: 0, excluded_known_by_keyword: 0,
    })

    await b.run((ctx) => insertCollected(ctx, rows.map(toRow)))
    const snapA = await saleSnap(a.householdId)
    expect(snapA).toHaveLength(3)
    expect(snapA).toEqual(await saleSnap(b.householdId))
    // 実額が入り、送料 0 は「未入力」のまま
    expect(snapA[0]).toMatchObject({ fee: 300, fee_source: 'actual', shipping_fee: 210, is_shipping_confirmed: 1, status: 'completed', source: 'collector' })
    expect(snapA[1]).toMatchObject({ shipping_fee: 0, is_shipping_confirmed: 0, fee_source: 'rate' })
  })

  it('画像の対象は、サムネ URL のある新規だけ（kind: sale・元 URL つき）', async () => {
    const rows = [sold('m10000000001'), sold('m10000000003', { thumbUrl: null })]
    const r = await pc.call('ingestSoldPage', lease, 1, rows)
    expect(r.body.result.thumb_targets).toEqual([
      { kind: 'sale', channel_item_id: 'm10000000001', thumb_url: 'https://static.mercdn.net/thumb/m10000000001_1.jpg?1700000000' },
    ])
  })

  it('既知：実額・購入完了日で更新する（updateCollectedActuals と同じ結果）', async () => {
    // 先に取引中タブで入っていた販売（仮置きの日付・状態）
    const early = [{ mercariItemId: 'm10000000001', title: '【A037】商品', price: 3000, soldAt: todayJst(), status: 'waiting_shipment' as const }]
    await a.run((ctx) => insertCollected(ctx, early))
    await b.run((ctx) => insertCollected(ctx, early))

    const rows = [sold('m10000000001')]
    const r = await pc.call('ingestSoldPage', lease, 1, rows)
    expect(r.body.result).toMatchObject({ already: false, inserted: 0, updated: 1 })

    expect(await b.run((ctx) => updateCollectedActuals(ctx, rows.map(toRow)))).toBe(1)
    const snapA = await saleSnap(a.householdId)
    expect(snapA).toEqual(await saleSnap(b.householdId))
    expect(snapA[0]).toMatchObject({ sold_at: '2026-10-05', completed_at: '2026-10-05', status: 'completed', fee: 300, shipping_fee: 210 })
  })

  it('0 件のページは何も書かない（inserted: 0）。成功か empty かは PC が実行記録で決める', async () => {
    const r = await pc.call('ingestSoldPage', lease, 1, [])
    expect(r.body.result).toMatchObject({ already: false, inserted: 0, updated: 0, thumb_targets: [] })
    expect(await sales(a)).toBe(0)
  })

  it('キーワード：不一致の新規は入れず、詳細も画像の対象にもしない。既知は更新される', async () => {
    await setKeyword(a, 'mercari_keyword', 'a037')
    const rows = [sold('m10000000001'), sold('m10000000002', { title: '私物の本' }), sold('m10000000003', { title: 'ABC A037 大文字小文字' })]
    const r = await pc.call('ingestSoldPage', lease, 1, rows)
    expect(r.body.result).toMatchObject({ inserted: 2, excluded_by_keyword: 1 })
    expect(r.body.result.thumb_targets.map((t: { channel_item_id: string }) => t.channel_item_id).sort())
      .toEqual(['m10000000001', 'm10000000003'])
    expect(await sales(a)).toBe(2)

    // キーワードを変えた後、既に取り込んだ不一致の販売は更新はされるが、画像の対象にはならない
    await setKeyword(a, 'mercari_keyword', 'zzz')
    const again = await pc.call('ingestSoldPage', lease, 2, [sold('m10000000001', { fee: 310 })])
    expect(again.body.result).toMatchObject({ inserted: 0, updated: 1, excluded_known_by_keyword: 1, thumb_targets: [] })
  })

  it('削除した販売（sale_exclusion）は再取り込みしない', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    await removeSale(a, 'm10000000001')
    expect(await sales(a)).toBe(0)

    const r = await pc.call('ingestSoldPage', lease, 2, [sold('m10000000001'), sold('m10000000002')])
    expect(r.body.result).toMatchObject({ inserted: 1, excluded_deleted: 1 })
    expect(await saleSnap(a.householdId)).toHaveLength(1)
  })
})

describe('画像（変わったときだけ取り直す）', () => {
  const url = 'https://static.mercdn.net/thumb/m10000000001_1.jpg?1700000000'

  it('パスを確定すると次からは対象に出ない。URL のクエリ（更新時刻）が変わったときだけまた対象になる', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    const path = `${a.householdId}/sales/abc.jpg`
    const saved = await pc.call('saveThumb', lease, { kind: 'sale', channel_item_id: 'm10000000001', thumb_url: url, path })
    expect(saved.body.result).toEqual({ already: false })
    expect((await f.dom.pg.query('select thumb_path, thumb_src from app.sale where household_id = $1', [a.householdId])).rows[0])
      .toEqual({ thumb_path: path, thumb_src: url })

    const same = await pc.call('ingestSoldPage', lease, 2, [sold('m10000000001')])
    expect(same.body.result.thumb_targets).toEqual([])

    const changed = await pc.call('ingestSoldPage', lease, 3, [sold('m10000000001', { thumbUrl: url.replace('1700000000', '1800000000') })])
    expect(changed.body.result.thumb_targets).toHaveLength(1)
  })

  it('同じ元 URL の確定を送り直すと済み（二重に書かない）', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    const input = { kind: 'sale', channel_item_id: 'm10000000001', thumb_url: url, path: `${a.householdId}/sales/abc.jpg` }
    expect((await pc.call('saveThumb', lease, input)).body.result).toEqual({ already: false })
    // 同じ段に別のパスを送っても、先の確定を壊さない
    expect((await pc.call('saveThumb', lease, { ...input, path: `${a.householdId}/sales/other.jpg` })).body.result).toEqual({ already: true })
    const row = (await f.dom.pg.query<{ thumb_path: string }>('select thumb_path from app.sale where household_id = $1', [a.householdId])).rows[0]
    expect(row.thumb_path).toBe(`${a.householdId}/sales/abc.jpg`)
  })

  it('他の世帯のフォルダ・.. ・空のパス・相対パスは断る（400）。何も書かない', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    for (const path of [
      `${b.householdId}/sales/x.jpg`, `${a.householdId}/../${b.householdId}/x.jpg`, `${a.householdId}//x.jpg`, `${a.householdId}/./x.jpg`,
      'sales/x.jpg', '/etc/passwd', a.householdId, '', null, 123,
    ]) {
      const r = await pc.call('saveThumb', lease, { kind: 'sale', channel_item_id: 'm10000000001', thumb_url: url, path })
      expect(r.status, String(path)).toBe(400)
    }
    expect((await f.dom.pg.query('select thumb_path from app.sale where household_id = $1', [a.householdId])).rows[0]).toEqual({ thumb_path: null })
  })

  it('知らない販売・出品は 404', async () => {
    const path = `${a.householdId}/sales/abc.jpg`
    expect((await pc.call('saveThumb', lease, { kind: 'sale', channel_item_id: 'm99999999999', thumb_url: url, path })).status).toBe(404)
    expect((await pc.call('saveThumb', lease, { kind: 'listing', channel_item_id: 'm99999999999', thumb_url: url, path })).status).toBe(404)
  })

  it('出品の画像は、対になる販売にも同じ画像を書く（売れる前後で共有）', async () => {
    await pc.call('ingestListingsPage', lease, 'mercari', 1, [listingRow('m10000000001')])
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    const path = `${a.householdId}/listings/l.jpg`
    expect((await pc.call('saveThumb', lease, { kind: 'listing', channel_item_id: 'm10000000001', thumb_url: url, path })).status).toBe(200)
    const l = await f.dom.pg.query('select thumb_path from app.listing where household_id = $1', [a.householdId])
    const s = await f.dom.pg.query('select thumb_path from app.sale where household_id = $1', [a.householdId])
    expect(l.rows[0]).toEqual({ thumb_path: path })
    expect(s.rows[0]).toEqual({ thumb_path: path })
  })
})

describe('取引中（ingestTrading）', () => {
  const tr = (id: string, status: string | null, over: Record<string, unknown> = {}) =>
    ({ mercariItemId: id, title: `【A037】取引 ${id}`, price: 2000, status, thumbUrl: null, ...over })

  it('新規は入れ、既知は状態を前にだけ進める。文言が読めない行は数える（デスクトップと同じ呼び方の結果）', async () => {
    // 既知の販売を 2 つ（どちらも waiting_shipment）
    const known = [tr('m10000000001', 'waiting_shipment'), tr('m10000000002', 'waiting_shipment')]
    await a.run((ctx) => insertCollected(ctx, known.map((t) => ({ ...t, soldAt: todayJst() })) as never))
    await b.run((ctx) => insertCollected(ctx, known.map((t) => ({ ...t, soldAt: todayJst() })) as never))

    const rows = [
      tr('m10000000001', 'shipped'), // 前に進む
      tr('m10000000002', 'waiting_payment'), // 後戻り→無視
      tr('m10000000003', 'waiting_payment'), // 新規
      tr('m10000000004', null), // 新規・文言不明
    ]
    const r = await pc.call('ingestTrading', lease, rows)
    expect(r.body.result).toMatchObject({ already: false, inserted: 2, updated: 1, unknown_status: 1, excluded_by_keyword: 0, excluded_deleted: 0 })

    // B：collector が呼ぶ関数をそのまま
    await b.run(async (ctx) => {
      await updateSaleStatus(ctx, 'm10000000001', 'shipped')
      await updateSaleStatus(ctx, 'm10000000002', 'waiting_payment')
      await insertCollected(ctx, [
        { mercariItemId: 'm10000000003', title: '【A037】取引 m10000000003', price: 2000, soldAt: todayJst(), status: 'waiting_payment' },
        { mercariItemId: 'm10000000004', title: '【A037】取引 m10000000004', price: 2000, soldAt: todayJst(), status: null },
      ])
    })
    const snapA = await saleSnap(a.householdId)
    expect(snapA).toEqual(await saleSnap(b.householdId))
    expect(snapA.map((s) => s.status)).toEqual(['shipped', 'waiting_shipment', 'waiting_payment', null])
    // 計上日は今日の仮置き
    expect(snapA[2].sold_at).toBe(todayJst())
  })

  it('キーワード不一致は入れず、削除済みも入れない。画像の対象は絞り込み後の全部', async () => {
    await setKeyword(a, 'mercari_keyword', 'a037')
    const rows = [tr('m10000000001', 'waiting_shipment', { thumbUrl: 'https://x.test/1.jpg?1' }), tr('m10000000002', 'waiting_shipment', { title: '私物' })]
    const r = await pc.call('ingestTrading', lease, rows)
    expect(r.body.result).toMatchObject({ inserted: 1, excluded_by_keyword: 1 })
    expect(r.body.result.thumb_targets).toEqual([{ kind: 'sale', channel_item_id: 'm10000000001', thumb_url: 'https://x.test/1.jpg?1' }])

    await removeSale(a, 'm10000000001')
    // 別の取り込みの段（今回の job では trading は済みなので、新しい job で）
    await f.dom.pg.query(`delete from app.collect_job_stage where job_id = $1`, [lease.job_id])
    const again = await pc.call('ingestTrading', lease, rows)
    expect(again.body.result).toMatchObject({ inserted: 0, excluded_deleted: 1, excluded_by_keyword: 1 })
  })

  it('状態の値が不正なら 400', async () => {
    const r = await pc.call('ingestTrading', lease, [tr('m10000000001', 'bogus')])
    expect(r.status).toBe(400)
    expect(await sales(a)).toBe(0)
  })
})

describe('出品（ingestListingsPage）', () => {
  const LISTING_COLUMNS = `channel, channel_item_id, title, price, status, first_seen_at::text as first_seen_at, listed_at::text as listed_at, likes`
  const listingSnap = async (m: Member) => (await f.dom.pg.query<Record<string, unknown>>(
    `select ${LISTING_COLUMNS} from app.listing where household_id = $1 order by channel, channel_item_id`, [m.householdId])).rows

  it('新規・更新が upsertListings と同じ（出品日の推定・いいね数・出品停止）', async () => {
    const first = [listingRow('m10000000001'), listingRow('m10000000002', { updatedText: '12日前に更新', likes: null })]
    const r1 = await pc.call('ingestListingsPage', lease, 'mercari', 1, first)
    expect(r1.body.result).toMatchObject({ already: false, inserted: 2, updated: 0, released_listings: 0, released_items: 0 })
    await b.run((ctx) => upsertListings(ctx, first, 'mercari'))

    const second = [listingRow('m10000000001', { price: 2800, suspended: true }), listingRow('m10000000003')]
    const r2 = await pc.call('ingestListingsPage', lease, 'mercari', 2, second)
    expect(r2.body.result).toMatchObject({ inserted: 1, updated: 1 })
    await b.run((ctx) => upsertListings(ctx, second, 'mercari'))

    const snapA = await listingSnap(a)
    expect(snapA).toHaveLength(3)
    expect(snapA).toEqual(await listingSnap(b))
    expect(snapA[0]).toMatchObject({ price: 2800, status: 'suspended' })
  })

  it('画像の対象は kind: listing。キーワードに合う出品だけ入れる', async () => {
    await setKeyword(a, 'mercari_keyword', 'a037')
    const rows = [listingRow('m10000000001'), listingRow('m10000000002', { title: '私物' })]
    const r = await pc.call('ingestListingsPage', lease, 'mercari', 1, rows)
    expect(r.body.result).toMatchObject({ inserted: 1, excluded_by_keyword: 1 })
    expect(r.body.result.thumb_targets).toEqual([
      { kind: 'listing', channel_item_id: 'm10000000001', thumb_url: 'https://static.mercdn.net/l/m10000000001.jpg?1' },
    ])
    expect(await count(f, 'select count(*)::int as n from app.listing where household_id = $1', a.householdId)).toBe(1)
  })

  it('Yahoo!フリマは出品先ごとのキーワード（yahoo_keyword）で絞り、公開停止は見ない（active のまま）', async () => {
    await setKeyword(a, 'mercari_keyword', 'zzz') // メルカリ側のキーワードは効かない
    await setKeyword(a, 'yahoo_keyword', 'a037')
    const rows = [
      { mercariItemId: 'z10000000001', title: '【A037】ヤフ出品', price: 4000, suspended: true, thumbUrl: null, likes: 1, listedAt: '2026-09-30T10:00:00' },
      { mercariItemId: 'z10000000002', title: '私物', price: 100, suspended: false, thumbUrl: null },
    ]
    const r = await pc.call('ingestListingsPage', lease, 'yahoo', 1, rows)
    expect(r.body.result).toMatchObject({ inserted: 1, excluded_by_keyword: 1 })
    expect((await f.dom.pg.query('select channel, status, listed_at::text as listed_at from app.listing where household_id = $1', [a.householdId])).rows)
      .toEqual([{ channel: 'yahoo', status: 'active', listed_at: '2026-09-30' }])
  })

  it('出品先が不正なら 400', async () => {
    expect((await pc.call('ingestListingsPage', lease, 'amazon', 1, [])).status).toBe(400)
  })
})

describe('Yahoo!フリマの売上（ingestYahooSales）', () => {
  const toYahooInsert = (c: ReturnType<typeof yahoo>) => ({
    mercariItemId: c.yahooItemId, title: c.title, price: c.price, soldAt: c.soldAt, fee: c.fee,
    shippingFee: c.shippingFee, bundleCount: c.bundleCount, status: c.status as never,
  })

  it('新規は insertCollected(..., yahoo) と同じ行（実額の手数料 0 円・まとめ買いの点数）', async () => {
    // 実物のまとめ買いはタイトルが「＜まとめ買い＞」で始まる（でないと型番の自動紐付けが点数を 1 に書き直す。デスクトップと同じ）
    const rows = [yahoo('z10000000001'), yahoo('z10000000002', { title: '＜まとめ買い＞【A037】ヤフ z10000000002 ほか', bundleCount: 3, shippingFee: null, status: null })]
    const r = await pc.call('ingestYahooSales', lease, 1, rows)
    expect(r.body.result).toMatchObject({ already: false, inserted: 2, updated: 0, truncated_title_ids: [] })
    await b.run((ctx) => insertCollected(ctx, rows.map(toYahooInsert), 'yahoo'))
    const snapA = await saleSnap(a.householdId)
    expect(snapA).toEqual(await saleSnap(b.householdId))
    expect(snapA[0]).toMatchObject({ channel: 'yahoo', fee: 0, fee_source: 'actual' })
    expect(snapA[1]).toMatchObject({ expected_item_count: 3 })
  })

  it('既知は updateYahooActuals で更新する。切れたタイトルでは上書きしない', async () => {
    const first = [yahoo('z10000000001', { status: 'shipped', shippingFee: null })]
    await a.run((ctx) => insertCollected(ctx, first.map(toYahooInsert), 'yahoo'))
    await b.run((ctx) => insertCollected(ctx, first.map(toYahooInsert), 'yahoo'))

    const next = [yahoo('z10000000001', { title: '【A037】ヤフ 切れ', titleTruncated: true, fee: 100 })]
    const r = await pc.call('ingestYahooSales', lease, 1, next)
    expect(r.body.result).toMatchObject({ inserted: 0, updated: 1 })
    await b.run((ctx) => updateYahooActuals(ctx, next.map((c) => ({
      mercariItemId: c.yahooItemId, soldAt: c.soldAt, fee: c.fee, shippingFee: c.shippingFee, bundleCount: c.bundleCount,
      price: c.price, status: c.status as never, title: undefined,
    }))))
    expect(await saleSnap(a.householdId)).toEqual(await saleSnap(b.householdId))
  })

  it('キーワード：判定できる新規は絞る。タイトルが切れた行は判定せずに入れ、id を返す。既知はキーワードに関わらず更新', async () => {
    await setKeyword(a, 'yahoo_keyword', 'a037')
    const rows = [
      yahoo('z10000000001'),
      yahoo('z10000000002', { title: '私物の本' }),
      yahoo('z10000000003', { title: '私物の本（切れた商品名', titleTruncated: true }),
    ]
    const r = await pc.call('ingestYahooSales', lease, 1, rows)
    expect(r.body.result).toMatchObject({ inserted: 2, excluded_by_keyword: 1, truncated_title_ids: ['z10000000003'] })
    expect((await saleSnap(a.householdId)).map((s) => s.channel_item_id)).toEqual(['z10000000001', 'z10000000003'])
  })

  it('削除済みは入れない', async () => {
    await pc.call('ingestYahooSales', lease, 1, [yahoo('z10000000001')])
    await removeSale(a, 'z10000000001')
    const r = await pc.call('ingestYahooSales', lease, 2, [yahoo('z10000000001')])
    expect(r.body.result).toMatchObject({ inserted: 0, excluded_deleted: 1 })
  })
})

describe('型番救済・購入日時', () => {
  it('説明文を読む販売は、メルカリ・転売・未紐付け・型番なし・現在のキーワードに合うものだけ', async () => {
    await setKeyword(a, 'mercari_keyword', 'スクイーズ')
    await setKeyword(a, 'yahoo_keyword', 'スクイーズ')
    await pc.call('ingestSoldPage', lease, 1, [
      sold('m10000000001', { title: 'もこ山 スクイーズ A' }),
      sold('m10000000002', { title: 'もこ山 スクイーズ B' }),
      sold('m10000000003', { title: 'もこ山 スクイーズ【A037】' }), // 型番あり
    ])
    await pc.call('ingestYahooSales', lease, 1, [yahoo('z10000000001', { title: 'ヤフ スクイーズ' })]) // 出品先が違う

    const r = await pc.call('listSalesNeedingDetail', lease, 5)
    expect(r.status).toBe(200)
    expect(r.body.result.targets.map((t: { mercari_item_id: string }) => t.mercari_item_id).sort()).toEqual(['m10000000001', 'm10000000002'])
    expect(r.body.result.excluded_by_keyword).toBe(0)

    // limit で切る。キーワードを変えると、今のキーワードに合わない販売は対象外（件数は limit の前の全体）
    expect((await pc.call('listSalesNeedingDetail', lease, 1)).body.result.targets).toHaveLength(1)
    await setKeyword(a, 'mercari_keyword', 'zzz')
    const narrowed = (await pc.call('listSalesNeedingDetail', lease, 5)).body.result
    expect(narrowed.targets.map((t: { mercari_item_id: string }) => t.mercari_item_id)).toEqual([])
    expect(narrowed.excluded_by_keyword).toBe(2)
  })

  it('説明文から型番を拾って追記する（applySaleDescription）。拾えなくても段は済み。二重に追記しない', async () => {
    await setKeyword(a, 'mercari_keyword', 'スクイーズ')
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001', { title: 'もこ山 スクイーズ' }), sold('m10000000002', { title: 'もこ山 スクイーズ 2' })])
    const id1 = await saleId(a, 'm10000000001')
    const id2 = await saleId(a, 'm10000000002')

    const r = await pc.call('applySaleDescription', lease, id1, '新品です。型番【A037】で検索してください。')
    expect(r.body.result).toEqual({ already: false, codes_found: 1, applied: true })
    expect((await f.dom.pg.query('select model_codes from app.sale where id = $1', [id1])).rows[0]).toEqual({ model_codes: ['A037'] })

    expect((await pc.call('applySaleDescription', lease, id1, '【A037】')).body.result).toEqual({ already: true })
    // 変な値（検査に通らない段は記録されない）
    expect((await pc.call('applySaleDescription', lease, 'x', 'a')).status).toBe(400)
    expect((await pc.call('applySaleDescription', lease, id2, null)).status).toBe(400)
    expect((await pc.call('applySaleDescription', lease, id2, '型番は書いてありません')).body.result)
      .toEqual({ already: false, codes_found: 0, applied: false })
  })

  it('購入日時：取り直す販売を返し、保存すると対象から外れる。読めなかった（null）も試行済み。二度目は済み', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001'), sold('m10000000002'), sold('m10000000003')])
    const list = await pc.call('listSalesNeedingPurchasedAt', lease, 2)
    expect(list.body.result).toHaveLength(2)
    expect(Object.keys(list.body.result[0]).sort()).toEqual(['id', 'mercari_item_id'])

    const [one, two] = list.body.result as Array<{ id: string; mercari_item_id: string }>
    expect((await pc.call('setSalePurchasedAt', lease, one.id, '2026-10-03T14:05')).body.result).toEqual({ already: false })
    expect((await pc.call('setSalePurchasedAt', lease, two.id, null)).body.result).toEqual({ already: false })
    expect((await pc.call('setSalePurchasedAt', lease, one.id, '2026-10-01T00:00')).body.result).toEqual({ already: true })

    const row = (await f.dom.pg.query<{ purchased_at: string; purchased_at_checked: number }>(
      `select to_char(purchased_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as purchased_at, purchased_at_checked from app.sale where id = $1`, [one.id])).rows[0]
    expect(row).toEqual({ purchased_at: '2026-10-03T14:05', purchased_at_checked: 1 })
    expect((await f.dom.pg.query('select purchased_at_checked from app.sale where id = $1', [two.id])).rows[0]).toEqual({ purchased_at_checked: 1 })

    const rest = await pc.call('listSalesNeedingPurchasedAt', lease, 5)
    expect(rest.body.result).toHaveLength(1)
    // 変な値
    expect((await pc.call('setSalePurchasedAt', lease, rest.body.result[0].id, 'きのう')).status).toBe(400)
    expect((await pc.call('setSalePurchasedAt', lease, 'x', null)).status).toBe(400)
  })
})
