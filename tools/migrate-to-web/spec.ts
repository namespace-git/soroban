// 何を、どの順で、どう移すか。SQLite の表 → Postgres（app スキーマ）の同じ名前の表。
// 順番は外部キーの順（親が先）。列の型は Postgres のスキーマ（information_schema）から読むので、ここには書かない

export interface TableSpec {
  /** SQLite の表名。Postgres も同じ名前 */
  name: string
  /**
   * 行を指す列（Postgres 側の列名）。読み戻した行との突き合わせと、エラー表示（行の名前）に使う。
   * 商品名などの中身は出さない（id・型番・商品 ID・月・キーだけ）
   */
  key: string[]
  /** 列の名前が変わるもの（SQLite → Postgres）。docs/web/02-porting-guide.md の 3 節 */
  renames?: Record<string, string>
  /**
   * 挿入のたびに増える番号（identity）で並びを持つ表の、その列。SQLite の rowid（挿入順）の置き換えで、
   * 行を SQLite の rowid 順に 1 行ずつ入れて、番号をその順に振らせる（並びが変わると、まとめ売りの端数の行などが変わる）
   */
  orderColumn?: string
  /**
   * 画像が見つからなかったとき、参照を null にできない表（not null）は、その行を移さない。
   * 画像のファイル名の列は images.ts の IMAGE_COLUMNS。Storage のパスの列は renames の行き先
   */
  dropRowWhenImageMissing?: boolean
}

export const TABLE_SPECS: TableSpec[] = [
  { name: 'shop_account', key: ['id'] },
  { name: 'shipping_method', key: ['id'] },
  { name: 'tag', key: ['id'] },
  { name: 'setting', key: ['key'] },
  { name: 'shop_alias', key: ['key'] },
  { name: 'product_name', key: ['model_code'] },
  { name: 'product_image', key: ['model_code'], renames: { file: 'path' }, dropRowWhenImageMissing: true },
  { name: 'mellojoy_excluded_order', key: ['shop_account_id', 'order_key'] },
  { name: 'purchase', key: ['id'] },
  { name: 'purchase_line', key: ['id'], renames: { image_file: 'image_path' } },
  { name: 'inventory_item', key: ['id'] },
  { name: 'sale', key: ['id'], renames: { mercari_item_id: 'channel_item_id', thumb_file: 'thumb_path' } },
  // 紐付けた順（SQLite の rowid 順）に 1 行ずつ入れる。allocation_order（identity）がこの順で振られる
  { name: 'sale_line', key: ['id'], orderColumn: 'allocation_order' },
  { name: 'sale_exclusion', key: ['channel_item_id'], renames: { mercari_item_id: 'channel_item_id' } },
  {
    name: 'listing', key: ['channel', 'channel_item_id'],
    renames: { mercari_item_id: 'channel_item_id', thumb_file: 'thumb_path' },
  },
  { name: 'listing_line', key: ['id'] },
  { name: 'expense', key: ['id'], renames: { receipt_file: 'receipt_path' } },
  { name: 'expense_line', key: ['id'] },
  { name: 'month_book', key: ['month'] },
  { name: 'collector_run', key: ['id'] },
  { name: 'sale_tag', key: ['sale_id', 'tag_id'] },
  { name: 'inventory_tag', key: ['inventory_item_id', 'tag_id'] },
  { name: 'purchase_tag', key: ['purchase_id', 'tag_id'] },
  { name: 'product_tag', key: ['model_code', 'tag_id'] },
  { name: 'shop_account_tag', key: ['shop_account_id', 'tag_id'] },
  { name: 'cash_account', key: ['id'] },
  { name: 'liability', key: ['id'] },
  { name: 'cash_entry', key: ['id'] },
  // 消込の順（1 回の入出金で複数の債務を消した、入力した順）。settle_order（identity）
  { name: 'liability_settlement', key: ['id'], orderColumn: 'settle_order' },
]

export const MIGRATED_TABLE_NAMES = new Set(TABLE_SPECS.map((t) => t.name))

/**
 * この道具が確かめた SQLite の schema_version（src/main/db.ts の migrate()）。
 * これより古い DB は列が足りないので、デスクトップ版で一度開いて最新にしてから使う。
 * 新しい DB は、列が増えていれば書き込みの前に「Postgres にその列が無い」と止まる
 */
export const MIN_SCHEMA_VERSION = 34

/** 移さない表と、その理由（件数を出力に出す） */
export const SKIPPED_TABLES: Record<string, string> = {
  app_log: '操作ログ。14 日で消える一時的なもの（Web 版は新しく溜まる）',
  expense_auto_month: '廃止した「振込手数料の自動計上」の記録（Postgres に表が無い）',
}

/** SQLite の setting のうち、移さないキーと理由 */
export function skippedSettingReason(key: string): string | null {
  if (key === 'schema_version') return 'デスクトップ版のマイグレーションの印'
  if (key.endsWith('_enc')) return 'API キー。端末の safeStorage で暗号化されていてサーバーでは読めない。Web 版で入れ直す'
  if (key.startsWith('auto_backup')) return 'デスクトップ版の自動バックアップの設定（Web 版は Supabase がバックアップする）'
  return null
}

/** 世帯を作ったとき（app.create_household）に入る発送方法。SQLite の行で置き換えてよいのは、これと同じ中身のときだけ */
export const INITIAL_SHIPPING_METHODS = [
  { name: 'ゆうパケットポストmini', carrier: 'ゆうゆうメルカリ便', fee: 180, sort_order: 1 },
  { name: 'ネコポス', carrier: 'らくらくメルカリ便', fee: 210, sort_order: 2 },
  { name: 'ゆうパケットポスト', carrier: 'ゆうゆうメルカリ便', fee: 215, sort_order: 3 },
  { name: 'ゆうパケット', carrier: 'ゆうゆうメルカリ便', fee: 230, sort_order: 4 },
  { name: '宅急便コンパクト', carrier: 'らくらくメルカリ便', fee: 520, sort_order: 5 },
  { name: 'ゆうパケットプラス', carrier: 'ゆうゆうメルカリ便', fee: 520, sort_order: 6 },
  { name: '宅急便 60サイズ', carrier: 'らくらくメルカリ便', fee: 750, sort_order: 7 },
  { name: '送料なし・着払い', carrier: null, fee: 0, sort_order: 99 },
] as const

/**
 * 世帯が「空」かを見る表。ここのどれかに 1 行でもあれば、移行を断る（二重に流す事故を防ぐ）。
 * shipping_method と setting は、世帯を作ったときの初期データがあるので別に扱う。
 * app_log・collect_job・push_subscription などは、Web 版が自分で積むもので、移行とぶつからない
 */
export const EMPTY_CHECK_TABLES = TABLE_SPECS
  .map((t) => t.name)
  .filter((n) => n !== 'shipping_method' && n !== 'setting')
