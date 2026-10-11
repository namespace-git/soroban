-- ============================================================
-- そろばん Web 版 — 世帯の作成・世帯の照会・取り込み要求の詰まり
--
-- 1. app.create_household     世帯を作り、持ち主を入れ、世帯ごとの初期データ（発送方法・設定）を入れる
-- 2. app.household_of_user    JWT のユーザー id → 世帯 id を引く（API 用）
-- 3. 取り込み要求の詰まりを直す
--      * queued のまま誰も取らない要求は、一定時間（既定 5 分）で cancelled にする（reap に足す）
--      * enqueue / claim の頭で reap を呼ぶ（API が呼び忘れても詰まらない）
--      * 人が queued を取り消せる（app.cancel_collect_job）
--
-- 既存のマイグレーション（0100〜0500）は書き換えず、ここで上書きする。
--
-- 呼び出し側が見分けるための SQLSTATE（0500 の SB001〜SB003 の続き）
--   SB004  取り消せない（始まっている、またはもう終わっている）
--   SB005  取り込みの要求が見つからない（他の世帯の要求もここ。RLS で見えない）
-- ============================================================

-- ------------------------------------------------------------
-- 世帯を作る
--
-- 全テーブルに force row level security が付いているので、SQL Editor から insert app.household …
-- を直接書くと、接続したロール（postgres）に BYPASSRLS が無い環境では失敗する。
-- 関数に閉じ込め、中で app.household_id を新しい世帯にしてから insert する（RLS の with check を
-- 通る）ので、ロールの属性に依存しない。
--
-- 呼び方（管理画面の SQL Editor から。postgres で）
--   select app.create_household('うち', array['<夫の id>', '<妻の id>']::uuid[]);
--
-- API（soroban_api）には渡さない。API から世帯を勝手に作れてはいけない。
--
-- 初期データは、SQLite で新しい DB を作ったときに入るものと同じ（schema.sql の
-- INSERT OR IGNORE INTO setting ＋ db.ts の seedDefaults の発送方法）。
-- schema_version は SQLite の migrate() の印なので、Postgres には持ち込まない
-- ------------------------------------------------------------

create function app.create_household(p_name text, p_owner_user_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_name     text := btrim(p_name);
  v_owners   uuid[];
  v_unknown  uuid[];
  v_id       uuid := gen_random_uuid();
  v_prev_hh  text := current_setting('app.household_id', true);
  -- now() はトランザクションの開始時刻。続けて作った世帯の古い・新しいが同じにならないよう、
  -- 実際の時刻を入れる（household_of_user が「古い方」を選ぶ根拠）
  v_created  timestamptz := clock_timestamp();
begin
  if v_name is null or v_name = '' then
    raise exception '世帯の名前を入れてください' using errcode = '22023';
  end if;
  if p_owner_user_ids is null or cardinality(p_owner_user_ids) = 0 then
    raise exception '世帯の持ち主（ユーザーの id）を 1 人以上指定してください' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_owner_user_ids) as o(user_id) where o.user_id is null) then
    raise exception '持ち主の id に null が混ざっています' using errcode = '22023';
  end if;

  select array_agg(distinct o.user_id) into v_owners from unnest(p_owner_user_ids) as o(user_id);

  select array_agg(o.user_id) into v_unknown
    from unnest(v_owners) as o(user_id)
   where not exists (select 1 from auth.users a where a.id = o.user_id);
  if v_unknown is not null then
    raise exception 'ユーザーが見つかりません（Authentication で先に作ってください）: %',
      array_to_string(v_unknown, ', ')
      using errcode = '22023';
  end if;

  perform set_config('app.household_id', v_id::text, true);

  insert into app.household (id, name, created_at) values (v_id, v_name, v_created);

  insert into app.household_member (household_id, user_id, role, created_at)
  select v_id, o.user_id, 'owner', v_created from unnest(v_owners) as o(user_id);

  -- 発送方法の既定。送料は改定されるので、設定画面から編集できる
  insert into app.shipping_method (name, carrier, fee, sort_order) values
    ('ゆうパケットポストmini', 'ゆうゆうメルカリ便', 180, 1),
    ('ネコポス',               'らくらくメルカリ便', 210, 2),
    ('ゆうパケットポスト',     'ゆうゆうメルカリ便', 215, 3),
    ('ゆうパケット',           'ゆうゆうメルカリ便', 230, 4),
    ('宅急便コンパクト',       'らくらくメルカリ便', 520, 5),
    ('ゆうパケットプラス',     'ゆうゆうメルカリ便', 520, 6),
    ('宅急便 60サイズ',        'らくらくメルカリ便', 750, 7),
    ('送料なし・着払い',       null,                  0, 99);

  -- 設定の既定。item_code_seq は在庫コード（S-0001…）の採番カウンタ
  insert into app.setting (key, value) values
    ('fee_rate_bp',            '1000'),
    ('fee_rate_bp_yahoo',      '500'),
    ('transfer_fee',           '200'),
    ('aging_warn_days',        '90'),
    ('collect_interval_h',     '1'),
    ('mercari_keyword',        ''),
    ('yahoo_keyword',          ''),
    ('auto_release_suspended', '1'),
    ('item_code_seq',          '0');

  -- 呼んだ側のトランザクションに、新しい世帯を残さない
  perform set_config('app.household_id', coalesce(v_prev_hh, ''), true);

  return v_id;
end
$$;

-- 管理画面（postgres）専用。soroban_api には既定の権限で EXECUTE が付くので、明示的に外す
revoke all on function app.create_household(text, uuid[]) from public;
revoke all on function app.create_household(text, uuid[]) from soroban_api;

-- ------------------------------------------------------------
-- ユーザー → 世帯
--
-- API は JWT の sub（ユーザー id）から世帯を引く。世帯が決まる前なので app.household_id は無い。
-- 世帯のメンバーの表は API に直接読ませず、この関数だけを通す。
-- 複数の世帯に属していたら、世帯の作成日が古い方を 1 つ。属していなければ null。
--
-- 関数の持ち主が RLS を素通りできなくても動くよう、中だけ app.user_id を引く相手にして
-- （member_self_lookup）、終わったら呼んだ側の値に戻す。世帯の作成日は RLS で見えない環境では
-- メンバーになった日で代える
-- ------------------------------------------------------------

create function app.household_of_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_prev_user text := current_setting('app.user_id', true);
  v_prev_hh   text := current_setting('app.household_id', true);
  v_household uuid;
begin
  if p_user_id is null then
    return null;
  end if;

  perform set_config('app.user_id', p_user_id::text, true);
  perform set_config('app.household_id', '', true);

  select m.household_id into v_household
    from app.household_member m
    left join app.household h on h.id = m.household_id
   where m.user_id = p_user_id
   order by coalesce(h.created_at, m.created_at), m.created_at, m.household_id
   limit 1;

  perform set_config('app.user_id', coalesce(v_prev_user, ''), true);
  perform set_config('app.household_id', coalesce(v_prev_hh, ''), true);

  return v_household;
end
$$;

revoke all on function app.household_of_user(uuid) from public;
grant execute on function app.household_of_user(uuid) to soroban_api;

-- ------------------------------------------------------------
-- 取り込み要求の詰まりを直す（0500 を上書き）
-- ------------------------------------------------------------

-- 期限切れの要求を片付ける。件数（下の 2 つの合計）を返す。
--   * running で lease_expires_at を過ぎたもの → failed（PC が落ちた。0500 と同じ）
--   * queued のまま p_queued_timeout（既定 5 分）たったもの → cancelled
--     （PC のエージェントが動いていない。始まっていないので claimed_at は NULL のまま＝
--      連続の判定に数えない。残しておくと以後ずっと「取り込み中です」になる）
-- 後から原因が分かるよう result に印を残す。以後、その job の token での書き込みは拒否される。
--
-- 引数を足すので、0500 の reap_stale_collect_jobs() を捨てて作り直す（残すと、引数なしの呼び出しが
-- どちらか決められずに失敗する）。引数は既定値つきなので、これまでの呼び方がそのまま通る
drop function app.reap_stale_collect_jobs();

create function app.reap_stale_collect_jobs(p_queued_timeout interval default '5 minutes')
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_running integer;
  v_queued  integer;
begin
  if p_queued_timeout is null or p_queued_timeout < interval '0 seconds' then
    raise exception 'queued の待ち時間は 0 以上にしてください' using errcode = '22023';
  end if;

  update app.collect_job
     set status = 'failed',
         finished_at = now(),
         result = jsonb_build_object(
           'reaped', true,
           'reason', 'lease_expired',
           'last_heartbeat_at', heartbeat_at,
           'lease_expires_at', lease_expires_at
         )
   where status = 'running' and lease_expires_at < now();
  get diagnostics v_running = row_count;

  update app.collect_job
     set status = 'cancelled',
         finished_at = now(),
         result = jsonb_build_object(
           'reaped', true,
           'reason', 'queued_timeout',
           'requested_at', requested_at
         )
   where status = 'queued' and requested_at < now() - p_queued_timeout;
  get diagnostics v_queued = row_count;

  return v_running + v_queued;
end
$$;

-- 取り込みを要求する。0500 から、頭で reap を呼ぶようにした（取られないまま古くなった要求を
-- 片付けてから「取り込み中か」を見る）。cancelled は始まっていない（claimed_at が NULL）ので
-- 連続の判定には数えない
create or replace function app.enqueue_collect_job(cooldown interval default '10 minutes')
returns app.collect_job
language plpgsql
set search_path = ''
as $$
declare
  v_last       timestamptz;
  v_job        app.collect_job;
  v_user       uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_constraint text;
begin
  perform app.reap_stale_collect_jobs();

  if exists (select 1 from app.collect_job where status in ('queued', 'running')) then
    raise exception '取り込み中です' using errcode = 'SB001';
  end if;

  -- 最後に取り込みを始めた時刻。結果（done / failed / reap されたもの）を問わない。
  -- 一度も取られなかった job（claimed_at が NULL。取り消し・時間切れの cancelled もここ）は
  -- 始まっていないので数えない
  select max(claimed_at) into v_last from app.collect_job;

  if v_last is not null and v_last > now() - cooldown then
    raise exception '前回の取り込みから % 分たっていません',
        ceil(extract(epoch from cooldown) / 60)::integer
      using errcode = 'SB002',
            detail = format('あと %s 秒', ceil(extract(epoch from (v_last + cooldown - now())))::integer);
  end if;

  begin
    insert into app.collect_job (requested_by) values (v_user) returning * into v_job;
  exception
    when unique_violation then
      -- 上の検査を同時に通り抜けた 2 本目。部分ユニーク索引が止める
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'collect_job_one_active' then
        raise exception '取り込み中です' using errcode = 'SB001';
      end if;
      raise;
  end;

  return v_job;
end
$$;

-- queued を 1 本だけ取って running にする。0500 から、頭で reap を呼ぶようにした
-- （古くなった要求を取らない。lease が切れた running を failed にして、次を受けられるようにする）
create or replace function app.claim_collect_job(p_agent_id text, p_lease interval default '3 minutes')
returns app.collect_job
language plpgsql
set search_path = ''
as $$
declare
  v_job app.collect_job;
begin
  if p_agent_id is null or btrim(p_agent_id) = '' then
    raise exception 'agent_id が必要です' using errcode = '22023';
  end if;
  if p_lease is null or p_lease <= interval '0 seconds' then
    raise exception 'lease は正の長さにしてください' using errcode = '22023';
  end if;

  perform app.reap_stale_collect_jobs();

  update app.collect_job j
     set status = 'running',
         agent_id = p_agent_id,
         claimed_at = now(),
         heartbeat_at = now(),
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + p_lease
   where j.id = (
     select q.id
       from app.collect_job q
      where q.status = 'queued'
      order by q.requested_at, q.id
      limit 1
        for update skip locked
   )
  returning j.* into v_job;

  if not found then
    return null;
  end if;
  return v_job;
end
$$;

-- 人が取り込みの要求を取り消す。queued のものだけ。取り消した job を返す。
-- running は PC が書き込み中なので取り消せない（SB004）。終わったものも同じ。
-- 見つからない（他の世帯の要求は RLS で見えない）なら SB005。
-- claimed_at は NULL のまま＝始まっていないので、取り消した直後でも新しい要求を積める
create function app.cancel_collect_job(p_id uuid)
returns app.collect_job
language plpgsql
set search_path = ''
as $$
declare
  v_job    app.collect_job;
  v_status text;
  v_user   uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  update app.collect_job
     set status = 'cancelled',
         finished_at = now(),
         result = jsonb_strip_nulls(jsonb_build_object(
           'cancelled', true,
           'reason', 'user_cancelled',
           'cancelled_by', v_user
         ))
   where id = p_id and status = 'queued'
  returning * into v_job;

  if found then
    return v_job;
  end if;

  select status into v_status from app.collect_job where id = p_id;
  if not found then
    raise exception '取り込みの要求が見つかりません' using errcode = 'SB005';
  end if;

  if v_status = 'running' then
    raise exception '取り込みはもう始まっているので取り消せません' using errcode = 'SB004', detail = '状態：running';
  end if;
  raise exception '取り込みはもう終わっています' using errcode = 'SB004', detail = format('状態：%s', v_status);
end
$$;

revoke all on function app.reap_stale_collect_jobs(interval) from public;
revoke all on function app.cancel_collect_job(uuid)          from public;

grant execute on function app.reap_stale_collect_jobs(interval) to soroban_api;
grant execute on function app.cancel_collect_job(uuid)          to soroban_api;

-- 念のため：anon / authenticated / PUBLIC に、app の関数の実行権限を残さない
revoke all on all functions in schema app from public, anon, authenticated;
