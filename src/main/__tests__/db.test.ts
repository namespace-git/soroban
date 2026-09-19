import { beforeEach, describe, expect, it, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import * as db from '../db'

describe('db（:memory:）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイA')
  })

  it('createPurchase：送料100・数量3の1行で在庫合計がpoolと一致する', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 100,
      lines: [{ name: 'テスト商品', unit_price: 1000, quantity: 3 }],
    })

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(3)

    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    // subtotal(1000*3=3000) + pool(100) = 3100 と一致するはず
    expect(totalLanded).toBe(3000 + 100)

    // 端数(100/3=33.33)は最後のアイテムに寄る
    const sorted = [...items].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(sorted.map(i => i.landed_cost)).toEqual([1033, 1033, 1034])
  })

  it('createPurchase：複数行でも明細ごと・全体の合計が一致する', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-02',
      shipping_fee: 100,
      other_cost: 50,
      discount: 20,
      lines: [
        { name: '商品A', unit_price: 1000, quantity: 2 },
        { name: '商品B', unit_price: 500, quantity: 3 },
      ],
    })

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(5)

    const subtotal = 1000 * 2 + 500 * 3
    const pool = 100 + 50 - 20
    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    expect(totalLanded).toBe(subtotal + pool)

    const purchases = db.listPurchases()
    expect(purchases[0].total_cost).toBe(subtotal + pool)
    expect(purchases[0].subtotal).toBe(subtotal)
  })

  it('createSale → linkInventory → listSaleLines / listSales の cost・gross_profit が正しい', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '売る商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]

    const saleId = db.createSale({
      title: '売る商品',
      sold_at: '2026-01-05',
      price: 2000,
    })
    db.linkInventory(saleId, [item.id])

    const lines = db.listSaleLines(saleId)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(item.id)

    const sales = db.listSales()
    const sale = sales.find(s => s.id === saleId)!
    expect(sale.cost).toBe(1000)
    // fee_rate_bp 既定1000(10%) → fee = floor(2000*1000/10000) = 200
    expect(sale.fee).toBe(200)
    expect(sale.gross_profit).toBe(2000 - 200 - 0 - 0 - 1000)
    expect(sale.unmatched).toBe(0)

    // 紐付けた在庫は sold になるので in_stock からは消える
    expect(db.listInventory('in_stock')).toHaveLength(0)
  })

  it('disposeInventory：personal_useでstatusが変わる／sold在庫は外せない', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '在庫X', unit_price: 500, quantity: 2 }],
    })
    const [item1, item2] = db.listInventory('in_stock')

    db.disposeInventory(item1.id, 'テスト理由', 'personal_use')
    const personalUse = db.listInventory('personal_use')
    expect(personalUse).toHaveLength(1)
    expect(personalUse[0].id).toBe(item1.id)

    // item2 を売って sold にしてから外そうとするとthrow
    const saleId = db.createSale({ title: '在庫X', sold_at: '2026-01-06', price: 1000 })
    db.linkInventory(saleId, [item2.id])
    expect(() => db.disposeInventory(item2.id, 'テスト')).toThrow()
  })

  it('splitInventory：landed_cost 1000 を3分割 → 333/333/334、親はsplitでin_stockから消える', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'ばら売り元', unit_price: 1000, quantity: 1 }],
    })
    const parent = db.listInventory('in_stock')[0]

    const childIds = db.splitInventory(parent.id, 3)
    expect(childIds).toHaveLength(3)

    // 親は split になり in_stock からは消える
    const inStock = db.listInventory('in_stock')
    expect(inStock).toHaveLength(3)
    expect(inStock.some(i => i.id === parent.id)).toBe(false)

    const splitList = db.listInventory('split')
    expect(splitList).toHaveLength(1)
    expect(splitList[0].id).toBe(parent.id)

    const sorted = [...inStock].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(sorted.map(i => i.landed_cost)).toEqual([333, 333, 334])
    expect(inStock.reduce((s, i) => s + i.landed_cost, 0)).toBe(1000)

    for (const child of inStock) expect(child.parent_id).toBe(parent.id)
  })

  it('自動紐付け：型番が完全一致すれば先入先出で自動確定、在庫が尽きたら未紐付けのまま', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 100,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-10',
      shipping_fee: 150,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })

    const items = db.listInventory('in_stock').sort((a, b) => a.acquired_at.localeCompare(b.acquired_at))
    expect(items.map(i => i.landed_cost)).toEqual([1100, 1150])

    const sale1 = db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-15', price: 2000 })
    const p1 = db.listSales().find(s => s.id === sale1)!
    expect(p1.cost).toBe(1100)
    expect(p1.auto_linked).toBe(1)
    expect(p1.unmatched).toBe(0)

    const sale2 = db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-16', price: 2000 })
    const p2 = db.listSales().find(s => s.id === sale2)!
    expect(p2.cost).toBe(1150)
    expect(p2.auto_linked).toBe(1)

    // 在庫が尽きたので3件目は未紐付けのまま
    const sale3 = db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-17', price: 2000 })
    const p3 = db.listSales().find(s => s.id === sale3)!
    expect(p3.unmatched).toBe(1)
    expect(p3.auto_linked).toBe(0)
  })

  it('シリーズ一致だけでは自動確定しない。候補の先頭には出る', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'いちごスフレの箱【Z074】', unit_price: 3000, quantity: 1 }],
    })
    const boxItem = db.listInventory('in_stock')[0]

    const saleId = db.createSale({ title: 'いちごスフレ【Z074-3】', sold_at: '2026-01-10', price: 1000 })
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(1)
    expect(sale.auto_linked).toBe(0)

    const suggestions = db.suggestInventory(saleId)
    expect(suggestions[0]?.id).toBe(boxItem.id)
  })

  it('複数型番（まとめ売り）は自動確定せず、両方が候補に出る', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 },
        { name: 'いちごスフレ【Z088-2】', unit_price: 1200, quantity: 1 },
      ],
    })
    const [itemA, itemB] = db.listInventory('in_stock')

    const saleId = db.createSale({
      title: '【Z080-1】【Z088-2】まとめ売り', sold_at: '2026-01-10', price: 3000,
    })
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(1)

    const candidateIds = db.suggestInventory(saleId).slice(0, 2).map(i => i.id).sort()
    expect(candidateIds).toEqual([itemA.id, itemB.id].sort())
  })

  it('私物判定：キーワード未設定なら型番の有無、設定していればキーワードの有無で判定する', () => {
    db.insertCollected([
      { mercariItemId: 'm1', title: '私物の売却です', price: 1000, soldAt: '2026-01-01' },
      { mercariItemId: 'm2', title: 'クリームわん【Z080-1】', price: 2000, soldAt: '2026-01-02' },
    ])
    const salesNoKeyword = db.listSales()
    expect(salesNoKeyword.find(s => s.mercari_item_id === 'm1')!.kind).toBe('personal')
    expect(salesNoKeyword.find(s => s.mercari_item_id === 'm2')!.kind).toBe('resale')

    db.setSetting('mercari_keyword', '限定')
    db.insertCollected([
      { mercariItemId: 'm3', title: '限定コラボ【Z080-1】', price: 2000, soldAt: '2026-01-03' },
      { mercariItemId: 'm4', title: 'クリームわん【Z080-1】', price: 2000, soldAt: '2026-01-04' },
    ])
    const salesWithKeyword = db.listSales()
    expect(salesWithKeyword.find(s => s.mercari_item_id === 'm3')!.kind).toBe('resale')
    // 型番はあるがキーワードを含まないので私物扱い
    expect(salesWithKeyword.find(s => s.mercari_item_id === 'm4')!.kind).toBe('personal')
  })

  it('下書き→確定：在庫は確定するまで作られず、按分後原価の合計が明細合計+送料と一致する', () => {
    const draftId = db.createPurchaseDraft({
      import_key: 'mellojoy-watch/2026-01-01-001',
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [
        { name: 'クリームわん【Z080-1】', quantity: 2 },
        { name: 'いちごスフレ【Z072-8】', quantity: 1 },
      ],
    })
    expect(draftId).not.toBe('')
    expect(db.listInventory('in_stock')).toHaveLength(0)
    expect(db.getDashboard().needsPurchaseConfirm).toBe(1)

    // 同じ import_key は積み直さない
    const dup = db.createPurchaseDraft({
      import_key: 'mellojoy-watch/2026-01-01-001',
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [{ name: 'クリームわん【Z080-1】', quantity: 2 }],
    })
    expect(dup).toBe('')
    expect(db.listPurchases()).toHaveLength(1)
    expect(db.getDashboard().needsPurchaseConfirm).toBe(1)

    const detail = db.getPurchase(draftId)
    expect(detail.status).toBe('draft')
    expect(detail.lines.map(l => l.model_code)).toEqual(['Z080-1', 'Z072-8'])

    db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 300,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 2 },
        { name: 'いちごスフレ【Z072-8】', unit_price: 1500, quantity: 1 },
      ],
    })

    const confirmed = db.getPurchase(draftId)
    expect(confirmed.status).toBe('confirmed')
    const subtotal = 1000 * 2 + 1500 * 1
    expect(confirmed.total_cost).toBe(subtotal + 300)

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(3)
    expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(subtotal + 300)
    expect(db.getDashboard().needsPurchaseConfirm).toBe(0)

    // 確定済みを再確定しようとすると例外（landed_cost は後から書き換えない）
    expect(() => db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [{ name: 'x', unit_price: 1, quantity: 1 }],
    })).toThrow()
  })

  it('applySaleActuals：実額を反映してshipping_source=actual・is_shipping_confirmed=1になる', () => {
    const saleId = db.createSale({ title: '実額テスト', sold_at: '2026-01-01', price: 2000 })
    db.applySaleActuals(saleId, { fee: 180, shipping_fee: 300 })

    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.shipping_source).toBe('actual')
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(sale.fee).toBe(180)
    expect(sale.shipping_fee).toBe(300)
    expect(sale.gross_profit).toBe(2000 - 180 - 300 - 0 - 0)
  })

  it('variant_summary：purchased/sold/avg_price/avg_profit/total_profitが手計算と一致する', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 100,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-10',
      shipping_fee: 150,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-15', price: 2000 })
    db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-16', price: 2000 })

    const summary = db.listVariantSummary().find(v => v.model_code === 'Z080-1')!
    expect(summary.purchased).toBe(2)
    expect(summary.sold).toBe(2)
    expect(summary.in_stock).toBe(0)
    // 手数料10%: fee=200 → gross_profit = 2000-200-cost
    // cost: 1100, 1150 → gross_profit: 700, 650
    expect(summary.avg_price).toBe(2000)
    expect(summary.avg_profit).toBe(Math.round((700 + 650) / 2))
    expect(summary.total_profit).toBe(700 + 650)
  })

  it('migrate：Phase1形式のDBに新列・splitステータス・新設定が使えるようになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-migrate-'))
    const path = join(dir, 'legacy.db')

    try {
      const legacy = new BetterSqlite3(path)
      legacy.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE shop_account (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE shipping_method (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, carrier TEXT, fee INTEGER NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO setting (key, value) VALUES
          ('fee_rate_bp', '1000'), ('transfer_fee', '200'),
          ('aging_warn_days', '90'), ('collect_interval_h', '6');

        CREATE TABLE purchase (
          id TEXT PRIMARY KEY, shop_account_id TEXT NOT NULL REFERENCES shop_account(id),
          ordered_at TEXT NOT NULL, order_no TEXT,
          shipping_fee INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0,
          other_cost INTEGER NOT NULL DEFAULT 0,
          alloc_method TEXT NOT NULL DEFAULT 'by_amount' CHECK (alloc_method IN ('by_amount','by_quantity')),
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (shop_account_id, order_no)
        );
        CREATE TABLE purchase_line (
          id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
          name TEXT NOT NULL, unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),
          allocated_cost INTEGER NOT NULL DEFAULT 0, landed_unit_cost INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE inventory_item (
          id TEXT PRIMARY KEY, purchase_line_id TEXT REFERENCES purchase_line(id) ON DELETE CASCADE,
          name TEXT NOT NULL, landed_cost INTEGER NOT NULL, acquired_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'in_stock'
                 CHECK (status IN ('in_stock','sold','disposed','personal_use')),
          disposed_at TEXT, disposed_note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE sale (
          id TEXT PRIMARY KEY, mercari_item_id TEXT UNIQUE, title TEXT NOT NULL,
          sold_at TEXT NOT NULL, price INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'resale' CHECK (kind IN ('resale','personal')),
          fee_rate_bp INTEGER NOT NULL DEFAULT 1000, fee INTEGER NOT NULL DEFAULT 0,
          shipping_method_id TEXT REFERENCES shipping_method(id),
          shipping_fee INTEGER NOT NULL DEFAULT 0, packaging_cost INTEGER NOT NULL DEFAULT 0,
          is_shipping_confirmed INTEGER NOT NULL DEFAULT 0,
          note TEXT, source TEXT NOT NULL DEFAULT 'collector' CHECK (source IN ('collector','manual')),
          raw TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE sale_line (
          id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
          inventory_item_id TEXT NOT NULL UNIQUE REFERENCES inventory_item(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE expense (
          id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, category TEXT NOT NULL,
          amount INTEGER NOT NULL, note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE collector_run (
          id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','auth_required','failed','empty')),
          fetched INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, message TEXT
        );
      `)
      legacy.prepare(`INSERT INTO shop_account (id, name) VALUES ('shop1', 'メロジョイA')`).run()
      legacy.prepare(`
        INSERT INTO purchase (id, shop_account_id, ordered_at) VALUES ('p1', 'shop1', '2026-01-01')
      `).run()
      legacy.prepare(`
        INSERT INTO purchase_line (id, purchase_id, name, unit_price, quantity)
        VALUES ('pl1', 'p1', '旧仕様の商品', 1000, 1)
      `).run()
      legacy.prepare(`
        INSERT INTO inventory_item (id, purchase_line_id, name, landed_cost, acquired_at)
        VALUES ('i1', 'pl1', '旧仕様の商品', 1000, '2026-01-01')
      `).run()
      legacy.close()

      db.initDb(path)

      // 既存データはそのまま残り、新列はNULLで読める
      const item = db.listInventory('in_stock').find(i => i.id === 'i1')!
      expect(item).toBeDefined()
      expect(item.model_code).toBeNull()
      expect(db.listPurchases()[0].status).toBe('confirmed')

      // status の CHECK に split が足されている（テーブル作り直し）
      const children = db.splitInventory('i1', 2)
      expect(children).toHaveLength(2)
      expect(db.listInventory('split')).toHaveLength(1)
      expect(db.listInventory('in_stock')).toHaveLength(2)

      // 設定：collect_interval_h は 6 → 1 に、新しいキーも入る
      const settings = db.getSettings()
      expect(settings.collect_interval_h).toBe('1')
      expect(settings.mercari_keyword).toBe('')
      expect(settings.schema_version).toBe('2')

      db.closeDb()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
