-- ============================================================
-- そろばん Web 版 — 消込（liability_settlement）の並び順
--
-- 1 回の入出金で複数の債務を消し込めて、画面は入力した順（CashEntry.settles）で見せる。
-- SQLite では liability_settlement の rowid（挿入順）で並べていたが、Postgres に rowid は無く、
-- 行は同じトランザクション（同じ now()）で入るので created_at でも決まらない。
-- sale_line.allocation_order と同じく、挿入のたびに増える番号を持つ。
-- 並べるのは入出金の中だけなので、値は連続しなくてよい（欠番は出る）。
-- ============================================================

alter table app.liability_settlement
  add column settle_order bigint generated always as identity;
