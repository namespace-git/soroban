-- ============================================================
-- そろばん Web 版 — 土台（スキーマ・ロール・世帯）
--
-- 設計：docs/web/00-architecture.md
--
-- * データはすべてスキーマ app に置く。PostgREST（Supabase の自動 API）は app を公開しない
--   ので、画面から直接は読めない。必ず API（Pages Functions）を通る
-- * API が DB につなぐときは、接続したロールから `set role soroban_api` する。soroban_api は
--   BYPASSRLS を持たないので、全テーブルの RLS（行レベルセキュリティ）が効く
-- * 世帯（household）は API が 1 リクエストごとに
--     select set_config('app.household_id', '<世帯の id>', true);
--   で渡す。各テーブルの household_id の既定値と RLS がこの値を見る
-- ============================================================

create schema if not exists app;

-- ------------------------------------------------------------
-- ロール
-- ------------------------------------------------------------

-- API が `set role` する先。ログインはできない（接続は別のロールで行い、そこから切り替える）。
-- BYPASSRLS を持たせないのが肝（持たせると RLS が素通りになる）。
-- すでにあっても属性を揃え直す（冪等）
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'soroban_api') then
    create role soroban_api nologin;
  end if;
end
$$;

-- 危ない属性が付いていないことを確かめる（付け直しはしない：Supabase の postgres は superuser ではないので、
-- `alter role … nosuperuser` のように属性を指定しただけで断られる。作ったばかりのロールは既定で全部「無し」）
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'soroban_api'
               and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolcanlogin)) then
    raise exception 'soroban_api に想定外の属性があります（superuser / bypassrls / createrole / createdb / login）。外してから流し直してください';
  end if;
end
$$;

-- 接続するロール（Supabase の接続文字列は postgres）が `set role soroban_api` できるようにする
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres')
     and not exists (
       select 1
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles u on u.oid = m.member
        where r.rolname = 'soroban_api' and u.rolname = 'postgres'
     )
  then
    grant soroban_api to postgres;
  end if;
end
$$;

-- ------------------------------------------------------------
-- 権限
-- ------------------------------------------------------------

-- Supabase の anon / authenticated（ブラウザから PostgREST を叩くときのロール）には
-- app の何も許可しない
revoke all on schema app from public;
revoke all on schema app from anon, authenticated;
grant usage on schema app to soroban_api;

-- これ以降に app へ作る表・関数は、soroban_api が使える（表は DML、関数は EXECUTE）。
-- 関数の EXECUTE は PUBLIC にも既定で付くので、関数ごとに revoke ... from public を書くこと
alter default privileges in schema app
  grant select, insert, update, delete on tables to soroban_api;
alter default privileges in schema app
  grant usage, select on sequences to soroban_api;
alter default privileges in schema app
  grant execute on functions to soroban_api;

-- ------------------------------------------------------------
-- RLS を張る補助関数（表ごとに 1 行 `select app.enable_household_rls('app.xxx')` で済ませる）
--
-- 世帯をまたいで見えないことは、クエリが where household_id = ? を書き忘れても
-- 守られる。using は見える行、with check は書ける行。
--
-- force row level security：表の持ち主は RLS を受けない（既定）。持ち主にも RLS を効かせる。
-- soroban_api は表の持ち主にしない（DML の grant だけ）ので、持ち主になる経路は無いが、
-- 持ち主のロールで繋いだときの取りこぼしも塞ぐ。BYPASSRLS のロール・スーパーユーザーは
-- それでも素通りする（Supabase の postgres は BYPASSRLS）
--
-- 方針の式は nullif(current_setting(…, true), '')：set_config(…, true) を一度使った接続は、
-- トランザクションが終わったあとも設定が空文字として残る（NULL に戻らない）。空文字のまま
-- ::uuid に通すと構文エラーで落ちて、プールされた接続で世帯を渡し忘れたときの挙動が不安定になる。
-- 空文字は NULL として扱い、どの行にも一致させない
-- ------------------------------------------------------------

create function app.enable_household_rls(p_table regclass)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format(
    $f$create policy household_isolation on %s
         using (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
         with check (household_id = nullif(current_setting('app.household_id', true), '')::uuid)$f$,
    p_table
  );
end
$$;

-- マイグレーションを流す人（表の持ち主）専用。API からは呼ばせない
revoke all on function app.enable_household_rls(regclass) from public;
revoke all on function app.enable_household_rls(regclass) from soroban_api;

-- ------------------------------------------------------------
-- 世帯とメンバー
-- ------------------------------------------------------------

create table app.household (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- 世帯に属する人。Supabase Auth のユーザー（auth.users）と世帯を結ぶ。
-- API は JWT のユーザー ID でここを引いて、世帯のメンバーでなければ 403 にする
create table app.household_member (
  household_id uuid not null references app.household (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- 「この人はどの世帯か」を user_id で引く
create index household_member_user_id on app.household_member (user_id);

-- household / household_member の RLS は、他の表と違って household_id の既定値を持たない
-- （household は id が世帯そのもの）。
--
-- 「この JWT のユーザーはどの世帯か」の照会は、世帯が決まる前（app.household_id がまだ無い）に
-- 行う。接続したロールのまま引く（Supabase の postgres は BYPASSRLS なので素通りできる）か、
-- app.user_id だけを渡して soroban_api で引く。後者のために、household_member には
-- 「自分自身の行だけ読める」方針を足してある（member_self_lookup。読み取りのみ）。
-- soroban_api で動いている間は、自分の世帯の行しか書けない・見えない
alter table app.household enable row level security;
alter table app.household force row level security;
create policy household_isolation on app.household
  using (id = nullif(current_setting('app.household_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.household_id', true), '')::uuid);

alter table app.household_member enable row level security;
alter table app.household_member force row level security;
create policy household_isolation on app.household_member
  using (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  with check (household_id = nullif(current_setting('app.household_id', true), '')::uuid);
create policy member_self_lookup on app.household_member
  for select
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- app スキーマの中身を作るのは、このマイグレーションを流したロール（postgres）。soroban_api は
-- 何も所有しない。念のため、PUBLIC・anon・authenticated に残っている既定の権限を外す
revoke all on all tables    in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
