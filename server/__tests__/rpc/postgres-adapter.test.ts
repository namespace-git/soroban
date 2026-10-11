import { describe, expect, it } from 'vitest'
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
    expect([...byOid.keys()].sort()).toEqual([OID.int8, OID.date, OID.timestamp, OID.timestamptz].sort())
    expect(byOid.get(OID.int8)!.parse('5750')).toBe(5750)
    expect(byOid.get(OID.date)!.parse('2026-10-12')).toBe('2026-10-12')
    expect(byOid.get(OID.timestamp)!.parse('2026-10-12 01:02:03')).toBe('2026-10-12 01:02:03')
    expect(byOid.get(OID.timestamptz)!.parse('2026-10-12 12:04:05+09')).toBe('2026-10-12T03:04:05.000Z')
    // 引数の側：文字列はそのまま（JS のタイムゾーンで動かさない）、Date は ISO
    expect(byOid.get(OID.date)!.serialize('2026-10-12')).toBe('2026-10-12')
    expect(byOid.get(OID.timestamptz)!.serialize(new Date('2026-10-12T03:04:05.000Z'))).toBe('2026-10-12T03:04:05.000Z')
  })
})
