-- ============================================================
-- そろばん Web 版 — Push 通知（出来事 × 端末の配送）
--
-- 設計：docs/web/03-agent-and-push.md の 4 節（Codex レビューの指摘 4・5）
--
-- 0400 の notification_outbox（出来事 1 行に送信の状態を持たせた形）は、複数の端末への送達を
-- 管理できないので捨て、出来事（notification_event）と端末ごとの配送（notification_delivery）に分ける。
-- 使っていない表なので、データの移し替えはしない。
--
--   notification_event     出来事 1 つ。dedupe_key は not null・世帯の中で unique
--   notification_delivery  出来事 × 購読（端末）。pending / sending / sent / failed・試行回数・次に試す時刻
--   push_subscription      端末名（label）と、種類ごとの受け取り（kind_sale / kind_shipping / kind_collect / kind_arrival）
--
-- 保証は「少なくとも 1 回」。完全に 1 回にはできない（Push サービスの受理と DB の更新を 1 つにできない）。
-- 二重に届いても 1 つに見えるのは、payload の event id を service worker が tag にするため。
--
-- 関数（どれも security invoker。soroban_api は世帯の文脈、soroban_cron は世帯をまたいで動かす）
--   app.enqueue_notification(kind, title, body, url, dedupe_key [, user_id]) … 業務と同じトランザクションで呼ぶ
--   app.claim_deliveries(limit, lease)                                          … 送る番が来たものを取る（skip locked）
--   app.complete_delivery(id, ok, error, gone)                                  … 送った結果を書く
--
-- 呼び出し側が見分けるための SQLSTATE
--   22023  引数が不正（種類・題名・dedupe_key など）
-- ============================================================

drop table app.notification_outbox;

-- ------------------------------------------------------------
-- 購読（端末）に、名前と、受け取る種類を足す
-- ------------------------------------------------------------

alter table app.push_subscription
  add column label          text    not null default '' check (char_length(label) <= 200),
  add column kind_sale      boolean not null default true,
  add column kind_shipping  boolean not null default true,
  add column kind_collect   boolean not null default true,
  add column kind_arrival   boolean not null default true,
  -- 配送が (household_id, id) の複合外部キーで購読を指す
  add unique (household_id, id);

-- ------------------------------------------------------------
-- 出来事
-- ------------------------------------------------------------

create table app.notification_event (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default (current_setting('app.household_id')::uuid)
               references app.household (id) on delete cascade,
  -- sale = 売れた / shipping = 発送の番 / collect = 取り込みの失敗・要ログイン・0 件 /
  -- arrival = 仕入が届いた / test = 設定画面の「試しに送る」（どの種類の設定にも縛られない）
  kind         text not null check (kind in ('sale', 'shipping', 'collect', 'arrival', 'test')),
  title        text not null,
  body         text not null default '',
  url          text,                      -- 押したときに開く画面（'/sales' など）
  -- 同じ出来事を二重に積まないための鍵（例 'sale:<販売の id>'）。世帯の中で一意
  dedupe_key   text not null,
  created_at   timestamptz not null default now(),

  unique (household_id, id),
  unique (household_id, dedupe_key)
);

-- ------------------------------------------------------------
-- 配送（出来事 × 端末）
--
-- pending = 送る番を待っている（失敗して再送待ちもここ。next_attempt_at が来たら送る）/
-- sending = 送信役が取った（claimed_at。長く sending のままなら送信役が落ちたとみて取り直せる）/
-- sent = 送った / failed = 規定の回数を使い切って諦めた。
-- 購読が消えたら（404 / 410・端末の削除・世帯から抜けた）配送も消える
-- ------------------------------------------------------------

create table app.notification_delivery (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null default (current_setting('app.household_id')::uuid)
                  references app.household (id) on delete cascade,
  event_id        uuid not null,
  subscription_id uuid not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  last_error      text,
  sent_at         timestamptz,

  unique (event_id, subscription_id),
  foreign key (household_id, event_id)
    references app.notification_event (household_id, id) on delete cascade,
  foreign key (household_id, subscription_id)
    references app.push_subscription (household_id, id) on delete cascade
);

-- 送る番が来たものを引く（送信役は世帯をまたいで巡回するので、household_id は先頭に置かない）
create index notification_delivery_due
  on app.notification_delivery (next_attempt_at)
  where status = 'pending';

-- 取ったまま止まっているものを探す
create index notification_delivery_sending
  on app.notification_delivery (claimed_at)
  where status = 'sending';

-- 購読を消すときの cascade
create index notification_delivery_subscription
  on app.notification_delivery (subscription_id);

select app.enable_household_rls('app.notification_event');
select app.enable_household_rls('app.notification_delivery');

-- ------------------------------------------------------------
-- 出来事を積む
--
-- 業務の書き込みと同じトランザクションで呼ぶ（送信の失敗で業務が巻き戻らず、業務が巻き戻れば
-- 通知も消える）。
--   * event を 1 行。同じ dedupe_key が世帯にあれば何もしない（null を返す）
--   * その時点の購読のうち、その種類を受け取る端末ぶんの delivery を作る。
--     test は種類の設定に縛られない。p_user_id を渡すと、その人の端末だけ（試しの通知は自分の端末だけ）
-- 新しく積んだら event の id を返す。重複で何もしなかったら null
--
-- 購読は event と同じ世帯のものだけを選ぶ。soroban_cron のように世帯をまたいで読める役が
-- 呼んでも、別の世帯の端末に配送を作らない
-- ------------------------------------------------------------

create function app.enqueue_notification(
  p_kind text,
  p_title text,
  p_body text,
  p_url text,
  p_dedupe_key text,
  p_user_id uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_event     uuid;
  v_household uuid;
begin
  if p_kind is null or p_kind not in ('sale', 'shipping', 'collect', 'arrival', 'test') then
    raise exception '通知の種類が不正です: %', p_kind using errcode = '22023';
  end if;
  if p_title is null or btrim(p_title) = '' or char_length(p_title) > 200 then
    raise exception '通知の題名は 1〜200 文字にしてください' using errcode = '22023';
  end if;
  if p_body is not null and char_length(p_body) > 1000 then
    raise exception '通知の本文は 1000 文字までです' using errcode = '22023';
  end if;
  if p_url is not null and char_length(p_url) > 2000 then
    raise exception '通知の行き先が長すぎます' using errcode = '22023';
  end if;
  if p_dedupe_key is null or btrim(p_dedupe_key) = '' or char_length(p_dedupe_key) > 300 then
    raise exception '通知の dedupe_key は 1〜300 文字にしてください' using errcode = '22023';
  end if;

  insert into app.notification_event (kind, title, body, url, dedupe_key)
  values (p_kind, p_title, coalesce(p_body, ''), p_url, p_dedupe_key)
  on conflict (household_id, dedupe_key) do nothing
  returning id, household_id into v_event, v_household;

  if not found then
    return null;
  end if;

  insert into app.notification_delivery (event_id, subscription_id)
  select v_event, s.id
    from app.push_subscription s
   where s.household_id = v_household
     and (p_user_id is null or s.user_id = p_user_id)
     and case p_kind
           when 'sale'     then s.kind_sale
           when 'shipping' then s.kind_shipping
           when 'collect'  then s.kind_collect
           when 'arrival'  then s.kind_arrival
           else true
         end;

  return v_event;
end
$$;

-- ------------------------------------------------------------
-- 送る番が来たものを取る（送信役）
--
-- * 送る番が来た pending（next_attempt_at <= now()）を p_limit 件まで、for update skip locked で取って
--   sending にする。2 本の送信役が同時に走っても、同じ配送を 2 回取らない
-- * sending のまま p_lease を超えて止まったもの（送信役が落ちた）も取り直す
-- * 取った時点で attempts を 1 増やす。送信役が落ち続けても、規定の回数（5）で諦める：
--   止まったまま規定の回数に達したものは、取り直さずに failed にする
-- 戻り値は、送るのに要るものを全部（出来事の中身と、購読の endpoint・鍵）
-- ------------------------------------------------------------

create function app.claim_deliveries(p_limit integer default 20, p_lease interval default '2 minutes')
returns table (
  delivery_id     uuid,
  household_id    uuid,
  event_id        uuid,
  subscription_id uuid,
  kind            text,
  title           text,
  body            text,
  url             text,
  endpoint        text,
  p256dh          text,
  auth            text,
  attempts        integer
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit < 1 then
    raise exception '件数は 1 以上にしてください' using errcode = '22023';
  end if;
  if p_lease is null or p_lease <= interval '0 seconds' then
    raise exception 'lease は正の長さにしてください' using errcode = '22023';
  end if;

  update app.notification_delivery d
     set status = 'failed',
         claimed_at = null,
         last_error = '送信中に止まったまま、規定の回数に達しました'
   where d.status = 'sending'
     and d.claimed_at <= now() - p_lease
     and d.attempts >= 5;

  return query
  with picked as (
    select d.id
      from app.notification_delivery d
     where (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.claimed_at <= now() - p_lease)
     order by d.next_attempt_at, d.id
     limit p_limit
       for update skip locked
  ),
  claimed as (
    update app.notification_delivery d
       set status = 'sending',
           claimed_at = now(),
           attempts = d.attempts + 1
      from picked
     where d.id = picked.id
    returning d.id, d.household_id, d.event_id, d.subscription_id, d.attempts
  )
  select c.id, c.household_id, c.event_id, c.subscription_id,
         e.kind, e.title, e.body, e.url,
         s.endpoint, s.p256dh, s.auth, c.attempts
    from claimed c
    join app.notification_event e on e.household_id = c.household_id and e.id = c.event_id
    join app.push_subscription s on s.household_id = c.household_id and s.id = c.subscription_id
   order by c.id;
end
$$;

-- ------------------------------------------------------------
-- 送った結果を書く（送信役）
--
--   p_ok       … 送れた。sent にして、購読の last_used_at を進める
--   !p_ok      … 失敗。p_error（500 文字まで）を残す。試行回数（取るたびに増える）が 5 に達していれば
--                failed（諦める）。そうでなければ pending に戻し、next_attempt_at を回数に応じて延ばす
--                （1 回目 +1 分・2 回目 +5 分・3 回目 +30 分・4 回目 +2 時間）
--   p_gone     … Push サービスが 404 / 410 を返した（購読が無効）。購読ごと消す（配送も cascade で消える）。
--                p_ok より優先する
-- 戻り値：'sent' / 'pending'（あとで再送）/ 'failed' / 'gone'（購読を消した）。
-- 配送が無い、または sending でない（別の送信役が取り直した・もう済んだ）ときは null で何もしない
-- （p_gone だけは、配送が sending でなくても購読を消す）
-- ------------------------------------------------------------

create function app.complete_delivery(p_id uuid, p_ok boolean, p_error text, p_gone boolean default false)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_d     app.notification_delivery;
  v_error text := left(p_error, 500);
begin
  select * into v_d from app.notification_delivery where id = p_id for update;
  if not found then
    return null;
  end if;

  if coalesce(p_gone, false) then
    delete from app.push_subscription
     where household_id = v_d.household_id and id = v_d.subscription_id;
    return 'gone';
  end if;

  if v_d.status <> 'sending' then
    return null;
  end if;

  if coalesce(p_ok, false) then
    update app.notification_delivery
       set status = 'sent', sent_at = now(), claimed_at = null, last_error = null
     where id = p_id;
    update app.push_subscription
       set last_used_at = now()
     where household_id = v_d.household_id and id = v_d.subscription_id;
    return 'sent';
  end if;

  if v_d.attempts >= 5 then
    update app.notification_delivery
       set status = 'failed', claimed_at = null, last_error = v_error
     where id = p_id;
    return 'failed';
  end if;

  update app.notification_delivery
     set status = 'pending',
         claimed_at = null,
         last_error = v_error,
         next_attempt_at = now() + (array[1, 5, 30, 120])[least(greatest(v_d.attempts, 1), 4)] * interval '1 minute'
   where id = p_id;
  return 'pending';
end
$$;

-- ------------------------------------------------------------
-- 権限
-- ------------------------------------------------------------

revoke all on all functions in schema app from public, anon, authenticated;
revoke all on all tables    in schema app from public, anon, authenticated;

grant execute on function app.enqueue_notification(text, text, text, text, text, uuid) to soroban_api;
grant execute on function app.claim_deliveries(integer, interval)                      to soroban_api;
grant execute on function app.complete_delivery(uuid, boolean, text, boolean)          to soroban_api;
