// ============================================================
// メインプロセスとレンダラーの契約
//
// このファイルは両方から参照される。ここにない情報を
// レンダラー側で勝手に算出しないこと（計算はメイン側に寄せる）
// ============================================================

export type SaleKind = 'resale' | 'personal'
export type InventoryStatus = 'in_stock' | 'sold' | 'disposed' | 'personal_use'
export type AllocMethod = 'by_amount' | 'by_quantity'
export type RunStatus = 'ok' | 'auth_required' | 'failed' | 'empty'

// ------------------------------------------------------------
// マスタ
// ------------------------------------------------------------

export interface ShopAccount {
  id: string
  name: string
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
  /** 紐付けた在庫の按分後原価の合計 */
  cost: number
  gross_profit: number
  item_count: number
  /** 1 なら在庫が未紐付け */
  unmatched: number
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
  ordered_at: string
  order_no: string | null
  shop_account_name: string
  shipping_fee: number
  discount: number
  line_count: number
  /** 明細合計（単価×数量の総和） */
  subtotal: number
  /** 按分後の総原価 */
  total_cost: number
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
  unlinkInventory(saleId: string, inventoryItemId: string): Promise<void>
  /** 商品名の類似度で在庫の候補を返す（確定はしない） */
  suggestInventory(saleId: string, limit?: number): Promise<InventoryItem[]>
  /** その販売に紐付いている在庫（解除・付け替え用） */
  listSaleLines(saleId: string): Promise<InventoryItem[]>

  // 仕入
  listPurchases(): Promise<PurchaseSummary[]>
  createPurchase(input: PurchaseInput): Promise<string>
  deletePurchase(id: string): Promise<void>

  // 在庫
  listInventory(status?: InventoryStatus): Promise<InventoryItem[]>
  /** 在庫から外す。廃棄（disposed）か自家消費（personal_use）。既定は disposed */
  disposeInventory(id: string, note: string, status?: 'disposed' | 'personal_use'): Promise<void>

  // 集計
  listMonthly(): Promise<MonthlySummary[]>

  // マスタ
  listShopAccounts(): Promise<ShopAccount[]>
  createShopAccount(name: string): Promise<string>
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
