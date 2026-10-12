import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findHouseholdsWithTrackingQueue } from '../../cron/tracking'
import { fromPglite } from '../../db/pglite'
import { createMigratedDb } from '../../test/migrate'
import { reapStaleCollectJobs } from '../../../workers/cron/index'
import { migrateToWeb, MigrationVerifyError } from '../../../tools/migrate-to-web/migrate'
import { formatReport } from '../../../tools/migrate-to-web/report'
import {
  callAgent, callRpc, closeFixture, jwtOf, leaseOf, openFixture, registerPc, resetWorld, type Fixture,
} from '../collect/helpers'
import {
  createHouseholdFor, imagesForFixture, loadFixture, recordingUploader, sequentialIds, snapshotFromFixture,
} from '../migrate/helpers'
import { sqlstateOf } from './helpers'

// 接続のユーザーそのものを soroban_gateway にして（set session authorization。接続の間ずっと）、
// サーバーの入口・取り込み担当・定期実行・移行の道具が、そのまま最後まで動くことを確かめる。
// どれも「世帯を引く 2 つの関数を呼ぶ → set role で soroban_api / soroban_cron に切り替える」以外の権限は要らない。
// （本物の Supabase ではまだ試していない。PGlite の上の確認）

let f: Fixture

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  await f.dom.pg.exec('set session authorization postgres').catch(() => {})
  await closeFixture(f)
})

/**
 * fn の間だけ、接続のユーザーをゲートウェイにする（終わったら postgres に戻す）。
 * PGlite では eset session authorization が元に戻らない（ゲートウェイのまま残る）ので、postgres を明示して戻す
 */
async function asGatewayConnection<T>(pg: { exec(sql: string): Promise<unknown> }, fn: () => Promise<T>): Promise<T> {
  await pg.exec('set session authorization soroban_gateway')
  try {
    return await fn()
  } finally {
    await pg.exec('set session authorization postgres')
  }
}

describe('サーバーの入口（画面の API・取り込み担当の API）', () => {
  it('JWT → 世帯の照会 → 世帯のトランザクション、鍵 → PC の照会 → 世帯のトランザクションが、ゲートウェイの接続で動く', async () => {
    await resetWorld(f)
    const a = f.world.a
    const b = f.world.b
    const jwtA = `Bearer ${await jwtOf(f, a)}`

    await asGatewayConnection(f.dom.pg, async () => {
      // 画面の API：世帯の照会（household_of_user）は set role の前、ゲートウェイのまま
      const status = await callRpc(f, 'getCollectStatus', [], jwtA)
      expect(status.status, JSON.stringify(status.body)).toBe(200)
      const settings = await callRpc(f, 'getSettings', [], jwtA)
      expect(settings.status).toBe(200)

      // 世帯に属さない人は 403（世帯の照会が null を返す）
      const stranger = await import('../rpc/helpers').then(async (h) => h.signToken({ key: f.key, sub: h.USER_NOBODY }))
      expect((await callRpc(f, 'getSettings', [], `Bearer ${stranger}`)).status).toBe(403)

      // 取り込み担当：register（JWT）→ claim（鍵 → agent_of_token）→ 書き込み → 終了 → 鍵を捨てる
      const pc = await registerPc(f, a)
      await a.call('requestCollect')
      const claimed = await pc.call('claim')
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200)
      const lease = claimed.body.result as { job_id: string; lease_token: string }
      const run = await pc.call('recordRun', leaseOf(lease), { source: 'mercari', status: 'ok', fetched: 1, inserted: 0 })
      expect(run.status, JSON.stringify(run.body)).toBe(200)
      const done = await pc.call('finish', leaseOf(lease), { status: 'done', run_ids: [run.body.result.id] })
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      expect((await pc.call('unregister')).status).toBe(200)
      expect((await pc.call('claim')).status).toBe(401)

      // 世帯 B の人は、自分の世帯のことしか見えない
      const pcB = await registerPc(f, b, 'B の PC')
      expect((await pcB.call('claim')).status).toBe(200)
      expect((await callRpc(f, 'listAgentDevices', [], `Bearer ${await jwtOf(f, b)}`)).body.result).toHaveLength(1)
    })
  })

  it('set role を忘れたコード（接続のまま app の表を読む）は、他の世帯の行を読めずに権限エラーで止まる', async () => {
    await resetWorld(f)
    await registerPc(f, f.world.a) // 行を作っておく（接続したロール）
    await asGatewayConnection(f.dom.pg, async () => {
      expect(await sqlstateOf(() => f.dom.root.get('select count(*) from app.collect_job'))).toBe('42501')
      expect(await sqlstateOf(() => f.dom.root.get('select * from app.household_member'))).toBe('42501')
      expect(await sqlstateOf(() => f.dom.root.run('delete from app.sale'))).toBe('42501')
      // 世帯の文脈の外で業務の関数も呼べない
      expect(await sqlstateOf(() => f.dom.root.get('select app.enqueue_collect_job()'))).toBe('42501')
    })
    // 接続を戻せば（対照）、全世帯が見える
    const n = await f.dom.pg.query<{ n: number }>('select count(*)::int as n from app.household_member')
    expect(n.rows[0].n).toBeGreaterThanOrEqual(2)
  })

  it('バレる前提の入口でも、鍵の無い・壊れた要求は 401（ゲートウェイでも同じ）', async () => {
    await resetWorld(f)
    await asGatewayConnection(f.dom.pg, async () => {
      expect((await callAgent(f, 'claim', [], null)).status).toBe(401)
      expect((await callAgent(f, 'claim', [], `Agent sbagent_${'A'.repeat(43)}`)).status).toBe(401)
    })
  })
})

describe('定期実行（Cron の Worker）', () => {
  it('期限切れの取り込み要求の片付け・追跡のキューの探索が、ゲートウェイから soroban_cron に切り替えて動く', async () => {
    await resetWorld(f)
    const job = await f.world.a.run(async (ctx) => ctx.sql.get<{ id: string }>('select (app.enqueue_collect_job()).id as id'))
    await f.dom.pg.query(`update app.collect_job set requested_at = now() - interval '6 minutes' where id = $1`, [job!.id])

    await asGatewayConnection(f.dom.pg, async () => {
      expect(await reapStaleCollectJobs(f.dom.root)).toBeGreaterThanOrEqual(1)
      expect(await findHouseholdsWithTrackingQueue(f.dom.root, 10)).toBeInstanceOf(Array)
    })
    const after = await f.dom.pg.query<{ status: string }>('select status from app.collect_job where id = $1', [job!.id])
    expect(after.rows[0].status).toBe('cancelled')
  })
})

describe('データ移行の道具（tools/migrate-to-web）', () => {
  it('ゲートウェイの接続でも最後まで動き、突き合わせがすべて一致する（postgres の接続は要らない）', async () => {
    const fx = loadFixture()
    const pg = await createMigratedDb()
    try {
      await pg.exec("set time zone 'UTC'")
      const { householdId } = await createHouseholdFor(pg, '移行先')
      const uploader = recordingUploader()
      const out = await asGatewayConnection(pg, () =>
        migrateToWeb({
          sql: fromPglite(pg), householdId,
          // 在庫コードの採番（item_code_seq）が、移した在庫のコードの最大以上であること、の確認に要る設定だけ足す
          snapshot: snapshotFromFixture(fx, { tables: { setting: [{ key: 'item_code_seq', value: '99' }] } }),
          images: { source: imagesForFixture(fx), uploader }, newId: sequentialIds(),
        }).catch((e: unknown) => {
          // 不一致のときは、レポート（どの表が違ったか）を失敗の文に載せる
          throw e instanceof MigrationVerifyError ? new Error(formatReport(e.report)) : e
        }))
      expect(out.report.ok).toBe(true)
      expect(out.report.tables.every((t) => t.ok)).toBe(true)
      const sales = await pg.query<{ n: number }>('select count(*)::int as n from app.sale where household_id = $1', [householdId])
      expect(sales.rows[0].n).toBe(fx.tables.sale.length)
    } finally {
      await pg.exec('set session authorization postgres').catch(() => {})
      await pg.close()
    }
  })
})
