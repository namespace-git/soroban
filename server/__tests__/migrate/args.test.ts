import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jwtSecondsLeft, parseArgs, readProdEnv, redact, secretsOf, UsageError } from '../../../tools/migrate-to-web/args'

// 引数と環境変数。秘密は環境変数だけから読み、画面に出さない

const HH = '11111111-2222-4333-8444-555555555555'
const CWD = resolve('/work/soroban')

describe('引数', () => {
  it('本番：soroban.db・画像のフォルダ・--household', () => {
    const a = parseArgs(['backup/soroban.db', 'backup/thumbs', '--household', HH], CWD)
    expect(a).toMatchObject({ dryRun: false, householdId: HH, help: false })
    expect(a.sqliteFile).toBe(resolve(CWD, 'backup/soroban.db'))
    expect(a.imagesDir).toBe(resolve(CWD, 'backup/thumbs'))
    expect(a.migrationsDir).toBe(join(CWD, 'supabase', 'migrations'))
  })

  it('--household=<id> の形も、順番が前後しても読める', () => {
    const a = parseArgs([`--household=${HH}`, 'a.db', 'thumbs'], CWD)
    expect(a.householdId).toBe(HH)
    expect(a.sqliteFile).toBe(resolve(CWD, 'a.db'))
  })

  it('--dry-run は世帯 id が要らない。--migrations と --image-map が読める', () => {
    const a = parseArgs(['a.db', 'thumbs', '--dry-run', '--migrations', 'm', '--image-map', 'map.json'], CWD)
    expect(a).toMatchObject({ dryRun: true, householdId: null })
    expect(a.migrationsDir).toBe(resolve(CWD, 'm'))
    expect(a.imageMapFile).toBe(resolve(CWD, 'map.json'))
  })

  it('本番で世帯 id が無い・uuid でない・引数の数が違う・知らないオプションは UsageError', () => {
    expect(() => parseArgs(['a.db', 'thumbs'], CWD)).toThrow(UsageError)
    expect(() => parseArgs(['a.db', 'thumbs', '--household', 'abc'], CWD)).toThrow(/uuid/)
    expect(() => parseArgs(['a.db', '--dry-run'], CWD)).toThrow(/2 つ必要/)
    expect(() => parseArgs(['a.db', 'thumbs', '--dry-run', '--force'], CWD)).toThrow(/知らないオプション/)
    expect(() => parseArgs(['a.db', 'thumbs', '--household'], CWD)).toThrow(/値がありません/)
  })

  it('--help は他の引数が無くても読める', () => {
    expect(parseArgs(['--help'], CWD).help).toBe(true)
  })
})

describe('環境変数', () => {
  const full = {
    SOROBAN_DATABASE_URL: 'postgresql://postgres:p%40ssw0rd-SECRET@db.abc.supabase.co:5432/postgres',
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_ANON-KEY-VALUE',
    SUPABASE_USER_JWT: 'aaa.eyJleHAiOjQxMDI0NDQ4MDB9.sig',
  }

  it('足りないものは名前だけ言う（値は出さない）', () => {
    expect(() => readProdEnv({ ...full, SUPABASE_USER_JWT: undefined, SUPABASE_ANON_KEY: ' ' })).toThrow(/SUPABASE_ANON_KEY、SUPABASE_USER_JWT/)
    try {
      readProdEnv({ ...full, SUPABASE_USER_JWT: '' })
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET')
    }
    expect(readProdEnv(full).databaseUrl).toBe(full.SOROBAN_DATABASE_URL)
  })

  it('接続文字列は postgresql:// の形でなければ断る（URL の中身は言わない）', () => {
    const err = (() => {
      try {
        readProdEnv({ ...full, SOROBAN_DATABASE_URL: 'mysql://user:SECRET-PASS@host/db' })
      } catch (e) {
        return e as Error
      }
      return null
    })()
    expect(err?.message).toContain('postgresql://')
    expect(err?.message).not.toContain('SECRET-PASS')
  })

  it('JWT の期限までの残り秒を読む。読めなければ null', () => {
    const exp = 2_000_000_000
    const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`
    expect(jwtSecondsLeft(jwt, (exp - 100) * 1000)).toBe(100)
    expect(jwtSecondsLeft(jwt, (exp + 5) * 1000)).toBe(-5)
    expect(jwtSecondsLeft('abc', 0)).toBeNull()
    expect(jwtSecondsLeft('a.b.c', 0)).toBeNull()
  })

  it('エラーの文に混ざった接続文字列・パスワード・JWT・キーは伏せる', () => {
    const env = readProdEnv(full)
    const secrets = secretsOf(env)
    const text = `connect ECONNREFUSED db.abc.supabase.co ${full.SOROBAN_DATABASE_URL} password=p@ssw0rd-SECRET jwt=${env.jwt} key=${env.anonKey}`
    const shown = redact(text, secrets)
    for (const s of ['p%40ssw0rd-SECRET', 'p@ssw0rd-SECRET', env.jwt, env.anonKey, 'db.abc.supabase.co']) expect(shown).not.toContain(s)
    expect(shown).toContain('***')
  })
})
