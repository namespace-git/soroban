import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { subtractDaysJst, todayJst } from '../../domain/_shared'
import * as master from '../../domain/master'
import * as purchase from '../../domain/purchase'
import { savePushSubscription } from '../../domain/push'
import * as sale from '../../domain/sale'
import { arrivalMessage, clip, enqueueNotification, enqueueSafely, formatYen, saleMessage, shippingMessage } from '../../push/notify'
import { newWorld, openDomainDb, type DomainDb, type World } from '../domain/helpers'
import { makeDevice, type TestDevice } from './helpers'

// 業務の書き込み（販売の取り込み・取引の進み・17TRACK の到着）と同じトランザクションで通知が積まれること。
// 積んだ通知は event 1 つ ＋ 受け取る端末ごとの配送。送るのは Cron（deliver.test.ts）

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

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)

interface EventRow { kind: string; title: string; body: string; url: string | null; dedupe_key: string }

async function eventsOf(hh: string): Promise<EventRow[]> {
  const r = await dom.pg.query<EventRow>(
    'select kind, title, body, url, dedupe_key from app.notification_event where household_id = $1 order by created_at, dedupe_key',
    [hh],
  )
  return r.rows
}

/** 端末 → その端末への配送の数（種類ごと） */
async function deliveriesByKind(hh: string): Promise<Record<string, number>> {
  const r = await dom.pg.query<{ kind: string; n: number }>(
    `select e.kind, count(*)::int as n
       from app.notification_delivery d join app.notification_event e on e.household_id = d.household_id and e.id = d.event_id
      where d.household_id = $1 group by e.kind`,
    [hh],
  )
  return Object.fromEntries(r.rows.map((x) => [x.kind, x.n]))
}

async function subscribe(m: World['a'] = w.a, device?: TestDevice): Promise<TestDevice> {
  const d = device ?? (await makeDevice())
  await m.run((c) => savePushSubscription(c, d.input))
  return d
}

const NEW_SALE = (id: string, over: Partial<Parameters<typeof sale.insertCollected>[1][number]> = {}) => ({
  mercariItemId: id, title: '【A040】もこ山 スクイーズ', price: 5750, soldAt: todayJst(), status: 'waiting_shipment' as const, ...over,
})

describe('文面', () => {
  it('formatYen：3 桁区切り。clip：改行・連続する空白を 1 つにして、コードポイントで切る（サロゲートペアを割らない）', () => {
    expect(formatYen(0)).toBe('¥0')
    expect(formatYen(999)).toBe('¥999')
    expect(formatYen(5750)).toBe('¥5,750')
    expect(formatYen(1234567)).toBe('¥1,234,567')
    expect(clip('a\n  b\t c', 10)).toBe('a b c')
    expect(clip('あいうえお', 5)).toBe('あいうえお')
    expect(clip('あいうえおか', 5)).toBe('あいうえ…')
    expect(Array.from(clip('😀'.repeat(10), 4))).toHaveLength(4)
    expect(clip('😀'.repeat(10), 4)).toBe('😀😀😀…')
  })

  it('売れた・発送・到着の文面と dedupe_key', () => {
    expect(saleMessage({ id: 'S1', title: '【A040】もこ山 スクイーズ', price: 5750 })).toEqual({
      kind: 'sale', title: '売れました：【A040】もこ山 スクイーズ ¥5,750', body: '', url: '/?tab=sales&sale=S1', dedupeKey: 'sale:S1',
    })
    expect(shippingMessage({ id: 'S1', title: '商品' })).toMatchObject({
      kind: 'shipping', title: '発送してください：商品', url: '/?tab=sales&sale=S1', dedupeKey: 'shipping:S1',
    })
    expect(arrivalMessage({ id: 'P1', supplier: 'メロジョイA', quantity: 3 })).toMatchObject({
      kind: 'arrival', title: 'メロジョイAの荷物が届きました（3 点）', url: '/?tab=purchases&purchase=P1', dedupeKey: 'arrival:P1',
    })
    // 点数が分からなければ（明細が無い）点数を書かない
    expect(arrivalMessage({ id: 'P1', supplier: 'メロジョイA', quantity: 0 }).title).toBe('メロジョイAの荷物が届きました')
    // 仕入先の名前を読めない経路（Cron）
    expect(arrivalMessage({ id: 'P1', supplier: null, quantity: 2 }).title).toBe('仕入れた荷物が届きました（2 点）')
    expect(arrivalMessage({ id: 'P1', supplier: '  ', quantity: 0 }).title).toBe('仕入れた荷物が届きました')
  })

  it('題名は 200 文字・商品名は切って、DB の上限（200 文字）に必ず収まる', () => {
    expect(saleMessage({ id: 'S1', title: 'あ'.repeat(1000), price: 1 }).title.length).toBeLessThanOrEqual(200)
  })
})

describe('販売が増えた（insertCollected → sale）', () => {
  it('新しく入った販売ごとに 1 つ。端末の数だけ配送ができる', async () => {
    await subscribe()
    await subscribe()
    const [row] = await A((c) => sale.insertCollected(c, [NEW_SALE('m1001')]))
    const events = await eventsOf(w.a.householdId)
    expect(events).toEqual([{
      kind: 'sale', title: '売れました：【A040】もこ山 スクイーズ ¥5,750', body: '',
      url: `/?tab=sales&sale=${row.id}`, dedupe_key: `sale:${row.id}`,
    }])
    expect(await deliveriesByKind(w.a.householdId)).toEqual({ sale: 2 })
  })

  it('2 件入れれば 2 つ。価格は円の整数のまま文面に入る', async () => {
    await A((c) => sale.insertCollected(c, [NEW_SALE('m2001', { price: 1200 }), NEW_SALE('m2002', { title: '別の商品', price: 980000 })]))
    const events = await eventsOf(w.a.householdId)
    expect(events.map((e) => e.title).sort()).toEqual(['売れました：【A040】もこ山 スクイーズ ¥1,200', '売れました：別の商品 ¥980,000'])
  })

  it('取引完了（販売履歴からまとめて入る過去の販売）と、3 日より前の販売は通知しない。状態が取れていない今日の販売は通知する', async () => {
    const old = subtractDaysJst(todayJst(), 4)
    const edge = subtractDaysJst(todayJst(), 3)
    await A((c) => sale.insertCollected(c, [
      NEW_SALE('m3001', { status: 'completed' }),
      NEW_SALE('m3002', { status: undefined, soldAt: old }),
      NEW_SALE('m3003', { status: undefined, soldAt: edge }),
      NEW_SALE('m3004', { status: undefined }),
      NEW_SALE('m3005', { status: 'waiting_payment' }),
    ]))
    const rows = await A((c) => c.sql.all<{ channel_item_id: string; id: string }>('select channel_item_id, id from sale'))
    const idOf = Object.fromEntries(rows.map((r) => [r.channel_item_id, r.id]))
    const keys = (await eventsOf(w.a.householdId)).map((e) => e.dedupe_key).sort()
    expect(keys).toEqual([`sale:${idOf.m3003}`, `sale:${idOf.m3004}`, `sale:${idOf.m3005}`].sort())
  })

  it('手入力の販売（createSale）は通知しない（人が自分で入れた）', async () => {
    await subscribe()
    await A((c) => sale.createSale(c, { title: '手入力', sold_at: todayJst(), price: 1000 }))
    expect(await eventsOf(w.a.householdId)).toEqual([])
  })

  it('同じ販売の通知は二度積まれない（dedupe_key）', async () => {
    await subscribe()
    const [row] = await A((c) => sale.insertCollected(c, [NEW_SALE('m4001')]))
    const again = await A((c) => enqueueNotification(c.sql, saleMessage({ id: row.id, title: 'x', price: 1 })))
    expect(again).toBeNull()
    expect(await eventsOf(w.a.householdId)).toHaveLength(1)
    expect(await deliveriesByKind(w.a.householdId)).toEqual({ sale: 1 })
  })

  it('業務が巻き戻れば通知も消える（同じトランザクション）', async () => {
    await subscribe()
    await expect(A(async (c) => {
      await sale.insertCollected(c, [NEW_SALE('m5001')])
      throw new Error('あとで失敗')
    })).rejects.toThrow('あとで失敗')
    expect(await eventsOf(w.a.householdId)).toEqual([])
    expect(await A((c) => c.sql.all('select id from sale'))).toHaveLength(0)
  })

  it('通知を積めなくても販売の取り込みは続く（SAVEPOINT の中で積む）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await A(async (c) => {
        await sale.insertCollected(c, [NEW_SALE('m6001')])
        // dedupe_key が長すぎて DB が断る。ここで投げずに null を返し、先の書き込みは残る
        const r = await enqueueSafely(c, { ...saleMessage({ id: 'x', title: 't', price: 1 }), dedupeKey: 'k'.repeat(301) })
        expect(r).toBeNull()
        await sale.insertCollected(c, [NEW_SALE('m6002')])
      })
      expect(spy).toHaveBeenCalled()
      expect(await A((c) => c.sql.all('select id from sale'))).toHaveLength(2)
      expect(await eventsOf(w.a.householdId)).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('長い商品名でも取り込みは止まらず、題名は 200 文字以内', async () => {
    await A((c) => sale.insertCollected(c, [NEW_SALE('m7001', { title: '長い題名 '.repeat(100) })]))
    const [e] = await eventsOf(w.a.householdId)
    expect(Array.from(e.title).length).toBeLessThanOrEqual(200)
    expect(e.title.startsWith('売れました：長い題名')).toBe(true)
    expect(e.title.endsWith('¥5,750')).toBe(true)
  })
})

describe('発送の番になった（updateSaleStatus → shipping）', () => {
  it('発送待ちに変わったとき 1 つ。同じ状態への更新・後戻りでは積まれない', async () => {
    await subscribe()
    const [row] = await A((c) => sale.insertCollected(c, [NEW_SALE('m8001', { status: 'waiting_payment' })]))
    // 入金待ちで入った時点では「売れました」だけ
    expect(await eventsOf(w.a.householdId).then((e) => e.map((x) => x.kind))).toEqual(['sale'])

    expect(await A((c) => sale.updateSaleStatus(c, 'm8001', 'waiting_shipment'))).toBe(true)
    const shipping = (await eventsOf(w.a.householdId)).filter((e) => e.kind === 'shipping')
    expect(shipping).toEqual([{
      kind: 'shipping', title: '発送してください：【A040】もこ山 スクイーズ', body: '',
      url: `/?tab=sales&sale=${row.id}`, dedupe_key: `shipping:${row.id}`,
    }])
    expect(await deliveriesByKind(w.a.householdId)).toEqual({ sale: 1, shipping: 1 })

    expect(await A((c) => sale.updateSaleStatus(c, 'm8001', 'waiting_shipment'))).toBe(false)
    expect(await A((c) => sale.updateSaleStatus(c, 'm8001', 'waiting_payment'))).toBe(false)
    expect((await eventsOf(w.a.householdId)).filter((e) => e.kind === 'shipping')).toHaveLength(1)
  })

  it('発送待ちを通り越した更新（発送済みへ）・知らない商品 ID では積まれない', async () => {
    await A((c) => sale.insertCollected(c, [NEW_SALE('m8101', { status: 'waiting_payment' })]))
    expect(await A((c) => sale.updateSaleStatus(c, 'm8101', 'shipped'))).toBe(true)
    expect(await A((c) => sale.updateSaleStatus(c, 'nothing', 'waiting_shipment'))).toBe(false)
    expect((await eventsOf(w.a.householdId)).filter((e) => e.kind === 'shipping')).toEqual([])
  })

  it('入金待ち → 発送待ち → 発送済み と進んでも、発送の通知は 1 回', async () => {
    await A((c) => sale.insertCollected(c, [NEW_SALE('m8201', { status: 'waiting_payment' })]))
    for (const s of ['waiting_shipment', 'shipped', 'delivered', 'completed'] as const) {
      await A((c) => sale.updateSaleStatus(c, 'm8201', s))
    }
    expect((await eventsOf(w.a.householdId)).filter((e) => e.kind === 'shipping')).toHaveLength(1)
  })
})

describe('仕入が届いた（applyTrackingResult → arrival）', () => {
  async function newPurchase(fulfillment: 'shipped' | 'delivered' | null = 'shipped') {
    const shop = await A((c) => master.createShopAccount(c, 'メロジョイA'))
    return A((c) => purchase.createPurchase(c, {
      shop_account_id: shop, ordered_at: '2026-01-01', fulfillment,
      lines: [{ name: 'A', unit_price: 100, quantity: 2 }, { name: 'B', unit_price: 100, quantity: 1 }],
    }))
  }
  const delivered = (id: string, at: string | null = '2026-03-03') => A((c) => purchase.applyTrackingResult(c, id, {
    status_text: '配達完了', fulfillment: 'delivered', delivered_at: at,
  }))

  it('17TRACK で初めて到着済になったとき 1 つ。仕入先の名前と点数が入る', async () => {
    await subscribe()
    const id = await newPurchase()
    expect(await delivered(id)).toBe(true)
    expect(await eventsOf(w.a.householdId)).toEqual([{
      kind: 'arrival', title: 'メロジョイAの荷物が届きました（3 点）', body: '',
      url: `/?tab=purchases&purchase=${id}`, dedupe_key: `arrival:${id}`,
    }])
    expect(await deliveriesByKind(w.a.householdId)).toEqual({ arrival: 1 })
  })

  it('配送中のままの結果・すでに到着済のものでは積まれない。同じ仕入が行き来しても二度は積まれない', async () => {
    const id = await newPurchase()
    await A((c) => purchase.applyTrackingResult(c, id, { status_text: '輸送中', fulfillment: 'shipped', delivered_at: null }))
    expect(await eventsOf(w.a.householdId)).toEqual([])

    await delivered(id)
    expect(await eventsOf(w.a.householdId)).toHaveLength(1)
    // 日付の訂正など（状態は変わらない）では積まれない
    await delivered(id, '2026-03-02')
    expect(await eventsOf(w.a.householdId)).toHaveLength(1)
    // 人が戻して、17TRACK がもう一度到着済にしても、同じ仕入の通知は二度積まれない
    await A((c) => purchase.setPurchaseFulfillment(c, id, 'shipped'))
    await delivered(id)
    expect(await eventsOf(w.a.householdId)).toHaveLength(1)
  })

  it('人が先に到着済にしていた仕入は積まれない（人が自分で押した）', async () => {
    const id = await newPurchase('delivered')
    await delivered(id)
    expect(await eventsOf(w.a.householdId)).toEqual([])
  })

  it('更新の見た言葉だけが進む（fulfillment が読めなかった）ときは積まれない', async () => {
    const id = await newPurchase()
    await A((c) => purchase.applyTrackingResult(c, id, { status_text: '謎', fulfillment: null, delivered_at: null }))
    expect(await eventsOf(w.a.householdId)).toEqual([])
  })
})

describe('配る相手：種類の設定・世帯・人', () => {
  it('種類を切った端末には配らない。切っていない端末には配る', async () => {
    await subscribe(w.a, await makeDevice({ label: '全部', kinds: {} }))
    await subscribe(w.a, await makeDevice({ label: '売れた以外', kinds: { sale: false } }))
    await subscribe(w.a, await makeDevice({ label: '到着だけ', kinds: { sale: false, shipping: false, collect: false } }))

    await A((c) => sale.insertCollected(c, [NEW_SALE('m9001', { status: 'waiting_payment' })]))
    await A((c) => sale.updateSaleStatus(c, 'm9001', 'waiting_shipment'))
    const id = await A(async (c) => purchase.createPurchase(c, {
      shop_account_id: await master.createShopAccount(c, '店'), ordered_at: '2026-01-01', fulfillment: 'shipped',
      lines: [{ name: 'A', unit_price: 1, quantity: 1 }],
    }))
    await A((c) => purchase.applyTrackingResult(c, id, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: null }))

    const r = await dom.pg.query<{ label: string; kind: string }>(
      `select s.label, e.kind
         from app.notification_delivery d
         join app.push_subscription s on s.household_id = d.household_id and s.id = d.subscription_id
         join app.notification_event e on e.household_id = d.household_id and e.id = d.event_id
        where d.household_id = $1 order by s.label, e.kind`,
      [w.a.householdId],
    )
    expect(r.rows.map((x) => `${x.label}:${x.kind}`).sort()).toEqual([
      '全部:arrival', '全部:sale', '全部:shipping',
      '到着だけ:arrival',
      '売れた以外:arrival', '売れた以外:shipping',
    ].sort())
  })

  it('別の世帯の端末には配らない。別の世帯の通知も作られない', async () => {
    await subscribe(w.b)
    await A((c) => sale.insertCollected(c, [NEW_SALE('m9101')]))
    expect(await eventsOf(w.b.householdId)).toEqual([])
    expect(await deliveriesByKind(w.b.householdId)).toEqual({})
  })

  it('Cron（soroban_cron）の経路からも同じ文面で積める：世帯の文脈を渡せば、その世帯の端末にだけ配る', async () => {
    await subscribe(w.a)
    await subscribe(w.b)
    const id = randomUUID()
    const event = await dom.root.tx(async (sql) => {
      await sql.run('set local role soroban_cron')
      await sql.get("select set_config('app.household_id', ?, true)", w.a.householdId)
      return enqueueNotification(sql, arrivalMessage({ id, supplier: null, quantity: 3 }))
    })
    expect(event).not.toBeNull()
    expect(await eventsOf(w.a.householdId)).toMatchObject([{ kind: 'arrival', title: '仕入れた荷物が届きました（3 点）', dedupe_key: `arrival:${id}` }])
    expect(await deliveriesByKind(w.a.householdId)).toEqual({ arrival: 1 })
    expect(await deliveriesByKind(w.b.householdId)).toEqual({})
  })

  it('端末が 1 つも無くても出来事は残る（あとで端末を足しても過去の通知は送らない）', async () => {
    await A((c) => sale.insertCollected(c, [NEW_SALE('m9201')]))
    expect(await eventsOf(w.a.householdId)).toHaveLength(1)
    expect(await deliveriesByKind(w.a.householdId)).toEqual({})
    await subscribe()
    expect(await deliveriesByKind(w.a.householdId)).toEqual({})
  })
})
