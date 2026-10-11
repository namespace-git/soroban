import { normalizeParam } from './types'

/**
 * better-sqlite3 と**同じ形**の DB インターフェース。
 * `src/main/db.ts` を Postgres に移すときの差分を `await` だけにするためのもの。
 * 実装は `postgres.ts`（本番・postgres.js）と `pglite.ts`（テスト・PGlite）。
 *
 * - SQL のプレースホルダは `?`。実装の中で `$1, $2 …` に置き換える（`toPositional`）
 * - **jsonb の `?` / `?|` / `?&` 演算子は使えない**（`?` はすべてプレースホルダとして数える）。
 *   `jsonb_exists(col, key)` / `jsonb_exists_any(col, keys)` / `jsonb_exists_all(col, keys)` を使うこと
 * - `tx` の中で渡される `Sql` を使う。**外側の `Sql` を tx の中で使うとロックを待って止まる**
 *   （PGlite は 1 本の接続を排他にするので、デッドロックで固まる）。
 *   postgres.js でも、トランザクションの中は `sql.begin(async scoped => …)` の `scoped` だけを使う（`postgres.ts`）
 * - **同じトランザクションの中で `Promise.all` による並列のクエリは禁止。** 1 本の接続に同時に流すと、
 *   1 つが失敗したときに残りが「トランザクションが中断している」で巻き込まれ、原因が分からなくなる。
 *   前のクエリが終わる前に次を投げると**例外**にする（`await` を 1 つずつ書く）。
 *   トランザクションの外（`tx` でない `Sql`）は接続が別々なので並列でよい
 * - 値は `types.ts` の約束で返る（int8 は number、date は文字列、timestamptz は ISO 文字列。numeric は文字列のまま＝使わない）
 */
export interface Sql {
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>
  /**
   * トランザクション。fn が例外を投げればロールバックして再スローする。
   * 入れ子は SAVEPOINT（内側だけを巻き戻す。better-sqlite3 の `db.transaction` と同じ）
   */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>
}

export interface DriverResult {
  rows: Record<string, unknown>[]
  changes: number
}

/** ドライバごとの違いはここだけ。`?` の置き換えと引数の検査は `createSql` が済ませてから渡す */
export interface Driver {
  query(text: string, params: unknown[]): Promise<DriverResult>
}

/** トランザクションの中の接続。入れ子（SAVEPOINT）を張れる */
export interface TxDriver extends Driver {
  /**
   * 入れ子のトランザクション（SAVEPOINT）。fn が投げたらその savepoint まで戻して再スローする。
   * postgres.js は**自分の `savepoint()` を使う**（`unsafe('savepoint …')` で張ると、内側のエラーを外側が
   * 「このトランザクションは失敗」と覚えてしまい、catch して続けても最後に全部ロールバックされる）。
   */
  savepoint<T>(fn: (driver: TxDriver) => Promise<T>): Promise<T>
}

export interface RootDriver extends Driver {
  /** 新しいトランザクション（begin … commit）。fn が投げたらロールバックして再スローする */
  begin<T>(fn: (driver: TxDriver) => Promise<T>): Promise<T>
}

/** SQL の `savepoint` 文で入れ子を張る `TxDriver`（PGlite 用。1 本の接続にそのまま流せるドライバ向け） */
export function savepointViaSql(driver: Driver): TxDriver {
  let counter = 0
  const self: TxDriver = {
    query: (text, params) => driver.query(text, params),
    async savepoint<T>(fn: (driver: TxDriver) => Promise<T>) {
      const name = `soroban_sp_${++counter}`
      await driver.query(`savepoint ${name}`, [])
      try {
        const value = await fn(self)
        await driver.query(`release savepoint ${name}`, [])
        return value
      } catch (e) {
        try {
          await driver.query(`rollback to savepoint ${name}`, [])
          await driver.query(`release savepoint ${name}`, [])
        } catch {
          // 巻き戻しに失敗しても、利用者に見せるのは元の例外（外側のトランザクションがロールバックされる）
        }
        throw e
      }
    },
  }
  return self
}

export function createSql(root: RootDriver): Sql {
  return build(root, null)
}

interface TxState {
  /** クエリが走っている間 true。重なって投げられたら例外にする（Promise.all の禁止） */
  busy: boolean
}

const PARALLEL_MESSAGE =
  '同じトランザクションの中で、前のクエリが終わる前に次のクエリを投げました（Promise.all で並列にせず、1 つずつ await してください）'
const OUTER_MESSAGE = '入れ子の tx が終わる前に、外側の sql を使いました（tx の中では、渡された内側の sql を使ってください）'

// state が null＝トランザクションの外。tx は新しく begin する。
// state があれば、すでにトランザクションの中なので tx は savepoint にする（state は入れ子の間で共有する＝接続は 1 本）
function build(driver: Driver, state: TxState | null): Sql {
  let childActive = false

  async function query(text: string, params: unknown[]): Promise<DriverResult> {
    if (state === null) return driver.query(text, params)
    if (childActive) throw new Error(OUTER_MESSAGE)
    if (state.busy) throw new Error(PARALLEL_MESSAGE)
    state.busy = true
    try {
      return await driver.query(text, params)
    } finally {
      state.busy = false
    }
  }

  async function run(text: string, params: unknown[]): Promise<DriverResult> {
    return query(toPositional(text, params.length), params.map(normalizeParam))
  }

  const sql: Sql = {
    async get<T>(text: string, ...params: unknown[]) {
      const r = await run(text, params)
      return r.rows[0] as T | undefined
    },
    async all<T>(text: string, ...params: unknown[]) {
      const r = await run(text, params)
      return r.rows as T[]
    },
    async run(text: string, ...params: unknown[]) {
      const r = await run(text, params)
      return { changes: r.changes }
    },
    async tx<T>(fn: (sql: Sql) => Promise<T>) {
      if (state === null) {
        return (driver as RootDriver).begin((inner) => fn(build(inner, { busy: false })))
      }
      if (childActive) throw new Error(OUTER_MESSAGE)
      if (state.busy) throw new Error(PARALLEL_MESSAGE)
      childActive = true
      try {
        return await (driver as TxDriver).savepoint((inner) => fn(build(inner, state)))
      } finally {
        childActive = false
      }
    },
  }
  return sql
}

const IDENT_CHAR = /[A-Za-z0-9_$]|[^\x00-\x7F]/
const DOLLAR_TAG = /\$(?:(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_]|[^\x00-\x7F])*)?\$/y
const DOLLAR_PARAM = /\$(\d+)/y

/**
 * `?` を `$1, $2 …` に置き換える。次の**中の `?` は置き換えない**。
 *
 * - 文字列リテラル `'…'`（`''` のエスケープ込み。`E'…'` は `\` のエスケープも）
 * - 引用識別子 `"…"`（`""` のエスケープ込み）
 * - 行コメント `-- …` と、入れ子になるブロックコメント `/* … *\/`
 * - ドル引用 `$$…$$` / `$tag$…$tag$`（関数の本体など）
 *
 * 扱っていないもの：`standard_conforming_strings = off` の素の `'…'` での `\` エスケープ
 * （Supabase は on）。jsonb の `?` 演算子（上の JSDoc のとおり使えない）。
 *
 * **引数の数とプレースホルダの数が合わなければ例外**にする（崩れた SQL を黙って投げない）。
 * すでに `$1` で書かれた SQL はそのまま通すが、`?` との混在は例外。
 */
export function toPositional(text: string, paramCount: number): string {
  const n = text.length
  let out = ''
  let i = 0
  let questions = 0
  let maxDollar = 0

  while (i < n) {
    const c = text[i]
    const next = text[i + 1]

    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += text.slice(i, stop)
      i = stop
      continue
    }

    if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      if (depth > 0) throw new Error(`SQL のコメント /* が閉じていません: ${preview(text)}`)
      out += text.slice(i, j)
      i = j
      continue
    }

    if (c === "'") {
      // E'…' だけ \ でエスケープできる（直前が E で、その E が識別子の一部でないとき）
      const escapes = (text[i - 1] === 'E' || text[i - 1] === 'e') && !(i >= 2 && IDENT_CHAR.test(text[i - 2]))
      let j = i + 1
      for (;;) {
        if (j >= n) throw new Error(`SQL の文字列 ' が閉じていません: ${preview(text)}`)
        const d = text[j]
        if (escapes && d === '\\') {
          j += 2
        } else if (d === "'") {
          if (text[j + 1] === "'") j += 2
          else break
        } else {
          j++
        }
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (c === '"') {
      let j = i + 1
      for (;;) {
        if (j >= n) throw new Error(`SQL の識別子 " が閉じていません: ${preview(text)}`)
        if (text[j] === '"') {
          if (text[j + 1] === '"') j += 2
          else break
        } else {
          j++
        }
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (c === '$') {
      // 識別子の途中の $（foo$bar）はドル引用でも引数でもない
      if (i > 0 && IDENT_CHAR.test(text[i - 1])) {
        out += c
        i++
        continue
      }
      DOLLAR_TAG.lastIndex = i
      const tag = DOLLAR_TAG.exec(text)
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        if (close === -1) throw new Error(`SQL のドル引用 ${tag[0]} が閉じていません: ${preview(text)}`)
        const end = close + tag[0].length
        out += text.slice(i, end)
        i = end
        continue
      }
      DOLLAR_PARAM.lastIndex = i
      const param = DOLLAR_PARAM.exec(text)
      if (param) {
        maxDollar = Math.max(maxDollar, Number(param[1]))
        out += param[0]
        i += param[0].length
        continue
      }
      out += c
      i++
      continue
    }

    if (c === '?') {
      questions++
      out += `$${questions}`
      i++
      continue
    }

    out += c
    i++
  }

  if (questions > 0 && maxDollar > 0) throw new Error(`SQL に ? と $n が混ざっています: ${preview(text)}`)
  const expected = questions > 0 ? questions : maxDollar
  if (expected !== paramCount) {
    throw new Error(`SQL のプレースホルダが ${expected} 個ですが、引数は ${paramCount} 個です: ${preview(text)}`)
  }
  return out
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat
}
