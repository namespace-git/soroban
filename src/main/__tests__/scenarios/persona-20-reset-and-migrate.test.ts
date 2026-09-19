import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { todayLocal } from '../../../shared/date'

beforeEach(() => { db.initDb(':memory:') })

// ペルソナ20：全部消して始め直す人。
// 一通りデータを作ってから resetData()、その後の再取り込み、
// そして「今のスキーマで作ったDBを閉じてもう一度開いても壊れない」ことを確かめる。
describe('ペルソナ20：全部消して始め直す人', () => {
  it('resetDataで販売・仕入・在庫・紐付け・実行記録が0、設定・仕入先・発送方法・タグは残る', () => {
    const shopId = db.createShopAccount('メロジョイA', 'mellojoy')
    const tagId = db.createTag('お気に入り')

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: todayLocal(),
      shipping_fee: 100,
      lines: [{ name: 'ぬいぐるみ【X100-1】', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    db.setInventoryTags(item.id, [tagId])

    const saleId = db.createSale({ title: 'ぬいぐるみ【X100-1】美品', price: 3000, sold_at: todayLocal() })
    db.setSaleTags(saleId, [tagId])

    const runId = db.startRun('mellojoy', shopId)
    db.finishRun(runId, 'ok', 1, 1)

    expect(db.listSales()).toHaveLength(1)
    expect(db.listSales()[0].item_count).toBe(1) // 型番完全一致で自動紐付け済み
    expect(db.listRuns()).toHaveLength(1)

    db.resetData()

    expect(db.listSales()).toHaveLength(0)
    expect(db.listPurchases()).toHaveLength(0)
    expect(db.listInventory('in_stock')).toHaveLength(0)
    expect(db.listInventory('sold')).toHaveLength(0)
    expect(db.listRuns()).toHaveLength(0)

    // マスタ（設定・仕入先・発送方法・タグ）は残る
    expect(db.listShopAccounts().some(a => a.id === shopId)).toBe(true)
    expect(db.listShippingMethods().length).toBeGreaterThan(0)
    expect(db.getSettings().fee_rate_bp).toBeDefined()
    // タグ自体は削除されない（付け外しの記録＝sale_tag/inventory_tagだけ消える）
    expect(db.listTags().some(t => t.id === tagId)).toBe(true)

    // その後もう一度取り込むと、同じ mercari_item_id が新規として入る
    const before = db.existingMercariIds(['m-x100'])
    expect(before.has('m-x100')).toBe(false)
    const inserted = db.insertCollected([
      { mercariItemId: 'm-x100', title: 'ぬいぐるみ 新品', price: 2000, soldAt: todayLocal() },
    ])
    expect(inserted).toHaveLength(1)
    expect(db.listSales()).toHaveLength(1)
    expect(db.existingMercariIds(['m-x100']).has('m-x100')).toBe(true)
  })

  it('今のスキーマで作ったDBを閉じてもう一度initDbしても壊れない（冪等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-persona20-'))
    const path = join(dir, 'test.db')
    try {
      db.initDb(path)
      const shopId = db.createShopAccount('冪等性チェック用')
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: todayLocal(),
        lines: [{ name: 'テスト商品', unit_price: 500, quantity: 1 }],
      })
      db.closeDb()

      // 再起動を模す：今のスキーマ（schema.sql + migrate()）で一度作ったDBを、
      // もう一度 initDb しても例外にならない
      expect(() => db.initDb(path)).not.toThrow()

      // データも読める。ビュー・トリガーも機能している
      const accounts = db.listShopAccounts()
      expect(accounts.some(a => a.id === shopId)).toBe(true)
      expect(db.listInventory('in_stock')).toHaveLength(1)
      expect(() => db.getDashboard()).not.toThrow()
      expect(() => db.listMonthly()).not.toThrow()

      // もう一度閉じて開いても壊れない（2回目の冪等性）
      db.closeDb()
      expect(() => db.initDb(path)).not.toThrow()
      expect(db.listShopAccounts().some(a => a.id === shopId)).toBe(true)

      db.closeDb()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
