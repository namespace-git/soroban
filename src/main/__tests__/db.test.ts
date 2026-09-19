import { beforeEach, describe, expect, it, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import * as db from '../db'

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

  it('insertCollected：shippingFeeが0でも確定扱い（着払い）', () => {
    db.insertCollected([{
      mercariItemId: 'h2', title: '着払いの商品', price: 1000, soldAt: '2026-09-19', shippingFee: 0,
    }])
    const sale = db.listSales().find(s => s.mercari_item_id === 'h2')!
    expect(sale.shipping_fee).toBe(0)
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(sale.shipping_source).toBe('actual')
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
    expect(after.is_shipping_confirmed).toBe(1)

    // 手入力の販売：sold_at は変わらない
    const manual = db.listSales().find(s => s.id === manualId)!
    expect(manual.sold_at).toBe('2026-01-01')

    // 既に actual & 同じ sold_at のものは再適用しても更新0件
    const noop = db.updateCollectedActuals([
      { mercariItemId: 'u1', soldAt: '2026-08-15', fee: 250, shippingFee: 0 },
    ])
    expect(noop).toBe(0)
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
    const s1 = db.createSale({ title: 'A', sold_at: '2026-01-01', price: 2000 }) // fee 200
    const s2 = db.createSale({ title: 'B', sold_at: '2026-01-02', price: 3000 }) // fee 300
    db.createSale({ title: 'C（タグなし）', sold_at: '2026-01-03', price: 5000 })
    db.setSaleTags(s1, [tagId])
    db.setSaleTags(s2, [tagId])

    const totals = db.saleTotals({ tagId })
    expect(totals).toEqual({
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

      expect(db.getSettings().schema_version).toBe('9')
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
      expect(db.getSettings().schema_version).toBe('9')

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

    it('reserveInventory：二重引き当て・売却済み在庫の引き当てをトリガーで拒否する', () => {
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

      expect(() => db.reserveInventory('LB', [itemA.id])).toThrow('既に別の出品に引き当て済み')

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

    it('suggestForListing：型番一致 → 引き当て済みの在庫は候補から除く', () => {
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

  describe('自動確定は型番の枝番まで完全一致だけ（シリーズのみは候補止まり）', () => {
    it('枝番あり（Z078-2）は自動確定、枝番なし（A035）は候補止まり、枝番あり（A035-1）は自動確定', () => {
      db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [
          { name: 'いちごスフレ【Z078-2】', unit_price: 1000, quantity: 1 },
          { name: 'メロージョイ ミニランド【A035】', unit_price: 1200, quantity: 1 },
          { name: 'メロージョイ ミニランド【A035-1】', unit_price: 1300, quantity: 1 },
        ],
      })

      const saleBranch = db.createSale({ title: '【Z078-2】いちごスフレ', sold_at: '2026-01-10', price: 2000 })
      expect(db.listSales().find(s => s.id === saleBranch)!.unmatched).toBe(0)

      const saleSeriesOnly = db.createSale({ title: '【A035】メロージョイ ミニランド', sold_at: '2026-01-10', price: 2000 })
      expect(db.listSales().find(s => s.id === saleSeriesOnly)!.unmatched).toBe(1)

      const saleBranch2 = db.createSale({ title: '【A035-1】メロージョイ ミニランド', sold_at: '2026-01-10', price: 2000 })
      expect(db.listSales().find(s => s.id === saleBranch2)!.unmatched).toBe(0)
    })
  })
})
