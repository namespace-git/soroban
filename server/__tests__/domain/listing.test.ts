import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { mapDbError } from '../../errors'
import * as listing from '../../domain/listing'
import { subtractDaysJst, todayJst } from '../../domain/_shared'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、出品（upsertListings / listListings / reserveInventory ほか）と
// 在庫の引き当てのテストを移したもの。期待値は変えていない。書き換えたのは「呼び方」と、次のものだけ：
//   * 同期の db.xxx(...) → await db.xxx(...)、expect(() => …).toThrow → await expect(…).rejects.toThrow
//   * db.createPurchase は SQL の直接投入（core-helpers の seedPurchase）。getPurchase(id).lines[0].items[0].id は createPurchaseItems
//   * todayLocal() → todayJst()（サーバーは UTC。出品日の推定も日本時間の暦日）
//   * 【変えた期待値】listedAt（絶対的な出品日時）が '2026-09-01T12:34' なら listed_at は '2026-09-01'。
//     listing.listed_at は date 列（契約も「出品日 YYYY-MM-DD」）なので、時刻は持たない。SQLite は TEXT で時刻つきのまま持っていた
//   * soroban-thumb://<file> → 公開 URL
//   * 出品のテストのうち getItemTimeline / getDashboard / deletePurchase は別のドメイン（2c・仕入）なので移していない
//   * migrate（SQLite のマイグレーション）は移していない

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)

describe('出品（listing）と在庫の引き当て', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('upsertListings：新規はinsert、既存はactive/suspendedなら更新、sold/endedは戻さない', async () => {
    const r1 = await db.upsertListings([
      { mercariItemId: 'L1', title: '商品A', price: 1000, suspended: false, thumbUrl: null },
      { mercariItemId: 'L2', title: '商品B', price: 2000, suspended: true, thumbUrl: null },
    ])
    expect(r1).toEqual({ inserted: 2, updated: 0, releasedListings: 0, releasedItems: 0 })

    const listings = await db.listListings()
    expect(listings.find(l => l.mercari_item_id === 'L1')!.status).toBe('active')
    expect(listings.find(l => l.mercari_item_id === 'L2')!.status).toBe('suspended')

    // 既存を更新（価格変更・公開停止解除）
    const r2 = await db.upsertListings([
      { mercariItemId: 'L1', title: '商品A', price: 1500, suspended: false, thumbUrl: null },
    ])
    expect(r2).toEqual({ inserted: 0, updated: 1, releasedListings: 0, releasedItems: 0 })
    expect((await db.listListings()).find(l => l.mercari_item_id === 'L1')!.price).toBe(1500)

    // 取り下げたものは一覧に出ていても active へ戻さない（1ページしか読まないため）
    await db.endListing('L2')
    const r3 = await db.upsertListings([
      { mercariItemId: 'L2', title: '商品B', price: 2000, suspended: false, thumbUrl: null },
    ])
    expect(r3).toEqual({ inserted: 0, updated: 0, releasedListings: 0, releasedItems: 0 })
    expect((await db.listListings({ status: ['ended'] }))[0].status).toBe('ended')
  })

  it('upsertListings：last_seen_atはISO形式（T・Zを含む）で返る（collector_run.finished_atとの文字列比較のため）', async () => {
    await db.upsertListings([
      { mercariItemId: 'LIso', title: 'ISO確認', price: 1000, suspended: false, thumbUrl: null },
    ])
    const row = (await db.listListings()).find(l => l.mercari_item_id === 'LIso')!
    expect(row.last_seen_at).toContain('T')
    expect(row.last_seen_at).toContain('Z')

    // 更新時も同様
    await db.upsertListings([
      { mercariItemId: 'LIso', title: 'ISO確認', price: 1200, suspended: false, thumbUrl: null },
    ])
    const updated = (await db.listListings()).find(l => l.mercari_item_id === 'LIso')!
    expect(updated.last_seen_at).toContain('T')
    expect(updated.last_seen_at).toContain('Z')
  })

  it('upsertListings：updatedTextからlisted_atを推定する。更新の巻き戻り（新しい候補）は無視し、より古い候補にだけ更新する。likesは毎回上書き', async () => {
    const daysAgo = (n: number) => subtractDaysJst(todayJst(), n)

    // 「5時間前」は0日扱い→ first_seen_atと同じ今日
    await db.upsertListings([
      {
        mercariItemId: 'LDate', title: '出品日推定', price: 1000, suspended: false, thumbUrl: null,
        updatedText: '5時間前に更新', likes: 10,
      },
    ])
    let l = (await db.listListings()).find(x => x.mercari_item_id === 'LDate')!
    expect(l.listed_at).toBe(todayJst())
    expect(l.first_seen_at).toBe(todayJst())
    expect(l.likes).toBe(10)

    // より古い候補（17日前）が来たら listed_at を巻き戻す
    await db.upsertListings([
      {
        mercariItemId: 'LDate', title: '出品日推定', price: 1000, suspended: false, thumbUrl: null,
        updatedText: '17日前に更新', likes: 12,
      },
    ])
    l = (await db.listListings()).find(x => x.mercari_item_id === 'LDate')!
    expect(l.listed_at).toBe(daysAgo(17))
    expect(l.likes).toBe(12)

    // 逆に新しい候補（1日前）が来ても、より古い方（17日前）のまま。likesは常に上書き
    await db.upsertListings([
      {
        mercariItemId: 'LDate', title: '出品日推定', price: 1000, suspended: false, thumbUrl: null,
        updatedText: '1日前に更新', likes: 15,
      },
    ])
    l = (await db.listListings()).find(x => x.mercari_item_id === 'LDate')!
    expect(l.listed_at).toBe(daysAgo(17))
    expect(l.likes).toBe(15)

    // updatedTextが取れなければ、挿入時は first_seen_at（今日）になる
    await db.upsertListings([
      {
        mercariItemId: 'LNoDate', title: '出品日不明', price: 1000, suspended: false, thumbUrl: null,
        updatedText: null, likes: null,
      },
    ])
    const noDate = (await db.listListings()).find(x => x.mercari_item_id === 'LNoDate')!
    expect(noDate.listed_at).toBe(todayJst())
    expect(noDate.likes).toBeNull()
  })

  it('upsertListings：「今日」は日本時間の暦日（UTC の 15:00〜23:59 は日本ではもう翌日）。17日前も日本の暦日から数える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 9, 15, 30, 0))) // JST 2026-03-10 00:30
    try {
      await db.upsertListings([
        { mercariItemId: 'LJst1', title: '深夜の新規', price: 1000, suspended: false, thumbUrl: null, updatedText: '5時間前に更新' },
        { mercariItemId: 'LJst2', title: '深夜の17日前', price: 1000, suspended: false, thumbUrl: null, updatedText: '17日前に更新' },
      ])
    } finally {
      vi.useRealTimers()
    }
    const ls = await db.listListings()
    expect(ls.find(l => l.mercari_item_id === 'LJst1')!.first_seen_at).toBe('2026-03-10')
    expect(ls.find(l => l.mercari_item_id === 'LJst1')!.listed_at).toBe('2026-03-10')
    expect(ls.find(l => l.mercari_item_id === 'LJst2')!.listed_at).toBe('2026-02-21')
  })

  it('upsertListings：listedAt（絶対的な出品日時。例：Yahoo!フリマのopentime）を渡すと新規行のlisted_atに優先して使われる（日付の部分）', async () => {
    await db.upsertListings([
      {
        mercariItemId: 'LAbs', title: '絶対日時あり', price: 1000, suspended: false, thumbUrl: null,
        updatedText: '5時間前に更新', // 相対推定なら today になるはずの値
        listedAt: '2026-09-01T12:34',
      },
    ])
    const l = (await db.listListings()).find(x => x.mercari_item_id === 'LAbs')!
    expect(l.listed_at).toBe('2026-09-01') // desktop は '2026-09-01T12:34'。date 列なので日付だけ
  })

  it('upsertListings：listedAtを渡さないときは今までどおり（updatedTextからの相対推定）', async () => {
    await db.upsertListings([
      {
        mercariItemId: 'LNoAbs', title: '絶対日時なし', price: 1000, suspended: false, thumbUrl: null,
        updatedText: '5時間前に更新',
      },
    ])
    const l = (await db.listListings()).find(x => x.mercari_item_id === 'LNoAbs')!
    expect(l.listed_at).toBe(todayJst())
  })

  it('upsertListings：既存行の更新ではlistedAtを渡しても上書きしない（出品日は後から変わらないはずという判断）', async () => {
    await db.upsertListings([
      {
        mercariItemId: 'LAbsKeep', title: '絶対日時あり', price: 1000, suspended: false, thumbUrl: null,
        listedAt: '2026-09-01T12:34',
      },
    ])
    let l = (await db.listListings()).find(x => x.mercari_item_id === 'LAbsKeep')!
    expect(l.listed_at).toBe('2026-09-01')

    // 2回目の収集で別のlistedAt（本来変わらないはずの値）が来ても、既存行は上書きしない
    await db.upsertListings([
      {
        mercariItemId: 'LAbsKeep', title: '絶対日時あり', price: 1200, suspended: false, thumbUrl: null,
        listedAt: '2026-09-05T09:00',
      },
    ])
    l = (await db.listListings()).find(x => x.mercari_item_id === 'LAbsKeep')!
    expect(l.listed_at).toBe('2026-09-01') // 上書きされない
    expect(l.price).toBe(1200) // price等の通常フィールドは今までどおり更新される
  })

  it('upsertListings：channelを渡すとlisting.channelに乗る（省略時mercari）。出品にもchannelが乗る', async () => {
    await db.upsertListings([{ mercariItemId: 'CHN-1', title: '出品チャンネル確認', price: 1500, suspended: false, thumbUrl: null }])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'CHN-1')!.channel).toBe('mercari')

    await db.upsertListings(
      [{ mercariItemId: 'YLST-1', title: 'Yahoo出品', price: 3000, suspended: false, thumbUrl: null }],
      'yahoo',
    )
    expect((await db.listListings()).find(l => l.mercari_item_id === 'YLST-1')!.channel).toBe('yahoo')
  })

  it('在庫のlisting派生オブジェクトにもchannelが乗る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '出品確認用【Z099-1】', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'CHN-2', title: '出品確認用【Z099-1】', price: 2000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('CHN-2', [item.id])

    const after = (await db.listInventory('in_stock')).find(i => i.id === item.id)!
    expect(after.listing).toEqual({ channel: 'mercari', mercari_item_id: 'CHN-2', price: 2000, status: 'active' })
  })

  it('reserveInventory：他の出品への引き当ては外れてこちらへ移る。売却済み在庫の引き当ては拒否する', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: '在庫A', unit_price: 1000, quantity: 1 },
        { name: '在庫B', unit_price: 1000, quantity: 1 },
      ],
    })
    const [itemA, itemB] = await db.listInventory('in_stock')

    await db.upsertListings([
      { mercariItemId: 'LA', title: '出品A', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'LB', title: '出品B', price: 3500, suspended: false, thumbUrl: null },
    ])

    await db.reserveInventory('LA', [itemA.id])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LA')!.items.map(i => i.id))
      .toEqual([itemA.id])

    // 他の出品(LA)に引き当て済みの在庫をLBへ移す：LAは未引き当てに戻り、LBに移る。在庫はin_stockのまま
    await db.reserveInventory('LB', [itemA.id])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LA')!.items).toEqual([])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LB')!.items.map(i => i.id))
      .toEqual([itemA.id])
    expect((await db.listInventory('in_stock')).some(i => i.id === itemA.id)).toBe(true)

    const saleId = await db.createSale({ title: '在庫B手動売却', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [itemB.id])
    await expect(db.reserveInventory('LB', [itemB.id])).rejects.toThrow('未販売の在庫だけ引き当てられます')
  })

  it('unreserveInventory：外すと在庫タブに戻り、他の出品へ引き当て直せる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '引き当て解除対象', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LA2', title: '出品A2', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'LB2', title: '出品B2', price: 3000, suspended: false, thumbUrl: null },
    ])

    await db.reserveInventory('LA2', [item.id])
    await db.unreserveInventory('LA2', item.id)
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LA2')!.items).toEqual([])

    await db.reserveInventory('LB2', [item.id])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LB2')!.items.map(i => i.id))
      .toEqual([item.id])
  })

  it('suggestForListing：型番一致 → 自分自身に引き当て済みの在庫は候補から除く', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 2 }],
    })
    const [item1, item2] = await db.listInventory('in_stock')
    await db.upsertListings([
      { mercariItemId: 'LZ', title: 'クリームわん【Z080-1】', price: 3000, suspended: false, thumbUrl: null },
    ])

    const suggestions = await db.suggestForListing('LZ')
    expect(suggestions.map(s => s.id).sort()).toEqual([item1.id, item2.id].sort())

    await db.reserveInventory('LZ', [item1.id])
    const after = await db.suggestForListing('LZ')
    expect(after.map(s => s.id)).toEqual([item2.id])
  })

  it('suggestForListing：他の出品に引き当て済みの在庫も候補に含み、listingに引き当て先が入る。reserveInventoryで移すと在庫はin_stockのまま', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z090-1】', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'SA', title: 'クリームわん【Z090-1】', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'SB', title: 'クリームわん【Z090-1】', price: 3200, suspended: false, thumbUrl: null },
    ])

    await db.reserveInventory('SA', [item.id])

    // SA自身の候補からは除かれる
    expect((await db.suggestForListing('SA')).map(s => s.id)).toEqual([])

    // SBの候補には、SAに引き当て済みのまま出る（listingに引き当て先が入る）
    const forB = await db.suggestForListing('SB')
    expect(forB.map(s => s.id)).toEqual([item.id])
    expect(forB[0].listing).toEqual({ channel: 'mercari', mercari_item_id: 'SA', price: 3000, status: 'active' })

    // SBへ移す：SAは未引き当てに戻り、SBに引き当て、在庫はin_stockのまま
    await db.reserveInventory('SB', [item.id])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'SA')!.items).toEqual([])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'SB')!.items.map(i => i.id))
      .toEqual([item.id])
    expect((await db.listInventory('in_stock')).some(i => i.id === item.id)).toBe(true)
  })

  it('listListings：reserved_cost・expected_profitが引き当てた在庫から出る。未引き当てはnull', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '出品対象', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LP', title: '出品対象', price: 3000, suspended: false, thumbUrl: null },
    ])

    const before = (await db.listListings()).find(l => l.mercari_item_id === 'LP')!
    expect(before.reserved_cost).toBe(0)
    expect(before.expected_profit).toBeNull()

    await db.reserveInventory('LP', [item.id])
    const after = (await db.listListings()).find(l => l.mercari_item_id === 'LP')!
    expect(after.reserved_cost).toBe(1000)
    // fee_rate_bp既定1000(10%) → fee=300、送料は引かない
    expect(after.expected_profit).toBe(3000 - 300 - 1000)

    expect((await db.listListings({ onlyUnallocated: true })).some(l => l.mercari_item_id === 'LP')).toBe(false)
  })

  it('listListings：Yahoo!フリマの出品は Yahoo の率（5%）で見込み粗利を出す', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '出品対象Y', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings(
      [{ mercariItemId: 'z10000002', title: '出品対象Y', price: 3000, suspended: false, thumbUrl: null }], 'yahoo',
    )
    await db.reserveInventory('z10000002', [item.id])
    const l = (await db.listListings()).find(x => x.mercari_item_id === 'z10000002')!
    expect(l.expected_profit).toBe(3000 - 150 - 1000)
  })

  it('setListingShipping：expected_profitに送料が反映され、売れたとき販売へ引き継がれる（実額があればactualを優先）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: '発送方法引き継ぎ対象', unit_price: 1000, quantity: 1 },
        { name: '発送方法引き継ぎ対象2', unit_price: 1000, quantity: 1 },
      ],
    })
    const [item1, item2] = await db.listInventory('in_stock')
    const method = (await db.listShippingMethods())[0]

    await db.upsertListings([
      { mercariItemId: 'mShip1', title: '発送方法引き継ぎ対象', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'mShip2', title: '発送方法引き継ぎ対象2', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'mShip3', title: '発送方法引き継ぎ対象3', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('mShip1', [item1.id])
    await db.reserveInventory('mShip2', [item2.id])
    await db.setListingShipping('mShip1', method.id)
    await db.setListingShipping('mShip2', method.id)

    // 出品一覧の見込み粗利にも発送方法の送料が反映される
    const listing1 = (await db.listListings()).find(l => l.mercari_item_id === 'mShip1')!
    expect(listing1.shipping_method_id).toBe(method.id)
    expect(listing1.shipping_method_name).toBe(method.name)
    expect(listing1.expected_profit).toBe(3000 - 300 - 1000 - method.fee)

    // mShip1：実額なしで取り込まれる → 発送方法（送料・確認済み）を引き継ぐ
    await db.insertCollected([
      { mercariItemId: 'mShip1', title: '発送方法引き継ぎ対象', price: 3000, soldAt: '2026-01-10' },
    ])
    const sale1 = (await db.listSales()).find(s => s.mercari_item_id === 'mShip1')!
    expect(sale1.shipping_method_id).toBe(method.id)
    expect(sale1.shipping_fee).toBe(method.fee)
    expect(sale1.is_shipping_confirmed).toBe(1)
    expect(sale1.shipping_source).toBe('manual')

    // mShip2：販売履歴の送料が ¥0（メルカリ便以外）で取り込まれる → 未確定なので出品時の発送方法を引き継ぐ
    await db.insertCollected([
      {
        mercariItemId: 'mShip2', title: '発送方法引き継ぎ対象2', price: 3000, soldAt: '2026-01-10',
        shippingFee: 0,
      },
    ])
    const sale2 = (await db.listSales()).find(s => s.mercari_item_id === 'mShip2')!
    expect(sale2.shipping_source).toBe('manual')
    expect(sale2.shipping_fee).toBe(method.fee)
    expect(sale2.shipping_method_id).toBe(method.id)
    expect(sale2.is_shipping_confirmed).toBe(1)

    // 次の取り込みで販売履歴の送料がまた ¥0 でも、引き継いだ発送方法は上書きされない
    await db.updateCollectedActuals([{ mercariItemId: 'mShip2', soldAt: '2026-01-10', fee: 300, shippingFee: 0 }])
    const sale2b = (await db.listSales()).find(s => s.mercari_item_id === 'mShip2')!
    expect(sale2b.shipping_source).toBe('manual')
    expect(sale2b.shipping_fee).toBe(method.fee)

    // mShip3：メルカリ便で実額 ¥500 → 出品時の発送方法より実額を優先
    await db.setListingShipping('mShip3', method.id)
    await db.insertCollected([
      { mercariItemId: 'mShip3', title: '発送方法引き継ぎ対象3', price: 3000, soldAt: '2026-01-10', shippingFee: 500 },
    ])
    const sale3 = (await db.listSales()).find(s => s.mercari_item_id === 'mShip3')!
    expect(sale3.shipping_source).toBe('actual')
    expect(sale3.shipping_fee).toBe(500)
  })

  it('setListingShipping：null で外せる。存在しない発送方法・出品は日本語で断る', async () => {
    await db.upsertListings([{ mercariItemId: 'mShipX', title: '発送方法', price: 3000, suspended: false, thumbUrl: null }])
    const method = (await db.listShippingMethods())[0]
    await db.setListingShipping('mShipX', method.id)
    expect((await db.listListings()).find(l => l.mercari_item_id === 'mShipX')!.shipping_method_id).toBe(method.id)
    await db.setListingShipping('mShipX', null)
    expect((await db.listListings()).find(l => l.mercari_item_id === 'mShipX')!.shipping_method_id).toBeNull()

    await expect(db.setListingShipping('mShipX', randomUUID())).rejects.toThrow('発送方法が見つかりません')
    await expect(db.setListingShipping('mNoSuch', method.id)).rejects.toThrow('出品が見つかりません')
    await expect(db.setListingShipping('mShipX', 'x')).rejects.toThrow('発送方法の指定が正しくありません')
  })

  it('insertCollected：出品への引き当てをそのまま販売に引き継ぐ（link_source=listing、出品はsoldに）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '出品済み商品', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'mTakeover', title: '出品済み商品', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('mTakeover', [item.id])

    await db.insertCollected([
      { mercariItemId: 'mTakeover', title: '出品済み商品', price: 3000, soldAt: '2026-01-10' },
    ])

    const s = (await db.listSales()).find(x => x.mercari_item_id === 'mTakeover')!
    expect(s.unmatched).toBe(0)
    expect(s.cost).toBe(1000)
    expect((await db.sql<{ link_source: string }>('select link_source from sale_line')).map(r => r.link_source)).toEqual(['listing'])

    const lines = await db.listSaleLines(s.id)
    expect(lines.map(l => l.id)).toEqual([item.id])

    // active/suspendedの一覧からは消え、soldとして残る
    expect((await db.listListings()).find(l => l.mercari_item_id === 'mTakeover')).toBeUndefined()
    const sold = (await db.listListings({ status: ['sold'] })).find(l => l.mercari_item_id === 'mTakeover')
    expect(sold?.status).toBe('sold')
  })

  it('insertCollected：キーワード不一致・型番なしのタイトルでも、出品への引き当てを引き継いだらkind=resaleになる', async () => {
    await db.setSetting('mercari_keyword', '限定コラボ') // タイトルはこれに一致しない
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '型番なしの雑貨', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'mTakeoverKind', title: '型番なしの雑貨', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('mTakeoverKind', [item.id])

    await db.insertCollected([
      { mercariItemId: 'mTakeoverKind', title: '型番なしの雑貨', price: 3000, soldAt: '2026-01-10' },
    ])

    const s = (await db.listSales()).find(x => x.mercari_item_id === 'mTakeoverKind')!
    // キーワード不一致・型番なしなら本来 personal 判定になるところを、人が出品に
    // 在庫を引き当てていた（＝転売の意思）ので resale にする
    expect(s.kind).toBe('resale')
    expect(s.cost).toBe(1000)
  })

  it('insertCollected：引き当てが無い出品が売れても出品はsoldになり、販売は型番FIFOで自動紐付けされる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z085-1】', unit_price: 1000, quantity: 1 }],
    })
    await db.upsertListings([
      { mercariItemId: 'mNoAlloc', title: 'クリームわん【Z085-1】', price: 3000, suspended: false, thumbUrl: null },
    ])
    // reserveInventoryはしない（未引き当てのまま出品が売れるケース）

    await db.insertCollected([
      { mercariItemId: 'mNoAlloc', title: 'クリームわん【Z085-1】', price: 3000, soldAt: '2026-01-10' },
    ])

    // 引き当てが無くても、売れた以上は出品タブ（active/suspended）に残さない
    expect((await db.listListings()).find(l => l.mercari_item_id === 'mNoAlloc')).toBeUndefined()
    const sold = (await db.listListings({ status: ['sold'] })).find(l => l.mercari_item_id === 'mNoAlloc')
    expect(sold?.status).toBe('sold')

    // takeOverListingが引き継げなかった（引き当て無し）ので、型番FIFOの自動確定にフォールバックする
    const s = (await db.listSales()).find(x => x.mercari_item_id === 'mNoAlloc')!
    expect(s.unmatched).toBe(0)
    expect(s.auto_linked).toBe(1)
    expect(s.cost).toBe(1000)
  })

  it('型番FIFOの自動確定は、他の出品に引き当て済みの在庫を候補から除く', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    const reservedItem = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LR', title: 'クリームわん【Z080-1】', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LR', [reservedItem.id])

    // 型番一致の在庫はこの1点だけだが、出品に引き当て済みなのでFIFOでは使われない
    const saleId = await db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-01-10', price: 2000 })
    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.unmatched).toBe(1)
    expect(s.auto_linked).toBe(0)

    const suggestions = await db.suggestInventory(saleId)
    expect(suggestions.some(i => i.id === reservedItem.id)).toBe(false)
  })

  it('endListing：在庫は未出品に戻り（引き当て解除）、出品はendedになる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '取り下げ対象', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LE', title: '取り下げ対象', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LE', [item.id])

    await db.endListing('LE')

    expect((await db.listInventory('in_stock')).find(i => i.id === item.id)!.listing).toBeNull()
    const ended = (await db.listListings({ status: ['ended'] })).find(l => l.mercari_item_id === 'LE')!
    expect(ended.status).toBe('ended')
    expect(ended.items).toEqual([])

    // 取り下げた在庫は別の出品に引き当て直せる
    await db.upsertListings([
      { mercariItemId: 'LE2', title: '再出品', price: 2500, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LE2', [item.id])
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LE2')!.items.map(i => i.id)).toEqual([item.id])
  })

  it('reserveInventory：終了済み（ended）の出品には引き当てられない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '終了済み出品対象', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LEndedGuard', title: '終了済み出品対象', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.endListing('LEndedGuard')

    await expect(db.reserveInventory('LEndedGuard', [item.id]))
      .rejects.toThrow('終了した出品には引き当てられません')

    // 拒否された結果、inventory_view に重複行が出ていない（在庫は1件のまま）
    expect((await db.listInventory('in_stock')).filter(i => i.id === item.id)).toHaveLength(1)
  })

  it('reserveInventory：sold（出品経由で売れた）出品にも引き当てられない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: '売却済み出品対象', unit_price: 1000, quantity: 1 },
        { name: '別の在庫', unit_price: 1000, quantity: 1 },
      ],
    })
    const [soldTarget, other] = await db.listInventory('in_stock')
    await db.upsertListings([
      { mercariItemId: 'LSoldGuard', title: '売却済み出品対象', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LSoldGuard', [soldTarget.id])
    await db.insertCollected([
      { mercariItemId: 'LSoldGuard', title: '売却済み出品対象', price: 3000, soldAt: '2026-01-10' },
    ])
    expect((await db.listListings({ status: ['sold'] })).find(l => l.mercari_item_id === 'LSoldGuard')?.status)
      .toBe('sold')

    await expect(db.reserveInventory('LSoldGuard', [other.id]))
      .rejects.toThrow('終了した出品には引き当てられません')
  })

  it('reserveInventory：存在しない出品・存在しない在庫・uuid でない在庫は日本語で断る。途中の 1 点が駄目なら 1 点も動かない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: '在庫1', unit_price: 1000, quantity: 1 },
        { name: '在庫2', unit_price: 1000, quantity: 1 },
      ],
    })
    const [a, b] = await db.listInventory('in_stock')
    await db.upsertListings([{ mercariItemId: 'LBad', title: '出品', price: 3000, suspended: false, thumbUrl: null }])
    await db.disposeInventory(b.id, '捨てた')

    await expect(db.reserveInventory('LNone', [a.id])).rejects.toThrow('終了した出品には引き当てられません')
    await expect(db.reserveInventory('LBad', [randomUUID()])).rejects.toThrow('在庫が見つかりません')
    await expect(db.reserveInventory('LBad', ['x'])).rejects.toThrow('在庫の指定が正しくありません')
    // a は引き当てられるが、b は廃棄済みなので、まとめて渡すと全部断られ、a も引き当たらない
    await expect(db.reserveInventory('LBad', [a.id, b.id])).rejects.toThrow('未販売の在庫だけ引き当てられます')
    expect((await db.listListings()).find(l => l.mercari_item_id === 'LBad')!.items).toEqual([])
  })

  it('出品に引き当て中の在庫を、同じ在庫で 2 つの出品に同時に握らせられない（DB のトリガーが最後の砦）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '二重引き当て', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LDup1', title: '出品1', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'LDup2', title: '出品2', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LDup1', [item.id])
    // domain の関数を通さず、直接 2 本目を入れようとするとトリガーが拒否する
    await expect(db.sqlRun(
      `insert into listing_line (listing_id, inventory_item_id)
       select id, ? from listing where channel_item_id = 'LDup2'`, item.id,
    )).rejects.toThrow('既に別の出品に引き当て済み')
  })

  it('suggestInventory / suggestForListing：includeSoldで売却済み（sold_to付き）も候補に含む。自分の販売に付いているものは除く', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: '在庫A', unit_price: 1000, quantity: 1 },
        { name: '在庫B', unit_price: 1000, quantity: 1 },
      ],
    })
    const [itemA, itemB] = await db.listInventory('in_stock')
    const sale1 = await db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
    await db.linkInventory(sale1, [itemA.id])

    // 通常は売却済みは候補に出ない
    const sale2 = await db.createSale({ title: '販売2', sold_at: '2026-01-06', price: 2000 })
    expect((await db.suggestInventory(sale2)).map(i => i.id)).not.toContain(itemA.id)

    // includeSoldで候補に出る。sold_toに元の販売が入る
    const withSold = await db.suggestInventory(sale2, 20, { includeSold: true })
    const found = withSold.find(i => i.id === itemA.id)
    expect(found).toBeTruthy()
    expect(found!.sold_to).toEqual({ sale_id: sale1, title: '販売1', price: 3000, sold_at: '2026-01-05' })

    // 自分自身（sale1）から見れば、自分に付いている在庫は候補に出ない
    const fromSale1 = await db.suggestInventory(sale1, 20, { includeSold: true })
    expect(fromSale1.map(i => i.id)).not.toContain(itemA.id)
    expect(fromSale1.map(i => i.id)).toContain(itemB.id)

    // suggestForListingも同様にincludeSoldで売却済みが候補に出る
    await db.upsertListings([
      { mercariItemId: 'INCL-1', title: '出品', price: 3000, suspended: false, thumbUrl: null },
    ])
    expect((await db.suggestForListing('INCL-1')).map(i => i.id)).not.toContain(itemA.id)
    expect((await db.suggestForListing('INCL-1', 20, { includeSold: true })).map(i => i.id)).toContain(itemA.id)
  })

  it('suggestForListing / suggestInventory：在庫コード一致 → 型番一致 → シリーズ一致 の順', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: 'シリーズだけ【Z074】', unit_price: 1000, quantity: 1 },
        { name: '型番が一致【Z074-3】', unit_price: 1000, quantity: 1 },
        { name: '在庫コードで一致', unit_price: 1000, quantity: 1 },
      ],
    })
    const items = await db.listInventory('in_stock')
    const byName = (n: string) => items.find(i => i.name === n)!
    const codeItem = byName('在庫コードで一致')
    await db.upsertListings([
      { mercariItemId: 'LRank', title: `いちごスフレ【Z074-3】【${codeItem.item_code}】`, price: 3000, suspended: false, thumbUrl: null },
    ])
    const ids = (await db.suggestForListing('LRank')).map(i => i.id)
    expect(ids.slice(0, 3)).toEqual([codeItem.id, byName('型番が一致【Z074-3】').id, byName('シリーズだけ【Z074】').id])
  })

  describe('autoReserveListings：出品への型番の完全一致・先入先出の自動引き当て', () => {
    it('枝番なしで在庫と完全一致（A037）の出品2件が在庫3点のうち古い順の2点に引き当たる。シリーズだけの型番（A035）は引き当たらない。既に引き当て済みは触らない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'メロージョイ Sサイズ【A037】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: 'メロージョイ Sサイズ【A037】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-03', shipping_fee: 0,
        lines: [{ name: 'メロージョイ Sサイズ【A037】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'メロージョイ ミニランド【A035-1】', unit_price: 1200, quantity: 1 }],
      })

      const a037items = (await db.listInventory('in_stock'))
        .filter(i => i.model_code === 'A037')
        .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at))
      expect(a037items).toHaveLength(3)
      const [oldest, middle, newest] = a037items

      // 3点目（最新）は先に別の出品へ引き当て済みにしておく（自動引き当てが横取りしないことの確認）
      await db.upsertListings([
        { mercariItemId: 'LAuto0', title: '既存引き当て済み', price: 2000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LAuto0', [newest.id])

      await db.upsertListings([
        { mercariItemId: 'LAuto1', title: 'メロージョイ Sサイズ【A037】', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LAuto2', title: 'メロージョイ Sサイズ【A037】', price: 3200, suspended: false, thumbUrl: null },
        {
          mercariItemId: 'LAutoA035', title: 'メロージョイ ミニランド【A035】', price: 1500,
          suspended: false, thumbUrl: null,
        },
      ])

      const count = await db.autoReserveListings()
      expect(count).toBe(2) // A035（在庫はA035-1でA035とは文字列一致しない）は対象外

      const l1 = (await db.listListings()).find(l => l.mercari_item_id === 'LAuto1')!
      const l2 = (await db.listListings()).find(l => l.mercari_item_id === 'LAuto2')!
      expect(l1.items.map(i => i.id)).toEqual([oldest.id])
      expect(l2.items.map(i => i.id)).toEqual([middle.id])

      // シリーズだけの型番（A035）は候補にならない
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LAutoA035')!.items).toEqual([])

      // 既に引き当て済みのものは触らない
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LAuto0')!.items.map(i => i.id))
        .toEqual([newest.id])

      // 対象が無くなったので再実行しても0
      expect(await db.autoReserveListings()).toBe(0)
    })

    it('同じ仕入の在庫（同着）でも、在庫コードの小さい順＝先に作った順に引き当たる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '同着【A090】', unit_price: 1000, quantity: 3 }],
      })
      const items = (await db.listInventory('in_stock')).sort((a, b) => a.item_code.localeCompare(b.item_code))
      await db.upsertListings([
        { mercariItemId: 'LTie1', title: '同着【A090】', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LTie2', title: '同着【A090】', price: 3000, suspended: false, thumbUrl: null },
      ])
      expect(await db.autoReserveListings()).toBe(2)
      const ls = await db.listListings()
      const held = [...ls.find(l => l.mercari_item_id === 'LTie1')!.items, ...ls.find(l => l.mercari_item_id === 'LTie2')!.items]
        .map(i => i.id).sort()
      expect(held).toEqual([items[0].id, items[1].id].sort())
      // 在庫コードの大きい 3 点目は残る
      expect((await db.suggestProductInventory('A090', 5))).toEqual([items[2].id])
    })

    it('在庫コード名指し（【S-0001】）と個数表記（×2）で引き当てる。在庫コードが先、型番は後', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: '名指し対象', unit_price: 1000, quantity: 1 },
          { name: '個数対象【A091】', unit_price: 1000, quantity: 3 },
        ],
      })
      const named = (await db.listInventory('in_stock')).find(i => i.name === '名指し対象')!
      await db.upsertListings([
        { mercariItemId: 'LCodeN', title: `名指し【${named.item_code}】`, price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LQty', title: '個数対象【A091】×2', price: 3000, suspended: false, thumbUrl: null },
      ])
      expect(await db.autoReserveListings()).toBe(2)
      const ls = await db.listListings()
      expect(ls.find(l => l.mercari_item_id === 'LCodeN')!.items.map(i => i.id)).toEqual([named.id])
      expect(ls.find(l => l.mercari_item_id === 'LQty')!.items).toHaveLength(2)
    })
  })

  describe('autoReserveListings：listingIds で対象を絞る（画面の絞り込みを無視して全件に走らないこと）', () => {
    it('listingIds を渡すと、その出品だけが引き当たる（渡していない未引き当ての出品はそのまま残る）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'りんご【A080】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'みかん【A081】', unit_price: 1000, quantity: 1 }],
      })
      await db.upsertListings([
        { mercariItemId: 'LFilterA', title: 'りんご【A080】', price: 2000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LFilterB', title: 'みかん【A081】', price: 2000, suspended: false, thumbUrl: null },
      ])

      const count = await db.autoReserveListings(['LFilterA'])
      expect(count).toBe(1)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LFilterA')!.items).toHaveLength(1)
      // 渡していないLFilterBは在庫があっても引き当たらない
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LFilterB')!.items).toEqual([])
    })

    it('空配列を渡すと0件で、未引き当ての出品は1件も引き当たらない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'くり【A082】', unit_price: 1000, quantity: 1 }],
      })
      await db.upsertListings([
        { mercariItemId: 'LFilterC', title: 'くり【A082】', price: 2000, suspended: false, thumbUrl: null },
      ])

      expect(await db.autoReserveListings([])).toBe(0)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LFilterC')!.items).toEqual([])
    })

    it('渡した id に、既に引き当て済み・型番が2個以上の出品が混ざっていてもエラーにならず、条件を満たすものだけ引き当たる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A083】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A084】', unit_price: 1000, quantity: 1 }],
      })
      await db.upsertListings([
        { mercariItemId: 'LFilterD', title: '対象【A083】', price: 2000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LFilterAlready', title: '既に引当済み', price: 2000, suspended: false, thumbUrl: null },
        {
          mercariItemId: 'LFilterTwo', title: '対象【A083】【A084】', price: 2000,
          suspended: false, thumbUrl: null,
        },
      ])
      const already = (await db.listInventory('in_stock')).find(i => i.model_code === 'A084')!
      await db.reserveInventory('LFilterAlready', [already.id])
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LFilterAlready')!.items).toHaveLength(1)

      const count = await db.autoReserveListings(['LFilterD', 'LFilterAlready', 'LFilterTwo'])
      expect(count).toBe(1)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LFilterD')!.items).toHaveLength(1)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LFilterTwo')!.items).toEqual([])
    })

    it('出品先（channel）が混ざった状態で、片方の出品先の id だけ渡したらもう片方は引き当たらない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'めるかり【A085】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'やふー【A086】', unit_price: 1000, quantity: 1 }],
      })
      await db.upsertListings(
        [{ mercariItemId: 'LMercari1', title: 'めるかり【A085】', price: 2000, suspended: false, thumbUrl: null }],
        'mercari',
      )
      await db.upsertListings(
        [{ mercariItemId: 'z10000001', title: 'やふー【A086】', price: 2000, suspended: false, thumbUrl: null }],
        'yahoo',
      )

      const count = await db.autoReserveListings(['LMercari1'])
      expect(count).toBe(1)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'LMercari1')!.items).toHaveLength(1)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'z10000001')!.items).toEqual([])
    })
  })

  describe('listingsNeedingThumb：サムネイルの差し替え判定', () => {
    it('listingに対しても salesNeedingThumb と同じ判定規則で動く', async () => {
      await db.upsertListings([
        { mercariItemId: 'lth-a', title: '未保存', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'lth-c', title: '差し替え', price: 1000, suspended: false, thumbUrl: null },
      ])
      await db.setListingThumb('lth-c', 'lth-c-old.jpg', 'https://example.com/lth-c-old.jpg')

      const targets = await db.listingsNeedingThumb([
        { mercariItemId: 'lth-a', thumbUrl: 'https://example.com/lth-a.jpg' },
        { mercariItemId: 'lth-c', thumbUrl: 'https://example.com/lth-c-new.jpg' },
      ])
      expect(targets.map(t => t.id)).toEqual(['lth-a', 'lth-c'])
    })

    it('(b)旧データ（thumb_srcが無い）は対象にせず src だけ記録する。listingsWithoutThumb は thumb_path が無いものだけ返す', async () => {
      await db.upsertListings([
        { mercariItemId: 'lth-b', title: '旧データ', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'lth-n', title: '未保存', price: 1000, suspended: false, thumbUrl: null },
      ])
      await db.sqlRun(`update listing set thumb_path = 'lth-b.jpg' where channel_item_id = 'lth-b'`)
      expect(await db.listingsNeedingThumb([{ mercariItemId: 'lth-b', thumbUrl: 'https://example.com/lth-b.jpg?w=1' }])).toEqual([])
      expect((await db.sqlGet<{ thumb_src: string }>(`select thumb_src from listing where channel_item_id = 'lth-b'`))!.thumb_src)
        .toBe('https://example.com/lth-b.jpg?w=1')
      expect(await db.listingsWithoutThumb(['lth-b', 'lth-n', 'lth-none'])).toEqual(['lth-n'])
    })
  })

  describe('出品停止中になったら引き当てを外す（auto_release_suspended）', () => {
    const makeItem = async (code = 'A037') => {
      const [id] = await db.createPurchaseItems({
        shop_account_id: shopId, ordered_at: '2026-04-01',
        lines: [{ name: `商品【${code}】`, unit_price: 1000, quantity: 1 }],
      })
      return id
    }
    const upsert = (id: string, suspended: boolean, channel: 'mercari' | 'yahoo' = 'mercari') =>
      db.upsertListings([{ mercariItemId: id, title: '止める出品', price: 3000, suspended, thumbUrl: null }], channel)
    const heldBy = async (id: string) =>
      (await db.listListings()).find(l => l.mercari_item_id === id)?.items.map(i => i.id) ?? []
    const itemStatus = async (id: string) =>
      (await db.sqlGet<{ status: string }>('select status from inventory_item where id = ?', id))!.status
    const saleLineCount = async () =>
      (await db.sqlGet<{ c: number }>('select count(*) as c from sale_line'))!.c

    it('設定の既定はオン（新規世帯）', async () => {
      expect((await db.getSettings()).auto_release_suspended).toBe('1')
    })

    it('active → suspended に変わった取り込みで引き当てが外れる。在庫の状態・sale_line は変わらない。件数が返る', async () => {
      const item = await makeItem()
      const soldItem = await makeItem('B001')
      const saleId = await db.createSale({ title: '販売済み', sold_at: '2026-04-05', price: 2000 })
      await db.linkInventory(saleId, [soldItem])
      await upsert('rel-1', false)
      await db.reserveInventory('rel-1', [item])
      const linesBefore = await saleLineCount()

      const r = await upsert('rel-1', true)

      expect(await heldBy('rel-1')).toEqual([])
      expect(r.releasedListings).toBe(1)
      expect(r.releasedItems).toBe(1)
      expect(await itemStatus(item)).toBe('in_stock')
      expect(await itemStatus(soldItem)).toBe('sold')
      expect(await saleLineCount()).toBe(linesBefore)
      expect((await db.listListings()).find(l => l.mercari_item_id === 'rel-1')?.status).toBe('suspended')
    })

    it('すでに suspended の出品に手で引き当て直しても、もう一度取り込んで suspended のままなら残る（毎回剥がさない）', async () => {
      const item = await makeItem()
      await upsert('keep-1', false)
      await db.reserveInventory('keep-1', [item])
      await upsert('keep-1', true) // ここで外れる
      expect(await heldBy('keep-1')).toEqual([])

      await db.reserveInventory('keep-1', [item]) // 人が手で引き当て直す
      const again = await upsert('keep-1', true)
      const third = await upsert('keep-1', true)

      expect(await heldBy('keep-1')).toEqual([item])
      expect(again.releasedListings).toBe(0)
      expect(again.releasedItems).toBe(0)
      expect(third.releasedListings).toBe(0)
    })

    it('設定がオフなら外れない', async () => {
      const item = await makeItem()
      await db.setSetting('auto_release_suspended', '0')
      await upsert('off-1', false)
      await db.reserveInventory('off-1', [item])

      const r = await upsert('off-1', true)

      expect(await heldBy('off-1')).toEqual([item])
      expect(r.releasedListings).toBe(0)
      expect(r.releasedItems).toBe(0)
    })

    it('suspended → active に戻ったときは何もしない（引き当てを作らない）', async () => {
      const item = await makeItem()
      await upsert('back-1', false)
      await db.reserveInventory('back-1', [item])
      await upsert('back-1', true)
      expect(await heldBy('back-1')).toEqual([])

      const r = await upsert('back-1', false)

      expect(await heldBy('back-1')).toEqual([])
      expect(r.releasedListings).toBe(0)
      expect(await itemStatus(item)).toBe('in_stock')
    })

    it('新規に suspended で入った出品・引き当てのない出品は0件で返る', async () => {
      expect(await upsert('new-susp', true)).toMatchObject({ inserted: 1, releasedListings: 0, releasedItems: 0 })
      await upsert('empty-1', false)
      expect(await upsert('empty-1', true)).toMatchObject({ updated: 1, releasedListings: 0, releasedItems: 0 })
    })

    it('複数点を握っていた出品は点数分が数えられ、他の出品の引き当ては残る', async () => {
      const a = await makeItem()
      const b = await makeItem()
      const c = await makeItem()
      await upsert('multi-1', false)
      await upsert('multi-2', false)
      await db.reserveInventory('multi-1', [a, b])
      await db.reserveInventory('multi-2', [c])

      const r = await db.upsertListings([
        { mercariItemId: 'multi-1', title: '止める出品', price: 3000, suspended: true, thumbUrl: null },
        { mercariItemId: 'multi-2', title: '止める出品', price: 3000, suspended: false, thumbUrl: null },
      ])

      expect(r.releasedListings).toBe(1)
      expect(r.releasedItems).toBe(2)
      expect(await heldBy('multi-1')).toEqual([])
      expect(await heldBy('multi-2')).toEqual([c])
    })

    it('yahoo の取り込みでは外さない', async () => {
      const item = await makeItem()
      await upsert('yh-1', false, 'yahoo')
      await db.reserveInventory('yh-1', [item])

      const r = await upsert('yh-1', true, 'yahoo')

      expect(await heldBy('yh-1')).toEqual([item])
      expect(r.releasedListings).toBe(0)
    })

    it('外れた在庫は、止めた出品に邪魔されず自動紐付けの候補になる', async () => {
      const item = await makeItem()
      await upsert('cand-1', false)
      await db.reserveInventory('cand-1', [item])
      expect(await db.suggestProductInventory('A037', 1)).toEqual([])

      await upsert('cand-1', true)

      expect(await db.suggestProductInventory('A037', 1)).toEqual([item])
    })
  })

  it('一覧：新しく見た出品が先頭。status の絞り込みと onlyUnallocated が効く', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 3, 0, 0)))
      await db.upsertListings([{ mercariItemId: 'o1', title: '古い', price: 100, suspended: false, thumbUrl: null }])
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 3, 3, 0, 0)))
      await db.upsertListings([{ mercariItemId: 'o2', title: '新しい', price: 100, suspended: true, thumbUrl: null }])
    } finally {
      vi.useRealTimers()
    }
    expect((await db.listListings()).map(l => l.mercari_item_id)).toEqual(['o2', 'o1'])
    expect((await db.listListings({ status: ['suspended'] })).map(l => l.mercari_item_id)).toEqual(['o2'])
    expect((await db.listListings({ status: [] })).map(l => l.mercari_item_id)).toEqual([])
    expect((await db.listListings({ onlyUnallocated: true })).map(l => l.mercari_item_id)).toEqual(['o2', 'o1'])
  })
})

describe('出品（listing）の引数の検査と世帯の分離', () => {
  const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
  const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)
  let itemA: string

  beforeEach(async () => {
    w = await newWorld(dom)
    const shop = await db.createShopAccount('A')
    ;[itemA] = await db.createPurchaseItems({
      shop_account_id: shop, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫【A001】', unit_price: 1000, quantity: 1 }],
    })
    await db.upsertListings([{ mercariItemId: 'mA1', title: '世帯Aの出品【A001】', price: 3000, suspended: false, thumbUrl: null }])
  })

  it('世帯 B からは A の出品が見えない・触れない（商品ID を知っていても）。B の出品に A の在庫は引き当てられない', async () => {
    expect(await asB((c) => listing.listListings(c))).toEqual([])
    await expect(asB((c) => listing.endListing(c, 'mA1'))).rejects.toThrow('出品が見つかりません')
    await expect(asB((c) => listing.setListingShipping(c, 'mA1', null))).rejects.toThrow('出品が見つかりません')
    await expect(asB((c) => listing.reserveInventory(c, 'mA1', [itemA]))).rejects.toThrow('終了した出品には引き当てられません')
    expect(await asB((c) => listing.suggestForListing(c, 'mA1'))).toEqual([])
    expect(await asB((c) => listing.autoReserveListings(c))).toBe(0)

    // B が同じ商品IDの出品を作っても、A の出品とは別（世帯ごとに独立）
    await asB((c) => listing.upsertListings(c, [{ mercariItemId: 'mA1', title: 'Bの出品', price: 1, suspended: false, thumbUrl: null }]))
    // B の出品に A の在庫は引き当てられない（在庫が見えない）
    await expect(asB((c) => listing.reserveInventory(c, 'mA1', [itemA]))).rejects.toThrow('在庫が見つかりません')

    // A の出品は何も変わっていない
    const a = (await db.listListings()).find(l => l.mercari_item_id === 'mA1')!
    expect(a.title).toBe('世帯Aの出品【A001】')
    expect(a.status).toBe('active')
    expect(a.items).toEqual([])
    // B の autoReserveListings は B の出品だけを見る。A の在庫は使わない
    expect(await asB((c) => listing.autoReserveListings(c))).toBe(0)
    // A は自分の出品に自分の在庫を引き当てられる
    expect(await db.autoReserveListings()).toBe(1)
  })

  it('変な型の引数は UserError（500 にならない）', async () => {
    await expect(asA((c) => listing.reserveInventory(c, 123 as never, [itemA]))).rejects.toThrow('出品は文字で入力してください')
    await expect(asA((c) => listing.reserveInventory(c, 'mA1', 'x' as never))).rejects.toThrow('在庫の形が正しくありません')
    await expect(asA((c) => listing.reserveInventory(c, 'mA1', ['x']))).rejects.toThrow('在庫の指定が正しくありません')
    await expect(asA((c) => listing.unreserveInventory(c, 'mA1', 'x'))).rejects.toThrow('在庫の指定が正しくありません')
    await expect(asA((c) => listing.listListings(c, { status: ['gone'] } as never))).rejects.toThrow('出品の状態の値が正しくありません')
    await expect(asA((c) => listing.listListings(c, { status: 'active' } as never))).rejects.toThrow('出品の状態の形が正しくありません')
    await expect(asA((c) => listing.autoReserveListings(c, 'mA1' as never))).rejects.toThrow('出品の形が正しくありません')
    await expect(asA((c) => listing.autoReserveListings(c, [1] as never))).rejects.toThrow('出品は文字で入力してください')
    await expect(asA((c) => listing.suggestForListing(c, 'mA1', 0))).rejects.toThrow('件数は1以上')
    await expect(asA((c) => listing.upsertListings(c, [{ mercariItemId: 'mX', title: 'x', price: 1.5, suspended: false, thumbUrl: null }])))
      .rejects.toThrow('出品の価格は整数で入力してください')
    await expect(asA((c) => listing.upsertListings(c, [], 'amazon' as never))).rejects.toThrow('出品先の値が正しくありません')
    expect((await db.listListings()).map(l => l.mercari_item_id)).toEqual(['mA1'])
  })

  it('API の入口（dispatch）経由：null の省略引数・オプション・他の世帯の出品 404', async () => {
    const list = await w.a.call('listListings', null)
    expect(list.status).toBe(200)
    expect((list.body.result as Array<{ mercari_item_id: string }>).map(l => l.mercari_item_id)).toEqual(['mA1'])

    const foreign = await w.b.call('endListing', 'mA1')
    expect(foreign.status).toBe(404)

    const bad = await w.a.call('reserveInventory', 'mA1', ['x'], null)
    expect(bad.status).toBe(400)
    expect(bad.body.error?.message).toBe('在庫の指定が正しくありません')

    const ok = await w.a.call('reserveInventory', 'mA1', [itemA], null)
    expect(ok.status).toBe(200)
    const suggest = await w.a.call('suggestForListing', 'mA1', null, null)
    expect(suggest.status).toBe(200)
    const auto = await w.a.call('autoReserveListings', null)
    expect(auto.body.result).toBe(0) // もう引き当て済み
    const none = await w.a.call('autoReserveListings', [])
    expect(none.body.result).toBe(0)
    const unreserve = await w.a.call('unreserveInventory', 'mA1', itemA)
    expect(unreserve.status).toBe(200)
    const shipping = await w.a.call('setListingShipping', 'mA1', null)
    expect(shipping.status).toBe(200)
    const end = await w.a.call('endListing', 'mA1')
    expect(end.status).toBe(200)
    expect((await db.listListings({ status: ['ended'] })).map(l => l.mercari_item_id)).toEqual(['mA1'])
  })

  it('引き当て中の在庫を持つ出品の商品IDが 2 つの出品先で衝突しても、各出品先の中では一意（同じ商品ID・別の出品先）', async () => {
    await db.upsertListings([{ mercariItemId: 'dupx', title: 'メルカリ側', price: 1, suspended: false, thumbUrl: null }], 'mercari')
    await db.upsertListings([{ mercariItemId: 'dupx', title: 'Yahoo側', price: 1, suspended: false, thumbUrl: null }], 'yahoo')
    expect((await db.listListings()).filter(l => l.mercari_item_id === 'dupx')).toHaveLength(2)
    // 直接 2 本目を同じ出品先に入れると一意制約。API の入口で日本語になる
    const err = await db.sqlRun(
      `insert into listing (channel, channel_item_id, title, price, first_seen_at, last_seen_at, listed_at)
       values ('mercari', 'dupx', 'x', 1, '2026-01-01', now(), '2026-01-01')`,
    ).then(() => null, (e: unknown) => e)
    expect(mapDbError(err)?.message).toBe('同じ商品IDの出品がすでにあります')
  })
})
