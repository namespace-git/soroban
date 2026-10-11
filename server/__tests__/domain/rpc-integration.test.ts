import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { mediaUrl } from '../../domain/_shared'
import { handleRpc, handlers } from '../../rpc'
// 登録の副作用（入口の functions/api/rpc/[method].ts と同じ import）
import '../../domain/index'
import { makeKey, signToken, stubJwks, type KeyPair } from '../rpc/helpers'
import { MEDIA_BASE, SUPABASE_URL, newWorld, openDomainDb, type DomainDb, type World } from './helpers'

// JWT → 認証（本物の app.household_of_user）→ 世帯のトランザクション → ドメインの関数、までを通して確かめる

let dom: DomainDb
let w: World
let key: KeyPair

beforeAll(async () => {
  dom = await openDomainDb()
  w = await newWorld(dom)
  key = await makeKey('domain-key')
  stubJwks([key])
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await dom.close()
})

async function call(method: string, args: unknown[], sub: string, handlerOverride?: Record<string, (ctx: Ctx, ...a: any[]) => Promise<unknown>>) {
  const token = await signToken({ key, sub })
  const request = new Request(`http://localhost/api/rpc/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ args }),
  })
  const response = await handleRpc(request, method, { root: dom.root, env: { SUPABASE_URL }, handlers: handlerOverride ?? handlers })
  return { status: response.status, body: JSON.parse(await response.text()) as { result?: unknown; error?: { code: string; message: string } } }
}

describe('handleRpc：JWT から世帯のドメインまで', () => {
  it('入口の import だけで master / cash の 27 本が登録されている', () => {
    const names = [
      'listTags', 'createTag', 'renameTag', 'deleteTag',
      'listShopAccounts', 'listShopAccountStats', 'createShopAccount', 'updateShopAccount', 'deleteShopAccount',
      'listShippingMethods', 'saveShippingMethod', 'deleteShippingMethod', 'getSettings', 'setSetting', 'listRuns', 'logClient',
      'listCashAccounts', 'createCashAccount', 'updateCashAccount', 'listLiabilities', 'createLiability', 'updateLiability',
      'deleteLiability', 'listCashEntries', 'createCashEntry', 'deleteCashEntry', 'getCashMonth',
    ]
    expect(names).toHaveLength(27)
    for (const name of names) expect(typeof handlers[name as keyof typeof handlers], name).toBe('function')
  })

  it('世帯 A のユーザーが書いたものは A にだけ見える（JWT の sub で世帯が決まる）', async () => {
    const created = await call('createTag', ['トークン経由'], w.a.userId)
    expect(created.status).toBe(200)
    const tagId = created.body.result as string

    expect((await call('listTags', [], w.a.userId)).body.result).toEqual([{ id: tagId, name: 'トークン経由', sort_order: 0 }])
    expect((await call('listTags', [], w.b.userId)).body.result).toEqual([])
    // B が A のタグの id で改名しようとしても、見つからない
    const denied = await call('renameTag', [tagId, '乗っ取り'], w.b.userId)
    expect(denied.status).toBe(404)
    expect(denied.body.error).toEqual({ code: 'not_found', message: 'タグが見つかりません' })
  })

  it('世帯に属さないユーザーは 403（ドメインに入る前）', async () => {
    const r = await call('listTags', [], '00000000-0000-4000-8000-0000000000ee')
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('forbidden')
  })

  it('お金の出入りも通る（口座 → 入金 → 月の明細）。変な引数は 400', async () => {
    const accountId = (await call('createCashAccount', [{ name: '銀行', kind: 'bank', opening_balance: 0, opening_date: '2026-09-01' }], w.a.userId)).body.result as string
    const entry = await call('createCashEntry', [{ account_id: accountId, occurred_at: '2026-09-05', direction: 'in', amount: 44620, category: 'sale_payout' }], w.a.userId)
    expect(entry.status).toBe(200)
    const month = await call('getCashMonth', ['2026-09'], w.a.userId)
    expect(month.body.result).toMatchObject({ month: '2026-09', opening: 0, incoming_total: 44620, closing: 44620, free_cash: 44620 })
    // B の月には何も出ない
    expect((await call('getCashMonth', ['2026-09'], w.b.userId)).body.result).toMatchObject({ opening: 0, closing: 0, incoming: [] })

    const bad = await call('createCashEntry', ['x'], w.a.userId)
    expect(bad.status).toBe(400)
    expect(bad.body.error?.code).toBe('bad_request')
    const bad2 = await call('getCashMonth', [{}], w.a.userId)
    expect(bad2.status).toBe(400)
  })

  it('取り込み要求の取り消し（app.cancel_collect_job）の SB004 / SB005 が、409 / 404 になる', async () => {
    // 見つからない（他の世帯の要求も、RLS で見えないのでここに来る）→ 404
    const missing = await call('collect', [], w.a.userId, {
      collect: async (ctx) => void (await ctx.sql.get('select app.cancel_collect_job(gen_random_uuid())')),
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toEqual({ code: 'not_found', message: '取り込みの要求が見つかりません' })

    // もう始まっている（要求 → PC が取る → 取り消し）→ 409
    const started = await call('collect', [], w.a.userId, {
      collect: async (ctx) => {
        const job = await ctx.sql.get<{ id: string }>('select (app.enqueue_collect_job()).id as id')
        await ctx.sql.get('select app.claim_collect_job(?)', 'agent-1')
        await ctx.sql.get('select app.cancel_collect_job(?::uuid)', job!.id)
      },
    })
    expect(started.status).toBe(409)
    expect(started.body.error).toEqual({ code: 'conflict', message: '取り込みはもう始まっているので取り消せません（状態：running）' })
  })

  it('ハンドラの ctx.mediaBase は SUPABASE_URL から作られている', async () => {
    const r = await call('getSettings', [], w.a.userId, {
      getSettings: async (ctx) => ({ base: ctx.mediaBase, url: mediaUrl(ctx, `${ctx.householdId}/sale/x.jpg`) }),
    })
    expect(r.body.result).toEqual({ base: MEDIA_BASE, url: `${MEDIA_BASE}/${w.a.householdId}/sale/x.jpg` })
  })
})
