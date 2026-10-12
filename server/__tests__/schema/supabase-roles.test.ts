import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { createSupabaseStubs, listMigrations } from '../../test/migrate'

/**
 * 本物の Supabase では、マイグレーションを流す `postgres` は **superuser ではない**（CREATEROLE・CREATEDB・BYPASSRLS はある）。
 * PGlite の既定のユーザーは superuser なので、ふつうのテストではこの違いに気づけない
 * （2026-10-12、`alter role … nosuperuser` が本番の `supabase db push` で 42501 になって分かった）。
 * ここでは Supabase に似せた「superuser ではない postgres」を作り、その権限で全部のマイグレーションを流す。
 *
 * 似せ方：storage の表の持ち主は別のロール（本物は supabase_storage_admin）。postgres はそのメンバー
 * （storage.objects に方針を作れる）。auth.users は読む・参照するだけ
 */
async function supabaseLikeDb(): Promise<PGlite> {
  const db = new PGlite()
  await createSupabaseStubs(db)
  await db.exec(`
    create role storage_owner nologin;
    alter table storage.objects owner to storage_owner;
    alter table storage.buckets owner to storage_owner;
    alter function storage.foldername(text) owner to storage_owner;

    create role supa_postgres nologin nosuperuser createrole createdb bypassrls;
    grant storage_owner to supa_postgres;
    do $$ begin execute format('grant create on database %I to supa_postgres', current_database()); end $$;
    grant usage on schema auth, storage to supa_postgres;
    grant select, references on auth.users to supa_postgres;
    grant execute on function auth.uid() to supa_postgres;
  `)
  return db
}

describe('Supabase の postgres（superuser ではない）で流せる', () => {
  it('全部のマイグレーションが、superuser でないロールで最後まで流れる', async () => {
    const db = await supabaseLikeDb()
    await db.exec('set role supa_postgres')
    const failed: string[] = []
    for (const f of listMigrations()) {
      try {
        await db.exec(f.sql)
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
        break
      }
    }
    expect(failed).toEqual([])
    const r = await db.query<{ rolsuper: boolean }>(`select rolsuper from pg_roles where rolname = current_user`)
    expect(r.rows[0].rolsuper).toBe(false)
  })
})
