-- ============================================================
-- そろばん Web 版 — 定期実行（Cron の Worker）の役割と、17TRACK のキュー・秘密の値の版
--
-- 設計：docs/web/03-agent-and-push.md の 3 節・5 節（Codex レビューの指摘 5・6・8）
--
-- Pages Functions には定期実行が無い。小さな Worker を 1 本足し、5 分ごとに次を行う：
--   1. 通知の送信（claim_deliveries → Web Push → complete_delivery）
--   2. 17TRACK：キューに積まれた仕入を 40 件以下のバッチで確認（register_pending → registered）
--   3. 期限切れの取り込み要求の片付け（reap_stale_collect_jobs）
-- この Worker は世帯をまたいで巡回する。そのためだけの専用ロール soroban_cron を用意し、
-- 「世帯をまたいで読む必要がある表」にだけ、列を絞った最小の権限と to soroban_cron の方針を付ける。
--
--   soroban_cron に出すもの（これ以外の表・列には何も出さない）
--     notification_event / notification_delivery / push_subscription  読み・配送の状態の更新・購読の削除
--     collect_job            読み（lease_token は除く）・片付け（status / finished_at / result の更新）
--     purchase               追跡の列だけ読み（世帯をまたぐ）・追跡の列だけ書き（世帯の文脈の中）
--     purchase_line          点数（quantity）だけ読み（世帯の文脈の中。到着の通知に点数を入れる）
--     setting_secret         読み（暗号文。復号の鍵は Worker の環境変数）
--     tracking_lease         17TRACK の世帯ごとの lease
--   販売・在庫・仕入の金額の列（sale・inventory_item・purchase の送料、purchase_line の単価 …）は読めない
--
-- 世帯をまたいで書けるのは、配送の状態・購読・取り込み要求の片付けだけ。仕入の追跡の列などは、
-- 世帯をまたいで「読める」が、書くときは app.household_id を渡した世帯の中だけ（household_isolation）
-- ============================================================

-- ------------------------------------------------------------
-- ロール
-- ------------------------------------------------------------

-- ログインはできない。接続は別のロール（Hyperdrive の接続文字列の postgres）で行い、そこから
-- `set role soroban_cron` する。BYPASSRLS を持たせず、何も所有しない（soroban_api と同じ）
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'soroban_cron') then
    create role soroban_cron nologin;
  end if;
end
$$;

-- 危ない属性が付いていないことを確かめる（付け直しはしない。理由は 0100 の soroban_api と同じ）
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'soroban_cron'
               and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolcanlogin)) then
    raise exception 'soroban_cron に想定外の属性があります（superuser / bypassrls / createrole / createdb / login）。外してから流し直してください';
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres')
     and not exists (
       select 1
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles u on u.oid = m.member
        where r.rolname = 'soroban_cron' and u.rolname = 'postgres'
     )
  then
    grant soroban_cron to postgres;
  end if;
end
$$;

grant usage on schema app to soroban_cron;

-- ------------------------------------------------------------
-- 17TRACK のキュー（仕入の列）
--
--   tracking_queued_at           確認する番が来た印。「配送状況を確認」や取り込みの終わりが積む。
--                                Cron が結果を書いたら NULL に戻す。実際に 17TRACK に聞くのは Cron だけ
--   tracking_register_pending_at register を送る直前に書く。成功したら tracking_registered_at を書いて
--                                NULL に戻す（check で両方は持てない）。
--                                pending のまま残っていたら「送ったか不明」なので、まず gettrackinfo で
--                                照会してから送り直す（register は無料枠を消費するので二重に送らない）
-- ------------------------------------------------------------

alter table app.purchase
  add column tracking_queued_at           timestamptz,
  add column tracking_register_pending_at timestamptz,
  add constraint purchase_tracking_register_state
    check (tracking_register_pending_at is null or tracking_registered_at is null);

-- Cron が世帯をまたいで「確認する番が来たもの」を引く
create index purchase_tracking_queue
  on app.purchase (tracking_queued_at)
  where tracking_queued_at is not null;

-- 17TRACK の世帯ごとの lease。秒間 3 リクエスト（API キーごと）を守るため、同じ世帯を同時に
-- 2 本走らせない。Worker は世帯の文脈（app.household_id）を渡して取る・返す
create table app.tracking_lease (
  household_id     uuid primary key default (current_setting('app.household_id')::uuid)
                   references app.household (id) on delete cascade,
  lease_token      uuid not null,
  lease_expires_at timestamptz not null
);

select app.enable_household_rls('app.tracking_lease');

-- 世帯（app.household_id）の 17TRACK の lease を取る。取れたら lease_token、取れなかった
-- （ほかの Worker が期限内に持っている）ら null。期限が切れていれば取り直せる（前の持ち主が落ちた）
create function app.acquire_tracking_lease(p_lease interval default '2 minutes')
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_token uuid;
begin
  if p_lease is null or p_lease <= interval '0 seconds' then
    raise exception 'lease は正の長さにしてください' using errcode = '22023';
  end if;

  insert into app.tracking_lease (lease_token, lease_expires_at)
  values (gen_random_uuid(), now() + p_lease)
  on conflict (household_id) do update
     set lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at
   where app.tracking_lease.lease_expires_at <= clock_timestamp()
  returning lease_token into v_token;

  return v_token;
end
$$;

-- lease を返す。持ち主（token が合う）なら true。期限が切れて別の Worker に取られていたら false
-- （何もしない）
create function app.release_tracking_lease(p_lease_token uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  delete from app.tracking_lease where lease_token = p_lease_token;
  return found;
end
$$;

-- ------------------------------------------------------------
-- 秘密の値：版と方式
--
-- 暗号そのものはサーバー側（SECRET_KEYS = 版:鍵 のカンマ区切り。先頭が今の鍵）。スキーマは版と方式を
-- 持つだけ。AAD に household_id ＋ 設定のキー ＋ key_version を入れる。
-- 既存の行（あれば）は版 1 とみなす。以後は書くたびに版を明示する（既定値は置かない）
-- ------------------------------------------------------------

alter table app.setting_secret
  add column key_version integer not null default 1 check (key_version >= 1),
  add column alg         text    not null default 'aes-256-gcm' check (alg in ('aes-256-gcm'));

alter table app.setting_secret alter column key_version drop default;

-- ------------------------------------------------------------
-- soroban_cron の権限
--
-- 表の権限は列まで絞る（select * は通らない）。方針は to soroban_cron のものだけ「世帯をまたいで」
-- 効く。ほかの表には方針も権限も付けない
-- ------------------------------------------------------------

-- 通知：出来事は読む。配送は読み・状態の更新（household_id などは書き換えられない）。
-- 出来事と配送を積むのは世帯の文脈の中（household_isolation）。購読は読み・last_used_at の更新・削除
grant select, insert on app.notification_event to soroban_cron;
create policy cron_read on app.notification_event for select to soroban_cron using (true);

grant select, insert on app.notification_delivery to soroban_cron;
grant update (status, attempts, next_attempt_at, claimed_at, last_error, sent_at)
  on app.notification_delivery to soroban_cron;
create policy cron_read   on app.notification_delivery for select to soroban_cron using (true);
create policy cron_update on app.notification_delivery for update to soroban_cron using (true) with check (true);

grant select (id, household_id, user_id, endpoint, p256dh, auth, label,
              kind_sale, kind_shipping, kind_collect, kind_arrival, last_used_at)
  on app.push_subscription to soroban_cron;
grant update (last_used_at) on app.push_subscription to soroban_cron;
grant delete on app.push_subscription to soroban_cron;
create policy cron_read   on app.push_subscription for select to soroban_cron using (true);
create policy cron_update on app.push_subscription for update to soroban_cron using (true) with check (true);
create policy cron_delete on app.push_subscription for delete to soroban_cron using (true);

-- 取り込み要求：期限切れの片付け（reap_stale_collect_jobs）。lease_token は読めない
grant select (id, household_id, requested_by, requested_at, status, agent_id, agent_device_id,
              claimed_at, heartbeat_at, finished_at, result, lease_expires_at)
  on app.collect_job to soroban_cron;
grant update (status, finished_at, result) on app.collect_job to soroban_cron;
create policy cron_read   on app.collect_job for select to soroban_cron using (true);
create policy cron_update on app.collect_job for update to soroban_cron using (true) with check (true);

-- 仕入：追跡の列だけ。読みは世帯をまたぐ（確認する番が来たものを探す）。書きは世帯の文脈の中だけ
-- （読みの方針しか付けないので、更新は household_isolation を通る）
grant select (id, household_id, fulfillment, fulfillment_updated_at, shipped_at, delivered_at,
              tracking_carrier, tracking_number, tracking_status, tracking_checked_at,
              tracking_registered_at, tracking_register_pending_at, tracking_queued_at)
  on app.purchase to soroban_cron;
grant update (fulfillment, fulfillment_updated_at, shipped_at, delivered_at,
              tracking_status, tracking_checked_at, tracking_registered_at,
              tracking_register_pending_at, tracking_queued_at, updated_at)
  on app.purchase to soroban_cron;
create policy cron_read on app.purchase for select to soroban_cron using (true);

-- 仕入の明細：点数だけ（到着の通知に「3 点」と入れる）。方針は付けない＝世帯の文脈の中だけ。
-- 単価・按分後の原価は読めない
grant select (household_id, purchase_id, quantity) on app.purchase_line to soroban_cron;

-- 秘密の値：暗号文を読む（復号の鍵は Worker の環境変数。DB には無い）。書けない
grant select (household_id, key, ciphertext, iv, key_version, alg, updated_at)
  on app.setting_secret to soroban_cron;
create policy cron_read on app.setting_secret for select to soroban_cron using (true);

-- 17TRACK の lease：世帯の文脈の中で取る・返す
grant select, insert, update, delete on app.tracking_lease to soroban_cron;

-- 関数
revoke all on all functions in schema app from public, anon, authenticated;
revoke all on all tables    in schema app from public, anon, authenticated;

grant execute on function app.acquire_tracking_lease(interval)                           to soroban_api, soroban_cron;
grant execute on function app.release_tracking_lease(uuid)                               to soroban_api, soroban_cron;
grant execute on function app.reap_stale_collect_jobs(interval)                          to soroban_cron;
grant execute on function app.enqueue_notification(text, text, text, text, text, uuid)   to soroban_cron;
grant execute on function app.claim_deliveries(integer, interval)                        to soroban_cron;
grant execute on function app.complete_delivery(uuid, boolean, text, boolean)            to soroban_cron;

-- 取りこぼし防止：app の全テーブルが force RLS（0400 と同じ確認）
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
