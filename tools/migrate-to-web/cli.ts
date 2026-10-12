import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPostgresSql } from '../../server/db/postgres'
import type { Sql } from '../../server/db/sql'
import {
  jwtSecondsLeft, parseArgs, readProdEnv, redact, secretsOf, UsageError, USAGE, type CliArgs, type ProdEnv,
} from './args'
import { DUMP_FLAG, dumpSqliteToJson } from './electron-sqlite'
import { imageMapJson, nextStepsText, runZipFlow } from './flow'
import { folderImageSource, SupabaseStorageUploader, type ImageUploader } from './images'
import { migrateToWeb, MigrationVerifyError } from './migrate'
import { createTerminalPrompter } from './prompt'
import { readSqlite } from './read-sqlite'
import { createRealDeps } from './real-deps'
import { formatReport } from './report'

// 実行の入口。run.mjs が、これを bundle して**普通の Node**で起動する（直接は動かさない）。
//
//   zip を渡す形（ふつう）… この Node のまま flow.ts を動かす。試走 → 値を聞く（パスワードは伏せ字）→ 確認（yes）→ 本番。
//                           SQLite を読むところだけ Electron の子プロセス（--dump-sqlite）にやらせる。
//                           Windows の Electron は端末（TTY）を持たず、パスワードを伏せて聞けないため（electron-sqlite.ts）
//   展開済みのファイルを渡す形（従来）… better-sqlite3 が Electron 向けにビルドされているので、全体を Electron
//                           （ELECTRON_RUN_AS_NODE=1）で動かし直す。環境変数 4 つと --household を自分で渡す
//   --dump-sqlite <db> <json> … 上の子プロセス。Electron でだけ動く（内部用）
//
// 本番に書くのは、利用者が自分の判断で流したときだけ。--dry-run は何も送らない

const isElectron = (): boolean => typeof process.versions.electron === 'string'

function electronPath(): string {
  return process.env.SOROBAN_MIGRATE_ELECTRON || (createRequire(import.meta.url)('electron') as string)
}

/** 自分（bundle）を Electron で動かし直す（従来の形）。標準入出力はそのまま渡す */
function rerunUnderElectron(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(electronPath(), [fileURLToPath(import.meta.url), ...argv], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    child.on('error', (e) => {
      console.error(`Electron を起動できません: ${e.message}`)
      resolve(1)
    })
  })
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)

  if (argv[0] === DUMP_FLAG) {
    if (!isElectron() || argv.length !== 3) {
      console.error(`${DUMP_FLAG} は内部用です（Electron の子プロセスとして動きます）`)
      return 2
    }
    dumpSqliteToJson(argv[1], argv[2])
    return 0
  }

  try {
    const args = parseArgs(argv)
    if (args.help) {
      console.log(USAGE)
      return 0
    }

    if (args.zipFile !== null) {
      // 対話できる端末のときだけ、聞く（パイプなどでは聞けない。flow が日本語で止める）
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
      return await runZipFlow(
        {
          zipFile: args.zipFile, repoRoot: args.repoRoot, migrationsDir: args.migrationsDir, imageMapFile: args.imageMapFile,
          dryRunOnly: args.dryRun, householdId: args.householdId, env: process.env,
        },
        createRealDeps(interactive ? createTerminalPrompter(process.stdin, process.stdout) : null),
      )
    }

    if (!isElectron()) return await rerunUnderElectron(argv)
    return await runExpanded(args)
  } catch (e) {
    // 引数の誤り（実行の失敗は、それぞれの中で表示して終了コードを返す）
    console.error(`\n失敗: ${e instanceof Error ? e.message : String(e)}`)
    if (e instanceof UsageError) console.error(`\n${USAGE}`)
    return 1
  }
}

/** 展開済みのファイル（<soroban.db> <thumbs>）を渡す従来の形。Electron の中で動く */
async function runExpanded(args: CliArgs): Promise<number> {
  let secrets: string[] = []
  try {
    const log = (line: string): void => console.log(line)

    // 本番に書くときの環境変数は、重い処理（SQLite の読み込み・画像）の前に確かめる
    let env: ProdEnv | null = null
    if (!args.dryRun) {
      env = readProdEnv(process.env)
      secrets = secretsOf(env)
      const left = jwtSecondsLeft(env.jwt)
      if (left === null) throw new UsageError('SUPABASE_USER_JWT が JWT の形ではありません')
      if (left <= 0) throw new UsageError('SUPABASE_USER_JWT の期限が切れています。Web 版にログインし直して、取り直してください')
      if (left < 300) throw new UsageError(`SUPABASE_USER_JWT の期限が近すぎます（あと ${left} 秒）。ログインし直して、取り直してください`)
    }

    log(`SQLite を読んでいます: ${args.sqliteFile}`)
    const snapshot = readSqlite(args.sqliteFile)
    const source = folderImageSource(args.imagesDir)

    let sql: Sql
    let householdId: string
    let uploader: ImageUploader | null = null
    let finish: () => Promise<void>

    if (args.dryRun || env === null) {
      // 試走：Postgres（PGlite）の上でだけ。本番には何も送らない
      const { openDryRunTarget } = await import('./dry-run-db')
      log('試走（--dry-run）：PGlite の上でだけ行います。本番には何も送りません')
      const target = await openDryRunTarget(args.migrationsDir)
      sql = target.sql
      householdId = target.householdId
      finish = () => target.close()
    } else {
      // Direct connection でも Session pooler（5432）でも Transaction pooler（6543）でも動くよう、prepared statement は使わない
      const db = createPostgresSql(env.databaseUrl, { prepare: false })
      sql = db
      householdId = args.householdId as string
      uploader = new SupabaseStorageUploader({ url: env.supabaseUrl, anonKey: env.anonKey, jwt: env.jwt })
      finish = () => db.end()
      log(`本番に書き込みます（世帯 ${householdId}）`)
    }

    try {
      const { report, images } = await migrateToWeb({
        sql, householdId, snapshot, images: { source, uploader }, dryRun: args.dryRun, log,
      })
      console.log(formatReport(report))
      if (args.imageMapFile) {
        writeFileSync(args.imageMapFile, imageMapJson(images))
        console.log(`画像の対応表を書き出しました: ${args.imageMapFile}`)
      }
      if (!args.dryRun) console.log(nextStepsText())
      return 0
    } finally {
      await finish()
    }
  } catch (e) {
    if (e instanceof MigrationVerifyError) {
      console.log(formatReport(e.report))
      console.error(`\n失敗: ${e.message}`)
      return 1
    }
    const message = e instanceof Error ? e.message : String(e)
    console.error(`\n失敗: ${redact(message, secrets)}`)
    if (e instanceof UsageError) console.error(`\n${USAGE}`)
    return 1
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    console.error(e)
    process.exitCode = 1
  },
)
