-- ============================================================
-- そろばん Web 版 — トリガー（SQLite の trg_sline_sold / trg_sline_unsold /
-- trg_listing_line_guard を PL/pgSQL に移植）
--
-- どれも security invoker（既定）。API は soroban_api で動くので RLS が効き、
-- 触れるのは同じ世帯の行だけ。念のため household_id も条件に入れる
-- ============================================================

-- 紐付けたら在庫を sold に、外したら in_stock に戻す
create function app.sale_line_mark_sold()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update app.inventory_item
     set status = 'sold', updated_at = now()
   where id = new.inventory_item_id
     and household_id = new.household_id;
  return null;
end
$$;

create function app.sale_line_mark_unsold()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update app.inventory_item
     set status = 'in_stock', updated_at = now()
   where id = old.inventory_item_id
     and household_id = old.household_id;
  return null;
end
$$;

create trigger trg_sline_sold
  after insert on app.sale_line
  for each row execute function app.sale_line_mark_sold();

create trigger trg_sline_unsold
  after delete on app.sale_line
  for each row execute function app.sale_line_mark_unsold();

-- 紐付けた順（allocation_order）は一度付いたら変えない。まとめ売りの端数をどの行に寄せるかが
-- この順で決まり、変わると 1 点あたりの売上・粗利（円）がずれる。
-- `generated always as identity` の列は update ... set allocation_order = default で
-- 振り直せてしまうので、値が変わる更新はここで拒否する
create function app.sale_line_order_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.allocation_order is distinct from old.allocation_order then
    raise exception '紐付けの並び順は変えられません';
  end if;
  return new;
end
$$;

create trigger trg_sale_line_order_immutable
  before update on app.sale_line
  for each row execute function app.sale_line_order_immutable();

-- 二重引き当てを禁止：同じ在庫が既に別の active/suspended な出品に引き当て済み、
-- または在庫が in_stock でなければ挿入を拒否する。終了した出品にも引き当てられない。
--
-- SQLite は書き込みが 1 本ずつなので検査と挿入の間に割り込まれなかったが、Postgres は
-- 2 つの端末が同時に同じ在庫を引き当てられる。先に在庫の行をロック（for update）して、
-- 後から来た方に最初の検査を見直させる。
-- 在庫が見つからない（別の世帯の在庫を含む）ときは、ここでは何もしない（SQLite と同じ。
-- 外部キーが拒否する）
create function app.listing_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_item_status    text;
  v_listing_status text;
begin
  select status into v_item_status
    from app.inventory_item
   where id = new.inventory_item_id and household_id = new.household_id
     for update;

  if exists (
    select 1
      from app.listing_line ll
      join app.listing l on l.id = ll.listing_id and l.household_id = ll.household_id
     where ll.inventory_item_id = new.inventory_item_id
       and ll.household_id = new.household_id
       and l.status in ('active', 'suspended')
  ) then
    raise exception '既に別の出品に引き当て済み';
  end if;

  if v_item_status <> 'in_stock' then
    raise exception '未販売の在庫だけ引き当てられます';
  end if;

  select status into v_listing_status
    from app.listing
   where id = new.listing_id and household_id = new.household_id;

  if v_listing_status not in ('active', 'suspended') then
    raise exception '終了した出品には引き当てられません';
  end if;

  return new;
end
$$;

create trigger trg_listing_line_guard
  before insert on app.listing_line
  for each row execute function app.listing_line_guard();

-- 関数の EXECUTE は PUBLIC にも既定で付くので外す
revoke all on function app.sale_line_mark_sold()   from public;
revoke all on function app.sale_line_mark_unsold() from public;
revoke all on function app.listing_line_guard()    from public;
revoke all on function app.sale_line_order_immutable() from public;
