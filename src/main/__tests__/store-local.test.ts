import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todayLocal } from '../../shared/date'
import type {
  AgentListingRow, AgentOrderInput, AgentSoldRow, AgentStage, AgentTradingRow, AgentYahooSaleRow,
} from '../../shared/agent-types'
import type { PurchaseDraftInput, PurchaseInput } from '../../shared/types'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import * as db from '../db'
import { createLocalStore } from '../store/local'
import { hashKeywords } from '../store/rules'
import type { CollectorStore } from '../store/types'

// ============================================================
// ローカルの store（store/local.ts）：:memory: の SQLite に、今の collector と同じ行を作る
// ============================================================

let store: CollectorStore

beforeEach(() => {
  db.initDb(':memory:')
  store = createLocalStore()
})

/** already: true でないことを確かめて、結果を取り出す（ローカルは冪等キーを持たないので常に false） */
function done<T>(r: AgentStage<T>): T {
  if (r.already) throw new Error('already: true が返りました')
  const { already: _already, ...rest } = r
  return rest as T
}

function all<T>(sql: string, ...args: unknown[]): T[] {
  return db.getDb().prepare(sql).all(...args) as T[]
}

function get<T>(sql: string, ...args: unknown[]): T {
  return db.getDb().prepare(sql).get(...args) as T
}

function count(table: string): number {
  return get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).c
}

interface SaleRow {
  id: string; mercari_item_id: string; channel: string; title: string; price: number; fee: number
  fee_source: string; status: string | null; sold_at: string; source: string; kind: string
  shipping_fee: number; thumb_file: string | null; thumb_src: string | null; raw: string
  model_codes: string; purchased_at: string | null; purchased_at_checked: number; expected_item_count: number | null
}

const saleOf = (itemId: string): SaleRow => get<SaleRow>('SELECT * FROM sale WHERE mercari_item_id = ?', itemId)

const sold = (id: string, title: string, over: Partial<AgentSoldRow> = {}): AgentSoldRow => ({
  mercariItemId: id, title, price: 3000, fee: 300, shippingFee: 200, otherCost: null, soldAt: '2026-10-01',
  thumbUrl: `https://img.example.com/${id}.jpg?1`, ...over,
})

const trading = (id: string, title: string, over: Partial<AgentTradingRow> = {}): AgentTradingRow => ({
  mercariItemId: id, title, price: 2500, status: 'waiting_shipment', thumbUrl: null, ...over,
})

const listing = (id: string, title: string, over: Partial<AgentListingRow> = {}): AgentListingRow => ({
  mercariItemId: id, title, price: 2000, suspended: false, thumbUrl: `https://img.example.com/${id}.jpg?1`,
  updatedText: '2日前に更新', likes: 3, ...over,
})

const yahoo = (id: string, title: string, over: Partial<AgentYahooSaleRow> = {}): AgentYahooSaleRow => ({
  yahooItemId: id, title, titleTruncated: false, price: 5000, fee: 250, shippingFee: null, bundleCount: null,
  soldAt: '2026-10-02', status: 'completed', thumbUrl: null, ...over,
})

describe('recordRun', () => {
  it('実行記録を 1 回で書き、始めた時刻は収集のコードが渡したものを残す', async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const run = await store.recordRun({
      source: 'mercari', started_at: startedAt, status: 'ok', fetched: 3, inserted: 2, message: '新規 2',
    })

    expect(run).toMatchObject({
      source: 'mercari', status: 'ok', fetched: 3, inserted: 2, message: '新規 2', started_at: startedAt,
      shop_account_id: null,
    })
    expect(run.finished_at).not.toBeNull()
    const saved = get<{ started_at: string; finished_at: string | null }>(
      'SELECT started_at, finished_at FROM collector_run WHERE id = ?', run.id,
    )
    expect(saved.started_at).toBe(startedAt)
    expect(saved.finished_at).toBe(run.finished_at)
  })

  it('0 件は empty のまま記録できる。メロジョイは仕入先を持つ。冪等キーは無いので同じ記録を 2 回送れば 2 行', async () => {
    const shopId = db.createShopAccount('メロジョイA', 'mellojoy')
    const first = await store.recordRun({
      source: 'mellojoy', shop_account_id: shopId, status: 'empty', fetched: 0, inserted: 0, message: '0件でした',
    })
    const second = await store.recordRun({
      source: 'mellojoy', shop_account_id: shopId, status: 'empty', fetched: 0, inserted: 0, message: '0件でした',
    })

    expect(first).toMatchObject({ status: 'empty', shop_account_id: shopId, shop_account_name: 'メロジョイA' })
    expect(second.id).not.toBe(first.id)
    expect(count('collector_run')).toBe(2)
  })

  it('始めた時刻が未来・読めない値なら無視する（startRun が刻んだ時刻のまま）', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const run = await store.recordRun({ source: 'yahoo', started_at: future, status: 'ok', fetched: 1, inserted: 1 })
    expect(run.started_at).not.toBe(future)

    const bad = await store.recordRun({ source: 'yahoo', started_at: 'いつか', status: 'ok', fetched: 1, inserted: 1 })
    expect(bad.started_at).not.toBe('いつか')
  })
})

describe('ingestSoldPage（メルカリの販売履歴 1 ページ）', () => {
  it('新規は completed の販売として入れ、画像の対象を返す。raw は今までの collector と同じ形', async () => {
    const res = done(await store.ingestSoldPage(1, [
      sold('m10000000001', '【A037】もこ山 スクイーズ'),
      sold('m10000000002', '【A038】ぷにぷに', { fee: null, shippingFee: null, thumbUrl: null }),
    ]))

    expect(res).toMatchObject({
      inserted: 2, updated: 0, excluded_by_keyword: 0, excluded_deleted: 0, excluded_known_by_keyword: 0,
    })
    // サムネイルの元 URL があるものだけが対象（種類は販売、キーは商品 ID）
    expect(res.thumb_targets).toEqual([
      { kind: 'sale', channel_item_id: 'm10000000001', thumb_url: 'https://img.example.com/m10000000001.jpg?1' },
    ])

    const a = saleOf('m10000000001')
    expect(a).toMatchObject({
      channel: 'mercari', title: '【A037】もこ山 スクイーズ', price: 3000, fee: 300, fee_source: 'actual',
      status: 'completed', sold_at: '2026-10-01', source: 'collector', shipping_fee: 200, thumb_file: null,
    })
    // raw に残る列と並び（thumbUrl は入らない）
    expect(Object.keys(JSON.parse(a.raw))).toEqual([
      'mercariItemId', 'title', 'price', 'soldAt', 'fee', 'shippingFee', 'otherCost', 'status',
    ])
    // 手数料・送料が取れていない行は率で見込む（fee_source = rate）
    expect(saleOf('m10000000002')).toMatchObject({ fee_source: 'rate', status: 'completed' })
  })

  it('同じ段をもう一度呼んでも二重には入らない（既知は実額の更新だけ。変化が無ければ 0 件）', async () => {
    const rows = [sold('m10000000001', '【A037】もこ山'), sold('m10000000002', '【A038】ぷにぷに')]
    await store.ingestSoldPage(1, rows)
    const again = done(await store.ingestSoldPage(1, rows))

    expect(again).toMatchObject({ inserted: 0, updated: 0 })
    expect(count('sale')).toBe(2)
    // まだ画像を保存していないので、対象には残る
    expect(again.thumb_targets).toHaveLength(2)
  })

  it('既知の販売の実額・購入完了日が変わっていれば更新する', async () => {
    await store.ingestSoldPage(1, [sold('m10000000001', '【A037】もこ山', { fee: null, shippingFee: null })])
    const res = done(await store.ingestSoldPage(1, [
      sold('m10000000001', '【A037】もこ山', { fee: 310, shippingFee: 210, soldAt: '2026-10-03' }),
    ]))

    expect(res).toMatchObject({ inserted: 0, updated: 1 })
    expect(saleOf('m10000000001')).toMatchObject({ fee: 310, fee_source: 'actual', shipping_fee: 210, sold_at: '2026-10-03' })
  })

  it('キーワードが設定されていれば、不一致の新規は入れない。除外数を返す', async () => {
    db.setSetting('mercari_keyword', 'メロジョイ')
    const res = done(await store.ingestSoldPage(1, [
      sold('m10000000001', 'メロジョイ ふわふわ'),
      sold('m10000000002', '無関係な商品'),
    ]))

    expect(res).toMatchObject({ inserted: 1, excluded_by_keyword: 1 })
    expect(count('sale')).toBe(1)
    // 不一致の商品には画像も取りに行かない
    expect(res.thumb_targets.map(t => t.channel_item_id)).toEqual(['m10000000001'])
  })

  it('キーワードを変えた後、既に取り込んだ不一致の販売はサムネ対象から外す（更新は止めない）', async () => {
    await store.ingestSoldPage(1, [sold('m10000000001', 'メロジョイ ふわふわ'), sold('m10000000002', '無関係な商品')])
    db.setSetting('mercari_keyword', 'メロジョイ')
    const res = done(await store.ingestSoldPage(1, [
      sold('m10000000001', 'メロジョイ ふわふわ', { fee: 320 }),
      sold('m10000000002', '無関係な商品', { fee: 330 }),
    ]))

    expect(res).toMatchObject({ inserted: 0, updated: 2, excluded_known_by_keyword: 1 })
    expect(res.thumb_targets.map(t => t.channel_item_id)).toEqual(['m10000000001'])
  })

  it('削除した販売（sale_exclusion）は再取り込みしない', async () => {
    await store.ingestSoldPage(1, [sold('m10000000001', '【A037】もこ山')])
    db.deleteSale(saleOf('m10000000001').id)
    expect(count('sale')).toBe(0)

    const res = done(await store.ingestSoldPage(1, [
      sold('m10000000001', '【A037】もこ山'), sold('m10000000002', '【A038】ぷにぷに'),
    ]))
    expect(res).toMatchObject({ inserted: 1, excluded_deleted: 1 })
    expect(count('sale')).toBe(1)
    expect(saleOf('m10000000002').mercari_item_id).toBe('m10000000002')
  })
})

describe('saveThumb（画像は変わったときだけ取り直す）', () => {
  it('保存したら thumb_file と元 URL（thumb_src）を残し、同じ URL なら対象に出ない。URL が変われば対象に戻る', async () => {
    const rows = [sold('m10000000001', '【A037】もこ山'), sold('m10000000002', '【A038】ぷにぷに')]
    const first = done(await store.ingestSoldPage(1, rows))
    expect(first.thumb_targets).toHaveLength(2)

    const t = first.thumb_targets[0]
    done(await store.saveThumb({ kind: t.kind, channel_item_id: t.channel_item_id, thumb_url: t.thumb_url, path: 'm10000000001-aaaa1111.jpg' }))
    expect(saleOf('m10000000001')).toMatchObject({
      thumb_file: 'm10000000001-aaaa1111.jpg', thumb_src: 'https://img.example.com/m10000000001.jpg?1',
    })

    // 同じ URL：保存済みの 1 件は対象に出ない
    const same = done(await store.ingestSoldPage(1, rows))
    expect(same.thumb_targets.map(x => x.channel_item_id)).toEqual(['m10000000002'])

    // クエリ（画像の更新時刻）が変わった：差し替えの対象に戻る
    const changed = done(await store.ingestSoldPage(1, [
      sold('m10000000001', '【A037】もこ山', { thumbUrl: 'https://img.example.com/m10000000001.jpg?2' }),
    ]))
    expect(changed.thumb_targets).toEqual([
      { kind: 'sale', channel_item_id: 'm10000000001', thumb_url: 'https://img.example.com/m10000000001.jpg?2' },
    ])
  })

  it('段の結果を経ていなくても、商品 ID から販売を引いて書ける。販売が無ければ断る', async () => {
    await store.ingestSoldPage(1, [sold('m10000000001', '【A037】もこ山')])

    // 別の store（画像の対象を覚えていない）から
    const other = createLocalStore()
    done(await other.saveThumb({
      kind: 'sale', channel_item_id: 'm10000000001', thumb_url: 'https://img.example.com/x.jpg?9', path: 'x.jpg',
    }))
    expect(saleOf('m10000000001')).toMatchObject({ thumb_file: 'x.jpg', thumb_src: 'https://img.example.com/x.jpg?9' })

    await expect(other.saveThumb({
      kind: 'sale', channel_item_id: 'm99999999999', thumb_url: 'https://img.example.com/y.jpg', path: 'y.jpg',
    })).rejects.toThrow('販売が見つかりません')
  })

  it('出品の画像：listing に書き、同じ商品 ID の販売にも同じ画像を書く（売れる前後で共有）', async () => {
    done(await store.ingestListingsPage('mercari', 1, [listing('m20000000001', '【A037】もこ山')]))
    await store.ingestSoldPage(1, [sold('m20000000001', '【A037】もこ山', { thumbUrl: null })])

    done(await store.saveThumb({
      kind: 'listing', channel_item_id: 'm20000000001', thumb_url: 'https://img.example.com/m20000000001.jpg?1',
      path: 'm20000000001-bbbb2222.jpg',
    }))

    expect(get<{ thumb_file: string; thumb_src: string }>(
      'SELECT thumb_file, thumb_src FROM listing WHERE mercari_item_id = ?', 'm20000000001',
    )).toEqual({ thumb_file: 'm20000000001-bbbb2222.jpg', thumb_src: 'https://img.example.com/m20000000001.jpg?1' })
    expect(saleOf('m20000000001').thumb_file).toBe('m20000000001-bbbb2222.jpg')
  })
})

describe('ingestTrading（取引中のスナップショット）', () => {
  it('未知は計上日を今日にして入れ、状態の文言が読めなかった行は数えて返す', async () => {
    const res = done(await store.ingestTrading([
      trading('m30000000001', '【A037】もこ山', { status: 'waiting_shipment', thumbUrl: 'https://img.example.com/t1.jpg?1' }),
      trading('m30000000002', '【A038】ぷにぷに', { status: null }),
    ]))

    expect(res).toMatchObject({
      inserted: 2, updated: 0, unknown_status: 1, excluded_by_keyword: 0, excluded_deleted: 0,
    })
    expect(res.thumb_targets).toEqual([
      { kind: 'sale', channel_item_id: 'm30000000001', thumb_url: 'https://img.example.com/t1.jpg?1' },
    ])
    expect(saleOf('m30000000001')).toMatchObject({ status: 'waiting_shipment', sold_at: todayLocal(), source: 'collector' })
    expect(saleOf('m30000000002').status).toBeNull()
  })

  it('既知は状態だけ前に進める。後戻り・同じ状態は無視する', async () => {
    await store.ingestTrading([trading('m30000000001', '【A037】もこ山', { status: 'waiting_shipment' })])

    const forward = done(await store.ingestTrading([trading('m30000000001', '【A037】もこ山', { status: 'shipped' })]))
    expect(forward).toMatchObject({ inserted: 0, updated: 1 })
    expect(saleOf('m30000000001').status).toBe('shipped')

    const back = done(await store.ingestTrading([trading('m30000000001', '【A037】もこ山', { status: 'waiting_shipment' })]))
    expect(back).toMatchObject({ inserted: 0, updated: 0 })
    expect(saleOf('m30000000001').status).toBe('shipped')
  })

  it('キーワード不一致は入れない。削除した販売は取引中タブからも再取り込みしない', async () => {
    db.setSetting('mercari_keyword', 'メロジョイ')
    const first = done(await store.ingestTrading([
      trading('m30000000001', 'メロジョイ ふわふわ'), trading('m30000000002', '無関係な商品'),
    ]))
    expect(first).toMatchObject({ inserted: 1, excluded_by_keyword: 1 })

    db.deleteSale(saleOf('m30000000001').id)
    const second = done(await store.ingestTrading([trading('m30000000001', 'メロジョイ ふわふわ')]))
    expect(second).toMatchObject({ inserted: 0, excluded_deleted: 1 })
    expect(count('sale')).toBe(0)
  })
})

describe('ingestListingsPage（出品の 1 ページ）', () => {
  it('メルカリ：出品停止中は suspended で入れる。画像の対象は出品（キーは商品 ID）', async () => {
    const res = done(await store.ingestListingsPage('mercari', 1, [
      listing('m40000000001', '【A037】もこ山'),
      listing('m40000000002', '【A038】ぷにぷに', { suspended: true, thumbUrl: null }),
    ]))

    expect(res).toMatchObject({ inserted: 2, updated: 0, released_listings: 0, released_items: 0, excluded_by_keyword: 0 })
    expect(res.thumb_targets).toEqual([
      { kind: 'listing', channel_item_id: 'm40000000001', thumb_url: 'https://img.example.com/m40000000001.jpg?1' },
    ])
    expect(all<{ mercari_item_id: string; channel: string; status: string }>(
      'SELECT mercari_item_id, channel, status FROM listing ORDER BY mercari_item_id',
    )).toEqual([
      { mercari_item_id: 'm40000000001', channel: 'mercari', status: 'active' },
      { mercari_item_id: 'm40000000002', channel: 'mercari', status: 'suspended' },
    ])

    // もう一度：新規は無く、更新になる
    const again = done(await store.ingestListingsPage('mercari', 1, [listing('m40000000001', '【A037】もこ山')]))
    expect(again).toMatchObject({ inserted: 0, updated: 1 })
    expect(count('listing')).toBe(2)
  })

  it('Yahoo!フリマ：公開停止中は観測しないので常に出品中。出品日時は新規行に使う。キーワードは yahoo_keyword', async () => {
    db.setSetting('yahoo_keyword', 'メロジョイ')
    const res = done(await store.ingestListingsPage('yahoo', 1, [
      listing('z400000001', 'メロジョイ ふわふわ', { suspended: true, listedAt: '2026-09-28T22:24', updatedText: null }),
      listing('z400000002', '無関係な商品', { updatedText: null }),
    ]))

    expect(res).toMatchObject({ inserted: 1, excluded_by_keyword: 1 })
    expect(get<{ channel: string; status: string; listed_at: string }>(
      'SELECT channel, status, listed_at FROM listing WHERE mercari_item_id = ?', 'z400000001',
    )).toEqual({ channel: 'yahoo', status: 'active', listed_at: '2026-09-28T22:24' })
    expect(count('listing')).toBe(1)
  })

  it('メルカリのキーワード（mercari_keyword）は Yahoo!フリマの出品に効かない', async () => {
    db.setSetting('mercari_keyword', 'メロジョイ')
    const res = done(await store.ingestListingsPage('yahoo', 1, [listing('z400000003', '無関係な商品')]))
    expect(res).toMatchObject({ inserted: 1, excluded_by_keyword: 0 })
  })
})

describe('ingestYahooSales（Yahoo!フリマの売上）', () => {
  it('新規を yahoo の販売として入れる。キーワード不一致は入れず、タイトルが切れた行は判定せずに入れて id を返す', async () => {
    db.setSetting('yahoo_keyword', 'メロジョイ')
    const res = done(await store.ingestYahooSales(1, [
      yahoo('z700000001', 'メロジョイ 贅沢スフレ【Z072】', { thumbUrl: 'https://img.example.com/z1.jpg?1' }),
      yahoo('z700000002', '全く関係ない商品'),
      yahoo('z700000003', '切れたタイトル…新品未開封【Z0', { titleTruncated: true, status: null }),
    ]))

    expect(res).toMatchObject({
      inserted: 2, updated: 0, excluded_by_keyword: 1, excluded_deleted: 0, truncated_title_ids: ['z700000003'],
    })
    expect(res.thumb_targets).toEqual([
      { kind: 'sale', channel_item_id: 'z700000001', thumb_url: 'https://img.example.com/z1.jpg?1' },
    ])
    expect(saleOf('z700000001')).toMatchObject({
      channel: 'yahoo', fee: 250, fee_source: 'actual', status: 'completed', sold_at: '2026-10-02', source: 'collector',
    })
    expect(Object.keys(JSON.parse(saleOf('z700000001').raw))).toEqual([
      'mercariItemId', 'title', 'price', 'soldAt', 'fee', 'shippingFee', 'bundleCount', 'status',
    ])
    expect(saleOf('z700000003').status).toBeNull()
    expect(count('sale')).toBe(2)
  })

  it('既知はキーワードに関わらず更新へ渡る。まとめ買いの点数は expected_item_count に刻む', async () => {
    await store.ingestYahooSales(1, [yahoo('z700000001', 'メロジョイ 贅沢スフレ【Z072】'), yahoo('z700000002', '全く関係ない商品')])
    db.setSetting('yahoo_keyword', 'メロジョイ')

    const res = done(await store.ingestYahooSales(1, [
      yahoo('z700000001', 'メロジョイ 贅沢スフレ【Z072】', { price: 5200 }),
      yahoo('z700000002', '全く関係ない商品', { bundleCount: 3 }),
    ]))

    expect(res).toMatchObject({ inserted: 0, updated: 2, excluded_by_keyword: 0 })
    expect(saleOf('z700000002').expected_item_count).toBe(3)
  })

  it('削除した販売は再取り込みしない（新規側だけ）', async () => {
    await store.ingestYahooSales(1, [yahoo('z700000001', 'メロジョイ 贅沢スフレ【Z072】')])
    db.deleteSale(saleOf('z700000001').id)

    const res = done(await store.ingestYahooSales(1, [yahoo('z700000001', 'メロジョイ 贅沢スフレ【Z072】')]))
    expect(res).toMatchObject({ inserted: 0, excluded_deleted: 1 })
    expect(count('sale')).toBe(0)
  })
})

describe('型番の救済と購入日時', () => {
  it('listSalesNeedingDetail：未紐付けで型番の無い転売だけ。今のキーワードに合わない販売は除いて数を返す', async () => {
    db.setSetting('mercari_keyword', 'メロジョイ')
    await store.ingestSoldPage(1, [sold('m50000000001', 'メロジョイ ふわふわ'), sold('m50000000002', 'メロジョイ ぷにぷに')])

    const before = await store.listSalesNeedingDetail(10)
    expect(before.excluded_by_keyword).toBe(0)
    expect(before.targets.map(t => t.mercari_item_id).sort()).toEqual(['m50000000001', 'm50000000002'])
    expect(before.targets.find(t => t.mercari_item_id === 'm50000000001')?.id).toBe(saleOf('m50000000001').id)

    // 件数の上限
    expect((await store.listSalesNeedingDetail(1)).targets).toHaveLength(1)

    // キーワードを変えた後は、合わない販売の詳細を開かない
    db.setSetting('mercari_keyword', 'ぷにぷに')
    const after = await store.listSalesNeedingDetail(10)
    expect(after.targets.map(t => t.mercari_item_id)).toEqual(['m50000000002'])
    expect(after.excluded_by_keyword).toBe(1)
  })

  it('applySaleDescription：説明文から型番を拾って追記する。拾えなければ何も書かない。同じ型番は二重に足さない', async () => {
    db.setSetting('mercari_keyword', 'メロジョイ')
    await store.ingestSoldPage(1, [sold('m50000000001', 'メロジョイ ふわふわ')])
    const saleId = saleOf('m50000000001').id

    expect(done(await store.applySaleDescription(saleId, '型番はありません'))).toEqual({ codes_found: 0, applied: false })
    expect(JSON.parse(saleOf('m50000000001').model_codes)).toEqual([])

    expect(done(await store.applySaleDescription(saleId, '商品の説明 【A037】 です'))).toEqual({ codes_found: 1, applied: true })
    expect(JSON.parse(saleOf('m50000000001').model_codes)).toEqual(['A037'])

    expect(done(await store.applySaleDescription(saleId, '商品の説明 【A037】 です'))).toEqual({ codes_found: 1, applied: false })
    expect(JSON.parse(saleOf('m50000000001').model_codes)).toEqual(['A037'])
  })

  it('購入日時：まだ取れていない販売を返し、保存すると（null でも試行済みとして）対象から外れる', async () => {
    await store.ingestSoldPage(1, [sold('m50000000001', '【A037】もこ山'), sold('m50000000002', '【A038】ぷにぷに')])
    expect((await store.listSalesNeedingPurchasedAt(5)).map(s => s.mercari_item_id).sort())
      .toEqual(['m50000000001', 'm50000000002'])
    expect(await store.listSalesNeedingPurchasedAt(1)).toHaveLength(1)

    done(await store.setSalePurchasedAt(saleOf('m50000000001').id, '2026-09-30T09:30'))
    done(await store.setSalePurchasedAt(saleOf('m50000000002').id, null))

    expect(saleOf('m50000000001')).toMatchObject({ purchased_at: '2026-09-30T09:30', purchased_at_checked: 1 })
    expect(saleOf('m50000000002')).toMatchObject({ purchased_at: null, purchased_at_checked: 1 })
    expect(await store.listSalesNeedingPurchasedAt(5)).toEqual([])
  })
})

// ------------------------------------------------------------
// メロジョイ（仕入）
// ------------------------------------------------------------

function confirmedOrder(
  shopId: string, orderNo: string, over: Partial<PurchaseInput> = {}, order: Partial<AgentOrderInput> = {},
): AgentOrderInput {
  const input: PurchaseInput = {
    shop_account_id: shopId,
    ordered_at: todayLocal(),
    order_no: orderNo,
    shipping_fee: 499,
    discount: 0,
    alloc_method: 'by_amount',
    note: '注文履歴から自動取得',
    import_key: `mellojoy:${orderNo}`,
    fulfillment: 'pending',
    lines: [
      { name: 'メロジョイ ふわふわ【Z078-2】', unit_price: 2499, quantity: 1, image_url: 'https://cdn.example.com/a_400x400.jpg' },
      { name: 'ぷにぷに【Z074-4】', unit_price: 2399, quantity: 1 },
    ],
    ...over,
  }
  return { order_no: orderNo, purchase: { kind: 'confirmed', input }, fulfillment: null, image_urls: [], ...order }
}

function draftOrder(shopId: string, orderNo: string, order: Partial<AgentOrderInput> = {}): AgentOrderInput {
  const input: PurchaseDraftInput = {
    import_key: `mellojoy:${orderNo}`,
    shop_account_id: shopId,
    ordered_at: todayLocal(),
    order_no: orderNo,
    fulfillment: null,
    lines: [{ name: 'テスト商品 【A001-2】青', quantity: 1 }],
    note: '注文履歴から自動取得（下書き）：小計が読めません',
  }
  return {
    order_no: orderNo, purchase: { kind: 'draft', input }, fulfillment: null,
    image_urls: [{ name: 'テスト商品 【A001-2】青', image_url: 'https://cdn.example.com/b_400x400.jpg' }],
    ...order,
  }
}

interface PurchaseRow {
  id: string; status: string; import_key: string; shipping_fee: number; note: string | null
  fulfillment: string | null; shipped_at: string | null; delivered_at: string | null
  tracking_carrier: string | null; tracking_number: string | null; image_checked_at: string | null
}

const purchaseOf = (id: string): PurchaseRow => get<PurchaseRow>('SELECT * FROM purchase WHERE id = ?', id)

describe('ingestOrder（仕入の 1 注文）', () => {
  let shopId: string
  beforeEach(() => { shopId = db.createShopAccount('メロジョイA', 'mellojoy') })

  it('確定：仕入と在庫を作る（按分は端数を最終行に寄せて合計が一致）。詳細を読んだ印と画像の対象も返す', async () => {
    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001')))

    expect(res.outcome).toBe('confirmed')
    expect(res.fulfillment_updated).toBe(false)
    const p = purchaseOf(res.purchase_id as string)
    expect(p).toMatchObject({ status: 'confirmed', import_key: 'mellojoy:#500001', fulfillment: 'pending' })
    // 取り込みでこの注文の詳細は読み終えている（あとで画像巡回に拾わせない）
    expect(p.image_checked_at).not.toBeNull()

    // 単価 2499・2399、送料 499 の金額按分（254 + 245）。合計は小計 + 送料に一致する
    const costs = all<{ model_code: string; landed_cost: number }>(
      'SELECT model_code, landed_cost FROM inventory_item ORDER BY model_code',
    )
    expect(costs).toEqual([
      { model_code: 'Z074-4', landed_cost: 2399 + 245 },
      { model_code: 'Z078-2', landed_cost: 2499 + 254 },
    ])
    expect(costs.reduce((s, c) => s + c.landed_cost, 0)).toBe(2499 + 2399 + 499)

    // 画像の元 URL があって、まだ保存していない明細だけが対象
    expect(res.image_targets).toHaveLength(1)
    expect(res.image_targets[0].image_url).toBe('https://cdn.example.com/a_400x400.jpg')
  })

  it('確定 + 配送：詳細の配送の状態・日付・追跡番号を反映し、変わったことを返す', async () => {
    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001', {}, {
      fulfillment: {
        status: 'shipped', shipped_at: '2026-10-03', delivered_at: null, carrier: 'SF Express', tracking_number: 'SF6047878426775',
      },
    })))

    expect(res.fulfillment_updated).toBe(true)
    expect(purchaseOf(res.purchase_id as string)).toMatchObject({
      fulfillment: 'shipped', shipped_at: '2026-10-03', tracking_carrier: 'SF Express', tracking_number: 'SF6047878426775',
    })
  })

  it('同じ確定の注文をもう一度渡すと、今までと同じに断る（二重には入らない）', async () => {
    await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001'))
    await expect(store.ingestOrder(shopId, confirmedOrder(shopId, '#500001')))
      .rejects.toThrow('同じ注文が既に取り込まれています')
    expect(count('purchase')).toBe(1)
    expect(count('inventory_item')).toBe(2)
  })

  it('キーワード：一致する明細が無ければ取り込まず除外を記録する。キーワードを変えれば除外は効かなくなる', async () => {
    db.getDb().prepare('UPDATE shop_account SET import_keywords = ? WHERE id = ?').run('ほげほげ', shopId)

    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500002')))
    expect(res).toMatchObject({ outcome: 'excluded', purchase_id: null, image_targets: [] })
    expect(count('purchase')).toBe(0)
    expect(get<{ keywords_hash: string }>(
      'SELECT keywords_hash FROM mellojoy_excluded_order WHERE shop_account_id = ? AND order_key = ?', shopId, '#500002',
    ).keywords_hash).toBe(hashKeywords(['ほげほげ']))

    expect(await store.excludedOrders(shopId, ['#500002', '#500003'])).toEqual(['#500002'])

    db.getDb().prepare('UPDATE shop_account SET import_keywords = ? WHERE id = ?').run('ふわふわ', shopId)
    expect(await store.excludedOrders(shopId, ['#500002'])).toEqual([])
  })

  it('キーワード：一部だけ一致なら一致した明細だけ。送料は金額比で按分する', async () => {
    db.getDb().prepare('UPDATE shop_account SET import_keywords = ? WHERE id = ?').run('メロジョイ', shopId)

    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500004')))
    expect(res.outcome).toBe('confirmed')

    const shipping = Math.round(499 * (2499 / (2499 + 2399)))
    const p = purchaseOf(res.purchase_id as string)
    expect(p.shipping_fee).toBe(shipping)
    expect(p.note).toContain('キーワード不一致の明細 1 件を除外')
    expect(all<{ landed_cost: number }>('SELECT landed_cost FROM inventory_item')).toEqual([
      { landed_cost: 2499 + shipping },
    ])
  })

  it('キャンセル：除外を記録するだけで仕入は作らない', async () => {
    const res = done(await store.ingestOrder(shopId, {
      order_no: '#500005', purchase: { kind: 'cancelled' }, fulfillment: null, image_urls: [],
    }))

    expect(res).toMatchObject({ outcome: 'cancelled', purchase_id: null })
    expect(count('purchase')).toBe(0)
    expect(await store.excludedOrders(shopId, ['#500005'])).toEqual(['#500005'])
  })

  it('下書き：仕入を draft で積み、画像の URL を明細に書く。同じ注文をもう一度渡すと existing（何もしない）', async () => {
    const res = done(await store.ingestOrder(shopId, draftOrder(shopId, '#500006')))
    expect(res.outcome).toBe('draft')

    const p = purchaseOf(res.purchase_id as string)
    expect(p).toMatchObject({ status: 'draft', import_key: 'mellojoy:#500006' })
    expect(p.image_checked_at).not.toBeNull()
    expect(res.image_targets).toHaveLength(1)
    expect(res.image_targets[0].image_url).toBe('https://cdn.example.com/b_400x400.jpg')
    // 下書きは在庫を作らない
    expect(count('inventory_item')).toBe(0)

    const again = done(await store.ingestOrder(shopId, draftOrder(shopId, '#500006')))
    expect(again).toMatchObject({ outcome: 'existing', purchase_id: null })
    expect(count('purchase')).toBe(1)
  })

  it('existingImportKeys：既に取り込んだ注文のキーだけを返す', async () => {
    await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001'))
    expect(await store.existingImportKeys(['mellojoy:#500001', 'mellojoy:#999999'])).toEqual(['mellojoy:#500001'])
    expect(await store.existingImportKeys([])).toEqual([])
  })
})

describe('一覧の到着状態・巡回・画像（メロジョイ）', () => {
  let shopId: string
  beforeEach(() => { shopId = db.createShopAccount('メロジョイA', 'mellojoy') })

  it('updateOrderFulfillments：前に進む方向だけ更新する（人が進めた状態を一覧で戻さない）', async () => {
    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001')))
    const id = res.purchase_id as string

    const forward = done(await store.updateOrderFulfillments(shopId, [
      { import_key: 'mellojoy:#500001', fulfillment: 'shipped' },
      { import_key: 'mellojoy:#999999', fulfillment: 'shipped' },
    ]))
    expect(forward.updated).toBe(1)
    expect(purchaseOf(id).fulfillment).toBe('shipped')

    const back = done(await store.updateOrderFulfillments(shopId, [{ import_key: 'mellojoy:#500001', fulfillment: 'pending' }]))
    expect(back.updated).toBe(0)
    expect(purchaseOf(id).fulfillment).toBe('shipped')
  })

  it('revisitOrder：読めたら画像 URL・読んだ印・配送を反映して画像の対象を返し、巡回の位置を進める', async () => {
    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001', {
      lines: [{ name: 'メロジョイ ふわふわ【Z078-2】', unit_price: 2499, quantity: 1 }],
    })))
    const id = res.purchase_id as string
    expect(res.image_targets).toEqual([])

    const revisit = done(await store.revisitOrder(shopId, id, {
      image_urls: [
        { name: 'メロジョイ ふわふわ【Z078-2】', image_url: 'https://cdn.example.com/x_400x400.jpg' },
        { name: '帳簿に無い名前', image_url: 'https://cdn.example.com/y_400x400.jpg' },
      ],
      fulfillment: { status: 'shipped', shipped_at: '2026-10-03', delivered_at: null, carrier: 'SF', tracking_number: 'SF9' },
    }))

    expect(revisit.fulfillment_updated).toBe(true)
    // 名前が完全一致した明細だけに URL が入る
    expect(revisit.image_targets).toHaveLength(1)
    expect(revisit.image_targets[0].image_url).toBe('https://cdn.example.com/x_400x400.jpg')
    expect(purchaseOf(id)).toMatchObject({ fulfillment: 'shipped', tracking_number: 'SF9' })
    expect(db.getSettings()[`mellojoy_image_cursor:${shopId}`]).toBe(id)
  })

  it('revisitOrder(null)：読めなかったときは巡回の位置だけ進める（読んだ印は付けない）', async () => {
    const res = done(await store.ingestOrder(shopId, draftOrder(shopId, '#500006', { image_urls: [] })))
    const id = res.purchase_id as string
    db.getDb().prepare('UPDATE purchase SET image_checked_at = NULL WHERE id = ?').run(id)

    const revisit = done(await store.revisitOrder(shopId, id, null))
    expect(revisit).toMatchObject({ fulfillment_updated: false, image_targets: [] })
    expect(purchaseOf(id).image_checked_at).toBeNull()
    expect(db.getSettings()[`mellojoy_image_cursor:${shopId}`]).toBe(id)
  })

  it('purchaseRevisitCandidates：到着が分からず追跡番号の無い注文が候補。前回の続き（巡回の位置の次）から並べ直す', async () => {
    const keys: string[] = []
    for (const no of ['#500001', '#500002', '#500003']) {
      await store.ingestOrder(shopId, confirmedOrder(shopId, no))
      keys.push(`mellojoy:${no}`)
    }

    const base = await store.purchaseRevisitCandidates(shopId, keys)
    expect(base).toHaveLength(3)
    expect(base.map(c => c.import_key).sort()).toEqual([...keys].sort())

    // 位置 = 先頭の注文：次回はその次から始まり、先頭は最後に回る
    await store.revisitOrder(shopId, base[0].id, null)
    const rotated = await store.purchaseRevisitCandidates(shopId, keys)
    expect(rotated.map(c => c.id)).toEqual([base[1].id, base[2].id, base[0].id])

    await store.revisitOrder(shopId, base[2].id, null)
    const rotated2 = await store.purchaseRevisitCandidates(shopId, keys)
    expect(rotated2.map(c => c.id)).toEqual([base[0].id, base[1].id, base[2].id])

    expect(await store.purchaseRevisitCandidates(shopId, [])).toEqual([])
  })

  it('saveLineImage：保存したファイル名を明細に書くと、画像の対象から外れる', async () => {
    const res = done(await store.ingestOrder(shopId, confirmedOrder(shopId, '#500001')))
    expect(res.image_targets).toHaveLength(1)

    done(await store.saveLineImage(res.image_targets[0].id, 'purchase-line-1-abcd1234.jpg'))
    expect(get<{ image_file: string }>('SELECT image_file FROM purchase_line WHERE id = ?', res.image_targets[0].id).image_file)
      .toBe('purchase-line-1-abcd1234.jpg')
    expect(db.purchaseLinesNeedingImage(res.purchase_id as string)).toEqual([])
  })
})

describe('getCollectPlan', () => {
  it('有効なメロジョイのアカウントだけ（メルカリ・Yahoo!フリマは常に対象なので含めない）', async () => {
    const active = db.createShopAccount('有効なメロジョイ', 'mellojoy')
    const other = db.createShopAccount('その他', 'other')
    const inactive = db.createShopAccount('止めたメロジョイ', 'mellojoy')
    db.getDb().prepare('UPDATE shop_account SET is_active = 0 WHERE id = ?').run(inactive)

    const plan = await store.getCollectPlan()
    expect(plan.shop_accounts).toContainEqual({ id: active, name: '有効なメロジョイ' })
    expect(plan.shop_accounts.map(a => a.id)).not.toContain(other)
    expect(plan.shop_accounts.map(a => a.id)).not.toContain(inactive)
  })
})
