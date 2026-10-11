import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// 在庫の金額：分割（splitInventory）は floor(合計/点数) を配って、余りは末尾の子に 1 円ずつ。合計は必ず親と一致する。
// 親の landed_cost は書き換えない。分割を戻しても（mergeSplitInventory）原価は動かない

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)

describe('在庫の金額（分割は合計が必ず一致する）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('いろいろな原価 × いろいろな分割数で、子の原価の合計が親と一致し、余りは末尾に 1 円ずつ寄る', async () => {
    const totals = [0, 1, 2, 3, 999, 1000, 1001, 1002, 12345, 1_000_001]
    const counts = [2, 3, 4, 7, 10, 100]
    for (const total of totals) {
      for (const count of counts) {
        const [id] = await db.createPurchaseItems({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: `分割${total}-${count}`, unit_price: total, quantity: 1 }],
        })
        const childIds = await db.splitInventory(id, count)
        const rows = await db.sql<{ id: string; landed_cost: number }>(
          'select id, landed_cost from inventory_item where parent_id = ?', id)
        const byId = new Map(rows.map(r => [r.id, r.landed_cost]))
        const costs = childIds.map(c => byId.get(c)!)
        const base = Math.floor(total / count)
        const rem = total - base * count
        // 合計は必ず親と一致する
        expect(costs.reduce((s, c) => s + c, 0), `${total}÷${count}`).toBe(total)
        // 先頭の (count - rem) 個は base、末尾の rem 個は base + 1
        expect(costs, `${total}÷${count}`).toEqual(Array.from({ length: count }, (_, i) => base + (i >= count - rem ? 1 : 0)))
        // 親の原価は書き換わっていない
        expect((await db.sqlGet<{ landed_cost: number }>('select landed_cost from inventory_item where id = ?', id))!.landed_cost).toBe(total)
      }
    }
  }, 120_000)

  it('負の原価（割引が商品代を超えた仕入）でも合計が一致する', async () => {
    const [id] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '値引き超過', unit_price: 0, quantity: 1 }],
    })
    await db.sqlRun('update inventory_item set landed_cost = -100 where id = ?', id)
    const childIds = await db.splitInventory(id, 3)
    const rows = await db.sql<{ id: string; landed_cost: number }>('select id, landed_cost from inventory_item where parent_id = ?', id)
    const byId = new Map(rows.map(r => [r.id, r.landed_cost]))
    const costs = childIds.map(c => byId.get(c)!)
    expect(costs).toEqual([-34, -33, -33])
    expect(costs.reduce((s, c) => s + c, 0)).toBe(-100)
  })

  it('分割 → 戻す → もう一度分割しても、子の在庫コードは新しく採番され（欠番は戻らない）、親の原価・コードは動かない', async () => {
    const [id] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '分割して戻す', unit_price: 1001, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    const first = await db.splitInventory(id, 3)
    const firstCodes = (await db.sql<{ item_code: string }>('select item_code from inventory_item where id = any(?::uuid[]) order by item_code', first))
      .map(r => r.item_code)
    expect(firstCodes).toEqual(['S-0002', 'S-0003', 'S-0004'])

    await db.mergeSplitInventory(id)
    const back = (await db.listInventory('in_stock'))[0]
    expect(back.id).toBe(parent.id)
    expect(back.item_code).toBe('S-0001')
    expect(back.landed_cost).toBe(1001)

    const second = await db.splitInventory(id, 2)
    const secondCodes = (await db.sql<{ item_code: string }>('select item_code from inventory_item where id = any(?::uuid[]) order by item_code', second))
      .map(r => r.item_code)
    expect(secondCodes).toEqual(['S-0005', 'S-0006'])
    const costs = (await db.sql<{ landed_cost: number }>('select landed_cost from inventory_item where parent_id = ? order by item_code', id))
      .map(r => r.landed_cost)
    expect(costs).toEqual([500, 501])
  })

  it('仕入の按分（送料の配賦）で出来た原価も、そのまま分割できる（端数は最後の子）', async () => {
    // 送料 100 円を 3 点に配賦 → 33 / 33 / 34、商品 1,000 円ずつ
    const items = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 100,
      lines: [{ name: '按分対象', unit_price: 1000, quantity: 3 }],
    })
    const costs = (await db.sql<{ landed_cost: number }>('select landed_cost from inventory_item order by item_code')).map(r => r.landed_cost)
    expect(costs).toEqual([1033, 1033, 1034])
    expect(costs.reduce((s, c) => s + c, 0)).toBe(3100)
    expect(items).toHaveLength(3)
    // 末尾の 1,034 円を 2 つに分ける → 517 / 517
    const children = await db.splitInventory(items[2], 2)
    const childCosts = (await db.sql<{ landed_cost: number }>('select landed_cost from inventory_item where id = any(?::uuid[]) order by item_code', children))
      .map(r => r.landed_cost)
    expect(childCosts).toEqual([517, 517])
  })
})
