-- ============================================================
-- そろばん Web 版 — 取り込みの排他（collect_job の操作）
--
-- 規則（docs/web/00-architecture.md）
-- * 同時に走らない … 世帯ごとに queued/running は 1 本だけ（部分ユニーク索引）。
--                     2 本目の要求は「取り込み中です」で断る
-- * 連続で走らない … 最後に取り込みを始めた（claimed_at）時刻から cooldown（既定 10 分）は断る。
--                     done だけでなく failed・cancelled の後にも効く（失敗の直後の連打を許さない）
-- * 1 台だけが取る … for update skip locked で queued を 1 本、原子的に running にする
-- * 期限切れ後の二重実行を防ぐ（フェンシング）… claim が lease_token を発行する。heartbeat / finish は
--     status = 'running' and lease_token = p_lease_token のときだけ書ける（CAS）。
--     PC が止まって期限が切れ、reap されたあと・別の端末が引き継いだあとに、古い端末が遅れて
--     書き込んでも例外で拒否される
-- * PC が落ちたら … lease_expires_at を過ぎた running を failed にして、次の要求を受けられるようにする
--
-- どれも security invoker。API は soroban_api で動くので RLS が効き、見えるのは自分の世帯の
-- 取り込み要求だけ
--
-- 呼び出し側が見分けるための SQLSTATE
--   SB001  取り込み中です
--   SB002  前回の取り込みから n 分たっていません（detail に「あと n 秒」）
--   SB003  取り込みの権限（lease）が失効している／この job は取れていない
-- ============================================================

-- 取り込みを要求する。積んだ job を返す。
-- 押した人は、API が set_config('app.user_id', '<auth.users の id>', true) で渡していれば
-- requested_by に入る（無ければ NULL）
create function app.enqueue_collect_job(cooldown interval default '10 minutes')
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
  if exists (select 1 from app.collect_job where status in ('queued', 'running')) then
    raise exception '取り込み中です' using errcode = 'SB001';
  end if;

  -- 最後に取り込みを始めた時刻。結果（done / failed / cancelled / reap されたもの）を問わない。
  -- 一度も取られなかった job（claimed_at が NULL）は始まっていないので数えない
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

-- queued を 1 本だけ取って running にし、lease_token を発行して返す。取れなければ null。
-- 戻り値の lease_token を agent が持っておき、heartbeat / finish に渡す。
-- （`select * from` で呼ぶと、取れなかったときも全列 null の 1 行が返る。id が null かで見分ける）
create function app.claim_collect_job(p_agent_id text, p_lease interval default '3 minutes')
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

-- 生きていることを知らせて、lease を p_lease だけ延ばす（30 秒ごと）。新しい期限を返す。
-- token が今の running のものでなければ SB003 を投げる（reap された・別の claim の後・
-- すでに終わった）。投げられたら取り込みを続けずに止めること
create function app.heartbeat_collect_job(p_id uuid, p_lease_token uuid, p_lease interval default '3 minutes')
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  update app.collect_job
     set heartbeat_at = now(), lease_expires_at = now() + p_lease
   where id = p_id and status = 'running' and lease_token = p_lease_token
  returning lease_expires_at into v_expires;

  if not found then
    raise exception '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）'
      using errcode = 'SB003';
  end if;
  return v_expires;
end
$$;

-- 取り込みを終える。終えた job を返す。p_status は done / failed / cancelled。
-- token が今の running のものでなければ SB003 を投げる（heartbeat と同じ）
create function app.finish_collect_job(p_id uuid, p_lease_token uuid, p_status text, p_result jsonb default null)
returns app.collect_job
language plpgsql
set search_path = ''
as $$
declare
  v_job app.collect_job;
begin
  if p_status is null or p_status not in ('done', 'failed', 'cancelled') then
    raise exception '終了の状態は done / failed / cancelled のどれかです: %', p_status
      using errcode = '22023';
  end if;

  update app.collect_job
     set status = p_status, finished_at = now(), result = p_result
   where id = p_id and status = 'running' and lease_token = p_lease_token
  returning * into v_job;

  if not found then
    raise exception '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）'
      using errcode = 'SB003';
  end if;
  return v_job;
end
$$;

-- lease の期限（lease_expires_at）を過ぎた running を failed にする。件数を返す。
-- 後から原因が分かるよう result に印を残す。以後、その job の token での書き込みは拒否される
create function app.reap_stale_collect_jobs()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
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
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function app.enqueue_collect_job(interval)                       from public;
revoke all on function app.claim_collect_job(text, interval)                   from public;
revoke all on function app.heartbeat_collect_job(uuid, uuid, interval)         from public;
revoke all on function app.finish_collect_job(uuid, uuid, text, jsonb)         from public;
revoke all on function app.reap_stale_collect_jobs()                           from public;

grant execute on function app.enqueue_collect_job(interval)                    to soroban_api;
grant execute on function app.claim_collect_job(text, interval)                to soroban_api;
grant execute on function app.heartbeat_collect_job(uuid, uuid, interval)      to soroban_api;
grant execute on function app.finish_collect_job(uuid, uuid, text, jsonb)      to soroban_api;
grant execute on function app.reap_stale_collect_jobs()                        to soroban_api;

-- 念のため：anon / authenticated / PUBLIC に、app の関数の実行権限を残さない
revoke all on all functions in schema app from public, anon, authenticated;
