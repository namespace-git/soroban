-- ============================================================
-- そろばん Web 版 — 画像の置き場（Supabase Storage）
--
-- 設計：docs/web/00-architecture.md の「画像」・docs/web/02-porting-guide.md の 4 節
--
--   media     公開。販売・出品のサムネイル、仕入明細の画像、商品画像
--             （フリマ・仕入先で公開されている商品写真。パスは推測できない）
--   receipts  非公開。レシート。見るときだけ署名 URL
--
-- パスは <世帯の id>/<種類>/<ランダムな id>.<拡張子>。取り込み担当の PC やブラウザは
-- authenticated（ログインした人）として上げる。パスの先頭のフォルダが自分の世帯の id のときだけ
-- 上げる・読む（receipts）・消せる。他の世帯のフォルダには入れられない。
-- media の読み出しは公開バケットなので方針は要らない（匿名でも URL で読める）。
-- ただし消すとき（delete ... returning）に行が見えている必要があるので、自分の世帯のフォルダの
-- select だけ authenticated に許している
--
-- app.my_household()：いまの JWT の人（auth.uid()）の世帯の id。引数を取らない＝他人の世帯を
-- 調べられない。方針の式から呼ぶので authenticated に EXECUTE を出す（このスキーマで authenticated に
-- 関数の権限を出すのはこれだけ。後のマイグレーションで app の関数をまとめて revoke すると、ここが
-- 「permission denied for function」になるので、revoke するなら my_household は出し直すこと）
-- ============================================================

create function app.my_household()
returns uuid
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  return app.household_of_user(auth.uid());
end
$$;

revoke all on all functions in schema app from public, anon, authenticated;
grant execute on function app.my_household() to authenticated;

-- ------------------------------------------------------------
-- バケット
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('media', 'media', true), ('receipts', 'receipts', false)
on conflict do nothing;

-- すでに同じ名前のバケットが公開で作られていたら、レシートが誰でも読める。気づかず進めない
do $$
begin
  if exists (select 1 from storage.buckets where id = 'receipts' and public) then
    raise exception 'receipts バケットが公開になっています。Supabase の Storage で非公開（Public off）に直してから流し直してください';
  end if;
end
$$;

-- ------------------------------------------------------------
-- storage.objects の方針（authenticated だけ。anon には何も出さない）
--
-- storage.foldername(name) は、パスの最後（ファイル名）を除いたフォルダの配列。
-- ('世帯の id/sales/abc.jpg' → {世帯の id, sales})。先頭が自分の世帯の id のときだけ通す。
-- (select ...) で包むのは、行ごとに呼ばず 1 度だけ評価させるため（Supabase の推奨の書き方）
-- ------------------------------------------------------------

create policy soroban_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select app.my_household())::text
  );

create policy soroban_media_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select app.my_household())::text
  );

create policy soroban_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select app.my_household())::text
  );

create policy soroban_receipts_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select app.my_household())::text
  );

create policy soroban_receipts_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select app.my_household())::text
  );

create policy soroban_receipts_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select app.my_household())::text
  );
