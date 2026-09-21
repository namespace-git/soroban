import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { app } from 'electron'
// ビルド後もスキーマを確実に読めるよう、ファイル読み込みではなく埋め込む
import schemaSql from './schema.sql?raw'
import { allocate, calcFee, splitEvenly } from './money'
import { extractCode, extractCodeQuantities, extractCodes, extractItemCodes, extractMaterial } from './code'
import { thisMonthLocal, todayLocal } from '../shared/date'
import type {
  AllocMethod, DashboardStats, Expense, ExpenseCategory, ExpenseInput, ExpenseLine, Fulfillment,
  InventoryItem, InventoryPatch, InventoryStatus, ItemTimeline, LinkSource, Listing, ListingStatus,
  Material, MonthClose, MonthDetail, MonthlySummary, MonthSaleRow, MonthTotals, ProductDetail,
  ProductMonthPoint, ProductSummary, PurchaseDetail,
  PurchaseDraftInput, PurchaseImportResult, PurchaseInput, PurchaseLine, PurchaseLineInput, PurchaseStatus,
  PurchaseSummary, SaleFilter, SaleInput, SaleKind, SalePatch, SaleProfit, SaleStatus, SaleTotals,
  SearchHit, ShippingMethod, ShopAccount, ShopAccountKind, ShopAccountStats, Tag, TimelineEvent, VariantSummary,
  CollectorRun, RunStatus, CollectorSource,
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
  // 検証用：環境変数で別ファイルを指せる（本番では未設定）
  return process.env.SOROBAN_DB_PATH || join(app.getPath('userData'), 'soroban.db')
}

/**
 * 保存したサムネイルのファイル名（例 'm87039845554.jpg'）を、レンダラーが
 * <img src> にそのまま渡せる soroban-thumb:// URL に直す。DB には file 名だけ持つ
 * （URL の組み立ては常にここ1か所で行う）。
 */
export function toThumbUrl(file: string | null): string | null {
  return file ? `soroban-thumb://${file}` : null
}

/** 金額を桁区切りの「¥2,699」形式にする。getItemTimeline の title/detail で使う */
function yenText(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`
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

/**
 * 在庫コードを1つ発行する（setting.item_code_seq を+1）。形式は `S-0001`
 * （4桁ゼロ埋め。9999を超えたら桁が増える）。呼び出し側のトランザクション内で使うこと
 */
function nextItemCode(): string {
  const next = setting('item_code_seq', 0) + 1
  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('item_code_seq', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
  ).run(String(next), String(next))
  return `S-${String(next).padStart(4, '0')}`
}

/**
 * mercari_keyword を「,」「、」空白（全角/半角）・改行区切りの複数語として解釈する。
 * 前後の空白は除去、空要素は無視、大小文字は無視する。
 */
export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,、\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
}

/** text がキーワードのどれか1つでも含んでいれば true（大小無視） */
export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k))
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
    // sale_line・listing_line 側のトリガーが inventory_item を名指しで参照しているため、
    // DROP TABLE の前に一旦外しておく（残したままだと ALTER TABLE ... RENAME 時に
    // "no such table" になる。SQLite は RENAME 時に他オブジェクトの参照を検証するため）
    // Phase 1 のビューも inventory_item を参照している。DROP TABLE の前に外す
    // （ビューは migrate() の後に viewsSql が作り直す）
    // inventory_tag も inventory_item を参照する外部キーを持つため、存在するなら
    // 先に落としておく（version<3 の段階で作り直される想定。通常は存在しない）
    db.exec(`
      DROP VIEW IF EXISTS sale_line_share;
      DROP VIEW IF EXISTS sale_profit;
      DROP VIEW IF EXISTS monthly_summary;
      DROP VIEW IF EXISTS inventory_view;
      DROP VIEW IF EXISTS variant_summary;
      DROP TRIGGER IF EXISTS trg_sline_sold;
      DROP TRIGGER IF EXISTS trg_sline_unsold;
      DROP TRIGGER IF EXISTS trg_listing_line_guard;
      DROP TABLE IF EXISTS inventory_tag;
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

    // listing_line が無い（このDBがまだ version<8 に上がっていない）ことがあるため、
    // 存在するときだけ trg_listing_line_guard を作り直す
    if (db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listing_line'`,
    ).get()) {
      db.exec(`
        CREATE TRIGGER trg_listing_line_guard
        BEFORE INSERT ON listing_line
        BEGIN
          SELECT RAISE(ABORT, '既に別の出品に引き当て済み')
           WHERE EXISTS (
             SELECT 1 FROM listing_line ll
             JOIN listing l ON l.mercari_item_id = ll.listing_id
             WHERE ll.inventory_item_id = NEW.inventory_item_id
               AND l.status IN ('active','suspended')
           );
          SELECT RAISE(ABORT, '未販売の在庫だけ引き当てられます')
           WHERE (SELECT status FROM inventory_item WHERE id = NEW.inventory_item_id) != 'in_stock';
          SELECT RAISE(ABORT, '終了した出品には引き当てられません')
           WHERE (SELECT status FROM listing WHERE mercari_item_id = NEW.listing_id) NOT IN ('active','suspended');
        END;
      `)
    }
  })
  tx()
  db.pragma('foreign_keys = ON')
}

function saleLineHasListingSource(): boolean {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sale_line'`,
  ).get() as { sql: string } | undefined
  return !!row && row.sql.includes("'listing'")
}

/**
 * sale_line.link_source の CHECK に 'listing' を足す。inventory_item を分割対応に
 * 作り直したとき（rebuildInventoryItemForSplit）と同じ流儀：ビュー・トリガーを
 * 先に DROP → 新テーブルへコピー → 旧を DROP → RENAME → トリガー再作成。
 * データ（既存の紐付け）は一切落とさない。
 */
function rebuildSaleLineForListingSource(): void {
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => {
    db.exec(`
      DROP VIEW IF EXISTS sale_line_share;
      DROP VIEW IF EXISTS sale_profit;
      DROP VIEW IF EXISTS monthly_summary;
      DROP VIEW IF EXISTS inventory_view;
      DROP VIEW IF EXISTS variant_summary;
      DROP TRIGGER IF EXISTS trg_sline_sold;
      DROP TRIGGER IF EXISTS trg_sline_unsold;
    `)

    db.exec(`
      CREATE TABLE sale_line_new (
        id                TEXT PRIMARY KEY,
        sale_id           TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL UNIQUE REFERENCES inventory_item(id),
        link_source       TEXT NOT NULL DEFAULT 'manual'
                          CHECK (link_source IN ('auto','manual','listing')),
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO sale_line_new (id, sale_id, inventory_item_id, link_source, created_at)
      SELECT id, sale_id, inventory_item_id, link_source, created_at FROM sale_line;

      DROP TABLE sale_line;
      ALTER TABLE sale_line_new RENAME TO sale_line;

      CREATE INDEX IF NOT EXISTS idx_sline_sale ON sale_line(sale_id);

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

function saleHasWaitingPaymentStatus(): boolean {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sale'`,
  ).get() as { sql: string } | undefined
  return !!row && row.sql.includes("'waiting_payment'")
}

/**
 * sale.status の CHECK に 'waiting_payment'（購入されたが未入金）を足す。取引中タブは
 * 支払い待ちの段階からここに出るため、waiting_shipment に決め打てない。
 * rebuildSaleLineForListingSource と同じ流儀：sale を参照するビューを先に DROP →
 * 新テーブルへ列をそのままコピー → 旧を DROP → RENAME。データは一切落とさない。
 */
function rebuildSaleForWaitingPayment(): void {
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => {
    db.exec(`
      DROP VIEW IF EXISTS sale_line_share;
      DROP VIEW IF EXISTS variant_summary;
      DROP VIEW IF EXISTS sale_profit;
      DROP VIEW IF EXISTS monthly_summary;
      DROP VIEW IF EXISTS inventory_view;
    `)

    db.exec(`
      CREATE TABLE sale_new (
        id                 TEXT PRIMARY KEY,
        mercari_item_id    TEXT UNIQUE,
        title              TEXT NOT NULL,
        sold_at            TEXT NOT NULL,
        price              INTEGER NOT NULL,
        kind               TEXT NOT NULL DEFAULT 'resale'
                           CHECK (kind IN ('resale','personal')),
        fee_rate_bp        INTEGER NOT NULL DEFAULT 1000,
        fee                INTEGER NOT NULL DEFAULT 0,
        shipping_method_id TEXT REFERENCES shipping_method(id),
        shipping_fee       INTEGER NOT NULL DEFAULT 0,
        packaging_cost     INTEGER NOT NULL DEFAULT 0,
        shipping_source    TEXT CHECK (shipping_source IN ('actual','master','manual')),
        is_shipping_confirmed INTEGER NOT NULL DEFAULT 0,
        model_codes        TEXT NOT NULL DEFAULT '[]',
        expected_item_count INTEGER,
        status             TEXT
                           CHECK (status IN ('waiting_payment','waiting_shipment','shipped','delivered','completed')),
        shipped_at         TEXT,
        delivered_at       TEXT,
        completed_at       TEXT,
        buyer              TEXT,
        note               TEXT,
        source             TEXT NOT NULL DEFAULT 'collector'
                           CHECK (source IN ('collector','manual')),
        raw                TEXT,
        thumb_file         TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO sale_new
        (id, mercari_item_id, title, sold_at, price, kind, fee_rate_bp, fee,
         shipping_method_id, shipping_fee, packaging_cost, shipping_source,
         is_shipping_confirmed, model_codes, expected_item_count, status,
         shipped_at, delivered_at, completed_at, buyer, note, source, raw,
         thumb_file, created_at, updated_at)
      SELECT
        id, mercari_item_id, title, sold_at, price, kind, fee_rate_bp, fee,
        shipping_method_id, shipping_fee, packaging_cost, shipping_source,
        is_shipping_confirmed, model_codes, expected_item_count, status,
        shipped_at, delivered_at, completed_at, buyer, note, source, raw,
        thumb_file, created_at, updated_at
      FROM sale;

      DROP TABLE sale;
      ALTER TABLE sale_new RENAME TO sale;

      CREATE INDEX IF NOT EXISTS idx_sale_sold ON sale(sold_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sale_kind ON sale(kind);
    `)
  })
  tx()
  db.pragma('foreign_keys = ON')
}

function inventoryHasItemCodeConstraint(): boolean {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_item'`,
  ).get() as { sql: string } | undefined
  return !!row && /item_code\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql)
}

/**
 * inventory_item.item_code に NOT NULL UNIQUE を付ける。呼び出し時点で全行に
 * item_code が採番済みである前提（migrate() の version<15 で先に埋めてから呼ぶ）。
 * ALTER TABLE では UNIQUE 制約を後付けできないため、他の列追加と同じ流儀
 * （rebuildInventoryItemForSplit）でテーブルを作り直す。
 */
function rebuildInventoryItemForItemCode(): void {
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => {
    db.exec(`
      DROP VIEW IF EXISTS sale_line_share;
      DROP VIEW IF EXISTS sale_profit;
      DROP VIEW IF EXISTS monthly_summary;
      DROP VIEW IF EXISTS inventory_view;
      DROP VIEW IF EXISTS variant_summary;
      DROP TRIGGER IF EXISTS trg_sline_sold;
      DROP TRIGGER IF EXISTS trg_sline_unsold;
      DROP TRIGGER IF EXISTS trg_listing_line_guard;
    `)

    db.exec(`
      CREATE TABLE inventory_item_new (
        id               TEXT PRIMARY KEY,
        item_code        TEXT NOT NULL UNIQUE,
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
        (id, item_code, purchase_line_id, name, landed_cost, acquired_at,
         model_code, series_code, material, parent_id, note,
         status, disposed_at, disposed_note, created_at, updated_at)
      SELECT
        id, item_code, purchase_line_id, name, landed_cost, acquired_at,
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

      CREATE TRIGGER trg_listing_line_guard
      BEFORE INSERT ON listing_line
      BEGIN
        SELECT RAISE(ABORT, '既に別の出品に引き当て済み')
         WHERE EXISTS (
           SELECT 1 FROM listing_line ll
           JOIN listing l ON l.mercari_item_id = ll.listing_id
           WHERE ll.inventory_item_id = NEW.inventory_item_id
             AND l.status IN ('active','suspended')
         );
        SELECT RAISE(ABORT, '未販売の在庫だけ引き当てられます')
         WHERE (SELECT status FROM inventory_item WHERE id = NEW.inventory_item_id) != 'in_stock';
        SELECT RAISE(ABORT, '終了した出品には引き当てられません')
         WHERE (SELECT status FROM listing WHERE mercari_item_id = NEW.listing_id) NOT IN ('active','suspended');
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

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '2')
         ON CONFLICT(key) DO UPDATE SET value = '2'`,
    ).run()
  }

  if (version < 3) {
    // タグ（2-I）。tag は新規テーブルなので ALTER 不要。CASCADE で
    // 販売・在庫からの付け外しが tag 削除に追従する（T-04）
    db.exec(`
      CREATE TABLE IF NOT EXISTS tag (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sale_tag (
        sale_id TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
        tag_id  TEXT NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
        PRIMARY KEY (sale_id, tag_id)
      );
      CREATE TABLE IF NOT EXISTS inventory_tag (
        inventory_item_id TEXT NOT NULL REFERENCES inventory_item(id) ON DELETE CASCADE,
        tag_id            TEXT NOT NULL REFERENCES tag(id)            ON DELETE CASCADE,
        PRIMARY KEY (inventory_item_id, tag_id)
      );
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '3')
         ON CONFLICT(key) DO UPDATE SET value = '3'`,
    ).run()
  }

  if (version < 4) {
    addColumnIfMissing('collector_run', 'source',
      `TEXT NOT NULL DEFAULT 'mercari' CHECK (source IN ('mercari','mellojoy'))`)
    addColumnIfMissing('collector_run', 'shop_account_id', 'TEXT REFERENCES shop_account(id)')
    db.exec(`CREATE INDEX IF NOT EXISTS idx_run_source_started ON collector_run(source, started_at DESC)`)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '4')
         ON CONFLICT(key) DO UPDATE SET value = '4'`,
    ).run()
  }

  if (version < 5) {
    addColumnIfMissing('purchase', 'fulfillment',
      `TEXT CHECK (fulfillment IN ('pending','shipped','delivered'))`)
    addColumnIfMissing('purchase', 'fulfillment_updated_at', 'TEXT')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '5')
         ON CONFLICT(key) DO UPDATE SET value = '5'`,
    ).run()
  }

  if (version < 6) {
    // 販売履歴のサムネイル（ファイル名のみ。URL化は toThumbUrl で行う）
    addColumnIfMissing('sale', 'thumb_file', 'TEXT')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '6')
         ON CONFLICT(key) DO UPDATE SET value = '6'`,
    ).run()
  }

  if (version < 7) {
    // 仕入の到着日（到着状態が shipped/delivered になったのを最初に観測した日）
    addColumnIfMissing('purchase', 'shipped_at', 'TEXT')
    addColumnIfMissing('purchase', 'delivered_at', 'TEXT')
    // v5〜v6 で既に到着状態だけ付いている仕入は、状態を観測した日で埋める（履歴を「予定」にしない）
    db.exec(`
      UPDATE purchase SET shipped_at = date(fulfillment_updated_at)
       WHERE shipped_at IS NULL AND fulfillment IN ('shipped','delivered') AND fulfillment_updated_at IS NOT NULL;
      UPDATE purchase SET delivered_at = date(fulfillment_updated_at)
       WHERE delivered_at IS NULL AND fulfillment = 'delivered' AND fulfillment_updated_at IS NOT NULL;
    `)

    // メルカリの取引の進み具合。collector はまだ埋めない（列と配線だけ）
    addColumnIfMissing('sale', 'status',
      `TEXT CHECK (status IN ('waiting_shipment','shipped','delivered','completed'))`)
    addColumnIfMissing('sale', 'shipped_at', 'TEXT')
    addColumnIfMissing('sale', 'delivered_at', 'TEXT')
    addColumnIfMissing('sale', 'completed_at', 'TEXT')
    addColumnIfMissing('sale', 'buyer', 'TEXT')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '7')
         ON CONFLICT(key) DO UPDATE SET value = '7'`,
    ).run()
  }

  if (version < 8) {
    // 出品（メルカリの出品中タブ）と在庫の引き当て。新規DBは schema.sql（tablesSql）で
    // 既に作られているので、ここは既存DBを追いつかせるための冪等な処理になる
    db.exec(`
      CREATE TABLE IF NOT EXISTS listing (
        mercari_item_id TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        price           INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','sold','ended')),
        first_seen_at   TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL,
        thumb_file      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS listing_line (
        id                TEXT PRIMARY KEY,
        listing_id        TEXT NOT NULL REFERENCES listing(mercari_item_id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL REFERENCES inventory_item(id),
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_listing_line_listing ON listing_line(listing_id);
      CREATE INDEX IF NOT EXISTS idx_listing_line_item    ON listing_line(inventory_item_id);
      CREATE TRIGGER IF NOT EXISTS trg_listing_line_guard
      BEFORE INSERT ON listing_line
      BEGIN
        SELECT RAISE(ABORT, '既に別の出品に引き当て済み')
         WHERE EXISTS (
           SELECT 1 FROM listing_line ll
           JOIN listing l ON l.mercari_item_id = ll.listing_id
           WHERE ll.inventory_item_id = NEW.inventory_item_id
             AND l.status IN ('active','suspended')
         );
        SELECT RAISE(ABORT, '未販売の在庫だけ引き当てられます')
         WHERE (SELECT status FROM inventory_item WHERE id = NEW.inventory_item_id) != 'in_stock';
        SELECT RAISE(ABORT, '終了した出品には引き当てられません')
         WHERE (SELECT status FROM listing WHERE mercari_item_id = NEW.listing_id) NOT IN ('active','suspended');
      END;
    `)

    // SQLite は既存の CHECK 制約を ALTER できないため、sale_line.link_source に
    // 'listing' が無ければテーブルを作り直す
    if (!saleLineHasListingSource()) rebuildSaleLineForListingSource()

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '8')
         ON CONFLICT(key) DO UPDATE SET value = '8'`,
    ).run()
  }

  if (version < 9) {
    // 仕入のタグ（purchase_tag）。sale_tag / inventory_tag と同じ流儀。
    // 新規テーブルなので ALTER 不要。CASCADE で仕入・タグ削除に追従する
    db.exec(`
      CREATE TABLE IF NOT EXISTS purchase_tag (
        purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
        tag_id      TEXT NOT NULL REFERENCES tag(id)      ON DELETE CASCADE,
        PRIMARY KEY (purchase_id, tag_id)
      );
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '9')
         ON CONFLICT(key) DO UPDATE SET value = '9'`,
    ).run()
  }

  if (version < 10) {
    // 期間費用（R-05）。auto=1 は振込手数料の自動計上（月1件）。
    // expense_auto_month は「その月に自動計上を検討したか」の記録。
    // auto=1 の行を人が消しても、この記録が残る限り再作成しない
    addColumnIfMissing('expense', 'auto', 'INTEGER NOT NULL DEFAULT 0')
    db.exec(`
      CREATE TABLE IF NOT EXISTS expense_auto_month (
        month      TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '10')
         ON CONFLICT(key) DO UPDATE SET value = '10'`,
    ).run()
  }

  if (version < 11) {
    // Codexレビュー指摘：終了済み（sold/ended）の出品にも引き当てられてしまっていた。
    // 引き当て先の listing 自身の status を見るチェックを追加してトリガーを作り直す
    db.exec(`
      DROP TRIGGER IF EXISTS trg_listing_line_guard;
      CREATE TRIGGER trg_listing_line_guard
      BEFORE INSERT ON listing_line
      BEGIN
        SELECT RAISE(ABORT, '既に別の出品に引き当て済み')
         WHERE EXISTS (
           SELECT 1 FROM listing_line ll
           JOIN listing l ON l.mercari_item_id = ll.listing_id
           WHERE ll.inventory_item_id = NEW.inventory_item_id
             AND l.status IN ('active','suspended')
         );
        SELECT RAISE(ABORT, '未販売の在庫だけ引き当てられます')
         WHERE (SELECT status FROM inventory_item WHERE id = NEW.inventory_item_id) != 'in_stock';
        SELECT RAISE(ABORT, '終了した出品には引き当てられません')
         WHERE (SELECT status FROM listing WHERE mercari_item_id = NEW.listing_id) NOT IN ('active','suspended');
      END;
    `)

    // Codexレビュー指摘：listing.last_seen_at が datetime('now')（'YYYY-MM-DD HH:MM:SS'）で
    // 保存されており、画面側が collector_run.finished_at（ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'）と
    // 文字列比較すると常に不一致になっていた。既存行を ISO 形式へ変換する
    // （'T' を含まない = 未変換の行だけ。新規保存分は upsertListings 側で ISO にする）
    db.exec(`
      UPDATE listing SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at)
       WHERE last_seen_at NOT LIKE '%T%';
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '11')
         ON CONFLICT(key) DO UPDATE SET value = '11'`,
    ).run()
  }

  if (version < 12) {
    // 仕入先ごとの取り込みキーワード（商品名がどれかに一致する明細だけ取り込む）
    addColumnIfMissing('shop_account', 'import_keywords', 'TEXT')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '12')
         ON CONFLICT(key) DO UPDATE SET value = '12'`,
    ).run()
  }

  if (version < 13) {
    // 出品日（推定）・いいね数・出品時に決めた発送方法
    addColumnIfMissing('listing', 'listed_at', `TEXT NOT NULL DEFAULT ''`)
    // 既存行は first_seen_at で埋める（新規行は upsertListings が候補日を入れる）
    db.exec(`UPDATE listing SET listed_at = first_seen_at WHERE listed_at = ''`)
    addColumnIfMissing('listing', 'likes', 'INTEGER')
    addColumnIfMissing('listing', 'shipping_method_id',
      'TEXT REFERENCES shipping_method(id) ON DELETE SET NULL')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '13')
         ON CONFLICT(key) DO UPDATE SET value = '13'`,
    ).run()
  }

  if (version < 14) {
    // 商品（型番）タグ・仕入先の自動タグ。新規テーブルなので ALTER 不要。
    // CASCADE でタグ削除・仕入先削除に追従する
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_tag (
        model_code TEXT NOT NULL,
        tag_id     TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
        PRIMARY KEY (model_code, tag_id)
      );
      CREATE TABLE IF NOT EXISTS shop_account_tag (
        shop_account_id TEXT NOT NULL REFERENCES shop_account(id) ON DELETE CASCADE,
        tag_id          TEXT NOT NULL REFERENCES tag(id)          ON DELETE CASCADE,
        PRIMARY KEY (shop_account_id, tag_id)
      );
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '14')
         ON CONFLICT(key) DO UPDATE SET value = '14'`,
    ).run()
  }

  if (version < 15) {
    // 在庫コード（item_code）。既存の在庫に acquired_at, created_at 順で採番して埋めてから
    // NOT NULL UNIQUE を付ける（ALTER TABLE では UNIQUE を後付けできないためテーブルを作り直す）
    addColumnIfMissing('inventory_item', 'item_code', 'TEXT')

    const uncoded = db.prepare(
      `SELECT id FROM inventory_item WHERE item_code IS NULL ORDER BY acquired_at, created_at`,
    ).all() as Array<{ id: string }>
    if (uncoded.length > 0) {
      let seq = setting('item_code_seq', 0)
      const setCode = db.prepare('UPDATE inventory_item SET item_code = ? WHERE id = ?')
      for (const row of uncoded) {
        seq += 1
        setCode.run(`S-${String(seq).padStart(4, '0')}`, row.id)
      }
      db.prepare(
        `INSERT INTO setting (key, value) VALUES ('item_code_seq', ?)
           ON CONFLICT(key) DO UPDATE SET value = ?`,
      ).run(String(seq), String(seq))
    }

    if (!inventoryHasItemCodeConstraint()) rebuildInventoryItemForItemCode()

    // 自動紐付けが「これだけ揃えば完了」と見積もった点数（在庫コード・型番の個数表記）
    addColumnIfMissing('sale', 'expected_item_count', 'INTEGER')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '15')
         ON CONFLICT(key) DO UPDATE SET value = '15'`,
    ).run()
  }

  if (version < 16) {
    // 取引中タブは「支払いをしてください」（購入されたが未入金）の段階からも出る。
    // sale.status の CHECK に 'waiting_payment' を足す（SQLite は CHECK を ALTER できない
    // ためテーブルを作り直す。列・データはそのまま）
    if (!saleHasWaitingPaymentStatus()) rebuildSaleForWaitingPayment()

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '16')
         ON CONFLICT(key) DO UPDATE SET value = '16'`,
    ).run()
  }

  if (version < 17) {
    // 仕入先ごとの送料の既定値（手入力の仕入フォームで、この仕入先を選んだときに入る）
    addColumnIfMissing('shop_account', 'default_shipping_fee', 'INTEGER')

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '17')
         ON CONFLICT(key) DO UPDATE SET value = '17'`,
    ).run()
  }

  if (version < 18) {
    // 経費の明細（expense_line）・計上月（month）・購入店（shop）・レシート（receipt_file）。
    // 振込手数料の自動計上は撤去（expense_auto_month は DROP。過去の auto=1 行は残す）
    addColumnIfMissing('expense', 'month', `TEXT NOT NULL DEFAULT ''`)
    db.exec(`UPDATE expense SET month = substr(occurred_at, 1, 7) WHERE month = ''`)
    addColumnIfMissing('expense', 'shop', 'TEXT')
    addColumnIfMissing('expense', 'receipt_file', 'TEXT')
    db.exec(`CREATE INDEX IF NOT EXISTS idx_expense_month ON expense(month)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS expense_line (
        id         TEXT PRIMARY KEY,
        expense_id TEXT NOT NULL REFERENCES expense(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        quantity   INTEGER NOT NULL DEFAULT 1,
        category   TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_expense_line_expense ON expense_line(expense_id);

      CREATE TABLE IF NOT EXISTS month_book (
        month         TEXT PRIMARY KEY,
        alloc_method  TEXT NOT NULL DEFAULT 'by_amount'
                      CHECK (alloc_method IN ('by_amount','by_quantity')),
        closed_at     TEXT,
        sales_count   INTEGER,
        revenue       INTEGER,
        gross_profit  INTEGER,
        expense_total INTEGER,
        net_profit    INTEGER
      );

      DROP TABLE IF EXISTS expense_auto_month;
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '18')
         ON CONFLICT(key) DO UPDATE SET value = '18'`,
    ).run()
  }

  if (version < 19) {
    // 経費の明細を「単価 × 数量 ＝ 金額」にする。既存行は amount が行の合計だったため、
    // 割り切れれば unit_price = amount / quantity、割り切れなければ unit_price = amount, quantity = 1
    // に寄せる（amount 自体は変えない＝合計は動かさない）
    addColumnIfMissing('expense_line', 'unit_price', 'INTEGER NOT NULL DEFAULT 0')
    const lineRows = db.prepare('SELECT id, amount, quantity FROM expense_line').all() as
      Array<{ id: string; amount: number; quantity: number }>
    const updLine = db.prepare('UPDATE expense_line SET unit_price = ?, quantity = ? WHERE id = ?')
    for (const r of lineRows) {
      if (r.quantity > 0 && r.amount % r.quantity === 0) {
        updLine.run(r.amount / r.quantity, r.quantity, r.id)
      } else {
        updLine.run(r.amount, 1, r.id)
      }
    }

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '19')
         ON CONFLICT(key) DO UPDATE SET value = '19'`,
    ).run()
  }

  if (version < 20) {
    // レシートの登録番号（T＋13桁）→ 店名の学習。新規テーブルなので ALTER 不要
    db.exec(`
      CREATE TABLE IF NOT EXISTS shop_alias (
        key        TEXT PRIMARY KEY,
        shop       TEXT NOT NULL,
        hits       INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '20')
         ON CONFLICT(key) DO UPDATE SET value = '20'`,
    ).run()
  }

  if (version < 21) {
    // 型番ごとの表示名（人が上書き）。新規テーブルなので ALTER 不要。resetData() では消さない
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_name (
        model_code TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('schema_version', '21')
         ON CONFLICT(key) DO UPDATE SET value = '21'`,
    ).run()
  }

  // mellojoy-watch の取り込みは取りやめた（ユーザーの指示）。
  // schema.sql の既定値挿入（毎起動・IF NOT EXISTS）で入り直しても構わないよう、
  // バージョンに関係なく毎回消しておく
  db.exec(
    `DELETE FROM setting WHERE key IN ('mellojoy_watch_dir', 'mellojoy_default_account_id')`,
  )
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

/**
 * fulfillment の初期値から shipped_at / delivered_at を決める。
 * shipped 以上なら発送日を今日、delivered なら到着日も今日にする
 * （updatePurchaseFulfillment と同じ規則。後から追いつく分は null のままにして
 * updatePurchaseFulfillment 側で最初に観測した日を刻む）。
 */
function initialFulfillmentDates(
  fulfillment: Fulfillment | null | undefined,
): { shipped_at: string | null; delivered_at: string | null } {
  if (fulfillment === 'delivered') {
    const today = todayLocal()
    return { shipped_at: today, delivered_at: today }
  }
  if (fulfillment === 'shipped') {
    return { shipped_at: todayLocal(), delivered_at: null }
  }
  return { shipped_at: null, delivered_at: null }
}

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
       (id, item_code, purchase_line_id, name, landed_cost, acquired_at,
        model_code, series_code, material)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // landed_cost・item_code はここで確定し、以後は独立（過去の利益を動かさない）
    const parts = splitEvenly(a.allocated, l.quantity)
    for (let n = 0; n < l.quantity; n++) {
      insItem.run(
        randomUUID(), nextItemCode(), l.id, l.name, l.unit_price + parts[n], orderedAt,
        l.model_code, l.series_code, l.material,
      )
    }
  }
}

/**
 * 仕入先アカウントの自動タグを、作成した仕入の purchase_tag に足す（作成時だけ）。
 * 後から setPurchaseTags で外しても、ここでは再付与しない。
 */
function applyShopAccountAutoTags(purchaseId: string, shopAccountId: string): void {
  const rows = db.prepare(
    'SELECT tag_id FROM shop_account_tag WHERE shop_account_id = ?',
  ).all(shopAccountId) as Array<{ tag_id: string }>
  if (rows.length === 0) return
  const ins = db.prepare('INSERT OR IGNORE INTO purchase_tag (purchase_id, tag_id) VALUES (?, ?)')
  for (const r of rows) ins.run(purchaseId, r.tag_id)
}

/**
 * order_no の前後の空白を除く。空文字・空白のみは null（UNIQUE制約に引っかからない値）。
 */
function normalizeOrderNo(orderNo: string | null | undefined): string | null {
  if (orderNo == null) return null
  const trimmed = orderNo.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 同じ仕入先に同じ注文番号の仕入が既にあれば、その仕入の情報を返す（人が読める文にするため）。
 * order_no が null なら見ない（UNIQUE制約も見ない）。excludeId は自分自身を除くとき（確定時の変更）に使う。
 */
function findDuplicateOrderNo(
  shopAccountId: string, orderNo: string, excludeId?: string,
): { id: string; ordered_at: string } | undefined {
  return db.prepare(
    `SELECT id, ordered_at FROM purchase
      WHERE shop_account_id = ? AND TRIM(order_no) = ? ${excludeId ? 'AND id != ?' : ''}`,
  ).get(...(excludeId ? [shopAccountId, orderNo, excludeId] : [shopAccountId, orderNo])) as
    | { id: string; ordered_at: string } | undefined
}

/**
 * createPurchase / confirmPurchase 共通の入力チェック。
 * SqliteError（UNIQUE/CHECK/NOT NULL違反）がそのまま画面に出ないよう、分かる範囲で先に日本語で弾く。
 * 戻り値は trim 済みの order_no（保存にそのまま使う）。
 */
function validatePurchaseInput(input: PurchaseInput, excludeId?: string): string | null {
  const shop = db.prepare('SELECT id FROM shop_account WHERE id = ?').get(input.shop_account_id)
  if (!shop) throw new Error('仕入先が見つかりません')

  if (!input.lines || input.lines.length === 0) throw new Error('明細がありません')
  input.lines.forEach((l, i) => {
    if (!(l.quantity > 0)) throw new Error(`${i + 1}行目：数量は1以上にしてください`)
    if (l.unit_price < 0) throw new Error(`${i + 1}行目：単価は0以上にしてください`)
  })

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.ordered_at)) {
    throw new Error('注文日はYYYY-MM-DDの形式で入力してください')
  }

  const orderNo = normalizeOrderNo(input.order_no)
  if (orderNo) {
    const dup = findDuplicateOrderNo(input.shop_account_id, orderNo, excludeId)
    if (dup) {
      throw new Error(
        `この仕入先には注文番号「${orderNo}」の仕入が既にあります（${dup.ordered_at} の登録）`,
      )
    }
  }
  return orderNo
}

export function createPurchase(input: PurchaseInput): string {
  if (input.import_key) {
    const exists = db.prepare('SELECT id FROM purchase WHERE import_key = ?').get(input.import_key) as
      | { id: string } | undefined
    if (exists) throw new Error(`同じ注文が既に取り込まれています: ${input.import_key}`)
  }

  const orderNo = validatePurchaseInput(input)

  const purchaseId = randomUUID()
  const shippingFee = input.shipping_fee ?? 0
  const discount = input.discount ?? 0
  const otherCost = input.other_cost ?? 0
  const method = input.alloc_method ?? 'by_amount'

  // 配賦対象額：送料 + その他 − 割引
  const pool = shippingFee + otherCost - discount

  const fulfillment = input.fulfillment ?? null
  const { shipped_at, delivered_at } = initialFulfillmentDates(fulfillment)

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchase
         (id, shop_account_id, ordered_at, order_no,
          shipping_fee, discount, other_cost, alloc_method, note, import_key, status,
          fulfillment, fulfillment_updated_at, shipped_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?,
               CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END, ?, ?)`,
    ).run(
      purchaseId, input.shop_account_id, input.ordered_at,
      orderNo, shippingFee, discount, otherCost,
      method, input.note ?? null, input.import_key ?? null,
      fulfillment, fulfillment, shipped_at, delivered_at,
    )

    insertLinesAndItems(purchaseId, input.lines, pool, method, input.ordered_at)
    applyShopAccountAutoTags(purchaseId, input.shop_account_id)
  })

  tx()
  return purchaseId
}

/**
 * まとめて登録。1件ずつ createPurchase と同じ検証で登録し、失敗した行は理由を付けて返す
 * （全体を止めない）。同じ呼び出しの中で注文番号が重複（同じ仕入先・同じ注文番号が2回）したら、
 * DBへ当たる前に「同じCSVの中で重複」として弾く（空の注文番号は見ない）。
 */
export function importPurchases(inputs: PurchaseInput[]): PurchaseImportResult {
  const result: PurchaseImportResult = { created: 0, skipped: [] }
  // このインポート内だけで見る注文番号の重複チェック（shop_account_id + order_no）
  const seen = new Set<string>()

  inputs.forEach((input, index) => {
    const orderNo = normalizeOrderNo(input.order_no)
    if (orderNo) {
      const key = `${input.shop_account_id}|${orderNo}`
      if (seen.has(key)) {
        result.skipped.push({ index, reason: `同じCSVの中で注文番号「${orderNo}」が重複しています` })
        return
      }
      seen.add(key)
    }

    try {
      createPurchase(input)
      result.created += 1
    } catch (e) {
      result.skipped.push({ index, reason: e instanceof Error ? e.message : String(e) })
    }
  })

  return result
}

/**
 * 注文履歴から積む下書き。価格・送料・注文番号は取れていれば入れ、まだなら0のまま
 * status='draft' で積む。在庫は確定するまで作らない。
 * 同じ import_key が既にあれば飛ばす（''を返す）。
 */
export function createPurchaseDraft(input: PurchaseDraftInput): string {
  const exists = db.prepare('SELECT id FROM purchase WHERE import_key = ?').get(input.import_key) as
    | { id: string } | undefined
  if (exists) return ''

  const purchaseId = randomUUID()
  const shippingFee = input.shipping_fee ?? 0
  const discount = input.discount ?? 0
  const fulfillment = input.fulfillment ?? null
  const { shipped_at, delivered_at } = initialFulfillmentDates(fulfillment)

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchase
         (id, shop_account_id, ordered_at, order_no, shipping_fee, discount, status, import_key, note,
          fulfillment, fulfillment_updated_at, shipped_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?,
               CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END, ?, ?)`,
    ).run(
      purchaseId, input.shop_account_id, input.ordered_at, input.order_no ?? null,
      shippingFee, discount, input.import_key, input.note ?? null,
      fulfillment, fulfillment, shipped_at, delivered_at,
    )

    const insLine = db.prepare(
      `INSERT INTO purchase_line
         (id, purchase_id, name, unit_price, quantity, model_code, series_code, material, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    input.lines.forEach((l, i) => {
      const extracted = extractCode(l.name)
      const model_code = l.model_code !== undefined ? l.model_code : extracted?.model_code ?? null
      const series_code = l.series_code !== undefined ? l.series_code : extracted?.series_code ?? null
      const material = l.material !== undefined ? l.material : extractMaterial(l.name)
      insLine.run(
        randomUUID(), purchaseId, l.name, l.unit_price ?? 0, l.quantity,
        model_code, series_code, material, i,
      )
    })
    applyShopAccountAutoTags(purchaseId, input.shop_account_id)
  })

  tx()
  return purchaseId
}

/**
 * 仕入明細から生まれた在庫1点ずつのいまの状態（getPurchase が使う）。
 * 分割で生まれた子は親の purchase_line_id を引き継ぐため、分割済みの親（status='split'）を
 * 除けば子だけが自然に対象になる。明細ごとに問い合わせず1クエリでまとめて引く。
 */
function loadPurchaseLineItems(lineIds: string[]): Map<string, PurchaseLine['items']> {
  const map = new Map<string, PurchaseLine['items']>()
  if (lineIds.length === 0) return map

  const ph = lineIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT
      i.purchase_line_id AS line_id,
      i.id, i.item_code, i.status, i.landed_cost,
      lst.price    AS listing_price,
      sl.sale_id   AS sale_id,
      sale.price   AS sale_price,
      sale.sold_at AS sold_at
    FROM inventory_item i
    LEFT JOIN listing_line ll  ON ll.inventory_item_id = i.id
    LEFT JOIN listing      lst ON lst.mercari_item_id = ll.listing_id AND lst.status IN ('active','suspended')
    LEFT JOIN sale_line    sl  ON sl.inventory_item_id = i.id
    LEFT JOIN sale             ON sale.id = sl.sale_id
    WHERE i.purchase_line_id IN (${ph}) AND i.status != 'split'
    ORDER BY i.created_at
  `).all(...lineIds) as Array<{
    line_id: string
    id: string; item_code: string; status: InventoryStatus; landed_cost: number
    listing_price: number | null
    sale_id: string | null; sale_price: number | null; sold_at: string | null
  }>

  for (const r of rows) {
    const arr = map.get(r.line_id) ?? []
    arr.push({
      id: r.id,
      item_code: r.item_code,
      status: r.status,
      landed_cost: r.landed_cost,
      listing_price: r.listing_price,
      sale_id: r.sale_id,
      sale_price: r.sale_price,
      sold_at: r.sold_at,
    })
    map.set(r.line_id, arr)
  }
  return map
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

  const lineRows = db.prepare(
    `SELECT id, name, unit_price, quantity, model_code, series_code, material,
            allocated_cost, landed_unit_cost
       FROM purchase_line WHERE purchase_id = ? ORDER BY sort_order`,
  ).all(id) as Array<Omit<PurchaseLine, 'items'>>
  const itemsMap = loadPurchaseLineItems(lineRows.map(l => l.id))
  const lines: PurchaseLine[] = lineRows.map(l => ({ ...l, items: itemsMap.get(l.id) ?? [] }))

  const subtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const total_cost = lines.reduce((s, l) => s + l.unit_price * l.quantity + l.allocated_cost, 0)
  const tagMap = loadTagsFor('purchase_tag', 'purchase_id', [id])

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
    import_key: p.import_key,
    fulfillment: p.fulfillment,
    shipped_at: p.shipped_at,
    delivered_at: p.delivered_at,
    line_count: lines.length,
    first_line_name: lines[0]?.name ?? null,
    first_model_code: lines[0]?.model_code ?? null,
    subtotal,
    total_cost,
    tags: tagMap.get(id) ?? [],
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

  const orderNo = validatePurchaseInput(input, id)

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
      input.shop_account_id, input.ordered_at, orderNo,
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

type FulfillmentRow = {
  fulfillment: Fulfillment | null
  shipped_at: string | null
  delivered_at: string | null
}

/**
 * 到着状態の更新の共通処理。import_key / id のどちらで引くかだけが呼び出し側で違う。
 * 変化が無ければ何もせず false。到着状態が shipped / delivered に進んだのを最初に
 * 観測した日を shipped_at / delivered_at に刻む（既に入っていれば触らない。後戻りしても消さない）
 */
function applyFulfillment(
  whereCol: 'import_key' | 'id', whereVal: string, fulfillment: Fulfillment | null,
): boolean {
  const cur = db.prepare(
    `SELECT fulfillment, shipped_at, delivered_at FROM purchase WHERE ${whereCol} = ?`,
  ).get(whereVal) as FulfillmentRow | undefined
  if (!cur) return false
  if (cur.fulfillment === fulfillment) return false

  const today = todayLocal()
  let shippedAt = cur.shipped_at
  let deliveredAt = cur.delivered_at
  if (fulfillment === 'shipped' && !shippedAt) shippedAt = today
  if (fulfillment === 'delivered') {
    if (!shippedAt) shippedAt = today
    if (!deliveredAt) deliveredAt = today
  }

  db.prepare(
    `UPDATE purchase
        SET fulfillment = ?, fulfillment_updated_at = datetime('now'),
            shipped_at = ?, delivered_at = ?, updated_at = datetime('now')
      WHERE ${whereCol} = ?`,
  ).run(fulfillment, shippedAt, deliveredAt, whereVal)
  return true
}

/**
 * 仕入元の注文の到着状態を更新する（collector が一覧の表示から更新する）。
 * import_key で引く。変化が無ければ何もせず false を返す。
 */
export function updatePurchaseFulfillment(
  importKey: string, fulfillment: Fulfillment | null,
): boolean {
  return applyFulfillment('import_key', importKey, fulfillment)
}

/**
 * 到着状態を手で変える（TikTok Shop など自動取得しない仕入先向け）。
 * shipped / delivered に初めて到達した日を shipped_at / delivered_at に刻む（既に入っていれば触らない）。
 * メロジョイの自動取得がある仕入は次の取り込みで注文一覧の状態に戻る
 */
export function setPurchaseFulfillment(id: string, fulfillment: Fulfillment | null): void {
  const exists = db.prepare('SELECT id FROM purchase WHERE id = ?').get(id) as { id: string } | undefined
  if (!exists) throw new Error('仕入が見つかりません')
  applyFulfillment('id', id, fulfillment)
}

/** listPurchases / getPurchaseSummary で共通の SELECT（WHERE・ORDER BY は呼び出し側で足す） */
const PURCHASE_SUMMARY_SELECT = `
  SELECT
    p.id, p.status, p.ordered_at, p.order_no, p.shop_account_id,
    p.shipping_fee, p.discount, p.note, p.import_key, p.fulfillment,
    p.shipped_at, p.delivered_at,
    sa.name AS shop_account_name,
    COUNT(pl.id) AS line_count,
    COALESCE(SUM(pl.unit_price * pl.quantity), 0) AS subtotal,
    COALESCE(SUM(pl.unit_price * pl.quantity + pl.allocated_cost), 0) AS total_cost,
    (SELECT name FROM purchase_line
      WHERE purchase_id = p.id ORDER BY sort_order, rowid LIMIT 1) AS first_line_name,
    (SELECT model_code FROM purchase_line
      WHERE purchase_id = p.id ORDER BY sort_order, rowid LIMIT 1) AS first_model_code
  FROM purchase p
  JOIN shop_account sa ON sa.id = p.shop_account_id
  LEFT JOIN purchase_line pl ON pl.purchase_id = p.id
`

export function listPurchases(): PurchaseSummary[] {
  const rows = db.prepare(
    `${PURCHASE_SUMMARY_SELECT} GROUP BY p.id ORDER BY p.ordered_at DESC, p.created_at DESC`,
  ).all() as Array<Omit<PurchaseSummary, 'tags'>>
  const tagMap = loadTagsFor('purchase_tag', 'purchase_id', rows.map(r => r.id))
  return rows.map(r => ({ ...r, tags: tagMap.get(r.id) ?? [] }))
}

/** 1件分の PurchaseSummary（getItemTimeline が使う）。無ければ undefined */
function getPurchaseSummary(id: string): PurchaseSummary | undefined {
  const row = db.prepare(
    `${PURCHASE_SUMMARY_SELECT} WHERE p.id = ? GROUP BY p.id`,
  ).get(id) as Omit<PurchaseSummary, 'tags'> | undefined
  if (!row) return undefined
  const tagMap = loadTagsFor('purchase_tag', 'purchase_id', [id])
  return { ...row, tags: tagMap.get(id) ?? [] }
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

  // 出品への引き当て（listing_line）は inventory_item への外部キーに ON DELETE が
  // 無いため、在庫より先に purchase を消すと FK 違反になる。先に引き当てだけ外す
  // （出品自体は残り、未引き当てに戻る。listing.status は変えない）
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM listing_line
      WHERE inventory_item_id IN (
        SELECT i.id FROM inventory_item i
        JOIN purchase_line pl ON pl.id = i.purchase_line_id
        WHERE pl.purchase_id = ?
      )
    `).run(id)
    db.prepare('DELETE FROM purchase WHERE id = ?').run(id)
  })
  tx()
}

// ============================================================
// 販売
// ============================================================

/**
 * メルカリの取引の進み具合。この順でしか進まない（後戻りしない）。
 * waiting_payment＝購入されたが未入金、completed＝売却済み一覧に出た（取引完了）。
 */
const SALE_STATUS_ORDER: SaleStatus[] =
  ['waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed']

/**
 * status の初期値（取り込み時点で既に分かっている段階）から shipped_at / delivered_at /
 * completed_at を決める。initialFulfillmentDates（仕入の到着状態）と同じ規則：
 * 該当段階に達していれば seenAt（観測日）を入れ、以後は updateSaleStatus 側で
 * 「最初に観測した日」として固定される。
 */
function initialSaleStatusDates(
  status: SaleStatus | null | undefined, seenAt: string,
): { shipped_at: string | null; delivered_at: string | null; completed_at: string | null } {
  if (!status) return { shipped_at: null, delivered_at: null, completed_at: null }
  const idx = SALE_STATUS_ORDER.indexOf(status)
  return {
    shipped_at: idx >= SALE_STATUS_ORDER.indexOf('shipped') ? seenAt : null,
    delivered_at: idx >= SALE_STATUS_ORDER.indexOf('delivered') ? seenAt : null,
    completed_at: status === 'completed' ? seenAt : null,
  }
}

/**
 * メルカリの取引の進み具合を更新する（取引中タブから collector が呼ぶ）。
 * status は前にしか進まない：後戻り・同じ状態への更新は無視して false を返す
 * （買い手都合のキャンセル等で表示が乱れても、一度進んだ記録を壊さないため）。
 * 初めて shipped 以上になった日を shipped_at、初めて delivered 以上になった日を
 * delivered_at に刻む（既に入っていれば触らない）。mercari_item_id が無ければ何もしない。
 * 戻り値は実際に状態が進んだかどうか。
 */
export function updateSaleStatus(
  mercariItemId: string, status: SaleStatus, seenAt = todayLocal(),
): boolean {
  const row = db.prepare(
    'SELECT id, status, shipped_at, delivered_at FROM sale WHERE mercari_item_id = ?',
  ).get(mercariItemId) as
    | { id: string; status: SaleStatus | null; shipped_at: string | null; delivered_at: string | null }
    | undefined
  if (!row) return false

  const curIdx = row.status ? SALE_STATUS_ORDER.indexOf(row.status) : -1
  const nextIdx = SALE_STATUS_ORDER.indexOf(status)
  if (nextIdx <= curIdx) return false

  const shippedAt = nextIdx >= SALE_STATUS_ORDER.indexOf('shipped') && !row.shipped_at
    ? seenAt : row.shipped_at
  const deliveredAt = nextIdx >= SALE_STATUS_ORDER.indexOf('delivered') && !row.delivered_at
    ? seenAt : row.delivered_at

  db.prepare(
    `UPDATE sale SET status = ?, shipped_at = ?, delivered_at = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(status, shippedAt, deliveredAt, row.id)
  return true
}

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
 * メルカリの取引詳細・販売履歴ページから取れた実額で上書きする
 * （collector が使う。IPCには出さない）。
 *
 * shipping_fee の扱い：
 *   * null/undefined（詳細ページの取得失敗など）は「未取得」として無視する
 *   * 0 より大きい額は、メルカリ便などで実際に請求された額。人が発送方法を選んで
 *     いても（shipping_source='master'）、メルカリが請求した実額を優先して actual・確定にする
 *   * 0 は「メルカリ便を使っていない（着払い・自己手配の郵送など）」可能性が高く、
 *     実際は送料がかかっているのに 0 円で確定してしまう恐れがある。既に人が発送方法を
 *     選んでいれば（shipping_source='master'、出品時に決めて引き継いだ 'manual' も同じ）その選択を尊重して送料関連の列には一切触らない。
 *     それ以外は shipping_fee=0・shipping_source='actual' で記録しつつ is_shipping_confirmed は
 *     立てない（＝送料未入力として要対応に出す。人が発送方法を選べば updateSale が master にして確定する）
 *
 * sold_at は source='collector' かつ status が未取得（取引中タブで先に追っていない）
 * 販売にだけ反映する。手入力の日付は上書きしない（一覧の取得日を仮の販売日として
 * 保存していたものを、本当の購入完了日に直すため）。取引中タブで先に status が付いた
 * 販売は sold_at を「初めて見た日」のまま固定する（本当の完了日は completed_at に持つ）。
 *
 * status に 'completed' を渡すと、completed_at が未設定なら completedAt で埋める
 * （既に入っていれば触らない。「最初に観測した日」を刻む他の日付と同じ規則）。
 */
export function applySaleActuals(
  id: string,
  actuals: {
    fee?: number | null
    shipping_fee?: number | null
    sold_at?: string
    status?: SaleStatus
    completedAt?: string
  },
): void {
  const sets: string[] = []
  const vals: unknown[] = []

  if (actuals.fee !== undefined && actuals.fee !== null) {
    sets.push('fee = ?')
    vals.push(actuals.fee)
  }
  if (actuals.shipping_fee !== undefined && actuals.shipping_fee !== null) {
    if (actuals.shipping_fee > 0) {
      sets.push('shipping_fee = ?', `shipping_source = 'actual'`, 'is_shipping_confirmed = 1')
      vals.push(actuals.shipping_fee)
    } else {
      const cur = db.prepare('SELECT shipping_source FROM sale WHERE id = ?').get(id) as
        { shipping_source: string | null } | undefined
      if (cur?.shipping_source !== 'master' && cur?.shipping_source !== 'manual') { // manual＝出品時に決めた発送方法の引き継ぎ
        sets.push('shipping_fee = ?', `shipping_source = 'actual'`, 'is_shipping_confirmed = 0')
        vals.push(0)
      }
    }
  }
  if (actuals.sold_at !== undefined) {
    // status が既に付いている（取引中タブで先に取り込んだ）販売は sold_at を触らない
    sets.push(`sold_at = CASE WHEN source = 'collector' AND status IS NULL THEN ? ELSE sold_at END`)
    vals.push(actuals.sold_at)
  }
  if (actuals.status !== undefined) {
    sets.push('status = ?')
    vals.push(actuals.status)
  }
  if (actuals.completedAt !== undefined) {
    sets.push('completed_at = COALESCE(completed_at, ?)')
    vals.push(actuals.completedAt)
  }
  if (sets.length === 0) return

  sets.push(`updated_at = datetime('now')`)
  vals.push(id)
  db.prepare(`UPDATE sale SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

/**
 * メルカリの販売履歴ページ（一覧）から取れた実額・購入完了日で、既知の取引を更新する。
 * 売却済み一覧（販売履歴）に出た時点で取引は完了しているので、status='completed'・
 * completed_at（初回のみ）も併せて刻む。既に shipping_source='actual' かつ sold_at が
 * 一致していれば何もしない（差分適用。取引中タブを経由した販売は shipping_source が
 * 'actual' になるのがこの反映のタイミングなので、初回は必ず通って status も完了になる）。
 * shipping_source='master'（人が発送方法を選択済み）の販売はこの条件に当たらず毎回
 * applySaleActuals まで進むが、送料 0 円のときに送料関連の列を触らない規則で守られるので、
 * 何度再適用しても発送方法・送料は動かない。kind・紐付けには触らない。戻り値は更新した件数。
 */
export function updateCollectedActuals(
  rows: Array<{
    mercariItemId: string
    soldAt: string
    fee?: number | null
    shippingFee?: number | null
  }>,
): number {
  let updated = 0
  for (const r of rows) {
    const sale = db.prepare(
      'SELECT id, shipping_source, sold_at, status FROM sale WHERE mercari_item_id = ?',
    ).get(r.mercariItemId) as
      | { id: string; shipping_source: string | null; sold_at: string; status: SaleStatus | null }
      | undefined
    if (!sale) continue

    // 既に実額が入っていて日付も同じ（または取引中タブ経由で先に取り込み、完了まで刻んだ）販売は再適用しない
    if (sale.shipping_source === 'actual' && (sale.sold_at === r.soldAt || sale.status === 'completed')) continue

    applySaleActuals(
      sale.id,
      {
        fee: r.fee, shipping_fee: r.shippingFee, sold_at: r.soldAt,
        status: 'completed', completedAt: r.soldAt,
      },
    )
    updated++
  }
  return updated
}

export function deleteSale(id: string): void {
  db.prepare('DELETE FROM sale WHERE id = ?').run(id)
}

type SaleProfitRow = Omit<SaleProfit, 'model_codes' | 'tags' | 'inherited_tags' | 'thumb_url'> & {
  model_codes: string
  thumb_file: string | null
}

/**
 * タグを持つテーブル（sale_tag / inventory_tag / purchase_tag / product_tag / shop_account_tag）
 * から、対象idごとのタグ配列をまとめて1クエリで引く（N+1にしない）。
 */
function loadTagsFor(
  table: 'sale_tag' | 'inventory_tag' | 'purchase_tag' | 'product_tag' | 'shop_account_tag',
  column: 'sale_id' | 'inventory_item_id' | 'purchase_id' | 'model_code' | 'shop_account_id',
  ids: string[],
): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  if (ids.length === 0) return map

  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT x.${column} AS owner_id, t.id, t.name, t.sort_order
    FROM ${table} x
    JOIN tag t ON t.id = x.tag_id
    WHERE x.${column} IN (${ph})
    ORDER BY t.sort_order, t.name
  `).all(...ids) as Array<{ owner_id: string; id: string; name: string; sort_order: number }>

  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/**
 * 在庫が「派生」で持つタグのうち、仕入から来るもの
 * （purchase_line → purchase に付いた purchase_tag）を1クエリで引く。
 */
function loadPurchaseTagsForInventory(itemIds: string[]): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  if (itemIds.length === 0) return map

  const ph = itemIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT i.id AS owner_id, t.id, t.name, t.sort_order
    FROM inventory_item i
    JOIN purchase_line pl ON pl.id = i.purchase_line_id
    JOIN purchase_tag  pt ON pt.purchase_id = pl.purchase_id
    JOIN tag t ON t.id = pt.tag_id
    WHERE i.id IN (${ph})
    ORDER BY t.sort_order, t.name
  `).all(...itemIds) as Array<{ owner_id: string; id: string; name: string; sort_order: number }>

  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/**
 * 在庫が「派生」で持つタグのうち、商品（型番）から来るもの（product_tag。model_code一致）。
 * model_code の無い在庫（私物の手入力等）は対象外。
 */
function loadProductTagsForInventory(items: Array<{ id: string; model_code: string | null }>): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  const withCode = items.filter((i): i is { id: string; model_code: string } => !!i.model_code)
  if (withCode.length === 0) return map

  const codes = [...new Set(withCode.map(i => i.model_code))]
  const ph = codes.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT pt.model_code AS model_code, t.id, t.name, t.sort_order
    FROM product_tag pt
    JOIN tag t ON t.id = pt.tag_id
    WHERE pt.model_code IN (${ph})
  `).all(...codes) as Array<{ model_code: string; id: string; name: string; sort_order: number }>

  const byCode = new Map<string, Tag[]>()
  for (const r of rows) {
    const arr = byCode.get(r.model_code) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    byCode.set(r.model_code, arr)
  }
  for (const i of withCode) {
    map.set(i.id, byCode.get(i.model_code) ?? [])
  }
  return map
}

/**
 * 派生タグを、優先順位 purchase > product > inventory で1つにまとめる
 * （同じタグが複数の経路から来ても重複させない）。直接タグ（directIds）は除く。
 * sources は既に優先順に並べて渡すこと（先勝ち）。
 */
function mergeInheritedTags(
  directIds: Set<string>,
  sources: Array<{ from: NonNullable<Tag['from']>; tags: Tag[] }>,
): Tag[] {
  const seen = new Map<string, Tag>()
  for (const { from, tags } of sources) {
    for (const t of tags) {
      if (directIds.has(t.id) || seen.has(t.id)) continue
      seen.set(t.id, { ...t, from })
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name.localeCompare(b.name))
}

/**
 * 販売が「派生」で持つタグのうち、紐付いた在庫の直接タグ（inventory_tag）由来。
 */
function loadInventoryTagsForSales(saleIds: string[]): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  if (saleIds.length === 0) return map

  const ph = saleIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT sl.sale_id AS owner_id, t.id, t.name, t.sort_order
    FROM sale_line sl
    JOIN inventory_tag it ON it.inventory_item_id = sl.inventory_item_id
    JOIN tag t ON t.id = it.tag_id
    WHERE sl.sale_id IN (${ph})
    ORDER BY t.sort_order, t.name
  `).all(...saleIds) as Array<{ owner_id: string; id: string; name: string; sort_order: number }>

  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/**
 * 販売が「派生」で持つタグのうち、紐付いた在庫の仕入（purchase_tag）由来。
 */
function loadPurchaseTagsForSales(saleIds: string[]): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  if (saleIds.length === 0) return map

  const ph = saleIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT sl.sale_id AS owner_id, t.id, t.name, t.sort_order
    FROM sale_line sl
    JOIN inventory_item i  ON i.id = sl.inventory_item_id
    JOIN purchase_line pl ON pl.id = i.purchase_line_id
    JOIN purchase_tag  pt ON pt.purchase_id = pl.purchase_id
    JOIN tag t ON t.id = pt.tag_id
    WHERE sl.sale_id IN (${ph})
    ORDER BY t.sort_order, t.name
  `).all(...saleIds) as Array<{ owner_id: string; id: string; name: string; sort_order: number }>

  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/**
 * 販売が「派生」で持つタグのうち、紐付いた在庫の商品（型番。product_tag）由来。
 */
function loadProductTagsForSales(saleIds: string[]): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  if (saleIds.length === 0) return map

  const ph = saleIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT DISTINCT sl.sale_id AS owner_id, t.id, t.name, t.sort_order
    FROM sale_line sl
    JOIN inventory_item i ON i.id = sl.inventory_item_id
    JOIN product_tag  pt ON pt.model_code = i.model_code
    JOIN tag t ON t.id = pt.tag_id
    WHERE sl.sale_id IN (${ph})
    ORDER BY t.sort_order, t.name
  `).all(...saleIds) as Array<{ owner_id: string; id: string; name: string; sort_order: number }>

  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/** listSales / saleTotals 共通の絞り込み。sale_profit ビューに対する WHERE を組み立てる */
function buildSaleFilterWhere(filter?: SaleFilter): { where: string; vals: unknown[] } {
  const clauses: string[] = []
  const vals: unknown[] = []

  if (filter?.month) { clauses.push(`substr(sold_at,1,7) = ?`); vals.push(filter.month) }
  if (filter?.kind) { clauses.push(`kind = ?`); vals.push(filter.kind) }
  // 未処理＝送料未入力、または（転売なのに）在庫が未紐付け
  if (filter?.onlyPending) {
    clauses.push(`(is_shipping_confirmed = 0 OR (unmatched = 1 AND kind = 'resale'))`)
  }
  if (filter?.tagId) {
    // 直接付いたタグ ∪ 派生タグ（紐付いた在庫のタグ・その仕入のタグ・その商品＝型番のタグ）で一致させる
    clauses.push(`(
      EXISTS (SELECT 1 FROM sale_tag WHERE sale_tag.sale_id = sale_profit.id AND sale_tag.tag_id = ?)
      OR EXISTS (
        SELECT 1 FROM sale_line sl
        JOIN inventory_tag it ON it.inventory_item_id = sl.inventory_item_id
        WHERE sl.sale_id = sale_profit.id AND it.tag_id = ?
      )
      OR EXISTS (
        SELECT 1 FROM sale_line sl
        JOIN inventory_item i  ON i.id = sl.inventory_item_id
        JOIN purchase_line pl ON pl.id = i.purchase_line_id
        JOIN purchase_tag  pt ON pt.purchase_id = pl.purchase_id
        WHERE sl.sale_id = sale_profit.id AND pt.tag_id = ?
      )
      OR EXISTS (
        SELECT 1 FROM sale_line sl
        JOIN inventory_item i ON i.id = sl.inventory_item_id
        JOIN product_tag  pt ON pt.model_code = i.model_code
        WHERE sl.sale_id = sale_profit.id AND pt.tag_id = ?
      )
    )`)
    vals.push(filter.tagId, filter.tagId, filter.tagId, filter.tagId)
  }

  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', vals }
}

/**
 * sale_profit の生行を SaleProfit（タグ・型番配列・サムネイルURL）に直す。
 * listSales / getItemTimeline / getProduct で共通に使う。
 */
function hydrateSaleProfitRows(rows: SaleProfitRow[]): SaleProfit[] {
  const ids = rows.map(r => r.id)
  const tagMap = loadTagsFor('sale_tag', 'sale_id', ids)
  const purchaseMap = loadPurchaseTagsForSales(ids)
  const productMap = loadProductTagsForSales(ids)
  const inventoryMap = loadInventoryTagsForSales(ids)
  return rows.map(r => {
    const { thumb_file, ...rest } = r
    const tags = tagMap.get(r.id) ?? []
    const directIds = new Set(tags.map(t => t.id))
    // 優先順位 purchase > product > inventory で1つにまとめる
    const inherited_tags = mergeInheritedTags(directIds, [
      { from: 'purchase', tags: purchaseMap.get(r.id) ?? [] },
      { from: 'product', tags: productMap.get(r.id) ?? [] },
      { from: 'inventory', tags: inventoryMap.get(r.id) ?? [] },
    ])
    return {
      ...rest,
      model_codes: JSON.parse(rest.model_codes || '[]') as string[],
      tags,
      inherited_tags,
      thumb_url: toThumbUrl(thumb_file),
    }
  })
}

export function listSales(filter?: SaleFilter): SaleProfit[] {
  const { where, vals } = buildSaleFilterWhere(filter)

  const sql = `SELECT * FROM sale_profit ${where} ORDER BY sold_at DESC, title`
  const rows = db.prepare(sql).all(...vals) as SaleProfitRow[]

  return hydrateSaleProfitRows(rows)
}

/** 絞り込んだ販売の合計。DB側で集計する（0件なら全部0） */
export function saleTotals(filter?: SaleFilter): SaleTotals {
  const { where, vals } = buildSaleFilterWhere(filter)

  return db.prepare(`
    SELECT
      COUNT(*)                          AS count,
      COALESCE(SUM(price), 0)           AS revenue,
      COALESCE(SUM(fee), 0)             AS total_fee,
      COALESCE(SUM(shipping_fee), 0)    AS total_shipping,
      COALESCE(SUM(packaging_cost), 0)  AS total_packaging,
      COALESCE(SUM(cost), 0)            AS total_cost,
      COALESCE(SUM(gross_profit), 0)    AS gross_profit
    FROM sale_profit
    ${where}
  `).get(...vals) as SaleTotals
}

// ============================================================
// 紐付け
//
// 自動確定しない。誤紐付けは原価を壊し、しかも気づきにくい。
// 例外は Phase 2 の型番完全一致（autoLinkSale）だけ。それ以外は
// suggestInventory が候補を返すだけで、確定は人間が行う。
// ============================================================

/**
 * 販売に在庫を紐付ける。タグはコピーしない（派生で見える。SaleProfit.inherited_tags）。
 * in_stock でない在庫（売却済み・廃棄済み・自家消費・分割済み）が混ざっていれば例外。
 * 出品に引き当て中（listing_line）の在庫は紐付けてよい。人が「この販売に使う」と
 * 決めたのでその引き当ては優先して外す（出品自体の status は変えない）。
 */
export function linkInventory(
  saleId: string, itemIds: string[], source: LinkSource = 'manual',
): void {
  if (itemIds.length > 0) {
    const ph = itemIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, status FROM inventory_item WHERE id IN (${ph})`,
    ).all(...itemIds) as Array<{ id: string; status: InventoryStatus }>
    if (rows.some(r => r.status !== 'in_stock')) {
      throw new Error('販売済み・廃棄済みの在庫は紐付けられません')
    }
  }

  const ins = db.prepare(
    `INSERT INTO sale_line (id, sale_id, inventory_item_id, link_source) VALUES (?, ?, ?, ?)`,
  )
  const delListing = db.prepare('DELETE FROM listing_line WHERE inventory_item_id = ?')
  const tx = db.transaction(() => {
    for (const itemId of itemIds) {
      ins.run(randomUUID(), saleId, itemId, source)
      delListing.run(itemId)
    }
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
 * 在庫コード（そろばん発行）に一致する未販売在庫の id を、渡した順に返す
 * （見つからないコードはスキップする。他の出品に引き当て中でも in_stock なら対象＝移す）。
 */
function findInventoryIdsByItemCodes(itemCodes: string[]): string[] {
  const find = db.prepare(`SELECT id FROM inventory_item WHERE item_code = ? AND status = 'in_stock'`)
  const ids: string[] = []
  for (const code of itemCodes) {
    const row = find.get(code) as { id: string } | undefined
    if (row) ids.push(row.id)
  }
  return ids
}

/**
 * 型番が model_code と文字列として完全一致する未販売在庫を、先入先出（acquired_at 昇順）で
 * 最大 qty 点まで返す（在庫が足りなければある分だけ）。枝番の有無は問わない。
 * 他の active/suspended な出品に引き当て済みの在庫は候補から外す
 * （人が出品に予約した意思を、型番一致の自動確定で横取りしない）。
 */
function findInventoryIdsByModelCodeFifo(modelCode: string, qty: number): string[] {
  const rows = db.prepare(`
    SELECT id FROM inventory_item i
     WHERE i.model_code = ? AND i.status = 'in_stock'
       AND NOT EXISTS (
         SELECT 1 FROM listing_line ll
         JOIN listing l ON l.mercari_item_id = ll.listing_id
         WHERE ll.inventory_item_id = i.id AND l.status IN ('active','suspended')
       )
     ORDER BY i.acquired_at ASC, i.created_at ASC
     LIMIT ?
  `).all(modelCode, qty) as Array<{ id: string }>
  return rows.map(r => r.id)
}

/**
 * 優先順で1回だけ自動確定を試みる：
 *   1. タイトルに在庫コードがあれば、見つかった分だけ全部（1つでも見つからない／販売済みなら
 *      その分は候補止まり。見つかった分だけ確定し、expected_item_count との差分で unmatched を残す）
 *   2. 在庫コードが無ければ型番：抽出した型番が1つで在庫と完全一致するときだけ、
 *      FIFOで個数表記（×2 等。無ければ1）の分だけ充てる（足りなければある分だけ）
 *   3. 型番が2つ以上なら候補止まり（何もしない）
 * 条件を満たさない、またはsale_lineが既にあれば何もしない。戻り値は1点でも確定できたか。
 */
export function autoLinkSale(saleId: string): boolean {
  const sale = db.prepare('SELECT kind, title, model_codes FROM sale WHERE id = ?').get(saleId) as
    | { kind: SaleKind; title: string; model_codes: string } | undefined
  if (!sale || sale.kind !== 'resale') return false

  const already = db.prepare('SELECT COUNT(*) AS c FROM sale_line WHERE sale_id = ?')
    .get(saleId) as { c: number }
  if (already.c > 0) return false

  const itemCodes = extractItemCodes(sale.title)
  if (itemCodes.length > 0) {
    db.prepare('UPDATE sale SET expected_item_count = ? WHERE id = ?').run(itemCodes.length, saleId)
    const ids = findInventoryIdsByItemCodes(itemCodes)
    if (ids.length === 0) return false
    linkInventory(saleId, ids, 'auto')
    return true
  }

  const codes = JSON.parse(sale.model_codes || '[]') as string[]
  if (codes.length !== 1) return false

  const qty = extractCodeQuantities(sale.title).find(q => q.code === codes[0])?.qty ?? 1
  db.prepare('UPDATE sale SET expected_item_count = ? WHERE id = ?').run(qty, saleId)
  const ids = findInventoryIdsByModelCodeFifo(codes[0], qty)
  if (ids.length === 0) return false

  linkInventory(saleId, ids, 'auto')
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

  const keywords = parseKeywords(settingStr('mercari_keyword', ''))
  // source='collector' かつ一度も更新されていない（=人が手で触っていない）ときだけ救済する
  const untouched = sale.source === 'collector' && sale.updated_at === sale.created_at
  const kind: SaleKind =
    sale.kind === 'personal' && keywords.length === 0 && merged.length > 0 && untouched
      ? 'resale'
      : sale.kind

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
/** inventory_view の1行。thumb_url・listing は組み立てる前の生の列 */
type InventoryRow = Omit<InventoryItem, 'tags' | 'inherited_tags' | 'thumb_url' | 'listing'> & {
  thumb_file: string | null
  listing_id: string | null
  listing_price: number | null
  listing_status: ListingStatus | null
}

/**
 * in_stock（等）を inventory_view から引いた結果に、まとめて引いた直接タグと
 * 派生タグ（仕入・商品＝型番から。優先順位 purchase > product。tags と重複するものは除く）を付ける。
 */
function attachInventoryTags(items: InventoryRow[]): InventoryItem[] {
  const ids = items.map(i => i.id)
  const tagMap = loadTagsFor('inventory_tag', 'inventory_item_id', ids)
  const purchaseMap = loadPurchaseTagsForInventory(ids)
  const productMap = loadProductTagsForInventory(items)
  return items.map(i => {
    const { thumb_file, listing_id, listing_price, listing_status, ...rest } = i
    const tags = tagMap.get(i.id) ?? []
    const directIds = new Set(tags.map(t => t.id))
    const inherited_tags = mergeInheritedTags(directIds, [
      { from: 'purchase', tags: purchaseMap.get(i.id) ?? [] },
      { from: 'product', tags: productMap.get(i.id) ?? [] },
    ])
    return {
      ...rest,
      thumb_url: toThumbUrl(thumb_file),
      tags,
      inherited_tags,
      listing: listing_id
        ? { mercari_item_id: listing_id, price: listing_price!, status: listing_status! }
        : null,
    }
  })
}

/**
 * 在庫候補の並び順：在庫コード一致 → 型番完全一致 → シリーズ一致 → 商品名の類似度
 * （完全一致 → 前方一致 → 部分一致 → 残り）。suggestInventory / suggestForListing で共通。
 */
function rankInventoryMatch(
  item: InventoryRow, itemCodeSet: Set<string>, codeSet: Set<string>, seriesCodes: Set<string>,
  target: string, head: string,
): number {
  if (itemCodeSet.has(item.item_code)) return 0
  if (item.model_code && codeSet.has(item.model_code)) return 1
  if (item.series_code && seriesCodes.has(item.series_code)) return 2
  const n = normalizeName(item.name)
  if (n === target) return 3
  if (head && n.startsWith(head)) return 4
  if (head && n.includes(head)) return 5
  return 6
}

/**
 * 在庫候補を返す。並びは 在庫コード一致 → 型番完全一致 → シリーズ一致 → 商品名の類似度
 * （完全一致 → 前方一致 → 部分一致 → 残り）。同順位は滞留日数が長い方を先に
 * （型番一致の中では先入先出と同じ順になる）。
 * SQL側では正規化できないため、in_stock を全件取ってJS側で並べ替える
 * （規模は月20〜50件程度の想定）。他の出品に引き当て済みの在庫は候補から除く。
 */
export function suggestInventory(saleId: string, limit = 20): InventoryItem[] {
  const sale = db.prepare('SELECT title, model_codes FROM sale WHERE id = ?').get(saleId) as
    | { title: string; model_codes: string } | undefined
  if (!sale) return []

  const codes = JSON.parse(sale.model_codes || '[]') as string[]
  const codeSet = new Set(codes)
  const seriesCodes = new Set(codes.map(c => c.split('-')[0]))
  const itemCodeSet = new Set(extractItemCodes(sale.title))

  const target = normalizeName(sale.title)
  const head = target.slice(0, 6)

  const items = db.prepare(
    `SELECT * FROM inventory_view WHERE status = 'in_stock' AND listing_id IS NULL`,
  ).all() as InventoryRow[]

  const picked = items
    .map(item => ({ item, r: rankInventoryMatch(item, itemCodeSet, codeSet, seriesCodes, target, head) }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : b.item.aging_days - a.item.aging_days))
    .slice(0, limit)
    .map(({ item }) => item)

  return attachInventoryTags(picked)
}

// ============================================================
// 出品（メルカリの出品中タブ）と在庫の引き当て
//
// 出品そのものは在庫の status を変えない（in_stock のまま。まだ売れていない資産）。
// 引き当ては人が行う（自動確定しない）。二重引き当て・売却済み在庫の引き当ては
// trg_listing_line_guard（schema.sql）が拒否する。
// ============================================================

/**
 * 出品中タブの「n日前に更新」（時間・分は0日扱い）から経過日数を取り出す。読めなければ null。
 */
export function parseElapsedDays(updatedText: string | null | undefined): number | null {
  if (!updatedText) return null
  const m = /(\d+)\s*(日|時間|分)前/.exec(updatedText)
  if (!m) return null
  return m[2] === '日' ? parseInt(m[1], 10) : 0
}

/** base（YYYY-MM-DD）から days 日前の日付を、ローカル時刻で YYYY-MM-DD にして返す */
function subtractDaysLocal(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - days)
  return todayLocal(dt)
}

/**
 * 出品中タブの一覧を取り込む。新規は first_seen_at を今日にする。
 * 既存は title/price/status/last_seen_at を更新するが、sold/ended になったものは
 * 一覧に出ていても active/suspended へ戻さない（1ページしか読まないため、
 * 一覧から消えたことと「取り下げた」を区別できない＝ CLAUDE.md のCodexレビュー指摘）。
 * 一覧に無い listing は何もしない。
 *
 * listed_at（出品日の推定）：updatedText から経過日数 n を出し、候補 = today − n日。
 * 新規は候補（取れなければ today）。既存は候補と現在値の min（＝より古い方）に更新する
 * （一覧の「更新順」表示の揺れで出品日が新しく巻き戻るのを防ぐ）。likes は毎回上書きする。
 */
export function upsertListings(
  rows: Array<{
    mercariItemId: string
    title: string
    price: number
    suspended: boolean
    thumbUrl: string | null
    /** 出品中タブの「n日前に更新」等。取れなければ null */
    updatedText?: string | null
    /** いいね数。取れなければ null */
    likes?: number | null
  }>,
): { inserted: number; updated: number } {
  const today = todayLocal()
  // last_seen_at は画面側で collector_run.finished_at（ISO）と比較するため、
  // SQLite の datetime('now')（'YYYY-MM-DD HH:MM:SS'）ではなく JS の ISO 文字列で保存する
  // （Codexレビュー指摘：形式が違うと文字列比較が常に不一致になる）
  const now = new Date().toISOString()
  const getExisting = db.prepare('SELECT status, listed_at FROM listing WHERE mercari_item_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO listing (mercari_item_id, title, price, status, first_seen_at, last_seen_at, listed_at, likes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateStmt = db.prepare(`
    UPDATE listing SET title = ?, price = ?, status = ?, last_seen_at = ?,
           listed_at = ?, likes = ?, updated_at = datetime('now')
     WHERE mercari_item_id = ?
  `)

  let inserted = 0
  let updated = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const status: ListingStatus = r.suspended ? 'suspended' : 'active'
      const days = parseElapsedDays(r.updatedText ?? null)
      const candidate = days !== null ? subtractDaysLocal(today, days) : null
      const likes = r.likes ?? null

      const existing = getExisting.get(r.mercariItemId) as
        | { status: ListingStatus; listed_at: string } | undefined
      if (!existing) {
        insertStmt.run(r.mercariItemId, r.title, r.price, status, today, now, candidate ?? today, likes)
        inserted++
      } else if (existing.status === 'active' || existing.status === 'suspended') {
        const listedAt = candidate !== null && candidate < existing.listed_at
          ? candidate
          : existing.listed_at
        updateStmt.run(r.title, r.price, status, now, listedAt, likes, r.mercariItemId)
        updated++
      }
      // sold / ended は一覧に出ていても戻さない
    }
  })
  tx()
  return { inserted, updated }
}

type ListingRow = {
  mercari_item_id: string
  title: string
  price: number
  status: ListingStatus
  first_seen_at: string
  last_seen_at: string
  listed_at: string
  likes: number | null
  shipping_method_id: string | null
  thumb_file: string | null
}

function hydrateListing(r: ListingRow, rateBp: number): Listing {
  const items = db.prepare(`
    SELECT i.id, i.item_code, i.name, i.model_code, i.landed_cost
      FROM listing_line ll
      JOIN inventory_item i ON i.id = ll.inventory_item_id
     WHERE ll.listing_id = ?
  `).all(r.mercari_item_id) as Array<
    { id: string; item_code: string; name: string; model_code: string | null; landed_cost: number }
  >

  const reserved_cost = items.reduce((s, i) => s + i.landed_cost, 0)

  let shippingMethodName: string | null = null
  let shippingFee = 0
  if (r.shipping_method_id) {
    const method = db.prepare('SELECT name, fee FROM shipping_method WHERE id = ?')
      .get(r.shipping_method_id) as { name: string; fee: number } | undefined
    if (method) {
      shippingMethodName = method.name
      shippingFee = method.fee
    }
  }

  // 手数料は設定の率。発送方法が決まっていればその送料も引く（梱包は引かない）
  const expected_profit = items.length === 0
    ? null
    : r.price - calcFee(r.price, rateBp) - reserved_cost - shippingFee

  return {
    mercari_item_id: r.mercari_item_id,
    title: r.title,
    price: r.price,
    status: r.status,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    listed_at: r.listed_at,
    likes: r.likes,
    shipping_method_id: r.shipping_method_id,
    shipping_method_name: shippingMethodName,
    thumb_url: toThumbUrl(r.thumb_file),
    model_codes: extractCodes(r.title),
    items,
    reserved_cost,
    expected_profit,
  }
}

/** status 未指定なら active + suspended。onlyUnallocated で未引き当てだけ */
export function listListings(
  filter?: { status?: ListingStatus[]; onlyUnallocated?: boolean },
): Listing[] {
  const statuses = filter?.status ?? ['active', 'suspended']
  const ph = statuses.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM listing WHERE status IN (${ph}) ORDER BY first_seen_at DESC, created_at DESC`,
  ).all(...statuses) as ListingRow[]

  const rateBp = setting('fee_rate_bp', 1000)
  const listings = rows.map(r => hydrateListing(r, rateBp))

  return filter?.onlyUnallocated ? listings.filter(l => l.items.length === 0) : listings
}

/** 出品時に発送方法を決めておく（null で外す）。売れたとき takeOverListing が販売へ引き継ぐ */
export function setListingShipping(mercariItemId: string, shippingMethodId: string | null): void {
  db.prepare(
    `UPDATE listing SET shipping_method_id = ?, updated_at = datetime('now') WHERE mercari_item_id = ?`,
  ).run(shippingMethodId, mercariItemId)
}

/**
 * 出品に在庫を引き当てる（追加）。既に他の active/suspended な出品に引き当て済みの
 * 在庫は、その引き当てを同じトランザクション内で先に外してからこちらへ移す
 * （再出品・付け替え。人の最新の決定を優先。元の出品は未引き当てに戻る）。
 * 販売済み・廃棄済みの在庫は trg_listing_line_guard がそのまま拒否する。
 */
export function reserveInventory(mercariItemId: string, inventoryItemIds: string[]): void {
  // トリガー（trg_listing_line_guard）でも拒否されるが、そこに任せると SQLite の
  // 生のエラーメッセージが上がってしまうため、先に同じ文言で明示的に弾く
  const listing = db.prepare('SELECT status FROM listing WHERE mercari_item_id = ?')
    .get(mercariItemId) as { status: ListingStatus } | undefined
  if (!listing || (listing.status !== 'active' && listing.status !== 'suspended')) {
    throw new Error('終了した出品には引き当てられません')
  }

  const delOther = db.prepare(`
    DELETE FROM listing_line
     WHERE inventory_item_id = ?
       AND listing_id IN (SELECT mercari_item_id FROM listing WHERE status IN ('active','suspended'))
  `)
  const ins = db.prepare(
    `INSERT INTO listing_line (id, listing_id, inventory_item_id) VALUES (?, ?, ?)`,
  )
  const tx = db.transaction(() => {
    for (const itemId of inventoryItemIds) {
      delOther.run(itemId)
      ins.run(randomUUID(), mercariItemId, itemId)
    }
  })
  tx()
}

export function unreserveInventory(mercariItemId: string, inventoryItemId: string): void {
  db.prepare('DELETE FROM listing_line WHERE listing_id = ? AND inventory_item_id = ?')
    .run(mercariItemId, inventoryItemId)
}

/**
 * 出品の引き当て候補。在庫コード一致 → 型番の完全一致 → シリーズ一致 → 名前の一致の順。
 * 販売済み・廃棄済みは除く。他の出品に引き当て済みの在庫も候補に含める
 * （InventoryItem.listing に引き当て先が入る。この出品自身に引き当て済みのものは除く）。
 * 同順位なら未引き当てを先に。
 */
export function suggestForListing(mercariItemId: string, limit = 20): InventoryItem[] {
  const listing = db.prepare('SELECT title FROM listing WHERE mercari_item_id = ?')
    .get(mercariItemId) as { title: string } | undefined
  if (!listing) return []

  const codes = extractCodes(listing.title)
  const codeSet = new Set(codes)
  const seriesCodes = new Set(codes.map(c => c.split('-')[0]))
  const itemCodeSet = new Set(extractItemCodes(listing.title))

  const target = normalizeName(listing.title)
  const head = target.slice(0, 6)

  const items = db.prepare(
    `SELECT * FROM inventory_view WHERE status = 'in_stock' AND (listing_id IS NULL OR listing_id != ?)`,
  ).all(mercariItemId) as InventoryRow[]

  const picked = items
    .map(item => ({ item, r: rankInventoryMatch(item, itemCodeSet, codeSet, seriesCodes, target, head) }))
    .sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r
      const aReserved = a.item.listing_id ? 1 : 0
      const bReserved = b.item.listing_id ? 1 : 0
      if (aReserved !== bReserved) return aReserved - bReserved
      return b.item.aging_days - a.item.aging_days
    })
    .slice(0, limit)
    .map(({ item }) => item)

  return attachInventoryTags(picked)
}

/** 人が「取り下げた」と記録する。引き当ては外れ、在庫は未出品に戻る */
export function endListing(mercariItemId: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM listing_line WHERE listing_id = ?').run(mercariItemId)
    db.prepare(
      `UPDATE listing SET status = 'ended', updated_at = datetime('now') WHERE mercari_item_id = ?`,
    ).run(mercariItemId)
  })
  tx()
}

/**
 * 未引き当ての出品（active／suspended）に在庫を引き当てる。autoLinkSale と同じ優先順：
 *   1. タイトルに在庫コードがあれば、見つかった分だけ全部
 *   2. 在庫コードが無ければ型番が1つに絞れるときだけ、FIFOで個数表記（×2等。無ければ1）の分だけ
 *   3. 型番が2つ以上なら候補止まり
 * 引き当てた出品の数を返す。reserveInventory で引き当てるので、1クリック（unreserveInventory）
 * で解除できる。
 */
export function autoReserveListings(): number {
  const pending = db.prepare(`
    SELECT mercari_item_id, title FROM listing l
     WHERE l.status IN ('active','suspended')
       AND NOT EXISTS (SELECT 1 FROM listing_line WHERE listing_id = l.mercari_item_id)
  `).all() as Array<{ mercari_item_id: string; title: string }>

  let count = 0
  for (const p of pending) {
    const itemCodes = extractItemCodes(p.title)
    if (itemCodes.length > 0) {
      const ids = findInventoryIdsByItemCodes(itemCodes)
      if (ids.length === 0) continue
      reserveInventory(p.mercari_item_id, ids)
      count++
      continue
    }

    const codes = extractCodes(p.title)
    if (codes.length !== 1) continue

    const qty = extractCodeQuantities(p.title).find(q => q.code === codes[0])?.qty ?? 1
    const ids = findInventoryIdsByModelCodeFifo(codes[0], qty)
    if (ids.length === 0) continue

    reserveInventory(p.mercari_item_id, ids)
    count++
  }
  return count
}

/**
 * 新しく取り込んだ販売の mercari_item_id と同じ出品があれば、その出品を sold にする
 * （引き当ての有無に関わらず。売れた以上、出品タブに active のまま残さない）。
 * 引き当て（listing_line）があれば、それをそのまま sale_line（link_source='listing'）へ移す
 * （人の決定をそのまま引き継ぐ。型番一致より優先）。
 * 出品時に発送方法を決めていれば、販売の shipping_method_id・shipping_fee・
 * is_shipping_confirmed・shipping_source（'manual'）へ引き継ぐ。ただし販売側に既に実額
 * （shipping_source='actual'）があればそちらを優先し、触らない。引き当てが0件でも
 * 発送方法だけは引き継ぐ。
 * 出品が無ければ何もせず false。引き当てが無かった（sale_line へ引き継げなかった）ときも
 * false を返す（呼び出し側が型番FIFOにフォールバック。出品を sold にする処理自体はここで完了済み）。
 */
function takeOverListing(saleId: string, mercariItemId: string | null): boolean {
  if (!mercariItemId) return false

  const listing = db.prepare(`
    SELECT mercari_item_id, shipping_method_id
      FROM listing WHERE mercari_item_id = ? AND status IN ('active','suspended')
  `).get(mercariItemId) as
    | { mercari_item_id: string; shipping_method_id: string | null } | undefined
  if (!listing) return false

  const lines = db.prepare('SELECT inventory_item_id FROM listing_line WHERE listing_id = ?')
    .all(mercariItemId) as Array<{ inventory_item_id: string }>

  const tx = db.transaction(() => {
    if (lines.length > 0) {
      const insLine = db.prepare(
        `INSERT INTO sale_line (id, sale_id, inventory_item_id, link_source) VALUES (?, ?, ?, 'listing')`,
      )
      for (const l of lines) insLine.run(randomUUID(), saleId, l.inventory_item_id)
      db.prepare('DELETE FROM listing_line WHERE listing_id = ?').run(mercariItemId)
    }
    db.prepare(
      `UPDATE listing SET status = 'sold', updated_at = datetime('now') WHERE mercari_item_id = ?`,
    ).run(mercariItemId)

    if (listing.shipping_method_id) {
      const sale = db.prepare('SELECT shipping_source, is_shipping_confirmed FROM sale WHERE id = ?')
        .get(saleId) as { shipping_source: string | null; is_shipping_confirmed: number } | undefined
      // 既に実額（actual）で確定していればそちらを優先し、触らない。
      // 実額が ¥0（メルカリ便以外＝未確定）なら、出品時に決めた発送方法を引き継ぐ
      if (sale && !(sale.shipping_source === 'actual' && sale.is_shipping_confirmed)) {
        const method = db.prepare('SELECT fee FROM shipping_method WHERE id = ?')
          .get(listing.shipping_method_id) as { fee: number } | undefined
        if (method) {
          db.prepare(`
            UPDATE sale
               SET shipping_method_id = ?, shipping_fee = ?,
                   is_shipping_confirmed = 1, shipping_source = 'manual'
             WHERE id = ?
          `).run(listing.shipping_method_id, method.fee, saleId)
        }
      }
    }
  })
  tx()

  return lines.length > 0
}

/** サムネイルをまだ持っていない出品（mercari_item_id）を返す */
export function listingsWithoutThumb(mercariItemIds: string[]): string[] {
  if (mercariItemIds.length === 0) return []
  const ph = mercariItemIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT mercari_item_id AS id FROM listing WHERE mercari_item_id IN (${ph}) AND thumb_file IS NULL`,
  ).all(...mercariItemIds) as Array<{ id: string }>
  return rows.map(r => r.id)
}

export function setListingThumb(mercariItemId: string, file: string): void {
  db.prepare(
    `UPDATE listing SET thumb_file = ?, updated_at = datetime('now') WHERE mercari_item_id = ?`,
  ).run(file, mercariItemId)
}

// ============================================================
// 在庫
// ============================================================

export function listInventory(status: InventoryStatus = 'in_stock'): InventoryItem[] {
  const items = db.prepare(
    `SELECT * FROM inventory_view WHERE status = ? ORDER BY aging_days DESC`,
  ).all(status) as InventoryRow[]
  return attachInventoryTags(items)
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
       (id, item_code, purchase_line_id, name, landed_cost, acquired_at, status,
        model_code, series_code, material, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?, ?)`,
  )

  const tx = db.transaction(() => {
    for (let n = 0; n < count; n++) {
      const childId = randomUUID()
      // 子は新しい在庫コードを持ち、名前は「元の名前（分割 1/2）」
      insItem.run(
        childId, nextItemCode(), item.purchase_line_id,
        `${item.name}（分割 ${n + 1}/${count}）`, parts[n], item.acquired_at,
        item.model_code, item.series_code, item.material, item.id,
      )
      childIds.push(childId)
    }
    // 引き当て中（出品に予約済み）だった場合、分割で親は売れなくなるので引き当ても外す
    db.prepare('DELETE FROM listing_line WHERE inventory_item_id = ?').run(id)
    db.prepare(`UPDATE inventory_item SET status = 'split', updated_at = datetime('now') WHERE id = ?`)
      .run(id)
  })
  tx()

  return childIds
}

/**
 * 分割を戻す：子が全部 in_stock で、どの出品にも引き当てられていない（listing_line にも
 * sale_line にも無い）ときだけ、子を消して親を in_stock に戻す。
 * 親の landed_cost・item_code・acquired_at はここでも一切書き換えない
 * （子の landed_cost の合計は生成時に親と一致しているはず。崩れていたら止める）。
 * 子のタグ・メモは親に寄せる（タグは重複を無視、メモは改行で追記）。子の item_code は欠番のまま。
 */
export function mergeSplitInventory(parentId: string): void {
  const parent = db.prepare('SELECT * FROM inventory_item WHERE id = ?').get(parentId) as
    | { id: string; status: InventoryStatus; landed_cost: number; note: string | null }
    | undefined
  if (!parent) throw new Error('在庫が見つかりません')
  if (parent.status !== 'split') throw new Error('分割した在庫ではありません')

  const children = db.prepare('SELECT * FROM inventory_item WHERE parent_id = ?').all(parentId) as
    Array<{ id: string; item_code: string; landed_cost: number; status: InventoryStatus; note: string | null }>
  if (children.length === 0) throw new Error('分割した子が見つかりません')

  const reasons: string[] = []
  for (const c of children) {
    if (c.status === 'sold') reasons.push(`${c.item_code} が販売済みです`)
    else if (c.status === 'disposed' || c.status === 'personal_use') {
      reasons.push(`${c.item_code} が廃棄／自家消費済みです`)
    } else if (c.status === 'split') {
      reasons.push(`${c.item_code} がさらに分割されています（先にそちらを戻してください）`)
    }

    const listed = db.prepare('SELECT COUNT(*) AS c FROM listing_line WHERE inventory_item_id = ?')
      .get(c.id) as { c: number }
    if (listed.c > 0) reasons.push(`${c.item_code} が出品に引き当て中です`)

    const sold = db.prepare('SELECT COUNT(*) AS c FROM sale_line WHERE inventory_item_id = ?')
      .get(c.id) as { c: number }
    if (sold.c > 0) reasons.push(`${c.item_code} が販売に紐付いています`)
  }
  if (reasons.length > 0) throw new Error(reasons.join('、'))

  const costSum = children.reduce((sum, c) => sum + c.landed_cost, 0)
  if (costSum !== parent.landed_cost) throw new Error('原価の合計が親と一致しません')

  const tx = db.transaction(() => {
    const copyTags = db.prepare(`
      INSERT OR IGNORE INTO inventory_tag (inventory_item_id, tag_id)
      SELECT ?, tag_id FROM inventory_tag WHERE inventory_item_id = ?
    `)
    for (const c of children) copyTags.run(parentId, c.id)

    const mergedNote = [parent.note, ...children.map(c => c.note)]
      .filter((n): n is string => !!n && n.trim() !== '')
      .join('\n')
    if (mergedNote !== (parent.note ?? '')) {
      db.prepare('UPDATE inventory_item SET note = ? WHERE id = ?').run(mergedNote || null, parentId)
    }

    for (const c of children) {
      db.prepare('DELETE FROM inventory_tag WHERE inventory_item_id = ?').run(c.id)
      db.prepare('DELETE FROM inventory_item WHERE id = ?').run(c.id)
    }

    db.prepare(`UPDATE inventory_item SET status = 'in_stock', updated_at = datetime('now') WHERE id = ?`)
      .run(parentId)
  })
  tx()
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

  const tx = db.transaction(() => {
    // 引き当て中（出品に予約済み）だった場合、廃棄・自家消費で売れなくなるので引き当ても外す
    db.prepare('DELETE FROM listing_line WHERE inventory_item_id = ?').run(id)
    db.prepare(
      `UPDATE inventory_item
          SET status = ?, disposed_at = date('now'),
              disposed_note = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(status, note, id)
  })
  tx()
}

// ============================================================
// 集計
// ============================================================

/** 月次集計。expense_total は expense.month（計上月）で集計する */
export function listMonthly(): MonthlySummary[] {
  const rows = db.prepare(
    `SELECT * FROM monthly_summary ORDER BY month DESC, kind`,
  ).all() as Array<Omit<MonthlySummary, 'unconfirmed_shipping' | 'expense_total' | 'net_profit' | 'closed'>>

  // 送料未入力の件数（月×kind）
  const unconfirmedRows = db.prepare(`
    SELECT substr(sold_at, 1, 7) AS month, kind, COUNT(*) AS c
    FROM sale WHERE is_shipping_confirmed = 0
    GROUP BY substr(sold_at, 1, 7), kind
  `).all() as Array<{ month: string; kind: SaleKind; c: number }>
  const unconfirmedMap = new Map(unconfirmedRows.map(r => [`${r.month}:${r.kind}`, r.c]))

  // 期間費用の月合計（計上月＝expense.month）。kind='resale' の行にだけ乗せる（私物は税務上別扱い）
  const expenseRows = db.prepare(`
    SELECT month, COALESCE(SUM(amount), 0) AS total
    FROM expense GROUP BY month
  `).all() as Array<{ month: string; total: number }>
  const expenseMap = new Map(expenseRows.map(r => [r.month, r.total]))

  const closedMonths = new Set(
    (db.prepare(`SELECT month FROM month_book WHERE closed_at IS NOT NULL`).all() as
      Array<{ month: string }>).map(r => r.month),
  )

  const result: MonthlySummary[] = rows.map(r => {
    const expense_total = r.kind === 'resale' ? (expenseMap.get(r.month) ?? 0) : 0
    return {
      ...r,
      unconfirmed_shipping: unconfirmedMap.get(`${r.month}:${r.kind}`) ?? 0,
      expense_total,
      net_profit: r.gross_profit - expense_total,
      closed: r.kind === 'resale' && closedMonths.has(r.month),
    }
  })

  // 売上がまだ無いが費用だけある月：resale の行が消えてしまうと期間費用も画面から消えるため、
  // 0件のresale行を補って出す
  const resaleMonths = new Set(result.filter(r => r.kind === 'resale').map(r => r.month))
  for (const [month, total] of expenseMap) {
    if (resaleMonths.has(month)) continue
    result.push({
      month, kind: 'resale',
      sales_count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0,
      total_cost: 0, gross_profit: 0,
      unconfirmed_shipping: 0, expense_total: total, net_profit: -total,
      closed: closedMonths.has(month),
    })
  }

  result.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? 1 : -1 // month DESC
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0 // kind ASC（personal, resale の順）
  })
  return result
}

// ------------------------------------------------------------
// 期間費用（レシート単位。梱包材・消耗品・送料実費・手数料など、販売1件に紐付かない費用）
//
// amount は明細（expense_line）があればその合計、無ければ入力した合計。
// 計上月（month）は購入日（occurred_at）の月が既定だが、変えられる。
// 月次の純利益・按分は occurred_at ではなく month で集計する。
// ------------------------------------------------------------

const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'packaging', 'supplies', 'shipping', 'fee', 'transfer_fee', 'other',
]

type ExpenseRow = {
  id: string
  occurred_at: string
  month: string
  shop: string | null
  category: ExpenseCategory
  amount: number
  note: string | null
  auto: number
  receipt_file: string | null
}

const EXPENSE_SELECT = `
  SELECT id, occurred_at, month, shop, category, amount, note, auto, receipt_file FROM expense
`

function loadExpenseLinesFor(expenseIds: string[]): Map<string, ExpenseLine[]> {
  const map = new Map<string, ExpenseLine[]>()
  if (expenseIds.length === 0) return map

  const ph = expenseIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT id, expense_id, name, unit_price, amount, quantity, category
    FROM expense_line
    WHERE expense_id IN (${ph})
    ORDER BY sort_order, rowid
  `).all(...expenseIds) as Array<
    {
      id: string; expense_id: string; name: string; unit_price: number; amount: number
      quantity: number; category: ExpenseCategory
    }
  >

  for (const r of rows) {
    const { expense_id, ...line } = r
    const arr = map.get(expense_id) ?? []
    arr.push(line)
    map.set(expense_id, arr)
  }
  return map
}

function hydrateExpenseRows(rows: ExpenseRow[]): Expense[] {
  const lineMap = loadExpenseLinesFor(rows.map(r => r.id))
  return rows.map(r => {
    const { receipt_file, ...rest } = r
    return { ...rest, receipt_url: toThumbUrl(receipt_file), lines: lineMap.get(r.id) ?? [] }
  })
}

/** month は YYYY-MM（計上月）で絞る。省略で全部。新しい順 */
export function listExpenses(month?: string): Expense[] {
  const rows = month
    ? db.prepare(`${EXPENSE_SELECT} WHERE month = ? ORDER BY occurred_at DESC, created_at DESC`)
        .all(month) as ExpenseRow[]
    : db.prepare(`${EXPENSE_SELECT} ORDER BY occurred_at DESC, created_at DESC`).all() as ExpenseRow[]
  return hydrateExpenseRows(rows)
}

type ValidatedExpense = {
  month: string
  category: ExpenseCategory
  amount: number
  lines: Array<
    { name: string; unit_price: number; quantity: number; amount: number; category: ExpenseCategory }
  >
}

/**
 * createExpense / updateExpense 共通の入力チェック。SqliteError が画面にそのまま
 * 出ないよう、分かる範囲で先に日本語で弾く。明細があれば amount・category を明細から導く。
 */
function validateExpenseInput(input: ExpenseInput): ValidatedExpense {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurred_at)) {
    throw new Error('購入日はYYYY-MM-DDの形式で入力してください')
  }
  const month = input.month ?? input.occurred_at.slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('計上月はYYYY-MMの形式で入力してください')
  }
  if (!EXPENSE_CATEGORIES.includes(input.category)) {
    throw new Error(`不正な費用区分です: ${input.category}`)
  }

  const lines = (input.lines ?? []).map((l, i) => {
    if (!l.name.trim()) throw new Error(`${i + 1}行目：品名を入力してください`)
    if (!Number.isInteger(l.unit_price) || l.unit_price < 0) {
      throw new Error(`${i + 1}行目：単価は0以上の整数で入力してください`)
    }
    const quantity = l.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`${i + 1}行目：数量は1以上の整数で入力してください`)
    }
    const category = l.category ?? input.category
    if (!EXPENSE_CATEGORIES.includes(category)) {
      throw new Error(`不正な費用区分です: ${category}`)
    }
    return { name: l.name.trim(), unit_price: l.unit_price, quantity, amount: l.unit_price * quantity, category }
  })

  const amount = lines.length > 0 ? lines.reduce((s, l) => s + l.amount, 0) : input.amount
  if (amount === undefined || amount === null) throw new Error('金額を入れてください')
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error('金額は0以上の整数で入力してください')
  }
  const category = lines.length > 0 ? lines[0].category : input.category

  return { month, category, amount, lines }
}

// ------------------------------------------------------------
// レシートの登録番号（T＋13桁）→ 店名の学習（shop_alias）。
// 会社ごとに固定な番号なので、一度店名を確定させれば次回の読み取りで使い回せる。
// resetData() では消さない（設定に近い知識）
// ------------------------------------------------------------

/** 学習済みの店名を返す。無ければ null */
export function lookupShopAlias(registrationNo: string): string | null {
  const row = db.prepare('SELECT shop FROM shop_alias WHERE key = ?').get(`reg:${registrationNo}`) as
    | { shop: string } | undefined
  return row ? row.shop : null
}

/** 「この登録番号＝この店名」を覚える（UPSERT）。shop は trim、空なら何もしない */
export function learnShopAlias(registrationNo: string, shop: string): void {
  const trimmed = shop.trim()
  if (!trimmed) return
  db.prepare(`
    INSERT INTO shop_alias (key, shop, hits, updated_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET shop = excluded.shop, hits = hits + 1, updated_at = datetime('now')
  `).run(`reg:${registrationNo}`, trimmed)
}

function insertExpenseLines(
  expenseId: string,
  lines: ValidatedExpense['lines'],
): void {
  const ins = db.prepare(`
    INSERT INTO expense_line (id, expense_id, name, unit_price, amount, quantity, category, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  lines.forEach((l, i) => {
    ins.run(randomUUID(), expenseId, l.name, l.unit_price, l.amount, l.quantity, l.category, i)
  })
}

/**
 * readReceiptImage が作った一時ファイル（receipt-tmp-<uuid>.<拡張子>、userData/thumbs）を
 * receipt-<経費id>.<拡張子> にリネームして本添付にする。想定外の名前・実在しないファイルは
 * 無視する（Error にしない）。既存のレシートがあれば消す
 */
function applyReceiptTempFile(id: string, tempFile: string | null | undefined): void {
  if (!tempFile || !tempFile.startsWith('receipt-tmp-')) return
  if (tempFile.includes('/') || tempFile.includes('\\') || tempFile.includes('..')) return

  const dir = join(app.getPath('userData'), 'thumbs')
  const srcPath = join(dir, tempFile)
  if (!existsSync(srcPath)) return

  const file = `receipt-${id}${extname(tempFile)}`
  const destPath = join(dir, file)

  const prevFile = getExpenseReceiptFile(id)
  if (prevFile && prevFile !== file) {
    try {
      unlinkSync(join(dir, prevFile))
    } catch {
      // 元々無い・消せない場合は無視
    }
  }

  renameSync(srcPath, destPath)
  setExpenseReceiptFile(id, file)
}

export function createExpense(input: ExpenseInput): string {
  const { month, category, amount, lines } = validateExpenseInput(input)
  const id = randomUUID()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO expense (id, occurred_at, month, shop, category, amount, note, auto)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(id, input.occurred_at, month, input.shop ?? null, category, amount, input.note ?? null)
    insertExpenseLines(id, lines)
    if (input.receipt_registration_no && input.shop) {
      learnShopAlias(input.receipt_registration_no, input.shop)
    }
  })
  tx()
  applyReceiptTempFile(id, input.receipt_temp_file)
  return id
}

/** 明細は全部入れ替える */
export function updateExpense(id: string, input: ExpenseInput): void {
  const exists = db.prepare('SELECT id FROM expense WHERE id = ?').get(id)
  if (!exists) throw new Error('経費が見つかりません')

  const { month, category, amount, lines } = validateExpenseInput(input)
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE expense
         SET occurred_at = ?, month = ?, shop = ?, category = ?, amount = ?, note = ?
       WHERE id = ?
    `).run(input.occurred_at, month, input.shop ?? null, category, amount, input.note ?? null, id)
    db.prepare('DELETE FROM expense_line WHERE expense_id = ?').run(id)
    insertExpenseLines(id, lines)
    if (input.receipt_registration_no && input.shop) {
      learnShopAlias(input.receipt_registration_no, input.shop)
    }
  })
  tx()
  applyReceiptTempFile(id, input.receipt_temp_file)
}

/** 明細は expense_line の ON DELETE CASCADE で消える。レシートファイル自体の削除は receipts.ts が担う */
export function deleteExpense(id: string): void {
  db.prepare('DELETE FROM expense WHERE id = ?').run(id)
}

/** receipts.ts が使う：経費に添付したレシート画像のファイル名を読む・書く */
export function getExpenseReceiptFile(id: string): string | null {
  const row = db.prepare('SELECT receipt_file FROM expense WHERE id = ?').get(id) as
    | { receipt_file: string | null } | undefined
  return row?.receipt_file ?? null
}

export function setExpenseReceiptFile(id: string, file: string | null): void {
  db.prepare('UPDATE expense SET receipt_file = ? WHERE id = ?').run(file, id)
}

// ------------------------------------------------------------
// 月次の明細・締め
//
// 経費はその月の販売用の販売（kind='resale'）にだけ按分する。私物には配賦しない。
// 金額按分＝販売価格の比、数量按分＝紐付けた在庫の点数の比（0点なら1）。
// floor で配って余りは最後の行（sales の末尾）に寄せ、Σallocated_expense = 経費合計にする。
// 販売が0件（または重みの合計が0）なら誰にも配賦しない（CLAUDE.mdの按分と同じ流儀）。
// ------------------------------------------------------------

function sumSaleTotals(sales: SaleProfit[]): Omit<MonthTotals, 'expense_total' | 'net_profit'> {
  return sales.reduce((acc, s) => ({
    sales_count: acc.sales_count + 1,
    revenue: acc.revenue + s.price,
    total_fee: acc.total_fee + s.fee,
    total_shipping: acc.total_shipping + s.shipping_fee,
    total_packaging: acc.total_packaging + s.packaging_cost,
    total_cost: acc.total_cost + s.cost,
    gross_profit: acc.gross_profit + s.gross_profit,
  }), {
    sales_count: 0, revenue: 0, total_fee: 0, total_shipping: 0,
    total_packaging: 0, total_cost: 0, gross_profit: 0,
  })
}

function allocateExpenseToSales(
  sales: Array<{ id: string; price: number; item_count: number }>,
  expenseTotal: number,
  method: AllocMethod,
): Map<string, number> {
  const map = new Map<string, number>()
  const weight = (s: { price: number; item_count: number }) =>
    method === 'by_quantity' ? Math.max(s.item_count, 1) : s.price
  const total = sales.reduce((sum, s) => sum + weight(s), 0)

  if (sales.length === 0 || total === 0) {
    for (const s of sales) map.set(s.id, 0)
    return map
  }

  let assigned = 0
  sales.forEach((s, idx) => {
    const isLast = idx === sales.length - 1
    // 端数は最終行へ。合計を expenseTotal と一致させるため
    const share = isLast ? expenseTotal - assigned : Math.floor((expenseTotal * weight(s)) / total)
    if (!isLast) assigned += share
    map.set(s.id, share)
  })
  return map
}

/** 月次の明細（月次タブの月をクリック）。tagId を渡すとそのタグの分だけの合計も返す */
export function getMonthDetail(month: string, opts?: { tagId?: string | null }): MonthDetail {
  const sales = listSales({ month, kind: 'resale' })
  const personal_sales = listSales({ month, kind: 'personal' })
  const expenses = listExpenses(month)
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0)

  const expense_by_category = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS amount
    FROM expense WHERE month = ?
    GROUP BY category
    ORDER BY category
  `).all(month) as Array<{ category: ExpenseCategory; amount: number }>

  const bookRow = db.prepare(`
    SELECT alloc_method, closed_at, sales_count, revenue, gross_profit, expense_total, net_profit
    FROM month_book WHERE month = ?
  `).get(month) as {
    alloc_method: AllocMethod
    closed_at: string | null
    sales_count: number | null
    revenue: number | null
    gross_profit: number | null
    expense_total: number | null
    net_profit: number | null
  } | undefined

  const alloc_method: AllocMethod = bookRow?.alloc_method ?? 'by_amount'

  const allocMap = allocateExpenseToSales(sales, expenseTotal, alloc_method)
  const monthSales: MonthSaleRow[] = sales.map(s => {
    const allocated_expense = allocMap.get(s.id) ?? 0
    return { ...s, allocated_expense, net_profit: s.gross_profit - allocated_expense }
  })

  const base = sumSaleTotals(sales)
  const totals: MonthTotals = {
    ...base,
    expense_total: expenseTotal,
    net_profit: base.gross_profit - expenseTotal,
  }

  let filtered: (MonthTotals & { tag: Tag }) | null = null
  if (opts?.tagId) {
    const tagRow = db.prepare('SELECT id, name, sort_order FROM tag WHERE id = ?')
      .get(opts.tagId) as Tag | undefined
    if (!tagRow) throw new Error('タグが見つかりません')

    const matched = monthSales.filter(s =>
      s.tags.some(t => t.id === opts.tagId) || s.inherited_tags.some(t => t.id === opts.tagId))
    const matchedBase = sumSaleTotals(matched)
    filtered = {
      ...matchedBase,
      expense_total: matched.reduce((sum, s) => sum + s.allocated_expense, 0),
      net_profit: matched.reduce((sum, s) => sum + s.net_profit, 0),
      tag: tagRow,
    }
  }

  const purchases_by_account = db.prepare(`
    SELECT p.shop_account_id AS shop_account_id, sa.name AS shop_account_name,
           COUNT(DISTINCT p.id) AS count,
           COALESCE(SUM(pl.unit_price * pl.quantity + pl.allocated_cost), 0) AS total_cost
    FROM purchase p
    JOIN shop_account sa ON sa.id = p.shop_account_id
    LEFT JOIN purchase_line pl ON pl.purchase_id = p.id
    WHERE substr(p.ordered_at, 1, 7) = ? AND p.status = 'confirmed'
    GROUP BY p.shop_account_id, sa.name
    ORDER BY sa.name
  `).all(month) as Array<
    { shop_account_id: string; shop_account_name: string; count: number; total_cost: number }
  >

  const pending = {
    unconfirmed_shipping: sales.filter(s => s.is_shipping_confirmed === 0).length,
    unmatched: sales.filter(s => s.unmatched === 1).length,
  }

  const close: MonthClose | null = bookRow?.closed_at
    ? {
        month,
        closed_at: bookRow.closed_at,
        alloc_method: bookRow.alloc_method,
        sales_count: bookRow.sales_count ?? 0,
        revenue: bookRow.revenue ?? 0,
        gross_profit: bookRow.gross_profit ?? 0,
        expense_total: bookRow.expense_total ?? 0,
        net_profit: bookRow.net_profit ?? 0,
      }
    : null

  const changed_since_close = close !== null && (
    close.sales_count !== totals.sales_count
    || close.revenue !== totals.revenue
    || close.gross_profit !== totals.gross_profit
    || close.expense_total !== totals.expense_total
    || close.net_profit !== totals.net_profit
  )

  return {
    month, alloc_method, close, changed_since_close,
    sales: monthSales, personal_sales, expenses, expense_by_category,
    totals, filtered, purchases_by_account, pending,
  }
}

/** その月の経費の按分方法（既定 by_amount）。締め済みでも変えられる */
export function setMonthAllocMethod(month: string, method: AllocMethod): void {
  db.prepare(`
    INSERT INTO month_book (month, alloc_method) VALUES (?, ?)
    ON CONFLICT(month) DO UPDATE SET alloc_method = excluded.alloc_method
  `).run(month, method)
}

/** 終わった月（今月・未来ではない月）だけ締められる。締めた時点の数字を month_book に記録する */
export function closeMonth(month: string): MonthClose {
  if (month >= thisMonthLocal()) {
    throw new Error('終わった月だけ締められます')
  }

  const detail = getMonthDetail(month)
  const closedAt = new Date().toISOString()

  db.prepare(`
    INSERT INTO month_book
      (month, alloc_method, closed_at, sales_count, revenue, gross_profit, expense_total, net_profit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      closed_at = excluded.closed_at,
      sales_count = excluded.sales_count,
      revenue = excluded.revenue,
      gross_profit = excluded.gross_profit,
      expense_total = excluded.expense_total,
      net_profit = excluded.net_profit
  `).run(
    month, detail.alloc_method, closedAt,
    detail.totals.sales_count, detail.totals.revenue, detail.totals.gross_profit,
    detail.totals.expense_total, detail.totals.net_profit,
  )

  return {
    month,
    closed_at: closedAt,
    alloc_method: detail.alloc_method,
    sales_count: detail.totals.sales_count,
    revenue: detail.totals.revenue,
    gross_profit: detail.totals.gross_profit,
    expense_total: detail.totals.expense_total,
    net_profit: detail.totals.net_profit,
  }
}

/** 締めを解除する（数字は消える。alloc_method は残す） */
export function reopenMonth(month: string): void {
  db.prepare(`
    UPDATE month_book
       SET closed_at = NULL, sales_count = NULL, revenue = NULL, gross_profit = NULL,
           expense_total = NULL, net_profit = NULL
     WHERE month = ?
  `).run(month)
}

export function listVariantSummary(
  sort: 'total_profit' | 'avg_profit' | 'sold' = 'total_profit',
): VariantSummary[] {
  const col = sort === 'avg_profit' ? 'avg_profit' : sort === 'sold' ? 'sold' : 'total_profit'
  return db.prepare(
    `SELECT * FROM variant_summary ORDER BY ${col} DESC`,
  ).all() as VariantSummary[]
}

// ============================================================
// 商品（型番）ページ・在庫の履歴
// ============================================================

type ProductSummarySort = 'total_profit' | 'avg_profit' | 'sold' | 'in_stock' | 'last_purchased_at'

type ProductSummaryRow = VariantSummary & {
  purchase_total: number
  avg_cost: number | null
  last_purchased_at: string | null
  last_sold_at: string | null
  thumb_file: string | null
}

/**
 * variant_summary に仕入額・最新日・サムネイルを足したもの。
 * purchase_total / avg_cost は split 親を除いた在庫（= variant_summary の purchased と同じ母集団）で計算する。
 */
function selectProducts(sort: ProductSummarySort): ProductSummaryRow[] {
  // SQLite は NULL を最小として扱うため、DESC で並べれば null は自動的に最後に来る
  const col: Record<ProductSummarySort, string> = {
    total_profit: 'total_profit',
    avg_profit: 'avg_profit',
    sold: 'sold',
    in_stock: 'in_stock',
    last_purchased_at: 'last_purchased_at',
  }

  return db.prepare(`
    SELECT
      vs.*,
      COALESCE(pt.purchase_total, 0)                        AS purchase_total,
      pt.avg_cost                                           AS avg_cost,
      pt.last_purchased_at                                  AS last_purchased_at,
      st.last_sold_at                                       AS last_sold_at,
      (
        SELECT sp2.thumb_file
        FROM inventory_item i2
        JOIN sale_line   sl2 ON sl2.inventory_item_id = i2.id
        JOIN sale_profit sp2 ON sp2.id = sl2.sale_id
        WHERE i2.model_code = vs.model_code
        ORDER BY sp2.sold_at DESC
        LIMIT 1
      ) AS thumb_file
    FROM variant_summary vs
    LEFT JOIN (
      SELECT
        model_code,
        SUM(landed_cost)                             AS purchase_total,
        CAST(ROUND(AVG(landed_cost)) AS INTEGER)      AS avg_cost,
        MAX(acquired_at)                              AS last_purchased_at
      FROM inventory_item
      WHERE model_code IS NOT NULL AND status != 'split'
      GROUP BY model_code
    ) pt ON pt.model_code = vs.model_code
    LEFT JOIN (
      SELECT i.model_code, MAX(sp.sold_at) AS last_sold_at
      FROM inventory_item i
      JOIN sale_line   sl ON sl.inventory_item_id = i.id
      JOIN sale_profit sp ON sp.id = sl.sale_id
      GROUP BY i.model_code
    ) st ON st.model_code = vs.model_code
    ORDER BY ${col[sort]} DESC
  `).all() as ProductSummaryRow[]
}

function toProductSummary(r: ProductSummaryRow, tags: Tag[]): ProductSummary {
  const { thumb_file, ...rest } = r
  return { ...rest, thumb_url: toThumbUrl(thumb_file), tags }
}

export function listProducts(sort: ProductSummarySort = 'total_profit'): ProductSummary[] {
  const rows = selectProducts(sort)
  const tagMap = loadTagsFor('product_tag', 'model_code', rows.map(r => r.model_code))
  return rows.map(r => toProductSummary(r, tagMap.get(r.model_code) ?? []))
}

/** 'YYYY-MM' を1か月進める */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m, 1) // m は1〜12（次の月がそのままDateのmonthインデックスになる）
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function getProduct(modelCode: string): ProductDetail | null {
  const base = selectProducts('total_profit').find(r => r.model_code === modelCode)
  if (!base) return null

  const purchaseRows = db.prepare(`
    SELECT acquired_at, landed_cost
    FROM inventory_item
    WHERE model_code = ? AND status != 'split'
  `).all(modelCode) as Array<{ acquired_at: string; landed_cost: number }>

  // 1点あたりの売上・粗利は sale_line_share の整数按分をそのまま使う（端数は最終行に寄っている）
  const soldRows = db.prepare(`
    SELECT sp.sold_at, sls.price_share AS price, sls.profit_share AS profit
    FROM inventory_item i
    JOIN sale_line       sl  ON sl.inventory_item_id = i.id
    JOIN sale_profit     sp  ON sp.id = sl.sale_id
    JOIN sale_line_share sls ON sls.inventory_item_id = i.id
    WHERE i.model_code = ?
  `).all(modelCode) as Array<{ sold_at: string; price: number; profit: number }>

  const disposedRows = db.prepare(`
    SELECT disposed_at
    FROM inventory_item
    WHERE model_code = ? AND status IN ('disposed','personal_use') AND disposed_at IS NOT NULL
  `).all(modelCode) as Array<{ disposed_at: string }>

  const purchaseByMonth = new Map<string, { purchased: number; purchase_amount: number }>()
  for (const r of purchaseRows) {
    const m = r.acquired_at.slice(0, 7)
    const cur = purchaseByMonth.get(m) ?? { purchased: 0, purchase_amount: 0 }
    cur.purchased += 1
    cur.purchase_amount += r.landed_cost
    purchaseByMonth.set(m, cur)
  }

  const soldByMonth = new Map<string, { sold: number; sales_amount: number; profit: number }>()
  for (const r of soldRows) {
    const m = r.sold_at.slice(0, 7)
    const cur = soldByMonth.get(m) ?? { sold: 0, sales_amount: 0, profit: 0 }
    cur.sold += 1
    cur.sales_amount += r.price
    cur.profit += r.profit
    soldByMonth.set(m, cur)
  }

  const disposedByMonth = new Map<string, number>()
  for (const r of disposedRows) {
    const m = r.disposed_at.slice(0, 7)
    disposedByMonth.set(m, (disposedByMonth.get(m) ?? 0) + 1)
  }

  const knownMonths = [...purchaseByMonth.keys(), ...soldByMonth.keys()].sort()
  const firstMonth = knownMonths[0] ?? thisMonthLocal()
  const lastMonth = thisMonthLocal()

  const months: ProductMonthPoint[] = []
  let cumulative = 0
  for (let m = firstMonth; m <= lastMonth; m = nextMonth(m)) {
    const p = purchaseByMonth.get(m) ?? { purchased: 0, purchase_amount: 0 }
    const s = soldByMonth.get(m) ?? { sold: 0, sales_amount: 0, profit: 0 }
    const disposed = disposedByMonth.get(m) ?? 0
    cumulative += p.purchased - s.sold - disposed
    months.push({
      month: m,
      purchased: p.purchased,
      sold: s.sold,
      in_stock: cumulative,
      purchase_amount: p.purchase_amount,
      sales_amount: s.sales_amount,
      profit: s.profit,
    })
  }

  const items = attachInventoryTags(
    db.prepare(
      `SELECT * FROM inventory_view WHERE model_code = ? ORDER BY acquired_at DESC`,
    ).all(modelCode) as InventoryRow[],
  )

  const saleRows = db.prepare(`
    SELECT DISTINCT sp.*
    FROM sale_profit sp
    JOIN sale_line     sl ON sl.sale_id = sp.id
    JOIN inventory_item i ON i.id = sl.inventory_item_id
    WHERE i.model_code = ?
    ORDER BY sp.sold_at DESC
  `).all(modelCode) as SaleProfitRow[]

  return {
    ...toProductSummary(base, loadTagsFor('product_tag', 'model_code', [modelCode]).get(modelCode) ?? []),
    months,
    items,
    sales: hydrateSaleProfitRows(saleRows),
  }
}

/**
 * 在庫1点の履歴（仕入→到着→販売→発送→受取→取引完了）。
 * 在庫が無ければ null。仕入・販売のどちらかが無くても組み立てられる分だけ返す。
 */
export function getItemTimeline(inventoryItemId: string): ItemTimeline | null {
  const itemRow = db.prepare(
    `SELECT * FROM inventory_view WHERE id = ?`,
  ).get(inventoryItemId) as InventoryRow | undefined
  if (!itemRow) return null
  const item = attachInventoryTags([itemRow])[0]

  const raw = db.prepare(
    `SELECT purchase_line_id, parent_id, disposed_at, disposed_note FROM inventory_item WHERE id = ?`,
  ).get(inventoryItemId) as {
    purchase_line_id: string | null
    parent_id: string | null
    disposed_at: string | null
    disposed_note: string | null
  }

  let purchase: PurchaseSummary | null = null
  let lineUnitPrice: number | null = null
  if (raw.purchase_line_id) {
    const line = db.prepare(
      `SELECT unit_price, purchase_id FROM purchase_line WHERE id = ?`,
    ).get(raw.purchase_line_id) as { unit_price: number; purchase_id: string } | undefined
    if (line) {
      lineUnitPrice = line.unit_price
      purchase = getPurchaseSummary(line.purchase_id) ?? null
    }
  }

  const saleRow = db.prepare(`
    SELECT sp.* FROM sale_line sl
    JOIN sale_profit sp ON sp.id = sl.sale_id
    WHERE sl.inventory_item_id = ?
  `).get(inventoryItemId) as SaleProfitRow | undefined
  const sale = saleRow ? hydrateSaleProfitRows([saleRow])[0] : null

  const events: TimelineEvent[] = []

  if (purchase && lineUnitPrice !== null) {
    const allocatedForItem = item.landed_cost - lineUnitPrice
    const detail = allocatedForItem === 0
      ? `${yenText(lineUnitPrice)} → 原価 ${yenText(item.landed_cost)}`
      : `${yenText(lineUnitPrice)} ＋送料按分 ${yenText(allocatedForItem)} → 原価 ${yenText(item.landed_cost)}`
    events.push({
      date: purchase.ordered_at,
      kind: 'ordered',
      title: `${purchase.shop_account_name}で注文${purchase.order_no ? ' ' + purchase.order_no : ''}`,
      detail,
      amount: item.landed_cost,
    })
  }

  // fulfillment が null（手入力）なら発送・到着の予定は出さない
  if (purchase && purchase.fulfillment !== null) {
    events.push({
      date: purchase.shipped_at,
      kind: 'purchase_shipped',
      title: '仕入先が発送',
      detail: null,
      amount: null,
    })
    events.push({
      date: purchase.delivered_at,
      kind: 'purchase_delivered',
      title: '到着',
      detail: null,
      amount: null,
    })
  }

  if (raw.parent_id) {
    const parent = db.prepare('SELECT name FROM inventory_item WHERE id = ?')
      .get(raw.parent_id) as { name: string } | undefined
    events.push({
      date: item.acquired_at,
      kind: 'split',
      title: '分割で生成',
      detail: parent ? `「${parent.name}」から分割` : null,
      amount: null,
    })
  }

  // 出品への引き当て（未販売ならitem.listingから）／売れたあとも、その紐付けが
  // link_source='listing'（出品からの引き継ぎ）なら「出品」イベントを足す
  let listingInfo: { price: number; listed_at: string } | null = null
  if (item.listing) {
    listingInfo = db.prepare('SELECT price, listed_at FROM listing WHERE mercari_item_id = ?')
      .get(item.listing.mercari_item_id) as { price: number; listed_at: string } | undefined ?? null
  } else if (sale) {
    const saleLine = db.prepare(
      'SELECT link_source FROM sale_line WHERE inventory_item_id = ? AND sale_id = ?',
    ).get(inventoryItemId, sale.id) as { link_source: LinkSource } | undefined
    if (saleLine?.link_source === 'listing' && sale.mercari_item_id) {
      listingInfo = db.prepare('SELECT price, listed_at FROM listing WHERE mercari_item_id = ?')
        .get(sale.mercari_item_id) as { price: number; listed_at: string } | undefined ?? null
    }
  }
  if (listingInfo) {
    events.push({
      date: listingInfo.listed_at,
      kind: 'listed',
      title: 'メルカリに出品',
      detail: yenText(listingInfo.price),
      amount: listingInfo.price,
    })
  }

  if (sale) {
    const detailParts = [yenText(sale.price)]
    if (sale.item_count > 1) {
      // この在庫1点あたりの取り分。sale_line_share の整数按分（端数は最終行）を使う
      const share = db.prepare(
        'SELECT price_share FROM sale_line_share WHERE inventory_item_id = ? AND sale_id = ?',
      ).get(inventoryItemId, sale.id) as { price_share: number } | undefined
      const perItem = share?.price_share ?? Math.floor(sale.price / sale.item_count)
      detailParts.push(`（まとめ売り ${sale.item_count} 点、1 点あたり ${yenText(perItem)}）`)
    }
    if (sale.buyer) detailParts.push(`買い手：${sale.buyer}`)

    events.push({
      date: sale.sold_at,
      kind: 'sold',
      title: 'メルカリで売れた',
      detail: detailParts.join(' '),
      amount: sale.price,
    })
    events.push({
      date: sale.shipped_at,
      kind: 'sale_shipped',
      title: '発送済み',
      detail: null,
      amount: null,
    })
    events.push({
      date: sale.delivered_at,
      kind: 'sale_delivered',
      title: '受取済み',
      detail: null,
      amount: null,
    })
    events.push({
      date: sale.completed_at,
      kind: 'sale_completed',
      title: '取引完了',
      detail: `売上金 ${yenText(sale.price - sale.fee - sale.shipping_fee)} 反映`,
      amount: null,
    })
  }

  if (item.status === 'disposed' || item.status === 'personal_use') {
    events.push({
      date: raw.disposed_at,
      kind: item.status,
      title: item.status === 'disposed' ? '廃棄' : '自家消費',
      detail: raw.disposed_note,
      amount: null,
    })
  }

  // 日付昇順。同日（null同士も含む）は上で積んだ順（＝仕様の並び）を保つ
  // （Array#sort は安定ソートなので、比較が同値なら元の順序が保たれる）
  const dateKey = (d: string | null) => d ?? '9999-99-99'
  events.sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)))

  return { item, events, sale, purchase }
}

// ============================================================
// タグ
//
// 仕入・販売・在庫に複数付けられる。名前は一意。消すと CASCADE で
// 付いていた仕入・販売・在庫からも外れる（T-04）。
// 仕入・在庫のタグは下流（在庫・販売）へ「派生」で見える（コピーしない）。
// ============================================================

export function listTags(): Tag[] {
  return db.prepare('SELECT id, name, sort_order FROM tag ORDER BY sort_order, name').all() as Tag[]
}

export function createTag(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('タグ名を入力してください')

  const exists = db.prepare('SELECT id FROM tag WHERE name = ?').get(trimmed) as
    | { id: string } | undefined
  if (exists) throw new Error('同じ名前のタグがあります')

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tag').get() as
    { m: number }
  const id = randomUUID()
  db.prepare('INSERT INTO tag (id, name, sort_order) VALUES (?, ?, ?)')
    .run(id, trimmed, maxOrder.m + 1)
  return id
}

export function renameTag(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('タグ名を入力してください')

  const exists = db.prepare('SELECT id FROM tag WHERE name = ? AND id != ?').get(trimmed, id) as
    | { id: string } | undefined
  if (exists) throw new Error('同じ名前のタグがあります')

  const result = db.prepare('UPDATE tag SET name = ? WHERE id = ?').run(trimmed, id)
  if (result.changes === 0) throw new Error('タグが見つかりません')
}

/** タグを消すと、付いていた仕入・販売・在庫からも CASCADE で外れる */
export function deleteTag(id: string): void {
  db.prepare('DELETE FROM tag WHERE id = ?').run(id)
}

/** 販売のタグを丸ごと置き換える（空配列で全部外す） */
export function setSaleTags(saleId: string, tagIds: string[]): void {
  const unique = [...new Set(tagIds)]
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM sale_tag WHERE sale_id = ?').run(saleId)
    const ins = db.prepare('INSERT INTO sale_tag (sale_id, tag_id) VALUES (?, ?)')
    for (const tagId of unique) ins.run(saleId, tagId)
  })
  tx()
}

export function setInventoryTags(itemId: string, tagIds: string[]): void {
  const unique = [...new Set(tagIds)]
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM inventory_tag WHERE inventory_item_id = ?').run(itemId)
    const ins = db.prepare('INSERT INTO inventory_tag (inventory_item_id, tag_id) VALUES (?, ?)')
    for (const tagId of unique) ins.run(itemId, tagId)
  })
  tx()
}

/**
 * 仕入のタグを丸ごと置き換える（空配列で全部外す）。
 * その仕入から生まれた在庫すべて・その在庫が紐付いた販売に派生で見える（コピーしない）
 */
export function setPurchaseTags(purchaseId: string, tagIds: string[]): void {
  const unique = [...new Set(tagIds)]
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM purchase_tag WHERE purchase_id = ?').run(purchaseId)
    const ins = db.prepare('INSERT INTO purchase_tag (purchase_id, tag_id) VALUES (?, ?)')
    for (const tagId of unique) ins.run(purchaseId, tagId)
  })
  tx()
}

/**
 * 商品（型番）のタグを丸ごと置き換える（空配列で全部外す）。
 * その型番の在庫すべて・その在庫が紐付いた販売に派生で見える（コピーしない）
 */
export function setProductTags(modelCode: string, tagIds: string[]): void {
  const unique = [...new Set(tagIds)]
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM product_tag WHERE model_code = ?').run(modelCode)
    const ins = db.prepare('INSERT INTO product_tag (model_code, tag_id) VALUES (?, ?)')
    for (const tagId of unique) ins.run(modelCode, tagId)
  })
  tx()
}

/**
 * 型番の表示名を人が上書きする（商品ページ）。trim して空/null なら消し、
 * variant_summary.name は最新の在庫名に戻る。modelCode は在庫に無くても保存してよい
 * （型番の入力ミスは画面側で防ぐ）。resetData() では消さない（shop_alias と同じ扱い）
 */
export function setProductName(modelCode: string, name: string | null): void {
  const trimmed = name?.trim()
  if (!trimmed) {
    db.prepare('DELETE FROM product_name WHERE model_code = ?').run(modelCode)
    return
  }
  db.prepare(`
    INSERT INTO product_name (model_code, name, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(model_code) DO UPDATE SET name = excluded.name, updated_at = datetime('now')
  `).run(modelCode, trimmed)
}

export function getDashboard(): DashboardStats {
  const one = <T>(sql: string, ...v: unknown[]) => db.prepare(sql).get(...v) as T

  const needsShipping = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale WHERE is_shipping_confirmed = 0`).c

  const needsMatch = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale_profit WHERE unmatched = 1 AND kind = 'resale'`).c

  const needsPurchaseConfirm = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM purchase WHERE status = 'draft'`).c

  const needsListingAllocation = one<{ c: number }>(`
    SELECT COUNT(*) AS c FROM listing l
     WHERE l.status = 'active' AND NOT EXISTS (
       SELECT 1 FROM listing_line ll WHERE ll.listing_id = l.mercari_item_id
     )
  `).c

  // 発送が必要な販売（取引中タブで「発送してください」の段階）。放置すると評価が下がるので
  // ホームの要対応の上位に出す
  const needsShipment = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sale WHERE status = 'waiting_shipment'`).c

  const stock = one<{ c: number; v: number }>(
    `SELECT COUNT(*) AS c, COALESCE(SUM(landed_cost),0) AS v
       FROM inventory_item WHERE status = 'in_stock'`)

  const warnDays = setting('aging_warn_days', 90)
  const aging = one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM inventory_view
      WHERE status = 'in_stock' AND aging_days >= ?`, warnDays).c

  // monthly_summary ビューには unconfirmed_shipping / expense_total / net_profit が無い
  // （listMonthly() が期間費用の自動計上を通した上で後付けしている）ため、直接ビューを
  // 読まず listMonthly() の結果から今月の resale 行を拾う
  const month = thisMonthLocal()
  const thisMonth = listMonthly().find(r => r.month === month && r.kind === 'resale')

  const lastRun = db.prepare(
    `${RUN_SELECT} ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
  ).get() as CollectorRun | undefined

  // 取り込み元ごとの直近1件（mercari + 有効なメロジョイ口座ごとに1件）。
  // 最後の1回だけ見ていると、別の取り込み元の成功で他の失敗が隠れるため、
  // 元ごとに直近の状態をホームの要対応で拾えるようにする
  const mercariRun = db.prepare(
    `${RUN_SELECT} WHERE r.source = 'mercari' ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
  ).get() as CollectorRun | undefined

  const accountRuns = db.prepare(`
    SELECT sa.id AS account_id
      FROM shop_account sa
     WHERE sa.is_active = 1 AND sa.kind = 'mellojoy'
     ORDER BY sa.name
  `).all() as { account_id: string }[]

  const accountRunSelect = db.prepare(
    `${RUN_SELECT} WHERE r.shop_account_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
  )
  const recentRuns: CollectorRun[] = []
  if (mercariRun) recentRuns.push(mercariRun)
  for (const { account_id } of accountRuns) {
    const run = accountRunSelect.get(account_id) as CollectorRun | undefined
    if (run) recentRuns.push(run)
  }

  return {
    needsShipping,
    needsMatch,
    needsPurchaseConfirm,
    needsListingAllocation,
    needsShipment,
    stockCount: stock.c,
    stockValue: stock.v,
    agingCount: aging,
    thisMonth: thisMonth ?? null,
    lastRun: lastRun ?? null,
    recentRuns,
  }
}

// ============================================================
// 横断検索（「あの商品どうなった？」を1か所で。全期間・全状態が対象）
//
// SQL の LIKE は大文字小文字・全角半角を無視できないため、候補は SQL で
// 広めに取り（既存の listInventory/listListings/listSales/listPurchases をそのまま
// 使う）、絞り込みは renderer の SearchBox.vue の matchesSearch と同じ規則で
// JS 側（normalize('NFKC').toLowerCase() + 空白区切り AND）で行う。
// ============================================================

const SEARCH_INVENTORY_STATUSES: InventoryStatus[] =
  ['in_stock', 'sold', 'disposed', 'personal_use', 'split']
const SEARCH_LISTING_STATUSES: ListingStatus[] = ['active', 'suspended', 'sold', 'ended']

function normalizeSearchText(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/** query を空白区切りにした語（terms）が haystacks のどれかに全部含まれるか（AND） */
function matchesQuery(haystacks: Array<string | null | undefined>, terms: string[]): boolean {
  if (terms.length === 0) return true
  const normalized = haystacks.filter((h): h is string => !!h).map(normalizeSearchText)
  return terms.every(term => normalized.some(h => h.includes(term)))
}

function inventoryStatusLabel(item: InventoryItem): string {
  switch (item.status) {
    case 'in_stock': return item.listing ? '出品中' : '未出品'
    case 'sold': return '販売済'
    case 'disposed': return '廃棄'
    case 'personal_use': return '自家消費'
    case 'split': return '分割済'
  }
}

function listingStatusLabel(status: ListingStatus): string {
  switch (status) {
    case 'active': return '出品中'
    case 'suspended': return '公開停止中'
    case 'sold': return '売れた'
    case 'ended': return '取り下げ'
  }
}

/** 優先はこの順、複数なら先頭：送料未入力 → 未紐付け（転売のみ） → 私物 → 完了 */
function saleStatusLabel(s: SaleProfit): string {
  if (s.is_shipping_confirmed === 0) return '送料未入力'
  if (s.unmatched === 1 && s.kind === 'resale') return '未紐付け'
  if (s.kind === 'personal') return '私物'
  return '完了'
}

function purchaseStatusLabel(p: PurchaseSummary): string {
  if (p.status === 'draft') return '下書き'
  if (p.fulfillment === 'delivered') return '到着済'
  if (p.fulfillment === 'shipped') return '配送中'
  return '未着'
}

/** 仕入の明細（全件）の name/model_code を、purchase_id ごとにまとめて1クエリで引く */
function loadPurchaseLineTexts(purchaseIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (purchaseIds.length === 0) return map

  const ph = purchaseIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT purchase_id, name, model_code FROM purchase_line WHERE purchase_id IN (${ph})`,
  ).all(...purchaseIds) as Array<{ purchase_id: string; name: string; model_code: string | null }>

  for (const r of rows) {
    const arr = map.get(r.purchase_id) ?? []
    arr.push(r.name)
    if (r.model_code) arr.push(r.model_code)
    map.set(r.purchase_id, arr)
  }
  return map
}

/** date（YYYY-MM-DD 等）降順に並べ、種類ごとの上限で切る */
function sortAndSlice(hits: SearchHit[], perKind: number): SearchHit[] {
  return hits
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, perKind)
}

function searchInventoryHits(terms: string[], perKind: number): SearchHit[] {
  const items = SEARCH_INVENTORY_STATUSES.flatMap(status => listInventory(status))

  const hits: SearchHit[] = items
    .filter(i => matchesQuery([
      i.name, i.item_code, i.model_code, i.series_code, i.material, i.note,
      i.order_no, i.shop_account_name,
      ...i.tags.map(t => t.name), ...i.inherited_tags.map(t => t.name),
    ], terms))
    .map(i => ({
      kind: 'inventory',
      id: i.id,
      title: i.name,
      model_code: i.model_code,
      status_label: inventoryStatusLabel(i),
      amount: i.landed_cost,
      date: i.acquired_at,
      thumb_url: i.thumb_url,
    }))

  return sortAndSlice(hits, perKind)
}

function searchListingHits(terms: string[], perKind: number): SearchHit[] {
  const listings = listListings({ status: SEARCH_LISTING_STATUSES })

  const hits: SearchHit[] = listings
    .filter(l => matchesQuery([
      l.title, ...l.model_codes,
      ...l.items.map(i => i.name), ...l.items.map(i => i.model_code),
    ], terms))
    .map(l => ({
      kind: 'listing',
      id: l.mercari_item_id,
      title: l.title,
      model_code: l.model_codes[0] ?? null,
      status_label: listingStatusLabel(l.status),
      amount: l.price,
      date: l.first_seen_at,
      thumb_url: l.thumb_url,
    }))

  return sortAndSlice(hits, perKind)
}

function searchSaleHits(terms: string[], perKind: number): SearchHit[] {
  const sales = listSales()

  const hits: SearchHit[] = sales
    .filter(s => matchesQuery([
      s.title, s.note, s.buyer, ...s.model_codes,
      ...s.tags.map(t => t.name), ...s.inherited_tags.map(t => t.name),
    ], terms))
    .map(s => ({
      kind: 'sale',
      id: s.id,
      title: s.title,
      model_code: s.model_codes[0] ?? null,
      status_label: saleStatusLabel(s),
      amount: s.price,
      date: s.sold_at,
      thumb_url: s.thumb_url,
    }))

  return sortAndSlice(hits, perKind)
}

function searchPurchaseHits(terms: string[], perKind: number): SearchHit[] {
  const purchases = listPurchases()
  const lineTexts = loadPurchaseLineTexts(purchases.map(p => p.id))

  const hits: SearchHit[] = purchases
    .filter(p => matchesQuery([
      p.first_line_name, p.order_no, p.shop_account_name, p.note,
      ...p.tags.map(t => t.name), ...(lineTexts.get(p.id) ?? []),
    ], terms))
    .map(p => ({
      kind: 'purchase',
      id: p.id,
      title: p.first_line_name ?? p.order_no ?? '(仕入)',
      model_code: p.first_model_code,
      status_label: purchaseStatusLabel(p),
      amount: p.total_cost,
      date: p.ordered_at,
      thumb_url: null,
    }))

  return sortAndSlice(hits, perKind)
}

/**
 * 空白区切りAND、NFKC正規化。種類ごと（inventory→listing→sale→purchase）に新しい順、
 * 種類ごとの上限は ceil(limit/4)。空文字なら []
 */
export function searchAll(query: string, limit = 60): SearchHit[] {
  const terms = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const perKind = Math.ceil(limit / 4)

  return [
    ...searchInventoryHits(terms, perKind),
    ...searchListingHits(terms, perKind),
    ...searchSaleHits(terms, perKind),
    ...searchPurchaseHits(terms, perKind),
  ]
}

// ============================================================
// マスタ
// ============================================================

export function listShopAccounts(): ShopAccount[] {
  const rows = db.prepare('SELECT * FROM shop_account ORDER BY name').all() as
    Array<Omit<ShopAccount, 'auto_tags'>>
  const tagMap = loadTagsFor('shop_account_tag', 'shop_account_id', rows.map(r => r.id))
  return rows.map(r => ({ ...r, auto_tags: tagMap.get(r.id) ?? [] }))
}

/**
 * 仕入先ごとの累計（確定済みの仕入だけ。下書きは含めない）。
 * total_cost は listPurchases の total_cost（商品計＋送料＋その他−割引）の合計と一致する。
 * 仕入が0件の仕入先も0件・null で返す（LEFT JOIN）
 */
export function listShopAccountStats(): ShopAccountStats[] {
  return db.prepare(`
    SELECT
      sa.id AS shop_account_id,
      COUNT(DISTINCT p.id) AS orders,
      COALESCE(SUM(pl.quantity), 0) AS items,
      COALESCE(SUM(pl.unit_price * pl.quantity + pl.allocated_cost), 0) AS total_cost,
      MAX(p.ordered_at) AS last_ordered_at
    FROM shop_account sa
    LEFT JOIN purchase p ON p.shop_account_id = sa.id AND p.status = 'confirmed'
    LEFT JOIN purchase_line pl ON pl.purchase_id = p.id
    GROUP BY sa.id
    ORDER BY sa.name
  `).all() as ShopAccountStats[]
}

export function createShopAccount(name: string, kind: ShopAccountKind = 'other'): string {
  const id = randomUUID()
  db.prepare('INSERT INTO shop_account (id, name, kind) VALUES (?, ?, ?)').run(id, name, kind)
  return id
}

export function getShopAccount(id: string): ShopAccount | undefined {
  const row = db.prepare('SELECT * FROM shop_account WHERE id = ?').get(id) as
    Omit<ShopAccount, 'auto_tags'> | undefined
  if (!row) return undefined
  const tagMap = loadTagsFor('shop_account_tag', 'shop_account_id', [id])
  return { ...row, auto_tags: tagMap.get(id) ?? [] }
}

export function updateShopAccount(
  id: string,
  patch: {
    name?: string; kind?: ShopAccountKind; is_active?: number; import_keywords?: string | null
    /** 置き換え（丸ごと入れ替え）。この口座の以後の仕入作成時にだけ効く（過去の仕入は変わらない） */
    auto_tag_ids?: string[]
    /** 手入力の仕入フォームで、この仕入先を選んだときに入る送料の既定値（円）。null で未設定に戻す */
    default_shipping_fee?: number | null
  },
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }

  if (patch.name !== undefined) put('name', patch.name)
  if (patch.kind !== undefined) put('kind', patch.kind)
  if (patch.is_active !== undefined) put('is_active', patch.is_active)
  if (patch.import_keywords !== undefined) {
    const trimmed = patch.import_keywords?.trim()
    put('import_keywords', trimmed ? patch.import_keywords : null)
  }
  if (patch.default_shipping_fee !== undefined) {
    const fee = patch.default_shipping_fee
    if (fee !== null && (!Number.isInteger(fee) || fee < 0)) {
      throw new Error('送料は 0 以上の整数で')
    }
    put('default_shipping_fee', fee)
  }

  const tx = db.transaction(() => {
    if (sets.length > 0) {
      vals.push(id)
      db.prepare(`UPDATE shop_account SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }
    if (patch.auto_tag_ids !== undefined) {
      const unique = [...new Set(patch.auto_tag_ids)]
      db.prepare('DELETE FROM shop_account_tag WHERE shop_account_id = ?').run(id)
      const ins = db.prepare('INSERT INTO shop_account_tag (shop_account_id, tag_id) VALUES (?, ?)')
      for (const tagId of unique) ins.run(id, tagId)
    }
  })
  tx()
}

/** 仕入で使われていたら消させない（無効化を促す）。無ければ物理削除 */
export function deleteShopAccount(id: string): void {
  const used = db.prepare('SELECT COUNT(*) AS c FROM purchase WHERE shop_account_id = ?')
    .get(id) as { c: number }
  if (used.c > 0) {
    throw new Error('この仕入先は仕入で使われています。無効にしてください')
  }
  // 実行記録は残す（FK が張ってあるので先に外す）
  db.prepare('UPDATE collector_run SET shop_account_id = NULL WHERE shop_account_id = ?').run(id)
  db.prepare('DELETE FROM shop_account WHERE id = ?').run(id)
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

/** collector_run に shop_account_name を付けて返す共通SELECT。listRuns / finishRun / getDashboard で使う */
const RUN_SELECT = `
  SELECT r.*, sa.name AS shop_account_name
  FROM collector_run r
  LEFT JOIN shop_account sa ON sa.id = r.shop_account_id
`

function selectRun(id: string): CollectorRun {
  return db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as CollectorRun
}

export function startRun(source: CollectorSource, shopAccountId: string | null = null): string {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO collector_run (id, started_at, source, shop_account_id) VALUES (?, ?, ?, ?)',
  ).run(id, new Date().toISOString(), source, shopAccountId)
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
  return selectRun(id)
}

export function listRuns(limit = 20): CollectorRun[] {
  return db.prepare(
    `${RUN_SELECT} ORDER BY r.started_at DESC LIMIT ?`,
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

/**
 * 渡した mercari_item_id のうち、まだサムネイルを保存していない（thumb_file が NULL）
 * 既存の販売を返す。実DBに元からあった販売（新規取り込みではない）にも、今回の一覧に
 * 出ている間にサムネイルを追いつかせるために使う（collector.ts の saveNewThumbs）。
 */
export function salesWithoutThumb(
  mercariItemIds: string[],
): Array<{ id: string; mercariItemId: string }> {
  if (mercariItemIds.length === 0) return []
  const ph = mercariItemIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, mercari_item_id AS mercariItemId FROM sale
      WHERE mercari_item_id IN (${ph}) AND thumb_file IS NULL`,
  ).all(...mercariItemIds) as Array<{ id: string; mercariItemId: string }>
  return rows
}

/** 既存の import_key を返す（仕入の注文履歴の差分取得用） */
export function existingImportKeys(keys: string[]): Set<string> {
  if (keys.length === 0) return new Set()
  const ph = keys.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT import_key FROM purchase WHERE import_key IN (${ph})`,
  ).all(...keys) as Array<{ import_key: string }>
  return new Set(rows.map(r => r.import_key))
}

export function insertCollected(
  rows: Array<{
    mercariItemId: string
    title: string
    price: number
    soldAt: string
    description?: string
    /** 販売手数料の実額。undefined/null なら従来どおり料率で計算 */
    fee?: number | null
    /**
     * 送料の実額。undefined/null なら未確定のまま。0 はメルカリ便を使っていない
     * （着払い・自己手配など）可能性が高く、実額として shipping_fee=0・shipping_source='actual'
     * は記録するが is_shipping_confirmed は立てない（送料未入力として要対応に出す）
     */
    shippingFee?: number | null
    /** 他費用。列は増やさない。raw に残すだけ */
    otherCost?: number | null
    /**
     * メルカリの取引の進み具合。取引中タブから来た行は waiting_payment 等、
     * 販売履歴（売却済み）から来た行は 'completed'。undefined/null なら未取得のまま
     */
    status?: SaleStatus | null
  }>,
): Array<{ id: string; mercariItemId: string }> {
  const rateBp = setting('fee_rate_bp', 1000)
  // 空なら「型番が抜けるか」で転売/私物を判定。空でなければキーワード（どれか1つでも部分一致・大小無視）で判定
  // （キーワードが設定されていれば collector 側で不一致は取り込まれないので、ここに来るのは一致したものだけ）
  const keywords = parseKeywords(settingStr('mercari_keyword', ''))

  const ins = db.prepare(
    `INSERT INTO sale
       (id, mercari_item_id, title, sold_at, price, kind,
        fee_rate_bp, fee, source, raw, is_shipping_confirmed, model_codes,
        shipping_fee, shipping_source, status, shipped_at, delivered_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'collector', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const inserted: Array<{ id: string; mercariItemId: string }> = []
  const tx = db.transaction(() => {
    for (const r of rows) {
      const text = r.title + (r.description ? ' ' + r.description : '')
      const codes = extractCodes(text)
      const kind: SaleKind = keywords.length > 0
        ? (matchesAnyKeyword(text, keywords) ? 'resale' : 'personal')
        : (codes.length > 0 ? 'resale' : 'personal')

      const hasFee = typeof r.fee === 'number'
      const fee = hasFee ? (r.fee as number) : calcFee(r.price, rateBp)

      // shippingFee は実額として記録するが、0 はメルカリ便を使っていない可能性が高いので
      // 確定扱いにしない（送料未入力として要対応に出す）。undefined/null は従来どおり未確定
      const hasShippingFee = typeof r.shippingFee === 'number'
      const shippingFee = hasShippingFee ? (r.shippingFee as number) : 0
      const shippingSource = hasShippingFee ? 'actual' : null
      const confirmed = hasShippingFee && shippingFee > 0 ? 1 : 0

      const status = r.status ?? null
      const statusDates = initialSaleStatusDates(status, r.soldAt)

      const id = randomUUID()
      ins.run(
        id, r.mercariItemId, r.title, r.soldAt, r.price, kind,
        rateBp, fee, JSON.stringify(r), confirmed, JSON.stringify(codes),
        shippingFee, shippingSource, status,
        statusDates.shipped_at, statusDates.delivered_at, statusDates.completed_at,
      )
      inserted.push({ id, mercariItemId: r.mercariItemId })

      // 出品への引き当てがあれば、そのままそれを引き継ぐ（人の決定が最優先）。
      // 無ければ今までどおり型番の完全一致でFIFO自動確定する
      if (takeOverListing(id, r.mercariItemId)) {
        // 人が出品に在庫を引き当てていた＝転売の意思。キーワード不一致・型番なしの
        // タイトルでも kind は 'resale' にする（Codexレビュー指摘）
        if (kind !== 'resale') {
          db.prepare(`UPDATE sale SET kind = 'resale' WHERE id = ?`).run(id)
        }
      } else {
        autoLinkSale(id)
      }
    }
  })
  tx()

  return inserted
}

/**
 * サムネイルのファイル名を保存する（collector が、新規に取り込んだ販売について
 * 画像取得に成功したときだけ呼ぶ）。生成後の landed_cost と違い、サムネイルは
 * 後から書き込んでも過去の利益には影響しないので updated_at は触らない
 * （appendModelCodes の「人が手で触ったか」判定を壊さないため）。
 */
export function setSaleThumb(saleId: string, file: string): void {
  db.prepare('UPDATE sale SET thumb_file = ? WHERE id = ?').run(file, saleId)
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
      CASE sp.source WHEN 'collector' THEN '自動取得' ELSE '手入力' END AS 取得元,
      sp.price           AS 販売価格,
      sp.fee             AS 販売手数料,
      sp.shipping_fee    AS 送料,
      sp.shipping_source AS 送料区分,
      sp.packaging_cost  AS 梱包材,
      sp.cost            AS 原価,
      sp.gross_profit    AS 粗利,
      sp.item_count      AS 紐付け点数,
      sp.model_codes     AS 型番,
      (SELECT GROUP_CONCAT(t.name, '|')
         FROM sale_tag st JOIN tag t ON t.id = st.tag_id
        WHERE st.sale_id = sp.id)  AS タグ,
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
  const items = db.prepare(`
    SELECT iv.*
    FROM inventory_view iv
    JOIN sale_line sl ON sl.inventory_item_id = iv.id
    WHERE sl.sale_id = ?
    ORDER BY iv.name
  `).all(saleId) as InventoryRow[]
  return attachInventoryTags(items)
}

// ============================================================
// データのリセット（テスト運用開始のやり直し用）
//
// 仕入・販売・在庫・収集履歴・期間費用を全部消す。
// setting（手数料率などの設定）・shop_account・shipping_method は
// マスタなので残す。外部キーの順に DELETE する
// ============================================================

export function resetData(): void {
  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM sale_tag;
      DELETE FROM inventory_tag;
      DELETE FROM purchase_tag;
      DELETE FROM listing_line;
      DELETE FROM listing;
      DELETE FROM sale_line;
      DELETE FROM sale;
      DELETE FROM inventory_item;
      DELETE FROM purchase_line;
      DELETE FROM purchase;
      DELETE FROM collector_run;
      DELETE FROM expense;
      DELETE FROM month_book;
    `)
  })
  tx()
  db.pragma('wal_checkpoint(TRUNCATE)')
}
