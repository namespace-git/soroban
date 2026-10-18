import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresSql, type PostgresSql } from '../../db/postgres'
import * as cash from '../../domain/cash'
import * as master from '../../domain/master'
import { loadTagsFor } from '../../domain/_shared'
import { DRIVER_NAMES, startBridge, type Bridge } from '../rpc/helpers'
import { memberOf, newWorld, openDomainDb, type DomainDb, type Member } from './helpers'

// 本番のドライバ（node-postgres）でも、PGlite のアダプタと同じ結果になること。
// 配列の引数（= any(?::uuid[])）・bigint の合計・date / timestamptz の読み出し・for update・returning など、
// ドメインが使う SQL を、PGlite を TCP で見せた入口（rpc/helpers.ts の startBridge）の上の node-postgres で流す

let dom: DomainDb
let bridge: Bridge
const opened: PostgresSql[] = []

beforeAll(async () => {
  dom = await openDomainDb()
  bridge = await startBridge(dom.pg)
})

afterAll(async () => {
  for (const sql of opened) await sql.end()
  await bridge.close()
  await dom.close()
})

const DRIVERS = DRIVER_NAMES

/** 新しい世帯 A を作り、指定のドライバ越しに操作する Member を返す */
async function memberVia(driver: (typeof DRIVERS)[number]): Promise<Member> {
  const world = await newWorld(dom)
  if (driver === 'PGlite') return world.a
  const sql = createPostgresSql(bridge.url)
  opened.push(sql)
  return memberOf({ root: sql }, world.a.householdId, world.a.userId)
}

describe.each(DRIVERS)('ドメインの SQL：%s', (driver) => {
  it('マスタ：タグ・仕入先（自動タグ・集計）・発送方法・設定・実行記録・ログ', async () => {
    const m = await memberVia(driver)

    const tagB = await m.run((c) => master.createTag(c, 'b'))
    const tagA = await m.run((c) => master.createTag(c, 'A'))
    expect(await m.run((c) => master.listTags(c))).toEqual([
      { id: tagB, name: 'b', sort_order: 0 }, { id: tagA, name: 'A', sort_order: 1 },
    ])
    await m.run((c) => master.renameTag(c, tagB, 'まとめ売り'))
    await expect(m.run((c) => master.createTag(c, 'A'))).rejects.toMatchObject({ code: 'conflict' })

    const shop = await m.run((c) => master.createShopAccount(c, 'メロジョイA', 'mellojoy'))
    await m.run((c) => master.updateShopAccount(c, shop, { auto_tag_ids: [tagA, tagB, tagA], import_keywords: 'a, b', default_shipping_fee: 399 }))
    const account = (await m.run((c) => master.getShopAccount(c, shop)))!
    expect(account).toMatchObject({ name: 'メロジョイA', kind: 'mellojoy', import_keywords: 'a, b', default_shipping_fee: 399, is_active: 1 })
    expect(account.auto_tags.map(t => t.id)).toEqual([tagB, tagA])
    await m.run((c) => master.updateShopAccount(c, shop, { auto_tag_ids: [tagA], is_active: 0 }))
    expect((await m.run((c) => master.listShopAccounts(c)))[0]).toMatchObject({ is_active: 0, auto_tags: [{ id: tagA, name: 'A', sort_order: 1 }] })

    const purchase = await m.run(async (c) => {
      const id = (await c.sql.get<{ id: string }>(`insert into purchase (shop_account_id, ordered_at) values (?, '2026-09-10') returning id`, shop))!.id
      await c.sql.run(`insert into purchase_line (purchase_id, name, unit_price, quantity, allocated_cost) values (?, '商品', 1000, 2, 300)`, id)
      await master.applyShopAccountAutoTags(c, id, shop)
      return id
    })
    expect(await m.run((c) => c.sql.all('select tag_id from purchase_tag where purchase_id = ?', purchase))).toEqual([{ tag_id: tagA }])
    expect(await m.run((c) => master.listShopAccountStats(c))).toEqual([
      { shop_account_id: shop, orders: 1, items: 2, total_cost: 2300, last_ordered_at: '2026-09-10' },
    ])
    await expect(m.run((c) => master.deleteShopAccount(c, shop))).rejects.toMatchObject({ code: 'conflict' })

    await m.run((c) => master.saveShippingMethod(c, { name: '新しい便', fee: 321, sort_order: 50 }))
    const methods = await m.run((c) => master.listShippingMethods(c))
    expect(methods).toHaveLength(9)
    expect(methods.find(x => x.name === '新しい便')).toMatchObject({ fee: 321, sort_order: 50, carrier: null, is_active: 1 })

    await m.run((c) => master.setSetting(c, 'fee_rate_bp', '1234'))
    await m.run((c) => master.setSetting(c, 'fee_rate_bp', '1500'))
    expect((await m.run((c) => master.getSettings(c))).fee_rate_bp).toBe('1500')

    const run1 = await m.run((c) => master.startRun(c, 'mellojoy', shop))
    const run2 = await m.run((c) => master.startRun(c, 'mercari'))
    const done = await m.run((c) => master.finishRun(c, run1, 'ok', 3, 2, 'メッセージ'))
    expect(done).toMatchObject({ id: run1, status: 'ok', fetched: 3, inserted: 2, message: 'メッセージ', source: 'mellojoy', shop_account_id: shop, shop_account_name: 'メロジョイA' })
    expect(done.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/)
    expect((await m.run((c) => master.listRuns(c, 5))).map(r => r.id)).toEqual([run2, run1])

    await m.run((c) => master.logClient(c, 'error', '画面の例外', { token: 'secret', list: [1, 2] }))
    expect(await m.run((c) => c.sql.all('select source, kind, message, payload from app_log'))).toEqual([
      { source: 'renderer', kind: 'error', message: '画面の例外', payload: '{"token":"***","list":[1,2]}' },
    ])

    const sale = await m.run(async (c) => (await c.sql.get<{ id: string }>(
      `insert into sale (title, sold_at, price) values ('販売', '2026-09-01', 1000) returning id`,
    ))!.id)
    await m.run((c) => c.sql.run('insert into sale_tag (sale_id, tag_id) values (?, ?), (?, ?)', sale, tagA, sale, tagB))
    const tags = await m.run((c) => loadTagsFor(c, 'sale_tag', 'sale_id', [sale, '00000000-0000-4000-8000-000000000001']))
    expect(tags.get(sale)!.map(t => t.name)).toEqual(['まとめ売り', 'A'])
    await m.run((c) => master.deleteTag(c, tagA))
    expect((await m.run((c) => loadTagsFor(c, 'sale_tag', 'sale_id', [sale]))).get(sale)!.map(t => t.name)).toEqual(['まとめ売り'])
  })

  it('お金の出入り：口座・債務・消し込み・月の明細', async () => {
    const m = await memberVia(driver)

    const bank = await m.run((c) => cash.createCashAccount(c, { name: '事業用の銀行', kind: 'bank', opening_balance: 0, opening_date: '2026-09-01' }))
    const flea = await m.run((c) => cash.createCashAccount(c, { name: 'フリマ', kind: 'flea', opening_balance: 20000, opening_date: '2026-09-15' }))
    const sale = await m.run(async (c) => (await c.sql.get<{ id: string }>(
      `insert into sale (title, sold_at, price) values ('9月の販売', '2026-09-15', 9000) returning id`,
    ))!.id)

    await m.run((c) => cash.createCashEntry(c, { account_id: bank, occurred_at: '2026-09-25', direction: 'in', amount: 44620, category: 'sale_payout' }))
    await m.run((c) => cash.createCashEntry(c, { account_id: bank, occurred_at: '2026-09-03', direction: 'in', amount: 200000, category: 'loan_in', note: '  借入 ' }))
    const purchase = await m.run((c) => cash.createLiability(c, { kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', due_at: '2026-10-15', amount: 161505 }))
    const loan = await m.run((c) => cash.createLiability(c, { kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 30000 }))
    const tool = await m.run((c) => cash.createLiability(c, { kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30', basis_sale_id: sale, basis_amount: 4737, basis_rate_bp: 3000 }))

    const entry = await m.run((c) => cash.createCashEntry(c, {
      account_id: bank, occurred_at: '2026-10-15', direction: 'out', amount: 191505, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 161505 }, { liability_id: loan, amount: 30000 }],
    }))
    await expect(m.run((c) => cash.createCashEntry(c, {
      account_id: bank, occurred_at: '2026-10-16', direction: 'out', amount: 100, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 1 }],
    }))).rejects.toThrow('残り')

    const entries = await m.run((c) => cash.listCashEntries(c))
    expect(entries.map(e => e.id)).toHaveLength(3)
    expect(entries[0]).toMatchObject({ id: entry, occurred_at: '2026-10-15', account_name: '事業用の銀行', settles: [
      { liability_id: purchase, amount: 161505 }, { liability_id: loan, amount: 30000 },
    ] })
    expect(entries.find(e => e.category === 'loan_in')!.note).toBe('借入')
    expect((await m.run((c) => cash.listCashEntries(c, '2026-10'))).map(e => e.id)).toEqual([entry])

    const accounts = await m.run((c) => cash.listCashAccounts(c))
    expect(accounts.map(a => [a.name, a.balance])).toEqual([['事業用の銀行', 200000 + 44620 - 191505], ['フリマ', 20000]])
    const liabilities = await m.run((c) => cash.listLiabilities(c))
    expect(liabilities.map(l => [l.id, l.settled, l.remaining])).toEqual([
      [purchase, 161505, 0], [loan, 30000, 0], [tool, 0, 1421],
    ])
    expect((await m.run((c) => cash.listLiabilities(c, { onlyOpen: true }))).map(l => l.id)).toEqual([tool])

    // 月の途中（9/15）から数え始める口座があるので、9 月の opening はその起点の残高を含む。
    // 9 月末には 10/15 の支払いはまだ無いので、債務は 3 本とも丸ごと残っている（期限のあるものが先、無いものは発生日順）
    const sep = await m.run((c) => cash.getCashMonth(c, '2026-09'))
    expect(sep).toMatchObject({ opening: 20000, incoming_total: 244620, outgoing_total: 0, closing: 264620 })
    expect(sep.upcoming.map(u => [u.liability_id, u.remaining])).toEqual([[purchase, 161505], [loan, 30000], [tool, 1421]])
    expect(sep.upcoming_total).toBe(161505 + 30000 + 1421)
    expect(sep.free_cash).toBe(sep.closing - sep.upcoming_total)
    const oct = await m.run((c) => cash.getCashMonth(c, '2026-10'))
    expect(oct).toMatchObject({ opening: 264620, outgoing_total: 191505, closing: 73115, upcoming: [{ liability_id: tool, remaining: 1421 }] })
    expect(oct.opening + oct.incoming_total - oct.outgoing_total).toBe(oct.closing)

    // 2 月の末日・うるう日（date の文字列の境界）
    await m.run((c) => cash.createCashEntry(c, { account_id: bank, occurred_at: '2028-02-29', direction: 'in', amount: 7, category: 'other' }))
    expect((await m.run((c) => cash.getCashMonth(c, '2028-02'))).incoming_total).toBe(7)

    await m.run((c) => cash.deleteCashEntry(c, entry))
    expect((await m.run((c) => cash.listLiabilities(c))).map(l => l.settled)).toEqual([0, 0, 0])
    await m.run((c) => cash.deleteLiability(c, purchase))
    await m.run((c) => cash.updateCashAccount(c, flea, { name: '改名', is_active: 0 }))
    expect((await m.run((c) => cash.listCashAccounts(c))).find(a => a.id === flea)).toMatchObject({ name: '改名', is_active: 0 })
  })

  it('変な引数の UserError と、DB の例外（uuid の形）の 400 が、どのドライバでも同じ', async () => {
    const m = await memberVia(driver)
    expect((await m.call('createTag', 123)).status).toBe(400)
    expect((await m.call('createCashEntry', null)).status).toBe(400)
    const shape = await m.run((c) => c.sql.get(`select 'not-a-uuid'::uuid`)).then(() => undefined, (e: unknown) => e)
    expect((shape as { code?: string }).code).toBe('22P02')
  })
})
