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
/**
 * メルカリの取引の進み具合。取引中タブ（/mypage/listings/in_progress）の文言から：
 *   waiting_payment  = 「支払いをしてください」「支払い待ち」（購入されたが未入金）
 *   waiting_shipment = 「発送してください」「発送待ち」（入金済み。こちらが発送する）
 *   shipped          = 「受取評価待ち」（発送済み。買い手の受取待ち）
 *   delivered        = 「評価をしてください」（買い手が受取評価済み。こちらの評価待ち）
 *   completed        = 売却済みタブ（販売履歴）に出た（取引完了・入金）
 */
export type SaleStatus = 'waiting_payment' | 'waiting_shipment' | 'shipped' | 'delivered' | 'completed'
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

export interface ShopAccountStats {
  shop_account_id: string
  orders: number
  items: number
  /** 商品計＋送料＋その他−割引 の合計 */
  total_cost: number
  last_ordered_at: string | null
}

export interface ShopAccount {
  id: string
  name: string
  kind: ShopAccountKind
  note: string | null
  is_active: number
  /**
   * 取り込みキーワード（改行・カンマ区切り。メルカリの設定 keywords と同じ書式）。
   * 注文履歴の取り込みで、**商品名がどれかに一致する明細だけ**を取り込む。空なら全部。
   * 一致する明細が 1 つも無い注文は取り込まない。一部だけ一致する注文は、一致した明細だけを
   * 仕入にし、送料・割引は注文全体の金額比で「取り込む明細の分だけ」按分する（私物の分の送料を
   * 転売の原価に混ぜない）。除外した明細数はメモに残す
   */
  import_keywords: string | null
  /**
   * 自動タグ。この仕入先の仕入（取り込み・手入力とも）に作成時に自動で付く（purchase_tag として。
   * 後から外せる）。例：マージン対象の口座に「マージン」を付けておくと、その在庫・販売まで派生して見える
   */
  auto_tags: Tag[]
  /** 手入力の仕入フォームで、この仕入先を選んだときに入る送料の既定値（円、税込）。null なら 0 */
  default_shipping_fee: number | null
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
  /**
   * 派生タグ（`inherited_tags`）にだけ入る：どこに付いたタグか。
   * purchase = 仕入（取引）／product = 商品（型番）／inventory = 在庫 1 点。
   * 直接付いたタグ（`tags`）では undefined
   */
  from?: 'purchase' | 'product' | 'inventory'
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
  /** 商品サムネイル（`soroban-thumb://<file>`）。取り込みで保存し、メルカリ側の画像が変わっていれば差し替える。無ければ null */
  thumb_url: string | null
  /**
   * 計上日（YYYY-MM-DD）。月次・月フィルタはこれで切る。
   * 取り込みの販売は「取引完了（購入完了日）」。未完了のうちは購入日時（無ければ初めて見た日）の仮置きで、
   * 完了を観測した時点で完了日に動く。手入力の販売は入力した日付のまま
   */
  sold_at: string
  /** 購入日時（取引画面の「購入日時」。ISO 分精度 `YYYY-MM-DDTHH:mm` か日付だけ）。まだ取れていなければ null */
  purchased_at: string | null
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
  /** 仕入先の商品画像の URL（メロジョイの注文詳細から）。取り込み後に main が保存して image_file にする */
  image_url?: string | null
}

export interface PurchaseImportResult {
  created: number
  skipped: Array<{ index: number; reason: string }>
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
  /** この明細から生まれた在庫 1 点ずつのいまの状態（下書きは空） */
  items: PurchaseLineItem[]
}

export interface PurchaseLineItem {
  id: string
  item_code: string
  status: InventoryStatus
  landed_cost: number
  /** 出品に引き当て済みなら出品価格 */
  listing_price: number | null
  /** 売れていれば販売の id・価格・販売日 */
  sale_id: string | null
  sale_price: number | null
  sold_at: string | null
  /** 仕入先の商品画像（soroban-thumb://）。無ければ null */
  image_url: string | null
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
  /**
   * 在庫コード（例 `S-0012`）。在庫 1 点ずつにそろばんが振る、絶対に重複しない番号。
   * 型番（商品の種類）とは別。メルカリのタイトルに `【S-0012】` と入れると、その 1 点だけが
   * 自動で引き当て・紐付けされる。複数（`【S-0012】【S-0013】`）なら全部。分割した子も新しいコードを持つ
   */
  item_code: string
  name: string
  landed_cost: number
  acquired_at: string
  status: InventoryStatus
  aging_days: number
  order_no: string | null
  shop_account_name: string | null
  model_code: string | null
  /** 型番に人が付けた表示名（setProductName）。無ければ null。名前の見出しに使い、name（明細名）は添え書きにする */
  product_name: string | null
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
  /** 販売済み（sale_line あり）なら、その販売。付け替え（takeFromSale）の警告に使う */
  sold_to: { sale_id: string; title: string; price: number; sold_at: string } | null
}

// ------------------------------------------------------------
// 出品（メルカリの出品中タブから取り込む）
// ------------------------------------------------------------

export interface Listing {
  mercari_item_id: string
  title: string
  price: number
  status: ListingStatus
  /** 初めて一覧で見た日／最後に見た日時（ISO） */
  first_seen_at: string
  last_seen_at: string
  /**
   * 出品日（YYYY-MM-DD）。出品中タブの「n日前に更新」から推定（初回取り込み時の日付 − n 日）。
   * 更新で巻き戻るので、以後の取り込みでは**より古い日付にだけ**更新する。取れなければ first_seen_at
   */
  listed_at: string
  /** いいね数。取れなければ null */
  likes: number | null
  /**
   * 出品時に決めた発送方法（設定の発送方法）。売れたとき販売に引き継ぐ
   * （shipping_method_id・送料・is_shipping_confirmed=1・shipping_source='manual'）。
   * 取引画面から実額が取れたらそちらが優先（actual）
   */
  shipping_method_id: string | null
  shipping_method_name: string | null
  thumb_url: string | null
  /** タイトルから抜いた型番（枝番まで）。無ければ空 */
  model_codes: string[]
  /** 引き当てた在庫 */
  items: Array<{ id: string; item_code: string; name: string; model_code: string | null; product_name: string | null; landed_cost: number }>
  /**
   * 引き当てた在庫の原価合計と、出品価格から見た見込み粗利
   * （手数料は設定の率。発送方法が決まっていればその送料も引く。梱包は引かない）
   */
  reserved_cost: number
  expected_profit: number | null
}

/** 横断検索の 1 件。クリックでその種類のタブへ飛び、検索語を引き継ぐ */
export interface SearchHit {
  kind: 'inventory' | 'listing' | 'sale' | 'purchase'
  /** inventory: inventory_item.id / listing: mercari_item_id / sale: sale.id / purchase: purchase.id */
  id: string
  title: string
  /** 型番（あれば） */
  model_code: string | null
  /** 状態の表示語（未出品／出品中／販売済／廃棄／出品中／公開停止中／売れた／取り下げ／送料未入力／未紐付け／下書き／確定 など） */
  status_label: string
  /** 表示用の金額（在庫は原価、出品は出品価格、販売は販売価格、仕入は総原価） */
  amount: number
  /** 並び替え用の日付 YYYY-MM-DD（仕入日／初めて見た日／販売日／注文日） */
  date: string
  thumb_url: string | null
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
  /** 商品画像。①人がセット（setProductImage）＞②仕入先（メロジョイ）の商品画像＞③最新の出品＞④最新の販売。無ければ null */
  thumb_url: string | null
  /** 1 なら人がセットした画像（取り込みで上書きしない）。setProductImageAuto(code, true) で自動に戻す */
  image_manual: boolean
  /** 商品（型番）に付いたタグ。付け外しは setProductTags。その型番の在庫・販売に派生する */
  tags: Tag[]
}

/** 月ごとの在庫の増減 */
export interface ProductMonthPoint {
  forecast_sales_amount?: number
  forecast_profit?: number
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
  forecast_profit?: number
  model_code: string
  series_code: string | null
  material: Material | null
  /** 表示名。custom_name があればそれ、無ければ最新の在庫名 */
  name: string
  /** 人が付けた表示名（setProductName）。無ければ null */
  custom_name: string | null
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
  forecast?: { count: number; revenue: number; gross_profit: number }
  count: number
  revenue: number
  total_fee: number
  total_shipping: number
  total_packaging: number
  total_cost: number
  gross_profit: number
}

export interface MonthlySummary {
  /** 未完了分のみ。経費は実績側で一度だけ控除する */
  forecast?: { count: number; revenue: number; gross_profit: number }
  month: string
  kind: SaleKind
  sales_count: number
  revenue: number
  total_fee: number
  total_shipping: number
  total_packaging: number
  total_cost: number
  gross_profit: number
  /** 送料が未入力（is_shipping_confirmed=0）の販売数。その分は送料 0 で集計されているので画面で注記する */
  unconfirmed_shipping: number
  /** 経費（expense.month がその月の合計）。kind='resale' の行にだけ載せ、私物の行は 0 */
  expense_total: number
  /** 締め済みなら true */
  closed: boolean
  /** 純利益 = 粗利 − 期間費用 */
  net_profit: number
}

// ------------------------------------------------------------
// 期間費用（振込手数料・梱包材の買い足しなど、販売 1 件に紐付かない費用）
// ------------------------------------------------------------

/**
 * 経費の項目。packaging=梱包費（既定。ビニール・箱など）／supplies=消耗品／shipping=送料／
 * fee=手数料／transfer_fee=振込手数料（自動計上は廃止。過去の行のために残す）／other=その他。
 * 減価償却は扱わない
 */
export type ExpenseCategory = 'packaging' | 'supplies' | 'shipping' | 'fee' | 'transfer_fee' | 'other'

/** 経費（レシート）の明細 1 行 */
export interface ExpenseLine {
  id: string
  name: string
  /** 税込の単価 */
  unit_price: number
  quantity: number
  /** 行の金額 ＝ unit_price × quantity（main が計算して保存。画面で再計算しない） */
  amount: number
  category: ExpenseCategory
}

/**
 * 経費 1 件＝レシート 1 枚。amount は明細があれば明細の合計、無ければ入力した合計。
 * 計上月 month は購入日の月が既定（変えられる）。月次の純利益・按分はこの month で集計する
 */
export interface Expense {
  id: string
  /** 購入日 YYYY-MM-DD */
  occurred_at: string
  /** 計上月 YYYY-MM */
  month: string
  /** 購入店 */
  shop: string | null
  /** 代表の項目（明細が無いときの項目。明細があれば最初の明細の項目） */
  category: ExpenseCategory
  amount: number
  note: string | null
  /** 旧・振込手数料の自動計上の印（1）。新規には付かない */
  auto: number
  /** レシート画像。soroban-thumb://receipt-<id>.<ext>。無ければ null */
  receipt_url: string | null
  /** 店の登録番号（T＋13 桁）。レシートから読めたときだけ。CSV に出す（インボイスの控え） */
  registration_no: string | null
  lines: ExpenseLine[]
}

export interface ExpenseLineInput {
  name: string
  /** 税込の単価 */
  unit_price: number
  /** 省略は 1 */
  quantity?: number
  category?: ExpenseCategory
}

/**
 * レシート画像を AI（Gemini、利用者の API キー）で読んだ下書き。画像は Google に送られる。
 * 推定なので必ず人が直す前提。読めなかった項目は null／空
 */
/** 画像上の位置。[ymin, xmin, ymax, xmax]、0〜1000 の正規化座標（Gemini の box_2d と同じ） */
export type ReceiptBox = [number, number, number, number]

export interface ReceiptDraft {
  shop: string | null
  /** レシートの事業者登録番号（T＋13 桁）。会社ごとに固定なので店名の学習キーに使う。無ければ null */
  registration_no: string | null
  /** shop が学習（shop_alias）や辞書で決まったなら true。OCR の生の推定なら false */
  shop_learned: boolean
  /** YYYY-MM-DD */
  occurred_at: string | null
  /** 「合計」などの行から取った税込の合計。無ければ null */
  total: number | null
  /** 明細。category は AI の分類（梱包費／消耗品／送料／手数料／その他）。無ければ画面の既定。box は画像上の位置 */
  lines: Array<{ name: string; unit_price: number; quantity: number; category?: ExpenseCategory; box?: ReceiptBox | null }>
  /** 店名・日付・合計を読んだ画像上の位置（AI の推定。確認用の枠に使う）。無ければ null */
  boxes: { shop: ReceiptBox | null; date: ReceiptBox | null; total: ReceiptBox | null }
  /** 消費税などで明細合計と合計が違うときの差額（AI が読めたとき）。無ければ null */
  tax: number | null
  /** AI が気づいたこと（例：事業と関係なさそうな行、合計が合わない） */
  warnings: string[]
  /** AI の生の応答（確認用） */
  raw_text: string
  /** 0〜100 */
  confidence: number
}

export interface AiStatus {
  /** API キーが保存されていれば true */
  configured: boolean
  /** 使うモデル（設定 ai_model。既定 gemini-flash-latest。キーによって使えるモデルが違うので listGeminiModels で選ぶ） */
  model: string
  /** OS の安全な保存（safeStorage）が使えるか。false なら保存を断る */
  safe_storage: boolean
}

/** 画像を選んで読み取った結果。temp_file は createExpense の receipt_temp_file に渡すと本添付になる */
export interface ReceiptRead {
  temp_file: string
  receipt_url: string
  draft: ReceiptDraft
}

export interface ExpenseInput {
  occurred_at: string
  /** readReceiptImage で読んだ一時ファイル名。指定すると登録時にレシートとして添付する */
  receipt_temp_file?: string | null
  /** OCR の下書きから登録するとき、レシートの登録番号を渡すと「この番号＝この店名」を覚える（shop_alias） */
  receipt_registration_no?: string | null
  /** 省略時は occurred_at の月 */
  month?: string | null
  shop?: string | null
  category: ExpenseCategory
  /** 明細が無いときの合計。明細があれば無視して明細の合計を使う */
  amount?: number
  note?: string | null
  lines?: ExpenseLineInput[]
}

/** 月の締めの記録。数字は締めた時点のもの（後で変わっても動かない） */
export interface MonthClose {
  month: string
  closed_at: string
  alloc_method: AllocMethod
  sales_count: number
  revenue: number
  gross_profit: number
  expense_total: number
  net_profit: number
}

/** 月次の明細の販売 1 行（sale_profit ＋ 按分した経費） */
export interface MonthSaleRow extends SaleProfit {
  /** この販売に配賦した経費（整数。合計はその月の経費合計と一致） */
  allocated_expense: number
  /** 粗利 − 配賦した経費 */
  net_profit: number
}

export interface MonthTotals {
  sales_count: number
  revenue: number
  total_fee: number
  total_shipping: number
  total_packaging: number
  total_cost: number
  gross_profit: number
  expense_total: number
  net_profit: number
}

/**
 * 月次の明細（月次タブの月をクリック）。
 * 経費はその月の販売用の販売（kind='resale'）に按分する。私物には配賦しない。
 * 金額按分＝販売価格の比、数量按分＝紐付けた在庫の点数の比（0 点なら 1）。
 * floor で配って余りは最後の行に寄せ、Σallocated_expense = expense_total にする。販売が 0 件なら誰にも配賦しない
 */
export interface MonthDetail {
  personal_forecast?: { count: number; revenue: number; gross_profit: number }
  forecast_sales?: SaleProfit[]
  forecast?: { count: number; revenue: number; gross_profit: number }
  month: string
  alloc_method: AllocMethod
  close: MonthClose | null
  /** 締め後に数字が変わっていれば true（close と totals の比較） */
  changed_since_close: boolean
  /** 販売用の販売（私物は含めない）。sold_at がその月 */
  sales: MonthSaleRow[]
  /** 私物の販売（参考。按分しない） */
  personal_sales: SaleProfit[]
  expenses: Expense[]
  expense_by_category: Array<{ category: ExpenseCategory; amount: number }>
  totals: MonthTotals
  /** tagId を渡したときだけ。そのタグ（直接・派生）を持つ販売だけの合計 */
  filtered: (MonthTotals & { tag: Tag }) | null
  /** その月に注文した仕入の仕入先ごとの支払合計（総原価＝商品計＋送料＋その他−割引） */
  purchases_by_account: Array<{ shop_account_id: string; shop_account_name: string; count: number; total_cost: number }>
  /** 締める前に片付けるもの */
  pending: { unconfirmed_shipping: number; unmatched: number }
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
  /** 発送が必要な販売（status = waiting_shipment）の件数。要対応の上位に出す */
  needsShipment: number
  /** 未販売在庫の点数 */
  stockCount: number
  /** 未販売在庫の原価合計（寝ている資金） */
  stockValue: number
  /** 滞留warn日数を超えた在庫の点数 */
  agingCount: number
  /** 今月の集計（転売分） */
  thisMonth: MonthlySummary | null
  /** 直近の実行 1 件（取り込み元を問わない） */
  lastRun: CollectorRun | null
  /**
   * 取り込み元ごとの直近の実行（メルカリ 1 件＋有効なメロジョイ口座ごとに 1 件）。
   * status が ok 以外のものは、ホームの要対応の先頭に「取り込みが失敗」として出す
   * （最後の 1 回だけ見ていると、別の取り込み元の成功で失敗が隠れるため）
   */
  recentRuns: CollectorRun[]
}


// ------------------------------------------------------------
// v0.2 画面の作り直し用の契約（ホーム＝受信箱、売上＝進捗、在庫＝型番グループ、商品＝カルテ、月次＝計算書、仕入＝ヘッダ）
// 数字は全部 main が計算する。画面は表示と操作だけ
// ------------------------------------------------------------

/** ホーム「今やること」の 1 件。kind ごとに画面での操作が決まる */
export type InboxKind =
  | 'ship'            // 売れて未発送（メルカリで発送する）。sale
  | 'shipping'        // 送料未入力。sale。行内の発送方法セレクトで片付く
  | 'link'            // 未紐付け。sale。候補が 1 点なら candidate で 1 クリック
  | 'confirm'         // 価格未入力の仕入（下書き）。purchase
  | 'collect'         // 取り込みの問題（ログイン切れ・失敗）。run
  | 'reminder'        // 忘れていませんか（自分で入れるもの）。reminder

export type ReminderType = 'manual_purchase' | 'delivery' | 'expense' | 'close_month'

export interface InboxItem {
  kind: InboxKind
  /** 画面のキー。sale_id / purchase_id / run_id / reminder の種類 */
  id: string
  title: string
  /** 補足 1 行（日付・金額・買い手・仕入先など。main が組み立てる） */
  detail: string
  thumb_url: string | null
  /** 販売の場合の中身（発送方法セレクト・紐付けに使う） */
  sale?: SaleProfit
  /** 未紐付けで候補が 1 点だけのとき（型番一致・先入先出）。ボタン 1 つで紐付け */
  candidate?: { inventory_item_id: string; item_code: string; landed_cost: number; acquired_at: string } | null
  /** 片付けたときの粗利（見込み）。null なら出さない */
  profit_hint?: { min: number; max: number } | null
  /** 仕入の下書きの場合 */
  purchase?: PurchaseSummary
  /** 取り込みの問題の場合 */
  run?: CollectorRun
  /** reminder の場合の種類と、押すボタン */
  reminder?: { type: ReminderType; action_label: string; purchase_id?: string; month?: string }
}

export interface InboxGroup { kind: InboxKind; label: string; hint: string; items: InboxItem[] }

/** ホームの上の利益ストリップ。トップバーの「今月の粗利」にも使う */
export interface ProfitStrip {
  month: string
  gross_profit: number
  net_profit: number
  revenue: number
  sales_count: number
  /** 今月の取引未完了分の見込み粗利（赤字も含む） */
  pending_profit_estimate: number
  pending_count: number
  /** 売上金の反映待ち（発送済み・受取評価待ち・評価待ちの販売の 価格−手数料 の合計） */
  awaiting_payout: number
  awaiting_payout_count: number
  /** 先月の純利益と締め状態 */
  last_month: { month: string; net_profit: number; closed: boolean } | null
}

export interface Inbox {
  strip: ProfitStrip
  groups: InboxGroup[]
  /** 今日片付けた件数（app_log の書き込み系から。目安） */
  done_today: number
  /** 右側「見直すもの」 */
  review: {
    aging_count: number
    aging_days: number
    unallocated_listings: number
    last_month_unclosed: string | null
    top_model: { model_code: string; name: string; total_profit: number } | null
  }
}

/** 売上タブの上の進捗（メルカリ側の状態）と入力（アプリ側の状態） */
export interface SalesProgress {
  listed: { count: number; expected_profit: number; unallocated: number }
  to_ship: { count: number; revenue: number }
  /** 発送済み・受取評価待ち・評価待ち（売上金の反映待ち） */
  in_transit: { count: number; revenue: number }
  completed_this_month: { count: number; revenue: number }
  all: number
  inputs: { needs_shipping: number; needs_link: number; done: number }
}

/** 在庫タブの上の状態カード */
export interface InventoryOverview {
  unlisted_arrived: { count: number; cost: number }
  not_arrived: { count: number; cost: number }
  listed: { count: number; expected_profit: number }
  aging: { count: number; cost: number; days: number }
}

/** split＝分割前の親だけ（メンテナンス用）。other／all には分割前の親を含めない */
export type InventoryGroupFilter = 'unlisted' | 'unlisted_arrived' | 'not_arrived' | 'listed' | 'sold' | 'other' | 'split' | 'all'

/** 在庫タブの型番グループ 1 つ（中の点は InventoryItem[]） */
export interface InventoryGroup {
  model_code: string | null
  name: string
  thumb_url: string | null
  tags: Tag[]
  unlisted: number
  unlisted_arrived: number
  not_arrived: number
  listed: number
  sold: number
  avg_price: number | null
  avg_profit: number | null
  cost_per_item: number | null
  oldest_acquired_at: string | null
  oldest_aging_days: number | null
  items: InventoryItem[]
}

/** 商品カルテ */
export interface ProductKarte {
  summary: ProductSummary
  /** 仕入明細の元の名前（表示名と違うとき） */
  source_name: string | null
  in_stock: { count: number; arrived: number; not_arrived: number; cost: number }
  listed: { count: number; price_total: number; expected_profit: number }
  sold_recent: { count: number; days: number }
  price_range: { min: number; max: number } | null
  profit_rate: number | null
  items: InventoryItem[]
  sales: SaleProfit[]
  listings: Listing[]
  /** 「この金額で売ったら？」の既定（先入先出の未出品 1 点、発送方法は最後に使ったもの） */
  estimate_default: { inventory_item_id: string | null; shipping_method_id: string | null }
}

/** 月次の計算書（MonthDetail の totals を縦組みで読むための並び。数字は同じ） */
export interface MonthStatement {
  personal_forecast?: { count: number; revenue: number; gross_profit: number }
  forecast?: { count: number; revenue: number; gross_profit: number }
  month: string
  sales_count: number
  revenue: number
  fee: number
  shipping: number
  shipping_actual_count: number
  packaging: number
  cost: number
  cost_items: number
  gross_profit: number
  gross_rate: number | null
  expenses: Array<{ category: ExpenseCategory; amount: number }>
  expense_total: number
  net_profit: number
  net_rate: number | null
  /** 参考 */
  awaiting_payout: number
  personal_revenue: number
  purchase_paid: number
  /** タグ別の集計（重複タグの販売は両方に数える。画面で注意を出す） */
  by_tag: Array<{ tag: Tag; count: number; gross_profit: number; allocated_expense: number; net_profit: number }>
  multi_tag_count: number
}

/** 仕入タブの上の仕入先カード（期間内の確定した仕入） */
export interface PurchaseAccountCard {
  /** null = すべて */
  shop_account_id: string | null
  name: string
  kind: ShopAccountKind | null
  orders: number
  items: number
  total_cost: number
  drafts: number
  not_arrived: number
  auth_required: boolean
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

/** 自動バックアップの状態。週 1 回、起動時に前回から 7 日以上たっていれば取る */
export interface AutoBackupStatus {
  enabled: boolean
  /** 最後に自動バックアップを取った日時（ISO）。まだ無ければ null */
  last_at: string | null
  /** 保存先フォルダ（userData/backups） */
  dir: string
  /** 新しい順。5 世代まで残して古いものから消す */
  files: Array<{ name: string; size: number; created_at: string }>
}

/** CSV で書き出す対象。sales=販売（実績・見込みの区分つき）／purchases=仕入の明細／expenses=経費の明細／inventory=在庫 1 点ずつ */
export type ExportKind = 'sales' | 'purchases' | 'expenses' | 'inventory'

export interface SorobanApi {
  // ダッシュボード
  getDashboard(): Promise<DashboardStats>
  /** ホーム（受信箱）。今やること・利益ストリップ・見直すもの */
  getInbox(): Promise<Inbox>
  /** 「忘れていませんか」を 7 日消す */
  snoozeReminder(type: ReminderType, id?: string | null): Promise<void>
  /** 売上タブの進捗と入力の件数（completed は今月） */
  getSalesProgress(): Promise<SalesProgress>
  /** 在庫タブの上の状態カード */
  getInventoryOverview(): Promise<InventoryOverview>
  /** 在庫を型番ごとにまとめて返す */
  listInventoryGroups(filter: InventoryGroupFilter): Promise<InventoryGroup[]>
  /** 商品カルテ */
  getProductKarte(modelCode: string): Promise<ProductKarte>
  /** 月次の計算書 */
  getMonthStatement(month: string): Promise<MonthStatement>
  /** 仕入タブの仕入先カード（期間で絞る。from/to は YYYY-MM-DD、null なら全部） */
  listPurchaseAccountCards(from: string | null, to: string | null): Promise<PurchaseAccountCard[]>

  // 販売
  listSales(filter?: SaleFilter): Promise<SaleProfit[]>
  /** 絞り込んだ販売の合計（件数・売上・手数料・送料・原価・粗利） */
  saleTotals(filter?: SaleFilter): Promise<SaleTotals>
  createSale(input: SaleInput): Promise<string>
  updateSale(id: string, patch: SalePatch): Promise<void>
  deleteSale(id: string): Promise<void>

  // 紐付け
  /** takeFromSale: 販売済みの在庫を、今の販売から外してこの販売に付け替える（メンテ用。画面で警告してから呼ぶ） */
  linkInventory(saleId: string, inventoryItemIds: string[], opts?: { takeFromSale?: boolean }): Promise<void>
  /** 未紐付けの転売のうち型番が完全一致するものを先入先出で自動確定する。戻り値は確定した販売数 */
  autoLinkPending(): Promise<number>
  unlinkInventory(saleId: string, inventoryItemId: string): Promise<void>
  /** 商品名の類似度で在庫の候補を返す（確定はしない） */
  /** includeSold: 販売済み（他の販売に紐付いた）在庫も候補に含める（sold_to 付き）。既定は未販売だけ */
  suggestInventory(saleId: string, limit?: number, opts?: { includeSold?: boolean }): Promise<InventoryItem[]>
  /** 商品コード完全一致・未販売・未引き当ての在庫を先入先出で選ぶ（読取専用）。選択済みIDは除外する */
  suggestProductInventory(modelCode: string, quantity: number, excludeIds?: string[]): Promise<string[]>
  /** その販売に紐付いている在庫（解除・付け替え用） */
  listSaleLines(saleId: string): Promise<InventoryItem[]>

  // 仕入
  listPurchases(): Promise<PurchaseSummary[]>
  getPurchase(id: string): Promise<PurchaseDetail>
  /** 登録。同じ仕入先に同じ注文番号があれば Error（日本語の文）。注文番号が空なら重複は見ない */
  createPurchase(input: PurchaseInput): Promise<string>
  /**
   * まとめて登録（CSV の一括登録）。1 件ずつ createPurchase と同じ検証で登録し、
   * 失敗した行は理由を付けて返す（全体を止めない）。index は inputs の添字
   */
  importPurchases(inputs: PurchaseInput[]): Promise<PurchaseImportResult>
  /** 下書きを確定する：内容を input で置き換え、在庫を生成する */
  confirmPurchase(id: string, input: PurchaseInput): Promise<void>
  updatePurchaseNote(id: string, note: string | null): Promise<void>
  /**
   * 到着状態を手で変える（TikTok Shop など自動取得しない仕入先向け）。
   * shipped / delivered に初めて到達した日を shipped_at / delivered_at に刻む（既に入っていれば触らない）。
   * メロジョイの自動取得がある仕入は次の取り込みで注文一覧の状態に戻る
   */
  updatePurchaseFulfillment(id: string, fulfillment: Fulfillment | null): Promise<void>
  deletePurchase(id: string): Promise<void>

  // 在庫
  listInventory(status?: InventoryStatus): Promise<InventoryItem[]>
  updateInventory(id: string, patch: InventoryPatch): Promise<void>
  /** ばらして売る：1点を count 点に分割。原価は等分し端数は最後の子へ。親は 'split' になる。戻り値は子の id */
  /**
   * 在庫 1 点を count 点に分割（箱を開けて半分ずつ売る等）。原価は均等割り（余りは末尾に 1 円ずつ）。
   * 子は新しい在庫コードを持ち、名前は「元の名前（分割 1/2）」。親は split になる。子の id を返す
   */
  splitInventory(id: string, count: number): Promise<string[]>
  /**
   * 分割を戻す（親 id）。子が全部 未出品 で、どの出品にも引き当てられていないときだけ。
   * 子を消して親を未出品に戻す。親の原価は分割前のまま（子の合計と一致）。子のタグ・メモは親に寄せる。
   * 戻せないときは理由を Error（例：S-0023 が販売済み）
   */
  mergeSplitInventory(parentId: string): Promise<void>
  /** 在庫から外す。廃棄（disposed）か自家消費（personal_use）。既定は disposed */
  disposeInventory(id: string, note: string, status?: 'disposed' | 'personal_use'): Promise<void>

  // 集計
  listMonthly(): Promise<MonthlySummary[]>

  // 期間費用
  /** month は YYYY-MM。省略で全部。新しい順 */
  /** month（YYYY-MM）は計上月で絞る。省略で全部（新しい順） */
  listExpenses(month?: string): Promise<Expense[]>
  createExpense(input: ExpenseInput): Promise<string>
  updateExpense(id: string, input: ExpenseInput): Promise<void>
  deleteExpense(id: string): Promise<void>
  /** レシート画像をファイル選択で添付（userData/thumbs/receipt-<id>.<ext> にコピー）。キャンセルなら null */
  attachReceipt(id: string): Promise<string | null>
  removeReceipt(id: string): Promise<void>
  /** 画像を選んで AI で読む。キャンセルなら null。キー未設定なら Error('AI 読み取りの設定がありません') */
  readReceiptImage(): Promise<ReceiptRead | null>
  /** 添付済みのレシートを AI で読む。レシートが無ければ Error */
  readReceipt(id: string): Promise<ReceiptDraft>
  /** AI 読み取りの状態。キーそのものは返さない */
  getAiStatus(): Promise<AiStatus>
  /** API キーを保存（safeStorage で暗号化）／null で削除 */
  setGeminiApiKey(key: string | null): Promise<void>
  /** モデル名を保存（設定 ai_model） */
  setAiModel(model: string): Promise<void>
  /** 保存したキーで 1 回だけ小さな要求を送って疎通を確かめる */
  testGemini(): Promise<{ ok: boolean; message: string }>
  /** このキーで使えるモデルの一覧（generateContent 対応のもの。表示名と説明付き）。キー未設定なら Error */
  listGeminiModels(): Promise<Array<{ name: string; display_name: string; description: string }>>

  /** 月次の明細。tagId で絞った合計も同時に返す */
  getMonthDetail(month: string, opts?: { tagId?: string | null }): Promise<MonthDetail>
  /** その月の経費の按分方法（既定 by_amount）。締め前でも変えられる */
  setMonthAllocMethod(month: string, method: AllocMethod): Promise<void>
  /** 終わった月だけ締められる（今月・未来は Error）。締めた時点の数字を記録する */
  closeMonth(month: string): Promise<MonthClose>
  reopenMonth(month: string): Promise<void>

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
  /** 商品（型番）のタグを丸ごと置き換える */
  setProductTags(modelCode: string, tagIds: string[]): Promise<void>
  /** 型番の表示名を付ける／外す（null）。仕入明細・在庫の元の名前は変えない。商品タブ・ランキング・在庫・売上の表示に使う */
  setProductName(modelCode: string, name: string | null): Promise<void>
  /** 商品画像を人がセットする（main でファイル選択ダイアログを開く）。選んだら true、キャンセルは false。以後は取り込みで上書きしない */
  setProductImage(modelCode: string): Promise<boolean>
  /** auto=true：人がセットした画像を捨てて自動（出品・販売の最新画像）に戻す。auto=false：今の自動画像をコピーして固定する */
  setProductImageAuto(modelCode: string, auto: boolean): Promise<void>
  /** 取引画面を 1 ページだけ開いて購入日時を取り直す（メンテ用）。取れた購入日時、取れなければ null。CAPTCHA なら例外 */
  refetchSaleDates(saleId: string): Promise<{ purchased_at: string | null }>
  /** メロジョイの注文詳細を 1 ページだけ開き直して、明細の商品画像を取り込む（メンテ用）。保存できた枚数 */
  refetchPurchaseImages(purchaseId: string): Promise<{ saved: number }>
  /** 仕入先ごとの累計（確定した仕入）。注文数・点数・支払合計（総原価）・最終注文日 */
  listShopAccountStats(): Promise<ShopAccountStats[]>
  listVariantSummary(sort?: 'total_profit' | 'avg_profit' | 'sold'): Promise<VariantSummary[]>

  // 商品（型番）ページ・在庫の履歴
  listProducts(sort?: 'total_profit' | 'avg_profit' | 'sold' | 'in_stock' | 'last_purchased_at'): Promise<ProductSummary[]>
  getProduct(modelCode: string): Promise<ProductDetail | null>
  getItemTimeline(inventoryItemId: string): Promise<ItemTimeline | null>

  // 出品（メルカリ）と在庫の引き当て
  /** status 未指定なら active + suspended。onlyUnallocated で未引き当てだけ */
  listListings(filter?: { status?: ListingStatus[]; onlyUnallocated?: boolean }): Promise<Listing[]>
  /**
   * 出品に在庫を引き当てる（追加）。販売済み・廃棄済みの在庫はエラー。
   * 他の active/suspended な出品に引き当て済みの在庫は、その引き当てを外してこちらへ**移す**
   * （再出品・付け替え。人の最新の決定を優先。元の出品は未引き当てに戻る）
   */
  /** takeFromSale: 販売済みの在庫を、その販売から外してこの出品に引き当てる（メンテ用。画面で警告してから呼ぶ） */
  reserveInventory(mercariItemId: string, inventoryItemIds: string[], opts?: { takeFromSale?: boolean }): Promise<void>
  unreserveInventory(mercariItemId: string, inventoryItemId: string): Promise<void>
  /**
   * 出品の引き当て候補。型番の完全一致 → シリーズ一致 → 名前の一致の順。販売済み・廃棄済みは除く。
   * 他の出品に引き当て済みの在庫も返す（`listing` に引き当て先が入る。画面では「出品 X から移す」と見せる）。
   * この出品自身に引き当て済みのものは除く
   */
  suggestForListing(mercariItemId: string, limit?: number, opts?: { includeSold?: boolean }): Promise<InventoryItem[]>
  /** 人が「取り下げた」と記録する。引き当ては外れ、在庫は未出品に戻る */
  endListing(mercariItemId: string): Promise<void>
  /**
   * 未引き当ての出品（active／suspended）に、型番の枝番まで完全一致する未販売・未引き当ての在庫を
   * 先入先出で 1 点ずつ引き当てる（販売の autoLinkPending と同じ規則。型番が 1 つで枝番ありのものだけ）。
   * 引き当てた出品の数を返す。1 クリックで解除できること
   */
  autoReserveListings(): Promise<number>
  /** 出品時に発送方法を決めておく（null で外す） */
  setListingShipping(mercariItemId: string, shippingMethodId: string | null): Promise<void>

  // 横断検索（「あの商品どうなった？」を 1 か所で。全期間・全状態が対象）
  /** 空白区切り AND、NFKC 正規化。種類ごとに新しい順、合計 limit 件（既定 60） */
  searchAll(query: string, limit?: number): Promise<SearchHit[]>

  // マスタ
  listShopAccounts(): Promise<ShopAccount[]>
  createShopAccount(name: string, kind?: ShopAccountKind): Promise<string>
  updateShopAccount(id: string, patch: { name?: string; kind?: ShopAccountKind; is_active?: number; import_keywords?: string | null; auto_tag_ids?: string[]; default_shipping_fee?: number | null }): Promise<void>
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
  /**
   * 粗利の見積もり（画面で再計算しないための共通計算）。手数料は現在の手数料率、送料は発送方法の料金
   * （無効化・削除済みの発送方法でも料金を引く）、原価は在庫の landed_cost の合計
   */
  estimateSaleProfit(input: { price: number; shipping_method_id: string | null; packaging_cost?: number; inventory_item_ids: string[] }): Promise<{ fee: number; shipping_fee: number; packaging_cost: number; cost: number; gross_profit: number }>
  /** 取り込んだ販売を削除したときに残る「もう取り込まない」記録。設定 → データ で見て解除できる */
  listSaleExclusions(): Promise<Array<{ mercari_item_id: string; title: string; excluded_at: string }>>
  removeSaleExclusion(mercariItemId: string): Promise<void>
  /** 仕入先アカウント（メロジョイ）のログイン画面を開く。アカウントごとに別プロファイル */
  openShopLogin(shopAccountId: string): Promise<void>
  listRuns(limit?: number): Promise<CollectorRun[]>

  // バックアップ
  /**
   * CSV で書き出す（確定申告・記録の持ち出し用）。
   * kind 省略時は販売。month（YYYY-MM）を渡すとその月だけ。保存先は人が選ぶ
   */
  exportCsv(kind?: ExportKind, month?: string): Promise<string | null>
  /**
   * バックアップを zip で保存（保存先を選ぶ。キャンセルなら null）。中身：soroban.db（SQLite の backup API で整合したコピー）、
   * thumbs/（レシート画像・サムネ）、meta.json（バージョン・OS・日時）。不具合報告もこのファイル 1 本
   */
  /** 自動バックアップの状態（週 1 回、起動時に古ければ取る。userData/backups に 5 世代まで） */
  getAutoBackupStatus(): Promise<AutoBackupStatus>
  /** 自動バックアップの入切。切ると次の起動から取らない（取り済みのファイルは消さない） */
  setAutoBackupEnabled(enabled: boolean): Promise<void>
  /** いま 1 本取る（自動と同じ場所・同じ世代管理）。取れたファイルのパス */
  runAutoBackupNow(): Promise<string>
  /** バックアップの入っているフォルダを OS のファイラで開く */
  openBackupFolder(): Promise<void>
  backupDb(): Promise<string | null>
  /**
   * zip から復元。復元前に今の DB と画像を userData/backup-before-restore-<日時>/ に退避してから入れ替え、アプリを再起動する。
   * 古い形式（.db 単体）も受け付ける。キャンセルなら null、成功なら再起動するので戻らない
   */
  restoreBackup(): Promise<{ restarting: true } | null>
  revealDbFolder(): Promise<void>
  /** 取引データ（販売・仕入・在庫・紐付け・取り込み履歴・期間費用）を全部消す。設定・仕入先・発送方法は残す */
  resetData(): Promise<void>

  /**
   * メルカリのページを標準ブラウザで開く。item = 商品ページ（https://jp.mercari.com/item/mXXX）、
   * transaction = 取引画面（https://jp.mercari.com/transaction/mXXX）。この 2 種以外は開かない
   */
  openMercari(kind: 'item' | 'transaction', mercariItemId: string): Promise<void>

  // 更新（GitHub Releases）
  /** いまのアプリのバージョンと、更新の確認結果。起動時と 6 時間ごとに自動で確認し、手動でも呼べる */
  /** 画面側の出来事をログに残す（例外・操作）。DB の app_log に入り、14 日で消える */
  logClient(kind: string, message: string, payload?: unknown): Promise<void>
  checkForUpdate(): Promise<UpdateStatus>
  /**
   * 更新を入れる。Windows：ダウンロード済みなら再起動して入れ替える（未ダウンロードならダウンロードを始める）。
   * macOS：署名が無いので自動入れ替えはできない。Releases のページ（dmg）をブラウザで開く
   */
  installUpdate(): Promise<void>
}

export interface UpdateStatus {
  /** いまのバージョン（package.json） */
  current: string
  /** 'none' = 最新 / 'available' = 新しい版がある / 'downloaded' = 入れ替え準備済み（Windows）/ 'error' = 確認できない（オフライン等） */
  state: 'none' | 'available' | 'downloaded' | 'error'
  /** 新しいバージョン（あれば） */
  latest: string | null
  /** リリースノート（Markdown。あれば） */
  notes: string | null
  /** Releases のページ URL（macOS はここを開く） */
  url: string | null
  /** この OS で自動入れ替えできるか（Windows = true、macOS = false） */
  canAutoInstall: boolean
  message: string | null
}

declare global {
  interface Window {
    /** 画面が使う API。renderer/main.ts が sorobanBridge を包んで定義する（引数を素のオブジェクトに直す） */
    soroban: SorobanApi
    /** preload が contextBridge で公開する生の API。画面からは直接使わない */
    sorobanBridge?: SorobanApi
  }
}
