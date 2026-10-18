import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_NAMES, openTestDb, type TestDb } from './helpers'

let db: TestDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.pg.exec('truncate public.typed')
})

// PGlite のアダプタと、本物の node-postgres（TCP のブリッジ経由）で、同じ結果になること
describe.each(DRIVER_NAMES)('Sql: %s', (name) => {
  const sql = () => db.drivers.find((d) => d.name === name)!.sql

  describe('get / all / run', () => {
    it('get は 1 行・無ければ undefined、all は全行、run は変更行数', async () => {
      const s = sql()
      expect(await s.run('insert into typed (id, amount) values (?, ?), (?, ?), (?, ?)', 1, 100, 2, 200, 3, 300)).toEqual({ changes: 3 })
      expect(await s.get<{ amount: number }>('select amount from typed where id = ?', 2)).toEqual({ amount: 200 })
      expect(await s.get('select amount from typed where id = ?', 99)).toBeUndefined()
      expect((await s.all<{ id: number }>('select id from typed order by id')).map((r) => r.id)).toEqual([1, 2, 3])
      expect(await s.run('update typed set amount = amount + ? where id >= ?', 1, 2)).toEqual({ changes: 2 })
      expect(await s.run('delete from typed where id = ?', 1)).toEqual({ changes: 1 })
      expect(await s.run('delete from typed where id = ?', 99)).toEqual({ changes: 0 })
    })

    it('文字列の中の ? は引数にならない', async () => {
      const r = await sql().get<{ q: string; a: string }>(`select 'what?' as q, ?::text as a`, 'x')
      expect(r).toEqual({ q: 'what?', a: 'x' })
    })

    it('jsonb は jsonb_exists() で書く', async () => {
      const r = await sql().get<{ has: boolean }>(`select jsonb_exists('{"a":1}'::jsonb, ?) as has`, 'a')
      expect(r?.has).toBe(true)
    })

    it('引数の数が合わなければ例外', async () => {
      await expect(sql().get('select ?::int, ?::int', 1)).rejects.toThrow('プレースホルダが 2 個ですが、引数は 1 個')
    })

    it('undefined・オブジェクトの引数は例外', async () => {
      await expect(sql().get('select ?::text', undefined)).rejects.toThrow('undefined')
      await expect(sql().get('select ?::text', { a: 1 })).rejects.toThrow('オブジェクト')
    })
  })

  describe('値の型（契約は number / string）', () => {
    it('count(*) と sum(integer) は number（bigint を文字列で返さない）', async () => {
      const s = sql()
      await s.run('insert into typed (id, amount) values (?, ?), (?, ?)', 1, 5000, 2, 750)
      const r = await s.get<{ n: unknown; total: unknown }>('select count(*) as n, sum(amount) as total from typed')
      expect(r).toEqual({ n: 2, total: 5750 })
      expect(typeof r?.n).toBe('number')
      expect(typeof r?.total).toBe('number')
      expect(r!.total as number).toBe(5000 + 750)
    })

    it('bigint が安全な整数を超えたら例外（黙って丸めない）', async () => {
      await expect(sql().get('select 9007199254740993::bigint as big')).rejects.toThrow('整数で表せません')
    })

    it('date は YYYY-MM-DD の文字列、timestamp は日時の文字列（Date オブジェクトにしない）', async () => {
      const s = sql()
      await s.run('insert into typed (id, amount, d, plain_ts) values (?, ?, ?, ?)', 1, 0, '2026-10-12', '2026-10-12 23:30:00')
      const r = await s.get<{ d: unknown; plain_ts: unknown }>('select d, plain_ts from typed where id = ?', 1)
      expect(r).toEqual({ d: '2026-10-12', plain_ts: '2026-10-12 23:30:00' })
    })

    it('timestamptz は UTC の ISO 文字列（接続の TimeZone が JST でも UTC でも同じ）', async () => {
      const s = sql()
      await s.run('insert into typed (id, amount, ts) values (?, ?, ?)', 1, 0, '2026-10-12 12:04:05.123+09')
      const r = await s.get<{ ts: unknown }>('select ts from typed where id = ?', 1)
      expect(r?.ts).toBe('2026-10-12T03:04:05.123Z')
      // 接続の TimeZone を変えても、読み出す文字列は同じ
      const jst = await s.tx(async (tx) => {
        await tx.run("set local timezone = 'Asia/Tokyo'")
        return tx.get<{ ts: unknown }>('select ts from typed where id = ?', 1)
      })
      const utc = await s.tx(async (tx) => {
        await tx.run("set local timezone = 'UTC'")
        return tx.get<{ ts: unknown }>('select ts from typed where id = ?', 1)
      })
      expect(jst?.ts).toBe('2026-10-12T03:04:05.123Z')
      expect(utc?.ts).toBe('2026-10-12T03:04:05.123Z')
    })

    it('Date の引数は ISO で渡る', async () => {
      const s = sql()
      await s.run('insert into typed (id, amount, ts) values (?, ?, ?)', 1, 0, new Date('2026-10-12T03:04:05.000Z'))
      expect((await s.get<{ ts: string }>('select ts from typed where id = ?', 1))?.ts).toBe('2026-10-12T03:04:05.000Z')
    })

    it('numeric は扱わない（どちらのドライバも文字列のまま。金額は integer で持つ）', async () => {
      const r = await sql().get<{ p: unknown; a: unknown }>('select 1.50::numeric as p, avg(x) as a from (values (1), (2)) v(x)')
      expect(r).toEqual({ p: '1.50', a: '1.5000000000000000' })
    })

    it('配列は text[] 列にそのまま入り、読み出しも配列。= any(?) にも渡せる', async () => {
      const s = sql()
      const tags = ['a', 'b c', 'd,e', 'f"g', 'NULL', '']
      await s.run('insert into typed (id, amount, tags) values (?, ?, ?)', 1, 0, tags)
      await s.run('insert into typed (id, amount, tags) values (?, ?, ?)', 2, 0, [])
      expect((await s.get<{ tags: string[] }>('select tags from typed where id = ?', 1))?.tags).toEqual(tags)
      expect((await s.get<{ tags: string[] }>('select tags from typed where id = ?', 2))?.tags).toEqual([])
      const ids = await s.all<{ id: number }>('select id from typed where id = any(?) order by id', [1, 2, 3])
      expect(ids.map((r) => r.id)).toEqual([1, 2])
    })
  })

  describe('トランザクション', () => {
    it('成功すれば確定、例外ならロールバックして再スロー', async () => {
      const s = sql()
      await s.tx(async (tx) => {
        await tx.run('insert into typed (id, amount) values (?, ?)', 1, 10)
      })
      await expect(
        s.tx(async (tx) => {
          await tx.run('insert into typed (id, amount) values (?, ?)', 2, 20)
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect((await s.all<{ id: number }>('select id from typed order by id')).map((r) => r.id)).toEqual([1])
    })

    it('tx の値を返す', async () => {
      expect(await sql().tx(async (tx) => (await tx.get<{ v: number }>('select 41 + 1 as v'))!.v)).toBe(42)
    })

    it('入れ子は savepoint：内側の失敗は内側だけ戻り、外側は続けて確定できる', async () => {
      const s = sql()
      await s.tx(async (tx) => {
        await tx.run('insert into typed (id, amount) values (?, ?)', 1, 10)
        await expect(
          tx.tx(async (inner) => {
            await inner.run('insert into typed (id, amount) values (?, ?)', 2, 20)
            throw new Error('inner')
          }),
        ).rejects.toThrow('inner')
        await tx.tx(async (inner) => {
          await inner.run('insert into typed (id, amount) values (?, ?)', 3, 30)
          // さらに入れ子
          await inner.tx(async (deeper) => {
            await deeper.run('insert into typed (id, amount) values (?, ?)', 4, 40)
          })
        })
      })
      expect((await s.all<{ id: number }>('select id from typed order by id')).map((r) => r.id)).toEqual([1, 3, 4])
    })

    it('DB のエラー（一意制約）で中断した内側を savepoint で戻せば、外側は続けられる', async () => {
      const s = sql()
      await s.tx(async (tx) => {
        await tx.run('insert into typed (id, amount) values (?, ?)', 1, 10)
        await expect(tx.tx((inner) => inner.run('insert into typed (id, amount) values (?, ?)', 1, 99))).rejects.toThrow()
        await tx.run('insert into typed (id, amount) values (?, ?)', 2, 20)
      })
      expect((await s.all<{ id: number; amount: number }>('select id, amount from typed order by id'))).toEqual([
        { id: 1, amount: 10 },
        { id: 2, amount: 20 },
      ])
    })

    it('外側が失敗すれば、成功した内側の savepoint も含めて全部戻る', async () => {
      const s = sql()
      await expect(
        s.tx(async (tx) => {
          await tx.tx((inner) => inner.run('insert into typed (id, amount) values (?, ?)', 1, 10))
          throw new Error('outer')
        }),
      ).rejects.toThrow('outer')
      expect(await s.all('select id from typed')).toEqual([])
    })

    it('同じトランザクションの中の Promise.all（並列）は例外。1 つずつ await すれば動く', async () => {
      const s = sql()
      await s.tx(async (tx) => {
        const results = await Promise.allSettled([tx.get<{ a: number }>('select 1 as a'), tx.get<{ a: number }>('select 2 as a')])
        // 1 本目は走り、重ねて投げた 2 本目は例外
        expect(results[0]).toMatchObject({ status: 'fulfilled', value: { a: 1 } })
        expect(results[1].status).toBe('rejected')
        expect(String((results[1] as PromiseRejectedResult).reason)).toContain('Promise.all')
        // 例外にしたあとも、1 つずつなら続けられる（トランザクションは壊れていない）
        expect(await tx.get<{ a: number }>('select 3 as a')).toEqual({ a: 3 })
      })
    })

    it('入れ子の tx が終わる前に外側の sql を使うのも例外（内側の sql を使う）。そのあとトランザクションは続けられる', async () => {
      const s = sql()
      await s.tx(async (tx) => {
        await expect(
          tx.tx(async () => {
            await tx.get('select 1')
          }),
        ).rejects.toThrow('外側の sql')
        expect(await tx.get<{ a: number }>('select 5 as a')).toEqual({ a: 5 })
      })
    })

    it('トランザクションの外の Promise.all は並列でよい', async () => {
      const s = sql()
      const r = await Promise.all([s.get<{ a: number }>('select 1 as a'), s.get<{ a: number }>('select 2 as a')])
      expect(r).toEqual([{ a: 1 }, { a: 2 }])
    })
  })
})
