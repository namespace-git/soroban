-- ============================================================
-- そろばん（Soroban）— メルカリ転売 利益管理
-- ローカルSQLiteスキーマ
--
-- 設計方針：
--   * 金額はすべて INTEGER（円）。小数を持ち込まない
--   * inventory_item（在庫1点）が販売可能な最小単位
--   * 1販売に複数在庫を紐付けられる（まとめ売り対応）
--   * landed_cost は在庫生成時に確定。後から仕入を直しても過去の利益は動かない
--
-- 新規DBはこのファイルで完成形を作る。既存DBには db.ts の migrate() が
-- 列を後から足す（SQLite は既存の CHECK 制約を ALTER できないため、
-- inventory_item.status のように制約自体を変える場合はテーブルを作り直す）。
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================
-- マスタ
-- ============================================================

-- 仕入先アカウント（メロジョイA / メロジョイB / TikTok 等）
CREATE TABLE IF NOT EXISTS shop_account (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- mellojoy = メロジョイ本体 / tiktok = TikTok Shop / other = その他手動登録
  kind       TEXT NOT NULL DEFAULT 'other'
             CHECK (kind IN ('mellojoy','tiktok','other')),
  note       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  -- 取り込みキーワード（改行・カンマ区切り）。空/NULLなら全部取り込む。詳細は shared/types.ts
  import_keywords TEXT,
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

-- タグ。販売・在庫に複数付けられる。名前は一意
CREATE TABLE IF NOT EXISTS tag (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- アプリ設定（手数料率など）
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- fee_rate_bp: ベーシスポイント。1000 = 10.00%
-- 小数を避けるため整数で持つ
-- collect_interval_h: 2026-09-19 に 6 時間から 1 時間へ変更（既存DBは migrate() で更新）
-- mercari_keyword: 転売と判定するキーワード（, 、 空白 区切りで複数可）。空なら型番の有無で判定する
--
-- schema_version はここに入れない。migrate() がバージョン判定に使う値なので、
-- ここで先に既定値を入れてしまうと「未マイグレーションの既存DB」でも
-- version=2 に見えてしまい、列追加が一切走らなくなる（migrate() 側でだけ設定する）
INSERT OR IGNORE INTO setting (key, value) VALUES
  ('fee_rate_bp',                 '1000'),
  ('transfer_fee',                '200'),
  ('aging_warn_days',             '90'),
  ('collect_interval_h',          '1'),
  ('mercari_keyword',             '');

-- ============================================================
-- 仕入
-- ============================================================

CREATE TABLE IF NOT EXISTS purchase (
  id              TEXT PRIMARY KEY,
  shop_account_id TEXT NOT NULL REFERENCES shop_account(id),

  -- draft = mellojoy-watch から積んだ下書き。価格未入力。在庫は confirmed で生成
  status          TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('draft','confirmed')),
  -- mellojoy-watch の記録フォルダ名など。同じものを二度積まないためのキー
  import_key      TEXT UNIQUE,

  ordered_at      TEXT NOT NULL,              -- YYYY-MM-DD
  order_no        TEXT,

  shipping_fee    INTEGER NOT NULL DEFAULT 0, -- 仕入時の送料
  discount        INTEGER NOT NULL DEFAULT 0, -- クーポン等（正の数で保持）
  other_cost      INTEGER NOT NULL DEFAULT 0,

  -- 按分方式：by_amount（金額按分）/ by_quantity（数量按分）
  alloc_method    TEXT NOT NULL DEFAULT 'by_amount'
                  CHECK (alloc_method IN ('by_amount','by_quantity')),

  -- 仕入元の注文の到着状態。pending(確認済み・未発送) / shipped(配達中) / delivered(配達済み)。
  -- NULL = 不明（手入力）。在庫の生成タイミングは変えない（確定時に作る）。
  -- 到着まで「未着」として見せるだけで、紐付けは可
  fulfillment          TEXT
                       CHECK (fulfillment IN ('pending','shipped','delivered')),
  fulfillment_updated_at TEXT,
  -- 到着状態が shipped / delivered になったのを最初に観測した日（YYYY-MM-DD）。それ以前は NULL
  shipped_at           TEXT,
  delivered_at         TEXT,

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
  unit_price  INTEGER NOT NULL,              -- 税込単価。下書きは 0
  quantity    INTEGER NOT NULL CHECK (quantity > 0),

  -- 型番（メロジョイの商品コード）。手動登録でも商品名から自動抽出し、手で直せる
  model_code  TEXT,
  series_code TEXT,
  material    TEXT,

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

  -- 型番。親（purchase_line）から継ぐが、分割時に手で直せる
  model_code       TEXT,
  series_code      TEXT,
  material         TEXT,
  -- 分割で生まれた子ならここに親の id
  parent_id        TEXT REFERENCES inventory_item(id),
  note             TEXT,

  -- split = ばらして売るために分割した親。子が在庫として残る（過去の原価は動かさない）
  status           TEXT NOT NULL DEFAULT 'in_stock'
                   CHECK (status IN ('in_stock','sold','disposed','personal_use','split')),
  disposed_at      TEXT,
  disposed_note    TEXT,

  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_status   ON inventory_item(status);
CREATE INDEX IF NOT EXISTS idx_inv_acquired ON inventory_item(acquired_at);
CREATE INDEX IF NOT EXISTS idx_inv_pline    ON inventory_item(purchase_line_id);
-- idx_inv_model（model_code列を使う）は __VIEWS__ マーカーの後ろで作る。
-- 既存DBは migrate() で model_code 列を足すまでこの列が無いため、
-- テーブル作成と同じタイミングで作ると未migrateのDBでコケる。

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
  -- actual = メルカリの取引詳細から取った実額 / master = 発送方法マスタ / manual = 手入力
  shipping_source    TEXT CHECK (shipping_source IN ('actual','master','manual')),

  -- collector は送料を取得できない。
  -- 発送方法を選ぶ・実額が取れたら 1 にする。0 のものを「要入力」として出す
  is_shipping_confirmed INTEGER NOT NULL DEFAULT 0,

  -- タイトル・説明文から抜いた型番（複数可）。JSON配列で持つ
  model_codes        TEXT NOT NULL DEFAULT '[]',

  -- メルカリの取引の進み具合。NULL = まだ取れていない（collector は今のところ埋めない。
  -- 取引中タブ・取引画面の DOM 確認後に対応する）
  status             TEXT
                     CHECK (status IN ('waiting_shipment','shipped','delivered','completed')),
  shipped_at         TEXT,
  delivered_at       TEXT,
  completed_at       TEXT,
  -- 買い手のニックネーム。取れていなければ NULL
  buyer              TEXT,

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
  -- auto = 型番の完全一致で自動確定 / manual = 人が確定 /
  -- listing = 出品に人が引き当てた在庫を、売れたときにそのまま引き継いだ
  link_source       TEXT NOT NULL DEFAULT 'manual'
                    CHECK (link_source IN ('auto','manual','listing')),
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
-- 出品（メルカリの出品中タブから取り込む）と在庫の引き当て
--
-- 出品そのものは在庫の状態を変えない（in_stock のまま。まだ売れていない資産）。
-- 引き当ては listing_line が持ち、在庫の status には反映しない
-- （在庫タブ・在庫金額は変わらず、「出品中」は listing_line からの派生表示にする）。
-- ============================================================

CREATE TABLE IF NOT EXISTS listing (
  mercari_item_id TEXT PRIMARY KEY,          -- m123456789
  title           TEXT NOT NULL,
  price           INTEGER NOT NULL,
  -- active = 出品中 / suspended = 公開停止中 / sold = 売却済み一覧で観測 / ended = 人が取り下げたと記録
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','sold','ended')),
  first_seen_at   TEXT NOT NULL,             -- 初めて一覧で見た日 YYYY-MM-DD（出品日の近似）
  last_seen_at    TEXT NOT NULL,
  -- 出品日（推定）。出品中タブの「n日前に更新」から today − n日で見積もる。
  -- 更新で巻き戻るので、以後の取り込みでは「より古い方」にだけ更新する（db.ts の upsertListings）
  listed_at       TEXT NOT NULL,
  likes           INTEGER,                   -- いいね数。取れなければ NULL
  -- 出品時に決めた発送方法（設定の発送方法）。売れたとき販売へ引き継ぐ（db.ts の takeOverListing）
  shipping_method_id TEXT REFERENCES shipping_method(id) ON DELETE SET NULL,
  thumb_file      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 出品と在庫の引き当て（人が確定する。自動確定しない）
CREATE TABLE IF NOT EXISTS listing_line (
  id                TEXT PRIMARY KEY,
  listing_id        TEXT NOT NULL REFERENCES listing(mercari_item_id) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_item(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listing_line_listing ON listing_line(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_line_item    ON listing_line(inventory_item_id);

-- 二重引き当てを禁止：同じ在庫が既に別の active/suspended な出品に引き当て済み、
-- または在庫が in_stock でなければ挿入を拒否する
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

-- ============================================================
-- 期間費用（振込手数料など、個別の販売に紐付かないもの）
-- ============================================================

CREATE TABLE IF NOT EXISTS expense (
  id          TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  category    TEXT NOT NULL,   -- transfer_fee | supplies | other
  amount      INTEGER NOT NULL,
  note        TEXT,
  -- 1 = 振込手数料の自動計上（月1件）。人が消しても、その月にはもう自動で作らない
  -- （expense_auto_month に記録が残るため）
  auto        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expense_date ON expense(occurred_at);

-- 振込手数料を自動計上した月の記録。auto=1の行を人が消しても、この記録が残る限り
-- その月にはもう自動で作り直さない（手数料設定を後から変えても過去月は動かさない、と同じ思想）
CREATE TABLE IF NOT EXISTS expense_auto_month (
  month      TEXT PRIMARY KEY, -- YYYY-MM
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  message     TEXT,

  -- mercari = 販売履歴 / mellojoy = 仕入先アカウントの注文履歴
  source          TEXT NOT NULL DEFAULT 'mercari'
                  CHECK (source IN ('mercari','mellojoy')),
  -- mellojoy のときだけ。どのアカウントの実行か
  shop_account_id TEXT REFERENCES shop_account(id)
);

CREATE INDEX IF NOT EXISTS idx_run_started ON collector_run(started_at DESC);
-- idx_run_source_started（source列を使う）は __VIEWS__ マーカーの後ろで作る（idx_inv_modelと同じ理由）。

-- ============================================================
-- タグの付け外し（多対多）。tag を消すと CASCADE で外れる（T-04）
-- ============================================================

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

-- 仕入に付いたタグ。その仕入から生まれた在庫すべて・その在庫が紐付いた販売に「派生」で見える
-- （コピーしない。上流で付け外しすれば下流にもそのまま効く）
CREATE TABLE IF NOT EXISTS purchase_tag (
  purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tag(id)      ON DELETE CASCADE,
  PRIMARY KEY (purchase_id, tag_id)
);

-- 商品（型番）に付いたタグ。model_code はメロジョイの商品コードそのもの（外部キーは張らない。
-- 在庫・仕入行が無い型番にも先に付けられるようにするため）。その型番の在庫すべて・
-- その在庫が紐付いた販売に「派生」で見える（コピーしない）
CREATE TABLE IF NOT EXISTS product_tag (
  model_code TEXT NOT NULL,
  tag_id     TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (model_code, tag_id)
);

-- 仕入先アカウントの自動タグ。この口座の仕入（取り込み・手入力とも）に作成時にだけ
-- purchase_tag として自動で付く（createPurchase / createPurchaseDraft）。後から setPurchaseTags で
-- 外せる。外しても再付与しない（作成時だけの挙動）
CREATE TABLE IF NOT EXISTS shop_account_tag (
  shop_account_id TEXT NOT NULL REFERENCES shop_account(id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tag(id)          ON DELETE CASCADE,
  PRIMARY KEY (shop_account_id, tag_id)
);

-- __VIEWS__
-- db.ts はこのマーカーでファイルを分割し、テーブルの CREATE → migrate() での
-- 列追加 → ここから先のビュー作成、の順で実行する（ビューが新しい列を参照するため）。

-- 型番の先入先出（自動紐付け）と型番ランキング集計に使う。
-- model_code は migrate() で足される列なので、ここ（migrate() の後）で作る。
CREATE INDEX IF NOT EXISTS idx_inv_model ON inventory_item(model_code, status, acquired_at);

-- source は migrate() で足される列なので、ここ（migrate() の後）で作る。
CREATE INDEX IF NOT EXISTS idx_run_source_started ON collector_run(source, started_at DESC);

-- ============================================================
-- ビュー
--
-- CREATE VIEW IF NOT EXISTS だと定義変更が既存DBに反映されないため、
-- 毎起動 DROP → CREATE で作り直す。
-- ============================================================

-- 販売ごとの利益
-- 粗利 = 販売価格 − 手数料 − 送料 − 梱包材 − Σ(紐付けた在庫の按分後原価)
DROP VIEW IF EXISTS sale_profit;
CREATE VIEW sale_profit AS
SELECT
  s.id,
  s.mercari_item_id,
  s.thumb_file,
  s.sold_at,
  s.title,
  s.kind,
  s.price,
  s.fee,
  s.shipping_fee,
  s.packaging_cost,
  s.is_shipping_confirmed,
  s.shipping_method_id,
  s.shipping_source,
  s.note,
  s.model_codes,
  s.source,
  s.status,
  s.shipped_at,
  s.delivered_at,
  s.completed_at,
  s.buyer,
  COALESCE(SUM(i.landed_cost), 0) AS cost,
  s.price - s.fee - s.shipping_fee - s.packaging_cost
    - COALESCE(SUM(i.landed_cost), 0) AS gross_profit,
  COUNT(sl.id) AS item_count,
  CASE WHEN COUNT(sl.id) = 0 THEN 1 ELSE 0 END AS unmatched,
  -- 1 なら紐付けのどれかが型番の自動確定
  COALESCE(MAX(CASE WHEN sl.link_source = 'auto' THEN 1 ELSE 0 END), 0) AS auto_linked
FROM sale s
LEFT JOIN sale_line      sl ON sl.sale_id = s.id
LEFT JOIN inventory_item i  ON i.id = sl.inventory_item_id
GROUP BY s.id;

-- 月次集計（kind別）
DROP VIEW IF EXISTS monthly_summary;
CREATE VIEW monthly_summary AS
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

-- 在庫（滞留日数つき）
DROP VIEW IF EXISTS inventory_view;
CREATE VIEW inventory_view AS
SELECT
  i.id,
  i.name,
  i.landed_cost,
  i.acquired_at,
  i.status,
  CAST(julianday('now') - julianday(i.acquired_at) AS INTEGER) AS aging_days,
  p.order_no,
  sa.name AS shop_account_name,
  i.model_code,
  i.series_code,
  i.material,
  i.parent_id,
  i.note,
  p.fulfillment,
  -- 紐付いた販売のサムネイル（売れた在庫だけ）。1在庫は1販売にしか紐付かない
  -- （sale_line.inventory_item_id が UNIQUE）ので LEFT JOIN で行が増えることはない
  sale.thumb_file,
  -- 出品への引き当て（active/suspended のみ。trg_listing_line_guard により
  -- 1在庫につき active/suspended な引き当ては高々1件なので行は増えない）
  lst.mercari_item_id AS listing_id,
  lst.price           AS listing_price,
  lst.status          AS listing_status
FROM inventory_item i
LEFT JOIN purchase_line pl ON pl.id = i.purchase_line_id
LEFT JOIN purchase      p  ON p.id  = pl.purchase_id
LEFT JOIN shop_account  sa ON sa.id = p.shop_account_id
LEFT JOIN sale_line     sl ON sl.inventory_item_id = i.id
LEFT JOIN sale             ON sale.id = sl.sale_id
LEFT JOIN listing_line  ll ON ll.inventory_item_id = i.id
LEFT JOIN listing       lst ON lst.mercari_item_id = ll.listing_id AND lst.status IN ('active','suspended');

-- 1販売の価格・粗利を、紐付けた点数（sale_line）に整数で按分したもの。
-- まとめ売り（1販売に複数在庫）のとき、1点あたりの売上・粗利を「商品ページ」
-- 「在庫の履歴」で使う。CLAUDE.md の按分と同じ流儀：
--   base = floor(合計 / 点数)、余り r（0 <= r < 点数）は「最後の r 行」に +1 する。
-- 「最後」の順序は sale_line の挿入順（= rowid の昇順）で決める。
-- created_at は秒精度で同じ販売内の複数行が同時刻になり得るため、順序の決定には使わない
-- （tie-break に UUID の id を使うと挿入順と無関係になり、テストが再現できなくなる）。
-- 各行の price_share・profit_share の合計は、必ず sale_profit.price / gross_profit と一致する。
DROP VIEW IF EXISTS sale_line_share;
CREATE VIEW sale_line_share AS
WITH ordered AS (
  SELECT
    sl.id                AS sale_line_id,
    sl.sale_id,
    sl.inventory_item_id,
    i.landed_cost         AS cost,
    sp.item_count,
    sp.price,
    sp.gross_profit,
    ROW_NUMBER() OVER (PARTITION BY sl.sale_id ORDER BY sl.rowid) AS rn,
    -- 余り（0 <= 余り < item_count）。SQLite の % は負数で C 流の切り捨てになるため
    -- (x % n + n) % n で正規化してから使う（gross_profit は赤字（負）もあり得る）
    ((sp.price % sp.item_count) + sp.item_count) % sp.item_count        AS price_rem,
    ((sp.gross_profit % sp.item_count) + sp.item_count) % sp.item_count AS profit_rem
  FROM sale_line sl
  JOIN sale_profit    sp ON sp.id = sl.sale_id
  JOIN inventory_item i  ON i.id = sl.inventory_item_id
)
SELECT
  sale_line_id,
  sale_id,
  inventory_item_id,
  cost,
  (price - price_rem) / item_count
    + CASE WHEN rn > item_count - price_rem THEN 1 ELSE 0 END AS price_share,
  (gross_profit - profit_rem) / item_count
    + CASE WHEN rn > item_count - profit_rem THEN 1 ELSE 0 END AS profit_share
FROM ordered;

-- 型番（バリアント）ごとの実績。ホームの型番ランキングで使う
DROP VIEW IF EXISTS variant_summary;
CREATE VIEW variant_summary AS
WITH linked AS (
  -- sale_line_share の整数按分をそのまま使う（1点あたりの売上・粗利。まとめ売り対応）
  SELECT
    i.model_code,
    sls.price_share  AS price_share,
    sls.profit_share AS profit_share
  FROM inventory_item i
  JOIN sale_line_share sls ON sls.inventory_item_id = i.id
  WHERE i.model_code IS NOT NULL
),
agg AS (
  SELECT
    model_code,
    AVG(price_share)  AS avg_price,
    AVG(profit_share) AS avg_profit,
    SUM(profit_share) AS total_profit
  FROM linked
  GROUP BY model_code
),
base AS (
  SELECT DISTINCT model_code FROM inventory_item WHERE model_code IS NOT NULL
)
SELECT
  base.model_code,
  (SELECT i2.series_code FROM inventory_item i2
     WHERE i2.model_code = base.model_code
     ORDER BY i2.acquired_at DESC, i2.created_at DESC LIMIT 1) AS series_code,
  (SELECT i2.material FROM inventory_item i2
     WHERE i2.model_code = base.model_code
     ORDER BY i2.acquired_at DESC, i2.created_at DESC LIMIT 1) AS material,
  (SELECT i2.name FROM inventory_item i2
     WHERE i2.model_code = base.model_code
     ORDER BY i2.acquired_at DESC, i2.created_at DESC LIMIT 1) AS name,
  (SELECT COUNT(*) FROM inventory_item i2
     WHERE i2.model_code = base.model_code AND i2.status != 'split') AS purchased,
  (SELECT COUNT(*) FROM inventory_item i2
     WHERE i2.model_code = base.model_code AND i2.status = 'sold') AS sold,
  (SELECT COUNT(*) FROM inventory_item i2
     WHERE i2.model_code = base.model_code AND i2.status = 'in_stock') AS in_stock,
  (SELECT COALESCE(SUM(i2.landed_cost), 0) FROM inventory_item i2
     WHERE i2.model_code = base.model_code AND i2.status = 'in_stock') AS stock_value,
  CAST(ROUND(agg.avg_price) AS INTEGER)                  AS avg_price,
  CAST(ROUND(agg.avg_profit) AS INTEGER)                 AS avg_profit,
  CAST(ROUND(COALESCE(agg.total_profit, 0)) AS INTEGER)  AS total_profit
FROM base
LEFT JOIN agg ON agg.model_code = base.model_code;
