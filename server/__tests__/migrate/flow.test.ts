import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NON_INTERACTIVE_MESSAGE, runZipFlow, type DbHandle, type FlowDeps, type FlowInput } from '../../../tools/migrate-to-web/flow'
import { PromptCancelled, type Prompter } from '../../../tools/migrate-to-web/prompt'
import { migrateToWeb, MigrationVerifyError, type MigrateOutput } from '../../../tools/migrate-to-web/migrate'
import type { MigrationReport } from '../../../tools/migrate-to-web/report'
import type { SourceSnapshot } from '../../../tools/migrate-to-web/types'
import { BackupZipError, type ExtractedBackup } from '../../../tools/migrate-to-web/zip'
import type { Sql } from '../../db/sql'
import { createMigratedDb } from '../../test/migrate'
import {
  createHouseholdFor, db, imagesForFixture, loadFixture, recordingUploader, snapshotFromFixture,
} from './helpers'

// `pnpm migrate:web <zip>` の通し（flow.ts）。外とのやり取り（zip・SQLite・本番の DB・Auth・Storage・端末）は全部偽物で、
// 試走と本番は本物の移行（PGlite 2 つ）で動かす。確かめること：
//   試走が一致しなければ本番につながない／yes 以外なら書かない／環境変数が優先／パスワード・JWT が出力に出ない

const fx = loadFixture()
const ITEM_SEQ = [{ key: 'item_code_seq', value: '99' }] // 在庫コードの採番の確認に要る設定だけ足す

const NOW = Date.UTC(2026, 9, 13, 3, 0, 0)
const SUPABASE_URL = 'https://projref.supabase.co'
const ANON_KEY = 'sb_publishable_TESTANONKEY0000'
const WRANGLER = `// 公開してよい値だけ\n{\n  "vars": { "SUPABASE_URL": "${SUPABASE_URL}", "SUPABASE_ANON_KEY": "${ANON_KEY}", },\n}\n`
const POOLER = 'postgresql://postgres.projref@aws-0-test.pooler.supabase.com:5432/postgres\n'

const DB_PASSWORD = 'Db-p@ss:w/ord#1?SECRET'
const LOGIN_EMAIL = 'owner@example.test'
const LOGIN_PASSWORD = 'Login-PW-SECRET-9'

function jwtFor(userId: string, issuedAtMs: number = NOW, ttlSeconds = 3600): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'ES256' })}.${part({ sub: userId, exp: Math.floor(issuedAtMs / 1000) + ttlSeconds })}.SIGNATURE-SECRET`
}

function emptyReport(ok: boolean): MigrationReport {
  return {
    dryRun: true, householdId: 'x', tables: [], sums: [], monthly: [], views: [], invariants: [],
    images: { total: 0, ready: 0, uploaded: 0, bytes: 0, missing: [] }, notes: [], notMigrated: [],
    settings: { migrated: 0, skipped: [] }, replacedShippingMethods: 0, ok,
  }
}

/** 本物の試走（PGlite）。deps.dryRun の既定 */
const realDryRun: FlowDeps['dryRun'] = async ({ snapshot, source, log }) => {
  const pg = await createMigratedDb()
  try {
    await pg.exec("set time zone 'UTC'")
    const { householdId } = await createHouseholdFor(pg, '試走')
    return await migrateToWeb({ sql: db(pg), householdId, snapshot, images: { source, uploader: null }, dryRun: true, log })
  } finally {
    await pg.close()
  }
}

interface HarnessOptions {
  /** 質問に順に答える。Error を入れると、その質問でそれを投げる（Ctrl-C など） */
  answers?: Array<string | Error>
  interactive?: boolean
  env?: Record<string, string | undefined>
  householdId?: string | null
  dryRunOnly?: boolean
  imageMapFile?: string | null
  /** null なら supabase/.temp/pooler-url が無い */
  pooler?: string | null
  dryRun?: FlowDeps['dryRun']
  migrate?: FlowDeps['migrate']
  patchSnapshot?: (snapshot: SourceSnapshot) => void
  /** データベースへの最初の接続確認が、この順に失敗する */
  dbFailures?: Error[]
  /** 世帯に入っていない人としてログインさせる */
  userWithoutHousehold?: boolean
  /** 質問に答えた後の時計の進み（ミリ秒）。ログインの期限切れの確認用 */
  clockJumpAfterYes?: number
}

async function makeHarness(options: HarnessOptions = {}) {
  const prodPg: PGlite = await createMigratedDb()
  await prodPg.exec("set time zone 'UTC'")
  const prod = await createHouseholdFor(prodPg, '本番の世帯')
  if (options.userWithoutHousehold) await prodPg.query('delete from app.household_member where user_id = $1', [prod.userId])

  const output: string[] = []
  const errors: string[] = []
  const questions: Array<{ kind: 'ask' | 'hidden'; question: string }> = []
  const answers = [...(options.answers ?? [])]
  let clock = NOW
  const opened: string[] = []
  let ended = 0
  const dbFailures = [...(options.dbFailures ?? [])]
  let loginCalls = 0
  const uploads = { made: [] as Array<{ url: string; anonKey: string; jwt: string }>, uploader: recordingUploader() }
  const written: Array<{ path: string; text: string }> = []
  const cleanup = vi.fn()
  const untrap = vi.fn()
  const extractZip = vi.fn((): ExtractedBackup => ({
    dir: '/tmp/fake', sqliteFile: '/tmp/fake/soroban.db', imagesDir: '/tmp/fake/thumbs', imageFiles: 3, skippedEntries: 0, cleanup,
  }))
  const migrateSpy = vi.fn(options.migrate ?? migrateToWeb)

  function nextAnswer(kind: 'ask' | 'hidden', question: string): string {
    questions.push({ kind, question })
    const a = answers.shift()
    if (a === undefined) throw new Error(`想定していない質問です: ${question}`)
    if (a instanceof Error) throw a
    if (a === 'yes' && options.clockJumpAfterYes) clock += options.clockJumpAfterYes
    return a
  }
  const prompter: Prompter = {
    ask: async (q) => nextAnswer('ask', q),
    askHidden: async (q) => nextAnswer('hidden', q),
  }

  const deps: FlowDeps = {
    extractZip,
    readSqlite: () => {
      const snapshot = snapshotFromFixture(fx, { tables: { setting: ITEM_SEQ } })
      options.patchSnapshot?.(snapshot)
      return snapshot
    },
    imageSource: () => imagesForFixture(fx),
    dryRun: options.dryRun ?? realDryRun,
    migrate: migrateSpy,
    openDatabase(url): DbHandle {
      opened.push(url)
      const sql = db(prodPg)
      const guarded: Sql = {
        ...sql,
        get: (async (text: string, ...params: unknown[]) => {
          if (text.startsWith('select 1 as ok') && dbFailures.length > 0) throw dbFailures.shift()
          return sql.get(text, ...params)
        }) as Sql['get'],
      }
      return { sql: guarded, end: async () => { ended++ } }
    },
    makeUploader(o) {
      uploads.made.push(o)
      return uploads.uploader
    },
    fetch: (async (_url: string, init: RequestInit) => {
      loginCalls++
      const body = JSON.parse(init.body as string) as { email: string; password: string }
      if (body.email === LOGIN_EMAIL && body.password === LOGIN_PASSWORD) {
        return new Response(JSON.stringify({ access_token: jwtFor(prod.userId, clock), refresh_token: 'REFRESH', user: { id: prod.userId } }), { status: 200 })
      }
      return new Response(JSON.stringify({ error_code: 'invalid_credentials' }), { status: 400 })
    }) as unknown as typeof fetch,
    readTextFile(path) {
      if (path.endsWith('wrangler.jsonc')) return WRANGLER
      if (path.endsWith('pooler-url')) return options.pooler === undefined ? POOLER : options.pooler
      return null
    },
    writeTextFile: (path, text) => void written.push({ path, text }),
    prompter: options.interactive === false ? null : prompter,
    print: (line) => void output.push(line),
    printError: (line) => void errors.push(line),
    now: () => clock,
    trapSignals: () => untrap,
  }

  const input: FlowInput = {
    zipFile: '/downloads/soroban-backup.zip',
    repoRoot: '/repo',
    migrationsDir: '/repo/supabase/migrations',
    imageMapFile: options.imageMapFile ?? null,
    dryRunOnly: options.dryRunOnly ?? false,
    householdId: options.householdId ?? null,
    env: options.env ?? {},
  }

  return {
    deps, input, prod, prodPg, questions, opened, extractZip, cleanup, untrap, migrateSpy, uploads, written,
    run: () => runZipFlow(input, deps),
    /** 画面に出たもの全部（標準出力＋標準エラー） */
    text: () => [...output, ...errors].join('\n'),
    /** 質問の文も含めた、利用者に見える文字の全部 */
    shown: () => [...output, ...errors, ...questions.map((q) => q.question)].join('\n'),
    ended: () => ended,
    loginCalls: () => loginCalls,
    remainingAnswers: () => answers.length,
    salesInProd: async (): Promise<number> =>
      (await prodPg.query<{ n: number }>('select count(*)::int as n from app.sale where household_id = $1', [prod.householdId])).rows[0].n,
  }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>
const made: Harness[] = []
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const h = await makeHarness(options)
  made.push(h)
  return h
}

afterEach(async () => {
  for (const h of made.splice(0)) await h.prodPg.close().catch(() => {})
})

let cachedDryRun: MigrateOutput
beforeAll(async () => {
  cachedDryRun = await realDryRun({
    snapshot: snapshotFromFixture(fx, { tables: { setting: ITEM_SEQ } }), source: imagesForFixture(fx), migrationsDir: '', log: () => {},
  })
})

const cached: FlowDeps['dryRun'] = async () => cachedDryRun
const happyAnswers = (): string[] => [DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD, 'yes']

function expectNoSecrets(text: string, extra: string[] = []): void {
  const secrets = [
    DB_PASSWORD, encodeURIComponent(DB_PASSWORD), LOGIN_PASSWORD, 'SIGNATURE-SECRET', 'aws-0-test.pooler.supabase.com', ANON_KEY, ...extra,
  ]
  for (const s of secrets) expect(text, `「${s}」が出力に出ている`).not.toContain(s)
}

describe('通し（試走 → 値を聞く → 確認 → 本番）', () => {
  it('zip を渡して、聞かれたものを入れて yes と答えると、本番に書けて、突き合わせが全部一致する', async () => {
    const h = await harness({ answers: happyAnswers() })
    const code = await h.run()
    expect(code, h.text()).toBe(0)

    // 質問の順：データベースのパスワード（伏せ字）→ メール → ログインのパスワード（伏せ字）→ 確認
    expect(h.questions.map((q) => q.kind)).toEqual(['hidden', 'ask', 'hidden', 'ask'])
    expect(h.questions[0].question).toContain('データベースのパスワード')
    expect(h.questions[3].question).toContain('yes')
    expect(h.remainingAnswers()).toBe(0)

    // 試走と本番の両方が「すべて一致しました」
    const text = h.text()
    expect(text.match(/すべて一致しました/g)).toHaveLength(2)
    expect(text.indexOf('■ 1. 試走')).toBeLessThan(text.indexOf('■ 2. 本番につなぐための入力'))
    expect(text.indexOf('■ 3. 確認')).toBeLessThan(text.indexOf('■ 4. 本番に書き込みます'))

    // 確認の文：世帯の先頭 8 文字と、件数
    const hh8 = h.prod.householdId.slice(0, 8)
    const dry = cachedDryRun.report
    const count = (t: string): number => dry.tables.find((x) => x.table === t)?.postgres ?? -1
    expect(text).toContain(
      `本番の世帯 ${hh8} に書きます。販売 ${count('sale')} 件・仕入 ${count('purchase')} 件・在庫 ${count('inventory_item')} 点・画像 ${dry.images.ready} 枚。`,
    )
    expect(count('sale')).toBe(fx.tables.sale.length)
    expect(text).not.toContain(h.prod.householdId) // 世帯の id は先頭 8 文字だけ

    // 本番（偽）に書かれている。画像も置いた
    expect(await h.salesInProd()).toBe(fx.tables.sale.length)
    expect(h.uploads.uploader.uploaded.length).toBe(dry.images.ready)
    expect(h.migrateSpy).toHaveBeenCalledTimes(1)
    const migrated = h.migrateSpy.mock.calls[0][0]
    expect(migrated.householdId).toBe(h.prod.householdId)
    expect(migrated.dryRun).toBe(false)
    expect(h.uploads.made).toEqual([{ url: SUPABASE_URL, anonKey: ANON_KEY, jwt: expect.stringContaining('.') }])

    // 接続文字列：pooler-url のユーザー・ホスト＋入力したパスワード（記号は URL エンコード）
    expect(h.opened).toHaveLength(1)
    const url = new URL(h.opened[0])
    expect(url.username).toBe('postgres.projref')
    expect(url.hostname).toBe('aws-0-test.pooler.supabase.com')
    expect(decodeURIComponent(url.password)).toBe(DB_PASSWORD)

    // 後片付け：接続を閉じた・一時フォルダを消した・シグナルの仕掛けを外した
    expect(h.ended()).toBe(1)
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.untrap).toHaveBeenCalledTimes(1)
    expect(text).toContain('このあと、利用者がすること')
  })

  it('パスワード・JWT・接続文字列・anon キー・接続先のホストは、画面にも質問の文にも出ない', async () => {
    const h = await harness({ answers: happyAnswers() })
    expect(await h.run(), h.text()).toBe(0)
    expectNoSecrets(h.shown(), [h.opened[0], jwtFor(h.prod.userId)])
    expect(h.shown()).not.toContain(LOGIN_EMAIL) // メールアドレスも画面には出さない（打った本人の端末には見えている）
  })

  it('試走の突き合わせが 1 つでも違えば、そこで止まる。本番につながない・何も聞かない・何も書かない', async () => {
    const h = await harness({
      answers: [],
      patchSnapshot: (s) => {
        const row = s.views.sale_profit.find((r) => r.gross_profit !== null) as Record<string, unknown>
        row.gross_profit = (row.gross_profit as number) + 1
      },
    })
    const code = await h.run()
    expect(code).toBe(1)
    expect(h.questions).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.loginCalls()).toBe(0)
    expect(h.migrateSpy).not.toHaveBeenCalled()
    expect(h.uploads.made).toEqual([])
    expect(await h.salesInProd()).toBe(0)
    expect(h.text()).toContain('不一致')
    expect(h.text()).toContain('本番にはつないでいません')
    expect(h.cleanup).toHaveBeenCalledTimes(1)
  })

  it('試走が「一致」を返さなかった（ok でない）ときも、本番につながない', async () => {
    const h = await harness({
      answers: [],
      dryRun: async () => ({ report: emptyReport(false), images: [] }),
    })
    expect(await h.run()).toBe(1)
    expect(h.questions).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.migrateSpy).not.toHaveBeenCalled()
  })

  it('試走が例外で落ちたときも、本番につながない（一時フォルダは消す）', async () => {
    const h = await harness({
      answers: [],
      dryRun: async () => {
        throw new Error('試走で壊れた')
      },
    })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('失敗: 試走で壊れた')
    expect(h.opened).toEqual([])
    expect(h.cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('確認（yes）', () => {
  it('yes 以外は、何も書かずに終わる（本番の DB・Storage・移行の関数に触れない）', async () => {
    for (const answer of ['no', '', 'y', 'yes please', 'はい', 'ｙｅｓ', 'yess']) {
      const h = await harness({ answers: [DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD, answer], dryRun: cached })
      const code = await h.run()
      expect(code, `「${answer}」`).toBe(1)
      expect(h.text()).toContain('何も書き込まずに終わります')
      expect(h.migrateSpy).not.toHaveBeenCalled()
      expect(h.uploads.made).toEqual([])
      expect(h.uploads.uploader.uploaded).toEqual([])
      expect(await h.salesInProd()).toBe(0)
      expect(h.ended()).toBe(1)
      expect(h.cleanup).toHaveBeenCalledTimes(1)
    }
  })

  it('yes は前後の空白・大文字小文字を許す', async () => {
    for (const answer of [' yes ', 'YES', 'Yes\t']) {
      const h = await harness({ answers: [DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD, answer], dryRun: cached })
      expect(await h.run(), h.text()).toBe(0)
      expect(h.migrateSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('確認に時間がかかってログインの期限が近づいたら、書かずに最初からやり直させる', async () => {
    const h = await harness({ answers: happyAnswers(), dryRun: cached, clockJumpAfterYes: 3400 * 1000 })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('ログインの期限')
    expect(h.migrateSpy).not.toHaveBeenCalled()
    expect(h.uploads.made).toEqual([])
    expect(await h.salesInProd()).toBe(0)
  })

  it('--yes のような、確認を飛ばす口は無い（質問に答えなければ書けない）', async () => {
    const h = await harness({ answers: [DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD], dryRun: cached })
    // 確認の質問に答えが用意されていない → 質問が出た時点で落ちる（= 質問は必ず出る）
    expect(await h.run()).toBe(1)
    expect(h.questions.at(-1)?.question).toContain('yes')
    expect(h.migrateSpy).not.toHaveBeenCalled()
  })
})

describe('対話できない場所・試走だけ', () => {
  it('対話できない（TTY でない）ときは、本番の形を日本語で断る。zip も開かない', async () => {
    const h = await harness({ interactive: false, answers: [], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('対話できる画面')
    expect(h.text()).toContain('SOROBAN_DATABASE_URL')
    expect(h.text()).toContain('--dry-run')
    expect(h.extractZip).not.toHaveBeenCalled()
    expect(h.opened).toEqual([])
    expect(NON_INTERACTIVE_MESSAGE).toContain('環境変数')
  })

  it('--dry-run は対話できなくても動く。何も聞かず、本番につながない。画像の対応表も書ける', async () => {
    const h = await harness({ interactive: false, dryRunOnly: true, imageMapFile: '/out/map.json' })
    expect(await h.run(), h.text()).toBe(0)
    expect(h.text()).toContain('すべて一致しました')
    expect(h.questions).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.loginCalls()).toBe(0)
    expect(h.migrateSpy).not.toHaveBeenCalled()
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.written).toHaveLength(1)
    expect(h.written[0].path).toBe('/out/map.json')
    const map = JSON.parse(h.written[0].text) as Array<Record<string, unknown>>
    expect(map.length).toBeGreaterThan(0)
    expect(Object.keys(map[0]).sort()).toEqual(['bucket', 'column', 'kind', 'path', 'rowKey', 'sourceFile', 'status', 'table'])
  })
})

describe('足りない値の集め方', () => {
  it('環境変数があれば聞かない（接続文字列・JWT）。公開の値も環境変数が優先', async () => {
    const envUrl = 'postgresql://soroban_gateway.projref:Env-DB-PASSWORD-SECRET@aws-0-env.pooler.supabase.com:5432/postgres'
    const h = await harness({ answers: ['yes'], dryRun: cached })
    const jwt = jwtFor(h.prod.userId)
    h.input.env = {
      SOROBAN_DATABASE_URL: envUrl,
      SUPABASE_USER_JWT: jwt,
      SUPABASE_URL: 'https://fromenv.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_FROM-ENV-KEY',
    }
    expect(await h.run(), h.text()).toBe(0)
    expect(h.questions.map((q) => q.kind)).toEqual(['ask']) // 確認だけ
    expect(h.opened).toEqual([envUrl])
    expect(h.loginCalls()).toBe(0)
    expect(h.uploads.made).toEqual([{ url: 'https://fromenv.supabase.co', anonKey: 'sb_publishable_FROM-ENV-KEY', jwt }])
    expect(await h.salesInProd()).toBe(fx.tables.sale.length)
    for (const s of [envUrl, 'Env-DB-PASSWORD-SECRET', jwt, 'aws-0-env.pooler.supabase.com', 'FROM-ENV-KEY']) expect(h.shown()).not.toContain(s)
  })

  it('環境変数の接続文字列の形が違う・JWT が期限切れなら、聞かずに日本語で止まる（値は出さない）', async () => {
    const bad = await harness({ answers: [], dryRun: cached })
    bad.input.env = { SOROBAN_DATABASE_URL: 'mysql://u:Secret-Value-1@h/db' }
    expect(await bad.run()).toBe(1)
    expect(bad.text()).toContain('postgresql://')
    expect(bad.text()).not.toContain('Secret-Value-1')

    const expired = await harness({ answers: [DB_PASSWORD], dryRun: cached })
    expired.input.env = { SUPABASE_USER_JWT: jwtFor(expired.prod.userId, NOW - 7200 * 1000) }
    expect(await expired.run()).toBe(1)
    expect(expired.text()).toContain('SUPABASE_USER_JWT')
    expect(expired.migrateSpy).not.toHaveBeenCalled()
  })

  it('supabase/.temp/pooler-url が無いときは、接続文字列を伏せ字で聞く（[YOUR-PASSWORD] のままでよい）', async () => {
    const pasted = 'postgresql://postgres.projref:[YOUR-PASSWORD]@aws-0-pasted.pooler.supabase.com:5432/postgres'
    const h = await harness({ pooler: null, answers: [pasted, DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD, 'yes'], dryRun: cached })
    expect(await h.run(), h.text()).toBe(0)
    expect(h.questions.map((q) => q.kind)).toEqual(['hidden', 'hidden', 'ask', 'hidden', 'ask'])
    expect(new URL(h.opened[0]).hostname).toBe('aws-0-pasted.pooler.supabase.com')
    expect(decodeURIComponent(new URL(h.opened[0]).password)).toBe(DB_PASSWORD)
    expect(h.shown()).not.toContain('aws-0-pasted.pooler.supabase.com')
  })

  it('接続文字列の形が読めなければ、日本語で止まる', async () => {
    const h = await harness({ pooler: null, answers: ['これは接続文字列ではない'], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('接続文字列の形が読めません')
    expect(h.opened).toEqual([])
  })
})

describe('データベースのパスワード', () => {
  const authError = Object.assign(new Error('password authentication failed for user "postgres.projref"'), { code: '28P01' })

  it('違っていたらもう一度聞く。合えば先へ進む', async () => {
    const h = await harness({
      dbFailures: [authError],
      answers: ['wrong-password-1', DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD, 'yes'],
      dryRun: cached,
    })
    expect(await h.run(), h.text()).toBe(0)
    expect(h.opened).toHaveLength(2)
    expect(h.text()).toContain('パスワードが違うようです')
    expect(h.text()).toContain('28P01')
    expect(h.ended()).toBe(2) // 失敗した接続も閉じた
    expect(h.shown()).not.toContain('wrong-password-1')
  })

  it('2 回続けて違えば止まる（重ねて試さない）。ログインには進まない', async () => {
    const h = await harness({ dbFailures: [authError, authError], answers: ['wrong-1', 'wrong-2'], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('パスワードが合いませんでした')
    expect(h.loginCalls()).toBe(0)
    expect(h.migrateSpy).not.toHaveBeenCalled()
    expect(h.shown()).not.toContain('wrong-1')
    expect(h.shown()).not.toContain('wrong-2')
  })

  it('通信の失敗（パスワードのせいではない）は、聞き直さずに止まる', async () => {
    const h = await harness({
      dbFailures: [Object.assign(new Error('connect ECONNREFUSED aws-0-test.pooler.supabase.com:5432'), { code: 'ECONNREFUSED' })],
      answers: [DB_PASSWORD], dryRun: cached,
    })
    expect(await h.run()).toBe(1)
    expect(h.questions).toHaveLength(1)
    expect(h.text()).toContain('ECONNREFUSED')
    expectNoSecrets(h.shown())
  })

  it('空のまま Enter は 1 回に数える', async () => {
    const h = await harness({ answers: ['', ''], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.opened).toEqual([])
    expect(h.text()).toContain('入力されませんでした')
  })
})

describe('ログイン', () => {
  it('メールアドレスかパスワードが違えばそう言って聞き直す（3 回まで）。合えば先へ進む', async () => {
    const h = await harness({
      answers: [DB_PASSWORD, LOGIN_EMAIL, 'wrong-login-1', LOGIN_EMAIL, LOGIN_PASSWORD, 'yes'],
      dryRun: cached,
    })
    expect(await h.run(), h.text()).toBe(0)
    expect(h.loginCalls()).toBe(2)
    expect(h.text()).toContain('メールアドレスかパスワードが違います')
    expect(h.shown()).not.toContain('wrong-login-1')
  })

  it('3 回続けて違えば止まる。本番には何も書かない', async () => {
    const wrong = [LOGIN_EMAIL, 'wrong-a', LOGIN_EMAIL, 'wrong-b', 'someone@example.test', 'wrong-c']
    const h = await harness({ answers: [DB_PASSWORD, ...wrong], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.loginCalls()).toBe(3)
    expect(h.text()).toContain('メールアドレスかパスワードが違います')
    expect(h.migrateSpy).not.toHaveBeenCalled()
    expect(await h.salesInProd()).toBe(0)
    for (const s of ['wrong-a', 'wrong-b', 'wrong-c']) expect(h.shown()).not.toContain(s)
    expect(h.ended()).toBe(1)
  })
})

describe('世帯', () => {
  it('ログインした人が入っていない世帯は引けない。日本語で止まる', async () => {
    const h = await harness({ userWithoutHousehold: true, answers: [DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('どの世帯にも入っていません')
    expect(h.text()).toContain('1-5')
    expect(h.migrateSpy).not.toHaveBeenCalled()
  })

  it('--household を付ければ、引かずにその世帯に書く', async () => {
    const h = await harness({ userWithoutHousehold: true, answers: [DB_PASSWORD, LOGIN_EMAIL, LOGIN_PASSWORD, 'yes'], dryRun: cached })
    h.input.householdId = h.prod.householdId.toUpperCase()
    expect(await h.run(), h.text()).toBe(0)
    expect(h.migrateSpy.mock.calls[0][0].householdId).toBe(h.prod.householdId)
  })

  it('書き込み先の世帯にすでにデータがあれば、画像も置かずに止まる（二重に流さない）', async () => {
    const h = await harness({ answers: happyAnswers(), dryRun: cached })
    await h.prodPg.query("insert into app.tag (household_id, name) values ($1, 'x')", [h.prod.householdId])
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('すでにデータがあります')
    expect(h.uploads.uploader.uploaded).toEqual([])
    expect(await h.salesInProd()).toBe(0)
    expect(h.ended()).toBe(1)
  })
})

describe('途中でやめたとき・失敗したとき', () => {
  it('Ctrl-C（入力の中止）は、何も書かずに終わる。一時フォルダは消す', async () => {
    const h = await harness({ answers: [DB_PASSWORD, LOGIN_EMAIL, new PromptCancelled()], dryRun: cached })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('中止しました')
    expect(h.migrateSpy).not.toHaveBeenCalled()
    expect(await h.salesInProd()).toBe(0)
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.ended()).toBe(1)
  })

  it('本番への書き込みが落ちても、その文に混ざったパスワード・JWT・接続文字列は伏せる', async () => {
    const h = await harness({
      answers: happyAnswers(),
      dryRun: cached,
      migrate: async (m) => {
        const jwt = h.uploads.made[0].jwt
        throw new Error(`書き込みに失敗: ${h.opened[0]} password=${DB_PASSWORD} jwt=${jwt} login=${LOGIN_PASSWORD} (世帯 ${m.householdId.slice(0, 8)})`)
      },
    })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('失敗: 書き込みに失敗')
    expect(h.text()).toContain('***')
    expectNoSecrets(h.shown(), [h.opened[0], h.uploads.made[0].jwt])
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.ended()).toBe(1)
  })

  it('本番の突き合わせで不一致なら、巻き戻して失敗にする（本番の失敗の文）', async () => {
    const h = await harness({
      answers: happyAnswers(),
      dryRun: cached,
      migrate: async () => {
        throw new MigrationVerifyError(emptyReport(false))
      },
    })
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('突き合わせで不一致がありました')
    expect(h.text()).not.toContain('本番にはつないでいません')
  })

  it('zip が使えない（危ない項目など）ときは、その理由をそのまま言って止まる', async () => {
    const h = await harness({ answers: [], dryRun: cached })
    h.deps.extractZip = () => {
      throw new BackupZipError('zip の中に危ない項目があります')
    }
    expect(await h.run()).toBe(1)
    expect(h.text()).toContain('zip の中に危ない項目があります')
    expect(h.opened).toEqual([])
    expect(h.questions).toEqual([])
  })
})
