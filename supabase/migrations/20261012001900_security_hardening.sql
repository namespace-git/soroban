-- ============================================================
-- そろばん Web 版 — セキュリティ・レビューの指摘への対応（DB 側）
--
-- 既存のマイグレーション（0100〜1530）は書き換えず、ここで上書きする。
--
-- 1. 取り込み担当の鍵（agent_device）
--      * app.agent_of_token … 鍵を作った人が「いまも」その世帯のメンバーのときだけ引ける
--        （registered_by が null なら引けない）。last_seen_at は 1 分より古いときだけ書く
--      * メンバーから外した人が登録した PC は、トリガーで取り消す（revoked_at）
--      * app.register_agent_device … 鍵が生きている同じ名前の行を上書きできるのは同じ人だけ（SB008）。
--        取り消されていない PC は世帯ごとに 10 台まで（SB009）。鍵の期限の上限は 24 時間 → 3 時間
--        （API は 2 時間で出す。server/agent/key.ts）。鍵を出す人が分からないときは断る（22023）
-- 2. API と定期実行の接続ロール soroban_gateway（ログイン専用。パスワードと LOGIN は利用者が付ける）
-- 3. Storage のバケットに大きさと種類の制限
-- 4. 最小権限
--      * soroban_api から household / household_member の insert / update / delete を外す
--      * household_member の member_self_lookup と agent_device の agent_token_lookup_* は、
--        使うロール（この関数たちの持ち主）だけに TO を付ける
--      * household_of_user / agent_of_token の EXECUTE は soroban_gateway だけ
--      * soroban_cron から setting_secret を外す（17TRACK のキーは世帯の文脈の中で読む）
-- 5. 同じ画像を 2 つの経費・型番に結ばない（部分ユニーク索引）
--
-- 呼び出し側が見分けるための SQLSTATE（1500 の SB006・SB007 の続き）
--   SB008  同じ名前の PC が、ほかの人のログインで使われている（register_agent_device）
--   SB009  取り込み担当の PC が多すぎる（register_agent_device）
-- ============================================================

-- ------------------------------------------------------------
-- 1. ゲートウェイのロール
--
-- Hyperdrive と移行の道具が DB に「ログイン」するためのロール。これまでは全テーブルの持ち主（postgres）で
-- つないでいて、`set role soroban_api` を忘れたコードは全世帯の行を読めた。これからは、忘れたコードは
-- 権限エラーで止まる。
--
--   * NOLOGIN で作る。パスワードと LOGIN は利用者が Supabase の SQL Editor で付ける（docs/web/01-setup.md）。
--     マイグレーションに秘密を書かない。ここで nologin を再び当てないのは、流し直しで利用者の LOGIN を消さないため
--   * NOINHERIT NOBYPASSRLS。soroban_api・soroban_cron のメンバー（`set role` できる）だが、権限は引き継がない。
--     メンバーにする前に NOINHERIT にしておく（PG16 以降はメンバーにした時点の値で決まる）
--   * 直接持つ権限は、set role の前に呼ぶ app.household_of_user・app.agent_of_token の EXECUTE と、app の USAGE だけ
-- ------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'soroban_gateway') then
    create role soroban_gateway nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  else
    alter role soroban_gateway noinherit;
  end if;
end
$$;

grant soroban_api  to soroban_gateway;
grant soroban_cron to soroban_gateway;

-- 管理画面（postgres）から `set role soroban_gateway` で権限を確かめられるように（0100 の soroban_api と同じ）
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres')
     and not exists (
       select 1
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles u on u.oid = m.member
        where r.rolname = 'soroban_gateway' and u.rolname = 'postgres'
     )
  then
    grant soroban_gateway to postgres;
  end if;
end
$$;

grant usage on schema app to soroban_gateway;

-- ------------------------------------------------------------
-- 2. 取り込み担当の鍵を引く（app.agent_of_token）
--
-- 0100 の household_of_user と同じ作り。接続したロールが force row level security で読めない環境でも引けるよう、
-- 中だけ方針に合う値（app.agent_token_hash・app.user_id）を渡し、終わったら呼んだ側の値に戻す。
--
--   * 鍵を作った人（registered_by）が、いまもその世帯の household_member にいるときだけ引ける。
--     人の権限が無くなった後も鍵が効き続けないための検査（registered_by が null＝アカウントを消された、も引けない）
--   * last_seen_at を書くのは 1 分より古いときだけ（形だけ正しい鍵を送られるたびに UPDATE が走らないように）
-- ------------------------------------------------------------

create or replace function app.agent_of_token(p_token_hash text)
returns table (agent_id uuid, household_id uuid)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_prev_hash text := current_setting('app.agent_token_hash', true);
  v_prev_user text := current_setting('app.user_id', true);
  v_id        uuid;
  v_household uuid;
  v_by        uuid;
  v_seen      timestamptz;
  v_member    boolean := false;
begin
  if p_token_hash is null or p_token_hash = '' then
    return;
  end if;

  perform set_config('app.agent_token_hash', p_token_hash, true);

  select d.id, d.household_id, d.registered_by, d.last_seen_at
    into v_id, v_household, v_by, v_seen
    from app.agent_device d
   where d.token_hash = p_token_hash
     and d.revoked_at is null
     and d.token_expires_at > clock_timestamp();

  if v_id is not null and v_by is not null then
    -- 鍵を作った人が、いまもこの世帯のメンバーか（member_self_lookup を通して自分の行を探す）
    perform set_config('app.user_id', v_by::text, true);
    select exists (
      select 1 from app.household_member m where m.household_id = v_household and m.user_id = v_by
    ) into v_member;
    perform set_config('app.user_id', coalesce(v_prev_user, ''), true);

    if v_member and v_seen < clock_timestamp() - interval '1 minute' then
      update app.agent_device d
         set last_seen_at = clock_timestamp()
       where d.id = v_id;
    end if;
  end if;

  perform set_config('app.agent_token_hash', coalesce(v_prev_hash, ''), true);

  if not v_member then
    return;
  end if;
  agent_id := v_id;
  household_id := v_household;
  return next;
end
$$;

-- API が `set role` の前、ゲートウェイの接続で呼ぶ。soroban_api はもう呼べない
revoke all on function app.agent_of_token(text) from public, soroban_api;
grant execute on function app.agent_of_token(text) to soroban_gateway;

-- household_of_user も同じ（0700 では soroban_api に出していた）。app.my_household()（storage の方針）は
-- security definer なので、持ち主の権限でこの関数を呼べる
revoke all on function app.household_of_user(uuid) from public, soroban_api;
grant execute on function app.household_of_user(uuid) to soroban_gateway;

-- ------------------------------------------------------------
-- 3. 鍵を出す（app.register_agent_device）
--
-- 1500 から変えたところ：
--   * 鍵を出す人（app.user_id）が分からなければ断る（registered_by が null の鍵は、2 で引けない）
--   * 鍵が生きている（取り消されておらず、期限が来ていない）同じ名前の行を上書きできるのは、鍵を作った人だけ（SB008）。
--     期限が切れていれば、同じ世帯の誰でも取り直せる（ログアウトで期限を今にするので、続けて別の人が入れる）
--   * 取り消されていない PC は世帯ごとに 10 台まで（SB009）。名前が同じ取り直しは台数を増やさないので数えない
--   * 期限の上限は 24 時間 → 3 時間（API は 2 時間で出す）
--   * 同じ世帯の登録は advisory lock で 1 列に並べる（台数の上限を同時に超えない）。
--     以前の on conflict の更新は、select → update / insert に替えた
-- ------------------------------------------------------------

create or replace function app.register_agent_device(p_name text, p_token_hash text, p_expires_at timestamptz)
returns app.agent_device
language plpgsql
set search_path = ''
as $$
declare
  c_max_devices constant integer := 10;
  v_name      text := btrim(p_name);
  v_user      uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_household uuid := nullif(current_setting('app.household_id', true), '')::uuid;
  v_cur       app.agent_device;
  v_dev       app.agent_device;
begin
  if v_name is null or v_name = '' then
    raise exception '端末の名前を入れてください' using errcode = '22023';
  end if;
  if char_length(v_name) > 200 then
    raise exception '端末の名前は 200 文字までです' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception '鍵のハッシュは SHA-256 の 16 進（小文字 64 文字）で渡してください' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '3 hours' then
    raise exception '鍵の期限は、いまから 3 時間以内にしてください' using errcode = '22023';
  end if;
  if v_user is null then
    raise exception '取り込み担当の鍵を出す人（ログインしている人）が分かりません' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('soroban:agent_device:' || coalesce(v_household::text, ''), 0));

  select * into v_cur from app.agent_device d where d.name = v_name;

  if found then
    if v_cur.revoked_at is not null then
      raise exception 'この PC は取り消されているので、取り込み担当の鍵を出せません' using errcode = 'SB006';
    end if;
    if v_cur.token_expires_at > clock_timestamp()
       and v_cur.registered_by is not null
       and v_cur.registered_by is distinct from v_user then
      raise exception 'この名前の PC は、ほかの人のログインで使われています。名前を変えるか、その人がログアウトするか、設定の「取り込み担当の PC」から外してください'
        using errcode = 'SB008';
    end if;

    update app.agent_device d
       set token_hash = p_token_hash,
           token_expires_at = p_expires_at,
           last_seen_at = now(),
           registered_by = v_user
     where d.id = v_cur.id
    returning * into v_dev;
  else
    if (select count(*) from app.agent_device d where d.revoked_at is null) >= c_max_devices then
      raise exception '取り込み担当の PC が多すぎます（10 台まで）。使っていない PC を、設定の「取り込み担当の PC」から外してください'
        using errcode = 'SB009';
    end if;

    insert into app.agent_device (name, token_hash, token_expires_at, registered_by)
    values (v_name, p_token_hash, p_expires_at, v_user)
    returning * into v_dev;
  end if;

  return v_dev;
end
$$;

-- ------------------------------------------------------------
-- 4. メンバーから外した人の PC を取り消す
--
-- household_member の行が消えたら（世帯から外した・アカウントを消してメンバーが cascade で消えた）、その人が
-- 登録した PC を取り消す。2 の検査でも鍵は引けなくなるが、設定の一覧にも「取り消し済み」と出し、
-- 同じ名前での取り直し（register）も断る。revoked_at は最初の時刻を残す。
--
-- security definer：メンバーを外すのは管理画面（postgres）だが、持ち主が BYPASSRLS を持たなくても動くよう、
-- create_household と同じく中だけ app.household_id をその世帯にして、終わったら呼んだ側の値に戻す
-- ------------------------------------------------------------

create function app.revoke_agents_of_removed_member()
returns trigger
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_prev_hh text := current_setting('app.household_id', true);
begin
  perform set_config('app.household_id', old.household_id::text, true);

  update app.agent_device d
     set revoked_at = coalesce(d.revoked_at, now())
   where d.household_id = old.household_id
     and d.registered_by = old.user_id;

  perform set_config('app.household_id', coalesce(v_prev_hh, ''), true);
  return old;
end
$$;

revoke all on function app.revoke_agents_of_removed_member() from public, soroban_api;

create trigger trg_household_member_revoke_agents
  after delete on app.household_member
  for each row execute function app.revoke_agents_of_removed_member();

-- ------------------------------------------------------------
-- 5. 最小権限
-- ------------------------------------------------------------

-- 世帯を作る・メンバーを入れる・外すのは、管理画面（app.create_household と SQL Editor）だけ。API は読むだけ
revoke insert, update, delete on app.household, app.household_member from soroban_api;

-- 「自分自身の行」「鍵のハッシュ」から引くための方針は、引く側（上の security definer の関数の持ち主）だけに効かせる。
-- soroban_api には効かない（API の接続からは、自分の世帯の行以外を、この方針で探せない）。
-- 持ち主＝このマイグレーションを流したロール（Supabase では postgres）
do $$
declare
  v_owner name := current_user;
begin
  drop policy member_self_lookup on app.household_member;
  execute format(
    $f$create policy member_self_lookup on app.household_member
         for select to %I
         using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)$f$,
    v_owner
  );

  drop policy agent_token_lookup_select on app.agent_device;
  execute format(
    $f$create policy agent_token_lookup_select on app.agent_device
         for select to %I
         using (token_hash = nullif(current_setting('app.agent_token_hash', true), ''))$f$,
    v_owner
  );

  drop policy agent_token_lookup_update on app.agent_device;
  execute format(
    $f$create policy agent_token_lookup_update on app.agent_device
         for update to %I
         using (token_hash = nullif(current_setting('app.agent_token_hash', true), ''))
         with check (token_hash = nullif(current_setting('app.agent_token_hash', true), ''))$f$,
    v_owner
  );
end
$$;

-- 定期実行は暗号文を読まない。17TRACK のキーは世帯の文脈（soroban_api）の中で読む（server/cron/tracking.ts）
drop policy cron_read on app.setting_secret;
revoke all on app.setting_secret from soroban_cron;

-- ------------------------------------------------------------
-- 6. Storage のバケット：大きさと種類の制限
--
-- media は商品・販売・出品の写真（Web は縮めた JPEG、PC はメルカリなどのサムネイル）、receipts はレシート。
-- どちらも画像だけ。置き場は Supabase の管理（storage.buckets）なので、update で足す
-- ------------------------------------------------------------

update storage.buckets
   set file_size_limit = 5 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
 where id = 'media';

update storage.buckets
   set file_size_limit = 10 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
 where id = 'receipts';

-- ------------------------------------------------------------
-- 7. 同じ画像を 2 つの経費・型番に結ばない
--
-- 1 つのファイルを 2 つが指すと、片方を外したときにもう片方の画像が消える。いまはアプリの検査だけだったので、
-- 同時に 2 つ結ばれても通ってしまう。DB でも止める。
--   * レシート … 経費ごとに 1 ファイル（receipt_path が null の行は数えない）
--   * 商品画像 … 人が上げた画像（<世帯>/product/…）だけ。「自動を固定する」は仕入先・出品・販売の画像と同じパスを
--     指す（server/domain/product.ts の setProductImageAuto）ので、そちらは複数の型番が同じパスを持ってよい
-- ------------------------------------------------------------

create unique index expense_receipt_path_unique
  on app.expense (household_id, receipt_path)
  where receipt_path is not null;

create unique index product_image_product_path_unique
  on app.product_image (household_id, path)
  where starts_with(path, household_id::text || '/product/');
