import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, seedHouseholds } from '../schema/helpers'

// variant_summary の「同じ型番で最新の在庫」（名前・シリーズ・素材）の決め方。
// 取得日が新しい → 作成日時が新しい → 在庫コードが新しい、の順

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

async function addItem(
  tx: Transaction,
  o: { code: string; name: string; model: string; series?: string; acquired?: string; createdAt?: string },
): Promise<void> {
  await tx.query(
    `insert into app.inventory_item (item_code, name, landed_cost, acquired_at, model_code, series_code, created_at)
     values ($1, $2, 100, $3, $4, $5, coalesce($6::timestamptz, now()))`,
    [o.code, o.name, o.acquired ?? '2026-09-01', o.model, o.series ?? null, o.createdAt ?? null],
  )
}

async function summaryOf(model: string): Promise<{ name: string; series_code: string | null }> {
  return asApi(db, HH_A, async (tx) =>
    (await tx.query<{ name: string; series_code: string | null }>(
      'select name, series_code from app.variant_summary where model_code = $1', [model])).rows[0])
}

describe('最新の在庫の決め方', () => {
  it('取得日が新しい在庫が勝つ（作成日時や在庫コードが古くても）', async () => {
    await asApi(db, HH_A, async (tx) => {
      await addItem(tx, { code: 'S-0100', name: '新しい取得日', model: 'T1', series: 'new', acquired: '2026-09-10' })
      await addItem(tx, { code: 'S-0101', name: '古い取得日', model: 'T1', series: 'old', acquired: '2026-09-01' })
    })
    expect(await summaryOf('T1')).toEqual({ name: '新しい取得日', series_code: 'new' })
  })

  it('取得日が同じなら、作成日時が新しい在庫が勝つ（在庫コードが古くても）', async () => {
    await asApi(db, HH_A, async (tx) => {
      await addItem(tx, { code: 'S-0200', name: '後に作った', model: 'T2', createdAt: '2026-09-02T00:00:00Z' })
      await addItem(tx, { code: 'S-0201', name: '先に作った', model: 'T2', createdAt: '2026-09-01T00:00:00Z' })
    })
    expect((await summaryOf('T2')).name).toBe('後に作った')
  })

  it('取得日も作成日時も同じ（分割の子のように同着）なら、在庫コードが新しい方。桁数が増えても数の大小どおり', async () => {
    await asApi(db, HH_A, async (tx) => {
      // 同じトランザクションなので created_at は同一。S-9999 より S-10000 が新しい（文字列の比較だと逆になる）
      await addItem(tx, { code: 'S-0009', name: 'n9', model: 'T3' })
      await addItem(tx, { code: 'S-10000', name: 'n10000', model: 'T3' })
      await addItem(tx, { code: 'S-9999', name: 'n9999', model: 'T3' })
      await addItem(tx, { code: 'S-0010', name: 'n10', model: 'T3' })
    })
    expect((await summaryOf('T3')).name).toBe('n10000')
  })

  it('表示名（product_name）があればそれが name。シリーズ等は最新の在庫から', async () => {
    await asApi(db, HH_A, async (tx) => {
      await addItem(tx, { code: 'S-0300', name: '在庫の名前', model: 'T4', series: 's4' })
      await tx.query(`insert into app.product_name (model_code, name, updated_at) values ('T4', '人がつけた名前', now())`)
    })
    expect(await summaryOf('T4')).toEqual({ name: '人がつけた名前', series_code: 's4' })
  })

  it('メモだけで表示名が無い（name が NULL）なら、在庫の名前にもどる', async () => {
    await asApi(db, HH_A, async (tx) => {
      await addItem(tx, { code: 'S-0400', name: '在庫の名前', model: 'T5' })
      await tx.query(`insert into app.product_name (model_code, note, updated_at) values ('T5', 'メモ', now())`)
    })
    const r = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ name: string; custom_name: string | null; note: string | null }>(
        `select name, custom_name, note from app.variant_summary where model_code = 'T5'`)).rows[0])
    expect(r).toEqual({ name: '在庫の名前', custom_name: null, note: 'メモ' })
  })
})

describe('丸め：0 から遠い方へ（SQLite の round と同じ）', () => {
  it.each([
    // [売った 2 点の価格, 期待する avg_price]  平均 = (a+b)/2
    [[1000, 1001], 1001], // 1000.5 → 1001（偶数丸めなら 1000）
    [[1001, 1002], 1002], // 1001.5 → 1002
    [[1000, 1000], 1000],
    [[0, 1], 1], // 0.5 → 1
  ])('価格 %j の平均 → %i', async (prices, expected) => {
    const model = `R${prices.join('x')}`
    await asApi(db, HH_A, async (tx) => {
      for (const [i, price] of prices.entries()) {
        const code = `S-${model}-${i}`
        await addItem(tx, { code, name: '丸め', model })
        const sale = await tx.query<{ id: string }>(
          `insert into app.sale (title, sold_at, price, status) values ('丸め', '2026-09-15', $1, 'completed') returning id`, [price])
        const item = await tx.query<{ id: string }>('select id from app.inventory_item where item_code = $1', [code])
        await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [sale.rows[0].id, item.rows[0].id])
      }
    })
    const r = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ avg_price: number }>('select avg_price from app.variant_summary where model_code = $1', [model])).rows[0])
    expect(r.avg_price).toBe(expected)
  })

  it('負の平均もちょうど .5 なら 0 から遠い方：-1200.5 → -1201（偶数丸めなら -1200）', async () => {
    await asApi(db, HH_A, async (tx) => {
      for (const [i, profit] of [-1200, -1201].entries()) {
        const code = `S-NEG-${i}`
        await addItem(tx, { code, name: '赤字', model: 'NEG' })
        // 価格 0・原価 = -profit（addItem の原価 100 を上書き）
        await tx.query('update app.inventory_item set landed_cost = $1 where item_code = $2', [-profit, code])
        const sale = await tx.query<{ id: string }>(
          `insert into app.sale (title, sold_at, price, status) values ('赤字', '2026-09-15', 0, 'completed') returning id`)
        const item = await tx.query<{ id: string }>('select id from app.inventory_item where item_code = $1', [code])
        await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [sale.rows[0].id, item.rows[0].id])
      }
    })
    const r = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ avg_profit: number; total_profit: number }>(
        `select avg_profit, total_profit from app.variant_summary where model_code = 'NEG'`)).rows[0])
    expect(r).toEqual({ avg_profit: -1201, total_profit: -2401 })
  })
})
