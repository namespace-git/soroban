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
 * 参照する分だけ作る：auth.users と、ロール anon / authenticated。
 * 本物の Supabase ではこれらは作らない（マイグレーションには入れない）
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
