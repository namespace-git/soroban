-- ============================================================
-- そろばん Web 版 — Web 化で新しく要るテーブル
--
-- collect_job          取り込み要求（同時・連続で走らせない）
-- push_subscription    Web Push の購読（人ごと・端末ごと）
-- notification_outbox  通知の出来事（業務ロジックと同じトランザクションで書く）
-- setting_secret       API キー等の秘密の値（暗号文だけ。平文の列は作らない）
--
-- どれも household_id と RLS を持つ（push_subscription / notification_outbox は、設計書の
-- 列の一覧に household_id が無かったが、世帯をまたいで見えてはいけないので足した）
-- ============================================================

-- ------------------------------------------------------------
-- 取り込み要求
-- ------------------------------------------------------------

create table app.collect_job (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null, -- 押した人
  requested_at timestamptz not null default now(),
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  agent_id     text,                      -- 取った PC
  claimed_at   timestamptz,               -- 取った（＝取り込みを始めた）時刻。連続の判定はこれを見る
  heartbeat_at timestamptz,
  finished_at  timestamptz,
  result       jsonb,                     -- CollectorRun[] と配送状況の要約

  -- フェンシング。claim のたびに作り直す乱数。heartbeat / finish はこの token が今の running の
  -- ものと一致するときだけ書ける。期限切れで reap された後・別の claim の後に、古い agent が
  -- 遅れて書き込んでも拒否される。API は claim の戻り値以外でこの列を画面やエージェントに返さないこと
  lease_token      uuid,
  lease_expires_at timestamptz,           -- heartbeat のたびに延びる。これを過ぎた running は reap の対象

  unique (household_id, id),
  -- running なら token と期限が揃っている
  check (status <> 'running' or (lease_token is not null and lease_expires_at is not null))
);

-- 同時に走らせない：世帯ごとに queued / running は 1 本だけ。2 本目は一意制約違反になる
create unique index collect_job_one_active
  on app.collect_job (household_id)
  where status in ('queued', 'running');

-- ------------------------------------------------------------
-- Push 通知
-- ------------------------------------------------------------

-- 購読（人ごと・端末ごと）。endpoint はブラウザ・端末ごとに一意
create table app.push_subscription (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  user_id      uuid not null,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,

  -- 世帯から抜けた人の購読は残さない
  foreign key (household_id, user_id)
    references app.household_member (household_id, user_id) on delete cascade
);

create index push_subscription_household on app.push_subscription (household_id, user_id);

-- 通知の出来事。業務ロジックと同じトランザクションで書き、送信はコミットの後に行う
-- （送信の失敗で業務の書き込みが巻き戻らない）。
-- 送信の状態：pending = 送る番を待っている（失敗して再送待ちもここ。next_attempt_at が来たら送る）/
-- sending = 送信役が取った（claimed_at。長く sending のままなら送信役が落ちたとみて戻せる）/
-- sent = 送った / failed = 規定の回数を超えて諦めた。送信役（Cron）は別の段で作る
create table app.notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  kind            text not null,
  title           text not null,
  body            text not null default '',
  url             text,
  payload         jsonb,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  last_error      text,
  -- 同じ出来事を二重に積まないための鍵（例 'sale:<販売の id>'）。世帯の中で一意。NULL は重複を許す
  dedupe_key      text,

  unique (household_id, dedupe_key)
);

-- 送る番が来たものを引く（送信役は世帯をまたいで巡回するので、household_id は先頭に置かない）
create index notification_outbox_due
  on app.notification_outbox (next_attempt_at)
  where status = 'pending';

-- 取ったまま止まっているものを探す
create index notification_outbox_sending
  on app.notification_outbox (claimed_at)
  where status = 'sending';

-- ------------------------------------------------------------
-- 秘密の値
--
-- Gemini / 17TRACK の API キーなど。Web では端末の safeStorage が使えないので、サーバーの秘密鍵
-- （Cloudflare の環境変数。DB には置かない）で AES-GCM 暗号化した結果だけを持つ。
-- ciphertext は暗号文＋認証タグ、iv は初期化ベクトル。平文の列は作らない
-- ------------------------------------------------------------

create table app.setting_secret (
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  key          text not null,
  ciphertext   bytea not null,
  iv           bytea not null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, key)
);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

select app.enable_household_rls('app.collect_job');
select app.enable_household_rls('app.push_subscription');
select app.enable_household_rls('app.notification_outbox');
select app.enable_household_rls('app.setting_secret');

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

revoke all on all tables    in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;
