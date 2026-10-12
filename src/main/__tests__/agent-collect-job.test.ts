import { describe, expect, it } from 'vitest'
import type { CollectorRun } from '../../shared/types'
import { decideFinishStatus, runCollectJob, type JobCollectors } from '../agent/collect-job'
import { AgentHttpError, LeaseLostError } from '../agent/errors'
import { JobGuard } from '../agent/guard'
import type { RemoteStore } from '../store/remote'

// 取り込み 1 回分の順序（メルカリ → Yahoo!フリマ → メロジョイ）と、finish の終わり方の決め方

const run = (over: Partial<CollectorRun> = {}): CollectorRun => ({
  id: 'r', started_at: 't', finished_at: 't', source: 'mercari', shop_account_id: null, shop_account_name: null,
  status: 'ok', fetched: 1, inserted: 0, message: null, ...over,
})

describe('decideFinishStatus：server/agent/jobs.ts の finish の規則に合わせる', () => {
  it('実行記録が 1 つも無ければ failed（done にはできない）', () => {
    expect(decideFinishStatus([], false)).toBe('failed')
    expect(decideFinishStatus([], true)).toBe('failed')
  })

  it('全部 ok / empty で途中で止めていなければ done', () => {
    expect(decideFinishStatus([run(), run({ status: 'empty' })], false)).toBe('done')
  })

  it('途中で止めた（未完了）なら、終わった分があれば partial、無ければ failed', () => {
    expect(decideFinishStatus([run()], true)).toBe('partial')
    expect(decideFinishStatus([run({ status: 'empty' })], true)).toBe('partial')
    expect(decideFinishStatus([run({ status: 'failed' })], true)).toBe('failed')
  })

  it('failed / 要ログインが混ざれば、終わった分があるなら partial、全部それなら failed', () => {
    expect(decideFinishStatus([run(), run({ status: 'failed' })], false)).toBe('partial')
    expect(decideFinishStatus([run({ status: 'empty' }), run({ status: 'auth_required' })], false)).toBe('partial')
    expect(decideFinishStatus([run({ status: 'failed' }), run({ status: 'auth_required' })], false)).toBe('failed')
  })
})

/** 偽の store：recordedRuns と getCollectPlan だけ */
function fakeStore(shops: Array<{ id: string; name: string }> = [], plan?: () => Promise<unknown>): RemoteStore & { push(r: CollectorRun): void } {
  const runs: CollectorRun[] = []
  return {
    getCollectPlan: (plan ?? (async () => ({ shop_accounts: shops }))) as RemoteStore['getCollectPlan'],
    recordedRuns: () => [...runs],
    push: (r: CollectorRun) => { runs.push(r) },
  } as unknown as RemoteStore & { push(r: CollectorRun): void }
}

describe('runCollectJob：直列の順序と打ち切り', () => {
  const logs: string[] = []
  const log = (kind: string, message: string): void => { logs.push(`${kind}:${message}`) }

  function collectors(store: ReturnType<typeof fakeStore>, order: string[], over: Partial<JobCollectors> = {}): JobCollectors {
    const rec = (id: string, source: CollectorRun['source'], shop: string | null = null) => {
      const r = run({ id, source, shop_account_id: shop })
      store.push(r)
      return Promise.resolve(r)
    }
    return {
      mercari: over.mercari ?? (() => { order.push('mercari'); return rec('r1', 'mercari') }),
      yahoo: over.yahoo ?? (() => { order.push('yahoo'); return rec('r2', 'yahoo') }),
      mellojoy: over.mellojoy ?? ((id) => { order.push(`mellojoy:${id}`); return rec(`r-${id}`, 'mellojoy', id) }),
    }
  }

  it('メルカリ → Yahoo!フリマ → メロジョイ（計画の仕入先の順）。全部 ok なら done、id を集める', async () => {
    const store = fakeStore([{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }])
    const order: string[] = []
    const result = await runCollectJob({ store, guard: new JobGuard(), silent: true, collectors: collectors(store, order), log })
    expect(order).toEqual(['mercari', 'yahoo', 'mellojoy:s1', 'mellojoy:s2'])
    expect(result).toMatchObject({ status: 'done', runIds: ['r1', 'r2', 'r-s1', 'r-s2'], message: null, aborted: false })
  })

  it('仕入先が無ければメルカリと Yahoo!フリマだけ', async () => {
    const store = fakeStore([])
    const order: string[] = []
    const result = await runCollectJob({ store, guard: new JobGuard(), silent: true, collectors: collectors(store, order), log })
    expect(order).toEqual(['mercari', 'yahoo'])
    expect(result.status).toBe('done')
  })

  it('計画を読めなければ何も収集しない（サーバーの不調のときに外のサイトを叩かない）。failed と理由', async () => {
    const store = fakeStore([], async () => { throw new AgentHttpError('internal', 500, 'サーバーでエラーが起きました（500）') })
    const order: string[] = []
    const result = await runCollectJob({ store, guard: new JobGuard(), silent: true, collectors: collectors(store, order), log })
    expect(order).toEqual([])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('計画を読めませんでした')
  })

  it('lease_lost で止まったら続きの取り込み元は始めず、aborted になる（finish を呼ばせない）', async () => {
    const store = fakeStore([{ id: 's1', name: 'A' }])
    const order: string[] = []
    const guard = new JobGuard()
    const result = await runCollectJob({
      store, guard, silent: true, log,
      collectors: collectors(store, order, {
        mercari: async () => { order.push('mercari'); guard.loseLease(); throw new LeaseLostError() },
      }),
    })
    expect(order).toEqual(['mercari'])
    expect(result.aborted).toBe(true)
  })

  it('収集が例外で止まっても、通信が続けられる種類でなければ次の取り込み元へ進む（理由は補足に残る）', async () => {
    const store = fakeStore([])
    const order: string[] = []
    const result = await runCollectJob({
      store, guard: new JobGuard(), silent: true, log,
      collectors: collectors(store, order, {
        mercari: async () => { order.push('mercari'); throw new Error('想定外') },
      }),
    })
    expect(order).toEqual(['mercari', 'yahoo'])
    expect(result.status).toBe('partial')
    expect(result.message).toBe('メルカリ：想定外')
  })

  it('補足は 500 文字までに収める', async () => {
    const store = fakeStore([])
    const result = await runCollectJob({
      store, guard: new JobGuard(), silent: true, log,
      collectors: collectors(store, [], {
        mercari: async () => { throw new Error('あ'.repeat(2000)) },
        yahoo: async () => { throw new Error('い'.repeat(2000)) },
      }),
    })
    expect(result.message!.length).toBeLessThanOrEqual(500)
  })
})
