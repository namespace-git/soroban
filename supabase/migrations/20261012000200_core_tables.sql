-- ============================================================
-- そろばん Web 版 — 既存テーブルの移植（SQLite の最新形 → Postgres）
--
-- 移植元：src/main/schema.sql ＋ db.ts の migrate()（列の後付け）＋ applog.ts（app_log）。
-- 「新しい空の DB に initDb() をかけた結果」を正とした。
--
-- 共通の約束
-- * 全テーブルに household_id（既定値は API が渡す app.household_id）。RLS で世帯を強制する
-- * id は uuid（SQLite は randomUUID() の文字列だった）。親子の外部キーは (household_id, id) の
--   複合で張る。単純に id だけで張ると、他の世帯の id を指す行が作れてしまうため
--   （外部キーの検査は RLS を受けないので、RLS では防げない）
-- * ユニーク制約は household_id を含める（世帯をまたいで衝突しない）
-- * 金額は integer（円）。日付は date（計上日・仕入日など「日」の事実）／
--   timestamptz（取り込んだ時刻など「出来事の時刻」）。月（YYYY-MM）は text ＋ check
-- * 0/1 のフラグ（is_active など）は SQLite のまま integer。画面の型（number）と
--   移植元の SQL（= 0 / = 1）をそのまま使えるように
-- * *_file → *_path（Supabase Storage の中のパス）
-- * mercari_item_id → channel_item_id（Yahoo!フリマの id も入る）
-- ============================================================

-- ============================================================
-- マスタ
-- ============================================================

-- 仕入先アカウント（メロジョイA / メロジョイB / TikTok 等）
create table app.shop_account (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  name         text not null,
  -- mellojoy = メロジョイ本体 / tiktok = TikTok Shop / other = その他手動登録
  kind         text not null default 'other' check (kind in ('mellojoy', 'tiktok', 'other')),
  note         text,
  is_active    integer not null default 1,
  -- 取り込みキーワード（改行・カンマ区切り）。空/NULL なら全部取り込む
  import_keywords text,
  -- 手入力の仕入フォームで、この仕入先を選んだときに入る送料の既定値（円）。NULL なら 0
  default_shipping_fee integer,
  created_at   timestamptz not null default now(),
  unique (household_id, id)
);

-- 発送方法。送料は改定されるので編集可能
create table app.shipping_method (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  name         text not null,
  carrier      text,
  fee          integer not null,
  sort_order   integer not null default 0,
  is_active    integer not null default 1,
  unique (household_id, id)
);

-- タグ。販売・在庫・仕入に複数付けられる。名前は世帯の中で一意
create table app.tag (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  name         text not null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, name)
);

-- アプリ設定（手数料率など）。世帯ごと。秘密の値（API キー）はここに入れず setting_secret へ
create table app.setting (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  key          text not null,
  value        text not null,
  primary key (household_id, key)
);

-- レシートの登録番号（T＋13桁）→ 店名の学習。key は接頭辞付き（'reg:T2290801007056'）
create table app.shop_alias (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  key          text not null,
  shop         text not null,
  hits         integer not null default 1,
  updated_at   timestamptz not null,
  primary key (household_id, key)
);

-- 型番ごとの表示名（人が上書き）とメモ。メモだけ付けて表示名は付けない運用もあるので name は NULL 可
create table app.product_name (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  model_code   text not null,
  name         text,
  note         text,
  updated_at   timestamptz not null,
  primary key (household_id, model_code)
);

-- 型番ごとに人がセットした商品画像（Storage のパス）。取り込みで上書きしない
create table app.product_image (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  model_code   text not null,
  path         text not null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, model_code)
);

-- メロジョイの注文取り込みで人が除外した注文。キーワードが変わったら（keywords_hash 不一致）再評価する
create table app.mellojoy_excluded_order (
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  shop_account_id uuid not null,
  order_key       text not null,
  keywords_hash   text not null,
  excluded_at     timestamptz not null default now(),
  primary key (household_id, shop_account_id, order_key),
  foreign key (household_id, shop_account_id)
    references app.shop_account (household_id, id) on delete cascade
);

-- ============================================================
-- 仕入
-- ============================================================

create table app.purchase (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  shop_account_id uuid not null,

  -- draft = 下書き（価格未入力。在庫は confirmed で生成）
  status          text not null default 'confirmed' check (status in ('draft', 'confirmed')),
  -- 取り込んだ注文のキー。同じものを二度積まない
  import_key      text,

  ordered_at      date not null,
  order_no        text,

  shipping_fee    integer not null default 0, -- 仕入時の送料
  discount        integer not null default 0, -- クーポン等（正の数で保持）
  other_cost      integer not null default 0,

  -- 按分方式：by_amount（金額按分）/ by_quantity（数量按分）
  alloc_method    text not null default 'by_amount'
                  check (alloc_method in ('by_amount', 'by_quantity')),

  -- 仕入元の注文の到着状態。NULL = 不明（手入力）
  fulfillment            text check (fulfillment in ('pending', 'shipped', 'delivered')),
  fulfillment_updated_at timestamptz,
  -- お店・配送会社の実際の発送日・到着日（こちらが気づいた日ではない）
  shipped_at             date,
  delivered_at           date,

  -- 注文詳細を開いて商品画像 URL を確認した日時。NULL = 未確認
  image_checked_at       timestamptz,

  tracking_carrier       text,
  tracking_number        text,
  -- 17TRACK で最後に見た配送状況の言葉そのまま。表示用
  tracking_status        text,
  tracking_checked_at    timestamptz,
  -- 追跡番号を 17TRACK に登録した日時。登録は無料枠を消費するので、一度登録したら二度と送らない
  tracking_registered_at timestamptz,

  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (household_id, id),
  unique (household_id, import_key),
  unique (household_id, shop_account_id, order_no),
  foreign key (household_id, shop_account_id)
    references app.shop_account (household_id, id)
);

create index idx_purchase_ordered on app.purchase (household_id, ordered_at desc);

create table app.purchase_line (
  id          uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
              references app.household (id) on delete cascade,
  purchase_id uuid not null,

  name        text not null,
  unit_price  integer not null,                 -- 税込単価。下書きは 0
  quantity    integer not null check (quantity > 0),

  model_code  text,
  series_code text,
  material    text,

  -- 按分結果（登録・再計算時に確定させる）
  allocated_cost   integer not null default 0,  -- この明細に配賦された送料等
  landed_unit_cost integer not null default 0,  -- 1点あたりの按分後原価

  -- 仕入先の商品画像。image_url は注文詳細から取った元 URL、image_path は Storage のパス
  image_url   text,
  image_path  text,

  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),

  unique (household_id, id),
  foreign key (household_id, purchase_id)
    references app.purchase (household_id, id) on delete cascade
);

create index idx_pline_purchase on app.purchase_line (household_id, purchase_id);

-- ============================================================
-- 在庫（販売可能な1点）
-- ============================================================

create table app.inventory_item (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null default (current_setting('app.household_id')::uuid)
                   references app.household (id) on delete cascade,
  -- そろばんが発行する在庫1点ずつのコード（例 S-0012）。型番とは別
  item_code        text not null,
  -- NULL 可：仕入記録のない私物を在庫として扱う場合に使う
  purchase_line_id uuid,

  name             text not null,
  -- 按分後原価。生成時にコピーし、以後は独立。後から書き換えると過去の利益が動く
  landed_cost      integer not null,
  acquired_at      date not null,               -- 仕入日

  model_code       text,
  series_code      text,
  material         text,
  -- 分割で生まれた子ならここに親の id
  parent_id        uuid,
  note             text,

  -- split = ばらして売るために分割した親。子が在庫として残る
  status           text not null default 'in_stock'
                   check (status in ('in_stock', 'sold', 'disposed', 'personal_use', 'split')),
  disposed_at      date,
  disposed_note    text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (household_id, id),
  unique (household_id, item_code),
  foreign key (household_id, purchase_line_id)
    references app.purchase_line (household_id, id) on delete cascade,
  foreign key (household_id, parent_id)
    references app.inventory_item (household_id, id)
);

create index idx_inv_status   on app.inventory_item (household_id, status);
create index idx_inv_acquired on app.inventory_item (household_id, acquired_at);
create index idx_inv_pline    on app.inventory_item (household_id, purchase_line_id);
create index idx_inv_parent   on app.inventory_item (household_id, parent_id);
-- 型番の先入先出（自動紐付け）と型番ランキング集計
create index idx_inv_model    on app.inventory_item (household_id, model_code, status, acquired_at);

-- ============================================================
-- 販売
-- ============================================================

create table app.sale (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null default (current_setting('app.household_id')::uuid)
                     references app.household (id) on delete cascade,

  -- 出品先（メルカリ / Yahoo!フリマ）
  channel            text not null default 'mercari' check (channel in ('mercari', 'yahoo')),
  -- 出品先での商品ID。メルカリは m123456789。手入力の販売は NULL
  channel_item_id    text,
  title              text not null,
  sold_at            date not null,             -- 計上日（月次・月フィルタの基準）
  price              integer not null,

  -- 転売か私物か。税務上の扱いが異なるので必ず分ける
  kind               text not null default 'resale' check (kind in ('resale', 'personal')),

  fee_rate_bp        integer not null default 1000,
  fee                integer not null default 0,  -- 販売手数料（確定値）
  -- 手数料が実額か見込みか。actual の手数料は価格変更で上書きしない
  fee_source         text not null default 'rate' check (fee_source in ('actual', 'rate')),

  shipping_method_id uuid,
  shipping_fee       integer not null default 0,
  packaging_cost     integer not null default 0,
  -- actual = 取引詳細から取った実額 / master = 発送方法マスタ / manual = 手入力
  shipping_source    text check (shipping_source in ('actual', 'master', 'manual')),

  -- 0 のものを「送料未入力」として目立たせる
  is_shipping_confirmed integer not null default 0,

  -- タイトル・説明文から抜いた型番（複数可）
  model_codes        text[] not null default '{}',

  -- 自動紐付けが「これだけ揃えば紐付け完了」と見積もった点数。NULL なら見積もっていない
  expected_item_count integer,

  -- 取引の進み具合。NULL = まだ取れていない
  status             text check (status in
                       ('waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed')),
  shipped_at         date,
  delivered_at       date,
  completed_at       date,                      -- 購入完了日（売上金が入る日）
  buyer              text,

  -- 購入日時（取引画面）。日付しか取れなかった行は、その日の 0:00（日本時間）で入れる
  purchased_at          timestamptz,
  -- 1 = 取引画面を一度だけ開いた（取れなくても再試行しない）
  purchased_at_checked  integer not null default 0,
  -- 保存したサムネイルの元 URL（クエリ・フラグメント除く）。変わったら取り直す
  thumb_src             text,
  -- 保存したサムネイル（Storage のパス）
  thumb_path            text,

  note               text,
  source             text not null default 'collector' check (source in ('collector', 'manual')),
  raw                jsonb,                      -- 取得時の生データ（デバッグ用）

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (household_id, id),
  unique (household_id, channel_item_id),
  foreign key (household_id, shipping_method_id)
    references app.shipping_method (household_id, id)
);

create index idx_sale_sold on app.sale (household_id, sold_at desc);
create index idx_sale_kind on app.sale (household_id, kind);

-- 販売と在庫の紐付け。1販売に複数在庫（まとめ売り）
create table app.sale_line (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null default (current_setting('app.household_id')::uuid)
                    references app.household (id) on delete cascade,
  sale_id           uuid not null,
  inventory_item_id uuid not null,
  -- auto = 型番の完全一致で自動確定 / manual = 人が確定 /
  -- listing = 出品に人が引き当てた在庫を、売れたときにそのまま引き継いだ
  link_source       text not null default 'manual' check (link_source in ('auto', 'manual', 'listing')),
  created_at        timestamptz not null default now(),

  -- 紐付けた順。まとめ売りの 1 点あたりの按分（sale_line_share）で、端数をどの行に寄せるかを
  -- 決める並び順。SQLite では sale_line の rowid（挿入順）で決めていたが、Postgres に rowid は無く、
  -- created_at は同時刻になり得るので、挿入のたびに増える番号を持つ。
  -- 一度付いたら変えない（update は下の trg_sale_line_order_immutable が拒否する）。
  -- 並べるのは販売の中だけなので、値は世帯・販売をまたいで連続しなくてよい（欠番は出る）
  allocation_order  bigint generated always as identity,

  unique (household_id, id),
  -- 1つの在庫は1回しか売れない
  unique (household_id, inventory_item_id),
  -- 販売の中の並び順（この索引が ORDER BY allocation_order と、販売から紐付けを引く検索を兼ねる）
  unique (household_id, sale_id, allocation_order),
  foreign key (household_id, sale_id)
    references app.sale (household_id, id) on delete cascade,
  foreign key (household_id, inventory_item_id)
    references app.inventory_item (household_id, id)
);

-- 取り込んだ販売を削除したときに残す「もう取り込まない」記録
create table app.sale_exclusion (
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  channel_item_id text not null,
  title           text not null,
  excluded_at     timestamptz not null default now(),
  primary key (household_id, channel_item_id)
);

-- ============================================================
-- 出品と在庫の引き当て
--
-- 出品そのものは在庫の状態を変えない（in_stock のまま）。引き当ては listing_line が持つ
-- ============================================================

create table app.listing (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  -- 出品先（メルカリ / Yahoo!フリマ）と、そこでの商品ID
  channel         text not null default 'mercari' check (channel in ('mercari', 'yahoo')),
  channel_item_id text not null,
  title           text not null,
  price           integer not null,
  -- active = 出品中 / suspended = 公開停止中 / sold = 売却済み一覧で観測 / ended = 人が取り下げたと記録
  status          text not null default 'active'
                  check (status in ('active', 'suspended', 'sold', 'ended')),
  first_seen_at   date not null,                 -- 初めて一覧で見た日（出品日の近似）
  last_seen_at    timestamptz not null,
  -- 出品日（推定）。以後の取り込みでは「より古い方」にだけ更新する
  listed_at       date not null,
  likes           integer,                       -- いいね数。取れなければ NULL
  -- 出品時に決めた発送方法。売れたとき販売へ引き継ぐ
  shipping_method_id uuid,
  thumb_path      text,                          -- Storage のパス
  -- 保存したサムネイルの元 URL（クエリ・フラグメント除く）。変わったら取り直す
  thumb_src       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (household_id, id),
  unique (household_id, channel, channel_item_id),
  -- 発送方法を消しても出品は残す。複合キーなので household_id は NULL にしない（列を指定する）
  foreign key (household_id, shipping_method_id)
    references app.shipping_method (household_id, id) on delete set null (shipping_method_id)
);

-- 出品と在庫の引き当て（人が確定する。自動確定しない）
create table app.listing_line (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null default (current_setting('app.household_id')::uuid)
                    references app.household (id) on delete cascade,
  listing_id        uuid not null,
  inventory_item_id uuid not null,
  created_at        timestamptz not null default now(),

  unique (household_id, id),
  foreign key (household_id, listing_id)
    references app.listing (household_id, id) on delete cascade,
  foreign key (household_id, inventory_item_id)
    references app.inventory_item (household_id, id)
);

create index idx_listing_line_listing on app.listing_line (household_id, listing_id);
create index idx_listing_line_item    on app.listing_line (household_id, inventory_item_id);

-- ============================================================
-- 期間費用（経費）
-- ============================================================

create table app.expense (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  occurred_at     date not null,                -- 購入日
  -- 計上月。月次の純利益・按分はこちらで集計する
  month           text not null check (month ~ '^\d{4}-\d{2}$'),
  shop            text,                         -- 購入店
  -- 代表の項目。明細（expense_line）があれば最初の明細の項目
  category        text not null,                -- packaging | supplies | shipping | fee | transfer_fee | other
  amount          integer not null,
  note            text,
  -- 旧・振込手数料の自動計上（廃止）の印。過去の行のために残す。新規行には付かない
  auto            integer not null default 0,
  receipt_path    text,                         -- レシート画像（Storage のパス）
  -- 店の登録番号（T＋13桁）。レシートから読めたときだけ
  registration_no text,
  created_at      timestamptz not null default now(),

  unique (household_id, id)
);

create index idx_expense_date  on app.expense (household_id, occurred_at);
create index idx_expense_month on app.expense (household_id, month);

-- 経費（レシート）の明細1行
create table app.expense_line (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  expense_id   uuid not null,
  name         text not null,
  unit_price   integer not null default 0,      -- 単価
  amount       integer not null,                -- 行の金額 ＝ unit_price × quantity
  quantity     integer not null default 1,
  category     text not null,
  sort_order   integer not null default 0,

  unique (household_id, id),
  foreign key (household_id, expense_id)
    references app.expense (household_id, id) on delete cascade
);

create index idx_expense_line_expense on app.expense_line (household_id, expense_id);

-- 月の締め。closed_at が入っていれば締め済み（数字はその時点のもの。後で変わっても動かさない）
create table app.month_book (
  household_id  uuid not null default (current_setting('app.household_id')::uuid)
                references app.household (id) on delete cascade,
  month         text not null check (month ~ '^\d{4}-\d{2}$'),
  alloc_method  text not null default 'by_amount' check (alloc_method in ('by_amount', 'by_quantity')),
  closed_at     timestamptz,
  sales_count   integer,
  revenue       integer,
  gross_profit  integer,
  expense_total integer,
  net_profit    integer,
  primary key (household_id, month)
);

-- ============================================================
-- 収集の実行記録
-- ============================================================

create table app.collector_run (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  started_at      timestamptz not null,
  finished_at     timestamptz,
  -- empty = 0件（連続したら DOM 変更で壊れている疑い）/ auth_required = セッション切れ
  status          text not null default 'ok' check (status in ('ok', 'auth_required', 'failed', 'empty')),
  fetched         integer not null default 0,
  inserted        integer not null default 0,
  message         text,
  -- mercari = 販売履歴 / mellojoy = 仕入先アカウントの注文履歴 / yahoo = Yahoo!フリマの販売履歴
  source          text not null default 'mercari' check (source in ('mercari', 'mellojoy', 'yahoo')),
  -- mellojoy のときだけ。どのアカウントの実行か
  shop_account_id uuid,

  unique (household_id, id),
  foreign key (household_id, shop_account_id)
    references app.shop_account (household_id, id)
);

create index idx_run_started        on app.collector_run (household_id, started_at desc);
create index idx_run_source_started on app.collector_run (household_id, source, started_at desc);

-- ============================================================
-- タグの付け外し（多対多）。タグを消すと CASCADE で外れる
-- ============================================================

create table app.sale_tag (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  sale_id      uuid not null,
  tag_id       uuid not null,
  primary key (household_id, sale_id, tag_id),
  foreign key (household_id, sale_id) references app.sale (household_id, id) on delete cascade,
  foreign key (household_id, tag_id)  references app.tag (household_id, id)  on delete cascade
);

create table app.inventory_tag (
  household_id      uuid not null default (current_setting('app.household_id')::uuid)
                    references app.household (id) on delete cascade,
  inventory_item_id uuid not null,
  tag_id            uuid not null,
  primary key (household_id, inventory_item_id, tag_id),
  foreign key (household_id, inventory_item_id)
    references app.inventory_item (household_id, id) on delete cascade,
  foreign key (household_id, tag_id) references app.tag (household_id, id) on delete cascade
);

-- 仕入に付いたタグ。その仕入から生まれた在庫・その在庫が紐付いた販売に「派生」で見える（コピーしない）
create table app.purchase_tag (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  purchase_id  uuid not null,
  tag_id       uuid not null,
  primary key (household_id, purchase_id, tag_id),
  foreign key (household_id, purchase_id)
    references app.purchase (household_id, id) on delete cascade,
  foreign key (household_id, tag_id) references app.tag (household_id, id) on delete cascade
);

-- 商品（型番）に付いたタグ。model_code に外部キーは張らない
-- （在庫・仕入行が無い型番にも先に付けられるようにするため）
create table app.product_tag (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  model_code   text not null,
  tag_id       uuid not null,
  primary key (household_id, model_code, tag_id),
  foreign key (household_id, tag_id) references app.tag (household_id, id) on delete cascade
);

-- 仕入先アカウントの自動タグ。この口座の仕入に作成時にだけ purchase_tag として付く
create table app.shop_account_tag (
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  shop_account_id uuid not null,
  tag_id          uuid not null,
  primary key (household_id, shop_account_id, tag_id),
  foreign key (household_id, shop_account_id)
    references app.shop_account (household_id, id) on delete cascade,
  foreign key (household_id, tag_id) references app.tag (household_id, id) on delete cascade
);

-- ============================================================
-- お金の出入り（資金繰り）
--
-- 損益（sale_profit / monthly_summary / month_book）とは別の層。損益のテーブルは読むだけで、
-- ここから書き換えない
-- ============================================================

-- お金の置き場。残高の列は持たない：opening_balance（opening_date の朝の残高）に
-- cash_entry を積んで出す
create table app.cash_account (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  name            text not null,
  kind            text not null default 'bank' check (kind in ('bank', 'flea', 'cash', 'other')),
  opening_balance integer not null default 0 check (opening_balance >= 0),
  opening_date    date not null,
  sort_order      integer not null default 0,
  is_active       integer not null default 1,
  created_at      timestamptz not null default now(),

  unique (household_id, id)
);

-- 払う義務。tool_share は根拠（basis_*）を作るときに固定して持つ
create table app.liability (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default (current_setting('app.household_id')::uuid)
                references app.household (id) on delete cascade,
  kind          text not null check (kind in ('loan', 'tool_share', 'purchase')),
  counterparty  text not null,
  occurred_at   date not null,
  due_at        date,
  amount        integer not null check (amount > 0),
  note          text,
  -- tool_share の根拠。sale への外部キーは張らない（販売を消す・作り直す操作に巻き込まれず、額も動かさない）
  basis_sale_id uuid,
  basis_amount  integer,                        -- そのときの粗利（円）
  basis_rate_bp integer,                        -- 割合（3000 = 30%）
  month         text check (month ~ '^\d{4}-\d{2}$'), -- purchase のとき、どの月ぶんか
  created_at    timestamptz not null default now(),

  unique (household_id, id)
);

create index idx_liability_due on app.liability (household_id, due_at);

-- 入出金。金額は常に正の整数で、向きは direction
create table app.cash_entry (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  account_id   uuid not null,
  occurred_at  date not null,
  direction    text not null check (direction in ('in', 'out')),
  amount       integer not null check (amount > 0),
  category     text not null
               check (category in ('sale_payout', 'purchase_payment', 'loan_in', 'loan_repay',
                                   'tool_share', 'allowance', 'expense', 'transfer', 'other')),
  note         text,
  sale_id      uuid,                            -- 自動で作った入金のとき、どの販売か（控え。外部キーは張らない）
  created_at   timestamptz not null default now(),

  unique (household_id, id),
  foreign key (household_id, account_id)
    references app.cash_account (household_id, id)
);

create index idx_cash_entry_date    on app.cash_entry (household_id, occurred_at);
create index idx_cash_entry_account on app.cash_entry (household_id, account_id);

-- どの入出金がどの債務をいくら消したか。入出金を消せば消込も一緒に外れる。
-- 消込のある債務は消せない（履歴を壊さない）
create table app.liability_settlement (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  entry_id     uuid not null,
  liability_id uuid not null,
  amount       integer not null check (amount > 0),

  unique (household_id, id),
  unique (household_id, entry_id, liability_id),
  foreign key (household_id, entry_id)
    references app.cash_entry (household_id, id) on delete cascade,
  foreign key (household_id, liability_id)
    references app.liability (household_id, id)
);

create index idx_liability_settlement_liability on app.liability_settlement (household_id, liability_id);

-- ============================================================
-- 操作ログ（IPC の書き込み系・収集・画面の例外）。14 日で削除する
-- ============================================================

create table app.app_log (
  id           bigint generated by default as identity primary key,
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  ts           timestamptz not null default now(),
  source       text not null,
  kind         text not null,
  message      text not null,
  -- 2,000 文字で切った要約。途中で切れるので JSON として正しいとは限らず、jsonb にはしない
  payload      text,
  duration_ms  integer,
  error        text
);

create index idx_app_log_ts on app.app_log (household_id, ts);

-- ============================================================
-- RLS（全表）。表を足したらここに 1 行足す。下の検査が、足し忘れを止める
-- ============================================================

select app.enable_household_rls('app.shop_account');
select app.enable_household_rls('app.shipping_method');
select app.enable_household_rls('app.tag');
select app.enable_household_rls('app.setting');
select app.enable_household_rls('app.shop_alias');
select app.enable_household_rls('app.product_name');
select app.enable_household_rls('app.product_image');
select app.enable_household_rls('app.mellojoy_excluded_order');
select app.enable_household_rls('app.purchase');
select app.enable_household_rls('app.purchase_line');
select app.enable_household_rls('app.inventory_item');
select app.enable_household_rls('app.sale');
select app.enable_household_rls('app.sale_line');
select app.enable_household_rls('app.sale_exclusion');
select app.enable_household_rls('app.listing');
select app.enable_household_rls('app.listing_line');
select app.enable_household_rls('app.expense');
select app.enable_household_rls('app.expense_line');
select app.enable_household_rls('app.month_book');
select app.enable_household_rls('app.collector_run');
select app.enable_household_rls('app.sale_tag');
select app.enable_household_rls('app.inventory_tag');
select app.enable_household_rls('app.purchase_tag');
select app.enable_household_rls('app.product_tag');
select app.enable_household_rls('app.shop_account_tag');
select app.enable_household_rls('app.cash_account');
select app.enable_household_rls('app.liability');
select app.enable_household_rls('app.cash_entry');
select app.enable_household_rls('app.liability_settlement');
select app.enable_household_rls('app.app_log');

do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind in ('r', 'p')
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS（force 込み）が有効でないテーブルがあります: %', missing;
  end if;
end
$$;

-- anon / authenticated には何も渡さない（念のため）
revoke all on all tables    in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;
