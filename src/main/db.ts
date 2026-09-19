import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
// ビルド後もスキーマを確実に読めるよう、ファイル読み込みではなく埋め込む
import schemaSql from './schema.sql?raw'
import { allocate, calcFee, splitEvenly } from './money'
import { extractCode, extractCodes, extractMaterial } from './code'
import { thisMonthLocal } from '../shared/date'
import type {
  AllocMethod, DashboardStats, InventoryItem, InventoryPatch, InventoryStatus, LinkSource,
  Material, MonthlySummary, PurchaseDetail, PurchaseDraftInput, PurchaseInput, PurchaseLine,
  PurchaseLineInput, PurchaseStatus, PurchaseSummary, SaleInput, SaleKind, SalePatch,
  SaleProfit, ShippingMethod, ShopAccount, ShopAccountKind, VariantSummary,
  CollectorRun, RunStatus,
} from '../shared/types'

// ============================================================
// ローカルSQLite
//
// 保存先は Electron の userData 配下。自前でパスを組み立てない。
//   Windows: %APPDATA%\soroban\soroban.db
//   macOS:   ~/Library/Application Support/soroban/soroban.db
//
// schema.sql は「__VIEWS__」マーカーでテーブル部とビュー部に分けて実行する。
// ビューが新しい列を参照するため、テーブルの CREATE → migrate() での列追加 →
// ビューの CREATE、の順に実行しないと、未migrateの既存DBでビュー作成がこける。
// ============================================================

let db: Database.Database

const VIEW_MARKER = '-- __VIEWS__'
const viewMarkerIndex = schemaSql.indexOf(VIEW_MARKER)
const tablesSql = viewMarkerIndex === -1 ? schemaSql : schemaSql.slice(0, viewMarkerIndex)
const viewsSql = viewMarkerIndex === -1 ? '' : schemaSql.slice(viewMarkerIndex)

export function getDbPath(): string {
  return join(app.getPath('userData'), 'soroban.db')
}

export function initDb(path?: string): void {
  db = new Database(path ?? getDbPath())
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  db.exec(tablesSql)
  migrate()
  db.exec(viewsSql)

  seedDefaults()
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DBが初期化されていません')
  return db
}

/** 接続を閉じる。通常は使わない（テストでファイルDBを後片付けするときだけ使う） */
export function closeDb(): void {
  db?.close()
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

function settingStr(key: string, fallback = ''): string {
  const r = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string } | undefined
  return r ? r.value : fallback
}

// ============================================================
// マイグレーション
//
// 新規DBは schema.sql（テーブル部）で完成形を作るので、以下は基本的に
// 「列がまだ無ければ足す」だけの冪等な処理になる。
// SQLite は既存の CHECK 制約を ALTER できないため、inventory_item.status に
// 'split' を足す部分だけはテーブルを作り直す。
// ============================================================

function columnExists(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some(r => r.name === column)
}

function addColumnIfMissing(table: string, column: string, decl: string): void {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }
}

function inventoryHasSplitStatus(): boolean {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_item'`,
  ).get() as { sql: string } | undefined
  return !!row && row.sql.includes("'split'")
}

/**
 * inventory_item.status の CHECK に 'split' を追加する。
 * 新テーブルを作って INSERT SELECT → 旧テーブル DROP → RENAME。
 * 呼び出し時点で model_code/series_code/material/note/parent_id は
 * すでに追加済みである前提（addColumnIfMissing で先に足しておく）。
 */
function rebuildInventoryItemForSplit(): void {
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => {
    // sale_line 側のトリガーが inventory_item を名指しで参照しているため、
    // DROP TABLE の前に一旦外しておく（残したままだと "no such table" になる）
    // Phase 1 のビューも inventory_item を参照している。DROP TABLE の前に外す
    // （ビューは migrate() の後に viewsSql が作り直す）
    db.exec(`
      DROP VIEW IF EXISTS sale_profit;
      DROP VIEW IF EXISTS monthly_summary;
      DROP VIEW IF EXISTS inventory_view;
      DROP VIEW IF EXISTS variant_summary;
      DROP TRIGGER IF EXISTS trg_sline_sold;
      DROP TRIGGER IF EXISTS trg_sline_unsold;
    `)

    db.exec(`
      CREATE TABLE inventory_item_new (
        id               TEXT PRIMARY KEY,
        purchase_line_id TEXT REFERENCES purchase_line(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        landed_cost      INTEGER NOT NULL,
        acquired_at      TEXT NOT NULL,
        model_code       TEXT,
        series_code      TEXT,
        material         TEXT,
        parent_id        TEXT REFERENCES inventory_item_new(id),
        note             TEXT,
        status           TEXT NOT NULL DEFAULT 'in_stock'
                         CHECK (status IN ('in_stock','sold','disposed','personal_use','split')),
        disposed_at      TEXT,
        disposed_note    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO inventory_item_new
        (id, purchase_line_id, name, landed_cost, acquired_at,
         model_code, series_code, material, parent_id, note,
         status, disposed_at, disposed_note, created_at, updated_at)
      SELECT
        id, purchase_line_id, name, landed_cost, acquired_at,
        model_code, series_code, material, parent_id, note,
        status, disposed_at, disposed_note, created_at, updated_at
      FROM inventory_item;

      DROP TABLE inventory_item;
      ALTER TABLE inventory_item_new RENAME TO inventory_item;

      CREATE INDEX IF NOT EXISTS idx_inv_status   ON inventory_item(status);
      CREATE INDEX IF NOT EXISTS idx_inv_acquired ON inventory_item(acquired_at);
      CREATE INDEX IF NOT EXISTS idx_inv_pline    ON inventory_item(purchase_line_id);
      CREATE INDEX IF NOT EXISTS idx_inv_model    ON inventory_item(model_code, status, acquired_at);

      CREATE TRIGGER trg_sline_sold
      AFTER INSERT ON sale_line
      BEGIN
        UPDATE inventory_item
           SET status = 'sold', updated_at = datetime('now')
         WHERE id = NEW.inventory_item_id;
      END;

      CREATE TRIGGER trg_sline_unsold
      AFTER DELETE ON sale_line
      BEGIN
        UPDATE inventory_item
           SET status = 'in_stock', updated_at = datetime('now')
         WHERE id = OLD.inventory_item_id;
      END;
    `)
  })
  tx()
  db.pragma('foreign_keys = ON')
}

function migrate(): void {
  const verRow = db.prepare(`SELECT value FROM setting WHERE key = 'schema_version'`).get() as
    | { value: string } | undefined
  const version = verRow ? Number(verRow.value) : 1

  if (version < 2) {
    addColumnIfMissing('shop_account', 'kind',
      `TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('mellojoy','tiktok','other'))`)

    addColumnIfMissing('purchase', 'status',
      `TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','confirmed'))`)
    addColumnIfMissing('purchase', 'import_key', 'TEXT')
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_import_key ON purchase(import_key)`)

    addColumnIfMissing('purchase_line', 'model_code', 'TEXT')
    addColumnIfMissing('purchase_line', 'series_code', 'TEXT')
    addColumnIfMissing('purchase_line', 'material', 'TEXT')

    addColumnIfMissing('inventory_item', 'model_code', 'TEXT')
    addColumnIfMissing('inventory_item', 'series_code', 'TEXT')
    addColumnIfMissing('inventory_item', 'material', 'TEXT')
    addColumnIfMissing('inventory_item', 'note', 'TEXT')
    addColumnIfMissing('inventory_item', 'parent_id', 'TEXT REFERENCES inventory_item(id)')
    if (!inventoryHasSplitStatus()) rebuildInventoryItemForSplit()

    addColumnIfMissing('sale', 'shipping_source',
      `TEXT CHECK (shipping_source IN ('actual','master','manual'))`)
    addColumnIfMissing('sale', 'model_codes', `TEXT NOT NULL DEFAULT '[]'`)

    addColumnIfMissing('sale_line', 'link_source',
      `TEXT NOT NULL DEFAULT 'manual' CHECK (link_source IN ('auto','manual'))`)

    // 収集間隔は 6 時間から 1 時間へ変更。値を手で変えていた場合は尊重する
    const interval = db.prepare(`SELECT value FROM setting WHERE key = 'collect_interval_h'`)
      .get() as { value: string } | undefined
    if (!interval || interval.value === '6') {
      db.prepare(
        `INSERT INTO setting (key, value) VALUES ('collect_interval_h', '1')
           ON CONFLICT(key) DO UPDATE SET value = '1'`,
      ).run()
    }
    db.prepare(`INSERT OR IGNORE INTO setting (key, value) VALUES ('mercari_keyword', '')`).run()
    db.prepare(`INSERT OR IGNORE INTO setting (key, value) VALUES ('mellojoy_watch_dir', '')`).run()
    db.prepare(
      `INSERT OR IGNORE INTO setting (key, value) VALUES ('mellojoy_default_account_id', '')`,
    ).run()

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '2')
         ON CONFLICT(key) DO UPDATE SET value = '2'`,
    ).run()
  }
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

/** 明細の型番・素材。手で指定されていなければ商品名から自動抽出する */
function resolveLineCode(l: PurchaseLineInput): {
  model_code: string | null
  series_code: string | null
  material: Material | null
} {
  const extracted = extractCode(l.name)
  return {
    model_code: l.model_code !== undefined ? l.model_code : extracted?.model_code ?? null,
    series_code: l.series_code !== undefined ? l.series_code : extracted?.series_code ?? null,
    material: l.material !== undefined ? l.material : extractMaterial(l.name),
  }
}

/** 按分して明細・在庫アイテムを作る。createPurchase / confirmPurchase の共通処理 */
function insertLinesAndItems(
  purchaseId: string,
  lines: PurchaseLineInput[],
  pool: number,
  method: AllocMethod,
  orderedAt: string,
): void {
  const lineRows = lines.map((l, i) => ({
    id: randomUUID(),
    name: l.name,
    unit_price: l.unit_price,
    quantity: l.quantity,
    sort_order: i,
    ...resolveLineCode(l),
  }))

  const alloc = allocate(lineRows, pool, method)

  const insLine = db.prepare(
    `INSERT INTO purchase_line
       (id, purchase_id, name, unit_price, quantity,
        model_code, series_code, material,
        allocated_cost, landed_unit_cost, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insItem = db.prepare(
    `INSERT INTO inventory_item
       (id, purchase_line_id, name, landed_cost, acquired_at,
        model_code, series_code, material)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const l of lineRows) {
    const a = alloc.get(l.id)!
    // purchase_line.landed_unit_cost は基準値（端数切り捨て）。
    // 実際のアイテムごとの原価は splitEvenly で1円単位まで割り振る
    const baseUnit = l.unit_price + Math.floor(a.allocated / l.quantity)
    insLine.run(
      l.id, purchaseId, l.name, l.unit_price, l.quantity,
      l.model_code, l.series_code, l.material,
      a.allocated, baseUnit, l.sort_order,
    )
    // 数量分だけ在庫アイテムを生成する。
    // landed_cost はここで確定し、以後は独立（過去の利益を動かさない）
    const parts = splitEvenly(a.allocated, l.quantity)
    for (let n = 0; n < l.quantity; n++) {
      insItem.run(
        randomUUID(), l.id, l.name, l.unit_price + parts[n], orderedAt,
        l.model_code, l.series_code, l.material,
      )
    }
  }
}

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
          shipping_fee, discount, other_cost, alloc_method, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    ).run(
      purchaseId, input.shop_account_id, input.ordered_at,
      input.order_no ?? null, shippingFee, discount, otherCost,
      method, input.note ?? null,
    )

    insertLinesAndItems(purchaseId, input.lines, pool, method, input.ordered_at)
  })

  tx()
  return purchaseId
}

/**
 * mellojoy-watch の購入記録から下書きを積む。価格・注文番号はまだ無いので
 * status='draft'、在庫はまだ作らない。同じ import_key が既にあれば飛ばす（''を返す）。
 */
export function createPurchaseDraft(input: PurchaseDraftInput): string {
  const exists = db.prepare('SELECT id FROM purchase WHERE import_key = ?').get(input.import_key) as
    | { id: string } | undefined
  if (exists) return ''

  const purchaseId = randomUUID()

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchase
         (id, shop_account_id, ordered_at, status, import_key, note)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
    ).run(purchaseId, input.shop_account_id, input.ordered_at, input.import_key, input.note ?? null)

    const insLine = db.prepare(
      `INSERT INTO purchase_line
         (id, purchase_id, name, unit_price, quantity, model_code, series_code, material, sort_order)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    input.lines.forEach((l, i) => {
      const extracted = extractCode(l.name)
      const model_code = l.model_code !== undefined ? l.model_code : extracted?.model_code ?? null
      const series_code = l.series_code !== undefined ? l.series_code : extracted?.series_code ?? null
      const material = l.material !== undefined ? l.material : extractMaterial(l.name)
      insLine.run(randomUUID(), purchaseId, l.name, l.quantity, model_code, series_code, material, i)
    })
  })

  tx()
  return purchaseId
}

export function getPurchase(id: string): PurchaseDetail {
  const p = db.prepare(
    `SELECT p.*, sa.name AS shop_account_name
       FROM purchase p
       JOIN shop_account sa ON sa.id = p.shop_account_id
      WHERE p.id = ?`,
  ).get(id) as
    | (PurchaseSummary & { other_cost: number; alloc_method: AllocMethod })
    | undefined
  if (!p) throw new Error('仕入が見つかりません')

  const lines = db.prepare(
    `SELECT id, name, unit_price, quantity, model_code, series_code, material,
            allocated_cost, landed_unit_cost
       FROM purchase_line WHERE purchase_id = ? ORDER BY sort_order`,
  ).all(id) as PurchaseLine[]

  const subtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const total_cost = lines.reduce((s, l) => s + l.unit_price * l.quantity + l.allocated_cost, 0)

  return {
    id: p.id,
    status: p.status,
    ordered_at: p.ordered_at,
    order_no: p.order_no,
    shop_account_id: p.shop_account_id,
    shop_account_name: p.shop_account_name,
    shipping_fee: p.shipping_fee,
    discount: p.discount,
    other_cost: p.other_cost,
    alloc_method: p.alloc_method,
    note: p.note,
    line_count: lines.length,
    subtotal,
    total_cost,
    lines,
  }
}

/** 下書きを確定する：内容を input で置き換え、按分して在庫を生成する */
export function confirmPurchase(id: string, input: PurchaseInput): void {
  const cur = db.prepare('SELECT status FROM purchase WHERE id = ?').get(id) as
    | { status: PurchaseStatus } | undefined
  if (!cur) throw new Error('仕入が見つかりません')
  if (cur.status !== 'draft') {
    throw new Error('確定済みの仕入は再確定できません（landed_costは後から書き換えない）')
  }

  const shippingFee = input.shipping_fee ?? 0
  const discount = input.discount ?? 0
  const otherCost = input.other_cost ?? 0
  const method = input.alloc_method ?? 'by_amount'
  const pool = shippingFee + otherCost - discount

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE purchase
          SET shop_account_id = ?, ordered_at = ?, order_no = ?,
              shipping_fee = ?, discount = ?, other_cost = ?, alloc_method = ?,
              note = ?, status = 'confirmed', updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      input.shop_account_id, input.ordered_at, input.order_no ?? null,
      shippingFee, discount, otherCost, method, input.note ?? null, id,
    )

    // 下書きの明細を作り直す（この時点では在庫はまだ無いので安全）
    db.prepare('DELETE FROM purchase_line WHERE purchase_id = ?').run(id)

    insertLinesAndItems(id, input.lines, pool, method, input.ordered_at)
  })

  tx()
}

export function updatePurchaseNote(id: string, note: string | null): void {
  db.prepare(`UPDATE purchase SET note = ?, updated_at = datetime('now') WHERE id = ?`).run(note, id)
}

export function listPurchases(): PurchaseSummary[] {
  return db.prepare(`
    SELECT
      p.id, p.status, p.ordered_at, p.order_no, p.shop_account_id,
      p.shipping_fee, p.discount, p.note,
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
  const modelCodes = extractCodes(input.title)

  db.prepare(
    `INSERT INTO sale
       (id, mercari_item_id, title, sold_at, price, kind,
        fee_rate_bp, fee, note, source, model_codes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
  ).run(
    id, input.mercari_item_id ?? null, input.title, input.sold_at,
    input.price, input.kind ?? 'resale', rateBp,
    calcFee(input.price, rateBp), input.note ?? null,
    JSON.stringify(modelCodes),
  )

  // 型番が完全一致すれば自動確定。それ以外は候補提示のまま（人が確定する）
  autoLinkSale(id)
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
      put('shipping_source', 'master')
    } else {
      put('is_shipping_confirmed', 0)
      put('shipping_source', null)
    }
  } else if (patch.shipping_fee !== undefined) {
    put('shipping_fee', patch.shipping_fee)
    put('is_shipping_confirmed', 1)
    put('shipping_source', 'manual')
  }

  if (sets.length === 0) return

  put('updated_at', new Date().toISOString())
  vals.push(id)
  db.prepare(`UPDATE sale SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

/**
 * メルカリの取引詳細から取れた実額で上書きする（次の波の収集が使う。IPCには出さない）。
 * shipping_fee が取れたときだけ shipping_source を 'actual' にして確定扱いにする。
 */
export function applySaleActuals(
  id: string,
  actuals: { fee?: number; shipping_fee?: number },
): void {
  const sets: string[] = []
  const vals: unknown[] = []

  if (actuals.fee !== undefined) {
    sets.push('fee = ?')
    vals.push(actuals.fee)
  }
  if (actuals.shipping_fee !== undefined) {
    sets.push('shipping_fee = ?', `shipping_source = 'actual'`, 'is_shipping_confirmed = 1')
    vals.push(actuals.shipping_fee)
  }
  if (sets.length === 0) return

  sets.push(`updated_at = datetime('now')`)
  vals.push(id)
  db.prepare(`UPDATE sale SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteSale(id: string): void {
  db.prepare('DELETE FROM sale WHERE id = ?').run(id)
}

type SaleProfitRow = Omit<SaleProfit, 'model_codes'> & { model_codes: string }

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
  const rows = db.prepare(sql).all(...vals) as SaleProfitRow[]
  return rows.map(r => ({ ...r, model_codes: JSON.parse(r.model_codes || '[]') as string[] }))
}

// ============================================================
// 紐付け
//
// 自動確定しない。誤紐付けは原価を壊し、しかも気づきにくい。
// 例外は Phase 2 の型番完全一致（autoLinkSale）だけ。それ以外は
// suggestInventory が候補を返すだけで、確定は人間が行う。
// ============================================================

export function linkInventory(
  saleId: string, itemIds: string[], source: LinkSource = 'manual',
): void {
  const ins = db.prepare(
    `INSERT INTO sale_line (id, sale_id, inventory_item_id, link_source) VALUES (?, ?, ?, ?)`,
  )
  const tx = db.transaction(() => {
    for (const itemId of itemIds) ins.run(randomUUID(), saleId, itemId, source)
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

/**
 * 販売の型番が model_code と枝番まで完全一致するとき、その型番の未販売在庫を
 * 先入先出（acquired_at 昇順）で1点だけ充てて自動確定する。
 * 条件を満たさない（型番なし・複数・一致在庫なし）場合は何もしない。
 * 戻り値は確定できたかどうか。
 */
export function autoLinkSale(saleId: string): boolean {
  const sale = db.prepare('SELECT kind, model_codes FROM sale WHERE id = ?').get(saleId) as
    | { kind: SaleKind; model_codes: string } | undefined
  if (!sale || sale.kind !== 'resale') return false

  const already = db.prepare('SELECT COUNT(*) AS c FROM sale_line WHERE sale_id = ?')
    .get(saleId) as { c: number }
  if (already.c > 0) return false

  const codes = JSON.parse(sale.model_codes || '[]') as string[]
  if (codes.length !== 1) return false

  const item = db.prepare(`
    SELECT id FROM inventory_item
     WHERE model_code = ? AND status = 'in_stock'
     ORDER BY acquired_at ASC, created_at ASC
     LIMIT 1
  `).get(codes[0]) as { id: string } | undefined
  if (!item) return false

  linkInventory(saleId, [item.id], 'auto')
  return true
}

/** 未紐付けの転売すべてに autoLinkSale を回す。戻り値は確定した件数 */
export function autoLinkPending(): number {
  const pending = db.prepare(
    `SELECT id FROM sale_profit WHERE unmatched = 1 AND kind = 'resale'`,
  ).all() as Array<{ id: string }>

  let count = 0
  for (const p of pending) {
    if (autoLinkSale(p.id)) count++
  }
  return count
}

/**
 * 説明文から後追いで見つかった型番を model_codes に追記する（collector が使う）。
 * 既存の配列と結合し重複除去（出現順は既存が先）。変化がなければ false。
 *
 * 追記後、型番が1つに絞れたら autoLinkSale を試みる。また、タイトルに型番が無く
 * 説明文にだけあったせいで私物扱いになっていた販売は resale に戻す（keyword 判定を
 * 使っていない場合のみ）。ただし人が手で personal にした販売（一度でも更新された
 * 販売）は戻さない。
 */
export function appendModelCodes(saleId: string, codes: string[]): boolean {
  const sale = db.prepare(
    'SELECT kind, source, model_codes, created_at, updated_at FROM sale WHERE id = ?',
  ).get(saleId) as
    | { kind: SaleKind; source: string; model_codes: string; created_at: string; updated_at: string }
    | undefined
  if (!sale) return false

  const existing = JSON.parse(sale.model_codes || '[]') as string[]
  const seen = new Set(existing)
  const merged = [...existing]
  for (const c of codes) {
    if (!seen.has(c)) {
      seen.add(c)
      merged.push(c)
    }
  }
  if (merged.length === existing.length) return false

  const keyword = settingStr('mercari_keyword', '')
  // source='collector' かつ一度も更新されていない（=人が手で触っていない）ときだけ救済する
  const untouched = sale.source === 'collector' && sale.updated_at === sale.created_at
  const kind: SaleKind =
    sale.kind === 'personal' && !keyword && merged.length > 0 && untouched ? 'resale' : sale.kind

  db.prepare(
    `UPDATE sale SET model_codes = ?, kind = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(merged), kind, saleId)

  autoLinkSale(saleId)
  return true
}

/** 記号と空白を落として比較用のキーを作る */
function normalizeName(s: string): string {
  return s.replace(/[\s　【】\[\]（）()／/・,、。]/g, '').toLowerCase()
}

/**
 * 在庫候補を返す。並びは 型番完全一致 → シリーズ一致 → 商品名の類似度
 * （完全一致 → 前方一致 → 部分一致 → 残り）。同順位は滞留日数が長い方を先に
 * （型番一致の中では先入先出と同じ順になる）。
 * SQL側では正規化できないため、in_stock を全件取ってJS側で並べ替える
 * （規模は月20〜50件程度の想定）。
 */
export function suggestInventory(saleId: string, limit = 20): InventoryItem[] {
  const sale = db.prepare('SELECT title, model_codes FROM sale WHERE id = ?').get(saleId) as
    | { title: string; model_codes: string } | undefined
  if (!sale) return []

  const codes = JSON.parse(sale.model_codes || '[]') as string[]
  const codeSet = new Set(codes)
  const seriesCodes = new Set(codes.map(c => c.split('-')[0]))

  const target = normalizeName(sale.title)
  const head = target.slice(0, 6)

  const items = db.prepare(
    `SELECT * FROM inventory_view WHERE status = 'in_stock'`,
  ).all() as InventoryItem[]

  const rank = (item: InventoryItem): number => {
    if (item.model_code && codeSet.has(item.model_code)) return 0
    if (item.series_code && seriesCodes.has(item.series_code)) return 1
    const n = normalizeName(item.name)
    if (n === target) return 2
    if (head && n.startsWith(head)) return 3
    if (head && n.includes(head)) return 4
    return 5
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

/** name/model_code/series_code/material/note のみ変更可能。landed_cost は触らない */
export function updateInventory(id: string, patch: InventoryPatch): void {
  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }

  if (patch.name !== undefined) put('name', patch.name)
  if (patch.model_code !== undefined) put('model_code', patch.model_code)
  if (patch.series_code !== undefined) put('series_code', patch.series_code)
  if (patch.material !== undefined) put('material', patch.material)
  if (patch.note !== undefined) put('note', patch.note)
  if (sets.length === 0) return

  put('updated_at', new Date().toISOString())
  vals.push(id)
  db.prepare(`UPDATE inventory_item SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

/**
 * ばらして売る：in_stock の1点を count 点に分割する。
 * landed_cost は等分し端数は最後の子へ（合計は親と一致）。親は status='split' で残し、
 * 過去の原価（landed_cost）はここでも一切書き換えない。
 */
export function splitInventory(id: string, count: number): string[] {
  if (count < 2) throw new Error('分割数は2以上にしてください')

  const item = db.prepare('SELECT * FROM inventory_item WHERE id = ?').get(id) as
    | {
        id: string
        purchase_line_id: string | null
        name: string
        landed_cost: number
        acquired_at: string
        status: InventoryStatus
        model_code: string | null
        series_code: string | null
        material: string | null
      }
    | undefined
  if (!item) throw new Error('在庫が見つかりません')
  if (item.status !== 'in_stock') throw new Error('未販売の在庫のみ分割できます')

  const parts = splitEvenly(item.landed_cost, count)
  const childIds: string[] = []

  const insItem = db.prepare(
    `INSERT INTO inventory_item
       (id, purchase_line_id, name, landed_cost, acquired_at, status,
        model_code, series_code, material, parent_id)
     VALUES (?, ?, ?, ?, ?, 'in_stock', ?, ?, ?, ?)`,
  )

  const tx = db.transaction(() => {
    for (let n = 0; n < count; n++) {
      const childId = randomUUID()
      insItem.run(
        childId, item.purchase_line_id, item.name, parts[n], item.acquired_at,
        item.model_code, item.series_code, item.material, item.id,
      )
      childIds.push(childId)
    }
    db.prepare(`UPDATE inventory_item SET status = 'split', updated_at = datetime('now') WHERE id = ?`)
      .run(id)
  })
  tx()

  return childIds
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

export function listVariantSummary(
  sort: 'total_profit' | 'avg_profit' | 'sold' = 'total_profit',
): VariantSummary[] {
  const col = sort === 'avg_profit' ? 'avg_profit' : sort === 'sold' ? 'sold' : 'total_profit'
  return db.prepare(
    `SELECT * FROM variant_summary ORDER BY ${col} DESC`,
  ).all() as VariantSummary[]
}

export function getDashboard(): DashboardStats {
  const one = <T>(sql: string, ...v: unknown[]) => db.prepare(sql).get(...v) as T

  const needsShipping = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale WHERE is_shipping_confirmed = 0`).c

  const needsMatch = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale_profit WHERE unmatched = 1 AND kind = 'resale'`).c

  const needsPurchaseConfirm = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM purchase WHERE status = 'draft'`).c

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
    needsPurchaseConfirm,
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

export function createShopAccount(name: string, kind: ShopAccountKind = 'other'): string {
  const id = randomUUID()
  db.prepare('INSERT INTO shop_account (id, name, kind) VALUES (?, ?, ?)').run(id, name, kind)
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
  rows: Array<{
    mercariItemId: string
    title: string
    description?: string
    price: number
    soldAt: string
  }>,
): number {
  const rateBp = setting('fee_rate_bp', 1000)
  // 空なら「型番が抜けるか」で転売/私物を判定。空でなければキーワード（部分一致・大小無視）で判定
  const keyword = settingStr('mercari_keyword', '')

  const ins = db.prepare(
    `INSERT INTO sale
       (id, mercari_item_id, title, sold_at, price, kind,
        fee_rate_bp, fee, source, raw, is_shipping_confirmed, model_codes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'collector', ?, 0, ?)`,
  )

  const insertedIds: string[] = []
  const tx = db.transaction(() => {
    for (const r of rows) {
      const text = r.title + (r.description ? ' ' + r.description : '')
      const codes = extractCodes(text)
      const kind: SaleKind = keyword
        ? (text.toLowerCase().includes(keyword.toLowerCase()) ? 'resale' : 'personal')
        : (codes.length > 0 ? 'resale' : 'personal')

      const id = randomUUID()
      ins.run(
        id, r.mercariItemId, r.title, r.soldAt, r.price, kind,
        rateBp, calcFee(r.price, rateBp), JSON.stringify(r), JSON.stringify(codes),
      )
      insertedIds.push(id)
    }
  })
  tx()

  // 型番が完全一致する分は自動確定する
  for (const id of insertedIds) autoLinkSale(id)

  return rows.length
}

// ============================================================
// エクスポート
// ============================================================

export function exportRows(): string {
  const rows = db.prepare(`
    SELECT
      sp.sold_at         AS 販売日,
      sp.title           AS 商品名,
      CASE sp.kind WHEN 'resale' THEN '転売' ELSE '私物' END AS 区分,
      sp.price           AS 販売価格,
      sp.fee             AS 販売手数料,
      sp.shipping_fee    AS 送料,
      sp.shipping_source AS 送料区分,
      sp.packaging_cost  AS 梱包材,
      sp.cost            AS 原価,
      sp.gross_profit    AS 粗利,
      sp.item_count      AS 紐付け点数,
      sp.model_codes     AS 型番,
      sp.mercari_item_id AS 取引ID
    FROM sale_profit sp
    ORDER BY sp.sold_at
  `).all() as Array<Record<string, unknown>>

  if (rows.length === 0) return ''

  // model_codes は JSON 配列で入っているので '|' 区切りの文字列に直す
  for (const r of rows) {
    const raw = r['型番']
    if (typeof raw === 'string') {
      try {
        r['型番'] = (JSON.parse(raw) as string[]).join('|')
      } catch {
        // 壊れたJSONはそのまま出す
      }
    }
  }

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
