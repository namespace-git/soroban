import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createShopAccount } from '../../domain/master'
import { collectNotification } from '../../agent/notify'
import type { Member } from '../domain/helpers'
import {
  ask, closeFixture, count, leaseOf, openFixture, registerPc, resetWorld, startJob, type Fixture, type Pc,
} from './helpers'

// 実行記録（recordRun）と、取り込みの終わり（finish）：done にできる条件、結果の組み立て、
// 失敗・要ログイン・0 件の通知（全部 ok なら積まない）

let f: Fixture
let a: Member
let pc: Pc
let lease: ReturnType<typeof leaseOf>

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  a = f.world.a
  pc = await registerPc(f, a, 'リビングの PC')
  lease = leaseOf(await startJob(f, a, pc))
})

const record = async (run: Record<string, unknown>): Promise<{ id: string; [k: string]: unknown }> => {
  const r = await pc.call('recordRun', lease, run)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.result
}

const ok = (source: string, extra: Record<string, unknown> = {}) =>
  ({ source, status: 'ok', fetched: 5, inserted: 2, message: '新規 2・更新 3', ...extra })

const events = async (): Promise<Array<{ kind: string; title: string; body: string; url: string | null; dedupe_key: string }>> =>
  (await f.dom.pg.query<{ kind: string; title: string; body: string; url: string | null; dedupe_key: string }>(
    'select kind, title, body, url, dedupe_key from app.notification_event where household_id = $1 order by created_at', [a.householdId])).rows

describe('実行記録（recordRun）', () => {
  it('取り込み元ごとの記録ができ、CollectorRun の形で返る。始めた時刻は取った時刻〜終わった時刻の間', async () => {
    const run = await record(ok('mercari'))
    expect(Object.keys(run).sort()).toEqual([
      'fetched', 'finished_at', 'id', 'inserted', 'message', 'shop_account_id', 'shop_account_name', 'source', 'started_at', 'status',
    ])
    expect(run).toMatchObject({ source: 'mercari', status: 'ok', fetched: 5, inserted: 2, message: '新規 2・更新 3', shop_account_id: null })
    expect(new Date(run.started_at as string).getTime()).toBeLessThanOrEqual(new Date(run.finished_at as string).getTime())

    const job = (await f.dom.pg.query<{ claimed_at: Date | string }>('select claimed_at from app.collect_job where id = $1', [lease.job_id])).rows[0]
    expect(new Date(run.started_at as string).getTime()).toBeGreaterThanOrEqual(new Date(job.claimed_at).getTime())
  })

  it('始めた時刻を渡しても、取った時刻より前・終わった時刻より後には丸める', async () => {
    const early = await record(ok('yahoo', { started_at: '2000-01-01T00:00:00Z' }))
    const job = (await f.dom.pg.query<{ claimed_at: Date | string }>('select claimed_at from app.collect_job where id = $1', [lease.job_id])).rows[0]
    expect(Math.abs(new Date(early.started_at as string).getTime() - new Date(job.claimed_at).getTime())).toBeLessThan(5)

    const late = await record(ok('mercari', { started_at: '2999-01-01T00:00:00Z' }))
    expect(new Date(late.started_at as string).getTime()).toBeLessThanOrEqual(new Date(late.finished_at as string).getTime())
  })

  it('メロジョイは仕入先の名前つき。仕入先が無い・知らないなら断る', async () => {
    const shop = await a.run((ctx) => createShopAccount(ctx, 'メロジョイ A', 'mellojoy'))
    const run = await record(ok('mellojoy', { shop_account_id: shop }))
    expect(run).toMatchObject({ source: 'mellojoy', shop_account_id: shop, shop_account_name: 'メロジョイ A' })

    expect((await pc.call('recordRun', lease, ok('mellojoy'))).status).toBe(400)
    expect((await pc.call('recordRun', lease, ok('mellojoy', { shop_account_id: '00000000-0000-4000-8000-000000000999' }))).status).toBe(404)
  })

  it('同じ取り込み元をもう一度送ると、書かずに前の記録を返す（二重に記録しない）', async () => {
    const first = await record(ok('mercari'))
    const again = await record(ok('mercari', { status: 'failed', message: '別の内容' }))
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ status: 'ok', message: '新規 2・更新 3' })
    expect(await count(f, 'select count(*)::int as n from app.collector_run where household_id = $1', a.householdId)).toBe(1)
  })

  it('状態・件数・取り込み元が変なら 400。何も記録せず、直して送り直せる', async () => {
    for (const bad of [
      ok('mercari', { status: 'success' }), ok('mercari', { fetched: -1 }), ok('mercari', { inserted: 1.5 }),
      ok('amazon'), ok('mercari', { message: 1 }), 'x', null,
    ]) {
      expect((await pc.call('recordRun', lease, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(await count(f, 'select count(*)::int as n from app.collector_run where household_id = $1', a.householdId)).toBe(0)
    await record(ok('mercari'))
  })

  it('取得 0 件は empty として記録できる（ok にしなくてよい形）', async () => {
    const run = await record({ source: 'mercari', status: 'empty', fetched: 0, inserted: 0, message: '0件でした。画面構造が変わっている可能性があります' })
    expect(run).toMatchObject({ status: 'empty', fetched: 0 })
  })

  it('長いメッセージは切り詰めて保存する（断らない）', async () => {
    const run = await record(ok('mercari', { message: 'あ'.repeat(4000) }))
    expect((run.message as string).length).toBe(2000)
  })
})

describe('取り込みを終える（finish）', () => {
  it('結果はサーバーが実行記録から組み立てて result に入れる。画面の状態に runs が出る', async () => {
    const m = await record(ok('mercari'))
    const y = await record(ok('yahoo'))
    const r = await pc.call('finish', lease, { status: 'done', run_ids: [m.id, y.id] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.result).toMatchObject({ status: 'done', notified: false })
    expect(typeof r.body.result.finished_at).toBe('string')

    const job = (await ask(a, 'getCollectStatus')).body.result.job
    expect(job).toMatchObject({ status: 'done', message: null })
    expect(job.runs.map((x: { id: string }) => x.id).sort()).toEqual([m.id, y.id].sort())
    expect(job.runs[0]).toHaveProperty('shop_account_name')
    expect(job.finished_at).not.toBeNull()
  })

  it('done にできるのは、実行記録が 1 つ以上あり、失敗・要ログインが無いときだけ', async () => {
    const empty = await pc.call('finish', lease, { status: 'done', run_ids: [] })
    expect(empty.status).toBe(400)
    expect(empty.body.error?.message).toContain('実行記録が 1 つもない')

    const failed = await record({ source: 'mercari', status: 'failed', fetched: 0, inserted: 0, message: '通信に失敗しました' })
    const auth = await record({ source: 'yahoo', status: 'auth_required', fetched: 0, inserted: 0, message: 'ログインし直してください' })
    for (const id of [failed.id, auth.id]) {
      const r = await pc.call('finish', lease, { status: 'done', run_ids: [id] })
      expect(r.status).toBe(400)
      expect(r.body.error?.message).toContain('完了')
    }
    // 断られた取り込みは、まだ走っている
    expect((await ask(a, 'getCollectStatus')).body.result.job.status).toBe('running')
    // 途中で止まった扱いなら終えられる
    expect((await pc.call('finish', lease, { status: 'partial', run_ids: [failed.id, auth.id] })).status).toBe(200)
  })

  it('0 件（empty）は done にできるが、通知を積む。取得 0 件を静かに成功にしない', async () => {
    const run = await record({ source: 'mercari', status: 'empty', fetched: 0, inserted: 0, message: '0件でした' })
    const r = await pc.call('finish', lease, { status: 'done', run_ids: [run.id] })
    expect(r.body.result).toMatchObject({ status: 'done', notified: true })
    const [event] = await events()
    expect(event.title).toBe('メルカリの取り込みが 0 件でした（リビングの PC）')
  })

  it('知らない実行記録・他の世帯の記録・終わっていない記録は断る', async () => {
    const mine = await record(ok('mercari'))
    const other = f.world.b
    const foreign = await other.run((ctx) => ctx.sql.get<{ id: string }>(
      `insert into collector_run (started_at, finished_at, source, status) values (now(), now(), 'mercari', 'ok') returning id`))
    const unfinished = await a.run((ctx) => ctx.sql.get<{ id: string }>(
      `insert into collector_run (started_at, source) values (now(), 'yahoo') returning id`))

    expect((await pc.call('finish', lease, { status: 'partial', run_ids: [foreign!.id] })).status).toBe(404)
    expect((await pc.call('finish', lease, { status: 'partial', run_ids: ['00000000-0000-4000-8000-000000000999'] })).status).toBe(404)
    expect((await pc.call('finish', lease, { status: 'partial', run_ids: [mine.id, unfinished!.id] })).status).toBe(400)
    expect((await pc.call('finish', lease, { status: 'partial', run_ids: ['x'] })).status).toBe(400)
    expect((await pc.call('finish', lease, { status: 'bogus', run_ids: [] })).status).toBe(400)
    expect((await pc.call('finish', lease, { run_ids: [] })).status).toBe(400)
    expect((await pc.call('finish', lease, null)).status).toBe(400)
    // 重複した id は 1 つに数える
    expect((await pc.call('finish', lease, { status: 'done', run_ids: [mine.id, mine.id] })).status).toBe(200)
  })

  it('補足（message）は 500 文字まで。渡せば画面の状態にそのまま出て、無ければ問題のある実行記録から作る', async () => {
    const run = await record({ source: 'mercari', status: 'auth_required', fetched: 0, inserted: 0, message: 'ログインし直してください' })
    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [run.id], message: 'x'.repeat(501) })).status).toBe(400)
    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [run.id] })).status).toBe(200)
    const job = (await ask(a, 'getCollectStatus')).body.result.job
    expect(job).toMatchObject({ status: 'failed', message: 'メルカリ：ログインが必要です（ログインし直してください）' })
  })

  it('PC がやめた（cancelled）取り込みは cancelled。実行記録が全部 ok なら通知しない', async () => {
    const run = await record(ok('mercari'))
    const r = await pc.call('finish', lease, { status: 'cancelled', run_ids: [run.id], message: 'アプリを閉じました' })
    expect(r.body.result).toMatchObject({ status: 'cancelled', notified: false })
    expect((await ask(a, 'getCollectStatus')).body.result.job).toMatchObject({ status: 'cancelled', message: 'アプリを閉じました' })
    expect(await events()).toEqual([])
  })
})

describe('終わりの通知（kind = collect）', () => {
  it('全部 ok なら積まれない', async () => {
    const m = await record(ok('mercari'))
    const y = await record(ok('yahoo'))
    expect((await pc.call('finish', lease, { status: 'done', run_ids: [m.id, y.id] })).body.result.notified).toBe(false)
    expect(await events()).toEqual([])
  })

  it('失敗：どの取り込み元か・PC の名前・理由を本文に。dedupe_key は job id', async () => {
    const m = await record(ok('mercari'))
    const y = await record({ source: 'yahoo', status: 'failed', fetched: 0, inserted: 0, message: '通信に失敗しました' })
    const r = await pc.call('finish', lease, { status: 'partial', run_ids: [m.id, y.id] })
    expect(r.body.result.notified).toBe(true)
    expect(await events()).toEqual([{
      kind: 'collect', title: 'Yahoo!フリマの取り込みに失敗しました（リビングの PC）',
      body: 'Yahoo!フリマ：失敗しました（通信に失敗しました）', url: '/', dedupe_key: `collect:${lease.job_id}`,
    }])
  })

  it('要ログイン：「…にログインが必要です（PC）」。メロジョイは仕入先の名前つき。要ログインが最優先', async () => {
    const shop = await a.run((ctx) => createShopAccount(ctx, 'メロジョイ A', 'mellojoy'))
    const e = await record({ source: 'mercari', status: 'empty', fetched: 0, inserted: 0, message: '0件でした' })
    const j = await record({ source: 'mellojoy', shop_account_id: shop, status: 'auth_required', fetched: 0, inserted: 0, message: 'セッションが切れています' })
    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [e.id, j.id] })).body.result.notified).toBe(true)
    const [event] = await events()
    expect(event.title).toBe('メロジョイ（メロジョイ A）にログインが必要です（リビングの PC）')
    expect(event.body).toBe('メルカリ：0 件でした（0件でした）\nメロジョイ（メロジョイ A）：ログインが必要です（セッションが切れています）')
  })

  it('実行記録が無いまま失敗・途中で止まった取り込みも通知する', async () => {
    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [] })).body.result.notified).toBe(true)
    expect((await events())[0].title).toBe('取り込みに失敗しました（リビングの PC）')
  })

  it('問題のある記録が無く途中で止まったなら「途中で止まりました」', async () => {
    const m = await record(ok('mercari'))
    expect((await pc.call('finish', lease, { status: 'partial', run_ids: [m.id], message: '時間切れ' })).body.result.notified).toBe(true)
    const [event] = await events()
    expect(event.title).toBe('取り込みが途中で止まりました（リビングの PC）')
    expect(event.body).toBe('時間切れ')
  })

  it('購読している端末のうち、取り込みの通知を受け取る設定の端末にだけ配送を作る', async () => {
    const insert = (endpoint: string, collect: boolean) => f.dom.pg.query(
      `insert into app.push_subscription (household_id, user_id, endpoint, p256dh, auth, label, kind_collect)
       values ($1, $2, $3, 'p', 'a', $3, $4)`, [a.householdId, a.userId, endpoint, collect])
    await insert('https://push.example.test/on', true)
    await insert('https://push.example.test/off', false)

    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [] })).body.result.notified).toBe(true)
    const rows = (await f.dom.pg.query<{ endpoint: string; status: string }>(
      `select s.endpoint, d.status from app.notification_delivery d join app.push_subscription s on s.id = d.subscription_id
        where d.household_id = $1`, [a.householdId])).rows
    expect(rows).toEqual([{ endpoint: 'https://push.example.test/on', status: 'pending' }])
  })

  it('他の世帯には届かない', async () => {
    await f.dom.pg.query(
      `insert into app.push_subscription (household_id, user_id, endpoint, p256dh, auth) values ($1, $2, 'https://push.example.test/b', 'p', 'a')`,
      [f.world.b.householdId, f.world.b.userId])
    await pc.call('finish', lease, { status: 'failed', run_ids: [] })
    expect(await count(f, 'select count(*)::int as n from app.notification_delivery where household_id = $1', f.world.b.householdId)).toBe(0)
    expect(await count(f, 'select count(*)::int as n from app.notification_event where household_id = $1', f.world.b.householdId)).toBe(0)
  })
})

describe('通知の文面（collectNotification）', () => {
  const run = (over: Record<string, unknown>) => ({
    id: 'r', started_at: 't', finished_at: 't', status: 'ok', fetched: 1, inserted: 1, message: null, source: 'mercari',
    shop_account_id: null, shop_account_name: null, ...over,
  }) as never

  it('問題が無ければ null、あれば PC の名前入り。長い文は 200・1000 文字に収める', () => {
    expect(collectNotification('done', [run({}), run({ source: 'yahoo' })], 'PC', null)).toBeNull()
    expect(collectNotification('cancelled', [run({})], 'PC', null)).toBeNull()
    expect(collectNotification('failed', [], 'PC', null)?.title).toBe('取り込みに失敗しました（PC）')

    const long = collectNotification('failed', [run({ status: 'failed', message: 'あ'.repeat(3000) })], 'い'.repeat(500), 'う'.repeat(900))!
    expect([...long.title].length).toBeLessThanOrEqual(200)
    expect([...long.body].length).toBeLessThanOrEqual(1000)
  })
})
