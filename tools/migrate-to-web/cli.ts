import { writeFileSync } from 'node:fs'
import { createPostgresSql } from '../../server/db/postgres'
import type { Sql } from '../../server/db/sql'
import {
  jwtSecondsLeft, parseArgs, readProdEnv, redact, secretsOf, UsageError, USAGE, type ProdEnv,
} from './args'
import { folderImageSource, SupabaseStorageUploader, type ImageUploader } from './images'
import { migrateToWeb, MigrationVerifyError } from './migrate'
import { readSqlite } from './read-sqlite'
import { formatReport } from './report'

// 実行の入口。ELECTRON_RUN_AS_NODE=1 の Electron で動く（better-sqlite3 が Electron 向けにビルドされているため）。
// run.mjs が、これを bundle して Electron で起動する。直接は動かさない。
//
// 本番に書くのは、利用者が自分の判断で流したときだけ。--dry-run は何も送らない

async function main(): Promise<number> {
  let secrets: string[] = []
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(USAGE)
      return 0
    }

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
        writeFileSync(args.imageMapFile, `${JSON.stringify(images.map(({ table, column, rowKey, kind, bucket, sourceFile, path, status }) =>
          ({ table, column, rowKey, kind, bucket, sourceFile, path, status })), null, 2)}\n`)
        console.log(`画像の対応表を書き出しました: ${args.imageMapFile}`)
      }
      if (!args.dryRun) printNextSteps()
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

function printNextSteps(): void {
  console.log([
    '',
    '■ このあと、利用者がすること',
    '  1. Web 版にログインして、ホーム・売上・在庫・月次の数字がデスクトップ版と同じか目で確かめる',
    '  2. 設定で API キー（Gemini・17TRACK）を入れ直す（デスクトップ版の鍵は端末で暗号化されていて移せない）',
    '  3. 確認が済むまで、デスクトップ版は消さない・使い続けない（移行後にデスクトップ版へ足したデータは Web 版に入らない）',
  ].join('\n'))
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
