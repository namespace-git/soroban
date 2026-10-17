import postgres from 'postgres'
import { describe, expect, it, vi } from 'vitest'
import { connectionOptions, fromPostgresJs } from '../../db/postgres'
import { OID } from '../../db/types'

// postgres.js の偽物。どのオブジェクト（外側の client／begin が渡す scoped／savepoint が渡す sp）で
// クエリが流れたかを記録する
function fakeClient() {
  const log: string[] = []
  const optionsSeen: unknown[] = []
  const make = (label: string): never => {
    const client = {
      unsafe: async (text: string, _params: unknown[], options: unknown) => {
        log.push(`${label}: ${text}`)
        optionsSeen.push(options)
        return Object.assign([{ v: 1 }], { count: 1 })
      },
      begin: async (cb: (sql: never) => unknown) => {
        log.push(`${label}: begin`)
        return cb(make('scoped'))
      },
      savepoint: async (cb: (sql: never) => unknown) => {
        log.push(`${label}: savepoint`)
        return cb(make('sp'))
      },
      end: async () => {},
    }
    return client as never
  }
  return { client: make('root'), log, optionsSeen }
}

describe('postgres.js のアダプタ', () => {
  it('トランザクションの中は、begin が渡す scoped だけを使う（外側の client に戻らない）', async () => {
    const { client, log } = fakeClient()
    const db = fromPostgresJs(client)
    await db.tx(async (tx) => {
      await tx.get('select 1')
      await tx.tx(async (inner) => {
        await inner.get('select 2')
        await inner.tx((deeper) => deeper.get('select 3'))
      })
      await tx.get('select 4')
    })
    expect(log).toEqual([
      'root: begin',
      'scoped: select 1',
      'scoped: savepoint',
      'sp: select 2',
      'sp: savepoint',
      'sp: select 3',
      'scoped: select 4',
    ])
    expect(log.filter((l) => l.startsWith('root: select'))).toEqual([])
  })

  it('トランザクションの外は外側の client を使う', async () => {
    const { client, log } = fakeClient()
    await fromPostgresJs(client).get('select 1')
    expect(log).toEqual(['root: select 1'])
  })

  it('入れ子の tx が終わる前に外側の sql を使うと例外', async () => {
    const { client } = fakeClient()
    await expect(
      fromPostgresJs(client).tx(async (tx) => {
        await tx.tx(async () => {
          await tx.get('select 1')
        })
      }),
    ).rejects.toThrow('外側の sql')
  })

  it('prepare の設定が各クエリに渡る（既定は prepare あり、simple は使わない）', async () => {
    const withPrepare = fakeClient()
    await fromPostgresJs(withPrepare.client).get('select 1')
    expect(withPrepare.optionsSeen).toEqual([{ prepare: true, simple: false }])

    const without = fakeClient()
    await fromPostgresJs(without.client, { prepare: false }).tx((tx) => tx.get('select 1'))
    expect(without.optionsSeen).toEqual([{ prepare: false, simple: false }])
  })

  it('run の changes は postgres.js の count', async () => {
    const { client } = fakeClient()
    expect(await fromPostgresJs(client).run('update t set a = 1')).toEqual({ changes: 1 })
  })
})

describe('onQuery（SQL の本数と時間を測る口）', () => {
  it('流した SQL 1 本ごとに 1 回。トランザクションの中・savepoint の中も数える（begin / savepoint 自体は数えない）', async () => {
    const { client } = fakeClient()
    const onQuery = vi.fn()
    const db = fromPostgresJs(client, { onQuery })

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
  })

  it('渡るのは時間（ミリ秒の数）ひとつだけ。SQL の文も引数も渡さない', async () => {
    const { client } = fakeClient()
    const onQuery = vi.fn()
    const db = fromPostgresJs(client, { onQuery })
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

  it('かかった時間は、DB に流す前と戻ってきた後の差', async () => {
    const { client } = fakeClient()
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(112.5)
    try {
      const onQuery = vi.fn()
      await fromPostgresJs(client, { onQuery }).get('select 1')
      expect(onQuery).toHaveBeenCalledWith(12.5)
    } finally {
      now.mockRestore()
    }
  })

  it('SQL が失敗しても、その 1 本の時間は数える。例外はそのまま出る', async () => {
    const failing = {
      unsafe: async () => {
        throw new Error('syntax error')
      },
      begin: async () => {},
      end: async () => {},
    } as never
    const onQuery = vi.fn()
    await expect(fromPostgresJs(failing, { onQuery }).get('select oops')).rejects.toThrow('syntax error')
    expect(onQuery).toHaveBeenCalledTimes(1)
  })

  it('onQuery が投げても、クエリには影響しない', async () => {
    const { client } = fakeClient()
    const onQuery = vi.fn(() => {
      throw new Error('measurement broke')
    })
    const db = fromPostgresJs(client, { onQuery })
    expect(await db.get('select 1')).toEqual({ v: 1 })
    expect(await db.run('update t set a = 1')).toEqual({ changes: 1 })
    expect(onQuery).toHaveBeenCalledTimes(2)
  })

  it('省略すれば何もしない（時計も見ない）', async () => {
    const { client } = fakeClient()
    const now = vi.spyOn(performance, 'now')
    try {
      expect(await fromPostgresJs(client).get('select 1')).toEqual({ v: 1 })
      expect(await fromPostgresJs(client, { prepare: false }).tx((tx) => tx.get('select 1'))).toEqual({ v: 1 })
      expect(now).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it('connectionOptions には持ち込まれない（postgres.js の設定に onQuery は混ざらない）', () => {
    const o = connectionOptions('postgres://u@localhost:5432/db', { onQuery: () => {} })
    expect(Object.keys(o)).not.toContain('onQuery')
  })
})

describe('connectionOptions', () => {
  const pooler = 'postgres://postgres.abc:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'

  it('既定：1 リクエスト 1 本・prepare あり（Hyperdrive 前提）', () => {
    const o = connectionOptions(pooler)
    expect(o.max).toBe(1)
    expect(o.prepare).toBe(true)
  })

  it('transaction モードのプーラ直なら prepare: false にできる', () => {
    expect(connectionOptions(pooler, { prepare: false }).prepare).toBe(false)
  })

  it('外部のホストは暗号化を必須にする。ローカル・Hyperdrive・URL に sslmode があるときは触らない', () => {
    expect(connectionOptions(pooler).ssl).toBe('require')
    expect(connectionOptions('postgres://u@localhost:5432/db').ssl).toBeUndefined()
    expect(connectionOptions('postgres://u@127.0.0.1:5432/db').ssl).toBeUndefined()
    expect(connectionOptions('postgres://u@abc123.hyperdrive.local:5432/db').ssl).toBeUndefined()
    expect(connectionOptions(`${pooler}?sslmode=verify-full`).ssl).toBeUndefined()
    expect(connectionOptions(pooler, { ssl: false }).ssl).toBe(false)
  })

  it('型：int8 は number、date・timestamp は文字列、timestamptz は ISO（numeric は触らない）', () => {
    const types = connectionOptions(pooler).types as Record<string, { to: number; from: number[]; parse: (x: string) => unknown; serialize: (x: unknown) => string }>
    const byOid = new Map(Object.values(types).map((t) => [t.from[0], t]))
    expect([...byOid.keys()].sort()).toEqual([OID.int8, OID.date, OID.timestamp, OID.timestamptz, OID.json].sort())
    expect(byOid.get(OID.int8)!.parse('5750')).toBe(5750)
    expect(byOid.get(OID.date)!.parse('2026-10-12')).toBe('2026-10-12')
    expect(byOid.get(OID.timestamp)!.parse('2026-10-12 01:02:03')).toBe('2026-10-12 01:02:03')
    expect(byOid.get(OID.timestamptz)!.parse('2026-10-12 12:04:05+09')).toBe('2026-10-12T03:04:05.000Z')
    // 引数の側：文字列はそのまま（JS のタイムゾーンで動かさない）、Date は ISO
    expect(byOid.get(OID.date)!.serialize('2026-10-12')).toBe('2026-10-12')
    expect(byOid.get(OID.timestamptz)!.serialize(new Date('2026-10-12T03:04:05.000Z'))).toBe('2026-10-12T03:04:05.000Z')
  })

  it('json / jsonb：文字列で渡した JSON を二重に包まない（postgres.js の既定は JSON.stringify し直す）', () => {
    const types = connectionOptions(pooler).types as Record<string, { to: number; from: number[]; parse: (x: string) => unknown; serialize: (x: unknown) => string }>
    const json = Object.values(types).find((t) => t.from.includes(OID.jsonb))!
    expect(json.from).toEqual([OID.json, OID.jsonb])
    expect(json.serialize('{"a":1}')).toBe('{"a":1}')
    expect(json.parse('{"a":1}')).toEqual({ a: 1 })
  })

  it('json / jsonb：postgres.js に渡したとき、jsonb の引数の serializer が文字列をそのまま通す', async () => {
    // postgres() は作っただけではつながらない。組み上がった serializers（既定に利用者の型を重ねたもの）を見る
    const client = postgres(pooler, connectionOptions(pooler))
    const serializers = (client.options as unknown as { serializers: Record<number, (x: unknown) => string> }).serializers
    expect(serializers[OID.jsonb]('{"a":1}')).toBe('{"a":1}')
    expect(serializers[OID.json]('{"a":1}')).toBe('{"a":1}')
    await client.end()
  })
})
