import { join } from 'node:path'
import type { Sql } from '../../server/db/sql'
import { jwtSecondsLeft, redact, secretsOf, UsageError } from './args'
import {
  buildDatabaseUrl, describeConnectError, findHousehold, isAuthFailure, jwtSubject, LoginError, loginWithPassword,
  parsePoolerUrl, resolvePublicConfig, type DatabaseTarget, type PublicConfig,
} from './gather'
import type { ImageSource, ImageUploader, PlannedImage } from './images'
import { MigrationVerifyError, type MigrateInput, type MigrateOutput } from './migrate'
import { PromptCancelled, type Prompter } from './prompt'
import { formatReport } from './report'
import type { SourceSnapshot } from './types'
import { BackupZipError, type ExtractedBackup } from './zip'

// `pnpm migrate:web <バックアップの zip>`：1 回のコマンドで、移行の全部を通す。
//   1. zip を一時フォルダに取り出す（終わったら必ず消す）
//   2. 試走（PGlite。このパソコンの中だけ）→ 「すべて一致しました」でなければここで止める。本番にはつながない
//   3. 足りない値を聞く（環境変数があればそれを使う）：データベースのパスワード・ログイン（伏せ字）、世帯はログインした人から引く
//   4. 確認（yes と入力）。yes 以外なら何も書かない
//   5. 本番に書いて、突き合わせの結果を出す
// 秘密（パスワード・JWT・接続文字列）は変数にだけ持ち、画面・ログ・エラー文・ファイルに出さない（出力は全部 redact を通す）

export interface DbHandle {
  sql: Sql
  end(): Promise<void>
}

/** 外とのやり取りは全部ここから渡す（本番は real-deps.ts、テストは偽物） */
export interface FlowDeps {
  extractZip(zipFile: string): ExtractedBackup
  readSqlite(file: string): SourceSnapshot
  imageSource(dir: string): ImageSource
  /** 試走。PGlite の上でだけ行う。突き合わせが 1 つでも違えば MigrationVerifyError */
  dryRun(input: { snapshot: SourceSnapshot; source: ImageSource; migrationsDir: string; log: (line: string) => void }): Promise<MigrateOutput>
  /** 本番への書き込み（migrateToWeb） */
  migrate(input: MigrateInput): Promise<MigrateOutput>
  openDatabase(url: string): DbHandle | Promise<DbHandle>
  makeUploader(options: { url: string; anonKey: string; jwt: string }): ImageUploader
  fetch: typeof fetch
  /** 無ければ null */
  readTextFile(path: string): string | null
  writeTextFile(path: string, text: string): void
  /** 対話できる端末のときだけ。null なら聞けない */
  prompter: Prompter | null
  print(line: string): void
  printError(line: string): void
  now(): number
  /** 途中で Ctrl-C されたときに一時フォルダを消すための仕掛け。戻り値で外す */
  trapSignals(onSignal: () => void): () => void
}

export interface FlowInput {
  zipFile: string
  /** wrangler.jsonc と supabase/.temp/pooler-url を探すフォルダ */
  repoRoot: string
  migrationsDir: string
  imageMapFile: string | null
  /** --dry-run：試走だけで終わる（何も聞かない） */
  dryRunOnly: boolean
  /** --household：あれば、ログインした人から世帯を引かずにこれに書く */
  householdId: string | null
  env: Record<string, string | undefined>
}

export const NON_INTERACTIVE_MESSAGE =
  'zip だけを渡す形は、ターミナルで入力を聞きながら進めるので、対話できる画面（PowerShell・Windows Terminal など）で実行してください。' +
  'パイプや自動実行では、zip を展開して `pnpm migrate:web <soroban.db> <thumbs のフォルダ> --household <世帯の id>` で流してください' +
  '（環境変数 SOROBAN_DATABASE_URL・SUPABASE_URL・SUPABASE_ANON_KEY・SUPABASE_USER_JWT の 4 つが要ります）。' +
  '試走だけなら --dry-run を付ければ、対話できなくても動きます'

export function nextStepsText(): string {
  return [
    '',
    '■ このあと、利用者がすること',
    '  1. Web 版にログインして、ホーム・売上・在庫・月次の数字がデスクトップ版と同じか目で確かめる',
    '  2. 設定で API キー（Gemini・17TRACK）を入れ直す（デスクトップ版の鍵は端末で暗号化されていて移せない）',
    '  3. 確認が済むまで、デスクトップ版は消さない・使い続けない（移行後にデスクトップ版へ足したデータは Web 版に入らない）',
  ].join('\n')
}

/** 画像の対応表の JSON（秘密は入らない） */
export function imageMapJson(images: PlannedImage[]): string {
  return `${JSON.stringify(images.map(({ table, column, rowKey, kind, bucket, sourceFile, path, status }) =>
    ({ table, column, rowKey, kind, bucket, sourceFile, path, status })), null, 2)}\n`
}

const MIN_JWT_SECONDS = 300
const DB_PASSWORD_ATTEMPTS = 2
const LOGIN_ATTEMPTS = 3

/** 終了コードを返す（0 = 全部一致して完了、1 = 失敗・中止。失敗のとき本番には何も書いていない） */
export async function runZipFlow(input: FlowInput, deps: FlowDeps): Promise<number> {
  const secrets: string[] = []
  const addSecrets = (...values: string[]): void => {
    for (const v of values) if (v.length >= 4 && !secrets.includes(v)) secrets.push(v)
  }
  const say = (line: string): void => deps.print(redact(line, secrets))
  const complain = (line: string): void => deps.printError(redact(line, secrets))

  let extracted: ExtractedBackup | null = null
  let db: DbHandle | null = null
  let untrap: (() => void) | null = null
  let phase: 'dry-run' | 'production' = 'dry-run'
  try {
    if (!input.dryRunOnly && deps.prompter === null) throw new UsageError(NON_INTERACTIVE_MESSAGE)

    // ---- 1. zip を取り出す ----
    say(`バックアップを取り出しています: ${input.zipFile}`)
    extracted = deps.extractZip(input.zipFile)
    const temp = extracted
    untrap = deps.trapSignals(() => temp.cleanup())
    say(`  soroban.db と画像 ${extracted.imageFiles} 枚を、一時フォルダに取り出しました（終わったら消します）`)
    if (extracted.skippedEntries > 0) say(`  取り出さなかった項目: ${extracted.skippedEntries} 件（thumbs の中の、普通のファイル名でないもの）`)
    const source = deps.imageSource(extracted.imagesDir)

    // ---- 2. 試走 ----
    say('')
    say('■ 1. 試走（このパソコンの中だけで行います。本番には何も送りません）')
    say(`SQLite を読んでいます…`)
    const dry = await deps.dryRun({ snapshot: deps.readSqlite(extracted.sqliteFile), source, migrationsDir: input.migrationsDir, log: say })
    if (!dry.report.ok) throw new MigrationVerifyError(dry.report)
    say(formatReport(dry.report))
    if (input.dryRunOnly) {
      writeImageMap(dry)
      return 0
    }

    // ---- 3. 足りない値を集める ----
    phase = 'production'
    const prompter = deps.prompter as Prompter
    say('')
    say('■ 2. 本番につなぐための入力（パスワードは画面に出しません）')
    const pub = resolvePublicConfig(input.env, deps.readTextFile(join(input.repoRoot, 'wrangler.jsonc')))
    addSecrets(pub.anonKey)

    db = await connectDatabase()
    say('  データベースにつながりました')
    const login = await obtainLogin(pub)
    say('  ログインしました')
    const householdId = await resolveHousehold(db.sql, login.userId)

    // ---- 4. 確認 ----
    const count = (table: string): number => dry.report.tables.find((t) => t.table === table)?.postgres ?? 0
    const missing = dry.report.images.missing.length
    say('')
    say('■ 3. 確認')
    say(
      `本番の世帯 ${householdId.slice(0, 8)} に書きます。販売 ${count('sale')} 件・仕入 ${count('purchase')} 件・` +
        `在庫 ${count('inventory_item')} 点・画像 ${dry.report.images.ready} 枚。` +
        (missing > 0 ? `（見つからなかった画像 ${missing} 枚は除く）` : ''),
    )
    const answer = await prompter.ask('よろしければ yes と入力（それ以外は何もせずに終わります）: ')
    if (answer.trim().toLowerCase() !== 'yes') {
      say('yes ではなかったので、何も書き込まずに終わります')
      return 1
    }
    const left = jwtSecondsLeft(login.jwt, deps.now())
    if (left === null || left < MIN_JWT_SECONDS) {
      throw new UsageError('ログインの期限が近づいています（確認に時間がかかりました）。もう一度最初から実行してください')
    }

    // ---- 5. 本番に書く ----
    say('')
    say(`■ 4. 本番に書き込みます（世帯 ${householdId.slice(0, 8)}）`)
    const result = await deps.migrate({
      sql: db.sql,
      householdId,
      snapshot: deps.readSqlite(extracted.sqliteFile),
      images: { source, uploader: deps.makeUploader({ url: pub.supabaseUrl, anonKey: pub.anonKey, jwt: login.jwt }) },
      dryRun: false,
      log: say,
    })
    say(formatReport(result.report))
    writeImageMap(result)
    say(nextStepsText())
    return 0
  } catch (e) {
    if (e instanceof MigrationVerifyError) {
      say(formatReport(e.report))
      complain(
        phase === 'dry-run'
          ? '\n失敗: 試走の突き合わせで不一致がありました。本番にはつないでいません（何も書き込んでいません）'
          : `\n失敗: ${e.message}`,
      )
      return 1
    }
    if (e instanceof PromptCancelled) {
      complain('\n中止しました。本番には何も書き込んでいません')
      return 1
    }
    if (e instanceof UsageError || e instanceof BackupZipError || e instanceof LoginError) {
      complain(`\n失敗: ${e.message}`)
      return 1
    }
    complain(`\n失敗: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    // 後片付け：接続を閉じ、一時フォルダ（帳簿の写し）を消し、秘密を捨てる
    try {
      await db?.end()
    } catch {
      // 閉じられなくても、終わるだけ
    }
    untrap?.()
    extracted?.cleanup()
    secrets.length = 0
  }

  function writeImageMap(output: MigrateOutput): void {
    if (input.imageMapFile === null) return
    deps.writeTextFile(input.imageMapFile, imageMapJson(output.images))
    say(`画像の対応表を書き出しました: ${input.imageMapFile}`)
  }

  /** データベースのパスワードを聞いて、つなぐ（環境変数 SOROBAN_DATABASE_URL があればそれを使う） */
  async function connectDatabase(): Promise<DbHandle> {
    const prompter = deps.prompter as Prompter
    const fromEnv = input.env.SOROBAN_DATABASE_URL?.trim()
    if (fromEnv) {
      if (!/^postgres(ql)?:\/\//.test(fromEnv)) throw new UsageError('SOROBAN_DATABASE_URL は postgresql:// で始まる接続文字列にしてください')
      addSecrets(...secretsOfUrl(fromEnv))
      try {
        return await openChecked(fromEnv)
      } catch (e) {
        throw new UsageError(`データベースにつなげませんでした（${describeConnectError(e)}）。SOROBAN_DATABASE_URL を確かめてください`)
      }
    }

    let target: DatabaseTarget | null = parsePoolerUrl(deps.readTextFile(join(input.repoRoot, 'supabase', '.temp', 'pooler-url')) ?? '')
    if (target === null) {
      say('  supabase/.temp/pooler-url がありません（supabase link をしていない場所です）')
      const pasted = await prompter.askHidden(
        'Supabase の Connect → Session pooler の接続文字列を貼り付けてください（パスワードの部分は [YOUR-PASSWORD] のままでよい）: ',
      )
      addSecrets(pasted, ...secretsOfUrl(pasted))
      target = parsePoolerUrl(pasted)
      if (target === null) throw new UsageError('接続文字列の形が読めませんでした（postgresql://ユーザー名@ホスト:5432/postgres の形です）')
    }

    for (let attempt = 1; attempt <= DB_PASSWORD_ATTEMPTS; attempt++) {
      const password = await prompter.askHidden('データベースのパスワード（Supabase のプロジェクトを作ったときのもの）: ')
      if (password === '') {
        say('  入力されませんでした')
        continue
      }
      const url = buildDatabaseUrl(target, password)
      addSecrets(password, encodeURIComponent(password), url, ...secretsOfUrl(url))
      try {
        return await openChecked(url)
      } catch (e) {
        if (!isAuthFailure(e)) {
          throw new UsageError(`データベースにつなげませんでした（${describeConnectError(e)}）。ネットワークを確かめて、もう一度実行してください`)
        }
        say(`  データベースにつなげませんでした（${describeConnectError(e)}）。パスワードが違うようです`)
      }
    }
    throw new UsageError(
      'データベースのパスワードが合いませんでした。Supabase の Project Settings → Database で確かめて（忘れたときは同じ画面で再設定できます）、' +
        'もう一度実行してください',
    )
  }

  async function openChecked(url: string): Promise<DbHandle> {
    const handle = await deps.openDatabase(url)
    try {
      await handle.sql.get('select 1 as ok')
      return handle
    } catch (e) {
      await handle.end().catch(() => {})
      throw e
    }
  }

  /** Web 版のログイン（メールアドレスとパスワード）で JWT を取る。環境変数 SUPABASE_USER_JWT があればそれを使う */
  async function obtainLogin(pub: PublicConfig): Promise<{ jwt: string; userId: string }> {
    const prompter = deps.prompter as Prompter
    const fromEnv = input.env.SUPABASE_USER_JWT?.trim()
    if (fromEnv) {
      addSecrets(fromEnv)
      const userId = jwtSubject(fromEnv)
      const left = jwtSecondsLeft(fromEnv, deps.now())
      if (userId === null || left === null) throw new UsageError('SUPABASE_USER_JWT が JWT の形ではありません')
      if (left < MIN_JWT_SECONDS) throw new UsageError('SUPABASE_USER_JWT の期限が切れている（または近すぎる）ので、取り直してください')
      return { jwt: fromEnv, userId }
    }

    say('  Web 版にログインするメールアドレスとパスワードを入れてください（画像を Storage に置くのに使います）')
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
      const email = (await prompter.ask('ログインのメールアドレス: ')).trim()
      const password = await prompter.askHidden('ログインのパスワード: ')
      if (email === '' || password === '') {
        say('  入力されませんでした')
        continue
      }
      addSecrets(password)
      try {
        const result = await loginWithPassword({ fetch: deps.fetch, supabaseUrl: pub.supabaseUrl, anonKey: pub.anonKey, email, password })
        addSecrets(result.accessToken)
        return { jwt: result.accessToken, userId: result.userId }
      } catch (e) {
        if (e instanceof LoginError && e.retryable) {
          say(`  ${e.message}`)
          continue
        }
        throw e
      }
    }
    throw new UsageError('ログインできませんでした。メールアドレスかパスワードが違います（Supabase の Authentication → Users で確かめてください）')
  }

  async function resolveHousehold(sql: Sql, userId: string): Promise<string> {
    if (input.householdId !== null) return input.householdId.toLowerCase()
    let found: string | null
    try {
      found = await findHousehold(sql, userId)
    } catch (e) {
      throw new UsageError(
        `ログインした人の世帯を引けませんでした（${describeConnectError(e)}）。` +
          '--household <世帯の id> を付ければ、引かずにその世帯に書けます（世帯の id は SQL Editor の app.household で見られます）',
      )
    }
    if (found === null) {
      throw new UsageError(
        'ログインしたアカウントは、どの世帯にも入っていません。docs/web/01-setup.md の 1-5 で世帯を作り、このアカウントをメンバーに入れてから、もう一度実行してください',
      )
    }
    return found.toLowerCase()
  }
}

/** 接続文字列から、画面に出してはいけない部分（パスワード・ホスト）を取る */
function secretsOfUrl(url: string): string[] {
  return secretsOf({ databaseUrl: url, supabaseUrl: '', anonKey: '', jwt: '' })
}
