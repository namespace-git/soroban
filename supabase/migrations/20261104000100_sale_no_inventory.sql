-- ============================================================
-- そろばん Web 版 — 販売を「在庫なしで確定」にする印（sale.no_inventory）
--
-- 売れて売上は入ったが、相手が受け取りを拒否して商品だけ戻ってきた販売など、紐付ける在庫が無い販売がある。
-- いまは未紐付けと区別がつかず、要対応に出続ける。
--
--   * sale.no_inventory = 1 の販売は、紐付けた在庫 0 点・原価 ¥0 のまま「紐付け済み」として数える
--     （sale_profit.unmatched = 0）。要対応・未紐付けの絞り込み・自動紐付け・月次の未紐付け件数は、
--     どれも sale_profit.unmatched を見ているので、ビューを直せば揃って動く
--   * 在庫を紐付けると 0 に戻る（アプリ側：linkInventory・takeOverListing）。付け外しは setSaleNoInventory
--   * 列を足すだけ（既定 0・not null）。この印を知らない Worker が動いていても壊れない
--     （insert は列を指定しないので既定の 0 が入る。select は列名を指定している）
--
-- sale_profit は create or replace で作り直す（依存する monthly_summary・sale_line_share・variant_summary は
-- そのまま。列の順は変えず、新しい列を最後＝household_id の後ろに足す）。with (security_invoker = true) と
-- soroban_api への select だけの権限（0600）は、create or replace で変わらない。
-- 表の権限は alter default privileges（0100）で表単位に付いており、列単位の grant は無いので、
-- 新しい列にも自動で同じ権限が及ぶ。RLS の方針も行単位（household_id）なので列を足しても変わらない。
-- ============================================================

alter table app.sale
  add column no_inventory integer not null default 0 check (no_inventory in (0, 1));

create or replace view app.sale_profit
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
  -- no_inventory = 1（在庫なしで確定）は、紐付けた在庫が 0 点でも紐付け済み。
  -- そうでなければ、紐付けが 0 点か、expected_item_count（見積もった点数）が分かっていて
  -- まだそこに届いていなければ、揃うまでは unmatched のまま（在庫コード・型番の個数表記が一部しか見つからなかった場合）
  case
    when s.no_inventory = 1 then 0
    when count(sl.id) = 0 then 1
    when s.expected_item_count is not null and count(sl.id) < s.expected_item_count then 1
    else 0
  end as unmatched,
  -- 1 なら紐付けのどれかが型番の自動確定
  coalesce(max(case when sl.link_source = 'auto' then 1 else 0 end), 0) as auto_linked,
  s.household_id,
  -- 1 なら「在庫なしで確定」。create or replace の都合で、新しい列は最後に置く
  s.no_inventory
from app.sale s
left join app.sale_line      sl on sl.household_id = s.household_id and sl.sale_id = s.id
left join app.inventory_item i  on i.household_id  = sl.household_id and i.id = sl.inventory_item_id
group by s.id;
