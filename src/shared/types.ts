// ============================================================
// メインプロセスとレンダラーの契約
//
// このファイルは両方から参照される。ここにない情報を
// レンダラー側で勝手に算出しないこと（計算はメイン側に寄せる）
// ============================================================

export type SaleKind = 'resale' | 'personal'
/** 販売の出どころ。collector = 自動取得、manual = 手入力 */
export type SaleSource = 'collector' | 'manual'
/** split = ばらして売るために分割した親。子が在庫として残る */
export type InventoryStatus = 'in_stock' | 'sold' | 'disposed' | 'personal_use' | 'split'
export type AllocMethod = 'by_amount' | 'by_quantity'
export type RunStatus = 'ok' | 'auth_required' | 'failed' | 'empty'
/** 収集の対象。mercari = 販売履歴 / mellojoy = 仕入先アカウントの注文履歴 */
export type CollectorSource = 'mercari' | 'mellojoy'
/** draft = 注文履歴から積んだ下書き（価格が確定できなかったもの）。在庫は confirmed で生成 */
export type PurchaseStatus = 'draft' | 'confirmed'
/**
 * 注文の到着状態（メロジョイの注文一覧から毎回更新）。
 * pending = 確認済み（未発送） / shipped = 配達中 / delivered = 配達済み。
 * null = 分からない（手入力の仕入など）。到着扱い。
 * 在庫は確定時に作り、delivered 以外は「未着」として見せる（紐付けは可）
 */
export type Fulfillment = 'pending' | 'shipped' | 'delivered'
/**
 * メルカリの取引状態。waiting_shipment = 発送待ち / shipped = 発送済み /
 * delivered = 受取済み（評価待ち） / completed = 取引完了（売上金が反映）。
 * null = まだ取れていない（取引中タブ・取引画面の DOM 確認後に collector が埋める）
 */
export type SaleStatus = 'waiting_shipment' | 'shipped' | 'delivered' | 'completed'
export type ShopAccountKind = 'mellojoy' | 'tiktok' | 'other'
/** actual = メルカリの取引詳細から取った実額 / master = 発送方法マスタ / manual = 手入力 */
export type ShippingSource = 'actual' | 'master' | 'manual'
/** auto = 型番の完全一致で自動確定 / manual = 人が確定 */
/** listing = 出品に人が引き当てた在庫を、売れたときにそのまま引き継いだ */
export type LinkSource = 'auto' | 'manual' | 'listing'
/**
 * メルカリの出品の状態。active = 出品中 / suspended = 公開停止中 /
 * sold = 売却済み一覧で同じ id を観測した / ended = 人が「取り下げた」と記録した。
 * 一覧から消えただけでは変えない（1 ページしか読まないため）
 */
export type ListingStatus = 'active' | 'suspended' | 'sold' | 'ended'

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

/**
 * タグ。仕入・在庫・販売に複数付けられる。名前は UNIQUE。
 *
 * 付いた場所から下流へ「派生」で見える（コピーしない）：
 *   仕入のタグ → その仕入から生まれた在庫すべて → その在庫が紐付いた販売
 *   在庫のタグ → その在庫が紐付いた販売
 * 上流で付け外しすれば下流にもそのまま効く。紐付けを解除すれば販売からは消える。
 * 各型の `tags` は自分に直接付いたもの、`inherited_tags` は上流から派生したもの（重複なし）。
 */
export interface Tag {
  id: string
  name: string
  sort_order: number
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
  /** 商品サムネイル。取り込み時に1度だけ保存したもの（`soroban-thumb://<file>`）。無ければ null */
  thumb_url: string | null
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
  /** collector = メルカリから自動取得 / manual = 手入力 */
  source: SaleSource
  /** 販売に直接付いたタグ。付け外しは setSaleTags */
  tags: Tag[]
  /** 紐付いた在庫とその仕入から派生したタグ（tags と重複しない）。販売側では外せない */
  inherited_tags: Tag[]
  /** 取引の進み具合と各日付（YYYY-MM-DD）。取れていなければ null */
  status: SaleStatus | null
  shipped_at: string | null
  delivered_at: string | null
  completed_at: string | null
  /** 買い手のニックネーム。取れていなければ null */
  buyer: string | null
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
  /** 注文履歴からの取り込みなら注文番号のキー。同じ注文を二度積まない（UNIQUE） */
  import_key?: string | null
  fulfillment?: Fulfillment | null
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
  /** null 以外なら注文履歴から自動取得したもの */
  import_key: string | null
  fulfillment: Fulfillment | null
  /** 到着状態が shipped / delivered になったのを最初に観測した日（YYYY-MM-DD）。それ以前は null */
  shipped_at: string | null
  delivered_at: string | null
  line_count: number
  /** 代表の明細（先頭）。一覧で「何を買った注文か」を見せるため。明細が無ければ null */
  first_line_name: string | null
  first_model_code: string | null
  /** 明細合計（単価×数量の総和） */
  subtotal: number
  /** 按分後の総原価 */
  total_cost: number
  /** 仕入に付いたタグ。付け外しは setPurchaseTags。この仕入の在庫・その販売に派生する */
  tags: Tag[]
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

/** 取り込みで積む仕入の下書き。価格はまだ無い */
export interface PurchaseDraftInput {
  /** 注文番号など。同じものを二度積まないためのキー（UNIQUE） */
  import_key: string
  shop_account_id: string
  ordered_at: string
  order_no?: string | null
  fulfillment?: Fulfillment | null
  /** 取れていれば入れる。確定画面に前もって埋まる */
  shipping_fee?: number
  discount?: number
  lines: Array<{
    name: string
    quantity: number
    /** 取れていれば単価。無ければ 0（価格未入力） */
    unit_price?: number
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
  /** 在庫に直接付いたタグ。付け外しは setInventoryTags */
  tags: Tag[]
  /** 仕入から派生したタグ（tags と重複しない）。在庫側では外せない */
  inherited_tags: Tag[]
  /** 仕入元の注文の到着状態。delivered / null 以外は「未着」 */
  fulfillment: Fulfillment | null
  /** 紐付いた販売のサムネイル（売れた在庫だけ）。無ければ null */
  thumb_url: string | null
  /** 出品に引き当て済みなら、その出品（派生。在庫の status は in_stock のまま） */
  listing: { mercari_item_id: string; price: number; status: ListingStatus } | null
}

// ------------------------------------------------------------
// 出品（メルカリの出品中タブから取り込む）
// ------------------------------------------------------------

export interface Listing {
  mercari_item_id: string
  title: string
  price: number
  status: ListingStatus
  /** 初めて一覧で見た日（＝出品日の近似）／最後に見た日時 */
  first_seen_at: string
  last_seen_at: string
  thumb_url: string | null
  /** タイトルから抜いた型番（枝番まで）。無ければ空 */
  model_codes: string[]
  /** 引き当てた在庫 */
  items: Array<{ id: string; name: string; model_code: string | null; landed_cost: number }>
  /** 引き当てた在庫の原価合計と、出品価格から見た見込み粗利（手数料は設定の率、送料は未定なので引かない） */
  reserved_cost: number
  expected_profit: number | null
}

export interface InventoryPatch {
  name?: string
  model_code?: string | null
  series_code?: string | null
  material?: Material | null
  note?: string | null
}

/** 型番ごとの実績（variant_summary ビュー） */
/** 在庫 1 点の履歴。仕入→到着→販売→発送→受取→取引完了 を時系列で */
export interface TimelineEvent {
  /** YYYY-MM-DD。日付が取れていない予定の段は null（UI は薄く出す） */
  date: string | null
  kind:
    | 'ordered' | 'purchase_shipped' | 'purchase_delivered' | 'listed'
    | 'sold' | 'sale_shipped' | 'sale_delivered' | 'sale_completed'
    | 'split' | 'disposed' | 'personal_use'
  /** 見出し。例「メロジョイで注文 #264129」 */
  title: string
  /** 補足。例「¥2,699 ＋送料按分 ¥499 → 原価 ¥3,198」 */
  detail: string | null
  /** 関係する金額（表示用。無ければ null） */
  amount: number | null
}

export interface ItemTimeline {
  item: InventoryItem
  events: TimelineEvent[]
  /** 販売済みなら販売の要約。未販売なら null */
  sale: SaleProfit | null
  /** 仕入の要約（注文番号・仕入先・注文日） */
  purchase: PurchaseSummary | null
}

/** 商品（型番）ページの一覧行。variant_summary に仕入額を足したもの */
export interface ProductSummary extends VariantSummary {
  /** 仕入合計（按分後原価の合計。廃棄・私物含む） */
  purchase_total: number
  /** 平均原価（按分後） */
  avg_cost: number | null
  /** 最新の仕入日・販売日 */
  last_purchased_at: string | null
  last_sold_at: string | null
  /** 代表サムネイル（紐付いた販売のもの。無ければ null） */
  thumb_url: string | null
}

/** 月ごとの在庫の増減 */
export interface ProductMonthPoint {
  /** YYYY-MM */
  month: string
  purchased: number
  sold: number
  /** 月末時点の在庫数（累積） */
  in_stock: number
  purchase_amount: number
  sales_amount: number
  profit: number
}

export interface ProductDetail extends ProductSummary {
  months: ProductMonthPoint[]
  /** この型番の在庫 1 点ずつ（新しい順） */
  items: InventoryItem[]
  /** この型番が紐付いた販売（新しい順） */
  sales: SaleProfit[]
}

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

/** 販売の絞り込み条件。listSales と saleTotals で共通 */
export interface SaleFilter {
  month?: string
  kind?: SaleKind
  onlyPending?: boolean
  /** このタグが付いた販売だけ */
  tagId?: string
}

/** 絞り込んだ販売の合計。DB 側で集計する（画面で足さない） */
export interface SaleTotals {
  count: number
  revenue: number
  total_fee: number
  total_shipping: number
  total_packaging: number
  total_cost: number
  gross_profit: number
}

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
  /** 出品中（active）で在庫が未引き当ての出品の数 */
  needsListingAllocation: number
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
  source: CollectorSource
  /** mellojoy のときだけ。どのアカウントの実行か */
  shop_account_id: string | null
  shop_account_name: string | null
}

// ------------------------------------------------------------
// IPC
// ------------------------------------------------------------

export interface SorobanApi {
  // ダッシュボード
  getDashboard(): Promise<DashboardStats>

  // 販売
  listSales(filter?: SaleFilter): Promise<SaleProfit[]>
  /** 絞り込んだ販売の合計（件数・売上・手数料・送料・原価・粗利） */
  saleTotals(filter?: SaleFilter): Promise<SaleTotals>
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

  // 在庫
  listInventory(status?: InventoryStatus): Promise<InventoryItem[]>
  updateInventory(id: string, patch: InventoryPatch): Promise<void>
  /** ばらして売る：1点を count 点に分割。原価は等分し端数は最後の子へ。親は 'split' になる。戻り値は子の id */
  splitInventory(id: string, count: number): Promise<string[]>
  /** 在庫から外す。廃棄（disposed）か自家消費（personal_use）。既定は disposed */
  disposeInventory(id: string, note: string, status?: 'disposed' | 'personal_use'): Promise<void>

  // 集計
  listMonthly(): Promise<MonthlySummary[]>

  // タグ
  listTags(): Promise<Tag[]>
  createTag(name: string): Promise<string>
  renameTag(id: string, name: string): Promise<void>
  /** タグを消すと、付いていた仕入・在庫・販売からも外れる */
  deleteTag(id: string): Promise<void>
  /** 直接付いたタグを丸ごと置き換える（空配列で全部外す）。派生分は対象外 */
  setSaleTags(saleId: string, tagIds: string[]): Promise<void>
  setInventoryTags(inventoryItemId: string, tagIds: string[]): Promise<void>
  setPurchaseTags(purchaseId: string, tagIds: string[]): Promise<void>
  listVariantSummary(sort?: 'total_profit' | 'avg_profit' | 'sold'): Promise<VariantSummary[]>

  // 商品（型番）ページ・在庫の履歴
  listProducts(sort?: 'total_profit' | 'avg_profit' | 'sold' | 'in_stock' | 'last_purchased_at'): Promise<ProductSummary[]>
  getProduct(modelCode: string): Promise<ProductDetail | null>
  getItemTimeline(inventoryItemId: string): Promise<ItemTimeline | null>

  // 出品（メルカリ）と在庫の引き当て
  /** status 未指定なら active + suspended。onlyUnallocated で未引き当てだけ */
  listListings(filter?: { status?: ListingStatus[]; onlyUnallocated?: boolean }): Promise<Listing[]>
  /** 出品に在庫を引き当てる（追加）。既に他の active な出品に引き当て済み・販売済みの在庫はエラー */
  reserveInventory(mercariItemId: string, inventoryItemIds: string[]): Promise<void>
  unreserveInventory(mercariItemId: string, inventoryItemId: string): Promise<void>
  /** 出品の引き当て候補。型番の完全一致 → シリーズ一致 → 名前の一致の順。引き当て済み・販売済みは除く */
  suggestForListing(mercariItemId: string, limit?: number): Promise<InventoryItem[]>
  /** 人が「取り下げた」と記録する。引き当ては外れ、在庫は未出品に戻る */
  endListing(mercariItemId: string): Promise<void>

  // マスタ
  listShopAccounts(): Promise<ShopAccount[]>
  createShopAccount(name: string, kind?: ShopAccountKind): Promise<string>
  updateShopAccount(id: string, patch: { name?: string; kind?: ShopAccountKind; is_active?: number }): Promise<void>
  /** 仕入で使われていれば例外（消せない）。使われていなければ削除。ログイン用プロファイルも消す */
  deleteShopAccount(id: string): Promise<void>
  listShippingMethods(): Promise<ShippingMethod[]>
  saveShippingMethod(m: Partial<ShippingMethod> & { name: string; fee: number }): Promise<void>
  deleteShippingMethod(id: string): Promise<void>
  getSettings(): Promise<Record<string, string>>
  setSetting(key: string, value: string): Promise<void>

  // 収集
  /** メルカリ→有効な仕入先アカウントの順に直列で走る。1回分がまとめて返る（先頭がメルカリ） */
  collect(): Promise<CollectorRun[]>
  openLogin(): Promise<void>
  /** 仕入先アカウント（メロジョイ）のログイン画面を開く。アカウントごとに別プロファイル */
  openShopLogin(shopAccountId: string): Promise<void>
  listRuns(limit?: number): Promise<CollectorRun[]>

  // バックアップ
  exportCsv(): Promise<string | null>
  backupDb(): Promise<string | null>
  revealDbFolder(): Promise<void>
  /** 取引データ（販売・仕入・在庫・紐付け・取り込み履歴・期間費用）を全部消す。設定・仕入先・発送方法は残す */
  resetData(): Promise<void>
}

declare global {
  interface Window {
    soroban: SorobanApi
  }
}
