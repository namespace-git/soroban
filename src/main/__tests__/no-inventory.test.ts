import { createCompletedSale } from './completed-sale'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { todayLocal } from '../../shared/date'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import * as db from '../db'
import * as views from '../views'

// 「在庫なしで確定」（sale.no_inventory）：売れて売上は入ったが、相手が受け取りを拒否して
// 商品だけ戻ってきた販売など、紐付ける在庫が無いものを、在庫 0 点・原価 ¥0 のまま
// 紐付け済み（sale_profit.unmatched = 0）にする。
//
// 数字はすべて手計算（手数料は既定の10%、floor）：
//   価格 3,000 → 手数料 300、送料 210、梱包材 40 → 在庫が無ければ粗利 3000 − 300 − 210 − 40 = 2,450
const MONTH = '2026-03'
const PRICE = 3000
const FEE = 300
const SHIPPING = 210
const PACKAGING = 40
const GROSS_NO_COST = PRICE - FEE - SHIPPING - PACKAGING // 2450

describe('在庫なしで確定（sale.no_inventory）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('在庫なし確認用')
  })

  /** 取引完了の転売。送料 210・梱包材 40 を入れて送料確定済みにする（未処理の理由を紐付けだけにするため） */
  function completedSale(title: string, soldAt = `${MONTH}-10`): string {
    const id = createCompletedSale({ title, sold_at: soldAt, price: PRICE })
    db.updateSale(id, { shipping_fee: SHIPPING, packaging_cost: PACKAGING })
    return id
  }

  /** 型番 code の在庫を qty 点（1 点 1,000 円）作って返す */
  function stock(code: string, qty: number) {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: `【${code}】戻り商品`, unit_price: 1000, quantity: qty }],
    })
    return db.listInventory('in_stock').filter(i => i.model_code === code)
  }

  const saleOf = (id: string) => db.listSales().find(s => s.id === id)!
  const itemStatus = (id: string) =>
    (db.getDb().prepare('SELECT status FROM inventory_item WHERE id = ?').get(id) as { status: string }).status
  const saleLineCount = (saleId: string) =>
    (db.getDb().prepare('SELECT COUNT(*) AS c FROM sale_line WHERE sale_id = ?').get(saleId) as { c: number }).c

  it('on：紐付け済みになり（unmatched=0）、原価 0・粗利 = 価格 − 手数料 − 送料 − 梱包材費。未処理・ホーム・月の明細の未紐付けから消える', () => {
    const target = completedSale('受け取り拒否で戻ってきた商品', `${MONTH}-12`)
    const other = completedSale('まだ未紐付けの商品', `${MONTH}-11`) // 比較用。未紐付けのまま残る

    const before = saleOf(target)
    expect(before.unmatched).toBe(1)
    expect(before.no_inventory).toBe(0)
    expect(db.listSales({ onlyPending: true }).map(s => s.id).sort()).toEqual([target, other].sort())
    expect(db.getDashboard().needsMatch).toBe(2)
    expect(db.getMonthDetail(MONTH).pending.unmatched).toBe(2)
    expect(views.getSalesProgress().inputs).toMatchObject({ needs_link: 2, done: 0 })

    db.setSaleNoInventory(target, true)

    const after = saleOf(target)
    expect(after.no_inventory).toBe(1)
    expect(after.unmatched).toBe(0)
    expect(after.item_count).toBe(0)
    expect(after.fee).toBe(FEE)
    expect(after.cost).toBe(0)
    expect(after.gross_profit).toBe(GROSS_NO_COST) // 2450
    expect(after.gross_profit).toBe(PRICE - after.fee - after.shipping_fee - after.packaging_cost - after.cost)

    // 未処理の絞り込み・ホームの未紐付け・月の明細・売上タブの進捗から、この販売だけ消える
    expect(db.listSales({ onlyPending: true }).map(s => s.id)).toEqual([other])
    expect(db.getDashboard().needsMatch).toBe(1)
    expect(db.getMonthDetail(MONTH).pending.unmatched).toBe(1)
    expect(views.getSalesProgress().inputs).toMatchObject({ needs_link: 1, done: 1 })
    // 比較用の販売は何も変わらない
    expect(saleOf(other).unmatched).toBe(1)
    expect(saleOf(other).no_inventory).toBe(0)
  })

  it('在庫が紐付いた販売で on：sale_line が全部消え、在庫は in_stock に戻り、原価は 0 になる', () => {
    const [item1, item2, untouched] = stock('A040', 3)
    const saleId = completedSale('受け取り拒否で戻ってきた商品')
    db.linkInventory(saleId, [item1.id, item2.id]) // まとめ売り 2 点（原価 1,000 × 2）

    const linked = saleOf(saleId)
    expect(linked.item_count).toBe(2)
    expect(linked.cost).toBe(2000)
    expect(linked.gross_profit).toBe(GROSS_NO_COST - 2000) // 450
    expect(itemStatus(item1.id)).toBe('sold')
    expect(itemStatus(item2.id)).toBe('sold')

    db.setSaleNoInventory(saleId, true)

    expect(saleLineCount(saleId)).toBe(0)
    expect(itemStatus(item1.id)).toBe('in_stock')
    expect(itemStatus(item2.id)).toBe('in_stock')
    expect(itemStatus(untouched.id)).toBe('in_stock')
    expect(db.listInventory('in_stock')).toHaveLength(3)

    const after = saleOf(saleId)
    expect(after.no_inventory).toBe(1)
    expect(after.unmatched).toBe(0)
    expect(after.item_count).toBe(0)
    expect(after.cost).toBe(0)
    expect(after.gross_profit).toBe(GROSS_NO_COST) // 2450
    // 1 点あたりの按分（sale_line_share）にもこの販売の行は残らない
    expect(
      (db.getDb().prepare('SELECT COUNT(*) AS c FROM sale_line_share WHERE sale_id = ?').get(saleId) as { c: number }).c,
    ).toBe(0)
  })

  it('型番が一致する在庫があっても、autoLinkPending は紐付けない（autoLinkSale も同じ）。off に戻せば紐付く', () => {
    // 在庫がまだ無いので、作った時点では自動紐付けされず未紐付けのまま
    const saleId = completedSale('【A040】戻ってきた商品')
    expect(saleOf(saleId).unmatched).toBe(1)
    db.setSaleNoInventory(saleId, true)

    const [item] = stock('A040', 1) // 型番が完全一致する在庫が後から入る
    expect(db.autoLinkPending()).toBe(0)
    expect(db.autoLinkSale(saleId)).toBe(false)
    expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    expect(saleLineCount(saleId)).toBe(0)
    expect(itemStatus(item.id)).toBe('in_stock')
    expect(saleOf(saleId).no_inventory).toBe(1)
    expect(saleOf(saleId).unmatched).toBe(0)

    // 対照：印を外せば、同じ販売が通常どおり自動紐付けの対象に戻る
    db.setSaleNoInventory(saleId, false)
    expect(db.autoLinkPending()).toBe(1)
    expect(saleLineCount(saleId)).toBe(1)
    expect(itemStatus(item.id)).toBe('sold')
  })

  it('off：未紐付けに戻る（unmatched=1）。外した在庫は戻さない。何度呼んでも同じ結果', () => {
    const [item] = stock('A041', 1)
    const saleId = completedSale('受け取り拒否で戻ってきた商品')
    db.linkInventory(saleId, [item.id])

    db.setSaleNoInventory(saleId, true)
    db.setSaleNoInventory(saleId, true) // 二度呼んでも同じ
    expect(saleOf(saleId)).toMatchObject({ no_inventory: 1, unmatched: 0, item_count: 0, cost: 0 })

    db.setSaleNoInventory(saleId, false)
    db.setSaleNoInventory(saleId, false) // 二度呼んでも同じ
    const after = saleOf(saleId)
    expect(after.no_inventory).toBe(0)
    expect(after.unmatched).toBe(1)
    expect(after.item_count).toBe(0)
    expect(after.gross_profit).toBe(GROSS_NO_COST)
    // 外した在庫は戻っていない（紐付け直さない）
    expect(saleLineCount(saleId)).toBe(0)
    expect(itemStatus(item.id)).toBe('in_stock')
    expect(db.listSales({ onlyPending: true }).map(s => s.id)).toEqual([saleId])
    expect(db.getDashboard().needsMatch).toBe(1)
  })

  it('on の販売に linkInventory すると no_inventory が 0 に戻り、原価が入る', () => {
    const [item] = stock('A042', 1)
    const saleId = completedSale('受け取り拒否で戻ってきた商品')
    db.setSaleNoInventory(saleId, true)
    expect(saleOf(saleId).no_inventory).toBe(1)

    // 何も紐付けない呼び出しでは印は動かない
    db.linkInventory(saleId, [])
    expect(saleOf(saleId).no_inventory).toBe(1)

    db.linkInventory(saleId, [item.id])

    const after = saleOf(saleId)
    expect(after.no_inventory).toBe(0)
    expect(after.unmatched).toBe(0)
    expect(after.item_count).toBe(1)
    expect(after.cost).toBe(1000)
    expect(after.gross_profit).toBe(GROSS_NO_COST - 1000) // 1450
    expect(itemStatus(item.id)).toBe('sold')
  })

  it('linkInventory が失敗した（紐付けられない在庫）ときは印を戻さない', () => {
    const [item] = stock('A043', 1)
    const firstSale = completedSale('先に売れた商品', `${MONTH}-05`)
    db.linkInventory(firstSale, [item.id]) // item は売却済み
    const saleId = completedSale('受け取り拒否で戻ってきた商品')
    db.setSaleNoInventory(saleId, true)

    expect(() => db.linkInventory(saleId, [item.id])).toThrow('販売済み・廃棄済みの在庫は紐付けられません')

    expect(saleOf(saleId)).toMatchObject({ no_inventory: 1, unmatched: 0, item_count: 0 })
    expect(saleOf(firstSale).item_count).toBe(1) // 先に売れた販売の紐付けも動かない
  })

  it('取引完了の on の販売は、monthly_summary に原価 0 で入る', () => {
    const saleId = completedSale('受け取り拒否で戻ってきた商品')
    db.setSaleNoInventory(saleId, true)

    const row = db.getDb().prepare(
      `SELECT sales_count, revenue, total_fee, total_shipping, total_packaging, total_cost, gross_profit
         FROM monthly_summary WHERE month = ? AND kind = 'resale'`,
    ).get(MONTH)
    expect(row).toEqual({
      sales_count: 1,
      revenue: PRICE,
      total_fee: FEE,
      total_shipping: SHIPPING,
      total_packaging: PACKAGING,
      total_cost: 0,
      gross_profit: GROSS_NO_COST,
    })

    const monthly = db.listMonthly().find(r => r.month === MONTH && r.kind === 'resale')!
    expect(monthly.total_cost).toBe(0)
    expect(monthly.gross_profit).toBe(GROSS_NO_COST)
  })

  it('販売が無ければ日本語のエラー（on でも off でも）', () => {
    expect(() => db.setSaleNoInventory('no-such-sale', true)).toThrow('販売が見つかりません')
    expect(() => db.setSaleNoInventory('no-such-sale', false)).toThrow('販売が見つかりません')
  })

  it('no_inventory は 0 か 1 だけ（CHECK）', () => {
    const saleId = completedSale('受け取り拒否で戻ってきた商品')
    expect(() => db.getDb().prepare('UPDATE sale SET no_inventory = 2 WHERE id = ?').run(saleId)).toThrow()
  })

  describe('getHealthChecks：「紐付けないまま 30 日」「出品に取られて紐付けられない」に数えない', () => {
    const daysAgo = (n: number): string =>
      todayLocal(new Date(Date.now() - n * 24 * 60 * 60 * 1000))

    it('unmatched-old：在庫なしで確定した販売は数えない（未紐付けのままの古い販売だけ数える）', () => {
      const confirmed = db.createSale({ title: '在庫なしで確定・古い', sold_at: daysAgo(35), price: 1000 })
      db.createSale({ title: '未紐付け・古い', sold_at: daysAgo(35), price: 1000 })
      expect(db.getHealthChecks().find(c => c.id === 'unmatched-old')?.count).toBe(2)

      db.setSaleNoInventory(confirmed, true)
      expect(db.getHealthChecks().find(c => c.id === 'unmatched-old')?.count).toBe(1)
    })

    it('listing-blocks-sale：在庫なしで確定した販売は数えない', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A040】もこ山 スクイーズ', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'm-noinv-1', title: '【A040】もこ山 スクイーズ', price: 3000, suspended: true, thumbUrl: null },
      ])
      db.reserveInventory('m-noinv-1', [item.id])
      const saleId = db.createSale({
        title: 'もこ山 スクイーズ【A040】', sold_at: '2026-01-10', price: 5750, channel: 'yahoo',
      })
      expect(db.getHealthChecks().find(c => c.id === 'listing-blocks-sale')?.count).toBe(1)

      db.setSaleNoInventory(saleId, true)
      expect(db.getHealthChecks().find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
    })
  })

  it('migrate：version34相当（sale.no_inventory が無い）→35 で列が足され、既存の販売は全部 0（印なし）。ビューも新しい列を持つ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-no-inventory-migrate-'))
    const path = join(dir, 'v34.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマ（最新コード）で作り、v34 相当（no_inventory が無い）まで剥がす
      const migrateShopId = db.createShopAccount('マイグレ確認')
      db.createPurchase({
        shop_account_id: migrateShopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '移行前の仕入', unit_price: 1000, quantity: 1 }],
      })
      const linkedItem = db.listInventory('in_stock')[0]
      const linkedSale = db.createSale({ title: '移行前・紐付け済み', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(linkedSale, [linkedItem.id])
      const unlinkedSale = db.createSale({ title: '移行前・未紐付け', sold_at: '2026-01-06', price: 2000 })

      db.getDb().exec(`
        DROP VIEW IF EXISTS sale_line_share;
        DROP VIEW IF EXISTS sale_profit;
        DROP VIEW IF EXISTS monthly_summary;
        DROP VIEW IF EXISTS inventory_view;
        DROP VIEW IF EXISTS variant_summary;
        ALTER TABLE sale DROP COLUMN no_inventory;
      `)
      db.getDb().prepare(`UPDATE setting SET value = '34' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('35')
      const saleColumns = db.getDb().prepare(`PRAGMA table_info('sale')`).all() as Array<{ name: string }>
      expect(saleColumns.map(c => c.name)).toContain('no_inventory')
      // ビューは起動のたびに作り直されるので、既存 DB でも新しい列を持つ
      const viewColumns = db.getDb().prepare(`PRAGMA table_info('sale_profit')`).all() as Array<{ name: string }>
      expect(viewColumns.map(c => c.name)).toEqual(expect.arrayContaining(['unmatched', 'no_inventory']))

      // 既存の販売は印なし（紐付け済みは紐付け済み、未紐付けは未紐付けのまま）
      expect(db.listSales().find(s => s.id === linkedSale)).toMatchObject({ no_inventory: 0, unmatched: 0, cost: 1000 })
      expect(db.listSales().find(s => s.id === unlinkedSale)).toMatchObject({ no_inventory: 0, unmatched: 1 })

      // 移行後は付け外しできる
      db.setSaleNoInventory(unlinkedSale, true)
      expect(db.listSales().find(s => s.id === unlinkedSale)).toMatchObject({ no_inventory: 1, unmatched: 0, cost: 0 })
      expect(() => db.getDb().prepare('UPDATE sale SET no_inventory = 2 WHERE id = ?').run(unlinkedSale)).toThrow()
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
