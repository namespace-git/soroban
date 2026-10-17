-- ============================================================
-- postgres が soroban_api / soroban_cron / soroban_gateway に `set role` できるようにする
--
-- PostgreSQL 16 以降、superuser でないロール（Supabase の postgres）が CREATE ROLE すると、作った側には
-- ADMIN OPTION だけが付き、SET / INHERIT は付かない（createrole_self_grant が空のとき）。
-- 0100 などの `grant soroban_api to postgres` は「すでにメンバーなら飛ばす」書き方だったので、この ADMIN だけの
-- メンバーシップを見て飛ばしてしまい、postgres は soroban_api に切り替えられなかった
-- （2026-10-18、データ移行の道具が本番で `permission denied to set role "soroban_api"` で止まって分かった）。
-- ADMIN を持っているので、自分に SET を付け直せる。INHERIT は付けない（postgres が黙って権限を引き継がない）
-- ============================================================

-- 付ける相手はマイグレーションを流しているロール（Supabase では postgres）
do $$
declare
  r text;
begin
  foreach r in array array['soroban_api', 'soroban_cron', 'soroban_gateway'] loop
    if exists (select 1 from pg_roles where rolname = r)
       and not pg_has_role(current_user, r, 'SET') then
      execute format('grant %I to %I with set true, inherit false', r, current_user);
    end if;
  end loop;
end
$$;
