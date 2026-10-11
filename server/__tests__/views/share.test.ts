import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, seedHouseholds } from '../schema/helpers'
import { evenly } from './helpers'

// まとめ売りの 1 点あたりの按分（sale_line_share）の端数。
// 規則（CLAUDE.md「按分」）：floor(合計 / 点数) を配って、余りは末尾の行に 1 円ずつ。合計は必ず一致する。
// 「末尾」は紐付けた順（sale_line.allocation_order）。SQLite の rowid の置き換え

let db: PGlite
let seq = 0

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

interface Made {
  saleId: string
  /** 紐付けた順の sale_line.id */
  lineIds: string[]
}

/**
 * 販売 1 件と在庫 n 点を作り、紐付ける。粗利 = 価格 − 手数料 − 送料 − 梱包材 − 原価の合計。
 * 紐付ける順は、在庫の作成順・item_code・id のどれとも違う（逆順）にする
 */
async function makeBundle(
  tx: Transaction,
  n: number,
  price: number,
  totalCost: number,
  extra: { fee?: number; shipping?: number; packaging?: number } = {},
): Promise<Made> {
  const n0 = ++seq
  const sale = await tx.query<{ id: string }>(
    `insert into app.sale (title, sold_at, price, fee, shipping_fee, packaging_cost, status)
     values ($1, '2026-09-15', $2, $3, $4, $5, 'completed') returning id`,
    [`まとめ ${n0}`, price, extra.fee ?? 0, extra.shipping ?? 0, extra.packaging ?? 0],
  )
  const saleId = sale.rows[0].id
  const itemIds: string[] = []
  for (let i = 0; i < n; i++) {
    const item = await tx.query<{ id: string }>(
      `insert into app.inventory_item (item_code, name, landed_cost, acquired_at)
       values ($1, $2, $3, '2026-09-01') returning id`,
      [`S-${String(n0).padStart(4, '0')}-${i}`, `在庫 ${n0}-${i}`, i === 0 ? totalCost : 0],
    )
    itemIds.push(item.rows[0].id)
  }
  const lineIds: string[] = []
  for (const itemId of [...itemIds].reverse()) {
    const line = await tx.query<{ id: string }>(
      'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id',
      [saleId, itemId],
    )
    lineIds.push(line.rows[0].id)
  }
  return { saleId, lineIds }
}

interface Shares {
  price: number[]
  profit: number[]
}

async function sharesOf(tx: Transaction, made: Made): Promise<Shares> {
  const { rows } = await tx.query<{ sale_line_id: string; price_share: number; profit_share: number }>(
    'select sale_line_id, price_share, profit_share from app.sale_line_share where sale_id = $1',
    [made.saleId],
  )
  const by = new Map(rows.map((r) => [r.sale_line_id, r]))
  expect(rows.length).toBe(made.lineIds.length)
  return {
    price: made.lineIds.map((id) => by.get(id)!.price_share),
    profit: made.lineIds.map((id) => by.get(id)!.profit_share),
  }
}

describe('端数（均等割り）', () => {
  it('1,001 円 ÷ 3 点 は 333/334/334。合計は 1,001 円', async () => {
    const r = await asApi(db, HH_A, async (tx) => sharesOf(tx, await makeBundle(tx, 3, 1001, 0)))
    expect(r.price).toEqual([333, 334, 334])
    expect(r.price.reduce((a, b) => a + b, 0)).toBe(1001)
    expect(r.profit).toEqual([333, 334, 334]) // 原価 0・手数料 0 なので粗利も 1,001 円
  })

  it.each([
    // [点数, 合計(=価格または赤字の粗利), 期待する配り方]
    [1, 1001, [1001]],
    [2, 1001, [500, 501]],
    [3, 1001, [333, 334, 334]],
    [3, 1000, [333, 333, 334]],
    [3, 999, [333, 333, 333]],
    [3, 2, [0, 1, 1]],
    [3, 1, [0, 0, 1]],
    [3, 0, [0, 0, 0]],
    [4, 10, [2, 2, 3, 3]],
  ])('価格: %i 点で %i 円 → %j', async (n, price, expected) => {
    const r = await asApi(db, HH_A, async (tx) => sharesOf(tx, await makeBundle(tx, n, price, 0)))
    expect(r.price).toEqual(expected)
    expect(r.price).toEqual(evenly(price, n))
  })

  it.each([
    // 赤字（粗利が負）。床の割り算なので -1 ÷ 3 は -1/0/0、余りは末尾の行へ
    [3, -1, [-1, 0, 0]],
    [3, -2, [-1, -1, 0]],
    [3, -3, [-1, -1, -1]],
    [3, -1001, [-334, -334, -333]],
    [2, -1001, [-501, -500]],
    [1, -1001, [-1001]],
    [7, -2002, [-286, -286, -286, -286, -286, -286, -286]],
  ])('粗利が赤字: %i 点で %i 円 → %j', async (n, profit, expected) => {
    // 価格 0・原価の合計 -profit → 粗利 = profit
    const r = await asApi(db, HH_A, async (tx) => sharesOf(tx, await makeBundle(tx, n, 0, -profit)))
    expect(r.profit).toEqual(expected)
    expect(r.profit).toEqual(evenly(profit, n))
    expect(r.profit.reduce((a, b) => a + b, 0)).toBe(profit)
  })

  it('手数料・送料・梱包材・原価を引いた粗利を按分する：1,001 − 100 − 200 − 30 − 1,000 = -329 → -110/-110/-109', async () => {
    const r = await asApi(db, HH_A, async (tx) =>
      sharesOf(tx, await makeBundle(tx, 3, 1001, 1000, { fee: 100, shipping: 200, packaging: 30 })))
    expect(r.price).toEqual([333, 334, 334])
    expect(r.profit).toEqual([-110, -110, -109])
    expect(r.profit.reduce((a, b) => a + b, 0)).toBe(-329)
  })

  it('点数 1〜10 × 価格 × 原価 の総当たり：基準の実装と一致し、合計が価格・粗利と一致する', async () => {
    const ns = [1, 2, 3, 4, 5, 6, 7, 10]
    const prices = [0, 1, 2, 7, 1000, 1001, 10001, 999999]
    const costs = [0, 5, 1000, 5000, 123457]
    const cases = await asApi(db, HH_A, async (tx) => {
      const made: Array<{ n: number; price: number; cost: number; m: Made }> = []
      for (const n of ns) for (const price of prices) for (const cost of costs) {
        made.push({ n, price, cost, m: await makeBundle(tx, n, price, cost) })
      }
      const out: Array<{ n: number; price: number; cost: number; s: Shares; profit: number }> = []
      for (const c of made) {
        const sp = await tx.query<{ gross_profit: number; price: number; item_count: number }>(
          'select gross_profit, price, item_count from app.sale_profit where id = $1', [c.m.saleId])
        expect(sp.rows[0].item_count).toBe(c.n)
        out.push({ n: c.n, price: c.price, cost: c.cost, s: await sharesOf(tx, c.m), profit: sp.rows[0].gross_profit })
      }
      return out
    })
    expect(cases.length).toBe(ns.length * prices.length * costs.length)
    let remainderCases = 0
    for (const c of cases) {
      const label = `n=${c.n} 価格=${c.price} 原価=${c.cost}`
      expect(c.profit, label).toBe(c.price - c.cost)
      expect(c.s.price, label).toEqual(evenly(c.price, c.n))
      expect(c.s.profit, label).toEqual(evenly(c.profit, c.n))
      expect(c.s.price.reduce((a, b) => a + b, 0), label).toBe(c.price)
      expect(c.s.profit.reduce((a, b) => a + b, 0), label).toBe(c.profit)
      // 端数のある行ほど後ろ：先頭の行が最小、末尾の行が最大
      expect(Math.max(...c.s.price) - Math.min(...c.s.price), label).toBeLessThanOrEqual(1)
      expect(Math.max(...c.s.profit) - Math.min(...c.s.profit), label).toBeLessThanOrEqual(1)
      if (c.price % c.n !== 0 || c.profit % c.n !== 0) remainderCases++
    }
    expect(remainderCases).toBeGreaterThan(100)
    expect(cases.some((c) => c.profit < 0 && c.profit % c.n !== 0)).toBe(true)
  })
})

describe('余りが寄る行は、紐付けた順（allocation_order）で決まる', () => {
  it('作成時刻が同じ（同じトランザクション）でも、id の順・在庫の作成順と無関係に、紐付けた順で決まる', async () => {
    const { made, lines } = await asApi(db, HH_A, async (tx) => {
      const m = await makeBundle(tx, 3, 1001, 0) // 紐付けは在庫の逆順
      const l = await tx.query<{ id: string; created_at: string; allocation_order: string }>(
        `select id, created_at::text as created_at, allocation_order::text as allocation_order
           from app.sale_line where sale_id = $1 order by allocation_order`, [m.saleId])
      return { made: m, lines: l.rows }
    })
    // 3 行とも同じ時刻（now() はトランザクションの開始時刻）
    expect(new Set(lines.map((l) => l.created_at)).size).toBe(1)
    // allocation_order の昇順 = 紐付けた順
    expect(lines.map((l) => l.id)).toEqual(made.lineIds)
    // 端数（+1）は後ろの 2 行
    const shares = await asApi(db, HH_A, async (tx) => sharesOf(tx, made))
    expect(shares.price).toEqual([333, 334, 334])
  })

  it('別のトランザクションで 1 行ずつ紐付けても、紐付けた順が保たれる（途中に別の販売の紐付けが挟まっても）', async () => {
    const sale = await asApi(db, HH_A, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into app.sale (title, sold_at, price, status) values ('別々に紐付け', '2026-09-16', 1001, 'completed') returning id`)
      return r.rows[0].id
    })
    const lineIds: string[] = []
    for (let i = 0; i < 3; i++) {
      await asApi(db, HH_A, async (tx) => {
        const item = await tx.query<{ id: string }>(
          `insert into app.inventory_item (item_code, name, landed_cost, acquired_at)
           values ($1, '在庫', 0, '2026-09-01') returning id`, [`S-X-${i}-${++seq}`])
        const line = await tx.query<{ id: string }>(
          'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id', [sale, item.rows[0].id])
        lineIds.push(line.rows[0].id)
        // 間に別の販売の紐付けを挟む（allocation_order は欠番が出るが、順序は保たれる）
        await makeBundle(tx, 2, 100, 0)
      })
    }
    const shares = await asApi(db, HH_A, async (tx) => sharesOf(tx, { saleId: sale, lineIds }))
    expect(shares.price).toEqual([333, 334, 334])
  })
})
