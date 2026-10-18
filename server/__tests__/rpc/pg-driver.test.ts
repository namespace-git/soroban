import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPostgresSql } from '../../db/postgres'
import { openPglite, type PgliteSql } from '../../db/pglite'
import type { Sql } from '../../db/sql'
import { describeError, mapDbError, readDbError } from '../../errors'
import { setupSchema, startBridge, type Bridge } from './helpers'

// 本物の node-postgres（pg）を、PGlite を TCP で見せたブリッジにつないで確かめる（server/db/postgres.ts）。
//   (1) 往復の数：引数のある SQL・無い SQL とも、Parse+Bind+Describe+Execute+Sync を 1 回の送信で流す（describe の往復が無い）
//   (2) 型：PGlite のアダプタと同じ値で読める（配列も）
//   (3) jsonb に入れる JSON の文字列を二重に包まない
//   (4) エラー：SQLSTATE・制約名・表名が PGlite と同じ形で届き、errors.ts の対応表がそのまま効く
//   (5) 後始末：1 本の接続を排他にする・トランザクションの外の SQL が中に混ざらない・つなげないときも end が返る

let pglite: PgliteSql
let bridge: Bridge
const opened: Array<{ end(): Promise<void> }> = []

function connect(): ReturnType<typeof createPostgresSql> {
  const db = createPostgresSql(bridge.url)
  opened.push(db)
  return db
}

beforeAll(async () => {
  pglite = await openPglite()
  await setupSchema(pglite.pg)
  await pglite.pg.exec(`
    create table public.pgtest_parent (id int primary key);
    create table public.pgtest_child (
      id int primary key,
      parent_id int references public.pgtest_parent (id),
      name text unique
    );
    create table public.pgtest_doc (id int primary key, body jsonb, plain json, tags text[]);
    create function public.pgtest_p0001() returns void language plpgsql as $$ begin raise exception 'english message'; end $$;
    create function public.pgtest_sb001() returns void language plpgsql
      as $$ begin raise exception '取り込み中です' using errcode = 'SB001', detail = 'あと 42 秒'; end $$;
    create function public.pgtest_40001() returns void language plpgsql
      as $$ begin raise exception 'could not serialize' using errcode = '40001'; end $$;
  `)
  bridge = await startBridge(pglite.pg)
})

afterAll(async () => {
  for (const db of opened) await db.end()
  await bridge.close()
  await pglite.close()
})

beforeEach(async () => {
  await pglite.pg.exec('truncate public.pgtest_child, public.pgtest_parent, public.pgtest_doc, public.typed')
})

/** クライアントが送った 1 回分のバイト列を、メッセージの種類（先頭 1 バイト）に分ける。起動のメッセージ（種類が無い）には使わない */
function messageTypes(chunk: Uint8Array): string[] {
  const types: string[] = []
  let i = 0
  while (i < chunk.length) {
    types.push(String.fromCharCode(chunk[i]))
    const length = new DataView(chunk.buffer, chunk.byteOffset + i + 1, 4).getInt32(0)
    i += 1 + length
  }
  return types
}

/** ブリッジが DB に渡した送信（PGlite の execProtocolRaw への 1 回 ＝ クライアントの 1 回の write）を記録する */
function spyOnWire() {
  const spy = vi.spyOn(pglite.pg, 'execProtocolRaw')
  return {
    sent: () => spy.mock.calls.map((c) => c[0] as Uint8Array),
    types: () => spy.mock.calls.map((c) => messageTypes(c[0] as Uint8Array)),
    clear: () => spy.mockClear(),
    restore: () => spy.mockRestore(),
  }
}

const EXTENDED = ['P', 'B', 'D', 'E', 'S']

describe('往復の数（引数のある SQL は 1 往復。describe のための往復が無い）', () => {
  it('つないだ後の引数のある SQL は、Parse+Bind+Describe+Execute+Sync を 1 回の送信にまとめる', async () => {
    const db = connect()
    await db.get('select 1') // つなぐ
    const wire = spyOnWire()
    try {
      expect(await db.get<{ n: number }>('select ?::int as n', 5)).toEqual({ n: 5 })
      expect(wire.types()).toEqual([EXTENDED])
      // 同じ SQL をもう一度流しても、増えない（初めての SQL だけ describe する、ということが無い）
      await db.get('select ?::int as n', 6)
      await db.get('select ?::int as m', 7) // 初めての SQL
      expect(wire.types()).toEqual([EXTENDED, EXTENDED, EXTENDED])
    } finally {
      wire.restore()
    }
  })

  it('引数が 0 個の SQL も extended protocol（simple query にしない）。名前付きの prepared statement は作らない', async () => {
    const db = connect()
    await db.get('select 1')
    const wire = spyOnWire()
    try {
      await db.all('select 2 as n')
      expect(wire.types()).toEqual([EXTENDED])
      // Parse の statement 名（Parse メッセージの先頭の文字列）が空
      const parse = wire.sent()[0]
      expect(parse[0]).toBe('P'.charCodeAt(0))
      expect(parse[5]).toBe(0)
    } finally {
      wire.restore()
    }
  })

  it('複数の文は通らない（引数が 0 個でも）', async () => {
    const db = connect()
    const failure = await db.all('select 1 as a; select 2 as b').then(() => undefined, (e: unknown) => e)
    expect(readDbError(failure)?.code).toBe('42601')
    expect(await db.get<{ n: number }>('select 3 as n')).toEqual({ n: 3 }) // そのあとも使える
  })

  it('トランザクション：begin（1 送信）→ SQL 1 本につき 1 送信 → commit（1 送信）', async () => {
    const db = connect()
    await db.get('select 1')
    const wire = spyOnWire()
    try {
      await db.tx(async (tx) => {
        await tx.get('select ?::int as n', 1)
        await tx.get('select 2 as n')
      })
      expect(wire.types()).toEqual([['Q'], EXTENDED, EXTENDED, ['Q']])
      const text = wire.sent().map((c) => Buffer.from(c).toString('latin1'))
      expect(text[0]).toContain('begin')
      expect(text[3]).toContain('commit')
    } finally {
      wire.restore()
    }
  })

  it('新しい接続で配列を返す SQL を初めて流しても、起動のあとの送信は 1 回だけ（配列型の問い合わせが無い）', async () => {
    const wire = spyOnWire()
    try {
      const db = connect()
      const row = await db.get<{ a: number[]; t: string[] }>(`select ?::int8[] as a, array['x', 'y'] as t`, [1, 2])
      expect(row).toEqual({ a: [1, 2], t: ['x', 'y'] })
      // 1 回目は起動のメッセージ。そのあとは SQL の 1 回だけ
      expect(wire.sent()).toHaveLength(2)
      expect(messageTypes(wire.sent()[1])).toEqual(EXTENDED)
    } finally {
      wire.restore()
    }
  })

  it('認証だけで DB に触らないなら、つながない', async () => {
    const wire = spyOnWire()
    try {
      const db = connect()
      await db.end()
      expect(wire.sent()).toEqual([])
    } finally {
      wire.restore()
    }
  })
})

describe('型（PGlite のアダプタと同じ値）', () => {
  const SCALARS = `select
    5::int8 as i8, 7::int4 as i4, 1.5::float8 as f8, true as b, 'text' as t, '00000000-0000-4000-8000-0000000000aa'::uuid as u,
    '2026-10-12'::date as d, '2026-10-12 01:02:03'::timestamp as ts, '2026-10-12 12:04:05.5+09'::timestamptz as tz,
    '{"a":[1,2]}'::jsonb as jb, '{"b":1}'::json as j, 1.50::numeric as n, '12:00'::time as tm,
    (select sum(x) from (values (1), (2)) v(x)) as sum_i4, (select count(*) from (values (1), (2)) v(x)) as cnt`

  it('スカラー：int8 は number、date・timestamp は文字列、timestamptz は ISO、json は値、numeric は文字列。PGlite と一致する', async () => {
    const viaPg = await connect().get<Record<string, unknown>>(SCALARS)
    const viaPglite = await pglite.get<Record<string, unknown>>(SCALARS)
    expect(viaPg).toEqual(viaPglite)
    expect(viaPg).toEqual({
      i8: 5, i4: 7, f8: 1.5, b: true, t: 'text', u: '00000000-0000-4000-8000-0000000000aa',
      d: '2026-10-12', ts: '2026-10-12 01:02:03', tz: '2026-10-12T03:04:05.500Z',
      jb: { a: [1, 2] }, j: { b: 1 }, n: '1.50', tm: '12:00:00', sum_i4: 3, cnt: 2,
    })
  })

  it('bigint が安全な整数を超えたら例外', async () => {
    await expect(connect().get('select 9007199254740993::bigint as big')).rejects.toThrow('整数で表せません')
  })

  const ARRAYS = `select
    array[1, 2]::int8[] as i8, array[null, 3]::int8[] as i8_null, '{}'::int8[] as i8_empty, array[array[1, 2], array[3, 4]]::int8[] as i8_2d,
    array[1, 2]::int4[] as i4, array[true, false]::bool[] as b, array[1.5, 2]::float8[] as f8,
    array['a', 'b c', 'd,e', 'f"g', 'NULL', '', '{x}', 'back\\slash']::text[] as t,
    array['00000000-0000-4000-8000-0000000000aa']::uuid[] as u,
    array['{"a":1}']::jsonb[] as jb, array['{"a":1}']::json[] as j, array[1.50]::numeric[] as n`

  it('配列：JS の配列で読める。PGlite と一致する（NULL・空・多次元・引用符・カンマ・波括弧・バックスラッシュも）', async () => {
    const viaPg = await connect().get<Record<string, unknown>>(ARRAYS)
    expect(viaPg).toEqual(await pglite.get<Record<string, unknown>>(ARRAYS))
    expect(viaPg).toMatchObject({
      i8: [1, 2], i8_null: [null, 3], i8_empty: [], i8_2d: [[1, 2], [3, 4]], i4: [1, 2], b: [true, false], f8: [1.5, 2],
      t: ['a', 'b c', 'd,e', 'f"g', 'NULL', '', '{x}', 'back\\slash'],
      u: ['00000000-0000-4000-8000-0000000000aa'], jb: [{ a: 1 }], j: [{ a: 1 }], n: ['1.50'],
    })
  })

  it('配列の要素にも、date・timestamp は文字列、timestamptz は ISO（PGlite のアダプタは配列の要素を Date にするので、ここは pg だけで確かめる）', async () => {
    const row = await connect().get<Record<string, unknown>>(`select
      array['2026-10-12', null]::date[] as d, array['2026-10-12 01:02:03']::timestamp[] as ts,
      array['2026-10-12 12:04:05.5+09', '2026-10-12 00:00:00+00']::timestamptz[] as tz`)
    expect(row).toEqual({ d: ['2026-10-12', null], ts: ['2026-10-12 01:02:03'], tz: ['2026-10-12T03:04:05.500Z', '2026-10-12T00:00:00.000Z'] })
  })

  it('配列の引数：リテラルの文字列で、text[] 列への代入も = any(?) も通る', async () => {
    const db = connect()
    const tags = ['a', 'b c', 'd,e', 'f"g', 'NULL', '']
    await db.run('insert into pgtest_doc (id, tags) values (?, ?), (?, ?)', 1, tags, 2, [])
    expect((await db.get<{ tags: string[] }>('select tags from pgtest_doc where id = ?', 1))?.tags).toEqual(tags)
    expect((await db.get<{ tags: string[] }>('select tags from pgtest_doc where id = ?', 2))?.tags).toEqual([])
    expect((await db.all<{ id: number }>('select id from pgtest_doc where id = any(?) order by id', [1, 2, 3])).map((r) => r.id)).toEqual([1, 2])
    expect((await db.all<{ id: number }>('select id from pgtest_doc where id = any(?::int[]) order by id', [2])).map((r) => r.id)).toEqual([2])
  })

  it('Date の引数：timestamptz にも timestamp（タイムゾーン無し）にも、UTC の ISO で入る', async () => {
    const db = connect()
    await db.run('insert into typed (id, amount, ts, plain_ts) values (?, ?, ?, ?)', 1, 0, new Date('2026-10-12T03:04:05.678Z'), new Date('2026-10-12T03:04:05.678Z'))
    const row = await db.get<{ ts: string; plain_ts: string }>('select ts, plain_ts from typed where id = ?', 1)
    expect(row).toEqual({ ts: '2026-10-12T03:04:05.678Z', plain_ts: '2026-10-12 03:04:05.678' })
  })
})

describe('jsonb / json の引数（呼び出し側が JSON.stringify した文字列を、そのまま入れる）', () => {
  it('二重に包まれない：jsonb_typeof が object で、読み出すともとの値。PGlite と同じ', async () => {
    const body = { sale: { title: 'セット', price: 3000 }, list: [1, 'x', null], quote: 'a"b\\c' }
    for (const [name, db] of [['pg', connect()], ['PGlite', pglite]] as Array<[string, Sql]>) {
      const id = name === 'pg' ? 1 : 2
      await db.run('insert into pgtest_doc (id, body, plain) values (?, ?, ?)', id, JSON.stringify(body), JSON.stringify(body))
      const row = await db.get<{ type: string; plain_type: string; body: unknown; plain: unknown; title: string }>(
        `select jsonb_typeof(body) as type, json_typeof(plain) as plain_type, body, plain, body #>> '{sale,title}' as title from pgtest_doc where id = ?`,
        id,
      )
      expect(row, name).toEqual({ type: 'object', plain_type: 'object', body, plain: body, title: 'セット' })
    }
  })

  it('JSON の文字列そのもの（"text"）や null も、そのまま', async () => {
    const db = connect()
    await db.run('insert into pgtest_doc (id, body) values (?, ?), (?, ?)', 1, JSON.stringify('text'), 2, 'null')
    expect((await db.get<{ body: unknown }>('select body from pgtest_doc where id = 1'))?.body).toBe('text')
    expect((await db.get<{ type: string }>('select jsonb_typeof(body) as type from pgtest_doc where id = 2'))?.type).toBe('null')
    await db.run('insert into pgtest_doc (id, body) values (?, ?)', 3, null)
    expect((await db.get<{ body: unknown }>('select body from pgtest_doc where id = 3'))?.body).toBeNull()
  })
})

describe('エラーの形：PGlite と同じ SQLSTATE・制約名・表名で届き、errors.ts の対応表がそのまま効く', () => {
  async function fail(db: Sql, run: (db: Sql) => Promise<unknown>): Promise<unknown> {
    try {
      await run(db)
    } catch (e) {
      return e
    }
    throw new Error('失敗するはずの SQL が成功しました')
  }

  const cases: Array<{ name: string; code: string; setup?: (db: Sql) => Promise<unknown>; run: (db: Sql) => Promise<unknown>; extra?: object }> = [
    {
      name: '23505 一意制約',
      code: '23505',
      setup: (db) => db.run(`insert into pgtest_child (id, name) values (1, 'dup')`),
      run: (db) => db.run(`insert into pgtest_child (id, name) values (2, 'dup')`),
      extra: { constraint: 'pgtest_child_name_key', table: 'pgtest_child' },
    },
    {
      name: '23503 外部キー',
      code: '23503',
      run: (db) => db.run('insert into pgtest_child (id, parent_id) values (?, ?)', 3, 999),
      extra: { constraint: 'pgtest_child_parent_id_fkey', table: 'pgtest_child' },
    },
    { name: '22P02 値の形（uuid）', code: '22P02', run: (db) => db.get('select ?::uuid', 'not-a-uuid') },
    { name: '22003 integer の範囲', code: '22003', run: (db) => db.get('select ?::bigint::int', 3000000000) },
    { name: '22012 0 で割る', code: '22012', run: (db) => db.get('select 1 / ?::int', 0) },
    { name: '42P01 表が無い', code: '42P01', run: (db) => db.get('select * from no_such_table') },
    { name: '42601 構文（複数の文）', code: '42601', run: (db) => db.all('select 1; select 2') },
    { name: 'P0001 raise exception（英語の内部用）', code: 'P0001', run: (db) => db.get('select public.pgtest_p0001()') },
    { name: 'SB001 利用者向けの日本語', code: 'SB001', run: (db) => db.get('select public.pgtest_sb001()') },
    { name: '40001 シリアライズ失敗', code: '40001', run: (db) => db.get('select public.pgtest_40001()') },
    {
      name: '42501 権限が無い（soroban_api は household_member を読めない）',
      code: '42501',
      run: (db) =>
        db.tx(async (tx) => {
          await tx.run('set local role soroban_api')
          await tx.get('select * from app.household_member')
        }),
    },
  ]

  for (const c of cases) {
    it(`${c.name}`, async () => {
      const db = connect()
      await c.setup?.(db)
      const viaPg = await fail(db, c.run)
      const viaPglite = await fail(pglite, c.run)

      // 例外は Error で、SQLSTATE が code に入っている
      expect(viaPg).toBeInstanceOf(Error)
      expect((viaPg as { code?: string }).code).toBe(c.code)
      // errors.ts が読む形（code・message・detail・constraint・table）が PGlite と同じ
      const infoPg = readDbError(viaPg)
      expect(infoPg).toMatchObject({ code: c.code, ...c.extra })
      expect(infoPg).toEqual(readDbError(viaPglite))
      // 利用者向けの日本語への対応（UserError か、写さない undefined か）も同じ
      const mappedPg = mapDbError(viaPg)
      const mappedPglite = mapDbError(viaPglite)
      expect(mappedPg === undefined).toBe(mappedPglite === undefined)
      if (mappedPg && mappedPglite) expect({ code: mappedPg.code, message: mappedPg.message }).toEqual({ code: mappedPglite.code, message: mappedPglite.message })
      // ログに出す形（describeError）にも code とメッセージが載る。SQL の引数は載らない
      expect(describeError(viaPg)).toMatchObject({ code: c.code })
      // 失敗のあとも同じ接続で続けられる
      expect(await db.get<{ ok: number }>('select 1 as ok')).toEqual({ ok: 1 })
    })
  }

  it('errors.ts の対応表：22P02 は 400「値の形が正しくありません」、SB001 は 409 でメッセージと detail をそのまま、40001 は 409、P0001・42P01 は写さない', async () => {
    const db = connect()
    const map = async (run: (db: Sql) => Promise<unknown>) => mapDbError(await fail(db, run))
    expect(await map((d) => d.get('select ?::uuid', 'not-a-uuid'))).toMatchObject({ code: 'bad_request', message: '値の形が正しくありません' })
    expect(await map((d) => d.get('select public.pgtest_sb001()'))).toMatchObject({ code: 'conflict', message: '取り込み中です（あと 42 秒）' })
    expect(await map((d) => d.get('select public.pgtest_40001()'))).toMatchObject({ code: 'conflict' })
    expect(await map((d) => d.get('select public.pgtest_p0001()'))).toBeUndefined()
    expect(await map((d) => d.get('select * from no_such_table'))).toBeUndefined()
  })

  it('トランザクションの中のエラー：savepoint で戻した内側は外側が続けられる。戻さなければ「中断している」（25P02）で、rollback で元に戻る', async () => {
    const db = connect()
    await db.tx(async (tx) => {
      await tx.run(`insert into pgtest_child (id, name) values (1, 'dup')`)
      const inner = await fail(tx, (t) => t.tx((s) => s.run(`insert into pgtest_child (id, name) values (2, 'dup')`)))
      expect(readDbError(inner)?.code).toBe('23505')
      await tx.run(`insert into pgtest_child (id, name) values (3, 'other')`) // 外側は続けられる
    })
    expect((await db.all<{ id: number }>('select id from pgtest_child order by id')).map((r) => r.id)).toEqual([1, 3])

    // savepoint なしで失敗したら、その先は 25P02。fn が投げれば rollback されて何も残らない
    const aborted = await fail(db, (d) =>
      d.tx(async (tx) => {
        await tx.run(`insert into pgtest_child (id, name) values (10, 'ten')`)
        await fail(tx, (t) => t.run(`insert into pgtest_child (id, name) values (11, 'dup')`)) // 'dup' は id=1 が持っている → 一意制約で中断
        await tx.get('select 1') // 中断したあとの SQL は 25P02
      }),
    )
    expect(readDbError(aborted)?.code).toBe('25P02')
    expect(await db.get('select 1 from pgtest_child where id = 10')).toBeUndefined()
  })
})

describe('1 本の接続を排他にする', () => {
  it('トランザクションの外の Promise.all は、順に 1 つずつ流れる。pg の「実行中に重ねて投げた」警告も出ない', async () => {
    const db = connect()
    const warn = vi.spyOn(process, 'emitWarning')
    try {
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => db.get<{ n: number }>('select ?::int as n', i)))
      expect(results.map((r) => r?.n)).toEqual([0, 1, 2, 3, 4, 5])
      const deprecations = warn.mock.calls.filter((c) => String(c[0]).includes('client.query()'))
      expect(deprecations).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('トランザクションの途中に、外側の sql の SQL は混ざらない（world のロール・設定が外に漏れない）', async () => {
    const db = connect()
    let outside: Promise<{ who: string; hh: string | null } | undefined> | undefined
    await db.tx(async (tx) => {
      await tx.run('set local role soroban_api')
      await tx.get(`select set_config('app.household_id', '00000000-0000-4000-8000-00000000000a', true)`)
      // await しない（await すると PGlite と同じく待ち続ける）。トランザクションが終わるまで流れない
      outside = db.get(`select current_user as who, nullif(current_setting('app.household_id', true), '') as hh`)
      expect((await tx.get<{ who: string }>('select current_user as who'))?.who).toBe('soroban_api')
    })
    const seen = await outside
    expect(seen?.who).not.toBe('soroban_api')
    expect(seen?.hh).toBeNull()
  })

  it('end は走っているトランザクションが終わってから閉じる。閉じたあとの SQL は例外', async () => {
    const db = connect()
    let ended: Promise<void> | undefined
    await db.tx(async (tx) => {
      await tx.run('insert into pgtest_parent (id) values (1)')
      ended = db.end()
      await tx.run('insert into pgtest_parent (id) values (2)')
    })
    await ended
    expect((await pglite.all<{ id: number }>('select id from pgtest_parent order by id')).map((r) => r.id)).toEqual([1, 2])
    await expect(db.get('select 1')).rejects.toThrow('閉じています')
  })

  it('つなげないとき：SQL は接続のエラーで失敗し、end は返る（固まらない）', async () => {
    const db = createPostgresSql('postgres://u@127.0.0.1:1/db')
    const failure = await db.get('select 1').then(() => undefined, (e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(readDbError(failure)).toBeUndefined() // DB の例外ではない（internal になる）
    await db.end()
  })
})
