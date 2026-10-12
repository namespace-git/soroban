import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// 業務ロジックの登録（registerHandler の副作用）。dispatch の既定のテーブルで getInbox・createTag を呼ぶ
import '../../domain/index'
import { UserError } from '../../errors'
import { dispatch, type Handlers } from '../../rpc'
import { newWorld, openDomainDb, type DomainDb, type Member, type World } from './helpers'

// 操作ログ（app_log・source='ipc'）。デスクトップの handle（src/main/index.ts）が書き込み系の IPC を記録するのと同じ規則で、
// dispatch が、書き込み系のメソッドが成功したときに同じトランザクションの中で 1 行残す。
// ホームの「今日やったこと」（done_today）がこれを数える。引数（API キーなど）は書かない。

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})
afterAll(async () => {
  await dom.close()
})
beforeEach(async () => {
  w = await newWorld(dom)
})

interface LogRow {
  source: string
  kind: string
  message: string
  payload: string | null
  duration_ms: number | null
  error: string | null
}

const logsOf = (m: Member): Promise<LogRow[]> =>
  m.run((c) => c.sql.all<LogRow>('select source, kind, message, payload, duration_ms, error from app_log order by id'))

async function call(m: Member, method: string, args: unknown[] = [], handlers?: Handlers) {
  const response = await dispatch(method, args, { root: dom.root, identity: { householdId: m.householdId, userId: m.userId }, handlers })
  return { status: response.status, body: JSON.parse(await response.text()) as { result?: unknown; error?: { code: string; message: string } } }
}

const doneToday = async (m: Member): Promise<number> => ((await call(m, 'getInbox')).body.result as { done_today: number }).done_today

/** 書き込み系の偽のハンドラ（成功する） */
const writes: Handlers = {
  updateSale: async () => ({ ok: true }),
  linkInventory: async () => undefined,
  createSale: async () => 'new-id',
}

describe('書き込み系が成功したら app_log に 1 行', () => {
  it('source=ipc・kind と message はメソッド名・error なし・時間が入る。引数は書かない', async () => {
    await call(w.a, 'updateSale', ['SECRET-ARG-1', { note: 'SECRET-ARG-2' }], writes)
    await call(w.a, 'linkInventory', ['SECRET-ARG-3'], writes)
    await call(w.a, 'createSale', [{ title: 'SECRET-ARG-4' }], writes)

    const rows = await logsOf(w.a)
    expect(rows.map((r) => [r.source, r.kind, r.message, r.payload, r.error])).toEqual([
      ['ipc', 'updateSale', 'updateSale', null, null],
      ['ipc', 'linkInventory', 'linkInventory', null, null],
      ['ipc', 'createSale', 'createSale', null, null],
    ])
    expect(rows.every((r) => Number.isInteger(r.duration_ms) && (r.duration_ms as number) >= 0)).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('SECRET-ARG')
  })

  it('本物のハンドラでも（createTag）。名前（引数）は app_log に入らない', async () => {
    const r = await call(w.a, 'createTag', ['SECRET-TAG-NAME'])
    expect(r.status).toBe(200)
    const rows = await logsOf(w.a)
    expect(rows.map((x) => [x.source, x.kind])).toEqual([['ipc', 'createTag']])
    expect(JSON.stringify(rows)).not.toContain('SECRET-TAG-NAME')
  })

  it('読み取りだけのメソッドと、記録しないもの（logClient・API キーの設定）は書かない', async () => {
    const quiet: Handlers = {
      getInbox: async () => ({}), getSettings: async () => ({}), listSales: async () => [], getPushConfig: async () => ({}),
      getCollectStatus: async () => ({}), searchAll: async () => [],
      logClient: async () => undefined, setGeminiApiKey: async () => undefined, setTrack17ApiKey: async () => undefined,
    }
    for (const method of Object.keys(quiet)) {
      expect((await call(w.a, method, [], quiet)).status, method).toBe(200)
    }
    expect(await logsOf(w.a)).toEqual([])
  })

  it('失敗したとき（例外・未実装・知らないメソッド）は書かない', async () => {
    const failing: Handlers = {
      updateSale: async () => {
        throw new UserError('失敗しました')
      },
    }
    expect((await call(w.a, 'updateSale', [], failing)).status).toBe(400)
    expect((await call(w.a, 'createSale', [], failing)).status).toBe(501)
    expect((await call(w.a, 'noSuchMethod', [], failing)).status).toBe(404)
    expect(await logsOf(w.a)).toEqual([])
  })

  it('ログを書けなくても、業務の書き込みは成功する（リクエストを失敗させない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const broken: Handlers = {
        updateSale: async (ctx) => {
          // このあとのログの書き込み（ctx.sql.tx）だけが落ちる
          ctx.sql = { ...ctx.sql, tx: async () => { throw new Error('boom') } }
          return 'ok'
        },
      }
      const r = await call(w.a, 'updateSale', [], broken)
      expect(r.status).toBe(200)
      expect(r.body.result).toBe('ok')
      expect(spy).toHaveBeenCalled()
      expect(await logsOf(w.a)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('14 日より古い行は書くたびに消す。世帯ごとに分かれる（相手の行は触らない）', async () => {
    await w.a.run((c) => c.sql.run(`insert into app_log (ts, source, kind, message) values (now() - interval '15 days', 'ipc', 'old', 'old')`))
    await w.a.run((c) => c.sql.run(`insert into app_log (ts, source, kind, message) values (now() - interval '13 days', 'ipc', 'recent', 'recent')`))
    await w.b.run((c) => c.sql.run(`insert into app_log (ts, source, kind, message) values (now() - interval '20 days', 'ipc', 'b-old', 'b-old')`))

    await call(w.a, 'updateSale', [], writes)

    expect((await logsOf(w.a)).map((r) => r.kind)).toEqual(['recent', 'updateSale'])
    expect((await logsOf(w.b)).map((r) => r.kind)).toEqual(['b-old'])
  })
})

describe('受信箱の done_today が数える', () => {
  it('書き込み系の成功だけ数える（updateSale・linkInventory・confirmPurchase・reserveInventory・setListingShipping・updatePurchaseFulfillment）。世帯ごと', async () => {
    expect(await doneToday(w.a)).toBe(0)

    await call(w.a, 'updateSale', [], writes)
    await call(w.a, 'updateSale', [], writes)
    await call(w.a, 'linkInventory', [], writes)
    expect(await doneToday(w.a)).toBe(3)

    // 数える種類に入っていない書き込み（createSale）・読み取りは数えない
    await call(w.a, 'createSale', [], writes)
    await call(w.a, 'createTag', ['新品'])
    expect(await doneToday(w.a)).toBe(3)

    // 失敗したものは数えない
    await call(w.a, 'updateSale', [], { updateSale: async () => { throw new UserError('失敗') } })
    expect(await doneToday(w.a)).toBe(3)

    // 世帯 B には数えない
    expect(await doneToday(w.b)).toBe(0)
  })
})
