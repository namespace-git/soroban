import { describe, expect, it } from 'vitest'
import { toPositional } from '../../db/sql'
import { normalizeParam, parseInt8, parseTimestamptz } from '../../db/types'

describe('toPositional: ? を $1, $2 … に置き換える', () => {
  it('順に番号を振る', () => {
    expect(toPositional('select * from t where a = ? and b = ? and c in (?, ?)', 4)).toBe(
      'select * from t where a = $1 and b = $2 and c in ($3, $4)',
    )
  })

  it('プレースホルダが無ければそのまま', () => {
    expect(toPositional('select 1', 0)).toBe('select 1')
  })

  describe('置き換えない境界', () => {
    it("文字列リテラルの中（'' のエスケープ込み）", () => {
      expect(toPositional("select 'what?' , ?", 1)).toBe("select 'what?' , $1")
      expect(toPositional("select 'it''s ? ok', ?", 1)).toBe("select 'it''s ? ok', $1")
      expect(toPositional("select '', ?", 1)).toBe("select '', $1")
    })

    it('標準の文字列では \\ はエスケープではない（\\ で終わる文字列の後の ? は引数）', () => {
      expect(toPositional("select 'a\\', ?", 1)).toBe("select 'a\\', $1")
    })

    it("E'…' では \\' が文字列の中の引用符になる", () => {
      expect(toPositional("select E'it\\'s ?', ?", 1)).toBe("select E'it\\'s ?', $1")
      expect(toPositional("select e'\\\\', ?", 1)).toBe("select e'\\\\', $1")
    })

    it('識別子の一部の e（name\'…）を E 文字列と取り違えない', () => {
      // table"e" の直後ではなく、識別子 `code` の末尾の e に続く ' は普通の文字列
      expect(toPositional("select code'x\\', ?", 1)).toBe("select code'x\\', $1")
    })

    it('引用識別子の中（"" のエスケープ込み）', () => {
      expect(toPositional('select "col?" from t where a = ?', 1)).toBe('select "col?" from t where a = $1')
      expect(toPositional('select "a""?" , ?', 1)).toBe('select "a""?" , $1')
    })

    it('行コメント', () => {
      expect(toPositional('select ? -- 本当に?\n, ?', 2)).toBe('select $1 -- 本当に?\n, $2')
      expect(toPositional('select ? -- 末尾のコメント?', 1)).toBe('select $1 -- 末尾のコメント?')
    })

    it('ブロックコメント（入れ子も）', () => {
      expect(toPositional('select /* ? */ ?', 1)).toBe('select /* ? */ $1')
      expect(toPositional('select /* a /* ? */ ? */ ?', 1)).toBe('select /* a /* ? */ ? */ $1')
    })

    it('ドル引用', () => {
      expect(toPositional('select $$ what? $$, ?', 1)).toBe('select $$ what? $$, $1')
      expect(toPositional('select $fn$ what? $$ ? $fn$, ?', 1)).toBe('select $fn$ what? $$ ? $fn$, $1')
      expect(toPositional('select $a$ $b$ ? $b$ ? $a$, ?', 1)).toBe('select $a$ $b$ ? $b$ ? $a$, $1')
    })

    it('関数の本体（$$ … $$）の中の ? は触らず、外の ? だけ引数', () => {
      const sql = "create function f() returns text language sql as $$ select '?' || ? $$; select ?"
      expect(toPositional(sql, 1)).toBe("create function f() returns text language sql as $$ select '?' || ? $$; select $1")
    })

    it('識別子の途中の $ はドル引用ではない', () => {
      expect(toPositional('select a$b, ?, c$d', 1)).toBe('select a$b, $1, c$d')
    })
  })

  describe('引数の数が合わなければ例外', () => {
    it('引数が足りない', () => {
      expect(() => toPositional('select ?, ?', 1)).toThrow('プレースホルダが 2 個ですが、引数は 1 個')
    })
    it('引数が多い', () => {
      expect(() => toPositional('select ?', 2)).toThrow('プレースホルダが 1 個ですが、引数は 2 個')
    })
    it('プレースホルダが無いのに引数がある', () => {
      expect(() => toPositional('select 1', 1)).toThrow('プレースホルダが 0 個')
    })
    it('文字列の中の ? は数えないので、数えるつもりで引数を渡すと例外', () => {
      expect(() => toPositional("select 'a?'", 1)).toThrow('プレースホルダが 0 個')
    })
    it('jsonb の ? 演算子は使えない（引数の数が合わず例外になる）', () => {
      expect(() => toPositional("select * from t where data ? 'key'", 0)).toThrow()
    })
  })

  describe('すでに $n で書かれた SQL', () => {
    it('そのまま通し、最大の番号と引数の数を照らす', () => {
      expect(toPositional('select $1, $2, $1', 2)).toBe('select $1, $2, $1')
      expect(() => toPositional('select $1, $2', 1)).toThrow()
    })
    it('? との混在は例外', () => {
      expect(() => toPositional('select $1, ?', 1)).toThrow('混ざっています')
    })
  })

  describe('閉じていないものは例外（崩れた SQL を黙って投げない）', () => {
    it("文字列 '", () => expect(() => toPositional("select 'abc, ?", 1)).toThrow("文字列 ' が閉じていません"))
    it('識別子 "', () => expect(() => toPositional('select "abc, ?', 1)).toThrow('識別子 " が閉じていません'))
    it('ブロックコメント', () => expect(() => toPositional('select ? /* abc', 1)).toThrow('コメント /* が閉じていません'))
    it('入れ子のブロックコメントの閉じ忘れ', () => expect(() => toPositional('select /* a /* b */ ?', 1)).toThrow('閉じていません'))
    it('ドル引用', () => expect(() => toPositional('select $$ abc ?', 1)).toThrow('ドル引用 $$ が閉じていません'))
  })
})

describe('normalizeParam: 引数を両方のドライバで同じ形にする', () => {
  it('undefined は例外（null を渡す）', () => {
    expect(() => normalizeParam(undefined, 2)).toThrow('3 番目が undefined')
  })

  it('NaN・Infinity は例外（金額に紛れ込ませない）', () => {
    expect(() => normalizeParam(NaN, 0)).toThrow('有限の数ではありません')
    expect(() => normalizeParam(Infinity, 0)).toThrow('有限の数ではありません')
  })

  it('素のオブジェクトは例外（jsonb は JSON.stringify して渡す）', () => {
    expect(() => normalizeParam({ a: 1 }, 0)).toThrow('JSON.stringify')
  })

  it('文字列・数・null・真偽・Date はそのまま', () => {
    const d = new Date()
    expect(normalizeParam('x', 0)).toBe('x')
    expect(normalizeParam(5750, 0)).toBe(5750)
    expect(normalizeParam(null, 0)).toBeNull()
    expect(normalizeParam(true, 0)).toBe(true)
    expect(normalizeParam(d, 0)).toBe(d)
  })

  it('配列は Postgres の配列リテラルにする（引用符・カンマ・NULL という文字列も安全）', () => {
    expect(normalizeParam([], 0)).toBe('{}')
    expect(normalizeParam([1, 2, 3], 0)).toBe('{1,2,3}')
    expect(normalizeParam(['a', 'b c', 'd,e', 'f"g', 'h\\i', 'NULL', ''], 0)).toBe('{"a","b c","d,e","f\\"g","h\\\\i","NULL",""}')
    expect(normalizeParam([1, null, 3], 0)).toBe('{1,NULL,3}')
    expect(normalizeParam([[1, 2], [3, 4]], 0)).toBe('{{1,2},{3,4}}')
  })

  it('配列の中のオブジェクトは例外', () => {
    expect(() => normalizeParam([{ a: 1 }], 0)).toThrow('渡せない値')
  })
})

describe('型の読み出し', () => {
  it('int8 は number。安全な整数を超えたら例外', () => {
    expect(parseInt8('5750')).toBe(5750)
    expect(parseInt8('-1')).toBe(-1)
    expect(() => parseInt8('9007199254740993')).toThrow('整数で表せません')
  })

  it('timestamptz は UTC の ISO 文字列（接続の TimeZone に依らない）', () => {
    expect(parseTimestamptz('2026-10-12 12:04:05.123456+09')).toBe('2026-10-12T03:04:05.123Z')
    expect(parseTimestamptz('2026-10-12 03:04:05+00')).toBe('2026-10-12T03:04:05.000Z')
    expect(parseTimestamptz('2026-10-12 08:34:05.5+05:30')).toBe('2026-10-12T03:04:05.500Z')
    expect(parseTimestamptz('2026-10-11 22:00:00-05')).toBe('2026-10-12T03:00:00.000Z')
  })

  it('読めない形（infinity）はそのまま', () => {
    expect(parseTimestamptz('infinity')).toBe('infinity')
  })
})
