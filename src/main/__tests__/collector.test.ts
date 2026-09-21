import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// collect() のフルフローをテストするための、実行のたびに差し替え可能な状態。
// FakeBrowserWindow.webContents.executeJavaScript がスクリプトの文字列で
// どの呼び出しかを判別し、ここに積んだ値を返す（実DOMの代わり）。
const state = vi.hoisted(() => ({
  opts: {
    loggedIn: true,
    hasCaptchaFrame: false,
    bodyText: '',
    scrapeResult: { sales: [] as unknown[], totalCount: null as number | null },
    listingsHtml: '',
    inProgressHtml: '',
    detailDescription: null as string | null,
    fetchImpl: undefined as
      | ((url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>)
      | undefined,
  },
  // collect() が内部で作るウィンドウは戻り値に出てこないので、生成されたインスタンスを
  // ここに積んで、show/isVisible/destroy の呼ばれ方をテストから見えるようにする
  createdWindows: [] as Array<{ isVisible: () => boolean; isDestroyed: () => boolean; title: string }>,
}))

// collector.ts は electron（BrowserWindow・session）に依存する。
// 純粋関数だけを見るテストのために import を通す最小限のモックに加え、
// collect() 自体をテストするための簡易 DOM（executeJavaScript をスクリプト文字列で分岐）を用意する
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
          // scrape() のスクリプトは合計件数抽出のために内部でも
          // `document.body ? document.body.innerText` を使うため、
          // より具体的なパターン（sold-item-link 等）を先に見る
          if (script.includes('sold-item-link')) return o.scrapeResult
          if (script.includes('outerHTML')) {
            return this.currentUrl.includes('in_progress') ? o.inProgressHtml : o.listingsHtml
          }
          if (script.includes('description')) return o.detailDescription
          if (script.includes('recaptcha')) return o.hasCaptchaFrame
          if (script.includes("querySelector('main')")) return o.loggedIn
          if (script.includes('document.body ? document.body.innerText')) return o.bodyText
          return null
        },
      }
    }

    loadURL(url: string): Promise<void> {
      this.currentUrl = url
      return Promise.resolve()
    }

    isDestroyed(): boolean {
      return this.destroyedFlag
    }

    destroy(): void {
      this.destroyedFlag = true
    }

    isVisible(): boolean {
      return this.visible
    }

    show(): void {
      this.visible = true
    }

    setTitle(title: string): void {
      this.title = title
    }

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

// サムネイル保存（downloadThumbFile）がテスト中に実ファイルへ書き込まないよう潰す。
// readFileSync（fixture読み込み）は実体のまま残す
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, mkdirSync: vi.fn() }
})
vi.mock('node:fs/promises', () => ({ writeFile: vi.fn(async () => {}) }))

// randomWait（ページ間の待ち）を即時にし、テストを遅くしない
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

// db.ts はテストごとに呼び出しを検証したいので個別にモックする
vi.mock('../db', () => ({
  startRun: vi.fn(() => 'run-1'),
  finishRun: vi.fn((
    id: string, status: string, fetched: number, inserted: number, message?: string,
  ) => ({
    id, source: 'mercari', shop_account_id: null, shop_account_name: null,
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:05.000Z',
    status, fetched, inserted, message: message ?? null,
  })),
  existingMercariIds: vi.fn(() => new Set<string>()),
  isMercariItemExcluded: vi.fn(() => false),
  insertCollected: vi.fn((rows: Array<{ mercariItemId: string }>) =>
    rows.map((r, i) => ({ id: `sale-${i}-${r.mercariItemId}`, mercariItemId: r.mercariItemId }))),
  updateCollectedActuals: vi.fn(() => 0),
  updateSaleStatus: vi.fn(() => true),
  salesWithoutThumb: vi.fn(() => []),
  setSaleThumb: vi.fn(),
  setListingThumb: vi.fn(),
  parseKeywords: vi.fn(() => [] as string[]),
  getSettings: vi.fn(() => ({ mercari_keyword: '' })),
  matchesAnyKeyword: vi.fn(() => true),
  upsertListings: vi.fn((rows: unknown[]) => ({ inserted: rows.length, updated: 0 })),
  listingsWithoutThumb: vi.fn(() => [] as string[]),
  listSales: vi.fn(() => []),
  appendModelCodes: vi.fn(() => false),
}))

import {
  buildUserAgent, collect, extractInProgressTotal, extractListingTotal, extractTotalCount,
  isChallengeText, parseInProgressHtml, parseListingsHtml, parseSoldHtml, parseSoldRow, randomWaitMs,
} from '../collector'
import * as db from '../db'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('collector（electronに依存しない部分）', () => {
  describe('randomWaitMs', () => {
    it('2,000〜6,000の範囲に収まる', () => {
      for (let i = 0; i < 200; i++) {
        const ms = randomWaitMs()
        expect(ms).toBeGreaterThanOrEqual(2000)
        expect(ms).toBeLessThanOrEqual(6000)
      }
    })
  })

  describe('buildUserAgent', () => {
    it('Windows：Electron/soroban を含まず、Chrome/メジャー版を含む', () => {
      const ua = buildUserAgent('win32', '130')
      expect(ua).toContain('Chrome/130')
      expect(ua).not.toContain('Electron')
      expect(ua).not.toContain('soroban')
      expect(ua).toContain('Windows NT 10.0')
    })

    it('macOS：Electron/soroban を含まず、Chrome/メジャー版を含む', () => {
      const ua = buildUserAgent('darwin', '130')
      expect(ua).toContain('Chrome/130')
      expect(ua).not.toContain('Electron')
      expect(ua).not.toContain('soroban')
      expect(ua).toContain('Macintosh')
    })
  })

  describe('isChallengeText', () => {
    it('URLにcaptchaが含まれれば true', () => {
      expect(isChallengeText('https://jp.mercari.com/captcha?x=1', '')).toBe(true)
    })

    it('URLにchallenge / verify / /auth/ が含まれれば true', () => {
      expect(isChallengeText('https://jp.mercari.com/challenge', '')).toBe(true)
      expect(isChallengeText('https://jp.mercari.com/verify', '')).toBe(true)
      expect(isChallengeText('https://jp.mercari.com/auth/callback', '')).toBe(true)
    })

    it('hasCaptchaFrame が true なら常に true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '短い', true)).toBe(true)
    })

    it('本文が短く「ロボットではありません」を含めば true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '私はロボットではありません')).toBe(true)
    })

    it('本文が短く「認証コード」を含めば true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '認証コードを入力してください')).toBe(true)
    })

    it('大文字小文字を無視する（CAPTCHA）', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', 'CAPTCHA')).toBe(true)
    })

    it('マイページ本文（長文、「本人確認前」を含む）では false（本人確認だけでは止めない）', () => {
      const longBody = '本人確認前 '.repeat(300) + 'ここはマイページの通常の本文です'
      expect(longBody.length).toBeGreaterThanOrEqual(1500)
      expect(isChallengeText('https://jp.mercari.com/mypage/listings/sold', longBody)).toBe(false)
    })

    it('本文が長ければ「ロボットではありません」等が混ざっていても止めない', () => {
      const longBody = 'x'.repeat(1500) + 'ロボットではありません'
      expect(isChallengeText('https://jp.mercari.com/mypage/listings/sold', longBody)).toBe(false)
    })

    it('通常のページでは false', () => {
      expect(isChallengeText(
        'https://jp.mercari.com/mypage/listings/sold',
        '販売履歴の一覧です',
      )).toBe(false)
    })
  })

  describe('parseSoldRow', () => {
    const cells = ['タイトル欄', '¥8999', '¥899', '¥215', '---', '10%', '¥7885', '---', '2026/09/19']

    it('href から mercariItemId を抜き、¥ 表記の金額を数値に直す', () => {
      const row = parseSoldRow('/transaction/m87039845554', 'テスト商品', cells)
      expect(row).toEqual({
        mercariItemId: 'm87039845554',
        title: 'テスト商品',
        price: 8999,
        fee: 899,
        shippingFee: 215,
        otherCost: null,
        soldAt: '2026-09-19',
        thumbUrl: null,
      })
    })

    it('thumbUrl を渡せばそのまま返す（省略時は null）', () => {
      const url = 'https://static.mercdn.net/thumb/photos/m87039845554_1.jpg?123'
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', cells, url)?.thumbUrl).toBe(url)
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', cells)?.thumbUrl).toBeNull()
    })

    it('「---」は null（他費用）', () => {
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', cells)?.otherCost).toBeNull()
    })

    it('送料 ¥0 は null ではなく 0（着払いの正当な実額）', () => {
      const zeroCells = [...cells]
      zeroCells[3] = '¥0'
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', zeroCells)?.shippingFee).toBe(0)
    })

    it('href に商品IDがなければ null', () => {
      expect(parseSoldRow('/mypage/listings/sold', 'テスト商品', cells)).toBeNull()
    })

    it('価格または購入完了日が読めなければ null', () => {
      const noDate = [...cells]
      noDate[8] = '---'
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', noDate)).toBeNull()
    })
  })

  describe('parseSoldHtml（実DOM抜粋のfixture）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'mercari-sold.html'), 'utf-8')
    const rows = parseSoldHtml(html)

    it('3行取れる', () => {
      expect(rows).toHaveLength(3)
    })

    it('1行目：m87039845554 / 8999 / 899 / 215 / 2026-09-19', () => {
      const r = rows[0]
      expect(r.mercariItemId).toBe('m87039845554')
      expect(r.price).toBe(8999)
      expect(r.fee).toBe(899)
      expect(r.shippingFee).toBe(215)
      expect(r.otherCost).toBeNull()
      expect(r.soldAt).toBe('2026-09-19')
    })

    it('1行目：サムネイルURLを img[src] から拾う', () => {
      expect(rows[0].thumbUrl).toBe(
        'https://static.mercdn.net/thumb/photos/m87039845554_1.jpg?1789188498',
      )
    })

    it('3行目（キャバドレス）は送料 0（着払いの実額）', () => {
      const r = rows[2]
      expect(r.mercariItemId).toBe('m43306721545')
      expect(r.shippingFee).toBe(0)
      expect(r.soldAt).toBe('2020-04-16')
    })

    it('総件数（全18件）を抜く', () => {
      expect(extractTotalCount(html)).toBe(18)
    })
  })

  describe('extractTotalCount', () => {
    it('見つからなければ null', () => {
      expect(extractTotalCount('該当の記載なし')).toBeNull()
    })

    it('カンマ区切りの件数も読む', () => {
      expect(extractTotalCount('1件～20件（全1,234件）')).toBe(1234)
    })
  })

  describe('parseListingsHtml（実DOM抜粋のfixture）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'mercari-listings.html'), 'utf-8')
    const rows = parseListingsHtml(html)

    it('4件取れる（公開中2・公開停止中2）', () => {
      expect(rows).toHaveLength(4)
      expect(rows.filter(r => r.suspended)).toHaveLength(2)
    })

    it('m47972655197：2,350円・公開中・サムネイルURL付き', () => {
      const r = rows.find(r => r.mercariItemId === 'm47972655197')!
      expect(r.price).toBe(2350)
      expect(r.suspended).toBe(false)
      expect(r.thumbUrl).toBe('https://static.mercdn.net/thumb/item/jpeg/m47972655197_1.jpg?1789810502')
      expect(r.title).toContain('メロイアのんびりシリーズ')
      // 更新日時（5時間前）といいね数（アイコン付き3数字のうち最後＝35）
      expect(r.updatedText).toBe('5時間前に更新')
      expect(r.likes).toBe(35)
    })

    it('m33032758836：公開停止中', () => {
      const r = rows.find(r => r.mercariItemId === 'm33032758836')!
      expect(r.suspended).toBe(true)
      expect(r.price).toBe(13500)
      expect(r.updatedText).toBe('7時間前に更新')
      expect(r.likes).toBe(29)
    })

    it('メロジョイ以外の出品も同じ形式で拾う（m92531073051：17日前に更新・いいね47）', () => {
      const r = rows.find(r => r.mercariItemId === 'm92531073051')!
      expect(r.suspended).toBe(true)
      expect(r.title).toContain('Melty Slime')
      expect(r.updatedText).toBe('17日前に更新')
      expect(r.likes).toBe(47)
    })

    it('総件数（22件）を抜く', () => {
      expect(extractListingTotal(html)).toBe(22)
    })
  })

  describe('extractListingTotal', () => {
    it('見つからなければ null', () => {
      expect(extractListingTotal('該当の記載なし')).toBeNull()
    })
  })

  describe('parseInProgressHtml（実DOM抜粋のfixture）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'mercari-in-progress.html'), 'utf-8')
    const rows = parseInProgressHtml(html)

    it('4件取れる', () => {
      expect(rows).toHaveLength(4)
    })

    it('m47467786314：発送してください → waiting_shipment・¥8,999・サムネURL', () => {
      const r = rows.find(r => r.mercariItemId === 'm47467786314')!
      expect(r.price).toBe(8999)
      expect(r.statusText).toBe('発送してください')
      expect(r.status).toBe('waiting_shipment')
      expect(r.updatedText).toBe('3時間前に更新')
      expect(r.thumbUrl).toBe(
        'https://static.mercdn.net/thumb/item/jpeg/m47467786314_1.jpg?1789781431',
      )
    })

    it('m69773157501：受取評価待ち → shipped', () => {
      const r = rows.find(r => r.mercariItemId === 'm69773157501')!
      expect(r.statusText).toBe('受取評価待ち')
      expect(r.status).toBe('shipped')
    })

    it('総件数（4件）を抜く', () => {
      expect(extractInProgressTotal(html)).toBe(4)
    })
  })

  describe('parseInProgressHtml：状態文言のマッピング', () => {
    // fixture と同じ構造の最小HTMLを組み立てる（更新日時の直後の<span>が状態文言）
    function buildHtml(statusText: string, id = 'm100000001'): string {
      return `<div data-testid="mypage-main-content"><ul data-testid="listed-item-list"><li>`
        + `<a href="/transaction/${id}" data-testid="listed-item">`
        + `<img src="https://example.com/${id}.jpg">`
        + `<p data-testid="item-label">テスト商品</p>`
        + `<span data-testid="price"><span>¥</span><span>1,000</span></span>`
        + `<span>1時間前に更新</span>`
        + `<p><span>${statusText}</span></p>`
        + `</a></li></ul></div>`
    }

    it('支払いをしてください → waiting_payment', () => {
      expect(parseInProgressHtml(buildHtml('支払いをしてください'))[0].status).toBe('waiting_payment')
    })

    it('支払い待ち → waiting_payment', () => {
      expect(parseInProgressHtml(buildHtml('支払い待ち'))[0].status).toBe('waiting_payment')
    })

    it('発送待ち → waiting_shipment', () => {
      expect(parseInProgressHtml(buildHtml('発送待ち'))[0].status).toBe('waiting_shipment')
    })

    it('評価をしてください → delivered', () => {
      expect(parseInProgressHtml(buildHtml('評価をしてください'))[0].status).toBe('delivered')
    })

    it('未知の文言は null（statusTextには残す。waiting_shipmentに決め打たない）', () => {
      const row = parseInProgressHtml(buildHtml('謎の状態'))[0]
      expect(row.status).toBeNull()
      expect(row.statusText).toBe('謎の状態')
    })
  })

  describe('extractInProgressTotal', () => {
    it('見つからなければ null', () => {
      expect(extractInProgressTotal('該当の記載なし')).toBeNull()
    })
  })
})

// ============================================================
// collect()（DOM・db をモックしたフルフロー）
// ============================================================
describe('collect()（フルフロー、DOM/dbはモック）', () => {
  const listingsFixtureHtml = readFileSync(join(__dirname, 'fixtures', 'mercari-listings.html'), 'utf-8')
  const soldFixtureHtml = readFileSync(join(__dirname, 'fixtures', 'mercari-sold.html'), 'utf-8')

  beforeEach(() => {
    vi.clearAllMocks()
    // vi.clearAllMocks は呼び出し記録だけ消し、mockImplementation の中身までは戻さないため、
    // 前のテストで differ させた実装（既知扱い・除外扱いなど）が漏れないよう明示的に既定へ戻す
    vi.mocked(db.existingMercariIds).mockImplementation(() => new Set<string>())
    vi.mocked(db.isMercariItemExcluded).mockImplementation(() => false)
    vi.mocked(db.listSales).mockReturnValue([])
    state.opts = {
      loggedIn: true,
      hasCaptchaFrame: false,
      // isChallengeTextの「本文が短い」判定に掛からないよう十分長くしておく
      bodyText: '通常のマイページの本文です。'.repeat(50),
      scrapeResult: { sales: [], totalCount: null },
      listingsHtml: '',
      inProgressHtml: '',
      detailDescription: null,
      fetchImpl: undefined,
    }
    state.createdWindows = []
  })

  it('非表示（silent）実行中にCAPTCHAが出たら、ウィンドウを表示したまま残す（destroyしない）', async () => {
    state.opts.hasCaptchaFrame = true

    const run = await collect(true)

    expect(run.status).toBe('auth_required')
    expect(run.message).toContain('本人確認（CAPTCHA）')
    expect(state.createdWindows).toHaveLength(1)
    expect(state.createdWindows[0].isVisible()).toBe(true)
    expect(state.createdWindows[0].isDestroyed()).toBe(false)
  })

  it('販売0件でも出品中タブを読み、出品が取れればokになる（Codexレビュー指摘）', async () => {
    state.opts.scrapeResult = { sales: [], totalCount: null }
    state.opts.listingsHtml = listingsFixtureHtml // 4件取れるfixture（既存テスト参照）

    const run = await collect(true)

    expect(run.status).toBe('ok')
    expect(run.message).toContain('販売 0 件')
    expect(run.message).toContain('出品 新規 4・更新 0')
    expect(db.upsertListings).toHaveBeenCalled()
  })

  it('販売・出品の両方が0件なら従来どおりemptyのまま', async () => {
    state.opts.scrapeResult = { sales: [], totalCount: null }
    state.opts.listingsHtml =
      '<div data-testid="mypage-main-content">'
      + '<p data-testid="total-item-count"><span>0件</span></p>'
      + '<ul data-testid="listed-item-list"></ul>'
      + '</div>'

    const run = await collect(true)

    expect(run.status).toBe('empty')
    expect(run.message).toContain('0件でした')
  })

  it('出品中タブの総数は読めるのに1件も解析できなければ、販売側がokでもmessageに構造変化を残す', async () => {
    state.opts.scrapeResult = {
      sales: [{
        mercariItemId: 'm100000001',
        title: 'テスト商品',
        price: 1000,
        fee: 100,
        shippingFee: 200,
        otherCost: null,
        soldAt: '2026-01-05',
        thumbUrl: null,
      }],
      totalCount: 1,
    }
    // mypage-main-content・総件数（5件）はあるが listed-item-list が別物に変わっている想定
    state.opts.listingsHtml =
      '<div data-testid="mypage-main-content">'
      + '<p data-testid="total-item-count"><span>5件</span></p>'
      + '<section data-testid="listed-item-list-changed"></section>'
      + '</div>'

    const run = await collect(true)

    // 販売側の結果（1件取得）に従って status は ok のまま
    expect(run.status).toBe('ok')
    expect(run.message).toContain('出品中タブの構造が変わった可能性')
    expect(run.message).toContain('総数 5 件')
    expect(run.message).toContain('解析 0 件')
  })

  it('サムネイルの予算は保存数ではなく試行数で減る：販売側で30件試行（全部失敗）なら出品側は0件試行', async () => {
    const sales = Array.from({ length: 30 }, (_, i) => ({
      mercariItemId: `m9${String(i).padStart(8, '0')}`,
      title: `商品${i}`,
      price: 1000,
      fee: 100,
      shippingFee: 200,
      otherCost: null,
      soldAt: '2026-01-01',
      thumbUrl: `https://static.mercdn.net/thumb/${i}.jpg`,
    }))
    state.opts.scrapeResult = { sales, totalCount: 30 }
    state.opts.listingsHtml = listingsFixtureHtml

    const fetchMock = vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }))
    state.opts.fetchImpl = fetchMock

    // 出品側にもサムネイル未取得の対象がある状態にする（旧実装なら追加で試行されてしまう）
    const listingIds = parseListingsHtml(listingsFixtureHtml).map(l => l.mercariItemId)
    vi.mocked(db.listingsWithoutThumb).mockReturnValue(listingIds)

    await collect(true)

    // 販売側30件の試行だけで、出品側は0件（30 + 4 = 34 にならない）
    expect(fetchMock).toHaveBeenCalledTimes(30)
    expect(db.setListingThumb).not.toHaveBeenCalled()
  })

  it('キーワード設定時：タイトル不一致の販売は挿入されず、サムネイルも取得しない。除外数がmessageに出る', async () => {
    const sales = parseSoldHtml(soldFixtureHtml) // 3件（うち「ワンピース キャバドレス」はメロジョイ不一致）
    state.opts.scrapeResult = { sales, totalCount: sales.length }
    state.opts.listingsHtml = listingsFixtureHtml

    vi.mocked(db.getSettings).mockReturnValue({ mercari_keyword: 'メロジョイ' } as never)
    vi.mocked(db.parseKeywords).mockReturnValue(['メロジョイ'])
    vi.mocked(db.matchesAnyKeyword).mockImplementation(
      (text: string, keywords: string[]) => keywords.some(k => text.toLowerCase().includes(k.toLowerCase())),
    )
    // 他テストの mockReturnValue の持ち越し（vi.clearAllMocks は実装までは戻さない）を断つ
    vi.mocked(db.listingsWithoutThumb).mockReturnValue([])

    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }))
    state.opts.fetchImpl = fetchMock

    const run = await collect(true)

    expect(db.insertCollected).toHaveBeenCalledTimes(1)
    const insertedTitles = vi.mocked(db.insertCollected).mock.calls[0][0].map(r => r.title)
    expect(insertedTitles).toHaveLength(2)
    expect(insertedTitles.every(t => t.includes('メロジョイ'))).toBe(true)

    // サムネイルも不一致の1件（m43306721545）には取りに行かない
    const fetchedUrls = fetchMock.mock.calls.map(c => c[0])
    expect(fetchedUrls).toHaveLength(2)
    expect(fetchedUrls.some(u => u.includes('m43306721545'))).toBe(false)

    expect(run.message).toContain('キーワード不一致で除外 1 件')
  })

  it('キーワードを変更後：既知の不一致販売はサムネイル対象から除外する（db.salesWithoutThumb への入力で確認）', async () => {
    const sales = parseSoldHtml(soldFixtureHtml) // 3件。m43306721545（キャバドレス）はメロジョイ不一致
    state.opts.scrapeResult = { sales, totalCount: sales.length }
    state.opts.listingsHtml = listingsFixtureHtml

    vi.mocked(db.getSettings).mockReturnValue({ mercari_keyword: 'メロジョイ' } as never)
    vi.mocked(db.parseKeywords).mockReturnValue(['メロジョイ'])
    vi.mocked(db.matchesAnyKeyword).mockImplementation(
      (text: string, keywords: string[]) => keywords.some(k => text.toLowerCase().includes(k.toLowerCase())),
    )
    vi.mocked(db.listingsWithoutThumb).mockReturnValue([])

    // 3件とも既に取り込み済み（新規挿入は0件、実額更新だけ）にする
    vi.mocked(db.existingMercariIds).mockImplementation((ids: string[]) => new Set(ids))

    const run = await collect(true)

    expect(db.insertCollected).not.toHaveBeenCalled()
    expect(db.updateCollectedActuals).toHaveBeenCalledTimes(1)

    // サムネイル対象（db.salesWithoutThumb への入力）に、キーワード不一致の
    // m43306721545（キャバドレス）が含まれない
    const idsPassed = vi.mocked(db.salesWithoutThumb).mock.calls[0][0] as string[]
    expect(idsPassed).not.toContain('m43306721545')
    expect(idsPassed.sort()).toEqual(['m84307165710', 'm87039845554'])

    expect(run.message).toContain('既知の不一致でサムネ対象外 1 件')
  })

  it('キーワードを変更後：既知の不一致販売は型番救済の詳細ページも開かない', async () => {
    state.opts.listingsHtml = listingsFixtureHtml

    vi.mocked(db.getSettings).mockReturnValue({ mercari_keyword: 'メロジョイ' } as never)
    vi.mocked(db.parseKeywords).mockReturnValue(['メロジョイ'])
    vi.mocked(db.matchesAnyKeyword).mockImplementation(
      (text: string, keywords: string[]) => keywords.some(k => text.toLowerCase().includes(k.toLowerCase())),
    )
    vi.mocked(db.listingsWithoutThumb).mockReturnValue([])
    vi.mocked(db.listSales).mockReturnValue([{
      id: 'sale-x', mercari_item_id: 'm90000000001', title: 'ワンピース キャバドレス（対象外）',
      kind: 'resale', unmatched: 1, model_codes: [],
    } as never])

    const run = await collect(true)

    // 詳細ページを開かないので appendModelCodes は呼ばれず、message にも「型番の追記」は出ない
    expect(db.appendModelCodes).not.toHaveBeenCalled()
    expect(run.message).not.toContain('型番の追記')
    expect(run.message).toContain('既知の不一致で詳細対象外 1 件')
  })

  it('削除済みの販売（sale_exclusion）は再取り込みしない', async () => {
    const sales = parseSoldHtml(soldFixtureHtml) // 3件
    state.opts.scrapeResult = { sales, totalCount: sales.length }
    state.opts.listingsHtml = listingsFixtureHtml

    vi.mocked(db.getSettings).mockReturnValue({ mercari_keyword: '' } as never)
    vi.mocked(db.parseKeywords).mockReturnValue([])
    vi.mocked(db.listingsWithoutThumb).mockReturnValue([])
    vi.mocked(db.isMercariItemExcluded).mockImplementation((id: string) => id === 'm43306721545')

    const run = await collect(true)

    expect(db.insertCollected).toHaveBeenCalledTimes(1)
    const insertedIds = vi.mocked(db.insertCollected).mock.calls[0][0].map(r => r.mercariItemId)
    expect(insertedIds).not.toContain('m43306721545')
    expect(insertedIds).toHaveLength(2)
    expect(run.message).toContain('削除済み 1 件')
  })

  it('キーワード未設定なら販売は全部挿入される', async () => {
    const sales = parseSoldHtml(soldFixtureHtml)
    state.opts.scrapeResult = { sales, totalCount: sales.length }
    state.opts.listingsHtml = listingsFixtureHtml

    vi.mocked(db.getSettings).mockReturnValue({ mercari_keyword: '' } as never)
    vi.mocked(db.parseKeywords).mockReturnValue([])

    const run = await collect(true)

    expect(db.insertCollected).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.insertCollected).mock.calls[0][0]).toHaveLength(3)
    expect(run.message).not.toContain('キーワード不一致で除外')
  })

  describe('取引中タブ', () => {
    const inProgressFixtureHtml =
      readFileSync(join(__dirname, 'fixtures', 'mercari-in-progress.html'), 'utf-8')

    it('既知の販売はupdateSaleStatusを呼び、未知は新規insertCollectedされる。messageに件数が出る', async () => {
      state.opts.listingsHtml = listingsFixtureHtml
      state.opts.inProgressHtml = inProgressFixtureHtml
      // 4件のうち m47467786314 だけ既知（それ以外3件は新規）
      vi.mocked(db.existingMercariIds).mockImplementation((ids: string[]) =>
        new Set(ids.filter(id => id === 'm47467786314')))

      const run = await collect(true)

      expect(db.updateSaleStatus).toHaveBeenCalledTimes(1)
      expect(db.updateSaleStatus).toHaveBeenCalledWith('m47467786314', 'waiting_shipment')

      // insertCollectedは売却済み側（0件・呼ばれない）と取引中側（1回）の合計1回
      expect(db.insertCollected).toHaveBeenCalledTimes(1)
      const rows = vi.mocked(db.insertCollected).mock.calls[0][0] as Array<{ mercariItemId: string }>
      expect(rows.map(r => r.mercariItemId).sort()).toEqual(
        ['m17929703335', 'm62168185726', 'm69773157501'].sort(),
      )

      expect(run.message).toContain('取引中 4件（新規 3・更新 1）')
    })

    it('総数は読めるのに1件も解析できなければ、messageに構造変化の疑いを残す（出品中と同じ）', async () => {
      state.opts.listingsHtml = listingsFixtureHtml
      state.opts.inProgressHtml =
        '<div data-testid="mypage-main-content">'
        + '<div data-testid="transaction-filter-menu"><p><span>3件</span></p></div>'
        + '<section data-testid="listed-item-list-changed"></section>'
        + '</div>'

      const run = await collect(true)

      expect(run.status).toBe('ok')
      expect(run.message).toContain('取引中タブの構造が変わった可能性')
      expect(run.message).toContain('総数 3 件')
      expect(db.insertCollected).not.toHaveBeenCalled()
    })

    it('削除済みの販売は取引中タブからも再取り込みしない', async () => {
      state.opts.listingsHtml = listingsFixtureHtml
      state.opts.inProgressHtml = inProgressFixtureHtml
      vi.mocked(db.isMercariItemExcluded).mockImplementation((id: string) => id === 'm47467786314')

      const run = await collect(true)

      const rows = vi.mocked(db.insertCollected).mock.calls[0][0] as Array<{ mercariItemId: string }>
      expect(rows.map(r => r.mercariItemId)).not.toContain('m47467786314')
      expect(rows).toHaveLength(3)
      expect(run.message).toContain('削除済み 1 件')
    })

    it('売却済み0・出品0・取引中1（新規）：empty にならず ok。fetched/inserted に取引中分が入る', async () => {
      state.opts.scrapeResult = { sales: [], totalCount: null }
      state.opts.listingsHtml =
        '<div data-testid="mypage-main-content">'
        + '<p data-testid="total-item-count"><span>0件</span></p>'
        + '<ul data-testid="listed-item-list"></ul>'
        + '</div>'
      state.opts.inProgressHtml =
        '<div data-testid="mypage-main-content">'
        + '<ul data-testid="listed-item-list"><li>'
        + '<a href="/transaction/m99999999901" data-testid="listed-item">'
        + '<img src="https://example.com/m99999999901.jpg">'
        + '<p data-testid="item-label">テスト商品</p>'
        + '<span data-testid="price"><span>¥</span><span>1,000</span></span>'
        + '<span>1時間前に更新</span>'
        + '<p><span>発送してください</span></p>'
        + '</a></li></ul></div>'

      const run = await collect(true)

      expect(run.status).toBe('ok')
      expect(run.fetched).toBe(1)
      expect(run.inserted).toBe(1)
    })
  })
})
