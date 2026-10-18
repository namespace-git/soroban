import pg from 'pg'
import type { ClientConfig } from 'pg'
import { createSql, type DriverResult, type RootDriver, type Sql, type TxDriver } from './sql'
import { OID, PARSERS, parseInt8, parseRaw, parseTimestamptz } from './types'

/**
 * node-postgres（`pg`）の `Sql`。本番（Cloudflare Workers）で使う。
 *
 * **1 リクエストにつき 1 つ作り、終わったら `end()`**（Workers は接続をリクエストをまたいで共有できない）。
 * 接続は**最初に SQL を流すときに張る**（認証だけで終わるリクエストは DB に触らない）。
 *
 * postgres.js から入れ替えた理由：引数のある SQL は接続ごとに最初の 1 回、describe（Parse+Describe）で 1 往復してから
 * Bind+Execute でもう 1 往復していて、接続の最初には配列型の OID の問い合わせもあった。本番の SQL 1 本が約 17ms
 * （ほぼ往復の時間）なので、往復が効く。`pg` は引数のある SQL を Parse+Bind+Describe+Execute+Sync まとめて 1 往復で送り、
 * 配列（text[] など）の読み方も組み込みなので型の問い合わせが要らない。
 */
export interface PostgresSql extends Sql {
  /** 接続を閉じる。Workers では `waitUntil(db.end())` で、応答を返した後に閉じる */
  end(): Promise<void>
}

export interface PostgresOptions {
  /**
   * **無視される**（postgres.js のときの名残。呼び出し側を変えずに済ませるために型だけ残してある）。
   * `pg` は名前付きの prepared statement を使わない（引数のある SQL は名前の無い statement を 1 往復で流す）ので、
   * Hyperdrive・session モードのプーラ・transaction モードのプーラのどれの先でも同じように動く。
   */
  prepare?: boolean
  /**
   * 暗号化。未指定なら自動（URL に sslmode が無く、ローカルでも Hyperdrive でもないホストなら 'require'）。
   * 'require' は libpq と同じ意味：暗号化はするが、証明書は検証しない（Supabase のプーラの証明書は公開の CA に連ならない）
   */
  ssl?: 'require' | false
  /**
   * SQL を 1 本流し終えるたびに、DB にかかった時間（ミリ秒）を渡す。失敗した 1 本も数える。
   * 1 リクエストの本数と合計時間を測るためのもの（`server/entry.ts` がログに 1 行出す）。
   * トランザクションの中・savepoint の中も数える（begin / commit / rollback / savepoint 自体は数えない）。
   *
   * **渡るのは時間だけ**（SQL の文・引数・結果は渡さない）。省略すれば何もしない。
   * これが投げても、クエリには影響させない（握りつぶす）
   */
  onQuery?: (ms: number) => void
}

export function createPostgresSql(url: string, options: PostgresOptions = {}): PostgresSql {
  return fromPgClient(new pg.Client(connectionOptions(url, options)), options)
}

/**
 * 接続設定。
 *
 * - 接続は 1 リクエスト＝1 本（`pg.Client`。プールは使わない）。世帯のトランザクションが接続に張り付くので、これ以上要らない
 * - `types` … bigint を number、date・timestamp を文字列、timestamptz を ISO 文字列に、配列の要素にも同じ規則
 *   （`types.ts` の約束。PGlite と同じ値にする。`pg` の既定は bigint が文字列、date・timestamp が Date）。
 *   **クライアントごとの設定**で、`pg.types.setTypeParser`（プロセス全体）は触らない
 * - `ssl` … 帳簿のデータと DB のパスワードを平文で流さないよう、外部のホストなら暗号化を必須にする。
 *   URL に `sslmode` があれば `pg` がそちらに従う
 * - `connectionTimeoutMillis` … 接続は 10 秒で諦める
 */
export function connectionOptions(url: string, options: PostgresOptions = {}): ClientConfig {
  const result: ClientConfig = {
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    application_name: 'soroban-api',
    types: pgTypes(),
  }
  const ssl = options.ssl === undefined ? (needsSsl(url) ? 'require' : undefined) : options.ssl
  if (ssl === 'require') result.ssl = { rejectUnauthorized: false }
  else if (ssl === false) result.ssl = false
  return result
}

function needsSsl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false // 読めない URL は pg が自分で落とす
  }
  if (parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl')) return false
  const host = parsed.hostname
  // Hyperdrive の接続文字列（<id>.hyperdrive.local）は Worker 内の経路で、TLS は Hyperdrive が先の DB に対して張る
  return !(['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.hyperdrive.local'))
}

// ---- 型の読み出し（types.ts の約束を pg の `types` に） ----

// 配列型の OID（types.ts の OID は要素の型だけ）
const ARRAY_OID = { int8: 1016, date: 1182, timestamp: 1115, timestamptz: 1185, numeric: 1231, json: 199, jsonb: 3807 } as const
const TEXT_ARRAY_OID = 1009
const parseJson = (text: string): unknown => JSON.parse(text)

// pg 組み込みの読み方（型定義の oid は enum なので、数で引くときは通す）
const builtinParser = (oid: number, format?: 'text' | 'binary'): ((value: string) => unknown) =>
  pg.types.getTypeParser(oid as never, format) as (value: string) => unknown

/**
 * 配列の読み出し。要素は**文字列のまま** text[] の読み方（pg 組み込み。引用符・エスケープ・NULL・多次元に対応）で配列にしてから、
 * 要素ごとに `parseElement` を通す（NULL は null のまま）。
 */
function arrayOf(parseElement: (text: string) => unknown): (text: string) => unknown {
  const parseTextArray = builtinParser(TEXT_ARRAY_OID, 'text')
  const walk = (value: unknown): unknown => (Array.isArray(value) ? value.map(walk) : value === null ? null : parseElement(value as string))
  return (text) => walk(parseTextArray(text))
}

/** pg が読み出しのたびに引く `getTypeParser`。ここに無い型は pg の既定（int4 は number、bool は boolean、numeric は文字列 など） */
function pgTypes(): { getTypeParser: (oid: number, format?: 'text' | 'binary') => (value: string) => unknown } {
  const own = new Map<number, (text: string) => unknown>([
    ...Object.entries(PARSERS).map(([oid, parse]) => [Number(oid), parse] as const),
    [OID.json, parseJson],
    [OID.jsonb, parseJson],
    [ARRAY_OID.int8, arrayOf(parseInt8)],
    [ARRAY_OID.date, arrayOf(parseRaw)],
    [ARRAY_OID.timestamp, arrayOf(parseRaw)],
    [ARRAY_OID.timestamptz, arrayOf(parseTimestamptz)],
    // numeric は扱わない（スカラーと同じく文字列のまま。pg の既定は numeric[] だけ parseFloat する）
    [ARRAY_OID.numeric, arrayOf(parseRaw)],
    [ARRAY_OID.json, arrayOf(parseJson)],
    [ARRAY_OID.jsonb, arrayOf(parseJson)],
  ])
  return {
    getTypeParser: (oid, format) => {
      const parse = format === 'binary' ? undefined : own.get(oid)
      return parse ?? builtinParser(oid, format)
    },
  }
}

// ---- Sql ----

/** `fromPgClient` が使う `pg.Client` の最小の形（テストでは偽物を渡す） */
export interface PgClientLike {
  connect(): Promise<unknown>
  query(config: PgQueryConfig): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end(): Promise<void>
  on(event: 'error' | 'notice', listener: (...args: never[]) => void): unknown
}

export interface PgQueryConfig {
  text: string
  values?: unknown[]
  /** 'extended' … 引数が 0 個でも Parse/Bind/Execute で流す（pg は既定だと引数が無い SQL を simple query で送る） */
  queryMode?: 'extended'
}

/**
 * 作り済みの `pg.Client` を包む（テストでは偽物を渡す）。
 *
 * - **接続は最初に使うときに張る**（`connect()` は 1 回だけ。失敗したら、その後の SQL も同じ理由で失敗する）
 * - **1 本の接続を排他にする**。トランザクションの外の SQL も、トランザクション 1 つ分も、順に 1 つずつ流す
 *   （`pg` は流しているあいだに次を投げると黙って待たせて非推奨の警告を出すので、こちらで順番を守る。
 *   外側の `Sql` をトランザクションの中で await すると、PGlite と同じく待ち続ける）
 * - 業務の SQL は**常に extended protocol**（`queryMode: 'extended'`）。名前付きの prepared statement は使わない
 * - トランザクションは `begin` / `commit` / `rollback`、入れ子は `savepoint` の SQL。**中は必ず同じ接続**
 */
export function fromPgClient(client: PgClientLike, options: PostgresOptions = {}): PostgresSql {
  const onQuery = options.onQuery

  // 接続が途中で切れたときの 'error'（待っているクエリには pg が別に失敗を返す）。イベントを聞く人がいないと
  // プロセスの例外になるので、受けて捨てる。notice（NOTICE・WARNING）も捨てる
  client.on('error', () => {})
  client.on('notice', () => {})

  let connecting: Promise<unknown> | null = null
  let closed = false
  const connected = (): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('接続はすでに閉じています'))
    return (connecting ??= client.connect())
  }

  let tail: Promise<unknown> = Promise.resolve()
  /** 1 つずつ順に流す。前の仕事が失敗していても次は走る */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work)
    tail = result.catch(() => {})
    return result
  }

  /** begin・commit・rollback・savepoint。業務の SQL ではないので、数えない・引数は無い */
  const control = async (text: string): Promise<void> => {
    await client.query({ text })
  }

  const execute = async (text: string, params: unknown[]): Promise<DriverResult> => {
    // Date は ISO（UTC）で渡す。pg の既定は JS のタイムゾーンのオフセット付きで、timestamp（タイムゾーン無し）の列では
    // 実行する場所の時計の値になってしまう。文字列・数値・null は normalizeParam が整えた形のまま pg が送る
    const values = params.map((p) => (p instanceof Date ? p.toISOString() : p))
    const result = await client.query({ text, values, queryMode: 'extended' })
    return { rows: result.rows, changes: result.rowCount ?? 0 }
  }

  /** 流して返ってくるまで（結果を配列にする前まで）を測る。onQuery が無ければ時計も見ない */
  const timed = async <T>(work: () => Promise<T>): Promise<T> => {
    const started = onQuery ? performance.now() : 0
    try {
      return await work()
    } finally {
      if (onQuery) reportQuery(onQuery, performance.now() - started)
    }
  }

  function txDriver(): TxDriver {
    let counter = 0
    const self: TxDriver = {
      query: (text, params) => timed(() => execute(text, params)),
      // 入れ子は SQL の savepoint。名前は連番。内側が失敗したら、その savepoint まで戻して外側は続けられる
      // （pg の Client はトランザクションの状態を覚えないので、内側の失敗が外側に残ることはない）
      async savepoint<T>(fn: (driver: TxDriver) => Promise<T>) {
        const name = `soroban_sp_${++counter}`
        await control(`savepoint ${name}`)
        try {
          const value = await fn(self)
          await control(`release savepoint ${name}`)
          return value
        } catch (e) {
          try {
            await control(`rollback to savepoint ${name}`)
            await control(`release savepoint ${name}`)
          } catch {
            // 巻き戻しに失敗しても、利用者に見せるのは元の例外（外側のトランザクションがロールバックされる）
          }
          throw e
        }
      },
    }
    return self
  }

  const rollbackQuietly = async (): Promise<void> => {
    try {
      await control('rollback')
    } catch {
      // 接続が死んでいれば、サーバー側で捨てられる。元の例外を優先する
    }
  }

  const driver: RootDriver = {
    query: (text, params) =>
      exclusive(() =>
        timed(async () => {
          await connected()
          return execute(text, params)
        }),
      ),
    begin: <T>(fn: (driver: TxDriver) => Promise<T>) =>
      exclusive(async () => {
        await connected()
        await control('begin')
        let value: T
        try {
          value = await fn(txDriver())
        } catch (e) {
          await rollbackQuietly()
          throw e
        }
        try {
          await control('commit')
        } catch (e) {
          await rollbackQuietly()
          throw e
        }
        return value
      }),
  }

  const root = createSql(driver)
  let ending: Promise<void> | null = null
  return Object.assign(root, {
    end: () =>
      (ending ??= exclusive(async () => {
        closed = true
        // 一度も SQL を流していなければ、つながっていないので閉じるものが無い
        if (connecting === null) return
        // つなぐのに失敗していても、半端な状態を閉じる
        await connecting.catch(() => {})
        await client.end()
      })),
  })
}

/** 測定の呼び出し。測定のほうが投げても、クエリの成否には影響させない */
function reportQuery(onQuery: (ms: number) => void, ms: number): void {
  try {
    onQuery(ms)
  } catch {
    // 握りつぶす（測っているだけ）
  }
}
