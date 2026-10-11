-- ============================================================
-- そろばん Web 版 — 金額のビュー（SQLite の sale_profit / monthly_summary / inventory_view /
-- sale_line_share / variant_summary を Postgres に移植）
--
-- 移植元：src/main/schema.sql の「-- __VIEWS__」より後ろ。
-- 約束は「同じデータを入れたら、SQLite（いまの帳簿）と 1 円も違わない数字が出る」こと。
-- server/__tests__/views/parity.test.ts が、SQLite 側の出力（fixtures/expected.json）と突き合わせる。
--
-- 共通の約束
-- * security_invoker = true：ビューを読む人（soroban_api）の権限で、元の表の RLS が効く。
--   ビュー越しにも、他の世帯の行は 1 行も見えない
-- * ビューの列の名前は SQLite のまま。変わったのは移植元で名前が変わった列だけ
--   （mercari_item_id → channel_item_id、thumb_file → thumb_path）。
--   inventory_view.listing_id は「出品先での商品 ID」（listing.channel_item_id）。
--   SQLite では listing_id が mercari_item_id だったので、その値をそのまま返す
--   （listing_line.listing_id は listing.id の uuid で別物。画面の契約も商品 ID の側）
-- * household_id を各ビューの最後の列に付ける。集計のビュー（monthly_summary / variant_summary）が
--   世帯ごとに集計するため（RLS が効かない読み方をしても、世帯をまたいで合算しない）。
--   画面へ返すときは列を選ぶこと（select * をそのまま返すと世帯の id が混ざる）
-- * count() / sum() は Postgres では bigint になる。ビューの列は ::integer で integer に揃える
--   （画面の契約は number。金額は円の整数）
-- * 「今日」は日本時間の日付 (now() at time zone 'Asia/Tokyo')::date。SQLite の
--   date('now','localtime') / julianday の置き換え。UTC の日付で数えると、日本時間の
--   0〜9 時台に 1 日ずれる（これを系統ごと消す）
-- * 実績の判定は src/shared/recognition.ts の isRealized と同じ条件：
--     status = 'completed' or (source = 'manual' and status is null)
-- ============================================================

-- ------------------------------------------------------------
-- 販売ごとの利益
-- 粗利 = 販売価格 − 手数料 − 送料 − 梱包材 − Σ(紐付けた在庫の按分後原価)
-- ------------------------------------------------------------
create view app.sale_profit
with (security_invoker = true)
as
select
  s.id,
  s.channel,
  s.channel_item_id,
  s.thumb_path,
  s.sold_at,
  s.purchased_at,
  s.title,
  s.kind,
  s.price,
  s.fee,
  s.fee_source,
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
  coalesce(sum(i.landed_cost), 0)::integer as cost,
  (s.price - s.fee - s.shipping_fee - s.packaging_cost
    - coalesce(sum(i.landed_cost), 0))::integer as gross_profit,
  count(sl.id)::integer as item_count,
  -- expected_item_count（見積もった点数）が分かっていて、まだそこに届いていなければ
  -- 揃うまでは unmatched のまま（在庫コード・型番の個数表記が一部しか見つからなかった場合）
  case
    when count(sl.id) = 0 then 1
    when s.expected_item_count is not null and count(sl.id) < s.expected_item_count then 1
    else 0
  end as unmatched,
  -- 1 なら紐付けのどれかが型番の自動確定
  coalesce(max(case when sl.link_source = 'auto' then 1 else 0 end), 0) as auto_linked,
  s.household_id
from app.sale s
left join app.sale_line      sl on sl.household_id = s.household_id and sl.sale_id = s.id
left join app.inventory_item i  on i.household_id  = sl.household_id and i.id = sl.inventory_item_id
group by s.id;

-- ------------------------------------------------------------
-- 月次集計（kind 別）。実績だけ（取引完了＋状態のない手入力）。見込みは入れない
-- ------------------------------------------------------------
create view app.monthly_summary
with (security_invoker = true)
as
select
  to_char(sold_at, 'YYYY-MM')   as month,
  kind,
  count(*)::integer             as sales_count,
  sum(price)::integer           as revenue,
  sum(fee)::integer             as total_fee,
  sum(shipping_fee)::integer    as total_shipping,
  sum(packaging_cost)::integer  as total_packaging,
  sum(cost)::integer            as total_cost,
  sum(gross_profit)::integer    as gross_profit,
  household_id
from app.sale_profit
where status = 'completed' or (source = 'manual' and status is null)
group by household_id, to_char(sold_at, 'YYYY-MM'), kind;

-- ------------------------------------------------------------
-- 在庫（滞留日数つき）
-- ------------------------------------------------------------
create view app.inventory_view
with (security_invoker = true)
as
select
  i.id,
  i.item_code,
  i.name,
  i.landed_cost,
  i.acquired_at,
  i.status,
  -- 日本時間の「今日」と acquired_at（日付）の日数差。date - date は整数の日数
  ((now() at time zone 'Asia/Tokyo')::date - i.acquired_at)::integer as aging_days,
  p.order_no,
  sa.name as shop_account_name,
  i.model_code,
  (select pn.name from app.product_name pn
    where pn.household_id = i.household_id and pn.model_code = i.model_code) as product_name,
  i.series_code,
  i.material,
  i.parent_id,
  i.note,
  p.fulfillment,
  -- 紐付いた販売のサムネイル（売れた在庫だけ）。1 在庫は 1 販売にしか紐付かない
  -- （sale_line の unique (household_id, inventory_item_id)）ので left join で行が増えることはない
  s.thumb_path,
  -- 付け替え（takeFromSale）の警告用。売れた在庫がどの販売に紐付いているか
  s.id      as sold_sale_id,
  s.title   as sold_title,
  s.price   as sold_price,
  s.sold_at as sold_sold_at,
  -- 出品への引き当て（active / suspended のみ。trg_listing_line_guard により 1 在庫につき
  -- active / suspended な引き当ては高々 1 件なので行は増えない）。listing_id は出品先での商品 ID
  lst.channel_item_id as listing_id,
  lst.channel         as listing_channel,
  lst.price           as listing_price,
  lst.status          as listing_status,
  i.household_id
from app.inventory_item i
left join app.purchase_line pl  on pl.household_id  = i.household_id and pl.id = i.purchase_line_id
left join app.purchase      p   on p.household_id   = pl.household_id and p.id = pl.purchase_id
left join app.shop_account  sa  on sa.household_id  = p.household_id and sa.id = p.shop_account_id
left join app.sale_line     sl  on sl.household_id  = i.household_id and sl.inventory_item_id = i.id
left join app.sale          s   on s.household_id   = sl.household_id and s.id = sl.sale_id
left join app.listing_line  ll  on ll.household_id  = i.household_id and ll.inventory_item_id = i.id
left join app.listing       lst on lst.household_id = ll.household_id and lst.id = ll.listing_id
                               and lst.status in ('active', 'suspended');

-- ------------------------------------------------------------
-- 1 販売の価格・粗利を、紐付けた点数（sale_line）に整数で按分したもの。
-- まとめ売り（1 販売に複数在庫）のとき、1 点あたりの売上・粗利を「商品ページ」
-- 「在庫の履歴」で使う。CLAUDE.md の按分と同じ流儀：
--   base = floor(合計 / 点数)、余り r（0 <= r < 点数）は「最後の r 行」に +1 する。
-- 「最後」の順序は sale_line.allocation_order の昇順（紐付けた順。SQLite の rowid の置き換え）。
-- created_at は同時刻になり得るので、順序の決定には使わない。
-- 各行の price_share・profit_share の合計は、必ず sale_profit.price / gross_profit と一致する。
--
-- 余りは (x % n + n) % n で 0 以上に正規化してから使う（gross_profit は赤字（負）もあり得る。
-- % の符号は被除数に従うので、SQLite と同じ式のまま Postgres でも同じ値になる）。
-- (x - 余り) は n で割り切れるので、整数の割り算の切り捨ての向きの違いは出ない
-- ------------------------------------------------------------
create view app.sale_line_share
with (security_invoker = true)
as
with ordered as (
  select
    sl.id                 as sale_line_id,
    sl.sale_id,
    sl.inventory_item_id,
    i.landed_cost         as cost,
    sp.item_count,
    sp.price,
    sp.gross_profit,
    row_number() over (partition by sl.household_id, sl.sale_id order by sl.allocation_order) as rn,
    ((sp.price % sp.item_count) + sp.item_count) % sp.item_count        as price_rem,
    ((sp.gross_profit % sp.item_count) + sp.item_count) % sp.item_count as profit_rem,
    sl.household_id
  from app.sale_line sl
  join app.sale_profit    sp on sp.household_id = sl.household_id and sp.id = sl.sale_id
  join app.inventory_item i  on i.household_id  = sl.household_id and i.id  = sl.inventory_item_id
)
select
  sale_line_id,
  sale_id,
  inventory_item_id,
  cost,
  (price - price_rem) / item_count
    + case when rn > item_count - price_rem then 1 else 0 end as price_share,
  (gross_profit - profit_rem) / item_count
    + case when rn > item_count - profit_rem then 1 else 0 end as profit_share,
  household_id
from ordered;

-- ------------------------------------------------------------
-- 型番（バリアント）ごとの実績。ホームの型番ランキングで使う
--
-- 重み（weight）と平均は SQLite と同じ倍精度（double precision）で計算する。numeric にすると
-- 1/3 の桁が変わり、ちょうど .5 になる平均の丸めが SQLite とずれ得る。
-- 丸めは SQLite の round() と同じ「0 から遠い方へ四捨五入」。Postgres の round(double precision) は
-- 偶数丸め（-250.5 → -250）なので使わない
-- ------------------------------------------------------------
create view app.variant_summary
with (security_invoker = true)
as
with recursive item_weight (id, weight) as (
  -- 分割していない在庫（parent_id なし）の重みは 1。分割した子は「親の重み ÷ 親の子の数」
  -- （分割の分割も再帰）。avg_price / avg_profit を「箱まるごと」単位にそろえるための重み
  select i.id, 1.0::double precision
  from app.inventory_item i
  where i.parent_id is null
  union all
  select i.id, iw.weight / cnt.n
  from app.inventory_item i
  join item_weight iw on iw.id = i.parent_id
  join (
    select parent_id, count(*) as n from app.inventory_item
    where parent_id is not null group by parent_id
  ) cnt on cnt.parent_id = i.parent_id
),
linked as (
  -- sale_line_share の整数按分をそのまま使う（1 点あたりの売上・粗利。まとめ売り対応）。
  -- weight は分割した子を「まるごと換算」するための重み
  select
    i.household_id,
    i.model_code,
    sls.price_share  as price_share,
    sls.profit_share as profit_share,
    (s.status = 'completed' or (s.source = 'manual' and s.status is null)) as realized,
    iw.weight        as weight
  from app.inventory_item i
  join app.sale_line_share sls on sls.household_id = i.household_id and sls.inventory_item_id = i.id
  join app.sale s              on s.household_id   = sls.household_id and s.id = sls.sale_id
  join item_weight iw          on iw.id = i.id
  where i.model_code is not null
),
agg as (
  -- avg_price / avg_profit は Σ(売上・粗利の按分) ÷ Σ(重み)。件数（purchased / sold 等）は
  -- 従来どおり「点」で数える（このビューの下の select を参照）
  select
    household_id,
    model_code,
    sum(case when realized then price_share else 0 end)
      / nullif(sum(case when realized then weight else 0 end), 0) as avg_price,
    sum(case when realized then profit_share else 0 end)
      / nullif(sum(case when realized then weight else 0 end), 0) as avg_profit,
    sum(case when realized then profit_share else 0 end) as total_profit,
    sum(case when realized then 0 else profit_share end) as forecast_profit
  from linked
  group by household_id, model_code
  having sum(weight) > 0
),
base as (
  select distinct household_id, model_code
  from app.inventory_item
  where model_code is not null
)
select
  base.model_code,
  -- 同じ型番で最新の在庫の値。取得日・作成日時（SQLite は秒精度で、分割の子は同着になる）が
  -- 同じ在庫が並んだときだけ、在庫コードの新しい方（S-0012 より S-0013。桁数 → 文字列の順で数の大小になる）。
  -- SQLite は同着のとき並びが決まらなかった。決まらない並びを Postgres では毎回同じにするための取り決め
  (select i2.series_code from app.inventory_item i2
     where i2.household_id = base.household_id and i2.model_code = base.model_code
     order by i2.acquired_at desc, i2.created_at desc, length(i2.item_code) desc, i2.item_code desc limit 1) as series_code,
  (select i2.material from app.inventory_item i2
     where i2.household_id = base.household_id and i2.model_code = base.model_code
     order by i2.acquired_at desc, i2.created_at desc, length(i2.item_code) desc, i2.item_code desc limit 1) as material,
  coalesce(
    (select pn.name from app.product_name pn
      where pn.household_id = base.household_id and pn.model_code = base.model_code),
    (select i2.name from app.inventory_item i2
       where i2.household_id = base.household_id and i2.model_code = base.model_code
       order by i2.acquired_at desc, i2.created_at desc, length(i2.item_code) desc, i2.item_code desc limit 1)
  ) as name,
  (select pn.name from app.product_name pn
    where pn.household_id = base.household_id and pn.model_code = base.model_code) as custom_name,
  (select pn.note from app.product_name pn
    where pn.household_id = base.household_id and pn.model_code = base.model_code) as note,
  (select count(*) from app.inventory_item i2
     where i2.household_id = base.household_id and i2.model_code = base.model_code
       and i2.status != 'split')::integer as purchased,
  (select count(*) from app.inventory_item i2
     where i2.household_id = base.household_id and i2.model_code = base.model_code
       and i2.status = 'sold')::integer as sold,
  (select count(*) from app.inventory_item i2
     where i2.household_id = base.household_id and i2.model_code = base.model_code
       and i2.status = 'in_stock')::integer as in_stock,
  (select coalesce(sum(i2.landed_cost), 0) from app.inventory_item i2
     where i2.household_id = base.household_id and i2.model_code = base.model_code
       and i2.status = 'in_stock')::integer as stock_value,
  (sign(agg.avg_price)  * floor(abs(agg.avg_price)  + 0.5))::integer as avg_price,
  (sign(agg.avg_profit) * floor(abs(agg.avg_profit) + 0.5))::integer as avg_profit,
  coalesce(agg.total_profit, 0)::integer    as total_profit,
  coalesce(agg.forecast_profit, 0)::integer as forecast_profit,
  base.household_id
from base
left join agg on agg.household_id = base.household_id and agg.model_code = base.model_code;

-- ------------------------------------------------------------
-- 権限：soroban_api に select だけ。anon / authenticated / PUBLIC には出さない。
-- ビューは書けない（既定の権限で付く insert / update / delete も外す）
-- ------------------------------------------------------------
revoke all on app.sale_profit, app.monthly_summary, app.inventory_view,
              app.sale_line_share, app.variant_summary
  from public, anon, authenticated, soroban_api;
grant select on app.sale_profit, app.monthly_summary, app.inventory_view,
                app.sale_line_share, app.variant_summary
  to soroban_api;
