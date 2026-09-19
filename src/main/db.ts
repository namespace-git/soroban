import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
// ビルド後もスキーマを確実に読めるよう、ファイル読み込みではなく埋め込む
import schemaSql from './schema.sql?raw'
import { allocate, calcFee, splitEvenly } from './money'
import { thisMonthLocal } from '../shared/date'
import type {
  DashboardStats, InventoryItem, InventoryStatus, MonthlySummary,
  PurchaseInput, PurchaseSummary, SaleInput, SaleKind, SalePatch,
  SaleProfit, ShippingMethod, ShopAccount, CollectorRun, RunStatus,
} from '../shared/types'

// ============================================================
// ローカルSQLite
//
// 保存先は Electron の userData 配下。自前でパスを組み立てない。
//   Windows: %APPDATA%\soroban\soroban.db
//   macOS:   ~/Library/Application Support/soroban/soroban.db
// ============================================================

let db: Database.Database

export function getDbPath(): string {
  return join(app.getPath('userData'), 'soroban.db')
}

export function initDb(path?: string): void {
  db = new Database(path ?? getDbPath())
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  db.exec(schemaSql)

  seedDefaults()
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DBが初期化されていません')
  return db
}

/** 初回のみ、発送方法の既定値を入れる */
function seedDefaults(): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM shipping_method').get() as { c: number }
  if (count.c > 0) return

  // 送料は改定される。設定画面から編集できるようにしてあるので、
  // 実際の出品画面の表示と食い違ったら直すこと
  const rows: Array<[string, string | null, number, number]> = [
    ['ゆうパケットポストmini', 'ゆうゆうメルカリ便', 180, 1],
    ['ネコポス', 'らくらくメルカリ便', 210, 2],
    ['ゆうパケットポスト', 'ゆうゆうメルカリ便', 215, 3],
    ['ゆうパケット', 'ゆうゆうメルカリ便', 230, 4],
    ['宅急便コンパクト', 'らくらくメルカリ便', 520, 5],
    ['ゆうパケットプラス', 'ゆうゆうメルカリ便', 520, 6],
    ['宅急便 60サイズ', 'らくらくメルカリ便', 750, 7],
    ['送料なし・着払い', null, 0, 99],
  ]
  const ins = db.prepare(
    `INSERT INTO shipping_method (id, name, carrier, fee, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction(() => {
    for (const [name, carrier, fee, order] of rows) {
      ins.run(randomUUID(), name, carrier, fee, order)
    }
  })
  tx()
}

function setting(key: string, fallback: number): number {
  const r = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string } | undefined
  return r ? Number(r.value) : fallback
}

// ============================================================
// 仕入：按分
//
// 送料1,000円の注文で5点買ったら、1点あたり200円が原価に乗る。
// これを無視すると利益が実態より大きく出る。
//
// 端数は最終行（明細）・最終アイテムに寄せて、配賦総額が必ず一致するようにしている。
// 純粋な計算部分は money.ts の allocate / splitEvenly を参照。
// ============================================================

export function createPurchase(input: PurchaseInput): string {
  const purchaseId = randomUUID()
  const shippingFee = input.shipping_fee ?? 0
  const discount = input.discount ?? 0
  const otherCost = input.other_cost ?? 0
  const method = input.alloc_method ?? 'by_amount'

  // 配賦対象額：送料 + その他 − 割引
  const pool = shippingFee + otherCost - discount

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchase
         (id, shop_account_id, ordered_at, order_no,
          shipping_fee, discount, other_cost, alloc_method, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      purchaseId, input.shop_account_id, input.ordered_at,
      input.order_no ?? null, shippingFee, discount, otherCost,
      method, input.note ?? null,
    )

    const lineRows = input.lines.map((l, i) => ({
      id: randomUUID(),
      name: l.name,
      unit_price: l.unit_price,
      quantity: l.quantity,
      sort_order: i,
    }))

    const alloc = allocate(lineRows, pool, method)

    const insLine = db.prepare(
      `INSERT INTO purchase_line
         (id, purchase_id, name, unit_price, quantity,
          allocated_cost, landed_unit_cost, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insItem = db.prepare(
      `INSERT INTO inventory_item
         (id, purchase_line_id, name, landed_cost, acquired_at)
       VALUES (?, ?, ?, ?, ?)`,
    )

    for (const l of lineRows) {
      const a = alloc.get(l.id)!
      // purchase_line.landed_unit_cost は基準値（端数切り捨て）。
      // 実際のアイテムごとの原価は splitEvenly で1円単位まで割り振る
      const baseUnit = l.unit_price + Math.floor(a.allocated / l.quantity)
      insLine.run(
        l.id, purchaseId, l.name, l.unit_price, l.quantity,
        a.allocated, baseUnit, l.sort_order,
      )
      // 数量分だけ在庫アイテムを生成する。
      // landed_cost はここで確定し、以後は独立（過去の利益を動かさない）
      const parts = splitEvenly(a.allocated, l.quantity)
      for (let n = 0; n < l.quantity; n++) {
        insItem.run(randomUUID(), l.id, l.name, l.unit_price + parts[n], input.ordered_at)
      }
    }
  })

  tx()
  return purchaseId
}

export function listPurchases(): PurchaseSummary[] {
  return db.prepare(`
    SELECT
      p.id, p.ordered_at, p.order_no, p.shipping_fee, p.discount,
      sa.name AS shop_account_name,
      COUNT(pl.id) AS line_count,
      COALESCE(SUM(pl.unit_price * pl.quantity), 0) AS subtotal,
      COALESCE(SUM(pl.unit_price * pl.quantity + pl.allocated_cost), 0) AS total_cost
    FROM purchase p
    JOIN shop_account sa ON sa.id = p.shop_account_id
    LEFT JOIN purchase_line pl ON pl.purchase_id = p.id
    GROUP BY p.id
    ORDER BY p.ordered_at DESC, p.created_at DESC
  `).all() as PurchaseSummary[]
}

export function deletePurchase(id: string): void {
  // 売れた在庫がぶら下がっていたら消させない。
  // 消すと販売側の原価が消えて過去の利益が壊れる
  const sold = db.prepare(`
    SELECT COUNT(*) AS c
    FROM inventory_item i
    JOIN purchase_line pl ON pl.id = i.purchase_line_id
    WHERE pl.purchase_id = ? AND i.status = 'sold'
  `).get(id) as { c: number }

  if (sold.c > 0) {
    throw new Error(`この仕入には販売済みの在庫が${sold.c}点あります。先に紐付けを解除してください`)
  }
  db.prepare('DELETE FROM purchase WHERE id = ?').run(id)
}

// ============================================================
// 販売
// ============================================================

export function createSale(input: SaleInput): string {
  const id = randomUUID()
  const rateBp = setting('fee_rate_bp', 1000)

  db.prepare(
    `INSERT INTO sale
       (id, mercari_item_id, title, sold_at, price, kind,
        fee_rate_bp, fee, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  ).run(
    id, input.mercari_item_id ?? null, input.title, input.sold_at,
    input.price, input.kind ?? 'resale', rateBp,
    calcFee(input.price, rateBp), input.note ?? null,
  )
  return id
}

export function updateSale(id: string, patch: SalePatch): void {
  const cur = db.prepare('SELECT * FROM sale WHERE id = ?').get(id) as
    | { price: number; fee_rate_bp: number } | undefined
  if (!cur) throw new Error('販売が見つかりません')

  const sets: string[] = []
  const vals: unknown[] = []

  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }

  if (patch.title !== undefined) put('title', patch.title)
  if (patch.sold_at !== undefined) put('sold_at', patch.sold_at)
  if (patch.kind !== undefined) put('kind', patch.kind)
  if (patch.packaging_cost !== undefined) put('packaging_cost', patch.packaging_cost)
  if (patch.note !== undefined) put('note', patch.note)

  // 価格が変わったら手数料を再計算する
  if (patch.price !== undefined) {
    put('price', patch.price)
    put('fee', calcFee(patch.price, cur.fee_rate_bp))
  }

  // 発送方法を選んだら送料をマスタから引き、確認済みにする
  if (patch.shipping_method_id !== undefined) {
    put('shipping_method_id', patch.shipping_method_id)
    if (patch.shipping_method_id) {
      const m = db.prepare('SELECT fee FROM shipping_method WHERE id = ?')
        .get(patch.shipping_method_id) as { fee: number } | undefined
      put('shipping_fee', patch.shipping_fee ?? m?.fee ?? 0)
      put('is_shipping_confirmed', 1)
    } else {
      put('is_shipping_confirmed', 0)
    }
  } else if (patch.shipping_fee !== undefined) {
    put('shipping_fee', patch.shipping_fee)
    put('is_shipping_confirmed', 1)
  }

  if (sets.length === 0) return

  put('updated_at', new Date().toISOString())
  vals.push(id)
  db.prepare(`UPDATE sale SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteSale(id: string): void {
  db.prepare('DELETE FROM sale WHERE id = ?').run(id)
}

export function listSales(filter?: {
  month?: string
  kind?: SaleKind
  onlyPending?: boolean
}): SaleProfit[] {
  const where: string[] = []
  const vals: unknown[] = []

  if (filter?.month) { where.push(`substr(sold_at,1,7) = ?`); vals.push(filter.month) }
  if (filter?.kind) { where.push(`kind = ?`); vals.push(filter.kind) }
  // 未処理＝送料未入力、または（転売なのに）在庫が未紐付け
  if (filter?.onlyPending) {
    where.push(`(is_shipping_confirmed = 0 OR (unmatched = 1 AND kind = 'resale'))`)
  }

  const sql = `SELECT * FROM sale_profit
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY sold_at DESC, title`
  return db.prepare(sql).all(...vals) as SaleProfit[]
}

// ============================================================
// 紐付け
//
// 自動確定しない。誤紐付けは原価を壊し、しかも気づきにくい。
// suggestInventory は候補を返すだけ。
// ============================================================

export function linkInventory(saleId: string, itemIds: string[]): void {
  const ins = db.prepare(
    `INSERT INTO sale_line (id, sale_id, inventory_item_id) VALUES (?, ?, ?)`,
  )
  const tx = db.transaction(() => {
    for (const itemId of itemIds) ins.run(randomUUID(), saleId, itemId)
  })
  try {
    tx()
  } catch (e) {
    // UNIQUE 制約：すでに他の販売に紐付いている
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      throw new Error('その在庫はすでに別の販売に紐付いています')
    }
    throw e
  }
}

export function unlinkInventory(saleId: string, itemId: string): void {
  db.prepare('DELETE FROM sale_line WHERE sale_id = ? AND inventory_item_id = ?')
    .run(saleId, itemId)
}

/** 記号と空白を落として比較用のキーを作る */
function normalizeName(s: string): string {
  return s.replace(/[\s　【】\[\]（）()／/・,、。]/g, '').toLowerCase()
}

/**
 * 商品名の類似度で在庫候補を返す。
 * 完全一致 → 前方一致 → 部分一致 → 残り、の順に並べる（同順位は滞留日数が長い方を先に）。
 * SQL側では正規化できないため、in_stock を全件取ってJS側で並べ替える
 * （規模は月20〜50件程度の想定）。
 */
export function suggestInventory(saleId: string, limit = 20): InventoryItem[] {
  const sale = db.prepare('SELECT title FROM sale WHERE id = ?').get(saleId) as
    | { title: string } | undefined
  if (!sale) return []

  const target = normalizeName(sale.title)
  const head = target.slice(0, 6)

  const items = db.prepare(
    `SELECT * FROM inventory_view WHERE status = 'in_stock'`,
  ).all() as InventoryItem[]

  const rank = (item: InventoryItem): number => {
    const n = normalizeName(item.name)
    if (n === target) return 0
    if (head && n.startsWith(head)) return 1
    if (head && n.includes(head)) return 2
    return 3
  }

  return items
    .map(item => ({ item, r: rank(item) }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : b.item.aging_days - a.item.aging_days))
    .slice(0, limit)
    .map(({ item }) => item)
}

// ============================================================
// 在庫
// ============================================================

export function listInventory(status: InventoryStatus = 'in_stock'): InventoryItem[] {
  return db.prepare(
    `SELECT * FROM inventory_view WHERE status = ? ORDER BY aging_days DESC`,
  ).all(status) as InventoryItem[]
}

export function disposeInventory(
  id: string,
  note: string,
  status: 'disposed' | 'personal_use' = 'disposed',
): void {
  const item = db.prepare('SELECT status FROM inventory_item WHERE id = ?').get(id) as
    | { status: InventoryStatus } | undefined
  if (!item) throw new Error('在庫が見つかりません')
  if (item.status !== 'in_stock') {
    throw new Error('販売済みの在庫は外せません')
  }

  db.prepare(
    `UPDATE inventory_item
        SET status = ?, disposed_at = date('now'),
            disposed_note = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(status, note, id)
}

// ============================================================
// 集計
// ============================================================

export function listMonthly(): MonthlySummary[] {
  return db.prepare(
    `SELECT * FROM monthly_summary ORDER BY month DESC, kind`,
  ).all() as MonthlySummary[]
}

export function getDashboard(): DashboardStats {
  const one = <T>(sql: string, ...v: unknown[]) => db.prepare(sql).get(...v) as T

  const needsShipping = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale WHERE is_shipping_confirmed = 0`).c

  const needsMatch = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale_profit WHERE unmatched = 1 AND kind = 'resale'`).c

  const stock = one<{ c: number; v: number }>(
    `SELECT COUNT(*) AS c, COALESCE(SUM(landed_cost),0) AS v
       FROM inventory_item WHERE status = 'in_stock'`)

  const warnDays = setting('aging_warn_days', 90)
  const aging = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM inventory_view
      WHERE status = 'in_stock' AND aging_days >= ?`, warnDays).c

  const month = thisMonthLocal()
  const thisMonth = db.prepare(
    `SELECT * FROM monthly_summary WHERE month = ? AND kind = 'resale'`,
  ).get(month) as MonthlySummary | undefined

  const lastRun = db.prepare(
    `SELECT * FROM collector_run ORDER BY started_at DESC LIMIT 1`,
  ).get() as CollectorRun | undefined

  return {
    needsShipping,
    needsMatch,
    stockCount: stock.c,
    stockValue: stock.v,
    agingCount: aging,
    thisMonth: thisMonth ?? null,
    lastRun: lastRun ?? null,
  }
}

// ============================================================
// マスタ
// ============================================================

export function listShopAccounts(): ShopAccount[] {
  return db.prepare('SELECT * FROM shop_account ORDER BY name').all() as ShopAccount[]
}

export function createShopAccount(name: string): string {
  const id = randomUUID()
  db.prepare('INSERT INTO shop_account (id, name) VALUES (?, ?)').run(id, name)
  return id
}

export function listShippingMethods(): ShippingMethod[] {
  return db.prepare(
    'SELECT * FROM shipping_method WHERE is_active = 1 ORDER BY sort_order, name',
  ).all() as ShippingMethod[]
}

export function saveShippingMethod(
  m: Partial<ShippingMethod> & { name: string; fee: number },
): void {
  if (m.id) {
    db.prepare(
      'UPDATE shipping_method SET name = ?, carrier = ?, fee = ?, sort_order = ? WHERE id = ?',
    ).run(m.name, m.carrier ?? null, m.fee, m.sort_order ?? 0, m.id)
  } else {
    db.prepare(
      'INSERT INTO shipping_method (id, name, carrier, fee, sort_order) VALUES (?,?,?,?,?)',
    ).run(randomUUID(), m.name, m.carrier ?? null, m.fee, m.sort_order ?? 0)
  }
}

export function deleteShippingMethod(id: string): void {
  db.prepare('UPDATE shipping_method SET is_active = 0 WHERE id = ?').run(id)
}

export function getSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM setting').all() as
    Array<{ key: string; value: string }>
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  ).run(key, value, value)
}

// ============================================================
// 収集の記録
// ============================================================

export function startRun(): string {
  const id = randomUUID()
  db.prepare('INSERT INTO collector_run (id, started_at) VALUES (?, ?)')
    .run(id, new Date().toISOString())
  return id
}

export function finishRun(
  id: string, status: RunStatus, fetched: number, inserted: number, message?: string,
): CollectorRun {
  db.prepare(
    `UPDATE collector_run
        SET finished_at = ?, status = ?, fetched = ?, inserted = ?, message = ?
      WHERE id = ?`,
  ).run(new Date().toISOString(), status, fetched, inserted, message ?? null, id)
  return db.prepare('SELECT * FROM collector_run WHERE id = ?').get(id) as CollectorRun
}

export function listRuns(limit = 20): CollectorRun[] {
  return db.prepare(
    'SELECT * FROM collector_run ORDER BY started_at DESC LIMIT ?',
  ).all(limit) as CollectorRun[]
}

/** 前回成功からの経過時間（時間単位）。未実行なら Infinity */
export function hoursSinceLastOk(): number {
  const r = db.prepare(
    `SELECT started_at FROM collector_run
      WHERE status IN ('ok','empty') ORDER BY started_at DESC LIMIT 1`,
  ).get() as { started_at: string } | undefined
  if (!r) return Infinity
  return (Date.now() - new Date(r.started_at).getTime()) / 3_600_000
}

/** 既存の mercari_item_id を返す（差分取得用） */
export function existingMercariIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set()
  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT mercari_item_id FROM sale WHERE mercari_item_id IN (${ph})`,
  ).all(...ids) as Array<{ mercari_item_id: string }>
  return new Set(rows.map(r => r.mercari_item_id))
}

export function insertCollected(
  rows: Array<{ mercariItemId: string; title: string; price: number; soldAt: string }>,
): number {
  const rateBp = setting('fee_rate_bp', 1000)
  const ins = db.prepare(
    `INSERT INTO sale
       (id, mercari_item_id, title, sold_at, price, kind,
        fee_rate_bp, fee, source, raw, is_shipping_confirmed)
     VALUES (?, ?, ?, ?, ?, 'resale', ?, ?, 'collector', ?, 0)`,
  )
  const tx = db.transaction(() => {
    for (const r of rows) {
      ins.run(
        randomUUID(), r.mercariItemId, r.title, r.soldAt, r.price,
        rateBp, calcFee(r.price, rateBp), JSON.stringify(r),
      )
    }
  })
  tx()
  return rows.length
}

// ============================================================
// エクスポート
// ============================================================

export function exportRows(): string {
  const rows = db.prepare(`
    SELECT
      sp.sold_at        AS 販売日,
      sp.title          AS 商品名,
      CASE sp.kind WHEN 'resale' THEN '転売' ELSE '私物' END AS 区分,
      sp.price          AS 販売価格,
      sp.fee            AS 販売手数料,
      sp.shipping_fee   AS 送料,
      sp.packaging_cost AS 梱包材,
      sp.cost           AS 原価,
      sp.gross_profit   AS 粗利,
      sp.item_count     AS 紐付け点数,
      sp.mercari_item_id AS 取引ID
    FROM sale_profit sp
    ORDER BY sp.sold_at
  `).all() as Array<Record<string, unknown>>

  if (rows.length === 0) return ''

  const headers = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ]
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + lines.join('\r\n')
}

/** その販売に紐付いている在庫（解除・付け替え用） */
export function listSaleLines(saleId: string): InventoryItem[] {
  return db.prepare(`
    SELECT iv.*
    FROM inventory_view iv
    JOIN sale_line sl ON sl.inventory_item_id = iv.id
    WHERE sl.sale_id = ?
    ORDER BY iv.name
  `).all(saleId) as InventoryItem[]
}
