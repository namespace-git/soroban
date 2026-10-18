import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { connectionOptions, fromPgClient, type PgClientLike, type PgQueryConfig } from '../../db/postgres'
import { toPositional } from '../../db/sql'

// node-postgres（pg）の Client の偽物。接続・SQL・切断を、流れた順に記録する。
// 本物の pg を PGlite につないだ確認（往復の数・型・エラーの形）は pg-driver.test.ts、2 つのドライバで同じ結果になることは db.test.ts ほか
interface FakeOptions {
  /** この SQL の文字列に当たったら、この例外を投げる */
  failOn?: (text: string) => Error | undefined
  connectError?: Error
  rowCount?: number | null
}

function fakeClient(options: FakeOptions = {}) {
  /** 'connect' / 'end' と、流れた SQL の文字列（業務の SQL も begin / commit / savepoint も） */
  const calls: string[] = []
  const queries: PgQueryConfig[] = []
  const listened: string[] = []
  let active = 0
  let overlapped = false
  const client: PgClientLike = {
    connect: async () => {
      calls.push('connect')
      if (options.connectError) throw options.connectError
    },
    query: async (config) => {
      // 1 本の接続に、前の SQL が終わる前に次を流していないか（pg は黙って待たせて非推奨の警告を出す）
      if (active > 0) overlapped = true
      active++
      try {
        await Promise.resolve()
        calls.push(config.text)
        queries.push(config)
        const error = options.failOn?.(config.text)
        if (error) throw error
        return { rows: [{ v: 1 }], rowCount: options.rowCount === undefined ? 1 : options.rowCount }
      } finally {
        active--
      }
    },
    end: async () => {
      calls.push('end')
    },
    on: (event) => {
      listened.push(event)
      return client
    },
  }
  return { client, calls, queries, listened, overlapped: () => overlapped }
}

describe('接続', () => {
  it('作っただけではつながない。最初の SQL で 1 回だけ connect する', async () => {
    const { client, calls } = fakeClient()
    const db = fromPgClient(client)
    expect(calls).toEqual([])
    await db.get('select 1')
    await db.get('select 2')
    await db.tx((tx) => tx.get('select 3'))
    expect(calls.filter((c) => c === 'connect')).toHaveLength(1)
    expect(calls[0]).toBe('connect')
  })

  it('トランザクションから始めても、begin の前に connect する', async () => {
    const { client, calls } = fakeClient()
    await fromPgClient(client).tx((tx) => tx.get('select 1'))
    expect(calls).toEqual(['connect', 'begin', 'select 1', 'commit'])
  })

  it('error と notice のイベントを受けて捨てる（聞く人がいない error はプロセスを落とす）', () => {
    const { client, listened } = fakeClient()
    fromPgClient(client)
    expect(listened.sort()).toEqual(['error', 'notice'])
  })

  it('一度も使わなければ end は何も閉じない。使ったあとは client.end を 1 回だけ（何度呼んでも）', async () => {
    const unused = fakeClient()
    await fromPgClient(unused.client).end()
    expect(unused.calls).toEqual([])

    const used = fakeClient()
    const db = fromPgClient(used.client)
    await db.get('select 1')
    await db.end()
    await db.end()
    expect(used.calls).toEqual(['connect', 'select 1', 'end'])
  })

  it('end は、走っている SQL・トランザクションが終わってから閉じる', async () => {
    const { client, calls } = fakeClient()
    const db = fromPgClient(client)
    const tx = db.tx(async (t) => {
      await t.get('select 1')
      void db.end() // 終わる前に閉じようとしても、トランザクションの途中では閉じない
      await t.get('select 2')
    })
    await tx
    await db.end()
    expect(calls).toEqual(['connect', 'begin', 'select 1', 'select 2', 'commit', 'end'])
  })

  it('end のあとの SQL は例外（つなぎ直さない）', async () => {
    const { client, calls } = fakeClient()
    const db = fromPgClient(client)
    await db.get('select 1')
    await db.end()
    await expect(db.get('select 2')).rejects.toThrow('閉じています')
    await expect(db.tx((tx) => tx.get('select 3'))).rejects.toThrow('閉じています')
    expect(calls).toEqual(['connect', 'select 1', 'end'])
  })

  it('つなぐのに失敗したら、SQL は同じ理由で失敗する（つなぎ直さない）。end は半端な状態を閉じる', async () => {
    const { client, calls } = fakeClient({ connectError: Object.assign(new Error('timeout expired'), { code: 'ETIMEDOUT' }) })
    const db = fromPgClient(client)
    await expect(db.get('select 1')).rejects.toThrow('timeout expired')
    await expect(db.tx((tx) => tx.get('select 2'))).rejects.toThrow('timeout expired')
    expect(calls).toEqual(['connect']) // SQL は 1 本も流れていない・connect は 1 回だけ
    await db.end()
    expect(calls).toEqual(['connect', 'end'])
  })
})

describe('extended protocol（引数が 0 個でも、複数の文を通さない）', () => {
  it('業務の SQL はすべて queryMode: extended。名前（prepared statement）は付けない', async () => {
    const { client, queries } = fakeClient()
    const db = fromPgClient(client)
    await db.get('select 1') // 引数 0 個
    await db.get('select ?::int', 5)
    await db.tx(async (tx) => {
      await tx.all('select 2')
      await tx.tx((inner) => inner.run('update t set a = ?', 1))
    })
    const business = queries.filter((q) => q.queryMode !== undefined || q.values !== undefined)
    expect(business.map((q) => q.text)).toEqual(['select 1', 'select $1::int', 'select 2', 'update t set a = $1'])
    for (const q of business) {
      expect(q.queryMode).toBe('extended')
      expect(Array.isArray(q.values)).toBe(true) // 引数が無くても []（simple query にならない）
      expect(Object.keys(q).sort()).toEqual(['queryMode', 'text', 'values']) // name・types・rowMode などは付けない
    }
    expect(business[0].values).toEqual([])
  })

  it('begin・commit・rollback・savepoint は固定の文字列。引数も queryMode も無い', async () => {
    const { client, queries } = fakeClient({ failOn: (text) => (text === 'boom' ? new Error('x') : undefined) })
    const db = fromPgClient(client)
    await db.tx(async (tx) => {
      await tx.tx((inner) => inner.get('select 1'))
    })
    await db.tx(async () => {
      throw new Error('fail')
    }).catch(() => {})
    const control = queries.filter((q) => q.queryMode === undefined)
    expect(control.map((q) => q.text)).toEqual(['begin', 'savepoint soroban_sp_1', 'release savepoint soroban_sp_1', 'commit', 'begin', 'rollback'])
    for (const q of control) expect(q).toEqual({ text: q.text })
  })

  it('引数：Date は ISO（UTC）、配列は配列リテラルの文字列、文字列・数値・null・JSON の文字列はそのまま', async () => {
    const { client, queries } = fakeClient()
    const json = JSON.stringify({ a: [1, 'x'] })
    await fromPgClient(client).run('insert into t values (?, ?, ?, ?, ?, ?, ?)', 'text', 5, null, new Date('2026-10-12T03:04:05.678Z'), ['a', 'b"c'], json, true)
    expect(queries[0].values).toEqual(['text', 5, null, '2026-10-12T03:04:05.678Z', '{"a","b\\"c"}', json, true])
    // jsonb に入れる文字列を、ここでもう一度 JSON.stringify しない（postgres.js の既定はしていて、二重に包まれて入った）
    expect(queries[0].values![5]).toBe('{"a":[1,"x"]}')
  })

  it('引数の数が合わない・undefined・オブジェクトは、DB に流す前に例外', async () => {
    const { client, calls } = fakeClient()
    const db = fromPgClient(client)
    await expect(db.get('select ?::int, ?::int', 1)).rejects.toThrow('プレースホルダ')
    await expect(db.get('select ?::text', undefined)).rejects.toThrow('undefined')
    await expect(db.get('select ?::text', { a: 1 })).rejects.toThrow('オブジェクト')
    expect(calls).toEqual([])
    expect(() => toPositional('select ?', 0)).toThrow() // 念のため：数が違う SQL は toPositional が先に断る
  })

  it('run の changes は rowCount（無ければ 0）', async () => {
    expect(await fromPgClient(fakeClient().client).run('update t set a = 1')).toEqual({ changes: 1 })
    expect(await fromPgClient(fakeClient({ rowCount: 7 }).client).run('delete from t')).toEqual({ changes: 7 })
    expect(await fromPgClient(fakeClient({ rowCount: null }).client).run('set x = 1')).toEqual({ changes: 0 })
  })
})

describe('トランザクション', () => {
  it('begin → fn の SQL → commit。入れ子は savepoint ～ release savepoint（名前は連番）。順番どおり', async () => {
    const { client, calls } = fakeClient()
    await fromPgClient(client).tx(async (tx) => {
      await tx.get('select 1')
      await tx.tx(async (inner) => {
        await inner.get('select 2')
        await inner.tx((deeper) => deeper.get('select 3'))
      })
      await tx.get('select 4')
    })
    expect(calls).toEqual([
      'connect',
      'begin',
      'select 1',
      'savepoint soroban_sp_1',
      'select 2',
      'savepoint soroban_sp_2',
      'select 3',
      'release savepoint soroban_sp_2',
      'release savepoint soroban_sp_1',
      'select 4',
      'commit',
    ])
  })

  it('savepoint の名前は、トランザクションごとに 1 から数え直す', async () => {
    const { client, queries } = fakeClient()
    const db = fromPgClient(client)
    for (let i = 0; i < 2; i++) await db.tx((tx) => tx.tx((inner) => inner.get('select 1')))
    expect(queries.filter((q) => q.text.startsWith('savepoint')).map((q) => q.text)).toEqual(['savepoint soroban_sp_1', 'savepoint soroban_sp_1'])
  })

  it('fn が例外なら rollback して再スロー。commit はしない', async () => {
    const { client, calls } = fakeClient()
    await expect(
      fromPgClient(client).tx(async (tx) => {
        await tx.run('insert into t values (1)')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(calls).toEqual(['connect', 'begin', 'insert into t values (1)', 'rollback'])
  })

  it('SQL が失敗した（トランザクションが中断した）ときも rollback して、その例外を再スロー', async () => {
    const dbError = Object.assign(new Error('division by zero'), { code: '22012' })
    const { client, calls } = fakeClient({ failOn: (text) => (text === 'select 1 / 0' ? dbError : undefined) })
    const failure = await fromPgClient(client).tx((tx) => tx.get('select 1 / 0')).then(() => undefined, (e: unknown) => e)
    expect(failure).toBe(dbError) // 包み直さない（code などがそのまま届く）
    expect(calls).toEqual(['connect', 'begin', 'select 1 / 0', 'rollback'])
  })

  it('入れ子の失敗：その savepoint まで戻して再スロー。外側は握って続けて、commit できる', async () => {
    const { client, calls } = fakeClient()
    await fromPgClient(client).tx(async (tx) => {
      await tx.run('insert into t values (1)')
      await expect(
        tx.tx(async (inner) => {
          await inner.run('insert into t values (2)')
          throw new Error('inner failed')
        }),
      ).rejects.toThrow('inner failed')
      await tx.run('insert into t values (3)')
    })
    expect(calls).toEqual([
      'connect',
      'begin',
      'insert into t values (1)',
      'savepoint soroban_sp_1',
      'insert into t values (2)',
      'rollback to savepoint soroban_sp_1',
      'release savepoint soroban_sp_1',
      'insert into t values (3)',
      'commit',
    ])
  })

  it('入れ子を巻き戻すのに失敗しても、利用者に見せるのは元の例外', async () => {
    const { client } = fakeClient({ failOn: (text) => (text.startsWith('rollback to') ? new Error('connection lost') : undefined) })
    await expect(
      fromPgClient(client).tx((tx) =>
        tx.tx(async () => {
          throw new Error('original')
        }),
      ),
    ).rejects.toThrow('original')
  })

  it('commit が失敗したら rollback を試して、commit の例外を再スロー', async () => {
    const serialization = Object.assign(new Error('could not serialize access'), { code: '40001' })
    const { client, calls } = fakeClient({ failOn: (text) => (text === 'commit' ? serialization : undefined) })
    const failure = await fromPgClient(client).tx((tx) => tx.get('select 1')).then(() => undefined, (e: unknown) => e)
    expect(failure).toBe(serialization)
    expect(calls).toEqual(['connect', 'begin', 'select 1', 'commit', 'rollback'])
  })

  it('rollback が失敗しても、元の例外を返す', async () => {
    const { client } = fakeClient({ failOn: (text) => (text === 'rollback' ? new Error('connection lost') : undefined) })
    await expect(
      fromPgClient(client).tx(async () => {
        throw new Error('original')
      }),
    ).rejects.toThrow('original')
  })

  it('begin が失敗したら fn は呼ばず、rollback もしない', async () => {
    const { client, calls } = fakeClient({ failOn: (text) => (text === 'begin' ? new Error('cannot begin') : undefined) })
    const fn = vi.fn()
    await expect(fromPgClient(client).tx(fn)).rejects.toThrow('cannot begin')
    expect(fn).not.toHaveBeenCalled()
    expect(calls).toEqual(['connect', 'begin'])
  })

  it('値を返す。入れ子の tx が終わる前に外側の sql を使うと例外', async () => {
    const { client } = fakeClient()
    const db = fromPgClient(client)
    expect(await db.tx(async (tx) => (await tx.get<{ v: number }>('select 1'))!.v)).toBe(1)
    await expect(
      db.tx(async (tx) => {
        await tx.tx(async () => {
          await tx.get('select 1')
        })
      }),
    ).rejects.toThrow('外側の sql')
  })

  it('トランザクションの途中に、外側の sql の SQL は割り込まない（同じ接続でも、トランザクションの外の SQL を中に混ぜない）', async () => {
    const { client, calls, overlapped } = fakeClient()
    const db = fromPgClient(client)
    let outside: Promise<unknown> | undefined
    await db.tx(async (tx) => {
      await tx.get('select inside-1')
      outside = db.get('select outside') // 待たせるだけ（await しない。await すると PGlite と同じく待ち続ける）
      await tx.get('select inside-2')
    })
    await outside
    expect(calls).toEqual(['connect', 'begin', 'select inside-1', 'select inside-2', 'commit', 'select outside'])
    expect(overlapped()).toBe(false)
  })

  it('トランザクションの外で Promise.all しても、1 本の接続に重ねて流さない（順に 1 つずつ）', async () => {
    const { client, calls, overlapped } = fakeClient()
    const db = fromPgClient(client)
    const results = await Promise.all([db.get('select 1'), db.get('select 2'), db.tx((tx) => tx.get('select 3')), db.get('select 4')])
    expect(results).toHaveLength(4)
    expect(calls).toEqual(['connect', 'select 1', 'select 2', 'begin', 'select 3', 'commit', 'select 4'])
    expect(overlapped()).toBe(false)
  })

  it('前の SQL が失敗しても、次の SQL は流れる', async () => {
    const { client, calls } = fakeClient({ failOn: (text) => (text === 'select bad' ? new Error('syntax error') : undefined) })
    const db = fromPgClient(client)
    const results = await Promise.allSettled([db.get('select bad'), db.get('select good')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(calls).toEqual(['connect', 'select bad', 'select good'])
  })
})

describe('onQuery（SQL の本数と時間を測る口）', () => {
  it('流した SQL 1 本ごとに 1 回。トランザクションの中・savepoint の中も数える（begin / commit / rollback / savepoint 自体は数えない）', async () => {
    const { client } = fakeClient()
    const onQuery = vi.fn()
    const db = fromPgClient(client, { onQuery })

    await db.get('select 1') // 外
    expect(onQuery).toHaveBeenCalledTimes(1)

    await db.tx(async (tx) => {
      await tx.get('select 2') // トランザクションの中
      await tx.all('select 3')
      await tx.tx(async (inner) => {
        await inner.get('select 4') // savepoint の中
        await inner.tx((deeper) => deeper.run('update t set a = 1')) // 入れ子の入れ子
      })
      await tx.get('select 5')
    })
    // 外 1 ＋ 中 2 ＋ savepoint 内 2 ＋ 戻って 1 ＝ 6 本
    expect(onQuery).toHaveBeenCalledTimes(6)

    // 失敗して rollback / rollback to savepoint になっても、増えるのは失敗した業務の SQL 1 本だけ
    onQuery.mockClear()
    const failing = fakeClient({ failOn: (text) => (text === 'select bad' ? new Error('x') : undefined) })
    const db2 = fromPgClient(failing.client, { onQuery })
    await db2.tx((tx) => tx.tx((inner) => inner.get('select bad'))).catch(() => {})
    expect(onQuery).toHaveBeenCalledTimes(1)
  })

  it('渡るのは時間（ミリ秒の数）ひとつだけ。SQL の文も引数も渡さない', async () => {
    const { client } = fakeClient()
    const onQuery = vi.fn()
    const db = fromPgClient(client, { onQuery })
    await db.tx((tx) => tx.get("select set_config('app.household_id', ?, true)", 'secret-household-id'))
    expect(onQuery).toHaveBeenCalledTimes(1)
    for (const call of onQuery.mock.calls) {
      expect(call).toHaveLength(1)
      expect(typeof call[0]).toBe('number')
      expect(Number.isFinite(call[0])).toBe(true)
      expect(call[0]).toBeGreaterThanOrEqual(0)
    }
    expect(JSON.stringify(onQuery.mock.calls)).not.toContain('secret-household-id')
  })

  it('かかった時間は、DB に流す前と戻ってきた後の差（待ち行列の待ちは含めない）', async () => {
    const { client } = fakeClient()
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(112.5)
    try {
      const onQuery = vi.fn()
      await fromPgClient(client, { onQuery }).get('select 1')
      expect(onQuery).toHaveBeenCalledWith(12.5)
    } finally {
      now.mockRestore()
    }
  })

  it('SQL が失敗しても、その 1 本の時間は数える。例外はそのまま出る', async () => {
    const { client } = fakeClient({ failOn: () => new Error('syntax error') })
    const onQuery = vi.fn()
    await expect(fromPgClient(client, { onQuery }).get('select oops')).rejects.toThrow('syntax error')
    expect(onQuery).toHaveBeenCalledTimes(1)
  })

  it('onQuery が投げても、クエリには影響しない', async () => {
    const { client } = fakeClient()
    const onQuery = vi.fn(() => {
      throw new Error('measurement broke')
    })
    const db = fromPgClient(client, { onQuery })
    expect(await db.get('select 1')).toEqual({ v: 1 })
    expect(await db.run('update t set a = 1')).toEqual({ changes: 1 })
    expect(onQuery).toHaveBeenCalledTimes(2)
  })

  it('省略すれば何もしない（時計も見ない）', async () => {
    const { client } = fakeClient()
    const now = vi.spyOn(performance, 'now')
    try {
      const db = fromPgClient(client)
      expect(await db.get('select 1')).toEqual({ v: 1 })
      expect(await db.tx((tx) => tx.tx((inner) => inner.get('select 1')))).toEqual({ v: 1 })
      expect(now).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it('connectionOptions には持ち込まれない（pg の設定に onQuery は混ざらない）', () => {
    const o = connectionOptions('postgres://u@localhost:5432/db', { onQuery: () => {} })
    expect(Object.keys(o)).not.toContain('onQuery')
  })
})

describe('connectionOptions', () => {
  const pooler = 'postgres://postgres.abc:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'

  it('既定：接続文字列・10 秒で諦める・application_name。プールは使わない', () => {
    const o = connectionOptions(pooler)
    expect(o.connectionString).toBe(pooler)
    expect(o.connectionTimeoutMillis).toBe(10_000)
    expect(o.application_name).toBe('soroban-api')
    expect(Object.keys(o)).not.toContain('max')
  })

  it('prepare は無視される（pg は名前付きの prepared statement を使わない。設定にも出てこない）', () => {
    expect(Object.keys(connectionOptions(pooler, { prepare: false })).sort()).toEqual(Object.keys(connectionOptions(pooler, { prepare: true })).sort())
    expect(Object.keys(connectionOptions(pooler, { prepare: false }))).not.toContain('prepare')
  })

  it('外部のホストは暗号化を必須にする（暗号化はするが証明書は検証しない＝libpq の require）。ローカル・Hyperdrive・URL に sslmode があるときは触らない', () => {
    expect(connectionOptions(pooler).ssl).toEqual({ rejectUnauthorized: false })
    expect(connectionOptions('postgres://u@localhost:5432/db').ssl).toBeUndefined()
    expect(connectionOptions('postgres://u@127.0.0.1:5432/db').ssl).toBeUndefined()
    expect(connectionOptions('postgres://u@[::1]:5432/db').ssl).toBeUndefined()
    expect(connectionOptions('postgres://u@abc123.hyperdrive.local:5432/db').ssl).toBeUndefined()
    expect(connectionOptions(`${pooler}?sslmode=verify-full`).ssl).toBeUndefined()
    expect(connectionOptions(`${pooler}?ssl=true`).ssl).toBeUndefined()
    expect(connectionOptions(pooler, { ssl: false }).ssl).toBe(false)
    expect(connectionOptions('postgres://u@localhost:5432/db', { ssl: 'require' }).ssl).toEqual({ rejectUnauthorized: false })
  })

  it('pg がその設定を読める：ユーザー・パスワード・ホスト・ポート・DB・application_name・SSL', () => {
    const client = new pg.Client(connectionOptions(pooler))
    expect(client.user).toBe('postgres.abc')
    expect(client.password).toBe('pw')
    expect(client.host).toBe('aws-0-ap-northeast-1.pooler.supabase.com')
    expect(client.port).toBe(6543)
    expect(client.database).toBe('postgres')
    expect((client as unknown as { connectionParameters: { application_name: string } }).connectionParameters.application_name).toBe('soroban-api')
    expect(client.ssl).toEqual({ rejectUnauthorized: false })
    // Hyperdrive は暗号化しない
    const hyper = new pg.Client(connectionOptions('postgres://hd:secret@abc123.hyperdrive.local:5432/postgres'))
    expect(hyper.ssl).toBe(false)
    expect(hyper.host).toBe('abc123.hyperdrive.local')
    // URL の sslmode=disable は URL に従う
    expect(new pg.Client(connectionOptions(`${pooler}?sslmode=disable`)).ssl).toBe(false)
  })
})

describe('型の読み出し（types.ts の約束。PGlite と同じ値）', () => {
  const types = connectionOptions('postgres://u@localhost:5432/db').types!
  /** OID の型定義は enum なので、数で引くときは通す */
  const read = (oid: number, text: string): unknown => types.getTypeParser(oid as never)(text)

  it('int8 は number。安全な整数を超えたら例外', () => {
    expect(read(20, '5750')).toBe(5750)
    expect(read(20, '-3')).toBe(-3)
    expect(() => read(20, '9007199254740993')).toThrow('整数で表せません')
  })

  it('date・timestamp は文字列のまま。timestamptz は UTC の ISO 文字列', () => {
    expect(read(1082, '2026-10-12')).toBe('2026-10-12')
    expect(read(1114, '2026-10-12 01:02:03')).toBe('2026-10-12 01:02:03')
    expect(read(1184, '2026-10-12 12:04:05+09')).toBe('2026-10-12T03:04:05.000Z')
    expect(read(1184, '2026-10-12 12:04:05.5+09')).toBe('2026-10-12T03:04:05.500Z')
    expect(read(1184, '2026-10-12 03:04:05.123456+00')).toBe('2026-10-12T03:04:05.123Z')
    expect(read(1184, '2026-10-12 08:34:05+05:30')).toBe('2026-10-12T03:04:05.000Z')
    expect(read(1184, 'infinity')).toBe('infinity') // 読めない形はそのまま
  })

  it('json / jsonb は JSON.parse した値', () => {
    expect(read(114, '{"a":[1,2]}')).toEqual({ a: [1, 2] })
    expect(read(3802, '"text"')).toBe('text')
    expect(read(3802, 'null')).toBeNull()
  })

  it('numeric は文字列のまま（金額は integer で持つので使わない）', () => {
    expect(read(1700, '1.50')).toBe('1.50')
  })

  it('配列：int8[] は number、date[]・timestamp[] は文字列、timestamptz[] は ISO、json[] は値。NULL は null のまま・多次元もそのまま', () => {
    expect(read(1016, '{1,2,NULL,3}')).toEqual([1, 2, null, 3])
    expect(read(1016, '{}')).toEqual([])
    expect(read(1016, '{{1,2},{3,4}}')).toEqual([[1, 2], [3, 4]])
    expect(() => read(1016, '{9007199254740993}')).toThrow('整数で表せません')
    expect(read(1182, '{2026-10-12,NULL}')).toEqual(['2026-10-12', null])
    expect(read(1115, '{"2026-10-12 01:02:03"}')).toEqual(['2026-10-12 01:02:03'])
    expect(read(1185, '{"2026-10-12 12:04:05+09","2026-10-12 03:04:05+00"}')).toEqual(['2026-10-12T03:04:05.000Z', '2026-10-12T03:04:05.000Z'])
    expect(read(199, '{"{\\"a\\":1}",NULL}')).toEqual([{ a: 1 }, null])
    expect(read(3807, '{"{\\"a\\":[1,2]}"}')).toEqual([{ a: [1, 2] }])
    expect(read(1231, '{1.50,2}')).toEqual(['1.50', '2']) // numeric[] も文字列（pg の既定は parseFloat）
  })

  it('それ以外は pg の既定のまま：int4 は number、bool は boolean、text[] は引用符・カンマ・NULL という文字列も正しく、uuid[] は文字列', () => {
    expect(read(23, '42')).toBe(42)
    expect(read(16, 't')).toBe(true)
    expect(read(701, '1.5')).toBe(1.5)
    expect(read(25, 'plain')).toBe('plain')
    expect(read(1009, '{a,"b c","d,e","f\\"g","NULL",""}')).toEqual(['a', 'b c', 'd,e', 'f"g', 'NULL', ''])
    expect(read(1009, '{a,NULL}')).toEqual(['a', null])
    expect(read(1007, '{1,2}')).toEqual([1, 2])
    expect(read(2951, '{00000000-0000-4000-8000-0000000000aa}')).toEqual(['00000000-0000-4000-8000-0000000000aa'])
  })

  it('binary 形式の要求には、組み込みの読み方を返す（上書きするのは text だけ）', () => {
    expect(types.getTypeParser(20, 'binary')).toBe(pg.types.getTypeParser(20, 'binary'))
  })

  it('pg.Client にクライアントごとに効く：グローバルの pg.types は書き換えない（既定は date が Date、int8 が文字列）', () => {
    const client = new pg.Client(connectionOptions('postgres://u@localhost:5432/db'))
    expect(client.getTypeParser(20)('5750')).toBe(5750)
    expect(client.getTypeParser(1082)('2026-10-12')).toBe('2026-10-12')
    // 設定をしていないクライアントや、プロセスの既定は元のまま
    expect(pg.types.getTypeParser(20)('5750')).toBe('5750')
    expect(pg.types.getTypeParser(1082)('2026-10-12')).toBeInstanceOf(Date)
    expect(new pg.Client('postgres://u@localhost/db').getTypeParser(20)('5750')).toBe('5750')
  })
})
