// ============================================================
// メインプロセスとレンダラーの契約
//
// このファイルは両方から参照される。ここにない情報を
// レンダラー側で勝手に算出しないこと（計算はメイン側に寄せる）
// ============================================================

export type SaleKind = 'resale' | 'personal'
/** split = ばらして売るために分割した親。子が在庫として残る */
export type InventoryStatus = 'in_stock' | 'sold' | 'disposed' | 'personal_use' | 'split'
export type AllocMethod = 'by_amount' | 'by_quantity'
export type RunStatus = 'ok' | 'auth_required' | 'failed' | 'empty'
/** draft = mellojoy-watch から積んだ下書き。価格未入力。在庫は confirmed で生成 */
export type PurchaseStatus = 'draft' | 'confirmed'
export type ShopAccountKind = 'mellojoy' | 'tiktok' | 'other'
/** actual = メルカリの取引詳細から取った実額 / master = 発送方法マスタ / manual = 手入力 */
export type ShippingSource = 'actual' | 'master' | 'manual'
/** auto = 型番の完全一致で自動確定 / manual = 人が確定 */
export type LinkSource = 'auto' | 'manual'

// ------------------------------------------------------------
// 型番（メロジョイの商品コード）
//   【Z078-2】= model_code 'Z078-2', series_code 'Z078'
//   【A035】  = model_code 'A035',   series_code 'A035'
// ------------------------------------------------------------

export interface ProductCode {
  /** 最小単位。在庫・紐付けのキー */
  model_code: string
  /** ハイフンの前。集計用。枝番なしなら model_code と同じ */
  series_code: string
}

/** 素材。名前から抜く。分類軸であって型番とは独立 */
export type Material = 'ムースクリーム' | 'ねっとりヨーグルト' | 'もちもちもち' | 'クリーミークリーム'

// ------------------------------------------------------------
// マスタ
// ------------------------------------------------------------

export interface ShopAccount {
  id: string
  name: string
  kind: ShopAccountKind
  note: string | null
  is_active: number
}

export interface ShippingMethod {
  id: string
  name: string
  carrier: string | null
  fee: number
  sort_order: number
  is_active: number
}

// ------------------------------------------------------------
// 販売
// ------------------------------------------------------------

/** sale_profit ビューの1行 */
export interface SaleProfit {
  id: string
  mercari_item_id: string | null
  sold_at: string
  title: string
  kind: SaleKind
  price: number
  fee: number
  shipping_fee: number
  packaging_cost: number
  is_shipping_confirmed: number
  shipping_method_id: string | null
  shipping_source: ShippingSource | null
  note: string | null
  /** タイトル・説明から抜いた型番（複数可）。ビューでは JSON 文字列、API では配列に直して返す */
  model_codes: string[]
  /** 紐付けた在庫の按分後原価の合計 */
  cost: number
  gross_profit: number
  item_count: number
  /** 1 なら在庫が未紐付け */
  unmatched: number
  /** 1 なら紐付けのどれかが型番の自動確定 */
  auto_linked: number
}

export interface SaleInput {
  title: string
  sold_at: string
  price: number
  kind?: SaleKind
  mercari_item_id?: string | null
  note?: string | null
}

export interface SalePatch {
  kind?: SaleKind
  shipping_method_id?: string | null
  /** 手入力の送料。shipping_source は 'manual' になる */
  shipping_fee?: number
  packaging_cost?: number
  price?: number
  sold_at?: string
  title?: string
  note?: string | null
}

// ------------------------------------------------------------
// 仕入
// ------------------------------------------------------------

export interface PurchaseLineInput {
  name: string
  unit_price: number
  quantity: number
  /** 省略時は name から自動抽出。手で直した値を渡してよい */
  model_code?: string | null
  series_code?: string | null
  material?: Material | null
}

export interface PurchaseInput {
  shop_account_id: string
  ordered_at: string
  order_no?: string | null
  shipping_fee?: number
  discount?: number
  other_cost?: number
  alloc_method?: AllocMethod
  note?: string | null
  lines: PurchaseLineInput[]
}

export interface PurchaseSummary {
  id: string
  status: PurchaseStatus
  ordered_at: string
  order_no: string | null
  shop_account_id: string
  shop_account_name: string
  shipping_fee: number
  discount: number
  note: string | null
  line_count: number
  /** 明細合計（単価×数量の総和） */
  subtotal: number
  /** 按分後の総原価 */
  total_cost: number
}

export interface PurchaseLine {
  id: string
  name: string
  unit_price: number
  quantity: number
  model_code: string | null
  series_code: string | null
  material: Material | null
  allocated_cost: number
  landed_unit_cost: number
}

/** 1注文の全部（下書きの確定フォーム用） */
export interface PurchaseDetail extends PurchaseSummary {
  other_cost: number
  alloc_method: AllocMethod
  lines: PurchaseLine[]
}

/** mellojoy-watch の購入記録1件から積む下書き。価格はまだ無い */
export interface PurchaseDraftInput {
  /** 記録フォルダ名など。同じものを二度積まないためのキー（UNIQUE） */
  import_key: string
  shop_account_id: string
  ordered_at: string
  lines: Array<{
    name: string
    quantity: number
    model_code?: string | null
    series_code?: string | null
    material?: Material | null
  }>
  note?: string | null
}

export interface ImportResult {
  scanned: number
  created: number
  skipped: number
  errors: string[]
}

// ------------------------------------------------------------
// 在庫
// ------------------------------------------------------------

export interface InventoryItem {
  id: string
  name: string
  landed_cost: number
  acquired_at: string
  status: InventoryStatus
  aging_days: number
  order_no: string | null
  shop_account_name: string | null
  model_code: string | null
  series_code: string | null
  material: Material | null
  /** 分割で生まれた子なら親の id */
  parent_id: string | null
  note: string | null
}

export interface InventoryPatch {
  name?: string
  model_code?: string | null
  series_code?: string | null
  material?: Material | null
  note?: string | null
}

/** 型番ごとの実績（variant_summary ビュー） */
export interface VariantSummary {
  model_code: string
  series_code: string | null
  material: Material | null
  /** 最新の在庫名 */
  name: string
  purchased: number
  sold: number
  in_stock: number
  /** 未販売在庫の原価合計 */
  stock_value: number
  avg_price: number | null
  avg_profit: number | null
  total_profit: number
}

// ------------------------------------------------------------
// 集計
// ------------------------------------------------------------

export interface MonthlySummary {
  month: string
  kind: SaleKind
  sales_count: number
  revenue: number
  total_fee: number
  total_shipping: number
  total_packaging: number
  total_cost: number
  gross_profit: number
}

export interface DashboardStats {
  /** 送料が未入力の販売件数 */
  needsShipping: number
  /** 在庫が未紐付けの販売件数（転売のみ） */
  needsMatch: number
  /** 価格未入力の仕入（下書き）件数 */
  needsPurchaseConfirm: number
  /** 未販売在庫の点数 */
  stockCount: number
  /** 未販売在庫の原価合計（寝ている資金） */
  stockValue: number
  /** 滞留warn日数を超えた在庫の点数 */
  agingCount: number
  /** 今月の集計（転売分） */
  thisMonth: MonthlySummary | null
  lastRun: CollectorRun | null
}

// ------------------------------------------------------------
// 収集
// ------------------------------------------------------------

export interface CollectorRun {
  id: string
  started_at: string
  finished_at: string | null
  status: RunStatus
  fetched: number
  inserted: number
  message: string | null
}

// ------------------------------------------------------------
// IPC
// ------------------------------------------------------------

export interface SorobanApi {
  // ダッシュボード
  getDashboard(): Promise<DashboardStats>

  // 販売
  listSales(filter?: {
    month?: string
    kind?: SaleKind
    onlyPending?: boolean
  }): Promise<SaleProfit[]>
  createSale(input: SaleInput): Promise<string>
  updateSale(id: string, patch: SalePatch): Promise<void>
  deleteSale(id: string): Promise<void>

  // 紐付け
  linkInventory(saleId: string, inventoryItemIds: string[]): Promise<void>
  /** 未紐付けの転売のうち型番が完全一致するものを先入先出で自動確定する。戻り値は確定した販売数 */
  autoLinkPending(): Promise<number>
  unlinkInventory(saleId: string, inventoryItemId: string): Promise<void>
  /** 商品名の類似度で在庫の候補を返す（確定はしない） */
  suggestInventory(saleId: string, limit?: number): Promise<InventoryItem[]>
  /** その販売に紐付いている在庫（解除・付け替え用） */
  listSaleLines(saleId: string): Promise<InventoryItem[]>

  // 仕入
  listPurchases(): Promise<PurchaseSummary[]>
  getPurchase(id: string): Promise<PurchaseDetail>
  createPurchase(input: PurchaseInput): Promise<string>
  /** 下書きを確定する：内容を input で置き換え、在庫を生成する */
  confirmPurchase(id: string, input: PurchaseInput): Promise<void>
  updatePurchaseNote(id: string, note: string | null): Promise<void>
  deletePurchase(id: string): Promise<void>
  /** mellojoy-watch の購入記録を読んで下書きを積む（既知のものは飛ばす） */
  importPurchaseDrafts(): Promise<ImportResult>

  // 在庫
  listInventory(status?: InventoryStatus): Promise<InventoryItem[]>
  updateInventory(id: string, patch: InventoryPatch): Promise<void>
  /** ばらして売る：1点を count 点に分割。原価は等分し端数は最後の子へ。親は 'split' になる。戻り値は子の id */
  splitInventory(id: string, count: number): Promise<string[]>
  /** 在庫から外す。廃棄（disposed）か自家消費（personal_use）。既定は disposed */
  disposeInventory(id: string, note: string, status?: 'disposed' | 'personal_use'): Promise<void>

  // 集計
  listMonthly(): Promise<MonthlySummary[]>
  listVariantSummary(sort?: 'total_profit' | 'avg_profit' | 'sold'): Promise<VariantSummary[]>

  // マスタ
  listShopAccounts(): Promise<ShopAccount[]>
  createShopAccount(name: string, kind?: ShopAccountKind): Promise<string>
  listShippingMethods(): Promise<ShippingMethod[]>
  saveShippingMethod(m: Partial<ShippingMethod> & { name: string; fee: number }): Promise<void>
  deleteShippingMethod(id: string): Promise<void>
  getSettings(): Promise<Record<string, string>>
  setSetting(key: string, value: string): Promise<void>

  // 収集
  collect(): Promise<CollectorRun>
  openLogin(): Promise<void>
  listRuns(limit?: number): Promise<CollectorRun[]>

  // バックアップ
  exportCsv(): Promise<string | null>
  backupDb(): Promise<string | null>
  revealDbFolder(): Promise<void>
}

declare global {
  interface Window {
    soroban: SorobanApi
  }
}
