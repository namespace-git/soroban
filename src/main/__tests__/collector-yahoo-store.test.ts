import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import type {
  AgentListingsResult, AgentRunInput, AgentThumbTarget, AgentYahooSaleRow, AgentYahooSalesResult,
} from '../../shared/agent-types'
import type { CollectorRun } from '../../shared/types'

// collect()（Yahoo!フリマ）のフルフロー：DOM は実物の fixture、帳簿への書き込みは「呼ばれ方を記録する偽の store」。
// 収集のコードが store の段へ何をどの順で渡すか（行の形・画像の予算・実行記録）を確かめる。
// 段の中身（DB に作る行）は store-local.test.ts が確かめる。
const state = vi.hoisted(() => ({
  opts: {
    hasCaptchaFrame: false,
    bodyText: '',
    sellingHtml: '',
    soldHtml: '',
    salesHtml: '',
    fetchImpl: undefined as
      | ((url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>)
      | undefined,
  },
  createdWindows: [] as Array<{ isVisible: () => boolean; isDestroyed: () => boolean }>,
}))

vi.mock('electron', () => {
  class FakeBrowserWindow {
    private destroyedFlag = false
    private currentUrl = ''
    private visible: boolean
    title = ''
    webContents: {
      getURL: () => string
      executeJavaScript: (script: string) => Promise<unknown>
    }

    constructor(opts?: { show?: boolean }) {
      this.visible = opts?.show ?? false
      state.createdWindows.push(this)
      this.webContents = {
        getURL: () => this.currentUrl,
        executeJavaScript: async (script: string) => {
          const o = state.opts
          if (script.includes('recaptcha')) return o.hasCaptchaFrame
          if (script.includes('document.documentElement.outerHTML')) {
            if (this.currentUrl.includes('salesmanagement')) return o.salesHtml
            if (this.currentUrl.includes('/my/item/sold')) return o.soldHtml
            return o.sellingHtml
          }
          if (script.includes('document.body ? document.body.innerText')) return o.bodyText
          if (script.includes('document.body.innerText.length')) return true
          return null
        },
      }
    }

    loadURL(url: string): Promise<void> {
      this.currentUrl = url
      return Promise.resolve()
    }

    isDestroyed(): boolean { return this.destroyedFlag }
    destroy(): void { this.destroyedFlag = true }
    isVisible(): boolean { return this.visible }
    show(): void { this.visible = true }
    setTitle(title: string): void { this.title = title }
    on(): void {}
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => '' },
    session: {
      fromPartition: () => ({
        setUserAgent: () => {},
        fetch: (url: string) => (state.opts.fetchImpl
          ? state.opts.fetchImpl(url)
          : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
      }),
    },
  }
})

// 画像の保存が実ファイルへ書き込まないよう潰す。readFileSync（fixture 読み込み）は実体のまま残す
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, mkdirSync: vi.fn() }
})
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(async () => {}),
  readdir: vi.fn(async () => [] as string[]),
  unlink: vi.fn(async () => {}),
}))

// ページ間の待ち・画像の間の待ちを即時にし、テストを遅くしない
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

import { CHALLENGE_MESSAGE } from '../collector'
import {
  collect, combineYahooSales, parseYahooSalesHtml, parseYahooSellingHtml, parseYahooSoldHtml,
} from '../collector-yahoo'
import type { CollectorStore } from '../store/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sellingHtml = readFileSync(join(__dirname, 'fixtures', 'yahoo-selling.html'), 'utf-8')
const soldHtml = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
const salesHtml = readFileSync(join(__dirname, 'fixtures', 'yahoo-salesmanagement.html'), 'utf-8')

const soldRows = parseYahooSoldHtml(soldHtml)

/** 呼ばれ方を記録するだけの store（collect() が使う段だけ）。 */
function createFakeStore() {
  const calls: string[] = []
  const store = {
    recordRun: vi.fn(async (run: AgentRunInput): Promise<CollectorRun> => {
      calls.push('recordRun')
      return {
        id: 'run-1', started_at: run.started_at ?? '', finished_at: '2026-01-01T00:00:00.000Z', status: run.status,
        fetched: run.fetched, inserted: run.inserted, message: run.message ?? null, source: run.source,
        shop_account_id: run.shop_account_id ?? null, shop_account_name: null,
      }
    }),
    ingestYahooSales: vi.fn(async (_page: number, _rows: AgentYahooSaleRow[]) => {
      calls.push('ingestYahooSales')
      return {
        already: false as const, inserted: 2, updated: 1, excluded_by_keyword: 0, excluded_deleted: 0,
        truncated_title_ids: [] as string[], thumb_targets: [] as AgentThumbTarget[],
      } satisfies { already: false } & AgentYahooSalesResult
    }),
    ingestListingsPage: vi.fn(async (..._args: unknown[]) => {
      calls.push('ingestListingsPage')
      return {
        already: false as const, inserted: 3, updated: 4, released_listings: 0, released_items: 0,
        excluded_by_keyword: 0, thumb_targets: [] as AgentThumbTarget[],
      } satisfies { already: false } & AgentListingsResult
    }),
    saveThumb: vi.fn(async (..._args: unknown[]) => {
      calls.push('saveThumb')
      return { already: false as const }
    }),
  }
  return { store, calls, asStore: store as unknown as CollectorStore }
}

describe('collect()（Yahoo!フリマ）が store の段へ渡すもの', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.opts = {
      hasCaptchaFrame: false,
      // isChallengeText の「本文が短い」判定に掛からないよう十分長くしておく
      bodyText: 'Yahoo!フリマの本文です。'.repeat(200),
      sellingHtml,
      soldHtml,
      salesHtml,
      fetchImpl: undefined,
    }
    state.createdWindows = []
  })

  it('②と③を結合した売上を 1 回で渡し、続けて出品を渡し、実行記録は最後に 1 回だけ書く', async () => {
    const { store, calls, asStore } = createFakeStore()

    const run = await collect(true, asStore)

    // 売上：結合した 4 件。store の段が読む列だけの形（isBundle は渡さない）
    expect(store.ingestYahooSales).toHaveBeenCalledTimes(1)
    const [page, rows] = store.ingestYahooSales.mock.calls[0]
    expect(page).toBe(1)
    expect(rows.map(r => r.yahooItemId)).toEqual(['z100000010', 'z100000011', 'z100000012', 'z100000013'])
    expect(rows[0]).toEqual({
      yahooItemId: 'z100000010',
      title: 'メロジョイ ふわふわ肉球ミルクパフ ねっとりヨーグルト【Z074-4】',
      titleTruncated: false,
      price: 5200,
      fee: 0,
      shippingFee: null,
      bundleCount: null,
      soldAt: '2026-09-28',
      status: 'shipped',
      thumbUrl: soldRows[2].thumbUrl,
    })

    // 出品：7 件。公開停止中は観測しないので suspended は常に false
    expect(store.ingestListingsPage).toHaveBeenCalledTimes(1)
    const [channel, listingPage, listings] = store.ingestListingsPage.mock.calls[0] as
      [string, number, Array<Record<string, unknown>>]
    expect(channel).toBe('yahoo')
    expect(listingPage).toBe(1)
    expect(listings).toHaveLength(7)
    expect(listings.every(l => l.suspended === false)).toBe(true)
    expect(listings[0]).toMatchObject({
      mercariItemId: 'z100000001', price: 7500, likes: 0, listedAt: '2026-09-28T22:24',
    })

    // 順：売上 → 出品 → 実行記録（最後に 1 回）
    expect(calls).toEqual(['ingestYahooSales', 'ingestListingsPage', 'recordRun'])
    expect(store.recordRun).toHaveBeenCalledTimes(1)
    const record = store.recordRun.mock.calls[0][0]
    const observed = new Set([
      ...parseYahooSellingHtml(sellingHtml), ...soldRows, ...parseYahooSalesHtml(salesHtml),
    ].map(r => r.yahooItemId))
    expect(record).toMatchObject({ source: 'yahoo', status: 'ok', fetched: observed.size, inserted: 2 })
    expect(Number.isNaN(Date.parse(record.started_at as string))).toBe(false)
    expect(record.message).toContain('新規 2・更新 1')
    expect(record.message).toContain('出品 新規 3・更新 4')
    expect(run.status).toBe('ok')

    // 窓は閉じる
    expect(state.createdWindows).toHaveLength(1)
    expect(state.createdWindows[0].isDestroyed()).toBe(true)
  })

  it('結合の結果が 0 件なら売上の段は呼ばない（出品は渡す）', async () => {
    state.opts.salesHtml = '<html><body></body></html>'
    const { store, asStore } = createFakeStore()

    await collect(true, asStore)

    expect(combineYahooSales(soldRows, parseYahooSalesHtml(state.opts.salesHtml)).sales).toEqual([])
    expect(store.ingestYahooSales).not.toHaveBeenCalled()
    expect(store.ingestListingsPage).toHaveBeenCalledTimes(1)
    expect(store.recordRun).toHaveBeenCalledTimes(1)
  })

  it('画像は段が返した対象を保存する。予算は販売・出品を合わせて 30 枚（試みた数で減らす）', async () => {
    const { store, asStore } = createFakeStore()
    const saleTargets: AgentThumbTarget[] = Array.from({ length: 31 }, (_, i) => ({
      kind: 'sale' as const, channel_item_id: `z9${String(i).padStart(8, '0')}`, thumb_url: `https://img.example.com/${i}.jpg?1`,
    }))
    store.ingestYahooSales.mockResolvedValueOnce({
      already: false, inserted: 31, updated: 0, excluded_by_keyword: 0, excluded_deleted: 0,
      truncated_title_ids: [], thumb_targets: saleTargets,
    })
    store.ingestListingsPage.mockResolvedValueOnce({
      already: false, inserted: 0, updated: 0, released_listings: 0, released_items: 0, excluded_by_keyword: 0,
      thumb_targets: [{ kind: 'listing', channel_item_id: 'z100000001', thumb_url: 'https://img.example.com/l.jpg?1' }],
    })
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }))
    state.opts.fetchImpl = fetchMock

    await collect(true, asStore)

    // 販売側 30 件で予算を使い切る：31 件目も、出品も取りに行かない
    expect(fetchMock).toHaveBeenCalledTimes(30)
    expect(store.saveThumb).toHaveBeenCalledTimes(30)
    expect(store.saveThumb.mock.calls.every(c => (c[0] as { kind: string }).kind === 'sale')).toBe(true)
    expect(store.saveThumb.mock.calls[0][0]).toEqual({
      kind: 'sale',
      channel_item_id: 'z900000000',
      thumb_url: 'https://img.example.com/0.jpg?1',
      path: expect.stringMatching(/^z900000000-[0-9a-f]{8}\.jpg$/),
    })
  })

  it('取得に失敗した画像は再試行せず、記録もしない。収集は失敗にしない', async () => {
    const { store, asStore } = createFakeStore()
    store.ingestYahooSales.mockResolvedValueOnce({
      already: false, inserted: 1, updated: 0, excluded_by_keyword: 0, excluded_deleted: 0, truncated_title_ids: [],
      thumb_targets: [{ kind: 'sale', channel_item_id: 'z900000000', thumb_url: 'https://img.example.com/0.jpg?1' }],
    })
    const fetchMock = vi.fn(async (_url: string) => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }))
    state.opts.fetchImpl = fetchMock

    const run = await collect(true, asStore)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.saveThumb).not.toHaveBeenCalled()
    expect(run.status).toBe('ok')
  })

  it('段が例外を投げたら、実行記録は failed（メッセージつき）で 1 回だけ書き、窓も閉じる', async () => {
    const { store, asStore } = createFakeStore()
    store.ingestYahooSales.mockRejectedValueOnce(new Error('書き込みに失敗しました'))

    const run = await collect(true, asStore)

    expect(store.ingestListingsPage).not.toHaveBeenCalled()
    expect(store.recordRun).toHaveBeenCalledTimes(1)
    expect(store.recordRun.mock.calls[0][0]).toMatchObject({
      source: 'yahoo', status: 'failed', fetched: 0, inserted: 0, message: '書き込みに失敗しました',
    })
    expect(run.status).toBe('failed')
    expect(state.createdWindows[0].isDestroyed()).toBe(true)
  })

  it('CAPTCHA が出たら何も書かずに止め、auth_required を記録する。窓は人に渡すので残す', async () => {
    state.opts.hasCaptchaFrame = true
    const { store, asStore } = createFakeStore()

    const run = await collect(true, asStore)

    expect(store.ingestYahooSales).not.toHaveBeenCalled()
    expect(store.ingestListingsPage).not.toHaveBeenCalled()
    expect(store.recordRun).toHaveBeenCalledTimes(1)
    expect(store.recordRun.mock.calls[0][0]).toMatchObject({
      source: 'yahoo', status: 'auth_required', fetched: 0, inserted: 0, message: CHALLENGE_MESSAGE,
    })
    expect(run.status).toBe('auth_required')
    expect(state.createdWindows[0].isVisible()).toBe(true)
    expect(state.createdWindows[0].isDestroyed()).toBe(false)
  })
})
