import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handlers } from '../../rpc'
import '../../domain/inventory'
import '../../domain/listing'
import '../../domain/sale'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'

// 紐付けの核（在庫・出品・販売）の API。登録したメソッドの一覧と、「変な引数で 500 / 501 にならない」ことを
// 全メソッドに対して確かめる。個々の振る舞いは inventory / listing / sale / linking のテストにある

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
  w = await newWorld(dom)
})

afterAll(async () => {
  await dom.close()
})

/** この段で API として登録するメソッド（契約 SorobanApi の名前そのまま） */
const CORE_METHODS = [
  'listSales', 'saleTotals', 'createSale', 'updateSale', 'deleteSale',
  'linkInventory', 'autoLinkPending', 'unlinkInventory', 'getAutoLinkBlockers',
  'suggestInventory', 'suggestProductInventory', 'listSaleLines', 'estimateSaleProfit',
  'listSaleExclusions', 'removeSaleExclusion', 'setSaleTags',
  'listInventory', 'updateInventory', 'splitInventory', 'mergeSplitInventory',
  'disposeInventory', 'restoreInventory', 'setInventoryTags',
  'listListings', 'reserveInventory', 'unreserveInventory', 'suggestForListing',
  'endListing', 'autoReserveListings', 'setListingShipping',
] as const

/** 収集（PC のエージェント）が使う関数。export するだけで、画面向けの API には登録しない */
const COLLECTOR_ONLY = [
  'insertCollected', 'upsertListings', 'updateCollectedActuals', 'updateYahooActuals', 'updateSaleStatus',
  'applySaleActuals', 'appendModelCodes', 'setSalePurchasedAt', 'setSaleThumb', 'setListingThumb',
  'salesNeedingThumb', 'listingsNeedingThumb', 'salesWithoutThumb', 'listingsWithoutThumb',
  'salesNeedingPurchasedAt', 'existingMercariIds', 'hoursSinceLastOk', 'isMercariItemExcluded', 'saleMercariItemId',
  'takeOverListing',
]

describe('API の登録（在庫・出品・販売）', () => {
  it('契約のメソッド 30 本がすべて登録されている', () => {
    expect(CORE_METHODS).toHaveLength(30)
    for (const m of CORE_METHODS) expect(Object.prototype.hasOwnProperty.call(handlers, m), m).toBe(true)
  })

  it('収集が使う関数は API に登録されていない（画面から呼べない）', () => {
    for (const m of COLLECTOR_ONLY) expect(Object.prototype.hasOwnProperty.call(handlers, m), m).toBe(false)
  })

  const garbage: unknown[][] = [
    [],
    [null, null, null, null],
    ['x', 'x', 'x', 'x'],
    [123, 456, 789, 0],
    [{}, {}, {}, {}],
    [[], [], [], []],
    [true, false, true, false],
    ['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', 'x', -1],
    [{ __proto__: null, constructor: 'x' }, [Number.NaN], 1e308, 'a'.repeat(20_000)],
  ]

  it('どの引数の組を渡しても 500 / 501 にならない（変な型は 400、見つからなければ 404）', async () => {
    const bad: string[] = []
    for (const method of CORE_METHODS) {
      for (const args of garbage) {
        // JSON を通すのと同じ形にする（NaN は null、関数は落ちる）
        const sent = JSON.parse(JSON.stringify(args)) as unknown[]
        const r = await w.a.call(method, ...sent)
        if (r.status >= 500) bad.push(`${method}(${JSON.stringify(sent).slice(0, 60)}) → ${r.status} ${r.body.error?.message}`)
      }
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('何も渡さない読み取り系は 200 で空を返す（初期の世帯）', async () => {
    for (const method of ['listSales', 'listInventory', 'listListings', 'listSaleExclusions'] as const) {
      const r = await w.a.call(method)
      expect(r.status, method).toBe(200)
      expect(r.body.result, method).toEqual([])
    }
    const totals = await w.a.call('saleTotals')
    expect(totals.status).toBe(200)
    expect(totals.body.result).toMatchObject({ count: 0, revenue: 0, gross_profit: 0 })
    const auto = await w.a.call('autoLinkPending')
    expect(auto.body.result).toBe(0)
    const reserve = await w.a.call('autoReserveListings')
    expect(reserve.body.result).toBe(0)
  })

  it('認証されていない世帯の id では動かない：世帯 B の呼び出しは A の行に一切触れない', async () => {
    const created = await w.a.call('createSale', { title: 'Aの販売', sold_at: '2026-01-05', price: 1000 })
    expect(created.status).toBe(200)
    const id = created.body.result as string
    for (const [method, args] of [
      ['updateSale', [id, { price: 1 }]],
      ['setSaleTags', [id, []]],
      ['linkInventory', [id, []]],
    ] as const) {
      const r = await w.b.call(method, ...args)
      // linkInventory は空配列なら何もしない（見つからないと言う必要がない）。他は 404
      if (method === 'linkInventory') expect(r.status).toBe(200)
      else expect(r.status, method).toBe(404)
    }
    const listB = await w.b.call('listSales')
    expect(listB.body.result).toEqual([])
    const listA = await w.a.call('listSales')
    expect((listA.body.result as Array<{ price: number }>)[0].price).toBe(1000)
  })
})
