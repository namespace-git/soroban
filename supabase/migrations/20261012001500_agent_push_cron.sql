-- ============================================================
-- そろばん Web 版 — 取り込み担当の PC（agent_device）と、取り込みの lease の穴ふさぎ
--
-- 設計：docs/web/03-agent-and-push.md の 1 節・2 節（Codex レビューの指摘 1・2・3）
--
-- 1. agent_device            取り込み担当の PC。短命の鍵の SHA-256 だけを持つ（平文の鍵は持たない）
-- 2. app.agent_of_token      鍵のハッシュ → (PC, 世帯)。API が set role の前に呼ぶ（security definer）
-- 3. app.register_agent_device / revoke_agent_device
-- 4. collect_job の穴ふさぎ
--      * status に partial（段が全部終わらずに止まった）を足す
--      * agent_device_id（どの PC が取ったか。agent_device への複合外部キー）
--      * app.assert_lease … 書き込みのトランザクションの先頭で呼ぶ。失効した lease を断る
--      * heartbeat / finish … 失効した lease では延命も終了もできない
--      * collect_job_stage / app.begin_stage … 段ごとの冪等（同じ段を 2 回書いたら 2 回目は「済み」）
--
-- 呼び出し側が見分けるための SQLSTATE（0500・0700 の SB001〜SB005 の続き。意味は変えない）
--   SB003  取り込みの権限（lease）が失効している／この job は取れていない（assert_lease・heartbeat・finish）
--   SB006  取り込み担当の PC が取り消されている（register で断る）
--   SB007  取り込み担当の PC が見つからない（revoke。他の世帯の PC もここ。RLS で見えない）
--   22023  引数が不正（端末名が空・200 文字超、鍵の形、期限、段の鍵）
-- ============================================================

-- ------------------------------------------------------------
-- 取り込み担当の PC
--
-- 鍵（アクセストークンとは別の、12 時間ほどの短命の鍵）は PC のメモリにだけあり、ここには
-- SHA-256 の 16 進（小文字 64 文字）だけを置く。平文の列は作らない。
-- 端末名が同じなら register は行を使い回して、token_hash と期限を差し替える（取り直し）。
-- 取り消し（revoked_at）された PC には、以後鍵を出さない
-- ------------------------------------------------------------

create table app.agent_device (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null default (current_setting('app.household_id')::uuid)
                   references app.household (id) on delete cascade,
  name             text not null check (name = btrim(name) and name <> '' and char_length(name) <= 200),
  token_hash       text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz not null,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  revoked_at       timestamptz,
  registered_by    uuid references auth.users (id) on delete set null, -- 鍵を作らせた人

  unique (household_id, id),
  unique (household_id, name),
  -- 鍵から PC を引く（世帯が決まる前に引くので、世帯を含めない）
  unique (token_hash)
);

select app.enable_household_rls('app.agent_device');

-- 鍵のハッシュから PC を引くための方針（app.agent_of_token が使う）。
-- 世帯が決まる前の照会なので household_isolation では見えない。household_member の
-- member_self_lookup と同じ作り：関数の中だけ app.agent_token_hash に渡されたハッシュを入れ、
-- そのハッシュに一致する 1 行だけを読み書きできるようにする。
-- 表の持ち主に BYPASSRLS が無い環境（force row level security が効く）でも関数が動くための方針
create policy agent_token_lookup_select on app.agent_device
  for select
  using (token_hash = nullif(current_setting('app.agent_token_hash', true), ''));

create policy agent_token_lookup_update on app.agent_device
  for update
  using (token_hash = nullif(current_setting('app.agent_token_hash', true), ''))
  with check (token_hash = nullif(current_setting('app.agent_token_hash', true), ''));

-- 鍵のハッシュ → (PC の id, 世帯の id)。期限切れ・取り消し済み・知らない鍵は 0 行。
-- 引けたら last_seen_at を進める（「生きている」の印。画面の「取り込み担当 n 台」はこれを見る）。
--
-- security definer：API は世帯が決まる前（set role soroban_api の前）に呼ぶ。household_of_user と
-- 同じ理由で、接続したロールが FORCE RLS で読めない環境でも引けるように、中だけ上の方針に合う値を渡す。
-- 渡した値は終わったら呼んだ側の値に戻す
create function app.agent_of_token(p_token_hash text)
returns table (agent_id uuid, household_id uuid)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_prev_hash text := current_setting('app.agent_token_hash', true);
  v_id        uuid;
  v_household uuid;
begin
  if p_token_hash is null or p_token_hash = '' then
    return;
  end if;

  perform set_config('app.agent_token_hash', p_token_hash, true);

  update app.agent_device d
     set last_seen_at = now()
   where d.token_hash = p_token_hash
     and d.revoked_at is null
     and d.token_expires_at > clock_timestamp()
  returning d.id, d.household_id into v_id, v_household;

  perform set_config('app.agent_token_hash', coalesce(v_prev_hash, ''), true);

  if v_id is null then
    return;
  end if;
  agent_id := v_id;
  household_id := v_household;
  return next;
end
$$;

-- 取り込み担当の鍵を出す（agent/register）。API が soroban_api ＋世帯の文脈で呼ぶ。
-- 同じ端末名なら行を使い回して token_hash と期限を差し替える（first_seen_at は残す）。
-- 取り消し済みの PC には出さない（SB006）。押した人は app.user_id から入る（無ければ NULL）。
-- 期限は今から 24 時間以内に限る（短命の鍵という前提を、DB でも守る）
create function app.register_agent_device(p_name text, p_token_hash text, p_expires_at timestamptz)
returns app.agent_device
language plpgsql
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_dev  app.agent_device;
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
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '24 hours' then
    raise exception '鍵の期限は、いまから 24 時間以内にしてください' using errcode = '22023';
  end if;

  insert into app.agent_device (name, token_hash, token_expires_at, registered_by)
  values (v_name, p_token_hash, p_expires_at, v_user)
  on conflict (household_id, name) do update
     set token_hash = excluded.token_hash,
         token_expires_at = excluded.token_expires_at,
         last_seen_at = now(),
         registered_by = excluded.registered_by
   where app.agent_device.revoked_at is null
  returning * into v_dev;

  if not found then
    raise exception 'この PC は取り消されているので、取り込み担当の鍵を出せません' using errcode = 'SB006';
  end if;
  return v_dev;
end
$$;

-- 取り込み担当の PC を取り消す。以後 agent_of_token で引けない。取り消し済みに重ねても変わらない
-- （最初の revoked_at を残す）。見つからなければ SB007
create function app.revoke_agent_device(p_id uuid)
returns app.agent_device
language plpgsql
set search_path = ''
as $$
declare
  v_dev app.agent_device;
begin
  update app.agent_device
     set revoked_at = coalesce(revoked_at, now())
   where id = p_id
  returning * into v_dev;

  if not found then
    raise exception '取り込み担当の PC が見つかりません' using errcode = 'SB007';
  end if;
  return v_dev;
end
$$;

-- ------------------------------------------------------------
-- 取り込み要求（collect_job）の穴ふさぎ
-- ------------------------------------------------------------

-- 段が全部終わらずに止まったら partial（done と区別する）。
-- 0400 の列の check は collect_job_status_check（Postgres が付ける既定の名前）
alter table app.collect_job drop constraint collect_job_status_check;
alter table app.collect_job
  add constraint collect_job_status_check
  check (status in ('queued', 'running', 'done', 'partial', 'failed', 'cancelled'));

-- どの PC が取ったか。agent_id（端末名の控え）は残す。PC を消しても job は残す
alter table app.collect_job add column agent_device_id uuid;
alter table app.collect_job
  add constraint collect_job_agent_device_fk
  foreign key (household_id, agent_device_id)
  references app.agent_device (household_id, id)
  on delete set null (agent_device_id);

-- 書き込みのトランザクションの先頭で呼ぶ。job の行を for update で取り、
-- 「running で、token が合い、期限が切れていない」でなければ SB003。
-- 行のロックを取引の終わりまで持つので、reap（期限切れの片付け）とは job の行で直列になる：
--   * 書き込みが先 … reap は書き込みの終わりを待ち、そのあとで判定し直す
--   * reap が先   … 書き込みは failed になった job を見て SB003 で止まる
-- どちらか一方だけ。スリープから戻った古い PC は、最初の書き込みでここで断られて止まる。
-- 期限は clock_timestamp()（呼んだ瞬間）で見る。now() は取引の開始時刻で、長い取引の中だと古い
create function app.assert_lease(p_id uuid, p_lease_token uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1
     from app.collect_job
    where id = p_id
      and status = 'running'
      and lease_token = p_lease_token
      and lease_expires_at > clock_timestamp()
      for update;

  if not found then
    raise exception '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）'
      using errcode = 'SB003';
  end if;
end
$$;

-- 生きていることを知らせて、lease を p_lease だけ延ばす。0500 から、失効した lease は延命できない
-- ようにした（期限を過ぎていたら SB003。reap がまだ来ていなくても延命させない）
create or replace function app.heartbeat_collect_job(p_id uuid, p_lease_token uuid, p_lease interval default '3 minutes')
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  update app.collect_job
     set heartbeat_at = now(), lease_expires_at = now() + p_lease
   where id = p_id
     and status = 'running'
     and lease_token = p_lease_token
     and lease_expires_at > clock_timestamp()
  returning lease_expires_at into v_expires;

  if not found then
    raise exception '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）'
      using errcode = 'SB003';
  end if;
  return v_expires;
end
$$;

-- 取り込みを終える。p_status は done / partial / failed / cancelled。
-- 0500 から、partial を受けるのと、失効した lease では終えられない（SB003）のを足した
create or replace function app.finish_collect_job(p_id uuid, p_lease_token uuid, p_status text, p_result jsonb default null)
returns app.collect_job
language plpgsql
set search_path = ''
as $$
declare
  v_job app.collect_job;
begin
  if p_status is null or p_status not in ('done', 'partial', 'failed', 'cancelled') then
    raise exception '終了の状態は done / partial / failed / cancelled のどれかです: %', p_status
      using errcode = '22023';
  end if;

  update app.collect_job
     set status = p_status, finished_at = now(), result = p_result
   where id = p_id
     and status = 'running'
     and lease_token = p_lease_token
     and lease_expires_at > clock_timestamp()
  returning * into v_job;

  if not found then
    raise exception '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）'
      using errcode = 'SB003';
  end if;
  return v_job;
end
$$;

-- queued を 1 本だけ取って running にする。0700 に、取った PC（p_agent_device_id）を足した。
-- 引数が増えるので 0700 の claim_collect_job(text, interval) は捨てる（残すと、
-- claim_collect_job('pc') の呼び出しがどちらか決められずに失敗する）。
-- 引数は既定値つきなので、これまでの呼び方がそのまま通る
drop function app.claim_collect_job(text, interval);

create function app.claim_collect_job(
  p_agent_id text,
  p_lease interval default '3 minutes',
  p_agent_device_id uuid default null
)
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
         agent_device_id = p_agent_device_id,
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

-- ------------------------------------------------------------
-- 段ごとの冪等
--
-- 取り込みは意味のある段（販売一覧の 1 ページ・出品の 1 ページ・画像 1 枚…）ごとに 1 トランザクションで
-- 書く。PC が落ちて同じ段を送り直しても、2 回書かないための記録。段の鍵の付け方は呼び出し側が決める
-- （例 'sales:3'・'trading'・'listings:1'・画像は元 URL）。job ごとに独立
-- ------------------------------------------------------------

create table app.collect_job_stage (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  job_id       uuid not null,
  stage_key    text not null check (btrim(stage_key) <> '' and char_length(stage_key) <= 2000),
  done_at      timestamptz not null default now(),
  primary key (household_id, job_id, stage_key),
  foreign key (household_id, job_id)
    references app.collect_job (household_id, id) on delete cascade
);

select app.enable_household_rls('app.collect_job_stage');

-- 書き込みのトランザクションの先頭で呼ぶ。lease を確かめて（assert_lease と同じ。SB003）、段を記録する。
--   true  … 初めて。この段の書き込みを続ける
--   false … 済み（前に同じ段を書いた）。何も書かずに「済み」として返す
-- 記録は書き込みと同じトランザクションなので、書き込みが失敗して巻き戻れば記録も消え、送り直せる
create function app.begin_stage(p_id uuid, p_lease_token uuid, p_stage_key text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_stage_key is null or btrim(p_stage_key) = '' then
    raise exception '段の鍵が必要です' using errcode = '22023';
  end if;
  if char_length(p_stage_key) > 2000 then
    raise exception '段の鍵が長すぎます（2000 文字まで）' using errcode = '22023';
  end if;

  perform app.assert_lease(p_id, p_lease_token);

  insert into app.collect_job_stage (job_id, stage_key)
  values (p_id, p_stage_key)
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  return v_rows = 1;
end
$$;

-- ------------------------------------------------------------
-- 権限
-- ------------------------------------------------------------

revoke all on all functions in schema app from public, anon, authenticated;
revoke all on all tables    in schema app from public, anon, authenticated;

-- agent_of_token は security definer。API が世帯の決まる前に呼ぶ。soroban_api に EXECUTE を出す
-- （household_of_user と同じ）。それ以外は security invoker で、soroban_api が世帯の文脈で呼ぶ
grant execute on function app.agent_of_token(text)                                  to soroban_api;
grant execute on function app.register_agent_device(text, text, timestamptz)        to soroban_api;
grant execute on function app.revoke_agent_device(uuid)                             to soroban_api;
grant execute on function app.assert_lease(uuid, uuid)                              to soroban_api;
grant execute on function app.heartbeat_collect_job(uuid, uuid, interval)           to soroban_api;
grant execute on function app.finish_collect_job(uuid, uuid, text, jsonb)           to soroban_api;
grant execute on function app.claim_collect_job(text, interval, uuid)               to soroban_api;
grant execute on function app.begin_stage(uuid, uuid, text)                         to soroban_api;
