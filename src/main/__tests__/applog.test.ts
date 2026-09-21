import { beforeEach, describe, expect, it, vi } from 'vitest'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）。
// applog.ts 自身も app.getVersion() を使う（起動ログのバージョン表記）
vi.mock('electron', () => ({
  app: {
    getPath: () => '',
    getVersion: () => '9.9.9',
  },
}))

import * as db from '../db'
import * as applog from '../applog'

interface AppLogRow {
  id: number
  ts: string
  source: string
  kind: string
  message: string
  payload: string | null
  duration_ms: number | null
  error: string | null
}

function rows(): AppLogRow[] {
  return db.getDb().prepare('SELECT * FROM app_log ORDER BY id').all() as AppLogRow[]
}

// ============================================================
// DB未初期化のとき：起動順序に関わらず落ちないことを、他のテストより先に確認する
// （同じファイル内で db.initDb() を先に呼んでしまうと検証できなくなるため）
// ============================================================
describe('applog（DB未初期化）', () => {
  it('getDb()が未初期化でもlog/initAppLogは例外を投げない', () => {
    expect(() => applog.log('main', 'x', 'y')).not.toThrow()
    expect(() => applog.initAppLog()).not.toThrow()
  })
})

describe('applog（:memory:）', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('initAppLogでapp_logテーブルを作り、起動を1行記録する', () => {
    applog.initAppLog()
    const all = rows()
    expect(all.length).toBe(1)
    expect(all[0].source).toBe('main')
    expect(all[0].kind).toBe('startup')
    expect(all[0].message).toContain('9.9.9')
  })

  it('logで1行追加できる（payload・duration_msを保存）', () => {
    applog.initAppLog()
    applog.log('ipc', 'createSale', 'createSale', { price: 1000 }, { duration_ms: 12 })
    const all = rows()
    expect(all.length).toBe(2)
    const last = all[all.length - 1]
    expect(last.source).toBe('ipc')
    expect(last.kind).toBe('createSale')
    expect(last.duration_ms).toBe(12)
    expect(last.error).toBeNull()
    expect(JSON.parse(last.payload as string)).toEqual({ price: 1000 })
  })

  it('logでerrorを記録できる', () => {
    applog.initAppLog()
    applog.log('ipc', 'deleteSale', 'deleteSale', ['id-1'], { error: '見つかりません' })
    const last = rows().at(-1)!
    expect(last.error).toBe('見つかりません')
  })

  it('14日より古い行はinitAppLogのたびに消える', () => {
    applog.initAppLog()
    applog.log('main', 'old', '古いログ')
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000).toISOString()
    db.getDb().prepare(`UPDATE app_log SET ts = ? WHERE kind = 'old'`).run(fifteenDaysAgo)
    expect(rows().some(r => r.kind === 'old')).toBe(true)

    applog.initAppLog()
    expect(rows().some(r => r.kind === 'old')).toBe(false)
  })

  it('13日前の行はinitAppLogで消えない（保持期間内）', () => {
    applog.initAppLog()
    applog.log('main', 'recent', '13日前のログ')
    const thirteenDaysAgo = new Date(Date.now() - 13 * 86400000).toISOString()
    db.getDb().prepare(`UPDATE app_log SET ts = ? WHERE kind = 'recent'`).run(thirteenDaysAgo)

    applog.initAppLog()
    expect(rows().some(r => r.kind === 'recent')).toBe(true)
  })
})

describe('summarize', () => {
  it('2,000文字で切る', () => {
    const big = 'a'.repeat(3000)
    const s = applog.summarize({ text: big })
    expect(s.length).toBeLessThan(2100)
    expect(s.startsWith('{"text":"aaa')).toBe(true)
  })

  it('password/token/cookieを含むキーは伏せる（大小文字を問わない）', () => {
    const s = applog.summarize({ password: 'secret', Token: 'abc', session_cookie: 'xyz', name: 'ok' })
    const obj = JSON.parse(s)
    expect(obj.password).toBe('***')
    expect(obj.Token).toBe('***')
    expect(obj.session_cookie).toBe('***')
    expect(obj.name).toBe('ok')
  })

  it('循環参照でも例外を投げず [Circular] にする', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    expect(() => applog.summarize(obj)).not.toThrow()
    expect(applog.summarize(obj)).toContain('[Circular]')
  })

  it('巨大配列は中身を展開せず件数だけにする', () => {
    const items = Array.from({ length: 200 }, (_, i) => i)
    const s = applog.summarize({ items })
    expect(s).toContain('200件')
    expect(s).not.toContain('"199"')
  })

  it('Bufferは長さだけにする', () => {
    const s = applog.summarize({ file: Buffer.from('hello world') })
    expect(s).toContain('11 bytes')
  })

  it('undefinedは空文字にする', () => {
    expect(applog.summarize(undefined)).toBe('')
  })
})
