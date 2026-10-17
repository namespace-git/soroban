import postgres from 'postgres'
import { createSql, type Driver, type Sql, type TxDriver } from './sql'
import { OID, PARSERS } from './types'

/**
 * postgres.js（porsager）の `Sql`。本番（Cloudflare Pages Functions）で使う。
 *
 * **1 リクエストにつき 1 つ作り、終わったら `end()`**（Workers は接続をリクエストをまたいで共有できない）。
 */
export interface PostgresSql extends Sql {
  /** 接続を閉じる。Pages Functions では `waitUntil(db.end())` で、応答を返した後に閉じる */
  end(): Promise<void>
}

export interface PostgresOptions {
  /**
   * 名前付きの prepared statement を使うか。**既定は true**（Cloudflare Hyperdrive 前提）。
   *
   * - 本番の第一候補：**Hyperdrive → Supabase の direct connection（または session モードのプーラ）**。
   *   このときは prepare ありのまま（Hyperdrive が接続を束ねるので、こちらで prepare を切る必要は無い）
   * - **Supabase の transaction モードのプーラ（Supavisor・port 6543）に直接つなぐなら `prepare: false`**。
   *   プーラはトランザクションごとに裏の接続を入れ替えるので、名前付き statement を別の接続で探して
   *   `prepared statement "…" does not exist` で落ちる。
   * - **Hyperdrive の先を transaction モードのプーラにしない**（二重のプーラ。Hyperdrive 側が不安定になりうるとしている）
   */
  prepare?: boolean
  /** 暗号化。未指定なら自動（URL に sslmode が無く、ローカルでも Hyperdrive でもないホストなら 'require'） */
  ssl?: 'require' | false
}

export function createPostgresSql(url: string, options: PostgresOptions = {}): PostgresSql {
  return fromPostgresJs(postgres(url, connectionOptions(url, options)), options)
}

/**
 * 接続設定。
 *
 * - `max: 1` … 1 リクエスト＝1 本。世帯のトランザクションが接続に張り付くので、これ以上要らない
 * - `fetch_types` は既定のまま（true）。`text[]` などの配列列を読むのに、配列型の OID を接続時に問い合わせる必要がある
 * - `types` … bigint を number、date・timestamp を文字列、timestamptz を ISO 文字列に
 *   （`types.ts` の約束。PGlite と同じ値にする。postgres.js の既定は bigint が文字列、date が Date）
 * - `ssl` … 帳簿のデータと DB のパスワードを平文で流さないよう、外部のホストなら暗号化を必須にする。
 *   URL に `sslmode` があればそちらに従う
 */
export function connectionOptions(
  url: string,
  options: PostgresOptions = {},
): postgres.Options<Record<string, postgres.PostgresType>> {
  const result: postgres.Options<Record<string, postgres.PostgresType>> = {
    max: 1,
    prepare: options.prepare ?? true,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'soroban-api' },
    types: postgresTypes(),
  }
  const ssl = options.ssl === undefined ? (needsSsl(url) ? 'require' : undefined) : options.ssl
  if (ssl !== undefined) result.ssl = ssl
  return result
}

function needsSsl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false // 読めない URL は postgres.js が自分で落とす
  }
  if (parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl')) return false
  const host = parsed.hostname
  // Hyperdrive の接続文字列（<id>.hyperdrive.local）は Worker 内の経路で、TLS は Hyperdrive が先の DB に対して張る
  return !(['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.hyperdrive.local'))
}

// 引数の側（serialize）は、文字列はそのまま・Date だけ ISO にする。
// 既定の date 型は `new Date(文字列).toISOString()` を通すので、'2026-10-12' が JS のタイムゾーンで動く恐れがある
const serializeAsIs = (x: unknown): string => (x instanceof Date ? x.toISOString() : String(x))

function postgresTypes(): Record<string, postgres.PostgresType> {
  const type = (name: keyof typeof OID): postgres.PostgresType => ({
    to: OID[name],
    from: [OID[name]],
    serialize: serializeAsIs,
    parse: PARSERS[OID[name]],
  })
  return {
    soroban_int8: type('int8'),
    soroban_date: type('date'),
    soroban_timestamp: type('timestamp'),
    soroban_timestamptz: type('timestamptz'),
    // json / jsonb の引数は、呼び出し側が JSON.stringify した文字列で渡す約束（types.ts の normalizeParam）。
    // postgres.js の既定はここでもう一度 JSON.stringify するので、文字列が「JSON の文字列」として二重に包まれて入る
    // （PGlite はそのまま入れるのでテストでは気づけない。2026-10-18、データ移行の本番だけ sale.raw が全行不一致になって分かった）
    soroban_json: {
      to: OID.json,
      from: [OID.json, OID.jsonb],
      serialize: (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x)),
      parse: (x: string) => JSON.parse(x),
    },
  }
}

/** 作り済みの postgres.js のクライアントを包む（テストでは偽物を渡す） */
export function fromPostgresJs(client: postgres.Sql, options: PostgresOptions = {}): PostgresSql {
  const prepare = options.prepare ?? true
  const root = createSql({
    ...driverOf(client, prepare),
    // トランザクションの中は、begin が渡す scoped（予約した 1 本の接続）だけを使う。
    // ここで外側の client に戻ると、別の接続に流れて世帯の文脈（set local）が効かない
    // postgres.js の戻り値の型は「Promise の配列なら中身を解く」型。fn は 1 つの Promise を返すので T のまま
    begin: <T>(fn: (driver: TxDriver) => Promise<T>) =>
      client.begin(async (scoped) => fn(txDriverOf(scoped, prepare))) as Promise<T>,
  })
  return Object.assign(root, { end: () => client.end() })
}

function txDriverOf(scoped: postgres.TransactionSql, prepare: boolean): TxDriver {
  return {
    ...driverOf(scoped, prepare),
    // 入れ子は postgres.js 自身の savepoint で張る（生の SQL の savepoint だと、内側の失敗を外側が覚えてしまい、
    // catch して続けても最後に全部ロールバックされる）。中でも渡された sp だけを使う
    savepoint: <T>(fn: (driver: TxDriver) => Promise<T>) =>
      scoped.savepoint(async (sp) => fn(txDriverOf(sp, prepare))) as Promise<T>,
  }
}

function driverOf(client: Pick<postgres.Sql, 'unsafe'>, prepare: boolean): Driver {
  return {
    async query(text, params) {
      // simple: false … 引数が 0 個でも extended protocol にする（simple だと複数文が通り、PGlite と挙動が分かれる）。
      // 型定義に無い実行時のオプション
      const result = await client.unsafe(text, params as never, { prepare, simple: false } as never)
      return { rows: Array.from(result) as Record<string, unknown>[], changes: result.count ?? 0 }
    },
  }
}
