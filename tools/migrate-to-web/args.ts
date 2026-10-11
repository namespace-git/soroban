import { resolve } from 'node:path'

// 引数と環境変数。**秘密（接続文字列・JWT・anon キー）は環境変数だけから読み、ファイルに書かず、画面にも出さない**
// （このリポジトリは Public）。純粋な関数にして、Node 単体でテストできるようにしてある

export const USAGE = `そろばん デスクトップ版（SQLite）→ Web 版（Postgres / Supabase）データ移行

使い方
  pnpm migrate:web <soroban.db> <thumbs のフォルダ> --household <世帯の id>
  pnpm migrate:web <soroban.db> <thumbs のフォルダ> --dry-run

  <soroban.db>        デスクトップ版の「バックアップ」で書き出した zip を展開した中の soroban.db
  <thumbs のフォルダ>  同じ zip の中の thumbs フォルダ（画像）
  --household <id>    書き込み先の世帯 id（app.create_household が返した値）。空の世帯にだけ書ける
  --dry-run           試走。Postgres（PGlite）の上でだけ変換・書き込み・突き合わせを行う。本番には何も送らない
  --migrations <dir>  --dry-run が使うマイグレーションのフォルダ（既定: ./supabase/migrations）
  --image-map <file>  画像の対応表（元のファイル → 新しいパス）を JSON で書き出す（任意。秘密は入らない）

環境変数（--dry-run では要らない。ファイルに書かない）
  SOROBAN_DATABASE_URL   Supabase の接続文字列（Direct connection）。秘密
  SUPABASE_URL           Project URL（https://xxxx.supabase.co）
  SUPABASE_ANON_KEY      anon（publishable）キー
  SUPABASE_USER_JWT      Web 版にログインした利用者の JWT（Storage への書き込みに使う。1 時間ほどで切れる）

終了コード  0 = 全部一致して完了 / 1 = 失敗（不一致・空でない世帯・入力の誤りなど。何も書き込んでいない）`

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface CliArgs {
  help: boolean
  sqliteFile: string
  imagesDir: string
  householdId: string | null
  dryRun: boolean
  migrationsDir: string
  imageMapFile: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseArgs(argv: string[], cwd: string = process.cwd()): CliArgs {
  const positional: string[] = []
  const out: CliArgs = {
    help: false, sqliteFile: '', imagesDir: '', householdId: null, dryRun: false,
    migrationsDir: resolve(cwd, 'supabase', 'migrations'), imageMapFile: null,
  }
  const valueOf = (i: number, name: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} の値がありません`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : null
    const take = (): string => {
      if (inline !== null) return inline
      const v = valueOf(i, name)
      i++
      return v
    }
    switch (name) {
      case '--help':
      case '-h':
        out.help = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--household':
        out.householdId = take()
        break
      case '--migrations':
        out.migrationsDir = resolve(cwd, take())
        break
      case '--image-map':
        out.imageMapFile = resolve(cwd, take())
        break
      default:
        if (arg.startsWith('-')) throw new UsageError(`知らないオプションです: ${name}`)
        positional.push(arg)
    }
  }
  if (out.help) return out
  if (positional.length !== 2) {
    throw new UsageError('引数は 2 つ必要です：<soroban.db> と <thumbs のフォルダ>')
  }
  out.sqliteFile = resolve(cwd, positional[0])
  out.imagesDir = resolve(cwd, positional[1])
  if (out.householdId !== null && !UUID.test(out.householdId)) throw new UsageError('--household は uuid の形で指定してください')
  if (!out.dryRun && out.householdId === null) throw new UsageError('--household（書き込み先の世帯 id）が必要です。試走だけなら --dry-run')
  return out
}

export interface ProdEnv {
  databaseUrl: string
  supabaseUrl: string
  anonKey: string
  jwt: string
}

const ENV_NAMES = ['SOROBAN_DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_USER_JWT'] as const

/** 本番に書くときの環境変数。足りないものは**名前だけ**言う（値は出さない） */
export function readProdEnv(env: Record<string, string | undefined>): ProdEnv {
  const missing = ENV_NAMES.filter((n) => !env[n] || env[n]?.trim() === '')
  if (missing.length > 0) throw new UsageError(`環境変数が足りません: ${missing.join('、')}（--dry-run なら要りません）`)
  const databaseUrl = (env.SOROBAN_DATABASE_URL as string).trim()
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new UsageError('SOROBAN_DATABASE_URL は postgresql:// で始まる接続文字列にしてください')
  return {
    databaseUrl,
    supabaseUrl: (env.SUPABASE_URL as string).trim(),
    anonKey: (env.SUPABASE_ANON_KEY as string).trim(),
    jwt: (env.SUPABASE_USER_JWT as string).trim(),
  }
}

/** JWT の期限までの残り秒。読めなければ null（中身は検証しない。Storage が検証する） */
export function jwtSecondsLeft(jwt: string, nowMs: number = Date.now()): number | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? Math.floor(payload.exp - nowMs / 1000) : null
  } catch {
    return null
  }
}

/** 秘密を画面に出さないための置き換え。エラーの文などに、接続文字列・JWT・キーが混ざっていても伏せる */
export function secretsOf(env: ProdEnv): string[] {
  const secrets = [env.databaseUrl, env.anonKey, env.jwt]
  try {
    const url = new URL(env.databaseUrl)
    if (url.password) secrets.push(decodeURIComponent(url.password), url.password)
    secrets.push(url.hostname, url.host)
  } catch {
    // 読めない URL は、全体をそのまま伏せ字の対象にしてある
  }
  return secrets.filter((s) => s.length >= 6)
}

/** 長いものから置き換える（接続文字列の中のパスワードだけが先に消えて、残りが読めてしまうのを避ける） */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('***')
  return out
}
