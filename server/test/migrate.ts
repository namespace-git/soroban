import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

// Web 版のサーバー（Postgres）のテスト用。supabase/migrations の SQL を PGlite（WASM の Postgres）に
// 名前順で流す。マイグレーション自体は PGlite 向けに曲げない（本物の Supabase に流すものと同じ）

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url))

export interface MigrationFile {
  /** ファイル名（例 20261012000100_app_foundation.sql） */
  name: string
  sql: string
}

/** Supabase CLI の命名（YYYYMMDDHHMMSS_name.sql）のファイルを、名前順で返す */
export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(name)) {
        throw new Error(`マイグレーションの名前が Supabase CLI の形（YYYYMMDDHHMMSS_name.sql）ではありません: ${name}`)
      }
      return { name, sql: readFileSync(join(dir, name), 'utf8') }
    })
}

/**
 * Supabase には最初からあるが、素の Postgres（PGlite）には無いものを、マイグレーションが
 * 参照する分だけ作る：auth.users・auth.uid()、ロール anon / authenticated、
 * Storage（storage.buckets・storage.objects・storage.foldername()）。
 * 本物の Supabase ではこれらは作らない（マイグレーションには入れない）。
 *
 * auth.uid() と storage.foldername() は本物の定義と同じ。storage の表は本物の列のうち、
 * 方針の検証に要るものだけ（buckets.type の enum、objects の version・user_metadata の細部、
 * 所有者 supabase_storage_admin は省いた）。objects は本物と同じく RLS を有効にしてあり、
 * anon / authenticated には表の権限を出してある（通すかどうかは方針だけで決まる）
 */
export async function createSupabaseStubs(db: PGlite): Promise<void> {
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id    uuid primary key,
      email text
    );

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
    end
    $$;

    -- 本物の auth.uid()：JWT の sub（PostgREST・Storage が request.jwt.claims に入れる）
    create or replace function auth.uid() returns uuid
    language sql stable
    as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;

    create schema if not exists storage;
    create table if not exists storage.buckets (
      id                 text primary key,
      name               text not null,
      owner              uuid,
      created_at         timestamptz default now(),
      updated_at         timestamptz default now(),
      public             boolean default false,
      avif_autodetection boolean default false,
      file_size_limit    bigint,
      allowed_mime_types text[],
      owner_id           text
    );
    create unique index if not exists bname on storage.buckets (name);

    create table if not exists storage.objects (
      id               uuid primary key default gen_random_uuid(),
      bucket_id        text references storage.buckets (id),
      name             text,
      owner            uuid,
      created_at       timestamptz default now(),
      updated_at       timestamptz default now(),
      last_accessed_at timestamptz default now(),
      metadata         jsonb,
      path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
      version          text,
      owner_id         text,
      user_metadata    jsonb
    );
    create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
    alter table storage.objects enable row level security;

    -- 本物の storage.foldername()：パスの最後（ファイル名）を除いたフォルダの配列
    create or replace function storage.foldername(name text) returns text[]
    language plpgsql
    as $$
    declare
      _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1:array_length(_parts, 1) - 1];
    end
    $$;

    grant usage on schema auth, storage to anon, authenticated;
    grant all on storage.buckets, storage.objects to anon, authenticated;
  `)
}

/** マイグレーションを名前順に流す。流したファイル名を返す。失敗したらファイル名つきで投げる */
export async function migrate(db: PGlite, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const applied: string[] = []
  for (const file of listMigrations(dir)) {
    try {
      await db.exec(file.sql)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(`マイグレーション ${file.name} が失敗しました: ${reason}`, { cause: e })
    }
    applied.push(file.name)
  }
  return applied
}

/** 空の PGlite に Supabase の最小の土台を作り、マイグレーションを全部流して返す */
export async function createMigratedDb(): Promise<PGlite> {
  const db = new PGlite()
  await createSupabaseStubs(db)
  await migrate(db)
  return db
}
