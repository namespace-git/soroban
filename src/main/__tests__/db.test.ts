import { createCompletedSale } from './completed-sale'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { todayLocal } from '../../shared/date'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import * as db from '../db'
import * as views from '../views'

/**
 * exportCsvRows() の CSV（先頭にBOM、CRLF区切り）をパースする。
 * persona-18 の parseCsv と違い、値に含まれるカンマ・"" のクォートも展開する
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  cells.push(cur)
  return cells
}

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const clean = csv.replace(/^﻿/, '')
  if (!clean) return { headers: [], rows: [] }
  const lines = clean.split('\r\n').filter(l => l.length > 0)
  const [headerLine, ...rest] = lines
  return { headers: parseCsvLine(headerLine), rows: rest.map(parseCsvLine) }
}

// ============================================================
// Phase 1 の実物スキーマ（`git show 64f69fd:src/main/schema.sql`）。
// migrate() のテストは、実機で実際に使われていた形そのままの DB を
// 用意して検証する（テーブルだけでなくビュー・トリガー・初期設定も含む）。
// ============================================================
const PHASE1_SCHEMA_SQL = `
-- ============================================================
-- そろばん（Soroban）— メルカリ転売 利益管理
-- ローカルSQLiteスキーマ
--
-- 設計方針：
--   * 金額はすべて INTEGER（円）。小数を持ち込まない
--   * inventory_item（在庫1点）が販売可能な最小単位
--   * 1販売に複数在庫を紐付けられる（まとめ売り対応）
--   * landed_cost は在庫生成時に確定。後から仕入を直しても過去の利益は動かない
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================
-- マスタ
-- ============================================================

-- 仕入先アカウント（メロジョイA / メロジョイB）
CREATE TABLE IF NOT EXISTS shop_account (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  note       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 発送方法。送料は改定されるので編集可能にしておく
CREATE TABLE IF NOT EXISTS shipping_method (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  carrier    TEXT,
  fee        INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- アプリ設定（手数料率など）
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- fee_rate_bp: ベーシスポイント。1000 = 10.00%
-- 小数を避けるため整数で持つ
INSERT OR IGNORE INTO setting (key, value) VALUES
  ('fee_rate_bp',        '1000'),
  ('transfer_fee',       '200'),
  ('aging_warn_days',    '90'),
  ('collect_interval_h', '6');

-- ============================================================
-- 仕入
-- ============================================================

CREATE TABLE IF NOT EXISTS purchase (
  id              TEXT PRIMARY KEY,
  shop_account_id TEXT NOT NULL REFERENCES shop_account(id),

  ordered_at      TEXT NOT NULL,              -- YYYY-MM-DD
  order_no        TEXT,

  shipping_fee    INTEGER NOT NULL DEFAULT 0, -- 仕入時の送料
  discount        INTEGER NOT NULL DEFAULT 0, -- クーポン等（正の数で保持）
  other_cost      INTEGER NOT NULL DEFAULT 0,

  -- 按分方式：by_amount（金額按分）/ by_quantity（数量按分）
  alloc_method    TEXT NOT NULL DEFAULT 'by_amount'
                  CHECK (alloc_method IN ('by_amount','by_quantity')),

  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (shop_account_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_ordered ON purchase(ordered_at DESC);

CREATE TABLE IF NOT EXISTS purchase_line (
  id          TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  unit_price  INTEGER NOT NULL,              -- 税込単価
  quantity    INTEGER NOT NULL CHECK (quantity > 0),

  -- 按分結果（登録・再計算時に確定させる）
  allocated_cost   INTEGER NOT NULL DEFAULT 0, -- この明細に配賦された送料等
  landed_unit_cost INTEGER NOT NULL DEFAULT 0, -- 1点あたりの按分後原価

  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pline_purchase ON purchase_line(purchase_id);

-- ============================================================
-- 在庫（販売可能な1点）
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_item (
  id               TEXT PRIMARY KEY,
  -- NULL 可：仕入記録のない私物を在庫として扱う場合に使う
  purchase_line_id TEXT REFERENCES purchase_line(id) ON DELETE CASCADE,

  name             TEXT NOT NULL,
  -- 按分後原価。生成時にコピーし、以後は独立。
  -- ここを後から書き換えると過去の利益が動いて帳簿が信用できなくなる
  landed_cost      INTEGER NOT NULL,
  acquired_at      TEXT NOT NULL,             -- 仕入日 YYYY-MM-DD

  status           TEXT NOT NULL DEFAULT 'in_stock'
                   CHECK (status IN ('in_stock','sold','disposed','personal_use')),
  disposed_at      TEXT,
  disposed_note    TEXT,

  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_status   ON inventory_item(status);
CREATE INDEX IF NOT EXISTS idx_inv_acquired ON inventory_item(acquired_at);
CREATE INDEX IF NOT EXISTS idx_inv_pline    ON inventory_item(purchase_line_id);

-- ============================================================
-- 販売
-- ============================================================

CREATE TABLE IF NOT EXISTS sale (
  id                 TEXT PRIMARY KEY,

  mercari_item_id    TEXT UNIQUE,            -- m123456789
  title              TEXT NOT NULL,
  sold_at            TEXT NOT NULL,          -- YYYY-MM-DD
  price              INTEGER NOT NULL,

  -- 転売か私物か。税務上の扱いが異なるので必ず分ける
  kind               TEXT NOT NULL DEFAULT 'resale'
                     CHECK (kind IN ('resale','personal')),

  fee_rate_bp        INTEGER NOT NULL DEFAULT 1000,
  fee                INTEGER NOT NULL DEFAULT 0,  -- 販売手数料（確定値）

  shipping_method_id TEXT REFERENCES shipping_method(id),
  shipping_fee       INTEGER NOT NULL DEFAULT 0,
  packaging_cost     INTEGER NOT NULL DEFAULT 0,

  -- collector は送料を取得できない。
  -- 発送方法を選んだら 1 にする。0 のものを「要入力」として出す
  is_shipping_confirmed INTEGER NOT NULL DEFAULT 0,

  note               TEXT,
  source             TEXT NOT NULL DEFAULT 'collector'
                     CHECK (source IN ('collector','manual')),
  raw                TEXT,                   -- 取得時の生データ（JSON・デバッグ用）

  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sale_sold ON sale(sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_kind ON sale(kind);

-- 販売と在庫の紐付け。1販売に複数在庫（まとめ売り）
CREATE TABLE IF NOT EXISTS sale_line (
  id                TEXT PRIMARY KEY,
  sale_id           TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  -- UNIQUE: 1つの在庫は1回しか売れない
  inventory_item_id TEXT NOT NULL UNIQUE REFERENCES inventory_item(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sline_sale ON sale_line(sale_id);

-- 紐付けたら在庫を sold に、外したら in_stock に戻す
CREATE TRIGGER IF NOT EXISTS trg_sline_sold
AFTER INSERT ON sale_line
BEGIN
  UPDATE inventory_item
     SET status = 'sold', updated_at = datetime('now')
   WHERE id = NEW.inventory_item_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sline_unsold
AFTER DELETE ON sale_line
BEGIN
  UPDATE inventory_item
     SET status = 'in_stock', updated_at = datetime('now')
   WHERE id = OLD.inventory_item_id;
END;

-- ============================================================
-- 期間費用（振込手数料など、個別の販売に紐付かないもの）
-- ============================================================

CREATE TABLE IF NOT EXISTS expense (
  id          TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  category    TEXT NOT NULL,   -- transfer_fee | supplies | other
  amount      INTEGER NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expense_date ON expense(occurred_at);

-- ============================================================
-- 収集の実行記録
-- ============================================================

CREATE TABLE IF NOT EXISTS collector_run (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  -- empty = 0件。連続したらDOM変更で壊れている疑い
  -- auth_required = セッション切れ
  status      TEXT NOT NULL DEFAULT 'ok'
              CHECK (status IN ('ok','auth_required','failed','empty')),
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_started ON collector_run(started_at DESC);

-- ============================================================
-- ビュー：販売ごとの利益
--
-- 粗利 = 販売価格 − 手数料 − 送料 − 梱包材 − Σ(紐付けた在庫の按分後原価)
-- ============================================================

CREATE VIEW IF NOT EXISTS sale_profit AS
SELECT
  s.id,
  s.mercari_item_id,
  s.sold_at,
  s.title,
  s.kind,
  s.price,
  s.fee,
  s.shipping_fee,
  s.packaging_cost,
  s.is_shipping_confirmed,
  s.shipping_method_id,
  COALESCE(SUM(i.landed_cost), 0) AS cost,
  s.price - s.fee - s.shipping_fee - s.packaging_cost
    - COALESCE(SUM(i.landed_cost), 0) AS gross_profit,
  COUNT(sl.id) AS item_count,
  CASE WHEN COUNT(sl.id) = 0 THEN 1 ELSE 0 END AS unmatched
FROM sale s
LEFT JOIN sale_line      sl ON sl.sale_id = s.id
LEFT JOIN inventory_item i  ON i.id = sl.inventory_item_id
GROUP BY s.id;

-- ============================================================
-- ビュー：月次集計（kind別）
-- ============================================================

CREATE VIEW IF NOT EXISTS monthly_summary AS
SELECT
  substr(sold_at, 1, 7) AS month,
  kind,
  COUNT(*)                  AS sales_count,
  SUM(price)                AS revenue,
  SUM(fee)                  AS total_fee,
  SUM(shipping_fee)         AS total_shipping,
  SUM(packaging_cost)       AS total_packaging,
  SUM(cost)                 AS total_cost,
  SUM(gross_profit)         AS gross_profit
FROM sale_profit
GROUP BY substr(sold_at, 1, 7), kind;

-- ============================================================
-- ビュー：在庫（滞留日数つき）
-- ============================================================

CREATE VIEW IF NOT EXISTS inventory_view AS
SELECT
  i.id,
  i.name,
  i.landed_cost,
  i.acquired_at,
  i.status,
  CAST(julianday('now') - julianday(i.acquired_at) AS INTEGER) AS aging_days,
  p.order_no,
  sa.name AS shop_account_name
FROM inventory_item i
LEFT JOIN purchase_line pl ON pl.id = i.purchase_line_id
LEFT JOIN purchase      p  ON p.id  = pl.purchase_id
LEFT JOIN shop_account  sa ON sa.id = p.shop_account_id;
`

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

  it('listPurchases/getPurchase：first_line_name・first_model_codeは先頭明細（下書きで明細ゼロならnull）', () => {
    const purchaseId = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-02',
      shipping_fee: 0,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 },
        { name: 'いちごスフレ【Z072-8】', unit_price: 1500, quantity: 1 },
        { name: 'シーソルト【Z001-4】', unit_price: 900, quantity: 1 },
      ],
    })

    const summary = db.listPurchases().find(p => p.id === purchaseId)!
    expect(summary.first_line_name).toBe('クリームわん【Z080-1】')
    expect(summary.first_model_code).toBe('Z080-1')

    const detail = db.getPurchase(purchaseId)
    expect(detail.first_line_name).toBe('クリームわん【Z080-1】')
    expect(detail.first_model_code).toBe('Z080-1')

    const draftId = db.createPurchaseDraft({
      import_key: 'empty-draft-1',
      shop_account_id: shopId,
      ordered_at: '2026-01-03',
      lines: [],
    })
    const draftSummary = db.listPurchases().find(p => p.id === draftId)!
    expect(draftSummary.first_line_name).toBeNull()
    expect(draftSummary.first_model_code).toBeNull()
    expect(db.getPurchase(draftId).first_line_name).toBeNull()
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

  it('restoreInventory：廃棄・自家消費を手元の在庫に戻す。原価は変わらない／売却済み・未廃棄は戻せない', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '在庫Y', unit_price: 500, quantity: 3 }],
    })
    const [item1, item2, item3] = db.listInventory('in_stock')
    const cost1 = item1.landed_cost

    db.disposeInventory(item1.id, '間違えて廃棄', 'disposed')
    db.restoreInventory(item1.id)
    const restored = db.listInventory('in_stock').find(i => i.id === item1.id)!
    expect(restored.landed_cost).toBe(cost1) // landed_cost は生成時のまま
    expect(restored.note ?? null).toBeNull()

    // disposed_at・disposed_note が消えている（restoreInventory 経由のUPDATEで確認）
    const raw = db.getDb().prepare('SELECT disposed_at, disposed_note FROM inventory_item WHERE id = ?')
      .get(item1.id) as { disposed_at: string | null; disposed_note: string | null }
    expect(raw.disposed_at).toBeNull()
    expect(raw.disposed_note).toBeNull()

    // 自家消費からも戻せる
    db.disposeInventory(item2.id, '自分用に使った', 'personal_use')
    db.restoreInventory(item2.id)
    expect(db.listInventory('in_stock').some(i => i.id === item2.id)).toBe(true)

    // 未廃棄（in_stock）は戻せない
    expect(() => db.restoreInventory(item3.id)).toThrow('この在庫は戻せません')

    // 売却済みは戻せない
    const saleId = db.createSale({ title: '在庫Y', sold_at: '2026-01-06', price: 1000 })
    db.linkInventory(saleId, [item3.id])
    expect(() => db.restoreInventory(item3.id)).toThrow('この在庫は戻せません')

    // 存在しないIDはエラー
    expect(() => db.restoreInventory('no-such-id')).toThrow('在庫が見つかりません')
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

  describe('mergeSplitInventory：分割を戻す', () => {
    it('3分割した直後に戻す→親がin_stock、子は0件、原価とitem_codeは親のまま', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '間違えて分けた', unit_price: 1000, quantity: 1 }],
      })
      const parent = db.listInventory('in_stock')[0]
      const childIds = db.splitInventory(parent.id, 3)

      db.mergeSplitInventory(parent.id)

      const inStock = db.listInventory('in_stock')
      expect(inStock).toHaveLength(1)
      expect(inStock[0].id).toBe(parent.id)
      expect(inStock[0].item_code).toBe(parent.item_code)
      expect(inStock[0].landed_cost).toBe(1000)
      expect(db.listInventory('split')).toHaveLength(0)

      for (const childId of childIds) {
        expect(db.listInventory('in_stock').some(i => i.id === childId)).toBe(false)
      }
    })

    it('子のタグ・メモは親に寄せる', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'タグ付き分割', unit_price: 900, quantity: 1 }],
      })
      const parent = db.listInventory('in_stock')[0]
      const tagId = db.createTag('レア')
      const childIds = db.splitInventory(parent.id, 3)
      db.setInventoryTags(childIds[0], [tagId])
      db.updateInventory(childIds[1], { note: '傷あり' })

      db.mergeSplitInventory(parent.id)

      const merged = db.listInventory('in_stock')[0]
      expect(merged.tags.map(t => t.id)).toEqual([tagId])
      expect(merged.note).toBe('傷あり')
    })

    it('子が1点でも販売済みならErrorにitem_codeを含み、何も変わらない', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '一部売れた分割', unit_price: 900, quantity: 1 }],
      })
      const parent = db.listInventory('in_stock')[0]
      const childIds = db.splitInventory(parent.id, 3)
      const soldChild = db.listInventory('in_stock').find(i => i.id === childIds[0])!

      const saleId = db.createSale({ title: '一部売れた分割', sold_at: '2026-01-06', price: 500 })
      db.linkInventory(saleId, [soldChild.id])

      expect(() => db.mergeSplitInventory(parent.id)).toThrow(soldChild.item_code)

      // 何も変わっていない
      expect(db.listInventory('split').some(i => i.id === parent.id)).toBe(true)
      expect(db.listInventory('in_stock').filter(i => childIds.includes(i.id))).toHaveLength(2)
    })

    it('子が出品に引き当て中ならError', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '引き当て中の分割', unit_price: 900, quantity: 1 }],
      })
      const parent = db.listInventory('in_stock')[0]
      const childIds = db.splitInventory(parent.id, 2)
      db.upsertListings([
        { mercariItemId: 'LMERGE', title: '引き当て中の分割', price: 1500, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LMERGE', [childIds[0]])

      expect(() => db.mergeSplitInventory(parent.id)).toThrow('引き当て中')
    })

    it('孫まで分割されているとError「さらに分割」', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '孫分割', unit_price: 900, quantity: 1 }],
      })
      const parent = db.listInventory('in_stock')[0]
      const childIds = db.splitInventory(parent.id, 2)
      db.splitInventory(childIds[0], 2)

      expect(() => db.mergeSplitInventory(parent.id)).toThrow('さらに分割')
    })
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

  it('私物判定：mercari_keywordは , 、 空白 改行区切りの複数語として扱い、どれか1つ含めばresale', () => {
    db.setSetting('mercari_keyword', 'メロジョイ, Mellojoy、ジョイ')
    db.insertCollected([
      { mercariItemId: 'k1', title: 'メロジョイ限定コラボ', price: 1000, soldAt: '2026-01-01' },
      { mercariItemId: 'k2', title: 'Mellojoyのグッズ', price: 1000, soldAt: '2026-01-02' },
      { mercariItemId: 'k3', title: 'かわいいジョイちゃん', price: 1000, soldAt: '2026-01-03' },
      { mercariItemId: 'k4', title: 'ぜんぜん関係ない商品', price: 1000, soldAt: '2026-01-04' },
    ])
    const sales = db.listSales()
    expect(sales.find(s => s.mercari_item_id === 'k1')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'k2')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'k3')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'k4')!.kind).toBe('personal')
  })

  it('appendModelCodes：説明文から拾った型番を追記し、resaleに戻して自動紐付けする', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })

    // タイトルに型番が無いので私物扱いで取り込まれる
    db.insertCollected([
      { mercariItemId: 'm10', title: '素敵な商品です', price: 2000, soldAt: '2026-01-05' },
    ])
    const saleId = db.listSales().find(s => s.mercari_item_id === 'm10')!.id
    expect(db.listSales().find(s => s.id === saleId)!.kind).toBe('personal')

    const changed = db.appendModelCodes(saleId, ['Z080-1'])
    expect(changed).toBe(true)

    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.kind).toBe('resale')
    expect(sale.model_codes).toEqual(['Z080-1'])
    expect(sale.auto_linked).toBe(1)
    expect(sale.cost).toBe(1000)
    expect(sale.unmatched).toBe(0)
  })

  it('appendModelCodes：同じ型番を足しても変化なしなら false', () => {
    const saleId = db.createSale({ title: '【Z080-1】クリームわん', sold_at: '2026-01-05', price: 2000 })
    expect(db.appendModelCodes(saleId, ['Z080-1'])).toBe(false)
  })

  it('appendModelCodes：人が手でpersonalにした販売はresaleに戻さない', () => {
    // タイトルに型番があるので取り込み時点ではresale
    db.insertCollected([
      { mercariItemId: 'm11', title: '【Z080-1】掘り出し物', price: 2000, soldAt: '2026-01-05' },
    ])
    const saleId = db.listSales().find(s => s.mercari_item_id === 'm11')!.id

    // 人が手でpersonalに変更した状態を模す（updated_atがcreated_atから進む）
    db.getDb().prepare(
      `UPDATE sale SET kind = 'personal', updated_at = datetime('now', '+1 minute') WHERE id = ?`,
    ).run(saleId)

    const changed = db.appendModelCodes(saleId, ['Z088-2'])
    expect(changed).toBe(true)

    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.kind).toBe('personal')
    expect(sale.model_codes.sort()).toEqual(['Z080-1', 'Z088-2'])
  })

  describe('updateSale：タイトルを書き換えたときの model_codes 列', () => {
    it('画面の値（listSales）と自動紐付けが使う値が食い違っていたことの再現：' +
      'タイトルを直しても列が古いままだと在庫があるのに自動紐付けが失敗する', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【A040】', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      // Yahoo!フリマの売上金管理のように、型番が読めない途中で切れたタイトルで取り込まれる
      const saleId = db.createSale({ title: '素敵な商品です', sold_at: '2026-01-05', price: 2000 })
      expect(db.listSales().find(s => s.id === saleId)!.model_codes).toEqual([])

      // 修正前の挙動を裏から再現する：patch.title だけ書き換え、model_codes 列は触らない
      // （このブロックは updateSale を直す前のバグの再現。db.ts 側の SQL を直接叩いて模している）
      db.getDb().prepare(`UPDATE sale SET title = ? WHERE id = ?`).run('【A040】素敵な商品です', saleId)

      // 「画面の値」（listSales＝保存された列）は古いまま＝空
      const staleView = db.listSales().find(s => s.id === saleId)!
      expect(staleView.model_codes).toEqual([])
      // 自動紐付けも同じ古い列を読むので、型番が読めず失敗する（在庫はあるのに、である）
      expect(db.autoLinkSale(saleId)).toBe(false)
      expect(db.listInventory('in_stock').find(i => i.id === item.id)).toBeDefined() // 在庫は在る

      // ここからが本来の直し方：updateSale 経由でタイトルを書き換えると、列も作り直される
      db.updateSale(saleId, { title: '【A040】素敵な商品です' })
      const fixedView = db.listSales().find(s => s.id === saleId)!
      expect(fixedView.model_codes).toEqual(['A040'])
      // 画面の値とautoLinkSaleが使う値は同じ列を見ているので、以後は一致して自動紐付けが効く
      expect(db.autoLinkSale(saleId)).toBe(true)
      expect(db.listSales().find(s => s.id === saleId)!.cost).toBe(item.landed_cost)
    })

    it('タイトルを直すと model_codes 列が追随する（型番の無いタイトル→【A040】付きに直す）', () => {
      const saleId = db.createSale({ title: 'タイトルにはまだ型番が無い', sold_at: '2026-01-05', price: 1000 })
      expect(db.listSales().find(s => s.id === saleId)!.model_codes).toEqual([])

      db.updateSale(saleId, { title: '【A040】タイトルを直した' })

      expect(db.listSales().find(s => s.id === saleId)!.model_codes).toEqual(['A040'])
    })

    it('説明文由来（appendModelCodesで足した型番）はタイトル編集で消えない', () => {
      const saleId = db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      // 説明文から後追いで見つかった型番（付属品など）を追記
      db.appendModelCodes(saleId, ['A099'])
      expect(db.listSales().find(s => s.id === saleId)!.model_codes.sort()).toEqual(['A040', 'A099'])

      // タイトル自体は型番はそのままに、他の文言だけ直す
      db.updateSale(saleId, { title: '【A040】本体（説明追記）' })

      expect(db.listSales().find(s => s.id === saleId)!.model_codes.sort()).toEqual(['A040', 'A099'])
    })

    it('古いタイトルにしか無かった型番は落ちる（【A040】→【A039】に直したらA040が消える）', () => {
      const saleId = db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      expect(db.listSales().find(s => s.id === saleId)!.model_codes).toEqual(['A040'])

      db.updateSale(saleId, { title: '【A039】本体' })

      expect(db.listSales().find(s => s.id === saleId)!.model_codes).toEqual(['A039'])
    })

    it('タイトルを直しても、説明文由来は残しつつ古いタイトル由来だけを落とす（複合ケース）', () => {
      const saleId = db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      db.appendModelCodes(saleId, ['A099']) // 説明文由来
      db.updateSale(saleId, { title: '【A041】本体（説明追記）' }) // タイトルをA040→A041に直す

      const after = db.listSales().find(s => s.id === saleId)!
      // A040（古いタイトル由来）は消え、A041（新しいタイトル）とA099（説明文由来）は残る
      expect(after.model_codes.sort()).toEqual(['A041', 'A099'])
    })

    it('title以外のpatch（kind等）ではmodel_codesは変わらない', () => {
      const saleId = db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      db.updateSale(saleId, { kind: 'personal' })
      expect(db.listSales().find(s => s.id === saleId)!.model_codes).toEqual(['A040'])
    })
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

  it('insertCollected：販売履歴ページの実額（fee/shippingFee/soldAt）をそのまま確定値として保存する', () => {
    db.insertCollected([{
      mercariItemId: 'h1',
      title: '実額つきの商品',
      price: 8999,
      soldAt: '2026-09-19', // collector側で '2026/09/19' 形式から変換済みという想定
      fee: 899,
      shippingFee: 215,
    }])

    const sale = db.listSales().find(s => s.mercari_item_id === 'h1')!
    expect(sale.fee).toBe(899)
    expect(sale.shipping_fee).toBe(215)
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(sale.shipping_source).toBe('actual')
    expect(sale.sold_at).toBe('2026-09-19')
    expect(sale.gross_profit).toBe(8999 - 899 - 215 - 0 - sale.cost)
  })

  it('insertCollected：shippingFeeが0は送料未入力のまま（メルカリ便を使っていない可能性が高い）', () => {
    db.insertCollected([{
      mercariItemId: 'h2', title: '着払いの商品', price: 1000, soldAt: '2026-09-19', shippingFee: 0,
    }])
    const sale = db.listSales().find(s => s.mercari_item_id === 'h2')!
    expect(sale.shipping_fee).toBe(0)
    expect(sale.is_shipping_confirmed).toBe(0)
    expect(sale.shipping_source).toBe('actual')
  })

  describe('fee_source：手数料が実額か見込みか（価格変更で実額を上書きしない）', () => {
    it('createSale：fee_sourceは常にrate（率から計算した見込み）', () => {
      const saleId = db.createSale({ title: '手入力の販売', sold_at: '2026-01-05', price: 1000 })
      expect(db.listSales().find(s => s.id === saleId)!.fee_source).toBe('rate')
    })

    it('createSale：feeに実額を渡すとそのまま保存されfee_source=actualになる。0円（キャンペーン）も実額', () => {
      // 実測：5,200円→0円（キャンペーン適用）
      const zeroId = db.createSale({
        title: 'キャンペーン販売', sold_at: '2026-01-05', price: 5200, channel: 'yahoo', fee: 0,
      })
      const zero = db.listSales().find(s => s.id === zeroId)!
      expect(zero.fee).toBe(0)
      expect(zero.fee_source).toBe('actual')

      // 実測：4,280円→213円（5%なら214円になるはずが合わない＝率で計算できない）
      const oddId = db.createSale({
        title: '端数が合わない販売', sold_at: '2026-01-05', price: 4280, channel: 'yahoo', fee: 213,
      })
      const odd = db.listSales().find(s => s.id === oddId)!
      expect(odd.fee).toBe(213)
      expect(odd.fee_source).toBe('actual')
    })

    it('createSale：feeを省略すると率で計算されfee_source=rateになる（メルカリ10%・Yahoo5%の両方）', () => {
      const mercariId = db.createSale({ title: 'メルカリ手入力', sold_at: '2026-01-05', price: 3000 })
      const mercari = db.listSales().find(s => s.id === mercariId)!
      expect(mercari.fee).toBe(300) // floor(3000*1000/10000)
      expect(mercari.fee_source).toBe('rate')

      const yahooId = db.createSale({
        title: 'Yahoo手入力', sold_at: '2026-01-05', price: 6400, channel: 'yahoo',
      })
      const yahoo = db.listSales().find(s => s.id === yahooId)!
      expect(yahoo.fee).toBe(320) // floor(6400*500/10000)
      expect(yahoo.fee_source).toBe('rate')
    })

    it('createSale：feeに負の額を渡すとthrow', () => {
      expect(() => db.createSale({
        title: '不正な手数料', sold_at: '2026-01-05', price: 1000, fee: -1,
      })).toThrow('手数料は整数で入力してください')
    })

    it('insertCollected：feeを渡さなければrate、渡せば0でもactualになる（Yahooのキャンペーンは実額0円）', () => {
      db.insertCollected([{ mercariItemId: 'fs-1', title: '見込みのまま', price: 1000, soldAt: '2026-09-01' }])
      db.insertCollected([{ mercariItemId: 'fs-2', title: '実額0円', price: 5200, soldAt: '2026-09-01', fee: 0 }])
      db.insertCollected([{ mercariItemId: 'fs-3', title: '実額あり', price: 6400, soldAt: '2026-09-01', fee: 320 }])

      const sales = db.listSales()
      expect(sales.find(s => s.mercari_item_id === 'fs-1')!.fee_source).toBe('rate')
      const zeroFee = sales.find(s => s.mercari_item_id === 'fs-2')!
      expect(zeroFee.fee).toBe(0)
      expect(zeroFee.fee_source).toBe('actual')
      expect(sales.find(s => s.mercari_item_id === 'fs-3')!.fee_source).toBe('actual')
    })

    it('applySaleActuals：feeに0を渡してもfee_source=actualになる（0は「未取得」ではなく実額）', () => {
      const saleId = db.createSale({
        title: 'キャンペーン販売', sold_at: '2026-01-05', price: 5200, channel: 'yahoo',
      })
      expect(db.listSales().find(s => s.id === saleId)!.fee_source).toBe('rate')

      db.applySaleActuals(saleId, { fee: 0 })
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.fee).toBe(0)
      expect(sale.fee_source).toBe('actual')
    })

    it('updateSale：実額（fee=0）が入った販売は価格を変えてもfeeが0のまま。rateの販売は今までどおり再計算される', () => {
      // 実額0円（Yahoo!フリマのキャンペーン適用。実測：5,200円→0円）
      const actualId = db.createSale({
        title: 'キャンペーン販売', sold_at: '2026-01-05', price: 5200, channel: 'yahoo',
      })
      db.applySaleActuals(actualId, { fee: 0 })

      db.updateSale(actualId, { price: 6000 })
      const actualSale = db.listSales().find(s => s.id === actualId)!
      expect(actualSale.price).toBe(6000)
      expect(actualSale.fee).toBe(0) // 率で上書きされていない
      expect(actualSale.fee_source).toBe('actual')

      // 率のまま（手入力）の販売は今までどおり価格変更で再計算される
      const rateId = db.createSale({ title: '手入力の販売', sold_at: '2026-01-05', price: 1000 })
      db.updateSale(rateId, { price: 2000 })
      const rateSale = db.listSales().find(s => s.id === rateId)!
      expect(rateSale.fee).toBe(200) // floor(2000*1000/10000)
      expect(rateSale.fee_source).toBe('rate')
    })

    it('updateSale：patch.feeで実額に直す／nullで率に戻す。価格と同時に渡しても実額が勝つ', () => {
      // createSale の時点でfee: 0の実額（キャンペーン）にしておく
      const saleId = db.createSale({
        title: 'patch.feeテスト', sold_at: '2026-01-05', price: 5200, channel: 'yahoo', fee: 0,
      })
      expect(db.listSales().find(s => s.id === saleId)!.fee_source).toBe('actual')

      // 価格だけ変える → 実額0円のまま動かない
      db.updateSale(saleId, { price: 6000 })
      const afterPrice = db.listSales().find(s => s.id === saleId)!
      expect(afterPrice.price).toBe(6000)
      expect(afterPrice.fee).toBe(0)
      expect(afterPrice.fee_source).toBe('actual')

      // patch.feeで実額300円に直す
      db.updateSale(saleId, { fee: 300 })
      const afterFee = db.listSales().find(s => s.id === saleId)!
      expect(afterFee.fee).toBe(300)
      expect(afterFee.fee_source).toBe('actual')

      // 価格と手数料を同時に渡す → 実額が勝つ（率の700にも、手数料単独の300にもならない）
      db.updateSale(saleId, { price: 7000, fee: 999 })
      const afterBoth = db.listSales().find(s => s.id === saleId)!
      expect(afterBoth.price).toBe(7000)
      expect(afterBoth.fee).toBe(999)
      expect(afterBoth.fee_source).toBe('actual')

      // fee: null で率の計算に戻す。fee_rate_bpはchannel=yahoo既定500 → floor(7000*500/10000)=350
      // （実額999とは異なる＝ちゃんと率で計算し直していることが分かる）
      db.updateSale(saleId, { fee: null })
      const afterNull = db.listSales().find(s => s.id === saleId)!
      expect(afterNull.fee_source).toBe('rate')
      expect(afterNull.fee).toBe(350)

      const raw = db.getDb().prepare('SELECT fee_rate_bp FROM sale WHERE id = ?').get(saleId) as
        { fee_rate_bp: number }
      expect(afterNull.fee).toBe(Math.floor((afterNull.price * raw.fee_rate_bp) / 10000))
    })

    it('updateSale：patch.feeに負の額を渡すとthrow', () => {
      const saleId = db.createSale({ title: '不正な手数料パッチ', sold_at: '2026-01-05', price: 1000 })
      expect(() => db.updateSale(saleId, { fee: -1 }))
        .toThrow('手数料は整数で入力してください')
    })

    it('粗利の検算：実額0円のYahoo販売の価格を変えたあとも、粗利が「新価格−0−送料−梱包材費−原価」と数字で一致する', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'fee_source検算用', unit_price: 1500, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      const saleId = db.createSale({
        title: 'fee_source検算用の販売', sold_at: '2026-01-10', price: 5200, channel: 'yahoo',
      })
      db.linkInventory(saleId, [item.id])
      db.applySaleActuals(saleId, { fee: 0 })
      db.updateSale(saleId, { price: 6000, packaging_cost: 50, shipping_fee: 300 })

      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.price).toBe(6000)
      expect(sale.fee).toBe(0)
      expect(sale.fee_source).toBe('actual')
      expect(sale.shipping_fee).toBe(300)
      expect(sale.packaging_cost).toBe(50)
      expect(sale.cost).toBe(1500)
      expect(sale.gross_profit).toBe(6000 - 0 - 300 - 50 - 1500)
      expect(sale.gross_profit).toBe(4150)
    })

    it('monthly_summary：createSaleでfee:0（実額）のYahoo販売を入れると、その月の手数料合計・粗利に0円が反映される（260円ずれない）', () => {
      db.createSale({
        title: 'キャンペーン販売（月次検算）', sold_at: todayLocal(), price: 5200, channel: 'yahoo', fee: 0,
      })

      const dash = db.getDashboard()
      expect(dash.thisMonth).not.toBeNull()
      expect(dash.thisMonth!.revenue).toBe(5200)
      expect(dash.thisMonth!.total_fee).toBe(0) // 率(5%)なら260円になるところ、実額0円で入っている
      expect(dash.thisMonth!.gross_profit).toBe(5200) // 5200 - 0(fee) - 0(shipping) - 0(packaging) - 0(cost)
    })

    it('migrate：version31相当（fee_sourceが無い）→32で列が足され、feeが率と一致すればrate・一致しなければactualになる', () => {
      const dir = mkdtempSync(join(tmpdir(), 'soroban-fee-source-migrate-'))
      const path = join(dir, 'v31.db')
      try {
        db.closeDb()
        db.initDb(path) // 一旦フルスキーマで作り、v31相当（fee_sourceが無い）まで剥がす

        // 率と一致：price=1000, fee_rate_bp=1000(既定) → calcFee=100
        const rateId = db.createSale({ title: '率と一致', sold_at: '2026-01-05', price: 1000 })
        // 率と不一致：price=5200, fee_rate_bp=500(yahoo既定) → calcFee=260 のはずが、
        // 実際は実額0円（キャンペーン）で保存されていたケースを再現する
        const actualId = db.createSale({
          title: '率と不一致（実額）', sold_at: '2026-01-05', price: 5200, channel: 'yahoo',
        })
        db.getDb().prepare(`UPDATE sale SET fee = 0 WHERE id = ?`).run(actualId)

        db.getDb().exec(`
          DROP VIEW IF EXISTS sale_line_share;
          DROP VIEW IF EXISTS sale_profit;
          DROP VIEW IF EXISTS monthly_summary;
          DROP VIEW IF EXISTS inventory_view;
          DROP VIEW IF EXISTS variant_summary;
          ALTER TABLE sale DROP COLUMN fee_source;
        `)
        db.getDb().prepare(`UPDATE setting SET value = '31' WHERE key = 'schema_version'`).run()
        db.closeDb()

        expect(() => db.initDb(path)).not.toThrow()

        expect(db.getSettings().schema_version).toBe('34')
        const sales = db.listSales()
        expect(sales.find(s => s.id === rateId)!.fee_source).toBe('rate')
        expect(sales.find(s => s.id === actualId)!.fee_source).toBe('actual')
      } finally {
        try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('migrate：v31相当でrawにfeeが数値で明示されていれば、率と偶然一致していてもactualになる。rawにfeeが無い行はいままでの判定のまま', () => {
      const dir = mkdtempSync(join(tmpdir(), 'soroban-fee-source-raw-migrate-'))
      const path = join(dir, 'v31-raw.db')
      try {
        db.closeDb()
        db.initDb(path)

        // insertCollectedはsale.rawにJSON.stringify(渡した行)を残す。fee=100は率10%(既定)の
        // 計算結果とも一致してしまう値だが、実額として明示的に渡している
        const [rawActual] = db.insertCollected([
          { mercariItemId: 'raw-actual', title: '率と偶然一致する実額', price: 1000, soldAt: '2026-01-05', fee: 100 },
        ])
        // feeを渡さない行はrawにfeeキーが残らない（従来どおりcalcFeeとの一致で判定させる）
        const [rawNone] = db.insertCollected([
          { mercariItemId: 'raw-none', title: 'feeを渡さない取り込み', price: 1000, soldAt: '2026-01-05' },
        ])

        db.getDb().exec(`
          DROP VIEW IF EXISTS sale_line_share;
          DROP VIEW IF EXISTS sale_profit;
          DROP VIEW IF EXISTS monthly_summary;
          DROP VIEW IF EXISTS inventory_view;
          DROP VIEW IF EXISTS variant_summary;
          ALTER TABLE sale DROP COLUMN fee_source;
        `)
        db.getDb().prepare(`UPDATE setting SET value = '31' WHERE key = 'schema_version'`).run()
        db.closeDb()

        expect(() => db.initDb(path)).not.toThrow()

        const sales = db.listSales()
        // rawにfee:100が明示 → 率(100)と一致していてもactual扱いになる。fee自体は変わらない
        const actualSale = sales.find(s => s.id === rawActual.id)!
        expect(actualSale.fee_source).toBe('actual')
        expect(actualSale.fee).toBe(100)
        // rawにfeeが無い → 従来どおり率と一致するのでrate扱い
        expect(sales.find(s => s.id === rawNone.id)!.fee_source).toBe('rate')
      } finally {
        try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('updateCollectedActuals：既存の（料率計算・未確定・仮日付の）販売を実額と本当の日付に置き換える。手入力の日付は変えない', () => {
    // collector が仮の取得日で先に積んだ販売（料率計算・未確定）
    db.insertCollected([{ mercariItemId: 'u1', title: '後で実額が来る商品', price: 3000, soldAt: '2026-09-01' }])
    const before = db.listSales().find(s => s.mercari_item_id === 'u1')!
    expect(before.shipping_source).toBeNull()
    expect(before.is_shipping_confirmed).toBe(0)
    expect(before.fee).toBe(300) // 料率10%で計算された仮の値

    // 手入力の販売（同じ mercari_item_id を持つケースを模す）
    const manualId = db.createSale({
      title: '手入力の商品', sold_at: '2026-01-01', price: 1000, mercari_item_id: 'u2',
    })

    const updated = db.updateCollectedActuals([
      { mercariItemId: 'u1', soldAt: '2026-08-15', fee: 250, shippingFee: 0 },
      { mercariItemId: 'u2', soldAt: '2026-08-20', fee: 90, shippingFee: 0 },
      { mercariItemId: 'does-not-exist', soldAt: '2026-08-20' },
    ])
    expect(updated).toBe(2)

    const after = db.listSales().find(s => s.mercari_item_id === 'u1')!
    expect(after.sold_at).toBe('2026-08-15')
    expect(after.fee).toBe(250)
    expect(after.shipping_fee).toBe(0)
    expect(after.shipping_source).toBe('actual')
    expect(after.is_shipping_confirmed).toBe(0) // 送料0はメルカリ便未使用の疑いがあるので未確定のまま

    // 手入力の販売：sold_at は変わらない
    const manual = db.listSales().find(s => s.id === manualId)!
    expect(manual.sold_at).toBe('2026-01-01')

    // 既に actual & 同じ sold_at のものは再適用しても更新0件
    const noop = db.updateCollectedActuals([
      { mercariItemId: 'u1', soldAt: '2026-08-15', fee: 250, shippingFee: 0 },
    ])
    expect(noop).toBe(0)
  })

  it('updateCollectedActuals：fee_sourceがrateのまま（誤判定を模す）でも、同じ金額のfeeが来ればactualへ自己修復する。feeの値自体は変えない', () => {
    db.insertCollected([
      { mercariItemId: 'heal-1', title: '自己修復対象', price: 1000, soldAt: '2026-09-01', fee: 100 },
    ])
    const before = db.listSales().find(s => s.mercari_item_id === 'heal-1')!
    expect(before.fee_source).toBe('actual')
    // v32移行の誤判定（率と偶然一致する実額をrateにしてしまうケース）を再現する
    db.getDb().prepare(`UPDATE sale SET fee_source = 'rate' WHERE id = ?`).run(before.id)
    expect(db.listSales().find(s => s.id === before.id)!.fee_source).toBe('rate')

    // 同じ金額のfeeが取り込みで返ってきただけでも、fee_sourceをactualへ直す
    const updated = db.updateCollectedActuals([{ mercariItemId: 'heal-1', soldAt: before.sold_at, fee: 100 }])
    expect(updated).toBe(1)
    const healed = db.listSales().find(s => s.id === before.id)!
    expect(healed.fee_source).toBe('actual')
    expect(healed.fee).toBe(100) // feeの値自体は変わらない

    // 自己修復が効いている＝以後 updateSale で価格を変えても手数料は再計算されない
    db.updateSale(before.id, { price: 2000 })
    const afterPriceChange = db.listSales().find(s => s.id === before.id)!
    expect(afterPriceChange.fee).toBe(100)
    expect(afterPriceChange.fee_source).toBe('actual')
  })

  it('updateCollectedActuals：r.feeがnullのときはfee_sourceを触らない', () => {
    const [{ id }] = db.insertCollected([
      { mercariItemId: 'heal-null', title: 'feeなし取り込み', price: 1000, soldAt: '2026-09-01' },
    ])
    const before = db.listSales().find(s => s.id === id)!
    expect(before.fee_source).toBe('rate')

    // feeはnull（未取得）のまま、status完了だけ観測させても fee_source は変わらない
    const updated = db.updateCollectedActuals([{ mercariItemId: 'heal-null', soldAt: before.sold_at, fee: null }])
    expect(updated).toBe(1) // status が completed へ進むので更新自体は起きる
    const after = db.listSales().find(s => s.id === id)!
    expect(after.fee_source).toBe('rate')
    expect(after.fee).toBe(before.fee) // feeの値も変わらない
  })

  it('mellojoy_watch_dir / mellojoy_default_account_id はmigrateのたびに消される（取り込み取りやめ）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-watch-'))
    const path = join(dir, 'test.db')
    try {
      db.initDb(path)
      db.getDb().prepare(
        `INSERT OR REPLACE INTO setting (key, value) VALUES ('mellojoy_watch_dir', '/tmp/x')`,
      ).run()
      db.getDb().prepare(
        `INSERT OR REPLACE INTO setting (key, value) VALUES ('mellojoy_default_account_id', 'abc')`,
      ).run()
      expect(db.getSettings().mellojoy_watch_dir).toBe('/tmp/x')

      // 再起動を模す
      db.closeDb()
      db.initDb(path)

      const settings = db.getSettings()
      expect(settings.mellojoy_watch_dir).toBeUndefined()
      expect(settings.mellojoy_default_account_id).toBeUndefined()

      db.closeDb()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updateShopAccount / deleteShopAccount：改名・種別変更・無効化、仕入の有無で削除の可否が変わる', () => {
    db.updateShopAccount(shopId, { name: 'メロジョイA改', kind: 'tiktok', is_active: 0 })
    const updated = db.listShopAccounts().find(a => a.id === shopId)!
    expect(updated.name).toBe('メロジョイA改')
    expect(updated.kind).toBe('tiktok')
    expect(updated.is_active).toBe(0)

    // is_active に関係なく listShopAccounts は全件返す
    expect(db.listShopAccounts().some(a => a.id === shopId)).toBe(true)

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '仕入あり', unit_price: 1000, quantity: 1 }],
    })
    expect(() => db.deleteShopAccount(shopId)).toThrow('この仕入先は仕入で使われています。無効にしてください')
    expect(db.listShopAccounts().some(a => a.id === shopId)).toBe(true)

    // 仕入の無いアカウントは消せる
    const otherId = db.createShopAccount('仕入なしアカウント')
    db.deleteShopAccount(otherId)
    expect(db.listShopAccounts().some(a => a.id === otherId)).toBe(false)
  })

  it('updateShopAccount / getShopAccount：import_keywords の保存・空文字はnullに丸める', () => {
    expect(db.getShopAccount(shopId)!.import_keywords).toBeNull()

    db.updateShopAccount(shopId, { import_keywords: 'メロジョイ, Mellojoy' })
    expect(db.getShopAccount(shopId)!.import_keywords).toBe('メロジョイ, Mellojoy')
    expect(db.listShopAccounts().find(a => a.id === shopId)!.import_keywords).toBe('メロジョイ, Mellojoy')

    db.updateShopAccount(shopId, { import_keywords: '   ' })
    expect(db.getShopAccount(shopId)!.import_keywords).toBeNull()

    db.updateShopAccount(shopId, { import_keywords: null })
    expect(db.getShopAccount(shopId)!.import_keywords).toBeNull()
  })

  it('updateShopAccount：default_shipping_fee の保存・null に戻す・負や小数はエラー', () => {
    expect(db.getShopAccount(shopId)!.default_shipping_fee).toBeNull()

    db.updateShopAccount(shopId, { default_shipping_fee: 399 })
    expect(db.getShopAccount(shopId)!.default_shipping_fee).toBe(399)
    expect(db.listShopAccounts().find(a => a.id === shopId)!.default_shipping_fee).toBe(399)

    db.updateShopAccount(shopId, { default_shipping_fee: null })
    expect(db.getShopAccount(shopId)!.default_shipping_fee).toBeNull()

    expect(() => db.updateShopAccount(shopId, { default_shipping_fee: -1 }))
      .toThrow('送料は整数で入力してください')
    expect(() => db.updateShopAccount(shopId, { default_shipping_fee: 1.5 }))
      .toThrow('送料は整数で入力してください')
  })

  it('resetData：仕入・販売・紐付け・runを消す。マスタ（shop_account/shipping_method/setting）は残す', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'リセット対象', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    const saleId = db.createSale({ title: 'リセット対象', sold_at: '2026-01-05', price: 2000 })
    db.linkInventory(saleId, [item.id])

    const runId = db.startRun('mercari')
    db.finishRun(runId, 'ok', 1, 1)

    db.saveShippingMethod({ name: 'テスト発送方法', fee: 300 })
    db.setSetting('fee_rate_bp', '1234')

    const tagId = db.createTag('リセットテスト用')
    db.setSaleTags(saleId, [tagId])
    db.setInventoryTags(item.id, [tagId])

    // リセット前提の確認
    expect(db.listPurchases()).toHaveLength(1)
    expect(db.listSales()).toHaveLength(1)
    expect(db.listRuns()).toHaveLength(1)

    db.resetData()

    // 仕入・在庫・販売・紐付け・runは0件
    expect(db.listPurchases()).toHaveLength(0)
    expect(db.listSales()).toHaveLength(0)
    expect(db.listInventory('in_stock')).toHaveLength(0)
    expect(db.listInventory('sold')).toHaveLength(0)
    expect(db.listRuns()).toHaveLength(0)
    const counts = db.getDb().prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_line) AS purchase_line,
        (SELECT COUNT(*) FROM sale_line)     AS sale_line,
        (SELECT COUNT(*) FROM expense)       AS expense,
        (SELECT COUNT(*) FROM sale_tag)      AS sale_tag,
        (SELECT COUNT(*) FROM inventory_tag) AS inventory_tag
    `).get() as {
      purchase_line: number; sale_line: number; expense: number
      sale_tag: number; inventory_tag: number
    }
    expect(counts).toEqual({
      purchase_line: 0, sale_line: 0, expense: 0, sale_tag: 0, inventory_tag: 0,
    })

    // マスタは残る（tagも消えない。付け外しの記録だけ消える）
    expect(db.listShopAccounts()).toHaveLength(1)
    expect(db.listShopAccounts()[0].id).toBe(shopId)
    expect(db.listShippingMethods().some(m => m.name === 'テスト発送方法')).toBe(true)
    expect(db.getSettings().fee_rate_bp).toBe('1234')
    expect(db.listTags().some(t => t.id === tagId)).toBe(true)

    // getDashboard が例外なく返り、全部0
    const dash = db.getDashboard()
    expect(dash.needsShipping).toBe(0)
    expect(dash.needsMatch).toBe(0)
    expect(dash.needsPurchaseConfirm).toBe(0)
    expect(dash.stockCount).toBe(0)
    expect(dash.stockValue).toBe(0)
    expect(dash.agingCount).toBe(0)
    expect(dash.thisMonth).toBeNull()
    expect(dash.lastRun).toBeNull()
  })

  it('getDashboard().thisMonth：net_profit/expense_total/unconfirmed_shippingが入る（monthly_summaryビューを直読みすると無かった）', () => {
    createCompletedSale({ title: '今月の転売', sold_at: todayLocal(), price: 1000 })
    // 手動の経費（計上月省略→occurred_atの月）がexpense_totalに乗る
    db.createExpense({ occurred_at: todayLocal(), category: 'packaging', amount: 200 })

    const dash = db.getDashboard()
    expect(dash.thisMonth).not.toBeNull()
    expect(dash.thisMonth!.kind).toBe('resale')
    expect(dash.thisMonth!.revenue).toBe(1000)
    expect(dash.thisMonth!.total_fee).toBe(100) // fee_rate_bp既定1000(10%)
    expect(dash.thisMonth!.expense_total).toBe(200)
    expect(dash.thisMonth!.net_profit).toBe((1000 - 100) - 200)
  })

  it('タグ：作成・重複例外・改名・削除で販売から外れる', () => {
    const tagId = db.createTag('  セール品  ')
    expect(db.listTags()).toHaveLength(1)
    expect(db.listTags()[0].name).toBe('セール品') // 前後の空白は除去

    expect(() => db.createTag('セール品')).toThrow('同じ名前のタグがあります')
    expect(() => db.createTag('   ')).toThrow()

    db.renameTag(tagId, 'まとめ売り')
    expect(db.listTags()[0].name).toBe('まとめ売り')

    const otherId = db.createTag('another')
    expect(() => db.renameTag(otherId, 'まとめ売り')).toThrow('同じ名前のタグがあります')

    const saleId = db.createSale({ title: 'タグ付き商品', sold_at: '2026-01-01', price: 1000 })
    db.setSaleTags(saleId, [tagId])
    expect(db.listSales().find(s => s.id === saleId)!.tags.map(t => t.name)).toEqual(['まとめ売り'])

    db.deleteTag(tagId)
    expect(db.listTags().map(t => t.id)).toEqual([otherId])
    // CASCADEで販売からも外れる
    expect(db.listSales().find(s => s.id === saleId)!.tags).toEqual([])
  })

  it('setSaleTags / setInventoryTags：タグの置き換え（丸ごと入れ替え）', () => {
    const tagA = db.createTag('A')
    const tagB = db.createTag('B')

    const saleId = db.createSale({ title: '商品', sold_at: '2026-01-01', price: 1000 })
    db.setSaleTags(saleId, [tagA, tagB])
    expect(db.listSales().find(s => s.id === saleId)!.tags.map(t => t.id).sort())
      .toEqual([tagA, tagB].sort())

    // 置き換え：Bだけになる
    db.setSaleTags(saleId, [tagB])
    expect(db.listSales().find(s => s.id === saleId)!.tags.map(t => t.id)).toEqual([tagB])

    // 空配列で全部外す
    db.setSaleTags(saleId, [])
    expect(db.listSales().find(s => s.id === saleId)!.tags).toEqual([])

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'タグ付き在庫', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    db.setInventoryTags(item.id, [tagA])
    expect(db.listInventory('in_stock')[0].tags.map(t => t.id)).toEqual([tagA])
    db.setInventoryTags(item.id, [tagB])
    expect(db.listInventory('in_stock')[0].tags.map(t => t.id)).toEqual([tagB])
  })

  it('listSales({tagId})：タグで絞り込める', () => {
    const tagId = db.createTag('絞り込み用')
    const s1 = db.createSale({ title: 'A', sold_at: '2026-01-01', price: 1000 })
    const s2 = db.createSale({ title: 'B', sold_at: '2026-01-02', price: 1000 })
    db.setSaleTags(s1, [tagId])

    const filtered = db.listSales({ tagId })
    expect(filtered.map(s => s.id)).toEqual([s1])

    const all = db.listSales()
    expect(all.map(s => s.id).sort()).toEqual([s1, s2].sort())
  })

  it('saleTotals：タグ絞り込みの合計が手計算と一致する。0件なら全部0', () => {
    const tagId = db.createTag('集計用')
    const s1 = createCompletedSale({ title: 'A', sold_at: '2026-01-01', price: 2000 }) // fee 200
    const s2 = createCompletedSale({ title: 'B', sold_at: '2026-01-02', price: 3000 }) // fee 300
    createCompletedSale({ title: 'C（タグなし）', sold_at: '2026-01-03', price: 5000 })
    db.setSaleTags(s1, [tagId])
    db.setSaleTags(s2, [tagId])

    const totals = db.saleTotals({ tagId })
    expect(totals).toEqual({
      forecast: { count: 0, revenue: 0, gross_profit: 0 },
      count: 2,
      revenue: 2000 + 3000,
      total_fee: 200 + 300,
      total_shipping: 0,
      total_packaging: 0,
      total_cost: 0,
      gross_profit: (2000 - 200) + (3000 - 300),
    })

    const empty = db.saleTotals({ tagId: 'no-such-tag' })
    expect(empty).toEqual({
      forecast: { count: 0, revenue: 0, gross_profit: 0 },
      count: 0, revenue: 0, total_fee: 0, total_shipping: 0,
      total_packaging: 0, total_cost: 0, gross_profit: 0,
    })
  })

  it('source：自動取得(collector)と手入力(manual)がsale_profitに出る', () => {
    db.insertCollected([{ mercariItemId: 'src1', title: '自動取得の商品', price: 1000, soldAt: '2026-01-01' }])
    const manualId = db.createSale({ title: '手入力の商品', sold_at: '2026-01-01', price: 1000 })

    expect(db.listSales().find(s => s.mercari_item_id === 'src1')!.source).toBe('collector')
    expect(db.listSales().find(s => s.id === manualId)!.source).toBe('manual')
  })

  it('setSaleThumb：保存したファイル名が listSales / 紐付いた在庫の listInventory に soroban-thumb:// で出る。未紐付けの在庫はnull', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 },
        { name: 'いちごスフレ【Z088-2】', unit_price: 1200, quantity: 1 },
      ],
    })
    const [linkedItem, otherItem] = db.listInventory('in_stock')

    const saleId = db.createSale({ title: 'サムネイルテスト', sold_at: '2026-01-10', price: 2000 })
    db.linkInventory(saleId, [linkedItem.id])

    expect(db.listSales().find(s => s.id === saleId)!.thumb_url).toBeNull()

    db.setSaleThumb(saleId, 'm8703.jpg')

    expect(db.listSales().find(s => s.id === saleId)!.thumb_url).toBe('soroban-thumb://m8703.jpg')

    const sold = db.listInventory('sold')
    expect(sold.find(i => i.id === linkedItem.id)!.thumb_url).toBe('soroban-thumb://m8703.jpg')

    // 未紐付けの在庫（in_stockのまま）は当然null
    expect(db.listInventory('in_stock').find(i => i.id === otherItem.id)!.thumb_url).toBeNull()
  })

  it('salesWithoutThumb：thumb_fileがNULLの既存販売だけ返す（実DBに元からあった分にも後追いでサムネを付けるため）', () => {
    db.insertCollected([
      { mercariItemId: 'nt1', title: 'サムネ未保存', price: 1000, soldAt: '2026-01-01' },
      { mercariItemId: 'nt2', title: 'サムネ保存済み', price: 1000, soldAt: '2026-01-02' },
    ])
    const withThumbId = db.listSales().find(s => s.mercari_item_id === 'nt2')!.id
    db.setSaleThumb(withThumbId, 'nt2.jpg')

    const targets = db.salesWithoutThumb(['nt1', 'nt2', 'no-such-id'])
    expect(targets.map(t => t.mercariItemId)).toEqual(['nt1'])

    expect(db.salesWithoutThumb([])).toEqual([])
  })

  describe('メルカリの取引状態（取引中タブ）', () => {
    it('insertCollected：statusを渡すと保存され、shipped/delivered/completedの初期日付も入る', () => {
      db.insertCollected([
        { mercariItemId: 'ip-1', title: '発送待ちの商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
        { mercariItemId: 'ip-2', title: '評価待ちの商品', price: 1000, soldAt: '2026-08-02', status: 'delivered' },
        { mercariItemId: 'ip-3', title: '状態不明の商品', price: 1000, soldAt: '2026-08-03' },
      ])

      const s1 = db.listSales().find(s => s.mercari_item_id === 'ip-1')!
      expect(s1.status).toBe('waiting_shipment')
      expect(s1.shipped_at).toBeNull()
      expect(s1.delivered_at).toBeNull()
      expect(s1.completed_at).toBeNull()

      const s2 = db.listSales().find(s => s.mercari_item_id === 'ip-2')!
      expect(s2.status).toBe('delivered')
      expect(s2.shipped_at).toBe('2026-08-02')
      expect(s2.delivered_at).toBe('2026-08-02')
      expect(s2.completed_at).toBeNull()

      const s3 = db.listSales().find(s => s.mercari_item_id === 'ip-3')!
      expect(s3.status).toBeNull()
    })

    it('updateSaleStatus：状態は前にしか進まない。同じ状態・後戻りはfalseで何もしない', () => {
      db.insertCollected([
        { mercariItemId: 'st-1', title: '商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_payment' },
      ])
      const id = db.listSales().find(s => s.mercari_item_id === 'st-1')!.id

      expect(db.updateSaleStatus('st-1', 'waiting_shipment', '2026-08-02')).toBe(true)
      expect(db.listSales().find(s => s.id === id)!.status).toBe('waiting_shipment')

      // 後戻り：無視されfalse
      expect(db.updateSaleStatus('st-1', 'waiting_payment', '2026-08-03')).toBe(false)
      expect(db.listSales().find(s => s.id === id)!.status).toBe('waiting_shipment')

      // 同じ状態：無視されfalse
      expect(db.updateSaleStatus('st-1', 'waiting_shipment', '2026-08-03')).toBe(false)

      // 未知のmercari_item_idはfalse
      expect(db.updateSaleStatus('does-not-exist', 'shipped')).toBe(false)
    })

    it('updateSaleStatus：shipped_at・delivered_atは初めて観測した日で固定（後から呼んでも変わらない）', () => {
      db.insertCollected([
        { mercariItemId: 'st-2', title: '商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
      ])

      expect(db.updateSaleStatus('st-2', 'shipped', '2026-08-05')).toBe(true)
      let s = db.listSales().find(s => s.mercari_item_id === 'st-2')!
      expect(s.shipped_at).toBe('2026-08-05')
      expect(s.delivered_at).toBeNull()

      // delivered まで進めても、既に入っているshipped_atは動かない
      expect(db.updateSaleStatus('st-2', 'delivered', '2026-08-09')).toBe(true)
      s = db.listSales().find(s => s.mercari_item_id === 'st-2')!
      expect(s.shipped_at).toBe('2026-08-05')
      expect(s.delivered_at).toBe('2026-08-09')
    })

    it('updateCollectedActuals：売却済み一覧で観測したらstatus=completed・completed_atが付き、取引中タブで先に入っていたsold_atも完了日へ動く', () => {
      // 取引中タブで先に取り込まれた販売（sold_atは「初めて見た日」の仮日付）
      db.insertCollected([
        { mercariItemId: 'ip-done', title: '取引中から入った商品', price: 2000, soldAt: '2026-08-01', status: 'waiting_shipment' },
      ])
      db.updateSaleStatus('ip-done', 'shipped', '2026-08-02')

      // 後日、売却済み一覧（販売履歴）で観測。soldAtは本当の購入完了日
      const updated = db.updateCollectedActuals([
        { mercariItemId: 'ip-done', soldAt: '2026-08-10', fee: 200, shippingFee: 300 },
      ])
      expect(updated).toBe(1)

      const s = db.listSales().find(s => s.mercari_item_id === 'ip-done')!
      expect(s.sold_at).toBe('2026-08-10') // 仮置きから本当の完了日へ動く
      expect(s.status).toBe('completed')
      expect(s.completed_at).toBe('2026-08-10')
      expect(s.fee).toBe(200)
      expect(s.shipping_fee).toBe(300)

      // 2回目に呼んでも completed_at は最初に観測した日のまま
      db.updateCollectedActuals([
        { mercariItemId: 'ip-done', soldAt: '2026-08-11', fee: 200, shippingFee: 300 },
      ])
      expect(db.listSales().find(s => s.mercari_item_id === 'ip-done')!.completed_at).toBe('2026-08-10')
    })

    it('updateCollectedActuals：取引中タブを経由していない販売は、従来どおりsold_atを本当の日付に直す', () => {
      db.insertCollected([{ mercariItemId: 'plain-1', title: '商品', price: 1000, soldAt: '2026-08-01' }])

      db.updateCollectedActuals([{ mercariItemId: 'plain-1', soldAt: '2026-07-20', fee: 100 }])

      const s = db.listSales().find(s => s.mercari_item_id === 'plain-1')!
      expect(s.sold_at).toBe('2026-07-20')
      expect(s.status).toBe('completed')
      expect(s.completed_at).toBe('2026-07-20')
    })

    it('getDashboard().needsShipment：status=waiting_shipmentの件数', () => {
      db.insertCollected([
        { mercariItemId: 'ns-1', title: '発送待ち1', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
        { mercariItemId: 'ns-2', title: '発送待ち2', price: 1000, soldAt: '2026-08-02', status: 'waiting_shipment' },
        { mercariItemId: 'ns-3', title: '支払い待ち', price: 1000, soldAt: '2026-08-03', status: 'waiting_payment' },
        { mercariItemId: 'ns-4', title: '完了済み', price: 1000, soldAt: '2026-08-04', status: 'completed' },
      ])

      expect(db.getDashboard().needsShipment).toBe(2)
    })
  })

  it('migrate：version2のDB→3でタグ機能が使えるようになる', () => {
    // version2状態（tag系テーブルが無いだけ）をファイルDB上で作り、initDbで3へ上げる
    const dir = mkdtempSync(join(tmpdir(), 'soroban-tag-migrate-'))
    const path = join(dir, 'v2.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマ（version3）で作ってから、v2相当まで剥がす
      db.getDb().prepare(`UPDATE setting SET value = '2' WHERE key = 'schema_version'`).run()
      db.getDb().exec('DROP TABLE inventory_tag; DROP TABLE sale_tag; DROP TABLE tag;')
      const saleId = db.createSale({ title: '既存の販売', sold_at: '2026-01-01', price: 1000 })
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      const tagId = db.createTag('移行後タグ')
      db.setSaleTags(saleId, [tagId])
      expect(db.listSales().find(s => s.id === saleId)!.tags.map(t => t.id)).toEqual([tagId])

    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
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
    createCompletedSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-15', price: 2000 })
    createCompletedSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-16', price: 2000 })

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

  it('variant_summary：分割した在庫はまるごと換算（1/分割数の重み）で平均する', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ぬいぐるみ【X001】', unit_price: 3000, quantity: 2 }],
    })
    const [whole, toSplit] = db.listInventory('in_stock')

    // 1点目はまるごと¥3,600で販売。手数料10%: fee=360 → 粗利 = 3600-360-3000 = 240
    const saleWhole = createCompletedSale({ title: 'まるごと販売', sold_at: '2026-09-10', price: 3600 })
    db.linkInventory(saleWhole, [whole.id])

    // 2点目は4分割（750ずつ）。1個¥1,000で4個販売。手数料10%: fee=100 → 粗利 = 1000-100-750 = 150
    const childIds = db.splitInventory(toSplit.id, 4)
    childIds.forEach((childId, i) => {
      const saleId = createCompletedSale({ title: `ばら売り${i + 1}`, sold_at: '2026-09-11', price: 1000 })
      db.linkInventory(saleId, [childId])
    })

    const summary = db.listVariantSummary().find(v => v.model_code === 'X001')!
    expect(summary.sold).toBe(5) // 件数（「点」）は従来どおり5点
    // avg_price = Σprice_share ÷ Σweight = (3600 + 4*1000) / (1 + 4*0.25) = 7600 / 2 = 3800
    expect(summary.avg_price).toBe(3800)
    // avg_profit = Σprofit_share ÷ Σweight = (240 + 4*150) / 2 = 840 / 2 = 420
    expect(summary.avg_profit).toBe(420)
    expect(summary.total_profit).toBe(240 + 4 * 150)
  })

  it('variant_summary：分割の分割（孫）も再帰的に重みを算出する（1/8）', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ぬいぐるみ【Y001】', unit_price: 800, quantity: 1 }],
    })
    const parent = db.listInventory('in_stock')[0]
    const children = db.splitInventory(parent.id, 4) // 各200（重み1/4）
    const grandchildren = db.splitInventory(children[0], 2) // 各100（重み1/8）

    // 孫2点をまとめて¥600で販売。手数料10%: fee=60 → 粗利 = 600-60-(100+100) = 340
    const saleId = createCompletedSale({ title: 'まとめ売り', sold_at: '2026-09-12', price: 600 })
    db.linkInventory(saleId, grandchildren)

    const summary = db.listVariantSummary().find(v => v.model_code === 'Y001')!
    // Σweight = 1/8 + 1/8 = 0.25 → avg_price = 600/0.25 = 2400、avg_profit = 340/0.25 = 1360
    expect(summary.avg_price).toBe(2400)
    expect(summary.avg_profit).toBe(1360)
    expect(summary.total_profit).toBe(340)
  })

  it('setProductName：表示名を上書きし、nullで最新の在庫名に戻る', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ムースクリーム（箱）旧名【Z078-2】', unit_price: 1000, quantity: 1 }],
    })

    db.setProductName('Z078-2', 'ムースクリーム（箱）')

    const products = db.listProducts()
    const p = products.find(x => x.model_code === 'Z078-2')!
    expect(p.name).toBe('ムースクリーム（箱）')
    expect(p.custom_name).toBe('ムースクリーム（箱）')

    const variants = db.listVariantSummary()
    const v = variants.find(x => x.model_code === 'Z078-2')!
    expect(v.name).toBe('ムースクリーム（箱）')
    expect(v.custom_name).toBe('ムースクリーム（箱）')

    db.setProductName('Z078-2', null)
    const after = db.listProducts().find(x => x.model_code === 'Z078-2')!
    expect(after.name).toBe('ムースクリーム（箱）旧名【Z078-2】')
    expect(after.custom_name).toBeNull()
  })

  it('setProductNote：型番のメモを付ける／消す。表示名とは独立に残る', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ムースクリーム（箱）【Z078-2】', unit_price: 1000, quantity: 1 }],
    })

    // メモだけ付ける（表示名は付けない）
    db.setProductNote('Z078-2', '型崩れしやすいので注意')
    let p = db.listProducts().find(x => x.model_code === 'Z078-2')!
    expect(p.note).toBe('型崩れしやすいので注意')
    expect(p.custom_name).toBeNull()

    const karte = views.getProductKarte('Z078-2')
    expect(karte.summary.note).toBe('型崩れしやすいので注意')

    // 表示名を付けてもメモは残る
    db.setProductName('Z078-2', 'ムースクリーム（箱）')
    p = db.listProducts().find(x => x.model_code === 'Z078-2')!
    expect(p.custom_name).toBe('ムースクリーム（箱）')
    expect(p.note).toBe('型崩れしやすいので注意')

    // メモを消しても表示名は残る
    db.setProductNote('Z078-2', null)
    p = db.listProducts().find(x => x.model_code === 'Z078-2')!
    expect(p.note).toBeNull()
    expect(p.custom_name).toBe('ムースクリーム（箱）')

    // 空文字も null 扱いで消える
    db.setProductNote('Z078-2', '追記メモ')
    db.setProductNote('Z078-2', '   ')
    p = db.listProducts().find(x => x.model_code === 'Z078-2')!
    expect(p.note).toBeNull()
  })

  it('listShopAccountStats：確定済みの仕入だけ集計、下書きは含めない。仕入0件は0で返す', () => {
    const otherShopId = db.createShopAccount('仕入なしアカウント')

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 300,
      lines: [
        { name: '商品A', unit_price: 1000, quantity: 2 },
      ],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-10',
      shipping_fee: 0,
      lines: [
        { name: '商品B', unit_price: 500, quantity: 1 },
      ],
    })
    db.createPurchaseDraft({
      import_key: 'draft-for-stats',
      shop_account_id: shopId,
      ordered_at: '2026-09-05',
      lines: [{ name: '下書き商品', unit_price: 0, quantity: 1 }],
    })

    const purchases = db.listPurchases().filter(p => p.shop_account_id === shopId && p.status === 'confirmed')
    const expectedTotal = purchases.reduce((s, p) => s + p.total_cost, 0)

    const stats = db.listShopAccountStats()
    const mine = stats.find(s => s.shop_account_id === shopId)!
    expect(mine.orders).toBe(2)
    expect(mine.items).toBe(3)
    expect(mine.total_cost).toBe(expectedTotal)
    expect(mine.last_ordered_at).toBe('2026-09-10')

    const other = stats.find(s => s.shop_account_id === otherShopId)!
    expect(other.orders).toBe(0)
    expect(other.items).toBe(0)
    expect(other.total_cost).toBe(0)
    expect(other.last_ordered_at).toBeNull()
  })

  it('migrate：schema_versionが30になる', () => {
    expect(db.getSettings().schema_version).toBe('34')
  })

  it('migrate：Phase1の実物スキーマ（ビュー・トリガー込み）の既存DBが壊れず新列が使えるようになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-migrate-'))
    const path = join(dir, 'legacy.db')

    try {
      // 実機のDBを模す：Phase1の実物スキーマ（ビュー・トリガー・初期設定込み）に
      // 仕入1件・在庫2点・販売1件・紐付け1件・collector_run 1件を入れる
      const legacy = new BetterSqlite3(path)
      legacy.exec(PHASE1_SCHEMA_SQL)

      legacy.prepare(`INSERT INTO shop_account (id, name) VALUES ('shop1', 'メロジョイA')`).run()
      legacy.prepare(`
        INSERT INTO purchase (id, shop_account_id, ordered_at, shipping_fee)
        VALUES ('p1', 'shop1', '2026-01-01', 100)
      `).run()
      legacy.prepare(`
        INSERT INTO purchase_line
          (id, purchase_id, name, unit_price, quantity, allocated_cost, landed_unit_cost)
        VALUES ('pl1', 'p1', '旧仕様の商品', 1000, 2, 100, 1050)
      `).run()
      // 按分後原価1050円の在庫を2点（splitEvenly(100,2)=[50,50] → 1000+50）
      legacy.prepare(`
        INSERT INTO inventory_item (id, purchase_line_id, name, landed_cost, acquired_at)
        VALUES ('i1', 'pl1', '旧仕様の商品', 1050, '2026-01-01')
      `).run()
      legacy.prepare(`
        INSERT INTO inventory_item (id, purchase_line_id, name, landed_cost, acquired_at)
        VALUES ('i2', 'pl1', '旧仕様の商品', 1050, '2026-01-01')
      `).run()
      legacy.prepare(`
        INSERT INTO sale (id, title, sold_at, price, fee)
        VALUES ('s1', '旧仕様の商品', '2026-01-10', 3000, 300)
      `).run()
      // トリガー trg_sline_sold により i1 は挿入直後に sold になる（Phase1の実挙動）
      legacy.prepare(`
        INSERT INTO sale_line (id, sale_id, inventory_item_id) VALUES ('sl1', 's1', 'i1')
      `).run()
      legacy.prepare(`
        INSERT INTO collector_run (id, started_at, finished_at, status, fetched, inserted)
        VALUES ('run1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'ok', 1, 1)
      `).run()
      legacy.close()

      // ---- 1回目の initDb：例外なく通ること ----
      expect(() => db.initDb(path)).not.toThrow()

      // データが残っている：在庫2点（1つは紐付け済みでsold、もう1つがin_stock）
      const inStock = db.listInventory('in_stock')
      expect(inStock).toHaveLength(1)
      expect(inStock[0].id).toBe('i2')
      expect(inStock[0].landed_cost).toBe(1050)

      // 販売の粗利がビュー（sale_profit）経由で読める
      const sale = db.listSales().find(s => s.id === 's1')!
      expect(sale.cost).toBe(1050)
      expect(sale.gross_profit).toBe(3000 - 300 - 0 - 0 - 1050)
      expect(sale.unmatched).toBe(0)

      expect(db.listRuns()).toHaveLength(1)
      // v4で足した列。既存行は既定値 'mercari' になる
      expect(db.listRuns()[0].source).toBe('mercari')
      expect(db.listRuns()[0].shop_account_id).toBeNull()

      // splitInventory が使える（status CHECK に 'split' が足されている）
      const children = db.splitInventory('i2', 2)
      expect(children).toHaveLength(2)
      expect(db.listInventory('split')).toHaveLength(1)
      expect(db.listInventory('in_stock')).toHaveLength(2)

      // collect_interval_h が 6 → 1 に更新されている
      expect(db.getSettings().collect_interval_h).toBe('1')

      // ---- 2回目の initDb（同じファイル）：冪等であること ----
      db.closeDb()
      expect(() => db.initDb(path)).not.toThrow()

      const inStockAfter = db.listInventory('in_stock')
      expect(inStockAfter).toHaveLength(2) // 分割した子2点はそのまま残る
      expect(db.listInventory('split')).toHaveLength(1)
      const saleAfter = db.listSales().find(s => s.id === 's1')!
      expect(saleAfter.cost).toBe(1050)
      expect(saleAfter.gross_profit).toBe(3000 - 300 - 0 - 0 - 1050)
      expect(db.getSettings().collect_interval_h).toBe('1')
      expect(db.getSettings().schema_version).toBe('34')

      // タグ機能（version3）もこの経路で使えるようになっている
      const tagId = db.createTag('移行後タグ')
      db.setSaleTags('s1', [tagId])
      expect(db.listSales().find(s => s.id === 's1')!.tags.map(t => t.id)).toEqual([tagId])
    } finally {
      // アサーション失敗時もハンドルを解放してから片付ける（EBUSYで本当のエラーが
      // 隠れないように）
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version18相当の経費明細（unit_priceが無い）→19でamount/quantityからunit_priceを逆算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-expense-migrate-'))
    const path = join(dir, 'v18.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、明細をv18相当（amount/quantityのみ）の値で直挿しする
      const expenseId = db.createExpense({ occurred_at: '2026-01-01', category: 'packaging', amount: 2200 })
      db.getDb().prepare(`
        INSERT INTO expense_line (id, expense_id, name, amount, quantity, category, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('line-divisible', expenseId, '割り切れる行', 1200, 4, 'packaging', 0)
      db.getDb().prepare(`
        INSERT INTO expense_line (id, expense_id, name, amount, quantity, category, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('line-remainder', expenseId, '割り切れない行', 1000, 3, 'packaging', 1)
      db.getDb().prepare(`UPDATE setting SET value = '18' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      const expense = db.listExpenses('2026-01').find(e => e.id === expenseId)!
      const divisible = expense.lines.find(l => l.id === 'line-divisible')!
      expect(divisible).toMatchObject({ unit_price: 300, quantity: 4, amount: 1200 })
      const remainder = expense.lines.find(l => l.id === 'line-remainder')!
      expect(remainder).toMatchObject({ unit_price: 1000, quantity: 1, amount: 1000 })
      // amount自体は動かさない（合計をずらさない）
      expect(expense.amount).toBe(2200)
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version25相当（expense.registration_noが無い）→26で列が足され、既存行はnullになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-expense-regno-migrate-'))
    const path = join(dir, 'v25.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、v25相当（registration_no列が無い）まで剥がす
      const expenseId = db.createExpense({ occurred_at: '2026-01-01', category: 'packaging', amount: 500 })
      db.getDb().exec('ALTER TABLE expense DROP COLUMN registration_no')
      db.getDb().prepare(`UPDATE setting SET value = '25' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      const expense = db.listExpenses('2026-01').find(e => e.id === expenseId)!
      expect(expense.registration_no).toBeNull()
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version26相当（product_name.nameがNOT NULL・note列が無い）→27で既存の表示名を保ったままnoteが使えるようになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-product-note-migrate-'))
    const path = join(dir, 'v26.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、v26相当（name NOT NULL・note列なし）まで剥がす
      const migrateShopId = db.createShopAccount('メロジョイA')
      db.createPurchase({
        shop_account_id: migrateShopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'ムースクリーム（箱）旧名【Z078-2】', unit_price: 1000, quantity: 1 }],
      })
      db.getDb().exec(`
        DROP VIEW IF EXISTS sale_line_share;
        DROP VIEW IF EXISTS sale_profit;
        DROP VIEW IF EXISTS monthly_summary;
        DROP VIEW IF EXISTS inventory_view;
        DROP VIEW IF EXISTS variant_summary;

        CREATE TABLE product_name_old (
          model_code TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO product_name_old (model_code, name, updated_at)
          VALUES ('Z078-2', '旧表示名', '2026-01-01T00:00:00.000Z');
        DROP TABLE product_name;
        ALTER TABLE product_name_old RENAME TO product_name;
      `)
      db.getDb().prepare(`UPDATE setting SET value = '26' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      // 既存の表示名はそのまま残る
      const p = db.listProducts().find(x => x.model_code === 'Z078-2')
      expect(p?.custom_name).toBe('旧表示名')
      expect(p?.note ?? null).toBeNull()

      // 移行後にメモも付けられる（name NOT NULLが外れている）
      db.setProductNote('Z078-2', '移行後のメモ')
      const after = db.listProducts().find(x => x.model_code === 'Z078-2')
      expect(after?.custom_name).toBe('旧表示名')
      expect(after?.note).toBe('移行後のメモ')
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createPurchaseDraft：order_no・shipping_fee・discount・unit_priceが取れていれば確定画面に前もって埋まる', () => {
    const draftId = db.createPurchaseDraft({
      import_key: 'order-100',
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      order_no: 'ORDER-100',
      shipping_fee: 300,
      discount: 50,
      lines: [{ name: 'いちごスフレ【Z072-8】', quantity: 2, unit_price: 800 }],
    })
    expect(draftId).not.toBe('')

    const detail = db.getPurchase(draftId)
    expect(detail.order_no).toBe('ORDER-100')
    expect(detail.shipping_fee).toBe(300)
    expect(detail.discount).toBe(50)
    expect(detail.lines[0].unit_price).toBe(800)
  })

  it('createPurchase：import_keyが一致すればlistPurchasesに出る。同じkeyの2回目はthrow', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      import_key: 'order-200',
      lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
    })

    expect(db.listPurchases()[0].import_key).toBe('order-200')
    expect(db.existingImportKeys(['order-200', 'no-such-key'])).toEqual(new Set(['order-200']))

    expect(() => db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-02-02',
      import_key: 'order-200',
      lines: [{ name: '別の商品', unit_price: 500, quantity: 1 }],
    })).toThrow('同じ注文が既に取り込まれています: order-200')

    // 2回目が弾かれているので仕入は1件のまま
    expect(db.listPurchases()).toHaveLength(1)
  })

  describe('createPurchase：注文番号の重複を分かる言葉で断る', () => {
    it('同じ仕入先・同じ注文番号は2回目がエラー。別の仕入先なら通る', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        order_no: 'ORD-1',
        lines: [{ name: '商品A', unit_price: 1000, quantity: 1 }],
      })

      expect(() => db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-05',
        order_no: 'ORD-1',
        lines: [{ name: '商品B', unit_price: 1000, quantity: 1 }],
      })).toThrow('この仕入先には注文番号「ORD-1」の仕入が既にあります（2026-03-01 の登録）')

      const otherShopId = db.createShopAccount('メロジョイB')
      expect(() => db.createPurchase({
        shop_account_id: otherShopId,
        ordered_at: '2026-03-06',
        order_no: 'ORD-1',
        lines: [{ name: '商品C', unit_price: 1000, quantity: 1 }],
      })).not.toThrow()

      // 弾かれた1件は登録されていない
      expect(db.listPurchases()).toHaveLength(2)
    })

    it('注文番号がnull・空文字・空白だけなら何件でも通る（空文字はnullとして保存される）', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        order_no: null,
        lines: [{ name: '商品A', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-02',
        order_no: '',
        lines: [{ name: '商品B', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-03',
        order_no: '   ',
        lines: [{ name: '商品C', unit_price: 1000, quantity: 1 }],
      })

      const list = db.listPurchases()
      expect(list).toHaveLength(3)
      expect(list.every(p => p.order_no === null)).toBe(true)
    })

    it('他のCHECK/NOT NULL違反も日本語で弾く', () => {
      expect(() => db.createPurchase({
        shop_account_id: 'no-such-shop',
        ordered_at: '2026-03-01',
        lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
      })).toThrow('仕入先が見つかりません')

      expect(() => db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        lines: [],
      })).toThrow('明細がありません')

      expect(() => db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        lines: [{ name: '商品', unit_price: 1000, quantity: 0 }],
      })).toThrow('数量は1以上の整数で入力してください')

      expect(() => db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        lines: [{ name: '商品', unit_price: -1, quantity: 1 }],
      })).toThrow('単価は整数で入力してください')

      expect(() => db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026/03/01',
        lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
      })).toThrow('注文日はYYYY-MM-DDの形式で入力してください')
    })
  })

  describe('importPurchases：まとめて登録', () => {
    it('正常・DB重複・ファイル内重複が混ざっても、成功分だけ登録され失敗理由が返る', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-04-01',
        order_no: 'DUP-1',
        lines: [{ name: '既存', unit_price: 1000, quantity: 1 }],
      })

      const result = db.importPurchases([
        {
          shop_account_id: shopId,
          ordered_at: '2026-04-02',
          order_no: 'NEW-1',
          lines: [{ name: '新規', unit_price: 1000, quantity: 1 }],
        },
        {
          // DB既存と重複
          shop_account_id: shopId,
          ordered_at: '2026-04-03',
          order_no: 'DUP-1',
          lines: [{ name: 'DB重複', unit_price: 1000, quantity: 1 }],
        },
        {
          shop_account_id: shopId,
          ordered_at: '2026-04-04',
          order_no: 'SAME-IN-FILE',
          lines: [{ name: 'ファイル内1件目', unit_price: 1000, quantity: 1 }],
        },
        {
          // 同じ呼び出しの中で注文番号が重複
          shop_account_id: shopId,
          ordered_at: '2026-04-05',
          order_no: 'SAME-IN-FILE',
          lines: [{ name: 'ファイル内2件目', unit_price: 1000, quantity: 1 }],
        },
      ])

      expect(result.created).toBe(2)
      expect(result.skipped).toEqual([
        { index: 1, reason: expect.stringContaining('この仕入先には注文番号「DUP-1」の仕入が既にあります') },
        { index: 3, reason: '同じCSVの中で注文番号「SAME-IN-FILE」が重複しています' },
      ])

      const names = db.listPurchases().map(p => p.first_line_name).sort()
      expect(names).toEqual(['新規', '既存', 'ファイル内1件目'].sort())
    })

    it('数量0の行はskipになり、他の行は登録される', () => {
      const result = db.importPurchases([
        {
          shop_account_id: shopId,
          ordered_at: '2026-05-01',
          lines: [{ name: '正常', unit_price: 1000, quantity: 1 }],
        },
        {
          shop_account_id: shopId,
          ordered_at: '2026-05-02',
          lines: [{ name: '数量0', unit_price: 1000, quantity: 0 }],
        },
        {
          shop_account_id: shopId,
          ordered_at: '2026-05-03',
          lines: [{ name: '正常2', unit_price: 500, quantity: 2 }],
        },
      ])

      expect(result.created).toBe(2)
      expect(result.skipped).toEqual([
        { index: 1, reason: expect.stringContaining('数量は1以上の整数で入力してください') },
      ])
    })
  })

  it('fulfillment：createPurchaseで指定した到着状態が仕入・在庫の両方に出て、updatePurchaseFulfillmentで更新できる', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-01',
      import_key: 'mellojoy:#111',
      fulfillment: 'pending',
      lines: [{ name: '到着状態テスト', unit_price: 1000, quantity: 1 }],
    })

    expect(db.listPurchases()[0].fulfillment).toBe('pending')
    expect(db.listInventory('in_stock')[0].fulfillment).toBe('pending')

    // 一覧の状態が進んだら import_key で引いて更新できる（在庫側にも反映される）
    const changed = db.updatePurchaseFulfillment('mellojoy:#111', 'delivered')
    expect(changed).toBe(true)
    expect(db.listPurchases()[0].fulfillment).toBe('delivered')
    expect(db.listInventory('in_stock')[0].fulfillment).toBe('delivered')

    // 同じ値なら false（変化なし）
    expect(db.updatePurchaseFulfillment('mellojoy:#111', 'delivered')).toBe(false)

    // 未知の import_key は false
    expect(db.updatePurchaseFulfillment('mellojoy:#no-such', 'shipped')).toBe(false)
  })

  it('updatePurchaseFulfillment：今より低い状態には巻き戻さない（人が到着済にしたものを収集で戻さない）', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-05',
      import_key: 'mellojoy:#downgrade',
      fulfillment: 'delivered',
      lines: [{ name: '巻き戻り防止テスト', unit_price: 1000, quantity: 1 }],
    })
    expect(db.listPurchases()[0].fulfillment).toBe('delivered')

    // delivered → shipped（一覧が「配送中」を指している）は変えない
    expect(db.updatePurchaseFulfillment('mellojoy:#downgrade', 'shipped')).toBe(false)
    expect(db.listPurchases()[0].fulfillment).toBe('delivered')

    // shipped → null（取れなかった）も変えない
    expect(db.updatePurchaseFulfillment('mellojoy:#downgrade', null)).toBe(false)
    expect(db.listPurchases()[0].fulfillment).toBe('delivered')

    // pending → shipped は進むので変わる
    const draftId = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-06',
      import_key: 'mellojoy:#upgrade',
      fulfillment: 'pending',
      lines: [{ name: '前進はできる', unit_price: 1000, quantity: 1 }],
    })
    expect(db.updatePurchaseFulfillment('mellojoy:#upgrade', 'shipped')).toBe(true)
    expect(db.getPurchase(draftId).fulfillment).toBe('shipped')

    // 手動（setPurchaseFulfillment）は今まで通り何にでも変えられる（shipped → pending に戻せる）
    db.setPurchaseFulfillment(draftId, 'pending')
    expect(db.getPurchase(draftId).fulfillment).toBe('pending')
  })

  it('fulfillment：指定しなければ null。confirmPurchaseはfulfillmentに触らない', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-01',
      lines: [{ name: 'fulfillment未指定', unit_price: 1000, quantity: 1 }],
    })
    expect(db.listPurchases()[0].fulfillment).toBeNull()

    const draftId = db.createPurchaseDraft({
      import_key: 'mellojoy:#222',
      shop_account_id: shopId,
      ordered_at: '2026-03-02',
      fulfillment: 'shipped',
      lines: [{ name: '下書きfulfillment', quantity: 1 }],
    })
    expect(db.getPurchase(draftId).fulfillment).toBe('shipped')

    db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-03-02',
      shipping_fee: 0,
      lines: [{ name: '下書きfulfillment', unit_price: 1000, quantity: 1 }],
    })
    // 確定時にfulfillmentを渡さなくても、下書きの値が保たれる（確定処理では触らない）
    expect(db.getPurchase(draftId).fulfillment).toBe('shipped')
  })

  it('setPurchaseFulfillment：idを指定して到着状態を手で変えられる（TikTok Shopなど自動取得しない仕入先向け）', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      lines: [{ name: '手動fulfillment', unit_price: 1000, quantity: 1 }],
    })
    expect(db.getPurchase(id).fulfillment).toBeNull()

    db.setPurchaseFulfillment(id, 'shipped')
    const afterShipped = db.getPurchase(id)
    expect(afterShipped.fulfillment).toBe('shipped')
    expect(afterShipped.shipped_at).not.toBeNull()
    expect(afterShipped.delivered_at).toBeNull()

    db.setPurchaseFulfillment(id, 'delivered')
    const afterDelivered = db.getPurchase(id)
    expect(afterDelivered.fulfillment).toBe('delivered')
    expect(afterDelivered.shipped_at).toBe(afterShipped.shipped_at) // 既に入っていた日は触らない
    expect(afterDelivered.delivered_at).not.toBeNull()

    // 後戻り（delivered → pending）も許可するが、日付は消さない
    db.setPurchaseFulfillment(id, 'pending')
    const afterPending = db.getPurchase(id)
    expect(afterPending.fulfillment).toBe('pending')
    expect(afterPending.shipped_at).toBe(afterShipped.shipped_at)
    expect(afterPending.delivered_at).toBe(afterDelivered.delivered_at)

    // 在庫側（inventory_view由来のfulfillment）も追従する
    expect(db.listInventory('in_stock')[0].fulfillment).toBe('pending')

    expect(() => db.setPurchaseFulfillment('no-such-id', 'shipped')).toThrow('仕入が見つかりません')
  })

  it('createPurchase：fulfillmentを指定した状態で保存できる（フォームからの初期状態）', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-02',
      fulfillment: 'pending',
      lines: [{ name: 'フォームの初期状態', unit_price: 1000, quantity: 1 }],
    })
    expect(db.getPurchase(id).fulfillment).toBe('pending')
  })

  it('startRun：sourceとshop_account_idを渡すと、finishRun/listRunsにshop_account_nameまで付いて返る', () => {
    const runId = db.startRun('mellojoy', shopId)
    const finished = db.finishRun(runId, 'ok', 3, 3)
    expect(finished.source).toBe('mellojoy')
    expect(finished.shop_account_id).toBe(shopId)
    expect(finished.shop_account_name).toBe('メロジョイA')

    const listed = db.listRuns().find(r => r.id === runId)!
    expect(listed.source).toBe('mellojoy')
    expect(listed.shop_account_id).toBe(shopId)
    expect(listed.shop_account_name).toBe('メロジョイA')

    // shop_account_idを省略するとmercari収集と同じくnull
    const mercariRunId = db.startRun('mercari')
    const mercariRun = db.finishRun(mercariRunId, 'ok', 1, 1)
    expect(mercariRun.source).toBe('mercari')
    expect(mercariRun.shop_account_id).toBeNull()
    expect(mercariRun.shop_account_name).toBeNull()
  })

  it('updatePurchaseFulfillment：shipped_at・delivered_atが最初に観測した日で入る（delivered直行ならshipped_atも同時に埋まる）', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      import_key: 'mellojoy:#date-1',
      fulfillment: 'pending',
      lines: [{ name: '日付テスト', unit_price: 1000, quantity: 1 }],
    })
    expect(db.listPurchases()[0].shipped_at).toBeNull()
    expect(db.listPurchases()[0].delivered_at).toBeNull()

    db.updatePurchaseFulfillment('mellojoy:#date-1', 'shipped')
    const afterShipped = db.listPurchases()[0]
    expect(afterShipped.shipped_at).not.toBeNull()
    expect(afterShipped.delivered_at).toBeNull()

    db.updatePurchaseFulfillment('mellojoy:#date-1', 'delivered')
    const afterDelivered = db.listPurchases()[0]
    expect(afterDelivered.shipped_at).toBe(afterShipped.shipped_at) // 既に入っていた日は上書きしない
    expect(afterDelivered.delivered_at).not.toBeNull()

    // delivered へ直行した場合はshipped_atも同時に埋まる
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-02',
      import_key: 'mellojoy:#date-2',
      fulfillment: 'pending',
      lines: [{ name: '直行テスト', unit_price: 1000, quantity: 1 }],
    })
    db.updatePurchaseFulfillment('mellojoy:#date-2', 'delivered')
    const direct = db.listPurchases().find(p => p.import_key === 'mellojoy:#date-2')!
    expect(direct.shipped_at).not.toBeNull()
    expect(direct.delivered_at).not.toBeNull()
  })

  it('createPurchase：fulfillmentがshipped/deliveredなら生成時点でshipped_at/delivered_atが入る', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      fulfillment: 'shipped',
      lines: [{ name: '生成時shipped', unit_price: 1000, quantity: 1 }],
    })
    const shipped = db.listPurchases().find(p => p.first_line_name === '生成時shipped')!
    expect(shipped.shipped_at).not.toBeNull()
    expect(shipped.delivered_at).toBeNull()

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      fulfillment: 'delivered',
      lines: [{ name: '生成時delivered', unit_price: 1000, quantity: 1 }],
    })
    const delivered = db.listPurchases().find(p => p.first_line_name === '生成時delivered')!
    expect(delivered.shipped_at).not.toBeNull()
    expect(delivered.delivered_at).not.toBeNull()
  })

  it('applyFulfillmentFromShop：状態はupdatePurchaseFulfillmentと同じ規則で前に進み、日付はお店の日付でそのまま入る', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'pending',
      lines: [{ name: 'お店の日付テスト', unit_price: 1000, quantity: 1 }],
    })

    const changed = db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: '2026-09-23',
      delivered_at: null,
      carrier: null,
      tracking_number: null,
    })
    expect(changed).toBe(true)
    const after = db.getPurchase(id)
    expect(after.fulfillment).toBe('shipped')
    expect(after.shipped_at).toBe('2026-09-23')
    expect(after.delivered_at).toBeNull()
  })

  it('applyFulfillmentFromShop：今より低い状態には巻き戻さないが、日付はお店の日付で上書きされる（気づいた日より正確なため）', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'delivered',
      lines: [{ name: '降格しないテスト', unit_price: 1000, quantity: 1 }],
    })
    const before = db.getPurchase(id)
    expect(before.fulfillment).toBe('delivered')

    const changed = db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: '2026-09-10',
      delivered_at: null,
      carrier: null,
      tracking_number: null,
    })
    expect(changed).toBe(true) // 状態は変わらないが日付が変わったのでtrue
    const after = db.getPurchase(id)
    // 状態はdeliveredのまま（一覧が「配送中」を指していても巻き戻さない）
    expect(after.fulfillment).toBe('delivered')
    // 日付はお店から読めた実際の日で上書きされる
    expect(after.shipped_at).toBe('2026-09-10')
  })

  it('applyFulfillmentFromShop：日付・追跡番号・業者がnullのときは既存の値を消さない', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'pending',
      lines: [{ name: 'null温存テスト', unit_price: 1000, quantity: 1 }],
    })
    db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: '2026-09-05',
      delivered_at: null,
      carrier: 'SF Express',
      tracking_number: 'SF1234567890',
    })
    expect(db.getPurchaseTrackingNumber(id)).toBe('SF1234567890')

    // 次の収集で追跡番号・業者・日付が読めなかった（null）→ 消えない
    const changed = db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: null,
      delivered_at: null,
      carrier: null,
      tracking_number: null,
    })
    expect(changed).toBe(false) // 何も変わっていない
    const after = db.getPurchase(id)
    expect(after.shipped_at).toBe('2026-09-05')
    expect(after.tracking_carrier).toBe('SF Express')
    expect(after.tracking_number).toBe('SF1234567890')
    expect(db.getPurchaseTrackingNumber(id)).toBe('SF1234567890')
  })

  it('applyFulfillmentFromShop：存在しない仕入idはfalse', () => {
    expect(db.applyFulfillmentFromShop('no-such-id', {
      status: 'shipped', shipped_at: '2026-09-05', delivered_at: null, carrier: null, tracking_number: null,
    })).toBe(false)
  })

  it('getPurchaseTrackingNumber：追跡番号を登録していない仕入はnull', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      lines: [{ name: '追跡番号なし', unit_price: 1000, quantity: 1 }],
    })
    expect(db.getPurchaseTrackingNumber(id)).toBeNull()
    expect(db.getPurchaseTrackingNumber('no-such-id')).toBeNull()
  })

  it('getPurchaseTracking：番号・到着状態・保存済みの状態をまとめて返す。存在しない仕入はnull', () => {
    const id = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'shipped',
      lines: [{ name: '配送中', unit_price: 1000, quantity: 1 }],
    })
    db.applyFulfillmentFromShop(id, {
      status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-GET-1',
    })
    expect(db.getPurchaseTracking(id)).toEqual({
      tracking_number: 'TRK-GET-1', fulfillment: 'shipped', tracking_status: null,
      tracking_registered_at: null,
    })

    db.applyTrackingResult(id, { status_text: '輸送中', fulfillment: null, delivered_at: null })
    expect(db.getPurchaseTracking(id)).toEqual({
      tracking_number: 'TRK-GET-1', fulfillment: 'shipped', tracking_status: '輸送中',
      tracking_registered_at: null,
    })

    db.markTrackingRegistered([id])
    expect(db.getPurchaseTracking(id)!.tracking_registered_at).not.toBeNull()

    expect(db.getPurchaseTracking('no-such-id')).toBeNull()
  })

  describe('trackingCheckCandidates / applyTrackingResult：17TRACK（追跡番号のサイト）を見るべき仕入と結果の反映', () => {
    function makeTrackedPurchase(
      name: string, trackingNumber: string | null,
      fulfillment: 'pending' | 'shipped' | 'delivered' | null = 'shipped',
      registered = true,
    ) {
      const id = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-09-01',
        fulfillment,
        lines: [{ name, unit_price: 1000, quantity: 1 }],
      })
      if (trackingNumber !== null) {
        db.applyFulfillmentFromShop(id, {
          status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: trackingNumber,
        })
        if (registered) db.markTrackingRegistered([id])
      }
      return id
    }

    it('追跡番号が無い仕入は候補に出ない', () => {
      makeTrackedPurchase('番号なし', null)
      expect(db.trackingCheckCandidates(10)).toEqual([])
    })

    it('到着済み（delivered）は候補に出ない', () => {
      const id = makeTrackedPurchase('到着済', 'TRK-DELIVERED', 'delivered')
      expect(db.trackingCheckCandidates(10).some(c => c.id === id)).toBe(false)
    })

    it('17TRACKにまだ登録していない（tracking_registered_atがnull）は候補に出ない（register前にgettrackinfoを呼ぶとエラーになるため）', () => {
      const id = makeTrackedPurchase('未登録', 'TRK-UNREGISTERED', 'shipped', false)
      expect(db.trackingCheckCandidates(10).some(c => c.id === id)).toBe(false)
      expect(db.trackingCheckCandidates().some(c => c.id === id)).toBe(false)
    })

    it('未確認（tracking_checked_atがnull）が先、次に古い順', () => {
      const idUnchecked = makeTrackedPurchase('未確認', 'TRK-A')
      const idOldChecked = makeTrackedPurchase('前に確認済み', 'TRK-B')
      const idRecentChecked = makeTrackedPurchase('直近に確認済み', 'TRK-C')

      db.getDb().prepare(
        `UPDATE purchase SET tracking_checked_at = datetime('now', '-25 hours') WHERE id = ?`,
      ).run(idOldChecked)
      db.getDb().prepare(
        `UPDATE purchase SET tracking_checked_at = datetime('now', '-1 hours') WHERE id = ?`,
      ).run(idRecentChecked)

      const ids = db.trackingCheckCandidates(10).map(c => c.id)
      expect(ids).toEqual([idUnchecked, idOldChecked, idRecentChecked])
    })

    it('最後に見た時刻にかかわらず候補に出る（取り込みは起動時と手動のときだけで間隔を空ける意味が無い）', () => {
      const idJustChecked = makeTrackedPurchase('1分前に確認済み', 'TRK-1M')

      db.getDb().prepare(
        `UPDATE purchase SET tracking_checked_at = datetime('now', '-1 minutes') WHERE id = ?`,
      ).run(idJustChecked)

      const ids = db.trackingCheckCandidates(10).map(c => c.id)
      expect(ids).toContain(idJustChecked)
    })

    it('limitを渡すと絞られる、省略すると全件返る', () => {
      makeTrackedPurchase('limit-a', 'TRK-L1')
      makeTrackedPurchase('limit-b', 'TRK-L2')
      expect(db.trackingCheckCandidates(1)).toHaveLength(1)
      expect(db.trackingCheckCandidates()).toHaveLength(2)
    })

    it('applyTrackingResult：配送中→delivered＋到着日で、fulfillmentとdelivered_atが入りtrue', () => {
      const id = makeTrackedPurchase('配達完了', 'TRK-D1', 'shipped')

      const changed = db.applyTrackingResult(id, {
        status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-09-20',
      })
      expect(changed).toBe(true)

      const after = db.getPurchase(id)
      expect(after.fulfillment).toBe('delivered')
      expect(after.delivered_at).toBe('2026-09-20')
      expect(after.tracking_status).toBe('配達完了')
      expect(after.tracking_checked_at).not.toBeNull()
    })

    it('applyTrackingResult：すでに人が到着済にしている仕入にshippedを渡しても戻らない', () => {
      const id = makeTrackedPurchase('到着済み・人の手で確定', 'TRK-D2', 'delivered')

      db.applyTrackingResult(id, { status_text: '輸送中', fulfillment: 'shipped', delivered_at: null })

      const after = db.getPurchase(id)
      expect(after.fulfillment).toBe('delivered') // 前に進む方向だけなので戻らない
    })

    it('applyTrackingResult：status_textだけ（fulfillment: null）でもtracking_status/tracking_checked_atは進み、到着状態は変わらずfalse', () => {
      const id = makeTrackedPurchase('情報不明', 'TRK-D3', 'shipped')

      const changed = db.applyTrackingResult(id, {
        status_text: '情報が見つかりません', fulfillment: null, delivered_at: null,
      })
      expect(changed).toBe(false)

      const after = db.getPurchase(id)
      expect(after.fulfillment).toBe('shipped') // 変わらない
      expect(after.tracking_status).toBe('情報が見つかりません') // 表示用の言葉は進む
      expect(after.tracking_checked_at).not.toBeNull() // 次の収集で同じものばかり引かないよう進む
    })

    it('applyTrackingResult：存在しない仕入idはfalse（例外を投げない）', () => {
      expect(db.applyTrackingResult('no-such-id', {
        status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-09-20',
      })).toBe(false)
    })
  })

  describe('trackingRegisterCandidates / markTrackingRegistered / trackingCounts：17TRACKへの登録（無料枠を消費する側）', () => {
    function makeUnregisteredPurchase(
      name: string, trackingNumber: string | null,
      fulfillment: 'pending' | 'shipped' | 'delivered' | null = 'shipped',
    ) {
      const id = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-09-01',
        fulfillment,
        lines: [{ name, unit_price: 1000, quantity: 1 }],
      })
      if (trackingNumber !== null) {
        db.applyFulfillmentFromShop(id, {
          status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: trackingNumber,
        })
      }
      return id
    }

    it('trackingRegisterCandidates：追跡番号が無い／到着済／すでに登録済みは出ない。未登録の未到着だけ出る', () => {
      const noNumber = makeUnregisteredPurchase('番号なし', null)
      const delivered = makeUnregisteredPurchase('到着済', 'TRK-REG-DELIVERED', 'delivered')
      const alreadyRegistered = makeUnregisteredPurchase('登録済み', 'TRK-REG-DONE', 'shipped')
      db.markTrackingRegistered([alreadyRegistered])
      const target = makeUnregisteredPurchase('未登録', 'TRK-REG-TARGET', 'shipped')

      const ids = db.trackingRegisterCandidates().map(c => c.id)
      expect(ids).not.toContain(noNumber)
      expect(ids).not.toContain(delivered)
      expect(ids).not.toContain(alreadyRegistered)
      expect(ids).toContain(target)
    })

    it('trackingRegisterCandidates：新しい注文が先（ordered_at DESC）', () => {
      const older = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        fulfillment: 'shipped',
        lines: [{ name: '古い注文', unit_price: 1000, quantity: 1 }],
      })
      db.applyFulfillmentFromShop(older, {
        status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-REG-OLD',
      })
      const newer = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-09-01',
        fulfillment: 'shipped',
        lines: [{ name: '新しい注文', unit_price: 1000, quantity: 1 }],
      })
      db.applyFulfillmentFromShop(newer, {
        status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-REG-NEW',
      })

      const ids = db.trackingRegisterCandidates().map(c => c.id)
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
    })

    it('markTrackingRegistered：印が付き、updated_atは変わらない。空配列では何も起きない。複数idをまとめて更新できる', () => {
      const a = makeUnregisteredPurchase('まとめて登録A', 'TRK-MARK-A')
      const b = makeUnregisteredPurchase('まとめて登録B', 'TRK-MARK-B')
      const before = db.getDb().prepare('SELECT updated_at FROM purchase WHERE id = ?').get(a) as
        { updated_at: string }

      expect(() => db.markTrackingRegistered([])).not.toThrow()
      expect(db.getPurchaseTracking(a)!.tracking_registered_at).toBeNull()

      db.markTrackingRegistered([a, b])

      expect(db.getPurchaseTracking(a)!.tracking_registered_at).not.toBeNull()
      expect(db.getPurchaseTracking(b)!.tracking_registered_at).not.toBeNull()
      const after = db.getDb().prepare('SELECT updated_at FROM purchase WHERE id = ?').get(a) as
        { updated_at: string }
      expect(after.updated_at).toBe(before.updated_at)
    })

    it('trackingCounts：未登録2件・登録済み未到着1件・到着済1件で { unregistered: 2, watching: 1 }', () => {
      makeUnregisteredPurchase('未登録1', 'TRK-COUNT-1', 'shipped')
      makeUnregisteredPurchase('未登録2', 'TRK-COUNT-2', 'shipped')
      const watching = makeUnregisteredPurchase('登録済み・未到着', 'TRK-COUNT-3', 'shipped')
      db.markTrackingRegistered([watching])
      const arrived = makeUnregisteredPurchase('到着済', 'TRK-COUNT-4', 'shipped')
      db.markTrackingRegistered([arrived])
      db.applyTrackingResult(arrived, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-09-20' })

      expect(db.trackingCounts()).toEqual({ unregistered: 2, watching: 1 })
    })
  })

  it('migrate：version27相当（purchase.tracking_carrier/tracking_numberが無い）→28で列が足され、既存行はnullになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-tracking-migrate-'))
    const path = join(dir, 'v27.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、v27相当（tracking列が無い）まで剥がす
      const migrateShopId = db.createShopAccount('メロジョイB')
      const purchaseId = db.createPurchase({
        shop_account_id: migrateShopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '移行前の仕入', unit_price: 1000, quantity: 1 }],
      })
      db.getDb().exec(`
        ALTER TABLE purchase DROP COLUMN tracking_carrier;
        ALTER TABLE purchase DROP COLUMN tracking_number;
      `)
      db.getDb().prepare(`UPDATE setting SET value = '27' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      const p = db.getPurchase(purchaseId)
      expect(p.tracking_carrier).toBeNull()
      expect(p.tracking_number).toBeNull()

      // 移行後は普通に書ける
      db.applyFulfillmentFromShop(purchaseId, {
        status: null, shipped_at: null, delivered_at: null,
        carrier: 'ヤマト運輸', tracking_number: '1234-5678-9012',
      })
      expect(db.getPurchaseTrackingNumber(purchaseId)).toBe('1234-5678-9012')
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version29相当（purchase.tracking_registered_atが無い）→30で列が足され、既存行はnullになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-tracking-registered-migrate-'))
    const path = join(dir, 'v29.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、v29相当（tracking_registered_atが無い）まで剥がす
      const migrateShopId = db.createShopAccount('メロジョイC')
      const purchaseId = db.createPurchase({
        shop_account_id: migrateShopId,
        ordered_at: '2026-01-01',
        fulfillment: 'shipped',
        lines: [{ name: '移行前の仕入', unit_price: 1000, quantity: 1 }],
      })
      db.applyFulfillmentFromShop(purchaseId, {
        status: null, shipped_at: null, delivered_at: null,
        carrier: null, tracking_number: 'TRK-MIGRATE-1',
      })
      db.getDb().exec(`ALTER TABLE purchase DROP COLUMN tracking_registered_at;`)
      db.getDb().prepare(`UPDATE setting SET value = '29' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      expect(db.getPurchaseTracking(purchaseId)!.tracking_registered_at).toBeNull()

      // 移行後は普通に登録できる
      db.markTrackingRegistered([purchaseId])
      expect(db.getPurchaseTracking(purchaseId)!.tracking_registered_at).not.toBeNull()
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version30相当（sale/listing.channelが無い）→31で列が足され、既存行はmercariになる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-channel-migrate-'))
    const path = join(dir, 'v30.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、v30相当（channel列が無い）まで剥がす
      const migrateShopId = db.createShopAccount('メロジョイD')
      db.createPurchase({
        shop_account_id: migrateShopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '移行前の仕入', unit_price: 1000, quantity: 1 }],
      })
      const saleId = db.createSale({ title: '移行前の販売', sold_at: '2026-01-02', price: 1000 })
      db.upsertListings([
        { mercariItemId: 'MIGR-1', title: '移行前の出品', price: 2000, suspended: false, thumbUrl: null },
      ])
      db.getDb().exec(`
        DROP VIEW IF EXISTS sale_line_share;
        DROP VIEW IF EXISTS sale_profit;
        DROP VIEW IF EXISTS monthly_summary;
        DROP VIEW IF EXISTS inventory_view;
        DROP VIEW IF EXISTS variant_summary;
        ALTER TABLE sale DROP COLUMN channel;
        ALTER TABLE listing DROP COLUMN channel;
      `)
      db.getDb().prepare(`UPDATE setting SET value = '30' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')
      expect(db.getSettings().fee_rate_bp_yahoo).toBe('500')

      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.channel).toBe('mercari')
      const listing = db.listListings().find(l => l.mercari_item_id === 'MIGR-1')!
      expect(listing.channel).toBe('mercari')
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version32相当（collector_run.sourceのCHECKにyahooが無い）→33で足され、既存の実行記録は1件も減らない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-run-yahoo-migrate-'))
    const path = join(dir, 'v32.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマで作り、v32相当（source CHECKにyahooが無い）まで剥がす
      const runId1 = db.startRun('mercari')
      db.finishRun(runId1, 'ok', 5, 5)
      const migrateShopId = db.createShopAccount('メロジョイE')
      const runId2 = db.startRun('mellojoy', migrateShopId)
      db.finishRun(runId2, 'empty', 0, 0)

      // collector_run は外部キー・ビュー・トリガーから参照されていないため、
      // テーブルだけ作り直せばよい（v26相当のproduct_nameと同じ流儀）
      db.getDb().exec(`
        CREATE TABLE collector_run_old (
          id          TEXT PRIMARY KEY,
          started_at  TEXT NOT NULL,
          finished_at TEXT,
          status      TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok','auth_required','failed','empty')),
          fetched     INTEGER NOT NULL DEFAULT 0,
          inserted    INTEGER NOT NULL DEFAULT 0,
          message     TEXT,
          source          TEXT NOT NULL DEFAULT 'mercari'
                          CHECK (source IN ('mercari','mellojoy')),
          shop_account_id TEXT REFERENCES shop_account(id)
        );
        INSERT INTO collector_run_old SELECT * FROM collector_run;
        DROP TABLE collector_run;
        ALTER TABLE collector_run_old RENAME TO collector_run;
        CREATE INDEX IF NOT EXISTS idx_run_started ON collector_run(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_run_source_started ON collector_run(source, started_at DESC);
      `)
      db.getDb().prepare(`UPDATE setting SET value = '32' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')

      // 既存の実行記録が1件も減らない
      const runs = db.listRuns(10)
      expect(runs.length).toBe(2)
      expect(runs.map(r => r.source).sort()).toEqual(['mellojoy', 'mercari'])

      // 移行後はsource='mercari'/'mellojoy'は今までどおり、'yahoo'も新規に挿入できる
      const yahooRunId = db.startRun('yahoo')
      db.finishRun(yahooRunId, 'ok', 3, 3)
      expect(db.listRuns(10).find(r => r.id === yahooRunId)?.source).toBe('yahoo')

      // 知らないsourceはCHECKで弾かれる（CHECKが生きている）
      expect(() => db.getDb().prepare(
        `INSERT INTO collector_run (id, started_at, source) VALUES ('bad-source', datetime('now'), 'foo')`,
      ).run()).toThrow()

      // インデックス2本が再構築後も残っている
      const indexes = db.getDb().prepare(`PRAGMA index_list('collector_run')`).all() as Array<{ name: string }>
      expect(indexes.map(i => i.name)).toEqual(
        expect.arrayContaining(['idx_run_started', 'idx_run_source_started']),
      )
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrate：version33相当→34で、更新前にupdateSaleが直していなかったsale.model_codesを足すだけで埋める（sale_lineには触らない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-model-codes-migrate-'))
    const path = join(dir, 'v33.db')
    try {
      db.closeDb()
      db.initDb(path) // 一旦フルスキーマ（最新コード）で作り、旧バージョンを装う
      const migrateShopId = db.createShopAccount('マイグレ確認')
      db.createPurchase({
        shop_account_id: migrateShopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【A040】', unit_price: 1000, quantity: 2 }],
      })

      // s1：ずれていない正常な行（型番どおりに自動紐付け済み）。マイグレーションで変わらないはず
      // （「1点目」等の数字+点/個は個数表記と誤認されるため使わない。CODE_RE直後の数字表記を避ける）
      const s1 = db.createSale({ title: '【A040】ひとつめ', sold_at: '2026-01-05', price: 2000 })
      expect(db.listSales().find(s => s.id === s1)!.unmatched).toBe(0) // 自動紐付け済み

      // s2：v34直前のバグを再現。タイトルだけ書き換わり、model_codes列は古いまま（生SQLで模す）
      const s2 = db.createSale({ title: '型番なしタイトル', sold_at: '2026-01-06', price: 2000 })
      db.getDb().prepare(`UPDATE sale SET title = ? WHERE id = ?`).run('【A040】ふたつめ', s2)
      expect(
        (db.getDb().prepare('SELECT model_codes FROM sale WHERE id = ?').get(s2) as { model_codes: string })
          .model_codes,
      ).toBe('[]')

      // s3：説明文から後追いで足された型番（appendModelCodes由来）。タイトルには出てこない
      const s3 = db.createSale({ title: '型番なしタイトル3', sold_at: '2026-01-07', price: 1000 })
      db.appendModelCodes(s3, ['A099'])

      const saleLineCountBefore = (
        db.getDb().prepare('SELECT COUNT(*) AS c FROM sale_line').get() as { c: number }
      ).c

      db.getDb().prepare(`UPDATE setting SET value = '33' WHERE key = 'schema_version'`).run()
      db.closeDb()

      expect(() => db.initDb(path)).not.toThrow()

      expect(db.getSettings().schema_version).toBe('34')

      // s1は変化なし
      expect(db.listSales().find(s => s.id === s1)!.model_codes).toEqual(['A040'])
      // s2：足すだけで埋まる（タイトルから拾えるA040が入る）
      expect(db.listSales().find(s => s.id === s2)!.model_codes).toEqual(['A040'])
      // s3：タイトルには型番が無いので追加は無く、説明文由来のA099は消えずに残る
      expect(db.listSales().find(s => s.id === s3)!.model_codes).toEqual(['A099'])

      // マイグレーションは列を直すだけで、自動紐付けは走らせない（sale_lineの件数は前後で変わらない）
      const saleLineCountAfter = (
        db.getDb().prepare('SELECT COUNT(*) AS c FROM sale_line').get() as { c: number }
      ).c
      expect(saleLineCountAfter).toBe(saleLineCountBefore)
      expect(db.listSales().find(s => s.id === s2)!.unmatched).toBe(1) // まだ未紐付け

      // 人が「型番で自動紐付け」ボタンを押したとき（autoLinkPending）には効く
      const linked = db.autoLinkPending()
      expect(linked).toBeGreaterThanOrEqual(1)
      expect(db.listSales().find(s => s.id === s2)!.unmatched).toBe(0)
    } finally {
      try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('autoLinkPending：saleIds で対象を絞る（画面の絞り込みを無視して全件に走らないこと）', () => {
    it('saleIds を渡すと、その販売だけが紐付く（渡していない未紐付けの販売はそのまま残る）', () => {
      // タイトルに型番はあるが、この時点では在庫が無いので createSale 内の自動紐付けは失敗し未紐付けのまま残る
      const saleA = db.createSale({ title: '【A040】りんご', sold_at: '2026-01-05', price: 2000 })
      const saleB = db.createSale({ title: '【A041】みかん', sold_at: '2026-01-05', price: 2000 })
      expect(db.listSales().find(s => s.id === saleA)!.unmatched).toBe(1)
      expect(db.listSales().find(s => s.id === saleB)!.unmatched).toBe(1)

      // ここで在庫を作る（両方とも紐付け可能な状態にする）
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'りんご【A040】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'みかん【A041】', unit_price: 1000, quantity: 1 }],
      })

      const linked = db.autoLinkPending([saleA])
      expect(linked).toBe(1)
      expect(db.listSales().find(s => s.id === saleA)!.unmatched).toBe(0)
      // 渡していないsaleBは在庫があっても紐付かない
      expect(db.listSales().find(s => s.id === saleB)!.unmatched).toBe(1)
    })

    it('空配列を渡すと0件で、未紐付けの販売は1件も紐付かない', () => {
      const saleA = db.createSale({ title: '【A050】くり', sold_at: '2026-01-05', price: 2000 })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'くり【A050】', unit_price: 1000, quantity: 1 }],
      })

      expect(db.autoLinkPending([])).toBe(0)
      expect(db.listSales().find(s => s.id === saleA)!.unmatched).toBe(1)
    })

    it('省略すると従来どおり全件が対象になる', () => {
      const saleA = db.createSale({ title: '【A051】もも', sold_at: '2026-01-05', price: 2000 })
      const saleB = db.createSale({ title: '【A052】ぶどう', sold_at: '2026-01-05', price: 2000 })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'もも【A051】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'ぶどう【A052】', unit_price: 1000, quantity: 1 }],
      })

      expect(db.autoLinkPending()).toBe(2)
      expect(db.listSales().find(s => s.id === saleA)!.unmatched).toBe(0)
      expect(db.listSales().find(s => s.id === saleB)!.unmatched).toBe(0)
    })

    it('渡した id に、既に紐付いている・私物・型番が2個以上の販売が混ざっていてもエラーにならず、条件を満たすものだけ紐付く', () => {
      // 在庫が無い状態でsaleを作る（createSale内の自動紐付けを空振りさせ、未紐付けのまま残す）
      const target = db.createSale({ title: '【A060】たいしょう', sold_at: '2026-01-05', price: 2000 })
      const alreadyLinked = db.createSale({ title: '【A060】すでに紐付済', sold_at: '2026-01-05', price: 2000 })
      const personal = db.createSale({
        title: '【A060】私物', sold_at: '2026-01-05', price: 500, kind: 'personal',
      })
      const twoCodesSale = db.createSale({
        title: '【A060】【A040】ふたつ型番', sold_at: '2026-01-05', price: 3000,
      })

      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A060】', unit_price: 1000, quantity: 2 }],
      })

      // alreadyLinkedだけ先に確定させ、A060の在庫2点のうち1点を消費しておく
      expect(db.autoLinkSale(alreadyLinked)).toBe(true)
      expect(db.listSales().find(s => s.id === alreadyLinked)!.unmatched).toBe(0)
      expect(db.listSales().find(s => s.id === target)!.unmatched).toBe(1)

      const linked = db.autoLinkPending([target, alreadyLinked, personal, twoCodesSale])
      // targetだけが残り1点のA060で紐付く。alreadyLinked（既にsale_lineあり）・personal（kind不一致）・
      // twoCodesSale（型番2つ）はautoLinkSale内で弾かれ、エラーにならず静かに飛ばされる
      expect(linked).toBe(1)
      expect(db.listSales().find(s => s.id === target)!.unmatched).toBe(0)
      expect(db.listSales().find(s => s.id === personal)!.kind).toBe('personal')
      expect(db.listSales().find(s => s.id === twoCodesSale)!.unmatched).toBe(1)
    })

    it('出品先（channel）が混ざった状態で、片方の出品先の id だけ渡したらもう片方は紐付かない', () => {
      const saleMercari = db.createSale({
        title: '【A070】めるかり', sold_at: '2026-01-05', price: 2000, channel: 'mercari',
      })
      const saleYahoo = db.createSale({
        title: '【A071】やふー', sold_at: '2026-01-05', price: 2000, channel: 'yahoo',
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'めるかり【A070】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'やふー【A071】', unit_price: 1000, quantity: 1 }],
      })

      const linked = db.autoLinkPending([saleMercari])
      expect(linked).toBe(1)
      expect(db.listSales().find(s => s.id === saleMercari)!.unmatched).toBe(0)
      expect(db.listSales().find(s => s.id === saleYahoo)!.unmatched).toBe(1)
    })
  })

  describe('出品先（channel）：メルカリ / Yahoo!フリマ', () => {
    it('setting.fee_rate_bp_yahooの既定は500（5.00%）', () => {
      expect(db.getSettings().fee_rate_bp_yahoo).toBe('500')
    })

    it('createSale：channel省略・mercariはfee_rate_bp(既定1000)、yahooはfee_rate_bp_yahoo(既定500)が焼き付く', () => {
      const idDefault = db.createSale({ title: '省略', sold_at: '2026-01-05', price: 1000 })
      const idMercari = db.createSale({ title: 'メルカリ', sold_at: '2026-01-05', price: 1000, channel: 'mercari' })
      const idYahoo = db.createSale({ title: 'Yahoo', sold_at: '2026-01-05', price: 1000, channel: 'yahoo' })

      const sales = db.listSales()
      const byId = (id: string) => sales.find(s => s.id === id)!

      expect(byId(idDefault).channel).toBe('mercari')
      expect(byId(idDefault).fee).toBe(100) // floor(1000*1000/10000)

      expect(byId(idMercari).channel).toBe('mercari')
      expect(byId(idMercari).fee).toBe(100)

      expect(byId(idYahoo).channel).toBe('yahoo')
      expect(byId(idYahoo).fee).toBe(50) // floor(1000*500/10000)

      const raw = db.getDb().prepare('SELECT fee_rate_bp FROM sale WHERE id = ?').all(idYahoo)[0] as
        { fee_rate_bp: number }
      expect(raw.fee_rate_bp).toBe(500)
    })

    it('設定のfee_rate_bp_yahooをあとで変えても、既に作った販売のfee_rate_bpは動かない', () => {
      const saleId = db.createSale({ title: 'Yahoo旧率', sold_at: '2026-01-05', price: 1000, channel: 'yahoo' })
      const before = db.getDb().prepare('SELECT fee_rate_bp, fee FROM sale WHERE id = ?').get(saleId) as
        { fee_rate_bp: number; fee: number }
      expect(before).toEqual({ fee_rate_bp: 500, fee: 50 })

      db.setSetting('fee_rate_bp_yahoo', '1000')

      const after = db.getDb().prepare('SELECT fee_rate_bp, fee FROM sale WHERE id = ?').get(saleId) as
        { fee_rate_bp: number; fee: number }
      expect(after).toEqual({ fee_rate_bp: 500, fee: 50 })

      // 新規に作るYahoo販売は新しい率が使われる
      const newId = db.createSale({ title: 'Yahoo新率', sold_at: '2026-01-06', price: 1000, channel: 'yahoo' })
      const newRaw = db.getDb().prepare('SELECT fee_rate_bp FROM sale WHERE id = ?').get(newId) as
        { fee_rate_bp: number }
      expect(newRaw.fee_rate_bp).toBe(1000)
    })

    it('listListings：出品にもchannelが乗る（既定mercari）', () => {
      db.upsertListings([
        { mercariItemId: 'CHN-1', title: '出品チャンネル確認', price: 1500, suspended: false, thumbUrl: null },
      ])
      const listing = db.listListings().find(l => l.mercari_item_id === 'CHN-1')!
      expect(listing.channel).toBe('mercari')
    })

    it('在庫のlisting派生オブジェクトにもchannelが乗る', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '出品確認用【Z099-1】', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'CHN-2', title: '出品確認用【Z099-1】', price: 2000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('CHN-2', [item.id])

      const after = db.listInventory('in_stock').find(i => i.id === item.id)!
      expect(after.listing).toEqual({ channel: 'mercari', mercari_item_id: 'CHN-2', price: 2000, status: 'active' })
    })

    it('Yahoo!フリマの販売の粗利（sale_profit）が「販売価格－手数料－送料－梱包材費－原価」と数字で一致する', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'Yahoo検算用', unit_price: 1200, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      const saleId = db.createSale({
        title: 'Yahoo検算用の販売', sold_at: '2026-01-10', price: 5000, channel: 'yahoo',
      })
      db.linkInventory(saleId, [item.id])
      db.updateSale(saleId, { packaging_cost: 50, shipping_fee: 300 })

      const sale = db.listSales().find(s => s.id === saleId)!
      // channel='yahoo' → fee_rate_bp_yahoo 既定500(5%) → fee = floor(5000*500/10000) = 250
      expect(sale.channel).toBe('yahoo')
      expect(sale.price).toBe(5000)
      expect(sale.fee).toBe(250)
      expect(sale.shipping_fee).toBe(300)
      expect(sale.packaging_cost).toBe(50)
      expect(sale.cost).toBe(1200)
      expect(sale.gross_profit).toBe(5000 - 250 - 300 - 50 - 1200)
      expect(sale.gross_profit).toBe(3200)
    })

    it('insertCollected：channelを渡すとsale.channelに乗り、実額が無いときの手数料が出品先の率になる', () => {
      const [yahoo] = db.insertCollected(
        [{ mercariItemId: 'YIC-1', title: 'Yahoo取り込み', price: 6000, soldAt: '2026-02-01' }],
        'yahoo',
      )
      const sale = db.listSales().find(s => s.id === yahoo.id)!
      expect(sale.channel).toBe('yahoo')
      // fee_rate_bp_yahoo 既定500(5%) → fee = floor(6000*500/10000) = 300
      expect(sale.fee).toBe(300)
      expect(sale.fee_source).toBe('rate')
    })

    it('insertCollected：channelを渡さない既存の呼び出しは今までどおりmercariになる', () => {
      const [mercari] = db.insertCollected(
        [{ mercariItemId: 'MIC-1', title: 'メルカリ取り込み', price: 6000, soldAt: '2026-02-01' }],
      )
      const sale = db.listSales().find(s => s.id === mercari.id)!
      expect(sale.channel).toBe('mercari')
      // fee_rate_bp 既定1000(10%) → fee = floor(6000*1000/10000) = 600
      expect(sale.fee).toBe(600)
    })

    it('insertCollected：channel=yahooでも、feeの実額が渡ればfee_source=actual（0円も実額）で率は使わない', () => {
      const [zero] = db.insertCollected(
        [{ mercariItemId: 'YIC-2', title: 'Yahooキャンペーン', price: 5200, soldAt: '2026-02-01', fee: 0 }],
        'yahoo',
      )
      const zeroSale = db.listSales().find(s => s.id === zero.id)!
      expect(zeroSale.fee).toBe(0)
      expect(zeroSale.fee_source).toBe('actual')

      const [actual] = db.insertCollected(
        [{ mercariItemId: 'YIC-3', title: 'Yahoo実額', price: 6400, soldAt: '2026-02-01', fee: 320 }],
        'yahoo',
      )
      const actualSale = db.listSales().find(s => s.id === actual.id)!
      expect(actualSale.fee).toBe(320)
      expect(actualSale.fee_source).toBe('actual')
    })

    it('upsertListings：channelを渡すとlisting.channelに乗る（省略時mercari）', () => {
      db.upsertListings(
        [{ mercariItemId: 'YLST-1', title: 'Yahoo出品', price: 3000, suspended: false, thumbUrl: null }],
        'yahoo',
      )
      const listing = db.listListings().find(l => l.mercari_item_id === 'YLST-1')!
      expect(listing.channel).toBe('yahoo')
    })

    it('setting.yahoo_keywordの既定は空文字（新規DB）', () => {
      expect(db.getSettings().yahoo_keyword).toBe('')
    })

    it('setting.yahoo_keywordは保存して読み戻せる。mercari_keywordとは独立している', () => {
      db.setSetting('mercari_keyword', 'メロジョイ')
      db.setSetting('yahoo_keyword', 'ヤフー限定')

      expect(db.getSettings().yahoo_keyword).toBe('ヤフー限定')
      expect(db.getSettings().mercari_keyword).toBe('メロジョイ')

      db.setSetting('yahoo_keyword', '別のキーワード')
      expect(db.getSettings().yahoo_keyword).toBe('別のキーワード')
      // yahoo_keywordを変えてもmercari_keywordは影響を受けない
      expect(db.getSettings().mercari_keyword).toBe('メロジョイ')
    })

    it('migrate：yahoo_keywordが無い既存DBでも、マイグレーションではなくINSERT OR IGNOREで空文字が入る', () => {
      const dir = mkdtempSync(join(tmpdir(), 'soroban-yahoo-keyword-migrate-'))
      const path = join(dir, 'no-yahoo-keyword.db')
      try {
        db.closeDb()
        db.initDb(path) // 一旦フルスキーマで作り、yahoo_keyword設定行を消して「無い状態」を再現
        db.getDb().prepare(`DELETE FROM setting WHERE key = 'yahoo_keyword'`).run()
        expect(db.getSettings().yahoo_keyword).toBeUndefined()
        db.closeDb()

        expect(() => db.initDb(path)).not.toThrow()

        // schema_versionは上がっていない＝migrate()の列追加ではなく、
        // 毎回のtablesSql実行に含まれるINSERT OR IGNOREで入ったことの確認
        expect(db.getSettings().schema_version).toBe('34')
        expect(db.getSettings().yahoo_keyword).toBe('')
      } finally {
        try { db.closeDb() } catch { /* 既に閉じていてもよい */ }
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('insertCollected：channel=yahooはyahoo_keywordで判定する（mercari_keywordには引きずられない）', () => {
      db.setSetting('mercari_keyword', 'メロジョイ')
      db.setSetting('yahoo_keyword', 'ヤフー限定')

      const [y1] = db.insertCollected(
        [{ mercariItemId: 'YK-1', title: 'ヤフー限定コラボ', price: 1000, soldAt: '2026-01-01' }],
        'yahoo',
      )
      // yahoo_keywordに一致 → resale
      expect(db.listSales().find(s => s.id === y1.id)!.kind).toBe('resale')

      const [y2] = db.insertCollected(
        [{ mercariItemId: 'YK-2', title: 'メロジョイ限定コラボ', price: 1000, soldAt: '2026-01-02' }],
        'yahoo',
      )
      // mercari_keywordにだけ一致・yahoo_keywordには不一致 → personal
      expect(db.listSales().find(s => s.id === y2.id)!.kind).toBe('personal')
    })

    it('insertCollected：channel省略（mercari）はmercari_keywordで判定する（yahoo_keywordには引きずられない）', () => {
      db.setSetting('mercari_keyword', 'メロジョイ')
      db.setSetting('yahoo_keyword', 'ヤフー限定')

      const [m1] = db.insertCollected(
        [{ mercariItemId: 'MK-1', title: 'メロジョイ限定コラボ', price: 1000, soldAt: '2026-01-01' }],
      )
      expect(db.listSales().find(s => s.id === m1.id)!.kind).toBe('resale')

      const [m2] = db.insertCollected(
        [{ mercariItemId: 'MK-2', title: 'ヤフー限定コラボ', price: 1000, soldAt: '2026-01-02' }],
      )
      // yahoo_keywordにだけ一致・mercari_keywordには不一致 → personal
      expect(db.listSales().find(s => s.id === m2.id)!.kind).toBe('personal')
    })

    it('insertCollected：yahoo_keywordが空なら、channel=yahooでも型番の有無で判定する', () => {
      const [noCode] = db.insertCollected(
        [{ mercariItemId: 'YK-3', title: '型番なしYahoo商品', price: 1000, soldAt: '2026-01-01' }],
        'yahoo',
      )
      expect(db.listSales().find(s => s.id === noCode.id)!.kind).toBe('personal')

      const [withCode] = db.insertCollected(
        [{ mercariItemId: 'YK-4', title: '【Z080-1】型番ありYahoo商品', price: 1000, soldAt: '2026-01-02' }],
        'yahoo',
      )
      expect(db.listSales().find(s => s.id === withCode.id)!.kind).toBe('resale')
    })

    it('appendModelCodes：出品先(channel)ごとのキーワードで救済判定する（mercari_keywordに固定しない）', () => {
      // mercari_keywordは設定されているが、yahoo_keywordは空 → yahoo販売の救済は
      // 「型番が付いたか」で判定されるべき（mercari_keywordの設定に引きずられない）
      db.setSetting('mercari_keyword', 'メロジョイ')

      const [{ id }] = db.insertCollected(
        [{ mercariItemId: 'YAM-1', title: '型番なしYahoo商品', price: 2000, soldAt: '2026-01-05' }],
        'yahoo',
      )
      expect(db.listSales().find(s => s.id === id)!.kind).toBe('personal')

      const changed = db.appendModelCodes(id, ['Z080-1'])
      expect(changed).toBe(true)
      expect(db.listSales().find(s => s.id === id)!.kind).toBe('resale')
    })

    it('updateYahooActuals：statusをそのまま使う（shippedではcompletedにしない・completed_at/sold_atを動かさない）', () => {
      const [{ id }] = db.insertCollected(
        [{
          mercariItemId: 'YUA-1', title: 'Yahoo更新対象', price: 6000, soldAt: '2026-03-01',
          status: 'waiting_shipment',
        }],
        'yahoo',
      )

      const updated = db.updateYahooActuals([
        { mercariItemId: 'YUA-1', soldAt: '2026-03-05', status: 'shipped' },
      ])
      expect(updated).toBe(1)

      const after = db.listSales().find(s => s.id === id)!
      expect(after.status).toBe('shipped')
      expect(after.completed_at).toBeNull()
      expect(after.sold_at).toBe('2026-03-01') // completedを観測するまでsold_atは動かない
    })

    it('updateYahooActuals：status=completedで初めてcompleted_atが入り、sold_atが完了日へ動く', () => {
      const [{ id }] = db.insertCollected(
        [{ mercariItemId: 'YUA-2', title: 'Yahoo完了対象', price: 6000, soldAt: '2026-03-01', status: 'shipped' }],
        'yahoo',
      )

      const updated = db.updateYahooActuals([
        { mercariItemId: 'YUA-2', soldAt: '2026-03-10', status: 'completed' },
      ])
      expect(updated).toBe(1)

      const after = db.listSales().find(s => s.id === id)!
      expect(after.status).toBe('completed')
      expect(after.completed_at).toBe('2026-03-10')
      expect(after.sold_at).toBe('2026-03-10')
    })

    it('updateYahooActuals：実額のfeeが変わったら反映され、fee_sourceがactualになる', () => {
      const [{ id }] = db.insertCollected(
        [{
          mercariItemId: 'YUA-3', title: 'Yahoo手数料変化', price: 6000, soldAt: '2026-03-01',
          status: 'completed', fee: 250,
        }],
        'yahoo',
      )
      const before = db.listSales().find(s => s.id === id)!
      expect(before.fee).toBe(250)
      expect(before.fee_source).toBe('actual')

      const updated = db.updateYahooActuals([
        { mercariItemId: 'YUA-3', soldAt: '2026-03-01', fee: 300, status: 'completed' },
      ])
      expect(updated).toBe(1)

      const after = db.listSales().find(s => s.id === id)!
      expect(after.fee).toBe(300)
      expect(after.fee_source).toBe('actual')
    })

    it('updateYahooActuals：priceの実額も反映できる', () => {
      const [{ id }] = db.insertCollected(
        [{ mercariItemId: 'YUA-4', title: 'Yahoo価格変化', price: 6000, soldAt: '2026-03-01', status: 'completed' }],
        'yahoo',
      )
      const updated = db.updateYahooActuals([
        { mercariItemId: 'YUA-4', soldAt: '2026-03-01', price: 5800, status: 'completed' },
      ])
      expect(updated).toBe(1)
      expect(db.listSales().find(s => s.id === id)!.price).toBe(5800)
    })

    it('updateYahooActuals：差分が無ければ更新0件', () => {
      db.insertCollected(
        [{
          mercariItemId: 'YUA-5', title: 'Yahoo差分なし', price: 6000, soldAt: '2026-03-01',
          status: 'completed', fee: 300,
        }],
        'yahoo',
      )
      const updated = db.updateYahooActuals([
        { mercariItemId: 'YUA-5', soldAt: '2026-03-01', fee: 300, status: 'completed' },
      ])
      expect(updated).toBe(0)
    })

    it('updateYahooActuals：知らないmercariItemIdは無視する', () => {
      const updated = db.updateYahooActuals([
        { mercariItemId: 'does-not-exist', soldAt: '2026-03-01', status: 'completed' },
      ])
      expect(updated).toBe(0)
    })

    it('updateYahooActuals：切れたタイトルで入った販売に全文のタイトルが来たら直る', () => {
      const [{ id }] = db.insertCollected(
        [{
          mercariItemId: 'YTT-1', title: 'クリームわん新品未開封【Z07', price: 6000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )
      expect(db.listSales().find(s => s.id === id)!.title).toBe('クリームわん新品未開封【Z07')

      const updated = db.updateYahooActuals([
        {
          mercariItemId: 'YTT-1', soldAt: '2026-03-01', status: 'completed',
          title: 'クリームわん新品未開封【Z074-4】',
        },
      ])
      expect(updated).toBe(1)
      expect(db.listSales().find(s => s.id === id)!.title).toBe('クリームわん新品未開封【Z074-4】')
    })

    it('updateYahooActuals：全文が入っているところに切れたタイトルが来ても上書きされない', () => {
      const [{ id }] = db.insertCollected(
        [{
          mercariItemId: 'YTT-2', title: 'クリームわん新品未開封【Z074-4】', price: 6000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )

      // 切れたタイトル（短い・prefix関係が逆）が来ても上書きしない。ただし fee が変わっている
      // ので更新自体は進む（title 以外の列は反映される）
      const updated = db.updateYahooActuals([
        {
          mercariItemId: 'YTT-2', soldAt: '2026-03-01', status: 'completed', fee: 400,
          title: 'クリームわん新品未開封【Z07',
        },
      ])
      expect(updated).toBe(1)
      const after = db.listSales().find(s => s.id === id)!
      expect(after.title).toBe('クリームわん新品未開封【Z074-4】')
      expect(after.fee).toBe(400)
    })

    it('updateYahooActuals：人が手で直したタイトルは上書きされない', () => {
      const [{ id }] = db.insertCollected(
        [{
          mercariItemId: 'YTT-3', title: 'クリームわん新品未開封【Z07', price: 6000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )
      // 人が手でタイトルを直す（updateSale経由）。以後は先頭が食い違うので収集の全文で上書きされない
      db.updateSale(id, { title: '人が直したタイトル' })

      const updated = db.updateYahooActuals([
        {
          mercariItemId: 'YTT-3', soldAt: '2026-03-01', status: 'completed', fee: 400,
          title: 'クリームわん新品未開封【Z074-4】',
        },
      ])
      expect(updated).toBe(1) // fee は変わるので更新自体は進む
      const after = db.listSales().find(s => s.id === id)!
      expect(after.title).toBe('人が直したタイトル')
      expect(after.fee).toBe(400)
    })

    it('updateYahooActuals：タイトルが直ると型番が取れて自動紐付けの候補まで進む', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z074-4】', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      const [{ id }] = db.insertCollected(
        [{
          mercariItemId: 'YTT-4', title: 'クリームわん新品未開封【Z07', price: 2000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )
      const before = db.listSales().find(s => s.id === id)!
      expect(before.model_codes).toEqual([]) // 閉じ括弧が無いのでCODE_REに一致せず型番なし
      expect(before.unmatched).toBe(1)

      db.updateYahooActuals([
        {
          mercariItemId: 'YTT-4', soldAt: '2026-03-01', status: 'completed',
          title: 'クリームわん新品未開封【Z074-4】',
        },
      ])

      const after = db.listSales().find(s => s.id === id)!
      expect(after.model_codes).toEqual(['Z074-4'])
      expect(after.unmatched).toBe(0)
      expect(after.auto_linked).toBe(1)
      expect(after.cost).toBe(item.landed_cost)
    })

    it('updateCollectedActuals（メルカリ用。titleを渡さない）は今までどおり動く', () => {
      const [{ id }] = db.insertCollected(
        [{ mercariItemId: 'YTT-5', title: 'メルカリの取引', price: 3000, soldAt: '2026-03-01' }],
      )
      const updated = db.updateCollectedActuals([
        { mercariItemId: 'YTT-5', soldAt: '2026-03-05', fee: 300 },
      ])
      expect(updated).toBe(1)
      const after = db.listSales().find(s => s.id === id)!
      expect(after.title).toBe('メルカリの取引') // titleを渡していないので変わらない
      expect(after.fee).toBe(300)
      expect(after.status).toBe('completed')
    })
  })

  it('getItemTimeline：仕入（送料按分あり）→販売（まとめ売り2点）でeventsの順・detailの数字が合う', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      order_no: 'ORDER-9',
      shipping_fee: 100,
      lines: [{ name: 'タイムライン商品', unit_price: 1000, quantity: 3 }],
    })
    // fulfillment未指定（null）＝手入力扱い。発送・到着イベントは出ない
    const items = [...db.listInventory('in_stock')].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(items.map(i => i.landed_cost)).toEqual([1033, 1033, 1034])

    const saleId = db.createSale({ title: 'まとめ売りテスト', sold_at: '2026-01-10', price: 4000 })
    db.linkInventory(saleId, [items[0].id, items[2].id]) // 1033 と 1034 をまとめ売り

    const timeline = db.getItemTimeline(items[2].id)! // landed_cost 1034（端数が乗った方）
    expect(timeline).not.toBeNull()
    expect(timeline.purchase?.order_no).toBe('ORDER-9')
    expect(timeline.sale?.id).toBe(saleId)

    const kinds = timeline.events.map(e => e.kind)
    expect(kinds).toEqual(['ordered', 'sold', 'sale_shipped', 'sale_delivered', 'sale_completed'])

    const ordered = timeline.events[0]
    expect(ordered.date).toBe('2026-01-01')
    expect(ordered.detail).toBe('¥1,000 ＋送料按分 ¥34 → 原価 ¥1,034')
    expect(ordered.amount).toBe(1034)

    const sold = timeline.events[1]
    expect(sold.date).toBe('2026-01-10')
    expect(sold.detail).toBe('¥4,000 （まとめ売り 2 点、1 点あたり ¥2,000）')
    expect(sold.amount).toBe(4000)

    // 発送・受取・取引完了はまだ取れていないので日付null（予定）
    expect(timeline.events[2].date).toBeNull()
    expect(timeline.events[3].date).toBeNull()
    const completed = timeline.events[4]
    expect(completed.date).toBeNull()
    // fee = floor(4000*1000/10000) = 400、shipping_fee = 0
    expect(completed.detail).toBe('売上金 ¥3,600 反映')
  })

  it('getItemTimeline：fulfillmentがpendingなら仕入の発送・到着が日付nullで出る（nullなら出ない）', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      fulfillment: 'pending',
      import_key: 'mellojoy:#timeline-pending',
      lines: [{ name: 'pending商品', unit_price: 1000, quantity: 1 }],
    })
    const pendingItem = db.listInventory('in_stock')[0]
    const pendingTimeline = db.getItemTimeline(pendingItem.id)!
    expect(pendingTimeline.events.map(e => e.kind)).toEqual(['ordered', 'purchase_shipped', 'purchase_delivered'])
    expect(pendingTimeline.events[1].date).toBeNull()
    expect(pendingTimeline.events[2].date).toBeNull()

    // fulfillment未指定（null）の仕入では発送・到着イベントが出ない
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'null商品', unit_price: 1000, quantity: 1 }],
    })
    const nullItem = db.listInventory('in_stock').find(i => i.name === 'null商品')!
    const nullTimeline = db.getItemTimeline(nullItem.id)!
    expect(nullTimeline.events.map(e => e.kind)).toEqual(['ordered'])
  })

  it('getItemTimeline：存在しない在庫はnull', () => {
    expect(db.getItemTimeline('no-such-id')).toBeNull()
  })

  it('listProducts：purchase_totalがlanded_costの合計と一致し、split親は数えない', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: 'listProducts商品【Z090-1】', unit_price: 1000, quantity: 1 }],
    })
    const parent = db.listInventory('in_stock')[0]
    db.splitInventory(parent.id, 2) // 500/500 の子2点。親はsplitでpurchase_totalから除外

    const products = db.listProducts()
    const target = products.find(p => p.model_code === 'Z090-1')!
    expect(target.purchase_total).toBe(1000) // 親(1000)を含めず、子2点(500+500)の合計
    expect(target.avg_cost).toBe(500)
  })

  it('getProduct：月を埋め、in_stockの累積が「仕入3-販売1=2」になる。型番が無ければnull', () => {
    expect(db.getProduct('no-such-model')).toBeNull()

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-01',
      shipping_fee: 0,
      lines: [{ name: 'getProduct商品【Z091-1】', unit_price: 1000, quantity: 3 }],
    })
    const items = db.listInventory('in_stock').filter(i => i.model_code === 'Z091-1')
    expect(items).toHaveLength(3)

    // タイトルの型番が1つに絞れるので createSale が自動で先入先出で紐付ける（手で linkInventory しない）
    const saleId = db.createSale({ title: 'getProduct商品【Z091-1】', sold_at: '2026-08-15', price: 2000 })
    expect(db.listSales().find(s => s.id === saleId)!.unmatched).toBe(0)

    const detail = db.getProduct('Z091-1')!
    expect(detail.items).toHaveLength(3)
    expect(detail.sales.map(s => s.id)).toEqual([saleId])

    // 2026-06（仕入3）〜2026-08（売上1）まで、間の2026-07も空月として埋まる
    const monthKeys = detail.months.map(m => m.month)
    expect(monthKeys).toContain('2026-06')
    expect(monthKeys).toContain('2026-07')
    expect(monthKeys).toContain('2026-08')

    const june = detail.months.find(m => m.month === '2026-06')!
    expect(june.purchased).toBe(3)
    expect(june.in_stock).toBe(3)

    const july = detail.months.find(m => m.month === '2026-07')!
    expect(july.purchased).toBe(0)
    expect(july.sold).toBe(0)
    expect(july.in_stock).toBe(3) // 空月も前月の累積を引き継ぐ

    const august = detail.months.find(m => m.month === '2026-08')!
    expect(august.sold).toBe(1)
    expect(august.in_stock).toBe(2) // 仕入3 − 販売1 = 2
  })

  describe('出品（メルカリの出品中タブ）と在庫の引き当て', () => {
    it('upsertListings：新規はinsert、既存はactive/suspendedなら更新、sold/endedは戻さない', () => {
      const r1 = db.upsertListings([
        { mercariItemId: 'L1', title: '商品A', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'L2', title: '商品B', price: 2000, suspended: true, thumbUrl: null },
      ])
      expect(r1).toEqual({ inserted: 2, updated: 0 })

      const listings = db.listListings()
      expect(listings.find(l => l.mercari_item_id === 'L1')!.status).toBe('active')
      expect(listings.find(l => l.mercari_item_id === 'L2')!.status).toBe('suspended')

      // 既存を更新（価格変更・公開停止解除）
      const r2 = db.upsertListings([
        { mercariItemId: 'L1', title: '商品A', price: 1500, suspended: false, thumbUrl: null },
      ])
      expect(r2).toEqual({ inserted: 0, updated: 1 })
      expect(db.listListings().find(l => l.mercari_item_id === 'L1')!.price).toBe(1500)

      // 取り下げたものは一覧に出ていても active へ戻さない（1ページしか読まないため）
      db.endListing('L2')
      const r3 = db.upsertListings([
        { mercariItemId: 'L2', title: '商品B', price: 2000, suspended: false, thumbUrl: null },
      ])
      expect(r3).toEqual({ inserted: 0, updated: 0 })
      expect(db.listListings({ status: ['ended'] })[0].status).toBe('ended')
    })

    it('upsertListings：last_seen_atはISO形式（T・Zを含む）で保存される（collector_run.finished_atとの文字列比較のため）', () => {
      db.upsertListings([
        { mercariItemId: 'LIso', title: 'ISO確認', price: 1000, suspended: false, thumbUrl: null },
      ])
      const row = db.getDb()
        .prepare('SELECT last_seen_at FROM listing WHERE mercari_item_id = ?').get('LIso') as
        { last_seen_at: string }
      expect(row.last_seen_at).toContain('T')
      expect(row.last_seen_at).toContain('Z')

      // 更新時も同様
      db.upsertListings([
        { mercariItemId: 'LIso', title: 'ISO確認', price: 1200, suspended: false, thumbUrl: null },
      ])
      const updated = db.getDb()
        .prepare('SELECT last_seen_at FROM listing WHERE mercari_item_id = ?').get('LIso') as
        { last_seen_at: string }
      expect(updated.last_seen_at).toContain('T')
      expect(updated.last_seen_at).toContain('Z')
    })

    it('upsertListings：updatedTextからlisted_atを推定する。更新の巻き戻り（新しい候補）は無視し、より古い候補にだけ更新する。likesは毎回上書き', () => {
      const daysAgo = (n: number) => {
        const d = new Date()
        d.setDate(d.getDate() - n)
        return todayLocal(d)
      }

      // 「5時間前」は0日扱い→ first_seen_atと同じ今日
      db.upsertListings([
        {
          mercariItemId: 'LDate', title: '出品日推定', price: 1000, suspended: false, thumbUrl: null,
          updatedText: '5時間前に更新', likes: 10,
        },
      ])
      let l = db.listListings().find(x => x.mercari_item_id === 'LDate')!
      expect(l.listed_at).toBe(todayLocal())
      expect(l.likes).toBe(10)

      // より古い候補（17日前）が来たら listed_at を巻き戻す
      db.upsertListings([
        {
          mercariItemId: 'LDate', title: '出品日推定', price: 1000, suspended: false, thumbUrl: null,
          updatedText: '17日前に更新', likes: 12,
        },
      ])
      l = db.listListings().find(x => x.mercari_item_id === 'LDate')!
      expect(l.listed_at).toBe(daysAgo(17))
      expect(l.likes).toBe(12)

      // 逆に新しい候補（1日前）が来ても、より古い方（17日前）のまま。likesは常に上書き
      db.upsertListings([
        {
          mercariItemId: 'LDate', title: '出品日推定', price: 1000, suspended: false, thumbUrl: null,
          updatedText: '1日前に更新', likes: 15,
        },
      ])
      l = db.listListings().find(x => x.mercari_item_id === 'LDate')!
      expect(l.listed_at).toBe(daysAgo(17))
      expect(l.likes).toBe(15)

      // updatedTextが取れなければ、挿入時は first_seen_at（今日）になる
      db.upsertListings([
        {
          mercariItemId: 'LNoDate', title: '出品日不明', price: 1000, suspended: false, thumbUrl: null,
          updatedText: null, likes: null,
        },
      ])
      const noDate = db.listListings().find(x => x.mercari_item_id === 'LNoDate')!
      expect(noDate.listed_at).toBe(todayLocal())
      expect(noDate.likes).toBeNull()
    })

    it('upsertListings：listedAt（絶対的な出品日時。例：Yahoo!フリマのopentime）を渡すと新規行のlisted_atに優先して使われる', () => {
      db.upsertListings([
        {
          mercariItemId: 'LAbs', title: '絶対日時あり', price: 1000, suspended: false, thumbUrl: null,
          updatedText: '5時間前に更新', // 相対推定なら today になるはずの値
          listedAt: '2026-09-01T12:34',
        },
      ])
      const l = db.listListings().find(x => x.mercari_item_id === 'LAbs')!
      expect(l.listed_at).toBe('2026-09-01T12:34')
    })

    it('upsertListings：listedAtを渡さないときは今までどおり（updatedTextからの相対推定）', () => {
      db.upsertListings([
        {
          mercariItemId: 'LNoAbs', title: '絶対日時なし', price: 1000, suspended: false, thumbUrl: null,
          updatedText: '5時間前に更新',
        },
      ])
      const l = db.listListings().find(x => x.mercari_item_id === 'LNoAbs')!
      expect(l.listed_at).toBe(todayLocal())
    })

    it('upsertListings：既存行の更新ではlistedAtを渡しても上書きしない（出品日は後から変わらないはずという判断）', () => {
      db.upsertListings([
        {
          mercariItemId: 'LAbsKeep', title: '絶対日時あり', price: 1000, suspended: false, thumbUrl: null,
          listedAt: '2026-09-01T12:34',
        },
      ])
      let l = db.listListings().find(x => x.mercari_item_id === 'LAbsKeep')!
      expect(l.listed_at).toBe('2026-09-01T12:34')

      // 2回目の収集で別のlistedAt（本来変わらないはずの値）が来ても、既存行は上書きしない
      db.upsertListings([
        {
          mercariItemId: 'LAbsKeep', title: '絶対日時あり', price: 1200, suspended: false, thumbUrl: null,
          listedAt: '2026-09-05T09:00',
        },
      ])
      l = db.listListings().find(x => x.mercari_item_id === 'LAbsKeep')!
      expect(l.listed_at).toBe('2026-09-01T12:34') // 上書きされない
      expect(l.price).toBe(1200) // price等の通常フィールドは今までどおり更新される
    })

    it('reserveInventory：他の出品への引き当ては外れてこちらへ移る。売却済み在庫の引き当ては拒否する', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [
          { name: '在庫A', unit_price: 1000, quantity: 1 },
          { name: '在庫B', unit_price: 1000, quantity: 1 },
        ],
      })
      const [itemA, itemB] = db.listInventory('in_stock')

      db.upsertListings([
        { mercariItemId: 'LA', title: '出品A', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LB', title: '出品B', price: 3500, suspended: false, thumbUrl: null },
      ])

      db.reserveInventory('LA', [itemA.id])
      expect(db.listListings().find(l => l.mercari_item_id === 'LA')!.items.map(i => i.id))
        .toEqual([itemA.id])

      // 他の出品(LA)に引き当て済みの在庫をLBへ移す：LAは未引き当てに戻り、LBに移る。在庫はin_stockのまま
      db.reserveInventory('LB', [itemA.id])
      expect(db.listListings().find(l => l.mercari_item_id === 'LA')!.items).toEqual([])
      expect(db.listListings().find(l => l.mercari_item_id === 'LB')!.items.map(i => i.id))
        .toEqual([itemA.id])
      expect(db.listInventory('in_stock').some(i => i.id === itemA.id)).toBe(true)

      const saleId = db.createSale({ title: '在庫B手動売却', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(saleId, [itemB.id])
      expect(() => db.reserveInventory('LB', [itemB.id])).toThrow('未販売の在庫だけ引き当てられます')
    })

    it('unreserveInventory：外すと在庫タブに戻り、他の出品へ引き当て直せる', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '引き当て解除対象', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LA2', title: '出品A2', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LB2', title: '出品B2', price: 3000, suspended: false, thumbUrl: null },
      ])

      db.reserveInventory('LA2', [item.id])
      db.unreserveInventory('LA2', item.id)
      expect(db.listListings().find(l => l.mercari_item_id === 'LA2')!.items).toEqual([])

      expect(() => db.reserveInventory('LB2', [item.id])).not.toThrow()
      expect(db.listListings().find(l => l.mercari_item_id === 'LB2')!.items.map(i => i.id))
        .toEqual([item.id])
    })

    it('suggestForListing：型番一致 → 自分自身に引き当て済みの在庫は候補から除く', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 2 }],
      })
      const [item1, item2] = db.listInventory('in_stock')
      db.upsertListings([
        { mercariItemId: 'LZ', title: 'クリームわん【Z080-1】', price: 3000, suspended: false, thumbUrl: null },
      ])

      const suggestions = db.suggestForListing('LZ')
      expect(suggestions.map(s => s.id).sort()).toEqual([item1.id, item2.id].sort())

      db.reserveInventory('LZ', [item1.id])
      const after = db.suggestForListing('LZ')
      expect(after.map(s => s.id)).toEqual([item2.id])
    })

    it('suggestForListing：他の出品に引き当て済みの在庫も候補に含み、listingに引き当て先が入る。reserveInventoryで移すと在庫はin_stockのまま', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z090-1】', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'SA', title: 'クリームわん【Z090-1】', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'SB', title: 'クリームわん【Z090-1】', price: 3200, suspended: false, thumbUrl: null },
      ])

      db.reserveInventory('SA', [item.id])

      // SA自身の候補からは除かれる
      expect(db.suggestForListing('SA').map(s => s.id)).toEqual([])

      // SBの候補には、SAに引き当て済みのまま出る（listingに引き当て先が入る）
      const forB = db.suggestForListing('SB')
      expect(forB.map(s => s.id)).toEqual([item.id])
      expect(forB[0].listing).toEqual({ channel: 'mercari', mercari_item_id: 'SA', price: 3000, status: 'active' })

      // SBへ移す：SAは未引き当てに戻り、SBに引き当て、在庫はin_stockのまま
      db.reserveInventory('SB', [item.id])
      expect(db.listListings().find(l => l.mercari_item_id === 'SA')!.items).toEqual([])
      expect(db.listListings().find(l => l.mercari_item_id === 'SB')!.items.map(i => i.id))
        .toEqual([item.id])
      expect(db.listInventory('in_stock').some(i => i.id === item.id)).toBe(true)
    })

    it('listListings：reserved_cost・expected_profitが引き当てた在庫から出る。未引き当てはnull', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '出品対象', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LP', title: '出品対象', price: 3000, suspended: false, thumbUrl: null },
      ])

      const before = db.listListings().find(l => l.mercari_item_id === 'LP')!
      expect(before.reserved_cost).toBe(0)
      expect(before.expected_profit).toBeNull()

      db.reserveInventory('LP', [item.id])
      const after = db.listListings().find(l => l.mercari_item_id === 'LP')!
      expect(after.reserved_cost).toBe(1000)
      // fee_rate_bp既定1000(10%) → fee=300、送料は引かない
      expect(after.expected_profit).toBe(3000 - 300 - 1000)

      expect(db.listListings({ onlyUnallocated: true }).some(l => l.mercari_item_id === 'LP')).toBe(false)
    })

    it('setListingShipping：expected_profitに送料が反映され、売れたとき販売へ引き継がれる（実額があればactualを優先）', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [
          { name: '発送方法引き継ぎ対象', unit_price: 1000, quantity: 1 },
          { name: '発送方法引き継ぎ対象2', unit_price: 1000, quantity: 1 },
        ],
      })
      const [item1, item2] = db.listInventory('in_stock')
      const method = db.listShippingMethods()[0]

      db.upsertListings([
        { mercariItemId: 'mShip1', title: '発送方法引き継ぎ対象', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'mShip2', title: '発送方法引き継ぎ対象2', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'mShip3', title: '発送方法引き継ぎ対象3', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('mShip1', [item1.id])
      db.reserveInventory('mShip2', [item2.id])
      db.setListingShipping('mShip1', method.id)
      db.setListingShipping('mShip2', method.id)

      // 出品一覧の見込み粗利にも発送方法の送料が反映される
      const listing1 = db.listListings().find(l => l.mercari_item_id === 'mShip1')!
      expect(listing1.shipping_method_id).toBe(method.id)
      expect(listing1.shipping_method_name).toBe(method.name)
      expect(listing1.expected_profit).toBe(3000 - 300 - 1000 - method.fee)

      // mShip1：実額なしで取り込まれる → 発送方法（送料・確認済み）を引き継ぐ
      db.insertCollected([
        { mercariItemId: 'mShip1', title: '発送方法引き継ぎ対象', price: 3000, soldAt: '2026-01-10' },
      ])
      const sale1 = db.listSales().find(s => s.mercari_item_id === 'mShip1')!
      expect(sale1.shipping_method_id).toBe(method.id)
      expect(sale1.shipping_fee).toBe(method.fee)
      expect(sale1.is_shipping_confirmed).toBe(1)
      expect(sale1.shipping_source).toBe('manual')

      // mShip2：販売履歴の送料が ¥0（メルカリ便以外）で取り込まれる → 未確定なので出品時の発送方法を引き継ぐ
      db.insertCollected([
        {
          mercariItemId: 'mShip2', title: '発送方法引き継ぎ対象2', price: 3000, soldAt: '2026-01-10',
          shippingFee: 0,
        },
      ])
      const sale2 = db.listSales().find(s => s.mercari_item_id === 'mShip2')!
      expect(sale2.shipping_source).toBe('manual')
      expect(sale2.shipping_fee).toBe(method.fee)
      expect(sale2.shipping_method_id).toBe(method.id)
      expect(sale2.is_shipping_confirmed).toBe(1)

      // 次の取り込みで販売履歴の送料がまた ¥0 でも、引き継いだ発送方法は上書きされない
      db.updateCollectedActuals([{ mercariItemId: 'mShip2', soldAt: '2026-01-10', fee: 300, shippingFee: 0 }])
      const sale2b = db.listSales().find(s => s.mercari_item_id === 'mShip2')!
      expect(sale2b.shipping_source).toBe('manual')
      expect(sale2b.shipping_fee).toBe(method.fee)

      // mShip3：メルカリ便で実額 ¥500 → 出品時の発送方法より実額を優先
      db.setListingShipping('mShip3', method.id)
      db.insertCollected([
        { mercariItemId: 'mShip3', title: '発送方法引き継ぎ対象3', price: 3000, soldAt: '2026-01-10', shippingFee: 500 },
      ])
      const sale3 = db.listSales().find(s => s.mercari_item_id === 'mShip3')!
      expect(sale3.shipping_source).toBe('actual')
      expect(sale3.shipping_fee).toBe(500)
    })

    it('insertCollected：出品への引き当てをそのまま販売に引き継ぐ（link_source=listing、出品はsoldに）', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '出品済み商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'mTakeover', title: '出品済み商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('mTakeover', [item.id])

      db.insertCollected([
        { mercariItemId: 'mTakeover', title: '出品済み商品', price: 3000, soldAt: '2026-01-10' },
      ])

      const sale = db.listSales().find(s => s.mercari_item_id === 'mTakeover')!
      expect(sale.unmatched).toBe(0)
      expect(sale.cost).toBe(1000)

      const lines = db.listSaleLines(sale.id)
      expect(lines.map(l => l.id)).toEqual([item.id])

      // active/suspendedの一覧からは消え、soldとして残る
      expect(db.listListings().find(l => l.mercari_item_id === 'mTakeover')).toBeUndefined()
      const sold = db.listListings({ status: ['sold'] }).find(l => l.mercari_item_id === 'mTakeover')
      expect(sold?.status).toBe('sold')
    })

    it('insertCollected：キーワード不一致・型番なしのタイトルでも、出品への引き当てを引き継いだらkind=resaleになる', () => {
      db.setSetting('mercari_keyword', '限定コラボ') // タイトルはこれに一致しない
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '型番なしの雑貨', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'mTakeoverKind', title: '型番なしの雑貨', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('mTakeoverKind', [item.id])

      db.insertCollected([
        { mercariItemId: 'mTakeoverKind', title: '型番なしの雑貨', price: 3000, soldAt: '2026-01-10' },
      ])

      const sale = db.listSales().find(s => s.mercari_item_id === 'mTakeoverKind')!
      // キーワード不一致・型番なしなら本来 personal 判定になるところを、人が出品に
      // 在庫を引き当てていた（＝転売の意思）ので resale にする
      expect(sale.kind).toBe('resale')
      expect(sale.cost).toBe(1000)
    })

    it('insertCollected：引き当てが無い出品が売れても出品はsoldになり、販売は型番FIFOで自動紐付けされる', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z085-1】', unit_price: 1000, quantity: 1 }],
      })
      db.upsertListings([
        { mercariItemId: 'mNoAlloc', title: 'クリームわん【Z085-1】', price: 3000, suspended: false, thumbUrl: null },
      ])
      // reserveInventoryはしない（未引き当てのまま出品が売れるケース）

      db.insertCollected([
        { mercariItemId: 'mNoAlloc', title: 'クリームわん【Z085-1】', price: 3000, soldAt: '2026-01-10' },
      ])

      // 引き当てが無くても、売れた以上は出品タブ（active/suspended）に残さない
      expect(db.listListings().find(l => l.mercari_item_id === 'mNoAlloc')).toBeUndefined()
      const sold = db.listListings({ status: ['sold'] }).find(l => l.mercari_item_id === 'mNoAlloc')
      expect(sold?.status).toBe('sold')

      // takeOverListingが引き継げなかった（引き当て無し）ので、型番FIFOの自動確定にフォールバックする
      const sale = db.listSales().find(s => s.mercari_item_id === 'mNoAlloc')!
      expect(sale.unmatched).toBe(0)
      expect(sale.auto_linked).toBe(1)
      expect(sale.cost).toBe(1000)
    })

    it('deletePurchase：出品に引き当て中の在庫を含む仕入も削除できる（引き当ては外れ、出品は未引き当てに戻る）', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '引き当て中の商品', unit_price: 1000, quantity: 1 }],
      })
      const purchaseId = db.listPurchases().find(p => p.first_line_name === '引き当て中の商品')!.id
      const item = db.listInventory('in_stock').find(i => i.name === '引き当て中の商品')!
      db.upsertListings([
        { mercariItemId: 'mDeletePurchase', title: '引き当て中の商品', price: 2000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('mDeletePurchase', [item.id])

      // listing_line にON DELETEが無いためFK違反で失敗していた（修正前）。今は成功する
      expect(() => db.deletePurchase(purchaseId)).not.toThrow()

      // 出品自体は残るが、未引き当てに戻る（在庫が消えたので）
      const listing = db.listListings().find(l => l.mercari_item_id === 'mDeletePurchase')!
      expect(listing.items).toEqual([])
      expect(
        db.listListings({ onlyUnallocated: true }).some(l => l.mercari_item_id === 'mDeletePurchase'),
      ).toBe(true)
      expect(db.listPurchases().find(p => p.id === purchaseId)).toBeUndefined()
    })

    it('型番FIFOの自動確定は、他の出品に引き当て済みの在庫を候補から除く', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
      })
      const reservedItem = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LR', title: 'クリームわん【Z080-1】', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LR', [reservedItem.id])

      // 型番一致の在庫はこの1点だけだが、出品に引き当て済みなのでFIFOでは使われない
      const saleId = db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-01-10', price: 2000 })
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(1)
      expect(sale.auto_linked).toBe(0)

      const suggestions = db.suggestInventory(saleId)
      expect(suggestions.some(i => i.id === reservedItem.id)).toBe(false)
    })

    it('endListing：在庫は未出品に戻り（引き当て解除）、出品はendedになる', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '取り下げ対象', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LE', title: '取り下げ対象', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LE', [item.id])

      db.endListing('LE')

      expect(db.listInventory('in_stock').find(i => i.id === item.id)!.listing).toBeNull()
      const ended = db.listListings({ status: ['ended'] }).find(l => l.mercari_item_id === 'LE')!
      expect(ended.status).toBe('ended')
      expect(ended.items).toEqual([])

      // 取り下げた在庫は別の出品に引き当て直せる
      db.upsertListings([
        { mercariItemId: 'LE2', title: '再出品', price: 2500, suspended: false, thumbUrl: null },
      ])
      expect(() => db.reserveInventory('LE2', [item.id])).not.toThrow()
    })

    it('reserveInventory：終了済み（ended）の出品には引き当てられない', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '終了済み出品対象', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LEndedGuard', title: '終了済み出品対象', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.endListing('LEndedGuard')

      expect(() => db.reserveInventory('LEndedGuard', [item.id]))
        .toThrow('終了した出品には引き当てられません')

      // 拒否された結果、inventory_view に重複行が出ていない（在庫は1件のまま）
      expect(db.listInventory('in_stock').filter(i => i.id === item.id)).toHaveLength(1)
    })

    it('reserveInventory：sold（出品経由で売れた）出品にも引き当てられない', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [
          { name: '売却済み出品対象', unit_price: 1000, quantity: 1 },
          { name: '別の在庫', unit_price: 1000, quantity: 1 },
        ],
      })
      const [soldTarget, other] = db.listInventory('in_stock')
      db.upsertListings([
        { mercariItemId: 'LSoldGuard', title: '売却済み出品対象', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LSoldGuard', [soldTarget.id])
      db.insertCollected([
        { mercariItemId: 'LSoldGuard', title: '売却済み出品対象', price: 3000, soldAt: '2026-01-10' },
      ])
      expect(db.listListings({ status: ['sold'] }).find(l => l.mercari_item_id === 'LSoldGuard')?.status)
        .toBe('sold')

      expect(() => db.reserveInventory('LSoldGuard', [other.id]))
        .toThrow('終了した出品には引き当てられません')
    })

    it('getDashboard().needsListingAllocation：activeで未引き当ての出品数（suspendedは数えない）', () => {
      db.upsertListings([
        { mercariItemId: 'NA1', title: '未引き当て1', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'NA2', title: '未引き当て2', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'NA3', title: '公開停止中', price: 1000, suspended: true, thumbUrl: null },
      ])
      expect(db.getDashboard().needsListingAllocation).toBe(2)

      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '引き当て用', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.reserveInventory('NA1', [item.id])
      expect(db.getDashboard().needsListingAllocation).toBe(1)
    })

    it('getDashboard().recentRuns：取り込み元ごとの直近1件（mercari + 有効なメロジョイ口座ごと）が状態を隠さず並ぶ', () => {
      // shopId（beforeEachで作成）はkind未指定＝'other'なので、ここではmellojoy口座を別途作る
      const mellojoyAId = db.createShopAccount('メロジョイ口座A', 'mellojoy')
      const mellojoyBId = db.createShopAccount('メロジョイ口座B', 'mellojoy')

      // メルカリ：1回目ok→2回目failed（直近＝failedだけが残る）
      const m1 = db.startRun('mercari')
      db.finishRun(m1, 'ok', 3, 1)
      const m2 = db.startRun('mercari')
      db.finishRun(m2, 'failed', 0, 0, 'ERR_FAILED loading /account')

      // メロジョイ口座A：ok
      const a1 = db.startRun('mellojoy', mellojoyAId)
      db.finishRun(a1, 'ok', 2, 1)

      const recent = db.getDashboard().recentRuns
      expect(recent).toHaveLength(2)
      expect(recent[0].source).toBe('mercari')
      expect(recent[0].status).toBe('failed')
      expect(recent[0].message).toBe('ERR_FAILED loading /account')
      expect(recent[1].source).toBe('mellojoy')
      expect(recent[1].shop_account_id).toBe(mellojoyAId)
      expect(recent[1].status).toBe('ok')

      // kind='other'（shopId）の実行があっても、メロジョイ口座扱いにはしない
      const otherRun = db.startRun('mellojoy', shopId)
      db.finishRun(otherRun, 'ok', 1, 1)
      expect(db.getDashboard().recentRuns.some(r => r.shop_account_id === shopId)).toBe(false)

      // 無効化した口座の実行は入らない
      const b1 = db.startRun('mellojoy', mellojoyBId)
      db.finishRun(b1, 'auth_required', 0, 0, 'ログインが必要です')
      db.updateShopAccount(mellojoyBId, { is_active: 0 })
      expect(db.getDashboard().recentRuns.some(r => r.shop_account_id === mellojoyBId)).toBe(false)

      // 有効に戻すと、口座の名前順（A→B）で並ぶ
      db.updateShopAccount(mellojoyBId, { is_active: 1 })
      const recent2 = db.getDashboard().recentRuns
      expect(recent2.map(r => r.shop_account_name)).toEqual([null, 'メロジョイ口座A', 'メロジョイ口座B'])
    })

    it('getItemTimeline：出品への引き当て・出品経由の売却でlistedイベントが「注文」と「売れた」の間に出る', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2020-01-01',
        shipping_fee: 0,
        lines: [{ name: 'タイムライン出品商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LT', title: 'タイムライン出品商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LT', [item.id])

      const beforeSale = db.getItemTimeline(item.id)!
      expect(beforeSale.events.map(e => e.kind)).toEqual(['ordered', 'listed'])
      const listedEvent = beforeSale.events[1]
      expect(listedEvent.title).toBe('メルカリに出品')
      expect(listedEvent.detail).toBe('¥3,000')
      expect(listedEvent.amount).toBe(3000)

      // 未来日で確実に「今日」より後にする（first_seen_atは今日になるため）
      db.insertCollected([
        { mercariItemId: 'LT', title: 'タイムライン出品商品', price: 3000, soldAt: '2099-01-01' },
      ])

      const afterSale = db.getItemTimeline(item.id)!
      expect(afterSale.events.map(e => e.kind)).toEqual([
        'ordered', 'listed', 'sold', 'sale_shipped', 'sale_delivered', 'sale_completed',
      ])
    })
  })

  describe('タグの派生：仕入→在庫→販売はコピーせず「派生」で見える', () => {
    it('仕入→在庫3点→紐付いた販売、へ派生する。直接タグとは重複せず、上流の付け外しがそのまま効く', () => {
      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '派生タグ対象', unit_price: 1000, quantity: 3 }],
      })
      const tagA = db.createTag('A')
      const tagB = db.createTag('B')
      db.setPurchaseTags(purchaseId, [tagA])

      // 仕入のタグ → その在庫3点すべてに派生する
      const items = db.listInventory('in_stock')
      expect(items).toHaveLength(3)
      for (const item of items) {
        expect(item.tags).toEqual([])
        expect(item.inherited_tags.map(t => t.id)).toEqual([tagA])
      }

      // 1点に直接タグBを付ける（在庫のタグと派生タグは重複しない）
      const [target, other] = items
      db.setInventoryTags(target.id, [tagB])
      const targetAfter = db.listInventory('in_stock').find(i => i.id === target.id)!
      expect(targetAfter.tags.map(t => t.id)).toEqual([tagB])
      expect(targetAfter.inherited_tags.map(t => t.id)).toEqual([tagA])

      // その在庫が紐付いた販売には、在庫の直接タグ(B)＋仕入のタグ(A)が両方派生する
      const saleId = db.createSale({ title: '派生タグ対象', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(saleId, [target.id])
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.tags).toEqual([])
      expect(sale.inherited_tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())

      // 販売に直接タグAを付けると、直接タグに出て、派生タグからは除かれる（重複しない）
      db.setSaleTags(saleId, [tagA])
      const withDirect = db.listSales().find(s => s.id === saleId)!
      expect(withDirect.tags.map(t => t.id)).toEqual([tagA])
      expect(withDirect.inherited_tags.map(t => t.id)).toEqual([tagB])

      // 紐付けを解除すると派生タグは消える（人が付けた直接タグは残る）
      db.unlinkInventory(saleId, target.id)
      const unlinked = db.listSales().find(s => s.id === saleId)!
      expect(unlinked.tags.map(t => t.id)).toEqual([tagA])
      expect(unlinked.inherited_tags).toEqual([])

      // 仕入のタグを外すと、まだ紐付いていない在庫からも派生タグが消える
      db.setPurchaseTags(purchaseId, [])
      const afterRemove = db.listInventory('in_stock').find(i => i.id === other.id)!
      expect(afterRemove.inherited_tags).toEqual([])
    })

    it('autoLinkSale（型番の自動確定）でも在庫・仕入のタグが販売へ派生する（コピーはしない）', () => {
      const tagId = db.createTag('自動確定タグ')
      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
      })
      db.setPurchaseTags(purchaseId, [tagId])

      const saleId = db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-01-05', price: 2000 })
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.auto_linked).toBe(1)
      expect(sale.tags).toEqual([])
      expect(sale.inherited_tags.map(t => t.id)).toEqual([tagId])
    })

    it('出品からの引き継ぎ（insertCollected）でも在庫のタグが販売へ派生する（コピーはしない）', () => {
      const tagId = db.createTag('出品タグ')
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'タグ付き出品商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.setInventoryTags(item.id, [tagId])
      db.upsertListings([
        { mercariItemId: 'LTAG', title: 'タグ付き出品商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LTAG', [item.id])

      db.insertCollected([
        { mercariItemId: 'LTAG', title: 'タグ付き出品商品', price: 3000, soldAt: '2026-01-10' },
      ])

      const sale = db.listSales().find(s => s.mercari_item_id === 'LTAG')!
      expect(sale.tags).toEqual([])
      expect(sale.inherited_tags.map(t => t.id)).toEqual([tagId])
    })
  })

  describe('setPurchaseTags / listPurchases・getPurchase の tags', () => {
    it('setPurchaseTags：置き換え（丸ごと入れ替え）。listPurchases・getPurchaseの両方に出る', () => {
      const tagA = db.createTag('A')
      const tagB = db.createTag('B')

      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '仕入タグ対象', unit_price: 1000, quantity: 1 }],
      })
      db.setPurchaseTags(purchaseId, [tagA, tagB])
      expect(db.listPurchases().find(p => p.id === purchaseId)!.tags.map(t => t.id).sort())
        .toEqual([tagA, tagB].sort())
      expect(db.getPurchase(purchaseId).tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())

      // 置き換え：Bだけになる
      db.setPurchaseTags(purchaseId, [tagB])
      expect(db.listPurchases().find(p => p.id === purchaseId)!.tags.map(t => t.id)).toEqual([tagB])
      expect(db.getPurchase(purchaseId).tags.map(t => t.id)).toEqual([tagB])

      // 空配列で全部外す
      db.setPurchaseTags(purchaseId, [])
      expect(db.listPurchases().find(p => p.id === purchaseId)!.tags).toEqual([])
    })
  })

  describe('setProductTags：商品（型番）のタグ。在庫・販売へ派生し、優先順位 purchase > product で1つにまとまる', () => {
    it('型番タグが在庫のinherited_tags（from: product）・販売のinherited_tagsに出る。listProducts/getProductのtagsにも出る', () => {
      const tagId = db.createTag('型番タグ')
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '型番タグ対象【Z900】', unit_price: 1000, quantity: 1 }],
      })
      db.setProductTags('Z900', [tagId])

      const item = db.listInventory('in_stock')[0]
      expect(item.tags).toEqual([])
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'product' }])

      expect(db.listProducts().find(p => p.model_code === 'Z900')!.tags.map(t => t.id)).toEqual([tagId])
      expect(db.getProduct('Z900')!.tags.map(t => t.id)).toEqual([tagId])

      const saleId = db.createSale({ title: '型番タグ対象【Z900】', sold_at: '2026-01-05', price: 2000 })
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.tags).toEqual([])
      expect(sale.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'product' }])
    })

    it('優先順位：同じタグが仕入(purchase)・商品(product)の両方から来たら purchase を優先して1つにまとめる', () => {
      const tagId = db.createTag('共通タグ')
      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '優先順位確認【Z901】', unit_price: 1000, quantity: 1 }],
      })
      db.setPurchaseTags(purchaseId, [tagId])
      db.setProductTags('Z901', [tagId])

      const item = db.listInventory('in_stock')[0]
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '共通タグ', sort_order: 0, from: 'purchase' }])
    })

    it('setProductTags：置き換え（丸ごと入れ替え）。deleteTagでCASCADEされ、product_tagからも消える', () => {
      const tagA = db.createTag('A')
      const tagB = db.createTag('B')
      db.setProductTags('Z902', [tagA, tagB])
      expect(db.listProducts().find(p => p.model_code === 'Z902')).toBeUndefined() // まだ在庫が無ければ商品一覧に出ない

      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '置き換え確認【Z902】', unit_price: 1000, quantity: 1 }],
      })
      expect(db.listProducts().find(p => p.model_code === 'Z902')!.tags.map(t => t.id).sort())
        .toEqual([tagA, tagB].sort())

      db.setProductTags('Z902', [tagB])
      expect(db.listProducts().find(p => p.model_code === 'Z902')!.tags.map(t => t.id)).toEqual([tagB])

      db.deleteTag(tagB)
      expect(db.listProducts().find(p => p.model_code === 'Z902')!.tags).toEqual([])
    })
  })

  describe('仕入先の自動タグ（shop_account_tag）：作成時にだけ purchase_tag へ自動で付く', () => {
    it('口座に自動タグA→createPurchaseの仕入にA、その在庫のinherited_tagsにA(from purchase)、売れた販売にもA。下書き→確定でも残る。setPurchaseTags([])で外せる', () => {
      const tagId = db.createTag('自動タグA')
      db.updateShopAccount(shopId, { auto_tag_ids: [tagId] })
      expect(db.listShopAccounts().find(a => a.id === shopId)!.auto_tags.map(t => t.id)).toEqual([tagId])
      expect(db.getShopAccount(shopId)!.auto_tags.map(t => t.id)).toEqual([tagId])

      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '自動タグ対象', unit_price: 1000, quantity: 1 }],
      })
      expect(db.getPurchase(purchaseId).tags.map(t => t.id)).toEqual([tagId])

      const item = db.listInventory('in_stock').find(i => i.name === '自動タグ対象')!
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '自動タグA', sort_order: 0, from: 'purchase' }])

      const saleId = db.createSale({ title: '自動タグ対象', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(saleId, [item.id])
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.inherited_tags.map(t => t.id)).toEqual([tagId])

      // 下書き→確定でも残る
      const draftId = db.createPurchaseDraft({
        import_key: 'mellojoy:#900001',
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '下書き対象', quantity: 1 }],
      })
      expect(db.getPurchase(draftId).tags.map(t => t.id)).toEqual([tagId])
      db.confirmPurchase(draftId, {
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '下書き対象', unit_price: 1000, quantity: 1 }],
      })
      expect(db.getPurchase(draftId).tags.map(t => t.id)).toEqual([tagId])

      // 後から外せる（作成時だけの挙動。外しても再付与しない）
      db.setPurchaseTags(purchaseId, [])
      expect(db.getPurchase(purchaseId).tags).toEqual([])
    })

    it('updateShopAccount：auto_tag_idsは丸ごと置き換え。他のpatchフィールドと同時に渡しても独立して効く', () => {
      const tagA = db.createTag('A')
      const tagB = db.createTag('B')
      db.updateShopAccount(shopId, { auto_tag_ids: [tagA, tagB], name: '改名後' })
      let acc = db.getShopAccount(shopId)!
      expect(acc.name).toBe('改名後')
      expect(acc.auto_tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())

      db.updateShopAccount(shopId, { auto_tag_ids: [tagB] })
      acc = db.getShopAccount(shopId)!
      expect(acc.auto_tags.map(t => t.id)).toEqual([tagB])

      db.updateShopAccount(shopId, { auto_tag_ids: [] })
      acc = db.getShopAccount(shopId)!
      expect(acc.auto_tags).toEqual([])
    })
  })

  describe('getPurchase：lines[].items（明細ごとの在庫の状態）', () => {
    it('3点のうち1点出品中・1点販売済・1点未出品の内訳が返る', () => {
      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '内訳確認', unit_price: 1000, quantity: 3 }],
      })
      const [a, b, c] = db.listInventory('in_stock')

      db.upsertListings([
        { mercariItemId: 'LDETAIL', title: '内訳確認', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LDETAIL', [a.id])

      const saleId = db.createSale({ title: '内訳確認', sold_at: '2026-01-10', price: 2500 })
      db.linkInventory(saleId, [b.id])
      // c は未出品のまま

      const detail = db.getPurchase(purchaseId)
      expect(detail.lines).toHaveLength(1)
      const items = detail.lines[0].items
      expect(items).toHaveLength(3)
      for (const it of items) expect(it.landed_cost).toBeGreaterThan(0)

      const itemA = items.find(i => i.id === a.id)!
      expect(itemA.status).toBe('in_stock')
      expect(itemA.listing_price).toBe(3000)
      expect(itemA.sale_id).toBeNull()

      const itemB = items.find(i => i.id === b.id)!
      expect(itemB.status).toBe('sold')
      expect(itemB.listing_price).toBeNull()
      expect(itemB.sale_id).toBe(saleId)
      expect(itemB.sale_price).toBe(2500)
      expect(itemB.sold_at).toBe('2026-01-10')

      const itemC = items.find(i => i.id === c.id)!
      expect(itemC.status).toBe('in_stock')
      expect(itemC.listing_price).toBeNull()
      expect(itemC.sale_id).toBeNull()
    })

    it('下書きは明細のitemsが空配列', () => {
      const draftId = db.createPurchaseDraft({
        import_key: 'mellojoy:#900002',
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '下書き明細', quantity: 2 }],
      })
      const detail = db.getPurchase(draftId)
      expect(detail.lines[0].items).toEqual([])
    })

    it('分割で生まれた子は親のpurchase_line_idを引き継ぎ、items には split 親は出ず子だけ出る', () => {
      const purchaseId = db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '分割確認', unit_price: 1000, quantity: 1 }],
      })
      const parent = db.listInventory('in_stock')[0]
      const childIds = db.splitInventory(parent.id, 2)

      const items = db.getPurchase(purchaseId).lines[0].items
      expect(items.map(i => i.id).sort()).toEqual([...childIds].sort())
      expect(items.every(i => i.status === 'in_stock')).toBe(true)
    })
  })

  describe('linkInventory：在庫の状態ガード・出品への引き当ての引き継ぎ', () => {
    it('in_stock でない在庫（廃棄済み）を紐付けようとするとthrow', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '廃棄済み紐付けガード', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.disposeInventory(item.id, 'テスト理由', 'disposed')

      const saleId = db.createSale({ title: '別の販売', sold_at: '2026-01-05', price: 1000 })
      expect(() => db.linkInventory(saleId, [item.id]))
        .toThrow('販売済み・廃棄済みの在庫は紐付けられません')
    })

    it('出品に引き当て中の在庫は紐付け可。紐付けたらその引き当ては外れる（出品のstatusは変えない）', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '引き当て中の紐付け', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LMANUAL', title: '引き当て中の紐付け', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LMANUAL', [item.id])

      const saleId = db.createSale({ title: '人が別の販売に決めた', sold_at: '2026-01-05', price: 2000 })
      expect(() => db.linkInventory(saleId, [item.id])).not.toThrow()

      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.cost).toBe(1000)

      // 出品側の引き当ては外れるが、出品自体は active のまま（未引き当てに戻る）
      const listing = db.listListings().find(l => l.mercari_item_id === 'LMANUAL')!
      expect(listing.status).toBe('active')
      expect(listing.items).toEqual([])
    })
  })

  describe('disposeInventory / splitInventory：出品への引き当てが先に外れる', () => {
    it('disposeInventory：引き当て済み在庫を廃棄すると listListings でその出品が未引き当てに戻る', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '廃棄で引き当て解除', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LDISPOSE', title: '廃棄で引き当て解除', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LDISPOSE', [item.id])

      db.disposeInventory(item.id, 'テスト理由', 'disposed')

      const listing = db.listListings().find(l => l.mercari_item_id === 'LDISPOSE')!
      expect(listing.items).toEqual([])
      expect(db.listListings({ onlyUnallocated: true }).some(l => l.mercari_item_id === 'LDISPOSE'))
        .toBe(true)
    })

    it('splitInventory：引き当て済み在庫を分割すると listListings でその出品が未引き当てに戻る', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '分割で引き当て解除', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'LSPLIT', title: '分割で引き当て解除', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LSPLIT', [item.id])

      db.splitInventory(item.id, 2)

      const listing = db.listListings().find(l => l.mercari_item_id === 'LSPLIT')!
      expect(listing.items).toEqual([])
    })
  })

  describe('disposeInventory：disposed_at は UTC ではなく日本時間の日付で入る', () => {
    it('JST 深夜0時台（UTC ではまだ前日）でも disposed_at は当日の日付になる', () => {
      // JST 2026-02-02 00:30 = UTC 2026-02-01 15:30。
      // date('now') は UTC で丸めるため、この時刻に廃棄すると誤って前日（2026-02-01）が入っていた
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 15, 30, 0)))
      try {
        db.createPurchase({
          shop_account_id: shopId,
          ordered_at: '2026-01-01',
          shipping_fee: 0,
          lines: [{ name: '深夜廃棄テスト', unit_price: 1000, quantity: 1 }],
        })
        const item = db.listInventory('in_stock')[0]
        db.disposeInventory(item.id, '深夜に廃棄', 'disposed')

        const raw = db.getDb().prepare('SELECT disposed_at FROM inventory_item WHERE id = ?')
          .get(item.id) as { disposed_at: string | null }
        expect(raw.disposed_at).toBe('2026-02-02')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('自動確定は抽出した型番が在庫の model_code と完全一致するときだけ（枝番の有無は問わない）', () => {
    it('枝番なしの在庫と完全一致（A037）・枝番ありの在庫と完全一致（Z078-2）は自動確定、シリーズだけの型番（A035）は候補止まり', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [
          { name: 'いちごスフレ【Z078-2】', unit_price: 1000, quantity: 1 },
          { name: 'メロージョイ ミニランド【A035-1】', unit_price: 1200, quantity: 1 },
          { name: 'メロージョイ ミニランド【A035-2】', unit_price: 1300, quantity: 1 },
          { name: 'メロージョイ Sサイズ【A037】', unit_price: 1400, quantity: 1 },
        ],
      })

      const saleBranch = db.createSale({ title: '【Z078-2】いちごスフレ', sold_at: '2026-01-10', price: 2000 })
      expect(db.listSales().find(s => s.id === saleBranch)!.unmatched).toBe(0)

      // 在庫はA035-1／A035-2の枝番付きだけで、A035と文字列完全一致する在庫が無いので候補止まり
      const saleSeriesOnly = db.createSale({ title: '【A035】メロージョイ ミニランド', sold_at: '2026-01-10', price: 2000 })
      expect(db.listSales().find(s => s.id === saleSeriesOnly)!.unmatched).toBe(1)

      // 在庫が枝番なしのA037で、販売の型番も枝番なしのA037＝文字列完全一致なので自動確定
      const saleExactNoBranch = db.createSale({ title: '【A037】メロージョイ Sサイズ', sold_at: '2026-01-10', price: 2000 })
      expect(db.listSales().find(s => s.id === saleExactNoBranch)!.unmatched).toBe(0)
    })
  })

  describe('autoReserveListings：出品への型番の完全一致・先入先出の自動引き当て', () => {
    it('枝番なしで在庫と完全一致（A037）の出品2件が在庫3点のうち古い順の2点に引き当たる。シリーズだけの型番（A035）は引き当たらない。既に引き当て済みは触らない', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'メロージョイ Sサイズ【A037】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: 'メロージョイ Sサイズ【A037】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-03', shipping_fee: 0,
        lines: [{ name: 'メロージョイ Sサイズ【A037】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'メロージョイ ミニランド【A035-1】', unit_price: 1200, quantity: 1 }],
      })

      const a037items = db.listInventory('in_stock')
        .filter(i => i.model_code === 'A037')
        .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at))
      expect(a037items).toHaveLength(3)
      const [oldest, middle, newest] = a037items

      // 3点目（最新）は先に別の出品へ引き当て済みにしておく（自動引き当てが横取りしないことの確認）
      db.upsertListings([
        { mercariItemId: 'LAuto0', title: '既存引き当て済み', price: 2000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LAuto0', [newest.id])

      db.upsertListings([
        { mercariItemId: 'LAuto1', title: 'メロージョイ Sサイズ【A037】', price: 3000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LAuto2', title: 'メロージョイ Sサイズ【A037】', price: 3200, suspended: false, thumbUrl: null },
        {
          mercariItemId: 'LAutoA035', title: 'メロージョイ ミニランド【A035】', price: 1500,
          suspended: false, thumbUrl: null,
        },
      ])

      const count = db.autoReserveListings()
      expect(count).toBe(2) // A035（在庫はA035-1でA035とは文字列一致しない）は対象外

      const l1 = db.listListings().find(l => l.mercari_item_id === 'LAuto1')!
      const l2 = db.listListings().find(l => l.mercari_item_id === 'LAuto2')!
      expect(l1.items.map(i => i.id)).toEqual([oldest.id])
      expect(l2.items.map(i => i.id)).toEqual([middle.id])

      // シリーズだけの型番（A035）は候補にならない
      expect(db.listListings().find(l => l.mercari_item_id === 'LAutoA035')!.items).toEqual([])

      // 既に引き当て済みのものは触らない
      expect(db.listListings().find(l => l.mercari_item_id === 'LAuto0')!.items.map(i => i.id))
        .toEqual([newest.id])

      // 対象が無くなったので再実行しても0
      expect(db.autoReserveListings()).toBe(0)
    })
  })

  describe('autoReserveListings：listingIds で対象を絞る（画面の絞り込みを無視して全件に走らないこと）', () => {
    it('listingIds を渡すと、その出品だけが引き当たる（渡していない未引き当ての出品はそのまま残る）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'りんご【A080】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'みかん【A081】', unit_price: 1000, quantity: 1 }],
      })
      db.upsertListings([
        { mercariItemId: 'LFilterA', title: 'りんご【A080】', price: 2000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LFilterB', title: 'みかん【A081】', price: 2000, suspended: false, thumbUrl: null },
      ])

      const count = db.autoReserveListings(['LFilterA'])
      expect(count).toBe(1)
      expect(db.listListings().find(l => l.mercari_item_id === 'LFilterA')!.items).toHaveLength(1)
      // 渡していないLFilterBは在庫があっても引き当たらない
      expect(db.listListings().find(l => l.mercari_item_id === 'LFilterB')!.items).toEqual([])
    })

    it('空配列を渡すと0件で、未引き当ての出品は1件も引き当たらない', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'くり【A082】', unit_price: 1000, quantity: 1 }],
      })
      db.upsertListings([
        { mercariItemId: 'LFilterC', title: 'くり【A082】', price: 2000, suspended: false, thumbUrl: null },
      ])

      expect(db.autoReserveListings([])).toBe(0)
      expect(db.listListings().find(l => l.mercari_item_id === 'LFilterC')!.items).toEqual([])
    })

    it('渡した id に、既に引き当て済み・型番が2個以上の出品が混ざっていてもエラーにならず、条件を満たすものだけ引き当たる', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A083】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A084】', unit_price: 1000, quantity: 1 }],
      })
      db.upsertListings([
        { mercariItemId: 'LFilterD', title: '対象【A083】', price: 2000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LFilterAlready', title: '既に引当済み', price: 2000, suspended: false, thumbUrl: null },
        {
          mercariItemId: 'LFilterTwo', title: '対象【A083】【A084】', price: 2000,
          suspended: false, thumbUrl: null,
        },
      ])
      const already = db.listInventory('in_stock').find(i => i.model_code === 'A084')!
      db.reserveInventory('LFilterAlready', [already.id])
      expect(db.listListings().find(l => l.mercari_item_id === 'LFilterAlready')!.items).toHaveLength(1)

      const count = db.autoReserveListings(['LFilterD', 'LFilterAlready', 'LFilterTwo'])
      expect(count).toBe(1)
      expect(db.listListings().find(l => l.mercari_item_id === 'LFilterD')!.items).toHaveLength(1)
      expect(db.listListings().find(l => l.mercari_item_id === 'LFilterTwo')!.items).toEqual([])
    })

    it('出品先（channel）が混ざった状態で、片方の出品先の id だけ渡したらもう片方は引き当たらない', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'めるかり【A085】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'やふー【A086】', unit_price: 1000, quantity: 1 }],
      })
      db.upsertListings(
        [{ mercariItemId: 'LMercari1', title: 'めるかり【A085】', price: 2000, suspended: false, thumbUrl: null }],
        'mercari',
      )
      db.upsertListings(
        [{ mercariItemId: 'z10000001', title: 'やふー【A086】', price: 2000, suspended: false, thumbUrl: null }],
        'yahoo',
      )

      const count = db.autoReserveListings(['LMercari1'])
      expect(count).toBe(1)
      expect(db.listListings().find(l => l.mercari_item_id === 'LMercari1')!.items).toHaveLength(1)
      expect(db.listListings().find(l => l.mercari_item_id === 'z10000001')!.items).toEqual([])
    })
  })

  describe('期間費用（経費の明細・計上月・振込手数料の自動計上は撤去）', () => {
    it('createExpense：明細があれば合計・代表項目を明細から導く。明細が無ければinput.amount/categoryをそのまま使う', () => {
      const id = db.createExpense({
        occurred_at: '2026-01-10',
        category: 'packaging',
        lines: [
          { name: '緩衝材', unit_price: 300, quantity: 1 },
          { name: 'OPP袋', unit_price: 100, quantity: 2, category: 'supplies' },
        ],
      })
      const expense = db.listExpenses('2026-01').find(e => e.id === id)!
      expect(expense.amount).toBe(500) // 300+200の合計
      expect(expense.category).toBe('packaging') // 最初の明細の項目
      expect(expense.lines).toHaveLength(2)
      expect(expense.lines[0]).toMatchObject(
        { name: '緩衝材', unit_price: 300, quantity: 1, amount: 300, category: 'packaging' },
      )
      expect(expense.lines[1]).toMatchObject(
        { name: 'OPP袋', unit_price: 100, quantity: 2, amount: 200, category: 'supplies' },
      )

      // 明細が無い経費はinput.amount/categoryのまま
      const id2 = db.createExpense({ occurred_at: '2026-01-15', category: 'other', amount: 700 })
      const expense2 = db.listExpenses('2026-01').find(e => e.id === id2)!
      expect(expense2.amount).toBe(700)
      expect(expense2.category).toBe('other')
      expect(expense2.lines).toHaveLength(0)
    })

    it('createExpense：明細の金額は単価×数量で計算される（数量省略は1）', () => {
      const id = db.createExpense({
        occurred_at: '2026-01-20',
        category: 'packaging',
        lines: [
          { name: '袋', unit_price: 300, quantity: 4 },
          { name: '箱', unit_price: 150 },
        ],
      })
      const expense = db.listExpenses('2026-01').find(e => e.id === id)!
      expect(expense.lines[0]).toMatchObject({ name: '袋', unit_price: 300, quantity: 4, amount: 1200 })
      expect(expense.lines[1]).toMatchObject({ name: '箱', unit_price: 150, quantity: 1, amount: 150 })
      expect(expense.amount).toBe(1350) // 1200 + 150

      // updateで数量を変えると再計算される
      db.updateExpense(id, {
        occurred_at: '2026-01-20',
        category: 'packaging',
        lines: [
          { name: '袋', unit_price: 300, quantity: 2 },
          { name: '箱', unit_price: 150 },
        ],
      })
      const updated = db.listExpenses('2026-01').find(e => e.id === id)!
      expect(updated.lines[0]).toMatchObject({ name: '袋', unit_price: 300, quantity: 2, amount: 600 })
      expect(updated.amount).toBe(750) // 600 + 150
    })

    it('計上月：省略時はoccurred_atの月。指定すればそちらで集計される（listExpenses(month)）', () => {
      // 12月末に買ったが、経理上は翌1月扱いにしたい
      const id = db.createExpense({
        occurred_at: '2025-12-30', month: '2026-01', category: 'supplies', amount: 400,
      })
      expect(db.listExpenses('2025-12')).toHaveLength(0)
      const jan = db.listExpenses('2026-01')
      expect(jan.find(e => e.id === id)).toBeDefined()
      expect(jan.find(e => e.id === id)!.month).toBe('2026-01')
      expect(jan.find(e => e.id === id)!.occurred_at).toBe('2025-12-30')

      // 省略時はoccurred_atの月
      const id2 = db.createExpense({ occurred_at: '2026-02-05', category: 'other', amount: 100 })
      expect(db.listExpenses('2026-02').find(e => e.id === id2)!.month).toBe('2026-02')

      // month省略で全部
      expect(db.listExpenses().map(e => e.id)).toEqual(expect.arrayContaining([id, id2]))
    })

    it('updateExpense：明細を丸ごと入れ替える', () => {
      const id = db.createExpense({
        occurred_at: '2026-03-01', category: 'packaging',
        lines: [{ name: '箱', unit_price: 500 }],
      })
      db.updateExpense(id, {
        occurred_at: '2026-03-01', category: 'shipping',
        lines: [{ name: '切手', unit_price: 100 }, { name: '梱包テープ', unit_price: 200 }],
      })
      const updated = db.listExpenses('2026-03').find(e => e.id === id)!
      expect(updated.amount).toBe(300)
      expect(updated.category).toBe('shipping')
      expect(updated.lines.map(l => l.name)).toEqual(['切手', '梱包テープ'])
    })

    it('createExpense：不正な費用区分・金額未指定はthrow', () => {
      expect(() => db.createExpense(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { occurred_at: '2026-01-01', category: 'invalid' as any, amount: 100 },
      )).toThrow()
      // 明細も無くamountも無い
      expect(() => db.createExpense({ occurred_at: '2026-01-01', category: 'other' })).toThrow()
    })

    it('createExpense：明細の単価が負・数量が0以下はthrow', () => {
      expect(() => db.createExpense({
        occurred_at: '2026-01-01', category: 'packaging',
        lines: [{ name: '袋', unit_price: -1 }],
      })).toThrow()
      expect(() => db.createExpense({
        occurred_at: '2026-01-01', category: 'packaging',
        lines: [{ name: '袋', unit_price: 100, quantity: 0 }],
      })).toThrow()
    })

    it('shop_alias：登録番号→店名を学習し、次回の読み取りで使える（learnShopAlias / lookupShopAlias）', () => {
      expect(db.lookupShopAlias('T2290801007056')).toBeNull()

      db.learnShopAlias('T2290801007056', 'セブンイレブン 小倉貫店')
      expect(db.lookupShopAlias('T2290801007056')).toBe('セブンイレブン 小倉貫店')

      // 同じ番号で別の店名を学習すると上書きされ、hits が増える
      db.learnShopAlias('T2290801007056', 'セブンイレブン 小倉貫店２号店')
      expect(db.lookupShopAlias('T2290801007056')).toBe('セブンイレブン 小倉貫店２号店')
      const row = db.getDb().prepare(
        `SELECT hits FROM shop_alias WHERE key = 'reg:T2290801007056'`,
      ).get() as { hits: number }
      expect(row.hits).toBe(2)

      // 空文字は何もしない
      db.learnShopAlias('T9999999999999', '   ')
      expect(db.lookupShopAlias('T9999999999999')).toBeNull()
    })

    it('createExpense：receipt_registration_no と shop を渡すと店名を学習し、lookupShopAlias で返る', () => {
      db.createExpense({
        occurred_at: '2026-04-01',
        category: 'supplies',
        amount: 300,
        shop: 'セリア 小倉貫店',
        receipt_registration_no: 'T4200001013662',
      })
      expect(db.lookupShopAlias('T4200001013662')).toBe('セリア 小倉貫店')
    })

    it('createExpense：receipt_registration_noを渡すとexpense.registration_noに保存され、listExpensesで返る', () => {
      const id = db.createExpense({
        occurred_at: '2026-04-01',
        category: 'supplies',
        amount: 300,
        shop: 'セリア 小倉貫店',
        receipt_registration_no: 'T4200001013662',
      })
      expect(db.listExpenses('2026-04').find(e => e.id === id)!.registration_no).toBe('T4200001013662')
    })

    it('createExpense：receipt_registration_noが空文字ならnullで保存される', () => {
      const id = db.createExpense({
        occurred_at: '2026-04-01', category: 'supplies', amount: 300, receipt_registration_no: '',
      })
      expect(db.listExpenses('2026-04').find(e => e.id === id)!.registration_no).toBeNull()
    })

    it('updateExpense：receipt_registration_noを省略すると今の値を消さない。nullを渡すと消える', () => {
      const id = db.createExpense({
        occurred_at: '2026-04-01', category: 'supplies', amount: 300, receipt_registration_no: 'T4200001013662',
      })

      // 省略：値は消えない
      db.updateExpense(id, { occurred_at: '2026-04-02', category: 'supplies', amount: 500 })
      expect(db.listExpenses('2026-04').find(e => e.id === id)!.registration_no).toBe('T4200001013662')

      // null明示：消える
      db.updateExpense(id, {
        occurred_at: '2026-04-02', category: 'supplies', amount: 500, receipt_registration_no: null,
      })
      expect(db.listExpenses('2026-04').find(e => e.id === id)!.registration_no).toBeNull()

      // 別の番号を渡すと差し替わる
      db.updateExpense(id, {
        occurred_at: '2026-04-02', category: 'supplies', amount: 500, receipt_registration_no: 'T9999999999999',
      })
      expect(db.listExpenses('2026-04').find(e => e.id === id)!.registration_no).toBe('T9999999999999')
    })

    it('振込手数料の自動計上は撤去：販売を作ってもexpenseは増えず、expense_auto_monthテーブルも存在しない', () => {
      db.createSale({ title: '経費テスト', sold_at: '2026-06-10', price: 2000 })
      expect(db.listExpenses('2026-06')).toHaveLength(0)
      expect(db.listMonthly().find(m => m.month === '2026-06' && m.kind === 'resale')!.expense_total).toBe(0)

      const tableExists = db.getDb().prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'expense_auto_month'`,
      ).get()
      expect(tableExists).toBeUndefined()
    })
  })

  describe('searchAll：横断検索', () => {
    it('空文字（空白のみ含む）は[]を返す', () => {
      expect(db.searchAll('')).toEqual([])
      expect(db.searchAll('   ')).toEqual([])
    })

    it('型番で在庫・出品・販売・仕入のすべてにヒットする', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        order_no: 'PO-Z200',
        lines: [{ name: 'クリームわん【Z200-1】', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      db.upsertListings([
        { mercariItemId: 'SZ200', title: 'クリームわん【Z200-1】', price: 2500, suspended: false, thumbUrl: null },
      ])

      // 手入力の私物販売（型番が一致していても私物は自動紐付けの対象外）。
      // 送料未入力のままだと status_label は「送料未入力」が優先されるので確定させておく
      const personalSaleId = db.createSale({
        title: 'クリームわん【Z200-1】', sold_at: '2026-01-10', price: 3000, kind: 'personal',
      })
      db.updateSale(personalSaleId, { shipping_fee: 0 })

      const hits = db.searchAll('Z200-1')
      expect(hits.map(h => h.kind).sort()).toEqual(['inventory', 'listing', 'purchase', 'sale'])

      const inv = hits.find(h => h.kind === 'inventory')!
      expect(inv.id).toBe(item.id)
      expect(inv.model_code).toBe('Z200-1')
      expect(inv.status_label).toBe('未出品')
      expect(inv.amount).toBe(item.landed_cost)
      expect(inv.date).toBe(item.acquired_at)

      const lst = hits.find(h => h.kind === 'listing')!
      expect(lst.id).toBe('SZ200')
      expect(lst.status_label).toBe('出品中')
      expect(lst.amount).toBe(2500)

      const sale = hits.find(h => h.kind === 'sale')!
      expect(sale.status_label).toBe('私物')
      expect(sale.amount).toBe(3000)

      const purchase = hits.find(h => h.kind === 'purchase')!
      expect(purchase.status_label).toBe('未着')
      expect(purchase.amount).toBe(1000)
    })

    it('タグ名（直接・派生）でヒットする', () => {
      const tag = db.createTag('限定品')
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: 'タグ検索対象', unit_price: 1000, quantity: 1 }],
      })
      const purchaseId = db.listPurchases()[0].id
      db.setPurchaseTags(purchaseId, [tag])

      // 仕入のタグは在庫・販売にも派生する
      const item = db.listInventory('in_stock')[0]
      const saleId = db.createSale({ title: 'タグ検索対象の販売', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(saleId, [item.id])

      const hits = db.searchAll('限定品')
      expect(hits.map(h => h.kind).sort()).toEqual(['inventory', 'purchase', 'sale'])
    })

    it('買い手（buyer）でヒットする', () => {
      const saleId = db.createSale({ title: '買い手検索対象', sold_at: '2026-01-01', price: 1000 })
      db.getDb().prepare(`UPDATE sale SET buyer = ? WHERE id = ?`).run('やまだたろう', saleId)

      const hits = db.searchAll('やまだたろう')
      expect(hits).toHaveLength(1)
      expect(hits[0].kind).toBe('sale')
      expect(hits[0].id).toBe(saleId)
    })

    it('注文番号・メモでヒットする（仕入）', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        order_no: 'ORDER-777',
        note: '特別な注文',
        lines: [{ name: 'メモ検索対象', unit_price: 1000, quantity: 1 }],
      })
      // order_noは在庫（inventory_view経由）・仕入の両方の検索対象なので両方にヒットする
      const orderHits = db.searchAll('ORDER-777')
      expect(orderHits.map(h => h.kind).sort()).toEqual(['inventory', 'purchase'])

      // noteは仕入自身のメモ（在庫のnoteとは別）なので仕入だけにヒットする
      expect(db.searchAll('特別な注文')).toHaveLength(1)
      expect(db.searchAll('特別な注文')[0].kind).toBe('purchase')
    })

    it('空白区切りAND：全部の語を満たすものだけヒットする', () => {
      db.createSale({ title: 'AAA商品', sold_at: '2026-01-01', price: 1000, note: 'BBBメモ' })
      db.createSale({ title: 'AAA商品2', sold_at: '2026-01-02', price: 1000 })

      expect(db.searchAll('AAA BBB')).toHaveLength(1)
      expect(db.searchAll('AAA')).toHaveLength(2)
    })

    it('全角英数はNFKC正規化で半角と同一視する', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{
          name: 'ぜんかく検索テスト', unit_price: 1000, quantity: 1,
          model_code: 'Z300', series_code: 'Z300',
        }],
      })

      const hits = db.searchAll('Ｚ３００')
      expect(hits.some(h => h.model_code === 'Z300')).toBe(true)
    })

    it('limit：種類ごとの上限はceil(limit/4)', () => {
      for (let i = 0; i < 10; i++) {
        db.createSale({
          title: `件数テスト${i}`,
          sold_at: `2026-01-${String(i + 1).padStart(2, '0')}`,
          price: 1000,
        })
      }
      const hits = db.searchAll('件数テスト', 8) // perKind = ceil(8/4) = 2
      expect(hits.filter(h => h.kind === 'sale')).toHaveLength(2)
    })

    it('sale の status_label は 送料未入力 → 未紐付け（転売のみ） → 私物 → 完了 の優先順', () => {
      const s1 = db.createSale({ title: '送料未入力テスト', sold_at: '2026-01-01', price: 1000 })
      expect(db.searchAll('送料未入力テスト')[0].status_label).toBe('送料未入力')

      db.updateSale(s1, { shipping_fee: 200 })
      expect(db.searchAll('送料未入力テスト')[0].status_label).toBe('未紐付け')

      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '紐付け用在庫', unit_price: 500, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.linkInventory(s1, [item.id])
      expect(db.searchAll('送料未入力テスト')[0].status_label).toBe('完了')

      const s2 = db.createSale({ title: '私物テスト検索', sold_at: '2026-01-02', price: 1000, kind: 'personal' })
      db.updateSale(s2, { shipping_fee: 100 })
      expect(db.searchAll('私物テスト検索')[0].status_label).toBe('私物')
    })

    it('inventory の status_label：出品中/未出品/廃棄/自家消費/販売済/分割済', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [
          { name: 'ラベル在庫A', unit_price: 1000, quantity: 1 },
          { name: 'ラベル在庫B', unit_price: 1000, quantity: 1 },
          { name: 'ラベル在庫C', unit_price: 1000, quantity: 1 },
          { name: 'ラベル在庫D', unit_price: 1000, quantity: 1 },
          { name: 'ラベル在庫E', unit_price: 1000, quantity: 1 },
          { name: 'ラベル在庫F', unit_price: 1000, quantity: 1 },
        ],
      })
      const byName = (name: string) => db.listInventory('in_stock').find(i => i.name === name)!
      const a = byName('ラベル在庫A')
      const c = byName('ラベル在庫C')
      const d = byName('ラベル在庫D')
      const e = byName('ラベル在庫E')
      const f = byName('ラベル在庫F')

      db.upsertListings([
        { mercariItemId: 'LBL1', title: 'ラベル在庫A', price: 2000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LBL1', [a.id])
      db.disposeInventory(c.id, '壊れた')
      db.disposeInventory(d.id, '自分用', 'personal_use')
      const saleId = db.createSale({ title: 'ラベル販売済み', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(saleId, [e.id])
      db.splitInventory(f.id, 2)

      expect(db.searchAll('ラベル在庫A')[0].status_label).toBe('出品中')
      expect(db.searchAll('ラベル在庫B')[0].status_label).toBe('未出品')
      expect(db.searchAll('ラベル在庫C')[0].status_label).toBe('廃棄')
      expect(db.searchAll('ラベル在庫D')[0].status_label).toBe('自家消費')
      expect(db.searchAll('ラベル在庫E')[0].status_label).toBe('販売済')
      // 分割で生まれた子は親と同名（in_stock）で出るため、親自身のidで引く
      expect(db.searchAll('ラベル在庫F').find(h => h.id === f.id)!.status_label).toBe('分割済')
    })

    it('listing の status_label：出品中/出品停止中/売れた/取り下げ', () => {
      db.upsertListings([
        { mercariItemId: 'LBLA', title: 'リストA', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LBLB', title: 'リストB', price: 1000, suspended: true, thumbUrl: null },
        { mercariItemId: 'LBLC', title: 'リストC', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'LBLD', title: 'リストD', price: 1000, suspended: false, thumbUrl: null },
      ])
      db.insertCollected([{ mercariItemId: 'LBLC', title: 'リストC', price: 1000, soldAt: '2026-01-01' }])
      db.endListing('LBLD')

      expect(db.searchAll('リストA')[0].status_label).toBe('出品中')
      expect(db.searchAll('リストB')[0].status_label).toBe('出品停止中')
      expect(db.searchAll('リストC').find(h => h.kind === 'listing')!.status_label).toBe('売れた')
      expect(db.searchAll('リストD')[0].status_label).toBe('取り下げ')
    })

    it('purchase の status_label：下書き/未着/配送中/到着済', () => {
      db.createPurchaseDraft({
        import_key: 'IMP-DRAFT',
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '下書き商品テスト', quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '未着商品テスト', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        fulfillment: 'shipped',
        lines: [{ name: '配送中商品テスト', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        fulfillment: 'delivered',
        lines: [{ name: '到着済商品テスト', unit_price: 1000, quantity: 1 }],
      })

      // 確定済みの仕入は在庫（同名）も一緒にヒットするため、purchase種別だけ見る
      const purchaseHit = (title: string) =>
        db.searchAll(title).find(h => h.kind === 'purchase')!

      expect(db.searchAll('下書き商品テスト')[0].status_label).toBe('下書き')
      expect(purchaseHit('未着商品テスト').status_label).toBe('未着')
      expect(purchaseHit('配送中商品テスト').status_label).toBe('配送中')
      expect(purchaseHit('到着済商品テスト').status_label).toBe('到着済')
    })
  })

  describe('getMonthDetail：価格0の月でも経費配賦は数量按分にフォールバックする', () => {
    it('販売価格が全て0でも、経費は数量按分で全額配賦される（合計が一致する）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
        lines: [{ name: '無料配布品A', unit_price: 0, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
        lines: [{ name: '無料配布品B', unit_price: 0, quantity: 1 }],
      })
      const [itemA, itemB] = db.listInventory('in_stock')

      const saleA = createCompletedSale({ title: '無料配布品A', sold_at: '2026-04-10', price: 0 })
      db.linkInventory(saleA, [itemA.id])
      const saleB = createCompletedSale({ title: '無料配布品B', sold_at: '2026-04-12', price: 0 })
      db.linkInventory(saleB, [itemB.id])

      db.createExpense({ occurred_at: '2026-04-05', category: 'packaging', amount: 101 })

      const detail = db.getMonthDetail('2026-04')
      expect(detail.totals.expense_total).toBe(101)
      const sum = detail.sales.reduce((s, r) => s + r.allocated_expense, 0)
      // 金額按分（価格の比）だと重みの合計が0円になり、以前は誰にも配賦されず
      // Σallocated_expense が経費合計と一致しなくなっていた。数量按分にフォールバックして一致させる
      expect(sum).toBe(101)
    })
  })

  describe('getMonthDetail：expense_by_categoryは明細ごとの項目で集計する', () => {
    it('複数項目にまたがるレシートは明細ごとのcategoryに配分される（先頭項目にまとめない）。明細の無い経費は親の項目で集計する', () => {
      db.createExpense({
        occurred_at: '2026-05-01', category: 'packaging',
        lines: [
          { name: '緩衝材', unit_price: 300, quantity: 1, category: 'packaging' },
          { name: 'OPP袋', unit_price: 100, quantity: 2, category: 'supplies' },
        ],
      })
      db.createExpense({ occurred_at: '2026-05-02', category: 'shipping', amount: 500 })

      const detail = db.getMonthDetail('2026-05')
      const byCat = Object.fromEntries(detail.expense_by_category.map(c => [c.category, c.amount]))
      expect(byCat.packaging).toBe(300)
      expect(byCat.supplies).toBe(200)
      expect(byCat.shipping).toBe(500)
    })
  })

  describe('自動紐付け（在庫コード名指し）は他の出品に引き当て済みの在庫を横取りしない', () => {
    it('タイトルの在庫コードが一致しても、その在庫が別の出品に引き当て済みなら候補止まり（listing_lineは消えない）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫コード商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      db.upsertListings([
        { mercariItemId: 'LCode1', title: `在庫コード商品【${item.item_code}】`, price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('LCode1', [item.id])

      const saleId = db.createSale({ title: `【${item.item_code}】在庫コード商品`, sold_at: '2026-01-10', price: 3000 })
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(1) // 奪わず候補止まり
      expect(sale.item_count).toBe(0)

      // 出品への引き当ては消えずそのまま残る
      const listing = db.listListings().find(l => l.mercari_item_id === 'LCode1')!
      expect(listing.items.map(i => i.id)).toEqual([item.id])
    })
  })

  describe('getAutoLinkBlockers：在庫はあるのに出品に取ってあるせいで自動紐付けから外れているのを見せる', () => {
    it('実データの再現：Yahooの販売がsuspendedのメルカリ出品に握られた在庫を見つける', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A040】もこ山 スクイーズ 新品未開封', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      expect(item.model_code).toBe('A040')

      db.upsertListings([
        { mercariItemId: 'm15691073401', title: '【A040】もこ山 スクイーズ 新品未開封', price: 3000, suspended: true, thumbUrl: null },
      ])
      db.reserveInventory('m15691073401', [item.id])

      const saleId = db.createSale({
        title: '… もこ山 スクイーズ 新品未開封【A040】', sold_at: '2026-01-10', price: 5750, channel: 'yahoo',
      })
      const sale = db.listSales().find(s => s.id === saleId)!
      // FIFOでは0点（在庫はあるのに「型番はあるが在庫が無い」と嘘をついていた）
      expect(sale.unmatched).toBe(1)

      const blockers = db.getAutoLinkBlockers(saleId)
      expect(blockers).toHaveLength(1)
      expect(blockers[0]).toMatchObject({
        inventory_item_id: item.id,
        item_code: item.item_code,
        model_code: 'A040',
        name: item.name, // product_name が無いので仕入明細名にフォールバック
        landed_cost: item.landed_cost,
        listing_id: 'm15691073401',
        listing_channel: 'mercari', // 販売はyahooだが、握っているのはmercariの出品
        listing_status: 'suspended',
        listing_title: '【A040】もこ山 スクイーズ 新品未開封',
      })
    })

    it('setProductName で表示名を付けていれば、在庫の明細名ではなくそちらを返す', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A049】もこ山 スクイーズ 旧パッケージ', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.setProductName('A049', 'もこ山 スクイーズ（表示名）')

      db.upsertListings([
        { mercariItemId: 'm-name-1', title: '【A049】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('m-name-1', [item.id])

      const saleId = db.createSale({ title: '商品【A049】', sold_at: '2026-01-10', price: 3000 })
      const blockers = db.getAutoLinkBlockers(saleId)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].name).toBe('もこ山 スクイーズ（表示名）')
    })

    it('activeな出品に握られている場合も同じく返る', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A041】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      db.upsertListings([
        { mercariItemId: 'm-active-1', title: '【A041】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('m-active-1', [item.id])

      const saleId = db.createSale({ title: '商品【A041】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
      const blockers = db.getAutoLinkBlockers(saleId)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].listing_status).toBe('active')
      expect(blockers[0].listing_id).toBe('m-active-1')
    })

    it('sold/endedの出品に引き当てられていた在庫は返らない（FIFOが除外しないので理由ではない）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A042】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      db.upsertListings([
        { mercariItemId: 'm-sold-1', title: '【A042】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('m-sold-1', [item.id])
      // 通常はtakeOverListingがlisting_lineを先に消してからsoldにする（trg_listing_line_guardは
      // INSERTだけを見ているのでUPDATEは通る）。万一listing_lineが残ったままstatusだけ変わっても、
      // blockersはそれを理由にしないことを確かめる
      db.getDb().prepare(`UPDATE listing SET status = 'sold' WHERE mercari_item_id = ?`).run('m-sold-1')

      // autoLinkSaleを経由せず、blockersのSQL条件だけを検証する（未紐付けのsaleを直接作る）
      const saleId = 'sale-sold-test'
      db.getDb().prepare(
        `INSERT INTO sale (id, title, sold_at, price, kind, model_codes) VALUES (?, ?, ?, ?, 'resale', ?)`,
      ).run(saleId, '商品【A042】', '2026-01-10', 3000, JSON.stringify(['A042']))

      expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('FIFOが選べる在庫がある販売では空配列になる（理由が別なので）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A043】商品', unit_price: 1000, quantity: 1 }],
      })
      const saleId = db.createSale({ title: '商品【A043】', sold_at: '2026-01-10', price: 3000 })
      const sale = db.listSales().find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(0) // 通常どおり自動確定できている

      expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('型番が0個のときは空配列', () => {
      const saleId = db.createSale({ title: '型番なしの商品', sold_at: '2026-01-10', price: 1000 })
      expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('型番が2個以上のときは空配列（A044は出品に握られているが対象外）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A044】商品X', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'm-multi-1', title: '【A044】商品X', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('m-multi-1', [item.id])

      const saleId = db.createSale({ title: '【A044】と【A045】のセット', sold_at: '2026-01-10', price: 2000 })
      expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('私物のときは空配列', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A046】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]
      db.upsertListings([
        { mercariItemId: 'm-personal-1', title: '【A046】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('m-personal-1', [item.id])

      const saleId = db.createSale({ title: '【A046】商品', sold_at: '2026-01-10', price: 1000, kind: 'personal' })
      expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('既に紐付き済みのときは空配列', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A047】商品', unit_price: 1000, quantity: 1 }],
      })
      // 出品には握らせない → FIFOで即自動確定する
      const saleId = db.createSale({ title: '【A047】商品', sold_at: '2026-01-10', price: 1000 })
      expect(db.listSales().find(s => s.id === saleId)!.unmatched).toBe(0)
      expect(db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('除外条件が対になっている：同じ在庫がFIFOで選べないときだけblockersが非空になる', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A048】商品1', unit_price: 1000, quantity: 1 }],
      })
      const item1 = db.listInventory('in_stock')[0]

      // 1. まだどこにも引き当てていない → FIFOで選べる（autoLinkSaleが成功）→ blockersは空
      const saleOk = db.createSale({ title: '商品1【A048】', sold_at: '2026-01-10', price: 3000 })
      expect(db.listSales().find(s => s.id === saleOk)!.unmatched).toBe(0)
      expect(db.getAutoLinkBlockers(saleOk)).toEqual([])

      // 2. 別の在庫を出品へ引き当ててからFIFOを試す → 選べない → blockersが非空（同じ在庫を指す）
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: '【A048】商品2', unit_price: 1000, quantity: 1 }],
      })
      const item2 = db.listInventory('in_stock').find(i => i.id !== item1.id)!
      db.upsertListings([
        { mercariItemId: 'm-pair-1', title: '【A048】商品2', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.reserveInventory('m-pair-1', [item2.id])

      const saleBlocked = db.createSale({ title: '商品2【A048】', sold_at: '2026-01-11', price: 3000 })
      const saleBlockedRow = db.listSales().find(s => s.id === saleBlocked)!
      expect(saleBlockedRow.unmatched).toBe(1) // FIFOで0点
      const blockers = db.getAutoLinkBlockers(saleBlocked)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].inventory_item_id).toBe(item2.id)
    })
  })

  describe('nextItemCode：カウンタが既存コードより後ろにずれていても衝突しない', () => {
    it('開始番号は max(カウンタ, 既存コードの最大番号) から採番する', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品A', unit_price: 100, quantity: 1 }],
      })
      const first = db.listInventory('in_stock')[0]
      expect(first.item_code).toBe('S-0001')

      // カウンタが既存コードより後ろにずれた状態を再現する（v15の一括採番の再実行・手動編集など）
      db.getDb().prepare(`UPDATE setting SET value = '0' WHERE key = 'item_code_seq'`).run()

      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: '商品B', unit_price: 100, quantity: 1 }],
      })
      const codes = db.listInventory('in_stock').map(i => i.item_code)
      expect(new Set(codes).size).toBe(codes.length) // 重複しない
      expect(codes).toContain('S-0002')
    })
  })

  describe('deleteSale：取り込んだ販売を削除すると除外記録（sale_exclusion）が残る', () => {
    it('source=collectorで削除するとlistSaleExclusionsに出て、removeSaleExclusionで解除できる', () => {
      const [inserted] = db.insertCollected([
        { mercariItemId: 'del-1', title: '削除される商品', price: 1000, soldAt: '2026-01-01' },
      ])
      db.deleteSale(inserted.id)

      expect(db.isMercariItemExcluded('del-1')).toBe(true)
      const list = db.listSaleExclusions()
      expect(list.find(e => e.mercari_item_id === 'del-1')).toMatchObject({ title: '削除される商品' })

      db.removeSaleExclusion('del-1')
      expect(db.isMercariItemExcluded('del-1')).toBe(false)
      expect(db.listSaleExclusions().find(e => e.mercari_item_id === 'del-1')).toBeUndefined()
    })

    it('手入力（manual）の販売を削除しても除外記録は残らない', () => {
      const saleId = db.createSale({ title: '手入力の販売', sold_at: '2026-01-01', price: 1000 })
      db.deleteSale(saleId)
      expect(db.listSaleExclusions()).toHaveLength(0)
    })

    it('resetDataでsale_exclusionも消える', () => {
      const [inserted] = db.insertCollected([
        { mercariItemId: 'del-2', title: '削除される商品2', price: 1000, soldAt: '2026-01-01' },
      ])
      db.deleteSale(inserted.id)
      expect(db.listSaleExclusions()).toHaveLength(1)

      db.resetData()
      expect(db.listSaleExclusions()).toHaveLength(0)
    })
  })

  describe('mellojoy_excluded_order：メロジョイの注文取り込みの除外記録', () => {
    it('markで記録するとisがtrueになり、keywords_hashが変われば再評価されfalseに戻る', () => {
      expect(db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashA')).toBe(false)

      db.markMellojoyOrderExcluded(shopId, 'order-1', 'hashA')
      expect(db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashA')).toBe(true)

      // キーワードが変わってhashが変わると再評価する（除外を引き継がない）
      expect(db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashB')).toBe(false)
    })
  })

  describe('estimateSaleProfit：紐付けパネルの粗利見積もり（画面で再計算しないための共通計算）', () => {
    it('手数料・送料・梱包材費・原価から粗利を計算する。無効化した発送方法でも送料は引く', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫X', unit_price: 1000, quantity: 1 }],
      })
      const item = db.listInventory('in_stock')[0]

      db.saveShippingMethod({ name: 'テスト送料', fee: 300 })
      const method = db.listShippingMethods().find(m => m.name === 'テスト送料')!
      db.deleteShippingMethod(method.id) // 無効化（is_active=0）にしても料金を引くことを確かめる

      const result = db.estimateSaleProfit({
        price: 2000, shipping_method_id: method.id, packaging_cost: 50, inventory_item_ids: [item.id],
      })
      // fee_rate_bp既定1000(10%) → fee = floor(2000*1000/10000) = 200
      expect(result.fee).toBe(200)
      expect(result.shipping_fee).toBe(300)
      expect(result.packaging_cost).toBe(50)
      expect(result.cost).toBe(1000)
      expect(result.gross_profit).toBe(2000 - 200 - 300 - 50 - 1000)
    })

    it('発送方法なし・在庫指定なしなら送料・原価は0', () => {
      const result = db.estimateSaleProfit({ price: 1000, shipping_method_id: null, inventory_item_ids: [] })
      expect(result).toEqual({ fee: 100, shipping_fee: 0, packaging_cost: 0, cost: 0, gross_profit: 900 })
    })

    it('channel省略はmercari(10%)、channel:yahooはYahoo率(5%、実測どおり切り捨て)で計算する', () => {
      const mercari = db.estimateSaleProfit({ price: 6400, shipping_method_id: null, inventory_item_ids: [] })
      expect(mercari.fee).toBe(640) // floor(6400*1000/10000)

      // 実測：6,400円→320円（5%どおり）
      const yahoo = db.estimateSaleProfit({
        price: 6400, shipping_method_id: null, inventory_item_ids: [], channel: 'yahoo',
      })
      expect(yahoo.fee).toBe(320)
    })

    it('feeに実額が渡ったら率を使わずそのまま返す（0も実額）', () => {
      const result = db.estimateSaleProfit({
        price: 6400, shipping_method_id: null, inventory_item_ids: [], channel: 'yahoo', fee: 320,
      })
      expect(result.fee).toBe(320)
      expect(result.gross_profit).toBe(6400 - 320)

      // 実測：5,200円→0円（キャンペーン）
      const zero = db.estimateSaleProfit({
        price: 5200, shipping_method_id: null, inventory_item_ids: [], channel: 'yahoo', fee: 0,
      })
      expect(zero.fee).toBe(0)
      expect(zero.gross_profit).toBe(5200)
    })

    it('feeに負の額を渡すとthrow', () => {
      expect(() => db.estimateSaleProfit({
        price: 1000, shipping_method_id: null, inventory_item_ids: [], fee: -1,
      })).toThrow('手数料は整数で入力してください')
    })
  })

  describe('入力値チェック（assertYen/assertQty）：画面からの入口で整数以外はエラーになる', () => {
    it('createPurchase：単価・送料が小数だとthrow', () => {
      expect(() => db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品', unit_price: 100.5, quantity: 1 }],
      })).toThrow('単価は整数で入力してください')

      expect(() => db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 99.9,
        lines: [{ name: '商品', unit_price: 100, quantity: 1 }],
      })).toThrow('送料は整数で入力してください')
    })

    it('createSale：価格が小数だとthrow', () => {
      expect(() => db.createSale({ title: '商品', sold_at: '2026-01-01', price: 100.5 }))
        .toThrow('価格は整数で入力してください')
    })

    it('updateSale：送料・梱包材費が小数だとthrow', () => {
      const saleId = db.createSale({ title: '商品', sold_at: '2026-01-01', price: 1000 })
      expect(() => db.updateSale(saleId, { shipping_fee: 100.5 }))
        .toThrow('送料は整数で入力してください')
      expect(() => db.updateSale(saleId, { packaging_cost: -1 }))
        .toThrow('梱包材費は整数で入力してください')
    })

    it('saveShippingMethod：料金が小数だとthrow', () => {
      expect(() => db.saveShippingMethod({ name: 'テスト', fee: 100.5 }))
        .toThrow('料金は整数で入力してください')
    })
  })

  describe('linkInventory / reserveInventory：takeFromSale（付け替え）', () => {
    it('takeFromSaleで売却済みの在庫を別の販売へ付け替える。元の販売は点数・原価が減り、新しい販売は1行だけ・原価が移る', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: '在庫A', unit_price: 1000, quantity: 1 },
          { name: '在庫B', unit_price: 500, quantity: 1 },
        ],
      })
      const [itemA, itemB] = db.listInventory('in_stock')

      const sale1 = db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      db.linkInventory(sale1, [itemA.id, itemB.id])
      expect(db.listSales().find(s => s.id === sale1)!.item_count).toBe(2)
      expect(db.listSales().find(s => s.id === sale1)!.cost).toBe(1500)

      const sale2 = db.createSale({ title: '販売2', sold_at: '2026-01-06', price: 2000 })
      db.linkInventory(sale2, [itemA.id], 'manual', { takeFromSale: true })

      const s1 = db.listSales().find(s => s.id === sale1)!
      expect(s1.item_count).toBe(1) // 元の販売から1点減る
      expect(s1.cost).toBe(500)

      const s2 = db.listSales().find(s => s.id === sale2)!
      expect(s2.item_count).toBe(1) // 在庫は新しい販売に1行だけ
      expect(s2.cost).toBe(1000)   // 合計原価が新しい販売に移る
      expect(db.listSaleLines(sale2).map(i => i.id)).toEqual([itemA.id])
    })

    it('takeFromSale無しで売却済みの在庫を紐付けようとすると例外（元の販売は変わらない）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 1 }],
      })
      const [itemA] = db.listInventory('in_stock')
      const sale1 = db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      db.linkInventory(sale1, [itemA.id])

      const sale2 = db.createSale({ title: '販売2', sold_at: '2026-01-06', price: 2000 })
      expect(() => db.linkInventory(sale2, [itemA.id])).toThrow('販売済み・廃棄済みの在庫は紐付けられません')
      expect(db.listSales().find(s => s.id === sale1)!.item_count).toBe(1)
      expect(db.listSales().find(s => s.id === sale2)!.item_count).toBe(0)
    })

    it('自分自身の販売に既に付いている在庫を渡しても無視される（例外にしない・二重にならない）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 1 }],
      })
      const [itemA] = db.listInventory('in_stock')
      const sale1 = db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      db.linkInventory(sale1, [itemA.id])

      expect(() => db.linkInventory(sale1, [itemA.id])).not.toThrow()
      expect(db.listSales().find(s => s.id === sale1)!.item_count).toBe(1)
    })

    it('reserveInventory：takeFromSaleで売却済みの在庫を出品へ付け替えられる。無しなら未販売の在庫だけというエラー', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 1 }],
      })
      const [itemA] = db.listInventory('in_stock')
      const sale1 = db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      db.linkInventory(sale1, [itemA.id])
      db.upsertListings([
        { mercariItemId: 'TFS-1', title: '出品', price: 3000, suspended: false, thumbUrl: null },
      ])

      expect(() => db.reserveInventory('TFS-1', [itemA.id])).toThrow('未販売の在庫だけ引き当てられます')

      db.reserveInventory('TFS-1', [itemA.id], { takeFromSale: true })
      expect(db.listListings().find(l => l.mercari_item_id === 'TFS-1')!.items.map(i => i.id))
        .toEqual([itemA.id])
      // 元の販売の紐付けは外れた（在庫が付け替わったので item_count が0）
      expect(db.listSales().find(s => s.id === sale1)!.item_count).toBe(0)
    })

    it('suggestInventory / suggestForListing：includeSoldで売却済み（sold_to付き）も候補に含む。自分の販売に付いているものは除く', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: '在庫A', unit_price: 1000, quantity: 1 },
          { name: '在庫B', unit_price: 1000, quantity: 1 },
        ],
      })
      const [itemA, itemB] = db.listInventory('in_stock')
      const sale1 = db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      db.linkInventory(sale1, [itemA.id])

      // 通常は売却済みは候補に出ない
      const sale2 = db.createSale({ title: '販売2', sold_at: '2026-01-06', price: 2000 })
      expect(db.suggestInventory(sale2).map(i => i.id)).not.toContain(itemA.id)

      // includeSoldで候補に出る。sold_toに元の販売が入る
      const withSold = db.suggestInventory(sale2, 20, { includeSold: true })
      const found = withSold.find(i => i.id === itemA.id)
      expect(found).toBeTruthy()
      expect(found!.sold_to).toEqual({ sale_id: sale1, title: '販売1', price: 3000, sold_at: '2026-01-05' })

      // 自分自身（sale1）から見れば、自分に付いている在庫は候補に出ない
      const fromSale1 = db.suggestInventory(sale1, 20, { includeSold: true })
      expect(fromSale1.map(i => i.id)).not.toContain(itemA.id)
      expect(fromSale1.map(i => i.id)).toContain(itemB.id)

      // suggestForListingも同様にincludeSoldで売却済みが候補に出る
      db.upsertListings([
        { mercariItemId: 'INCL-1', title: '出品', price: 3000, suspended: false, thumbUrl: null },
      ])
      expect(db.suggestForListing('INCL-1').map(i => i.id)).not.toContain(itemA.id)
      expect(db.suggestForListing('INCL-1', 20, { includeSold: true }).map(i => i.id)).toContain(itemA.id)
    })
  })

  describe('setSalePurchasedAt / salesNeedingPurchasedAt：取引画面の購入日時', () => {
    it('purchased_atを保存し、未完了ならsold_atの仮置きを購入日（日付部分）に直す', () => {
      const [inserted] = db.insertCollected([
        { mercariItemId: 'pa-1', title: '購入日時テスト', price: 1000, soldAt: '2026-08-01' },
      ])
      db.setSalePurchasedAt(inserted.id, '2026-07-30T21:15')

      const s = db.listSales().find(s => s.id === inserted.id)!
      expect(s.purchased_at).toBe('2026-07-30T21:15')
      expect(s.sold_at).toBe('2026-07-30') // 仮置き(2026-08-01)から購入日へ直る

      // 取引完了済みならsold_atは触らない
      db.updateCollectedActuals([{ mercariItemId: 'pa-1', soldAt: '2026-08-05', fee: 100 }])
      db.setSalePurchasedAt(inserted.id, '2026-07-29T10:00')
      expect(db.listSales().find(s => s.id === inserted.id)!.sold_at).toBe('2026-08-05')
    })

    it('purchased_atがnull（取れなかった）でもchecked扱いになり、salesNeedingPurchasedAtの対象から外れる', () => {
      const [inserted] = db.insertCollected([
        { mercariItemId: 'pa-2', title: '取れなかった商品', price: 1000, soldAt: '2026-08-01' },
      ])
      expect(db.salesNeedingPurchasedAt(10).map(r => r.mercari_item_id)).toEqual(['pa-2'])

      db.setSalePurchasedAt(inserted.id, null)
      expect(db.salesNeedingPurchasedAt(10)).toEqual([])
      expect(db.listSales().find(s => s.id === inserted.id)!.purchased_at).toBeNull()
    })
  })

  describe('salesNeedingThumb：サムネイルの差し替え判定', () => {
    it('(a)未保存は対象、(b)旧データ（thumb_srcが無い）はsrcだけ記録して対象外、(c)urlが変われば対象（クエリ違いは対象外）', () => {
      const [, s2, s3] = db.insertCollected([
        { mercariItemId: 'th-a', title: '未保存', price: 1000, soldAt: '2026-01-01' },
        { mercariItemId: 'th-b', title: '旧データ', price: 1000, soldAt: '2026-01-02' },
        { mercariItemId: 'th-c', title: '差し替え', price: 1000, soldAt: '2026-01-03' },
      ])
      // (b) 旧データ：thumb_fileはあるがthumb_srcが無い状態を再現
      db.getDb().prepare('UPDATE sale SET thumb_file = ? WHERE id = ?').run('th-b.jpg', s2.id)
      // (c) 差し替え対象：既存のsrcと違うURL
      db.setSaleThumb(s3.id, 'th-c-old.jpg', 'https://example.com/th-c-old.jpg')

      const targets = db.salesNeedingThumb([
        { mercariItemId: 'th-a', thumbUrl: 'https://example.com/th-a.jpg' },
        { mercariItemId: 'th-b', thumbUrl: 'https://example.com/th-b.jpg?w=200' },
        { mercariItemId: 'th-c', thumbUrl: 'https://example.com/th-c-new.jpg' },
        { mercariItemId: 'th-none', thumbUrl: null },
      ])

      // (a)が先、(c)が後
      expect(targets.map(t => t.mercariItemId)).toEqual(['th-a', 'th-c'])

      // (b)は対象にせず、srcだけ記録される
      const row = db.getDb().prepare('SELECT thumb_src FROM sale WHERE id = ?').get(s2.id) as { thumb_src: string | null }
      expect(row.thumb_src).toBe('https://example.com/th-b.jpg?w=200')

      // クエリは画像の更新時刻なので、クエリが変われば「変わった」（差し替え対象）
      const again = db.salesNeedingThumb([
        { mercariItemId: 'th-b', thumbUrl: 'https://example.com/th-b.jpg?w=999' },
      ])
      expect(again.map(t => t.mercariItemId)).toEqual(['th-b'])
      // 同じ URL なら対象にならない
      expect(db.salesNeedingThumb([
        { mercariItemId: 'th-b', thumbUrl: 'https://example.com/th-b.jpg?w=200' },
      ])).toEqual([])
    })

    it('listingsNeedingThumb：listingに対しても同じ判定規則で動く', () => {
      db.upsertListings([
        { mercariItemId: 'lth-a', title: '未保存', price: 1000, suspended: false, thumbUrl: null },
        { mercariItemId: 'lth-c', title: '差し替え', price: 1000, suspended: false, thumbUrl: null },
      ])
      db.setListingThumb('lth-c', 'lth-c-old.jpg', 'https://example.com/lth-c-old.jpg')

      const targets = db.listingsNeedingThumb([
        { mercariItemId: 'lth-a', thumbUrl: 'https://example.com/lth-a.jpg' },
        { mercariItemId: 'lth-c', thumbUrl: 'https://example.com/lth-c-new.jpg' },
      ])
      expect(targets.map(t => t.id)).toEqual(['lth-a', 'lth-c'])
    })
  })

  describe('attachInventoryTags：thumb_fileが無い未販売在庫は商品画像で埋める', () => {
    it('出品の画像があれば、未販売の在庫のthumb_urlに出る', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【P200】', unit_price: 1000, quantity: 1 }],
      })
      const [item] = db.listInventory('in_stock')
      expect(item.thumb_url).toBeNull()

      db.upsertListings([
        { mercariItemId: 'P200-L', title: 'クリームわん【P200】', price: 2000, suspended: false, thumbUrl: null },
      ])
      db.setListingThumb('P200-L', 'listing-p200.jpg', null)

      const after = db.listInventory('in_stock').find(i => i.id === item.id)!
      expect(after.thumb_url).toBe('soroban-thumb://listing-p200.jpg')
    })
  })

  describe('productImageFiles：商品画像の優先順位', () => {
    it('①人がセット ＞ ②最新の出品 ＞ ③最新の販売 の順で選ばれる。無ければMapに入らない', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: 'クリームわん【P100】', unit_price: 1000, quantity: 1 },
          { name: 'クリームわん【P101】', unit_price: 1000, quantity: 1 },
          { name: 'クリームわん【P102】', unit_price: 1000, quantity: 1 },
        ],
      })
      const [, item2] = db.listInventory('in_stock')

      // P102：画像が何も無い → Mapに入らない
      // P101：販売の画像だけ
      const sale = db.createSale({ title: 'クリームわん【P101】', sold_at: '2026-01-10', price: 2000 })
      db.linkInventory(sale, [item2.id])
      db.setSaleThumb(sale, 'sale-p101.jpg', null)

      // P100：出品の画像もあるが、人がセットした画像を優先
      db.upsertListings([
        { mercariItemId: 'PI-LISTING', title: 'クリームわん【P100】', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.setListingThumb('PI-LISTING', 'listing-p100.jpg', null)
      db.upsertProductImage('P100', 'product-p100-manual.jpg')

      const map = db.productImageFiles(['P100', 'P101', 'P102', 'P199'])
      expect(map.get('P100')).toEqual({ file: 'product-p100-manual.jpg', manual: true })
      expect(map.get('P101')).toEqual({ file: 'sale-p101.jpg', manual: false })
      expect(map.has('P102')).toBe(false)
      expect(map.has('P199')).toBe(false)
    })

    it('②仕入先の商品画像 は ①人がセット の次、③出品より優先。同じ型番で複数明細があれば注文日が新しい方を使う', () => {
      const firstId = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【P300】', unit_price: 1000, quantity: 1 }],
      })
      const firstLine = db.getPurchase(firstId).lines[0]
      db.setPurchaseLineImage(firstLine.id, 'purchase-p300-old.jpg')

      // 出品の画像もあるが、仕入先の商品画像を優先する
      db.upsertListings([
        { mercariItemId: 'PI-P300', title: 'クリームわん【P300】', price: 3000, suspended: false, thumbUrl: null },
      ])
      db.setListingThumb('PI-P300', 'listing-p300.jpg', null)

      expect(db.productImageFiles(['P300']).get('P300')).toEqual({ file: 'purchase-p300-old.jpg', manual: false })

      // 同じ型番の後の注文（注文日が新しい）に画像があれば、そちらに差し替わる
      const secondId = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-10', shipping_fee: 0,
        lines: [{ name: 'クリームわん【P300】', unit_price: 1000, quantity: 1 }],
      })
      const secondLine = db.getPurchase(secondId).lines[0]
      db.setPurchaseLineImage(secondLine.id, 'purchase-p300-new.jpg')

      expect(db.productImageFiles(['P300']).get('P300')).toEqual({ file: 'purchase-p300-new.jpg', manual: false })
    })
  })

  describe('商品単位の手動FIFO選択', () => {
    it('商品選択は自動引き当てと同じFIFO順。枝番違い・予約済み・販売済み・選択済みを除外し、プレビューでは保存しない', () => {
      const make = (date: string, code = 'A037') => {
        const id = db.createPurchase({ shop_account_id: shopId, ordered_at: date,
          lines: [{ name: `商品【${code}】`, unit_price: 1000, quantity: 1 }] })
        return db.getPurchase(id).lines[0].items[0].id
      }
      const newer = make('2026-04-04')
      const older = make('2026-04-03')
      const reserved = make('2026-04-01')
      const sold = make('2026-03-01')
      make('2026-02-01', 'A037-1')
      db.upsertListings([{ mercariItemId: 'fifo-reserved', title: '予約先', price: 3000, suspended: false, thumbUrl: null }])
      db.reserveInventory('fifo-reserved', [reserved])
      const saleId = db.createSale({ title: '販売済み', sold_at: '2026-04-05', price: 2000 })
      db.linkInventory(saleId, [sold])
      expect(db.suggestProductInventory('A037', 5)).toEqual([older, newer])
      expect(db.suggestProductInventory('A037', 2, [older])).toEqual([newer])
      expect(db.suggestProductInventory('A037', 2, [older, newer])).toEqual([])
      expect(db.listInventory('in_stock').find(i => i.id === older)?.listing).toBeNull()
      db.upsertListings([{ mercariItemId: 'fifo-auto', title: '商品【A037】×2', price: 4000, suspended: false, thumbUrl: null }])
      db.autoReserveListings()
      expect(db.listListings().find(l => l.mercari_item_id === 'fifo-auto')?.items.map(i => i.id).sort()).toEqual([older, newer].sort())
    })

    it('商品選択の不正な点数を拒否する', () => {
      for (const qty of [0, -1, 1.5, NaN, Infinity]) {
        expect(() => db.suggestProductInventory('A037', qty)).toThrow('点数は1以上の整数')
      }
      expect(() => db.suggestProductInventory('', 1)).toThrow('商品コードを指定')
    })

  })

  describe('仕入明細の画像（purchase_line.image_url / image_file）', () => {
    it('画像巡回は同じ口座・対象注文・キーワード一致の自動更新商品のみ', () => {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', import_key: 'mellojoy:#images',
        lines: [{ name: 'テスト【A001-2】青', unit_price: 1000, quantity: 1 }],
      })
      const keys = ['mellojoy:#images']
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, ['テスト'])).toEqual([{ id, import_key: keys[0] }])
      expect(db.purchaseDetailRevisitCandidates('other-shop', keys, [])).toEqual([])
      expect(db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#other'], [])).toEqual([])
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, ['不一致'])).toEqual([])
      db.upsertProductImage('A001-2', 'fixed.jpg')
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, [])).toEqual([])
      db.deleteProductImage('A001-2')
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, [])).toHaveLength(1)
    })

    it('image_checked_atで画像巡回の終わりを判定する（取り終えたら候補から外れ、失敗が残れば対象のまま）', () => {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', import_key: 'mellojoy:#checked',
        lines: [{ name: 'テスト【A002】', unit_price: 1000, quantity: 1, image_url: 'https://cdn.example/a002.jpg' }],
      })
      const keys = ['mellojoy:#checked']
      // (a) 未確認（image_checked_at が NULL）：候補に出る
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, [])).toHaveLength(1)

      db.setPurchaseImageChecked(id)
      const line = db.getPurchase(id).lines[0]
      // (c) 確認済みだが、URLはあるのにダウンロードが済んでいない（前回失敗）：候補のまま
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, [])).toHaveLength(1)

      db.setPurchaseLineImage(line.id, 'a002.jpg')
      // (b) 確認済み・全明細の画像を保存済み：候補から外れる＝巡回が終わる
      expect(db.purchaseDetailRevisitCandidates(shopId, keys, [])).toEqual([])
    })

    it('バリアントを取り違えず更新し、自動OFFの画像は固定、ONなら公式画像を優先する', () => {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01',
        lines: [
          { name: '商品 【A001-1】赤', unit_price: 1000, quantity: 1, image_url: 'https://cdn.example/red.jpg' },
          { name: '商品 【A001-2】青', unit_price: 1000, quantity: 1, image_url: 'https://cdn.example/blue.jpg' },
        ],
      })
      const [red, blue] = db.getPurchase(id).lines
      db.setPurchaseLineImage(red.id, 'red.jpg')
      db.setPurchaseLineImage(blue.id, 'blue.jpg')
      db.upsertProductImage('A001-2', 'fixed.jpg')
      expect(db.setPurchaseLineImageUrls(id, [{ name: blue.name, image_url: 'https://cdn.example/blue.jpg?v=2' }])).toBe(1)
      expect(db.purchaseLinesNeedingImage(id)).toEqual([{ id: blue.id, image_url: 'https://cdn.example/blue.jpg?v=2' }])
      expect(db.purchaseLinesNeedingImage(id, ['赤'])).toEqual([])
      db.setPurchaseLineImage(blue.id, 'blue-new.jpg')
      expect(db.productImageFiles(['A001-1', 'A001-2']).get('A001-1')?.file).toBe('red.jpg')
      expect(db.productImageFiles(['A001-2']).get('A001-2')).toEqual({ file: 'fixed.jpg', manual: true })
      db.deleteProductImage('A001-2')
      expect(db.productImageFiles(['A001-2']).get('A001-2')).toEqual({ file: 'blue-new.jpg', manual: false })
      expect(db.setPurchaseLineImageUrls(id, [{ name: blue.name, image_url: 'https://cdn.example/blue.jpg?v=2' }])).toBe(0)
      expect(db.purchaseLinesNeedingImage(id)).toEqual([])
    })

    it('createPurchase で image_url を保存し、在庫アイテムの image_url に同じサムネURLが出る（数量分すべて同じ）', () => {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
        lines: [{ name: '画像テスト', unit_price: 1000, quantity: 2, image_url: 'https://mellojoy.example/img/300.jpg' }],
      })
      const detail = db.getPurchase(id)
      expect(detail.lines[0].items).toHaveLength(2)
      // まだダウンロード前（image_file が無い）なので item.image_url は null
      expect(detail.lines[0].items[0].image_url).toBeNull()
      expect(detail.lines[0].items[1].image_url).toBeNull()

      const needing = db.purchaseLinesNeedingImage(id)
      expect(needing).toEqual([{ id: detail.lines[0].id, image_url: 'https://mellojoy.example/img/300.jpg' }])

      db.setPurchaseLineImage(detail.lines[0].id, 'purchase-300.jpg')
      const after = db.getPurchase(id)
      expect(after.lines[0].items[0].image_url).toBe('soroban-thumb://purchase-300.jpg')
      expect(after.lines[0].items[1].image_url).toBe('soroban-thumb://purchase-300.jpg')
      // ダウンロード済みなので needing から消える
      expect(db.purchaseLinesNeedingImage(id)).toEqual([])
    })

    it('image_url を省略すれば null（items の image_url も null、needing にも出ない）', () => {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-02', shipping_fee: 0,
        lines: [{ name: '画像なし', unit_price: 1000, quantity: 1 }],
      })
      const detail = db.getPurchase(id)
      expect(detail.lines[0].items[0].image_url).toBeNull()
      expect(db.purchaseLinesNeedingImage(id)).toEqual([])
    })

    it('setPurchaseLineImageUrls：名前で突き合わせて image_url を更新し、変わった行だけ image_file をリセットする', () => {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-03', shipping_fee: 0,
        lines: [
          { name: 'A商品', unit_price: 1000, quantity: 1, image_url: 'https://x/a-old.jpg' },
          { name: 'B商品', unit_price: 1000, quantity: 1 },
        ],
      })
      const before = db.getPurchase(id)
      db.setPurchaseLineImage(before.lines[0].id, 'a-old.jpg')

      // A商品：URLが変わった → image_file はリセットされ、取り直し対象になる
      // B商品：新しくURLが付いた → 同様に取り直し対象
      // 存在しない名前は無視
      const updated = db.setPurchaseLineImageUrls(id, [
        { name: 'A商品', image_url: 'https://x/a-new.jpg' },
        { name: 'B商品', image_url: 'https://x/b-new.jpg' },
        { name: 'C商品（無い）', image_url: 'https://x/c.jpg' },
      ])
      expect(updated).toBe(2)

      const needing = db.purchaseLinesNeedingImage(id)
      expect(needing.map(n => n.image_url).sort()).toEqual(['https://x/a-new.jpg', 'https://x/b-new.jpg'])

      // 同じURLをもう一度渡しても変化なし（0件）
      expect(db.setPurchaseLineImageUrls(id, [{ name: 'A商品', image_url: 'https://x/a-new.jpg' }])).toBe(0)
    })

    it('confirmPurchase：下書きを確定するときも image_url を保存する', () => {
      const draftId = db.createPurchaseDraft({
        import_key: 'mellojoy:#img-draft', shop_account_id: shopId, ordered_at: '2026-04-04',
        lines: [{ name: '下書き画像', quantity: 1 }],
      })
      db.confirmPurchase(draftId, {
        shop_account_id: shopId, ordered_at: '2026-04-04', shipping_fee: 0,
        lines: [{ name: '下書き画像', unit_price: 1000, quantity: 1, image_url: 'https://x/confirm.jpg' }],
      })
      expect(db.purchaseLinesNeedingImage(draftId)).toEqual([
        { id: db.getPurchase(draftId).lines[0].id, image_url: 'https://x/confirm.jpg' },
      ])
    })
  })

  describe('purchaseDetailRevisitCandidates：配送状況・追跡番号のためにも注文詳細を開き直す', () => {
    const daysAgo = (n: number): string =>
      todayLocal(new Date(Date.now() - n * 24 * 60 * 60 * 1000))

    // 画像は取り終えた状態（product_image を登録済み＝画像の理由では候補に出ない）にして、
    // 配送の理由だけを見る
    function makeImageDoneButUndelivered(name: string, importKey: string, orderedAt: string) {
      const id = db.createPurchase({
        shop_account_id: shopId, ordered_at: orderedAt, import_key: importKey,
        lines: [{ name, unit_price: 1000, quantity: 1 }],
      })
      return id
    }

    it('画像を取り終えていても、追跡番号が無く未到着なら候補に出る', () => {
      db.upsertProductImage('D001', 'fixed.jpg')
      const id = makeImageDoneButUndelivered('テスト【D001】', 'mellojoy:#deliv-1', daysAgo(1))
      expect(db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-1'], [])
        .map(c => c.id)).toEqual([id])
    })

    it('追跡番号が入ったら（未到着でも）その理由では候補に出ない', () => {
      db.upsertProductImage('D002', 'fixed.jpg')
      const id = makeImageDoneButUndelivered('テスト【D002】', 'mellojoy:#deliv-2', daysAgo(1))
      db.applyFulfillmentFromShop(id, {
        status: 'shipped', shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-DELIV-2',
      })
      expect(db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-2'], [])).toEqual([])
    })

    it('手で商品画像をセットした型番を含む注文でも、追跡番号が無く未到着なら候補に出る', () => {
      // 通常なら product_image が存在する型番は画像の理由から丸ごと外れるが、配送の理由は別
      db.upsertProductImage('D003', 'manual.jpg')
      const id = makeImageDoneButUndelivered('テスト【D003】', 'mellojoy:#deliv-3', daysAgo(1))
      expect(db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-3'], [])
        .map(c => c.id)).toEqual([id])
    })

    it('90日より古い注文は、追跡番号が無くても候補に出ない', () => {
      db.upsertProductImage('D004', 'fixed.jpg')
      makeImageDoneButUndelivered('テスト【D004】', 'mellojoy:#deliv-4', daysAgo(91))
      expect(db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-4'], [])).toEqual([])
    })

    it('90日の線はJSTの暦日で引く。UTCではまだ前日にあたる時刻（JST深夜0時台）に実行しても、' +
      'ちょうど90日前は候補に出て91日前は出ない', () => {
      // 「いま」を JST 2026-04-10 00:15（= UTC 2026-04-09 15:15）に固定する。
      // SQL 側が date('now') のまま（UTC基準）だと、この時間帯だけ90日の線が1日ずれていた
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.UTC(2026, 3, 9, 15, 15, 0)))
      try {
        db.upsertProductImage('D005', 'fixed.jpg')
        db.upsertProductImage('D006', 'fixed.jpg')
        const exactly90 = makeImageDoneButUndelivered('テスト【D005】', 'mellojoy:#deliv-5', daysAgo(90))
        makeImageDoneButUndelivered('テスト【D006】', 'mellojoy:#deliv-6', daysAgo(91))

        const ids = db.purchaseDetailRevisitCandidates(
          shopId, ['mellojoy:#deliv-5', 'mellojoy:#deliv-6'], [],
        ).map(c => c.id)
        expect(ids).toEqual([exactly90])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('listInventoryGroups：分割前の親（split）の絞り込み', () => {
    it('split は all にも other にも含めず、split フィルタでだけ見える', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-05-01', shipping_fee: 0,
        lines: [{ name: '分割元【P400】', unit_price: 3000, quantity: 1 }],
      })
      const [item] = db.listInventory('in_stock')
      db.splitInventory(item.id, 2)

      const all = views.listInventoryGroups('all')
      const p400All = all.find(g => g.model_code === 'P400')
      // all には子（in_stock）2点だけが残り、親（split）は入らない
      expect(p400All?.items.every(i => i.status !== 'split')).toBe(true)
      expect(p400All?.items).toHaveLength(2)

      const other = views.listInventoryGroups('other')
      expect(other.find(g => g.model_code === 'P400')).toBeUndefined()

      const splitOnly = views.listInventoryGroups('split')
      const p400Split = splitOnly.find(g => g.model_code === 'P400')
      expect(p400Split?.items).toHaveLength(1)
      expect(p400Split?.items[0].status).toBe('split')
      expect(p400Split?.items[0].id).toBe(item.id)
    })
  })

  describe('getInventoryOverview().total：記録の上での在庫の総数', () => {
    it('在庫を作ると増える。廃棄・自家消費にしても（記録は残るので）減らない', () => {
      expect(views.getInventoryOverview().total).toBe(0)

      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-06-01', shipping_fee: 0,
        lines: [{ name: '総数テスト', unit_price: 1000, quantity: 2 }],
      })
      expect(views.getInventoryOverview().total).toBe(2)

      const [item1] = db.listInventory('in_stock')
      db.disposeInventory(item1.id, '廃棄テスト', 'disposed')
      expect(views.getInventoryOverview().total).toBe(2)
    })
  })

  describe('getHealthChecks：データの健康診断（読むだけ。直しはしない）', () => {
    const daysAgo = (n: number): string =>
      todayLocal(new Date(Date.now() - n * 24 * 60 * 60 * 1000))

    it('きれいなDBでは空配列', () => {
      expect(db.getHealthChecks()).toEqual([])
    })

    it('alloc-mismatch：allocated_costをわざと壊すと検出され、正常な注文では出ない', () => {
      const purchaseId = db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 100,
        lines: [{ name: '正常な仕入', unit_price: 1000, quantity: 1 }],
      })
      expect(db.getHealthChecks().find(c => c.id === 'alloc-mismatch')).toBeUndefined()

      const line = db.getDb().prepare(
        'SELECT id FROM purchase_line WHERE purchase_id = ?',
      ).get(purchaseId) as { id: string }
      db.getDb().prepare('UPDATE purchase_line SET allocated_cost = ? WHERE id = ?').run(9999, line.id)

      const found = db.getHealthChecks().find(c => c.id === 'alloc-mismatch')
      expect(found?.count).toBe(1)
      expect(found?.level).toBe('warn')
    })

    it('zero-cost-link：原価0円の在庫を紐付けた転売の販売が1件になる', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '原価0円商品', unit_price: 0, quantity: 1 }],
      })
      const [item] = db.listInventory('in_stock')
      const saleId = db.createSale({ title: '原価0円商品', sold_at: todayLocal(), price: 1000 })
      db.linkInventory(saleId, [item.id])

      const found = db.getHealthChecks().find(c => c.id === 'zero-cost-link')
      expect(found?.count).toBe(1)
      expect(found?.goto).toEqual({ tab: 'sales', stage: 'all' })
    })

    it('shipping-old：送料未入力のまま30日たった販売が1件になる（29日は出ない）', () => {
      const oldSaleId = db.createSale({ title: '古い販売', sold_at: daysAgo(31), price: 1000 })
      const recentSaleId = db.createSale({ title: '最近の販売', sold_at: daysAgo(29), price: 1000 })
      expect(oldSaleId).toBeTruthy()
      expect(recentSaleId).toBeTruthy()

      const found = db.getHealthChecks().find(c => c.id === 'shipping-old')
      expect(found?.count).toBe(1)
      expect(found?.level).toBe('info')
    })

    it('unmatched-old：紐付けないまま30日たった転売の販売が1件になる（私物は数えない）', () => {
      db.createSale({ title: '未紐付け・古い', sold_at: daysAgo(35), price: 1000 })
      db.createSale({ title: '未紐付け・私物', sold_at: daysAgo(35), price: 1000, kind: 'personal' })

      const found = db.getHealthChecks().find(c => c.id === 'unmatched-old')
      expect(found?.count).toBe(1)
    })

    it('draft-old：下書きのまま14日たった仕入が1件になる', () => {
      db.createPurchaseDraft({
        import_key: 'draft-old-1', shop_account_id: shopId,
        ordered_at: daysAgo(15), lines: [],
      })
      db.createPurchaseDraft({
        import_key: 'draft-old-2', shop_account_id: shopId,
        ordered_at: daysAgo(5), lines: [],
      })

      const found = db.getHealthChecks().find(c => c.id === 'draft-old')
      expect(found?.count).toBe(1)
      expect(found?.goto).toEqual({ tab: 'purchases' })
    })

    it('経過日数はJSTの暦日で数える。UTCでは前日にあたる時刻（JST深夜0時台）でも、' +
      'shipping-old・unmatched-old（30日）とdraft-old（14日）のちょうどの日数の扱いが変わらない', () => {
      // 「いま」を JST 2026-05-01 00:15（= UTC 2026-04-30 15:15）に固定する。
      // julianday('now') のまま（UTC基準）だと、この時間帯だけ経過日数が実際より少なく出て境目が1日ずれていた
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 15, 15, 0)))
      try {
        db.createSale({ title: 'ちょうど30日・未紐付け', sold_at: daysAgo(30), price: 1000 })
        db.createSale({ title: '29日・未紐付け', sold_at: daysAgo(29), price: 1000 })
        db.createPurchaseDraft({
          import_key: 'draft-jst-1', shop_account_id: shopId,
          ordered_at: daysAgo(14), lines: [],
        })
        db.createPurchaseDraft({
          import_key: 'draft-jst-2', shop_account_id: shopId,
          ordered_at: daysAgo(13), lines: [],
        })

        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'shipping-old')?.count).toBe(1)
        expect(checks.find(c => c.id === 'unmatched-old')?.count).toBe(1)
        expect(checks.find(c => c.id === 'draft-old')?.count).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('同じ「ちょうど30日／29日／31日・14日／13日」の扱いが、JST昼間に実行しても深夜0時台と同じになる', () => {
      // 深夜0時台と結果を比較するため、今度は UTC でも同じ日付になる JST 昼間（12:00）に固定する
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 3, 0, 0))) // JST 2026-04-30 12:00
      try {
        db.createSale({ title: 'ちょうど30日・未紐付け・昼', sold_at: daysAgo(30), price: 1000 })
        db.createSale({ title: '31日・未紐付け・昼', sold_at: daysAgo(31), price: 1000 })
        db.createSale({ title: '29日・未紐付け・昼', sold_at: daysAgo(29), price: 1000 })
        db.createPurchaseDraft({
          import_key: 'draft-noon-1', shop_account_id: shopId,
          ordered_at: daysAgo(14), lines: [],
        })
        db.createPurchaseDraft({
          import_key: 'draft-noon-2', shop_account_id: shopId,
          ordered_at: daysAgo(13), lines: [],
        })

        const checks = db.getHealthChecks()
        // 30日・31日の2件が対象（29日は対象外）
        expect(checks.find(c => c.id === 'unmatched-old')?.count).toBe(2)
        expect(checks.find(c => c.id === 'shipping-old')?.count).toBe(2)
        expect(checks.find(c => c.id === 'draft-old')?.count).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('no-model-code：型番の無いin_stock在庫が1件になる', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '型番の無い商品', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '型番あり商品【M001】', unit_price: 1000, quantity: 1 }],
      })

      const found = db.getHealthChecks().find(c => c.id === 'no-model-code')
      expect(found?.count).toBe(1)
      expect(found?.goto).toEqual({ tab: 'inventory' })
    })

    it('warnがinfoより先に並ぶ', () => {
      // info（no-model-code）
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '型番なし', unit_price: 1000, quantity: 1 }],
      })
      // warn（zero-cost-link）
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: '原価0円【M002】', unit_price: 0, quantity: 1 }],
      })
      const [item] = db.listInventory('in_stock').filter(i => i.name === '原価0円【M002】')
      const saleId = db.createSale({ title: '原価0円【M002】', sold_at: todayLocal(), price: 1000 })
      db.linkInventory(saleId, [item.id])

      const checks = db.getHealthChecks()
      const firstInfoIndex = checks.findIndex(c => c.level === 'info')
      const lastWarnIndex = checks.map(c => c.level).lastIndexOf('warn')
      expect(firstInfoIndex).toBeGreaterThan(lastWarnIndex)
    })

    describe('listing-blocks-sale／suspended-listing-reserved：出品に取られたままの在庫', () => {
      it('実データの再現：suspendedな出品が握った在庫と同じ型番のYahoo販売が未紐付けだと、両方1件ずつ出る', () => {
        db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '【A040】もこ山 スクイーズ', unit_price: 1000, quantity: 1 }],
        })
        const item = db.listInventory('in_stock')[0]
        db.upsertListings([
          { mercariItemId: 'm-blk-1', title: '【A040】もこ山 スクイーズ', price: 3000, suspended: true, thumbUrl: null },
        ])
        db.reserveInventory('m-blk-1', [item.id])

        const saleId = db.createSale({
          title: 'もこ山 スクイーズ【A040】', sold_at: '2026-01-10', price: 5750, channel: 'yahoo',
        })
        const sale = db.listSales().find(s => s.id === saleId)!
        expect(sale.unmatched).toBe(1)

        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'listing-blocks-sale')).toMatchObject({
          level: 'warn', count: 1, goto: { tab: 'sales', stage: 'all' },
        })
        expect(checks.find(c => c.id === 'suspended-listing-reserved')).toMatchObject({
          level: 'info', count: 1, goto: { tab: 'sales', stage: 'listed' },
        })
      })

      it('同じ型番の在庫がもう1点、引き当てられずに残っていればlisting-blocks-saleは出ない（FIFOで紐付くので）。suspended-listing-reservedは出る', () => {
        db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '【A050】在庫2点', unit_price: 1000, quantity: 2 }],
        })
        const [item1, item2] = db.listInventory('in_stock')
        db.upsertListings([
          { mercariItemId: 'm-blk-2', title: '【A050】在庫2点', price: 3000, suspended: true, thumbUrl: null },
        ])
        db.reserveInventory('m-blk-2', [item1.id]) // item2は未引き当てのまま残す

        const saleId = db.createSale({ title: '在庫2点【A050】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
        const sale = db.listSales().find(s => s.id === saleId)!
        expect(sale.unmatched).toBe(0) // item2で普通に自動紐付けできている
        void item2

        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
        expect(checks.find(c => c.id === 'suspended-listing-reserved')).toMatchObject({ count: 1 })
      })

      it('activeな出品が握っている場合：listing-blocks-saleは出るが、suspended-listing-reservedは出ない（出品中は正常）', () => {
        db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '【A051】商品', unit_price: 1000, quantity: 1 }],
        })
        const item = db.listInventory('in_stock')[0]
        db.upsertListings([
          { mercariItemId: 'm-blk-3', title: '【A051】商品', price: 3000, suspended: false, thumbUrl: null },
        ])
        db.reserveInventory('m-blk-3', [item.id])

        const saleId = db.createSale({ title: '商品【A051】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
        const sale = db.listSales().find(s => s.id === saleId)!
        expect(sale.unmatched).toBe(1)

        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'listing-blocks-sale')).toMatchObject({ count: 1 })
        expect(checks.find(c => c.id === 'suspended-listing-reserved')).toBeUndefined()
      })

      it('sold/endedの出品が握っていた在庫は、どちらも数えない', () => {
        db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '【A052】商品', unit_price: 1000, quantity: 1 }],
        })
        const item = db.listInventory('in_stock')[0]
        db.upsertListings([
          { mercariItemId: 'm-blk-4', title: '【A052】商品', price: 3000, suspended: false, thumbUrl: null },
        ])
        db.reserveInventory('m-blk-4', [item.id])
        // 通常はtakeOverListingがlisting_lineを先に消してからsoldにするが、万一残っていても
        // 数えないことを確かめる（既存のgetAutoLinkBlockersのテストと同じやり方）
        db.getDb().prepare(`UPDATE listing SET status = 'sold' WHERE mercari_item_id = ?`).run('m-blk-4')

        const saleId = db.createSale({ title: '商品【A052】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
        const sale = db.listSales().find(s => s.id === saleId)!
        expect(sale.unmatched).toBe(0) // soldな出品は横取りにならないのでFIFOで紐付く

        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
        expect(checks.find(c => c.id === 'suspended-listing-reserved')).toBeUndefined()
      })

      it('私物・型番なし・型番2つ・紐付け済みの販売はlisting-blocks-saleに数えない', () => {
        db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '【A053】商品', unit_price: 1000, quantity: 1 }],
        })
        const item = db.listInventory('in_stock')[0]
        db.upsertListings([
          { mercariItemId: 'm-blk-5', title: '【A053】商品', price: 3000, suspended: true, thumbUrl: null },
        ])
        db.reserveInventory('m-blk-5', [item.id])

        // 私物
        db.createSale({ title: '商品【A053】', sold_at: '2026-01-10', price: 3000, kind: 'personal' })
        // 型番なし
        db.createSale({ title: '型番なしの商品', sold_at: '2026-01-10', price: 1000 })
        // 型番2つ
        db.createSale({ title: '【A053】と【A054】のセット', sold_at: '2026-01-10', price: 2000 })
        // 紐付け済み（別の型番の在庫を明示的に紐付ける）
        db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '【A055】別商品', unit_price: 1000, quantity: 1 }],
        })
        const item55 = db.listInventory('in_stock').find(i => i.model_code === 'A055')!
        const linkedSaleId = db.createSale({ title: '別商品【A055】', sold_at: '2026-01-10', price: 3000 })
        db.linkInventory(linkedSaleId, [item55.id])

        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
      })

      it('該当が無いとき、どちらもリストに出てこない', () => {
        const checks = db.getHealthChecks()
        expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
        expect(checks.find(c => c.id === 'suspended-listing-reserved')).toBeUndefined()
      })
    })
  })

  describe('inventory_view：在庫の滞留日数（aging_days）はJSTの暦日で数える', () => {
    // 【注意】aging_days は inventory_view の中で julianday('now') を直接使っており、
    // これは better-sqlite3（ネイティブのSQLite）がOSの時計を読んで計算する。
    // vi.useFakeTimers / vi.setSystemTime は JS の Date を差し替えるだけで、
    // ネイティブ実装が読む「今」には効かない（実際に試すと、フェイクした日付ではなく
    // 実行した実際の日付からの日数がそのまま返ってきた）。
    //
    // そのため、時刻を固定する代わりに、acquired_at 側も SQLite の
    // date('now','localtime','-N days') で組み立てる。こうすると「now」がいつであっても
    // （＝テストを実行した実際の時刻がJST何時であっても）、期待値どおりの日数になる。
    // 逆に言うと、直し前の式（julianday('now') をそのまま引く）だと、
    // 実行したのがちょうどJSTの0〜9時台（UTC日をまたぐ前）に当たると
    // ここが89日など1日少なく出て、このテストが落ちていたはずの箇所
    function localDateOffset(days: number): string {
      return (db.getDb().prepare(
        `SELECT date('now','localtime',?) AS d`,
      ).get(`-${days} days`) as { d: string }).d
    }

    it('acquired_atからの経過日数は、実行した時刻（時分秒）を引きずらずちょうどの暦日数になる。ちょうど90日は長期滞留に入り、89日は入らない', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: localDateOffset(90), shipping_fee: 0,
        lines: [{ name: 'ちょうど90日', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: localDateOffset(89), shipping_fee: 0,
        lines: [{ name: '89日', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: localDateOffset(0), shipping_fee: 0,
        lines: [{ name: '今日仕入れた', unit_price: 1000, quantity: 1 }],
      })

      const items = db.listInventory('in_stock')
      expect(items.find(i => i.name === 'ちょうど90日')!.aging_days).toBe(90)
      expect(items.find(i => i.name === '89日')!.aging_days).toBe(89)
      expect(items.find(i => i.name === '今日仕入れた')!.aging_days).toBe(0)

      // aging_warn_days は既定90（schema.sqlの初期値）。90日ちょうどの1件だけが対象
      expect(views.getInventoryOverview().aging.count).toBe(1)
    })
  })

  describe('exportCsvRows：CSV書き出し（金額は円の整数のまま。main で組み立て、レンダラーで再計算しない）', () => {
    it('0件は空文字（保存ダイアログを出さない判定に使う）', () => {
      expect(db.exportCsvRows('sales')).toBe('')
      expect(db.exportCsvRows('purchases')).toBe('')
      expect(db.exportCsvRows('expenses')).toBe('')
      expect(db.exportCsvRows('inventory')).toBe('')
    })

    it('sales：見出しと1行目の列数が一致し、monthでsold_at（計上日）を絞れる。金額はカンマ区切りにならない整数', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品A', unit_price: 1000, quantity: 2 }],
      })
      const [item1, item2] = db.listInventory('in_stock')
      const sale1 = db.createSale({ title: '商品A', sold_at: '2026-01-05', price: 123456 })
      db.linkInventory(sale1, [item1.id])
      const sale2 = db.createSale({ title: '商品A', sold_at: '2026-02-05', price: 20000 })
      db.linkInventory(sale2, [item2.id])

      const all = parseCsv(db.exportCsvRows('sales'))
      expect(all.rows).toHaveLength(2)
      expect(all.rows[0]).toHaveLength(all.headers.length)

      const jan = parseCsv(db.exportCsvRows('sales', '2026-01'))
      expect(jan.rows).toHaveLength(1)
      const priceIdx = jan.headers.indexOf('販売価格')
      expect(jan.rows[0][priceIdx]).toBe('123456')
      expect(jan.rows[0][priceIdx]).not.toContain(',')
    })

    it('purchases：1行=仕入の1明細。見出しと列数が一致し、monthでordered_at（注文日）を絞れる', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-10', shipping_fee: 100,
        lines: [{ name: '仕入品A【Q001】', unit_price: 1000, quantity: 1 }],
      })
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-10', shipping_fee: 50,
        lines: [{ name: '仕入品B【Q002】', unit_price: 2000, quantity: 1 }],
      })

      const all = parseCsv(db.exportCsvRows('purchases'))
      expect(all.rows).toHaveLength(2)
      expect(all.rows[0]).toHaveLength(all.headers.length)
      expect(all.headers).toEqual([
        '注文日', '仕入先', '注文番号', '状態', '商品名', '型番', '数量', '単価',
        '按分後原価', '注文の送料', '注文のその他費用', '注文の割引', 'メモ',
      ])

      const jan = parseCsv(db.exportCsvRows('purchases', '2026-01'))
      expect(jan.rows).toHaveLength(1)
      expect(jan.rows[0][jan.headers.indexOf('商品名')]).toBe('仕入品A【Q001】')
      expect(jan.rows[0][jan.headers.indexOf('型番')]).toBe('Q001')
      expect(jan.rows[0][jan.headers.indexOf('状態')]).toBe('確定')
    })

    it('expenses：1行=経費の1明細。見出しと列数が一致し、monthは計上月（occurred_atではない）で絞る。明細の無い経費も落とさない', () => {
      // 12月末に買ったが計上月は1月（月をまたぐケース）。明細なし＝合計だけ入力
      db.createExpense({ occurred_at: '2025-12-30', month: '2026-01', category: 'packaging', amount: 700 })
      db.createExpense({ occurred_at: '2026-02-01', category: 'other', amount: 300 })

      const all = parseCsv(db.exportCsvRows('expenses'))
      expect(all.rows).toHaveLength(2)
      expect(all.rows[0]).toHaveLength(all.headers.length)
      expect(all.headers).toEqual([
        '計上月', '購入日', '購入店', '登録番号', '項目', '品名', '単価', '数量', '金額', 'メモ',
      ])

      const jan = parseCsv(db.exportCsvRows('expenses', '2026-01'))
      expect(jan.rows).toHaveLength(1)
      expect(jan.rows[0][jan.headers.indexOf('購入日')]).toBe('2025-12-30')
      expect(jan.rows[0][jan.headers.indexOf('金額')]).toBe('700')
      expect(jan.rows[0][jan.headers.indexOf('項目')]).toBe('梱包費')
    })

    it('expenses：registration_noを保存した経費はCSVの登録番号列に出る。無い経費は空文字', () => {
      db.createExpense({
        occurred_at: '2026-03-01', category: 'supplies', amount: 300,
        shop: 'セリア 小倉貫店', receipt_registration_no: 'T4200001013662',
      })
      db.createExpense({ occurred_at: '2026-03-02', category: 'other', amount: 100 })

      const rows = parseCsv(db.exportCsvRows('expenses', '2026-03'))
      const regIdx = rows.headers.indexOf('登録番号')
      const values = rows.rows.map(r => r[regIdx]).sort()
      expect(values).toEqual(['', 'T4200001013662'])
    })

    it('inventory：monthを渡しても全件（在庫は「今」の姿なので月で切らない）', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫品【R001】', unit_price: 1000, quantity: 2 }],
      })

      const withoutMonth = parseCsv(db.exportCsvRows('inventory'))
      expect(withoutMonth.rows).toHaveLength(2)
      expect(withoutMonth.rows[0]).toHaveLength(withoutMonth.headers.length)
      expect(withoutMonth.headers).toEqual([
        '在庫コード', '商品名', '型番', '素材', '状態', '仕入先', '注文番号', '仕入日',
        '滞留日数', '按分後原価', '出品価格', '販売日', '販売価格', '1点あたりの粗利',
      ])

      const withMonth = parseCsv(db.exportCsvRows('inventory', '2099-01'))
      expect(withMonth.rows).toHaveLength(2)
    })

    it('値にカンマを含む商品名は"で囲まれる', () => {
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品,カンマ入り', unit_price: 1000, quantity: 1 }],
      })
      const [item] = db.listInventory('in_stock')
      const saleId = db.createSale({ title: '商品,カンマ入り', sold_at: '2026-01-05', price: 2000 })
      db.linkInventory(saleId, [item.id])

      const csv = db.exportCsvRows('sales')
      expect(csv).toContain('"商品,カンマ入り"')
      const parsed = parseCsv(csv)
      expect(parsed.rows[0][parsed.headers.indexOf('商品名')]).toBe('商品,カンマ入り')
    })
  })
})
