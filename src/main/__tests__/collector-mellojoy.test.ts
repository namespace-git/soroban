import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// collectShopOrders() のフルフローをテストするための、実行のたびに差し替え可能な状態。
// FakeBrowserWindow.webContents.executeJavaScript がスクリプトの文字列と現在のURLで
// どの呼び出しかを判別し、ここに積んだ値を返す（実DOMの代わり。collector.test.ts と同じ流儀）
const state = vi.hoisted(() => ({
  opts: {
    hasCaptchaFrame: false,
    bodyText: '通常のマイページの本文です。'.repeat(50),
    listHtml: '',
    /** 詳細ページのURL（href をそのまま絶対URLにしたもの）→ 詳細ページの outerHTML */
    detailHtmlByUrl: {} as Record<string, string>,
  },
  /** loadURL に渡された URL を呼び出し順に積む（詳細ページを開いたかどうかの確認用） */
  loadedUrls: [] as string[],
}))

// collector-mellojoy.ts は electron（BrowserWindow・session）と collector.ts（同じく electron 依存）
// に依存する。純粋関数だけを見るテストのための最小限のモックに加え、collectShopOrders() 自体を
// テストするための簡易 DOM（executeJavaScript をスクリプト文字列で分岐）を用意する
vi.mock('electron', () => {
  class FakeBrowserWindow {
    private destroyedFlag = false
    private currentUrl = ''
    webContents: {
      getURL: () => string
      executeJavaScript: (script: string) => Promise<unknown>
    }

    constructor() {
      this.webContents = {
        getURL: () => this.currentUrl,
        executeJavaScript: async (script: string) => {
          const o = state.opts
          if (script.includes('recaptcha')) return o.hasCaptchaFrame
          if (script.includes('ResourceList')) return true // waitForDetailReady：常に即座にready扱い
          if (script.includes('order-')) return true // waitForOrdersReady：常に即座にready扱い
          if (script.includes('outerHTML')) {
            return this.currentUrl.includes('mellojoyjapan.com')
              ? o.listHtml
              : (o.detailHtmlByUrl[this.currentUrl] ?? '')
          }
          if (script.includes('document.body ? document.body.innerText')) return o.bodyText
          return null
        },
      }
    }

    loadURL(url: string): Promise<void> {
      this.currentUrl = url
      state.loadedUrls.push(url)
      return Promise.resolve()
    }

    isDestroyed(): boolean {
      return this.destroyedFlag
    }

    destroy(): void {
      this.destroyedFlag = true
    }

    on(): void {}
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    session: { fromPartition: () => ({ setUserAgent: () => {} }) },
  }
})

// randomWait（ページ間の待ち）を即時にし、テストを遅くしない
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

// db.ts はテストごとに呼び出しを検証したいので個別にモックする
vi.mock('../db', () => ({
  startRun: vi.fn(() => 'run-1'),
  finishRun: vi.fn((
    id: string, status: string, fetched: number, inserted: number, message?: string,
  ) => ({
    id, source: 'mellojoy', shop_account_id: 'shop-1', shop_account_name: null,
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:05.000Z',
    status, fetched, inserted, message: message ?? null,
  })),
  getShopAccount: vi.fn(() => ({ id: 'shop-1', import_keywords: '' })),
  parseKeywords: vi.fn((raw: string) =>
    raw.split(/[,、\s]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 0)),
  matchesAnyKeyword: vi.fn((text: string, keywords: string[]) =>
    keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))),
  existingImportKeys: vi.fn(() => new Set<string>()),
  updatePurchaseFulfillment: vi.fn(() => false),
  isMellojoyOrderExcluded: vi.fn(() => false),
  markMellojoyOrderExcluded: vi.fn(),
  createPurchase: vi.fn(),
  createPurchaseDraft: vi.fn(),
}))

import {
  collectShopOrders,
  filterPurchaseDraftByKeywords, filterPurchaseInputByKeywords, fulfillmentFromStatus, hashKeywords,
  inferOrderDate, isCancelledDetail, isShopLoginUrl, parseOrderDetailHtml, parseOrderListHtml, shouldSkipDetail,
  toPurchaseInput,
} from '../collector-mellojoy'
import * as db from '../db'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ordersListHtml = readFileSync(join(__dirname, 'fixtures', 'mellojoy-orders.html'), 'utf-8')
const orderDetailHtml = readFileSync(join(__dirname, 'fixtures', 'mellojoy-order.html'), 'utf-8')

describe('collector-mellojoy（electronに依存しない部分）', () => {
  describe('parseOrderListHtml（実DOM抜粋のfixture）', () => {
    const rows = parseOrderListHtml(ordersListHtml)

    it('4件取れる', () => {
      expect(rows).toHaveLength(4)
    })

    it('#268526：確認済み・￥5,397・href', () => {
      const r = rows.find(x => x.orderNo === '#268526')
      expect(r).toBeDefined()
      expect(r?.status).toBe('確認済み')
      expect(r?.total).toBe(5397)
      expect(r?.href).toBe('/69465800944/account/orders/7174504808688?region_country=JP')
    })

    it('#268463：キャンセル済み・￥0', () => {
      const r = rows.find(x => x.orderNo === '#268463')
      expect(r).toBeDefined()
      expect(r?.status).toBe('キャンセル済み')
      expect(r?.total).toBe(0)
    })

    it('#267001・#264129：配達中', () => {
      const r1 = rows.find(x => x.orderNo === '#267001')
      const r2 = rows.find(x => x.orderNo === '#264129')
      expect(r1?.status).toBe('配達中')
      expect(r1?.total).toBe(3098)
      expect(r2?.status).toBe('配達中')
      expect(r2?.total).toBe(3198)
    })

    it('fulfillmentFromStatus：#268526（確認済み）は pending、#267001（配達中）は shipped', () => {
      const r268526 = rows.find(x => x.orderNo === '#268526')
      const r267001 = rows.find(x => x.orderNo === '#267001')
      expect(fulfillmentFromStatus(r268526!.status)).toBe('pending')
      expect(fulfillmentFromStatus(r267001!.status)).toBe('shipped')
    })
  })

  describe('fulfillmentFromStatus', () => {
    it('確認済み → pending', () => {
      expect(fulfillmentFromStatus('確認済み')).toBe('pending')
    })

    it('配達中・発送済み・出荷済み → shipped', () => {
      expect(fulfillmentFromStatus('配達中')).toBe('shipped')
      expect(fulfillmentFromStatus('発送済み')).toBe('shipped')
      expect(fulfillmentFromStatus('出荷済み')).toBe('shipped')
    })

    it('配達済み・受け取り済み・完了 → delivered', () => {
      expect(fulfillmentFromStatus('配達済み')).toBe('delivered')
      expect(fulfillmentFromStatus('受け取り済み')).toBe('delivered')
      expect(fulfillmentFromStatus('完了')).toBe('delivered')
    })

    it('キャンセル済み・空・未知の表記 → null', () => {
      expect(fulfillmentFromStatus('キャンセル済み')).toBeNull()
      expect(fulfillmentFromStatus('')).toBeNull()
      expect(fulfillmentFromStatus('よくわからない状態')).toBeNull()
    })
  })

  describe('parseOrderDetailHtml（実DOM抜粋のfixture #268526）', () => {
    const detail = parseOrderDetailHtml(orderDetailHtml)

    it('orderNo・確認日のテキストが取れる', () => {
      expect(detail.orderNo).toBe('#268526')
      expect(detail.confirmedAtText).toBe('確認日: 9月19日')
    })

    it('明細2行', () => {
      expect(detail.lines).toHaveLength(2)
      expect(detail.lines[0]).toEqual({
        title: 'Mellojoy -ねっとりヨーグルト&ムースクリーム- わふわ肉球ミルクパフ【Z078】【【 ブラインドボックスのおもちゃ】】',
        variant: '【Z078-2】ムースクリーム - わふわ肉球ミルクパフ',
        quantity: 1,
        price: 2499,
      })
      expect(detail.lines[1].price).toBe(2399)
      expect(detail.lines[1].variant).toBe('【Z074-4】もちもちもち - クリーム・ブロッサム')
    })

    it('小計・配送・合計が取れ、未知の行はない', () => {
      expect(detail.subtotal).toBe(4898)
      expect(detail.shipping).toBe(499)
      expect(detail.discount).toBe(0)
      expect(detail.total).toBe(5397)
      expect(detail.unknownRows).toEqual([])
    })
  })

  describe('parseOrderDetailHtml（配送が「無料」表記。実際の注文#270882で下書きに落ちていたバグ）', () => {
    // 配送のセル（￥499）を「無料」に、合計（￥5,397）を配送0円分の￥4,898に差し替える
    const freeShippingHtml = orderDetailHtml
      .replace('>￥499<', '>無料<')
      .replace('>￥5,397<', '>￥4,898<')
    const detail = parseOrderDetailHtml(freeShippingHtml)

    it('shipping は 0（読めない扱いにならない）', () => {
      expect(detail.shipping).toBe(0)
      expect(detail.subtotal).toBe(4898)
      expect(detail.total).toBe(4898)
      expect(detail.unknownRows).toEqual([])
    })

    it('toPurchaseInput で confirmed になり、配送料が読めませんが出ない', () => {
      const opts = { shopAccountId: 'shop-1', orderedAt: '2026-09-19', orderNo: '#268526' }
      const result = toPurchaseInput(detail, opts)
      expect(result.kind).toBe('confirmed')
      if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')
      expect(result.input.shipping_fee).toBe(0)
    })
  })

  describe('inferOrderDate', () => {
    it('年が無ければ今年。今日以前なら今年のまま', () => {
      expect(inferOrderDate('確認日: 9月19日', new Date('2026-09-20'))).toBe('2026-09-19')
    })

    it('今年だと未来になる（1日超）なら前年', () => {
      expect(inferOrderDate('9月19日', new Date('2026-03-01'))).toBe('2025-09-19')
    })

    it('年が明記されていればそれを使う', () => {
      expect(inferOrderDate('2025年1月5日', new Date('2026-09-20'))).toBe('2025-01-05')
    })

    it('日付が読めなければ null', () => {
      expect(inferOrderDate('発送準備中', new Date('2026-09-20'))).toBeNull()
    })
  })

  describe('toPurchaseInput', () => {
    const detail = parseOrderDetailHtml(orderDetailHtml)
    const opts = { shopAccountId: 'shop-1', orderedAt: '2026-09-19', orderNo: '#268526' }

    it('fixture は confirmed になる', () => {
      const result = toPurchaseInput(detail, opts)
      expect(result.kind).toBe('confirmed')
    })

    it('明細の単価・型番・素材、送料、import_key が正しい', () => {
      const result = toPurchaseInput(detail, opts)
      if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')

      expect(result.input.import_key).toBe('mellojoy:#268526')
      expect(result.input.shipping_fee).toBe(499)
      expect(result.input.discount).toBe(0)
      expect(result.input.order_no).toBe('#268526')
      expect(result.input.alloc_method).toBe('by_amount')

      expect(result.input.lines[0].unit_price).toBe(2499)
      expect(result.input.lines[0].model_code).toBe('Z078-2')
      expect(result.input.lines[0].series_code).toBe('Z078')
      expect(result.input.lines[0].material).toBe('ムースクリーム')
      expect(result.input.lines[0].name).toContain('Z078-2')

      expect(result.input.lines[1].unit_price).toBe(2399)
      expect(result.input.lines[1].model_code).toBe('Z074-4')
      expect(result.input.lines[1].series_code).toBe('Z074')
    })

    it('opts.fulfillment が confirmed の input にそのまま通る', () => {
      const result = toPurchaseInput(detail, { ...opts, fulfillment: 'pending' })
      if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')
      expect(result.input.fulfillment).toBe('pending')
    })

    it('opts.fulfillment を渡さなければ null', () => {
      const result = toPurchaseInput(detail, opts)
      if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')
      expect(result.input.fulfillment).toBeNull()
    })

    it('行合計パターン：数量2・価格 ￥4,998・小計 ￥4,998 なら単価は 2499', () => {
      const html = `
        <h1>注文 (#100001)</h1>
        <span>確認日: 1月1日</span>
        <div role="table" aria-labelledby="ResourceList1">
          <div role="row">
            <div role="cell"><span>数量</span>2</div>
            <div role="cell">
              <span>テスト商品</span>
              <small><span>バリアントA</span></small>
            </div>
            <div role="cell"><span>￥4,998</span></div>
          </div>
        </div>
        <h3 id="MoneyLine-Heading1">注文合計</h3>
        <div role="table" aria-labelledby="MoneyLine-Heading1">
          <div role="row"><div role="rowheader"><span>小計・1アイテム</span></div><div role="cell"><span>￥4,998</span></div></div>
          <div role="row"><div role="rowheader"><span>配送</span></div><div role="cell"><span>￥500</span></div></div>
          <div role="row"><div role="rowheader"><strong>合計</strong></div><div role="cell"><strong>￥5,498</strong></div></div>
        </div>
      `
      const d = parseOrderDetailHtml(html)
      const result = toPurchaseInput(d, { shopAccountId: 'shop-1', orderedAt: '2026-01-01', orderNo: '#100001' })
      expect(result.kind).toBe('confirmed')
      if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')
      expect(result.input.lines[0].unit_price).toBe(2499)
      expect(result.input.lines[0].quantity).toBe(2)
    })

    it('合計が合わなければ draft になり、reason が入る', () => {
      const html = `
        <h1>注文 (#100002)</h1>
        <span>確認日: 1月1日</span>
        <div role="table" aria-labelledby="ResourceList2">
          <div role="row">
            <div role="cell"><span>数量</span>1</div>
            <div role="cell"><span>テスト商品</span></div>
            <div role="cell"><span>￥1,000</span></div>
          </div>
        </div>
        <h3 id="MoneyLine-Heading2">注文合計</h3>
        <div role="table" aria-labelledby="MoneyLine-Heading2">
          <div role="row"><div role="rowheader"><span>小計・1アイテム</span></div><div role="cell"><span>￥1,000</span></div></div>
          <div role="row"><div role="rowheader"><span>配送</span></div><div role="cell"><span>￥500</span></div></div>
          <div role="row"><div role="rowheader"><strong>合計</strong></div><div role="cell"><strong>￥2,000</strong></div></div>
        </div>
      `
      const d = parseOrderDetailHtml(html)
      const result = toPurchaseInput(d, { shopAccountId: 'shop-1', orderedAt: '2026-01-01', orderNo: '#100002' })
      expect(result.kind).toBe('draft')
      if (result.kind !== 'draft') throw new Error('draft になるはず')
      expect(result.reason).toContain('合計が一致しません')
      expect(result.input.import_key).toBe('mellojoy:#100002')
    })
  })

  describe('filterPurchaseInputByKeywords（fixture #268526：Z078-2 ¥2,499 + Z074-4 ¥2,399、送料¥499・割引0）', () => {
    const detail = parseOrderDetailHtml(orderDetailHtml)
    const opts = { shopAccountId: 'shop-1', orderedAt: '2026-09-19', orderNo: '#268526' }
    const result = toPurchaseInput(detail, opts)
    if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')
    const input = result.input

    it('キーワードが空なら絞り込まずそのまま返す', () => {
      expect(filterPurchaseInputByKeywords(input, [])).toBe(input)
    })

    it('全明細が一致すればそのまま返す（送料・割引は変えない）', () => {
      const filtered = filterPurchaseInputByKeywords(input, ['mellojoy'])
      expect(filtered).toBe(input)
    })

    it('一部だけ一致：一致した明細だけに絞り、送料・割引を金額比で按分し、noteに除外件数を追記', () => {
      const filtered = filterPurchaseInputByKeywords(input, ['z078'])
      expect(filtered).not.toBeNull()
      expect(filtered!.lines).toHaveLength(1)
      expect(filtered!.lines[0].model_code).toBe('Z078-2')

      // 送料・割引は「一致した明細の小計 ÷ 全明細の小計」の金額比で按分
      const fullSubtotal = 2499 * 1 + 2399 * 1
      const matchedSubtotal = 2499 * 1
      expect(filtered!.shipping_fee).toBe(Math.round(499 * matchedSubtotal / fullSubtotal))
      expect(filtered!.discount).toBe(Math.round(0 * matchedSubtotal / fullSubtotal))

      expect(filtered!.note).toBe(
        '注文履歴から自動取得\nキーワード不一致の明細 1 件を除外（送料・割引は金額比で按分）',
      )
    })

    it('一致0件なら null（取り込まない）', () => {
      expect(filterPurchaseInputByKeywords(input, ['該当しないキーワード'])).toBeNull()
    })
  })

  describe('filterPurchaseDraftByKeywords（下書き：単価不明なので送料・割引は按分しない）', () => {
    const draft = {
      import_key: 'mellojoy:#300001',
      shop_account_id: 'shop-1',
      ordered_at: '2026-01-01',
      order_no: '#300001',
      shipping_fee: 500,
      discount: 100,
      lines: [
        { name: '転売商品【Z078-2】', quantity: 1 },
        { name: '私物のおやつ', quantity: 1 },
      ],
      note: '注文履歴から自動取得（下書き）：小計が読めません',
    }

    it('キーワードが空ならそのまま返す', () => {
      expect(filterPurchaseDraftByKeywords(draft, [])).toBe(draft)
    })

    it('一致0件なら null（取り込まない）', () => {
      expect(filterPurchaseDraftByKeywords(draft, ['該当しないキーワード'])).toBeNull()
    })

    it('一部一致：一致した明細だけに絞り、送料・割引は注文全体の値のまま、noteに除外件数を追記', () => {
      const filtered = filterPurchaseDraftByKeywords(draft, ['z078'])
      expect(filtered).not.toBeNull()
      expect(filtered!.lines).toHaveLength(1)
      expect(filtered!.lines[0].name).toBe('転売商品【Z078-2】')

      // 単価が分からないので按分せず、注文全体の送料・割引のまま
      expect(filtered!.shipping_fee).toBe(500)
      expect(filtered!.discount).toBe(100)

      expect(filtered!.note).toBe(
        '注文履歴から自動取得（下書き）：小計が読めません\n' +
        'キーワード不一致の明細 1 件を除外（送料・割引は注文全体の値。確定時に見直してください）',
      )
    })
  })

  describe('shouldSkipDetail', () => {
    it('明細が1行もなければ true（描画待ちが足りず読めなかった扱い。空の下書きを作らない）', () => {
      const detail = parseOrderDetailHtml('<h1>注文 (#999999)</h1>')
      expect(detail.lines).toHaveLength(0)
      expect(shouldSkipDetail(detail)).toBe(true)
    })

    it('fixture（明細2行）は false', () => {
      const detail = parseOrderDetailHtml(orderDetailHtml)
      expect(shouldSkipDetail(detail)).toBe(false)
    })
  })

  describe('isCancelledDetail', () => {
    it('合計が ￥0 と明示的に読めれば true', () => {
      const html = `
        <h1>注文 (#400001)</h1>
        <h3 id="MoneyLine-Heading1">注文合計</h3>
        <div role="table" aria-labelledby="MoneyLine-Heading1">
          <div role="row"><div role="rowheader"><span>小計・0アイテム</span></div><div role="cell"><span>￥0</span></div></div>
          <div role="row"><div role="rowheader"><strong>合計</strong></div><div role="cell"><strong>￥0</strong></div></div>
        </div>
      `
      expect(isCancelledDetail(parseOrderDetailHtml(html))).toBe(true)
    })

    it('明細が単に描画待ちで読めていないだけ（合計も読めない）なら false（shouldSkipDetail 側の再試行に任せる）', () => {
      const detail = parseOrderDetailHtml('<h1>注文 (#999999)</h1>')
      expect(isCancelledDetail(detail)).toBe(false)
      expect(shouldSkipDetail(detail)).toBe(true)
    })

    it('fixture（合計￥5,397）は false', () => {
      expect(isCancelledDetail(parseOrderDetailHtml(orderDetailHtml))).toBe(false)
    })
  })

  describe('isShopLoginUrl', () => {
    it('注文一覧のURLは false', () => {
      expect(isShopLoginUrl('https://shopify.com/69465800944/account/orders')).toBe(false)
    })

    it('/login を含むパスは true', () => {
      expect(isShopLoginUrl('https://www.mellojoyjapan.com/account/login')).toBe(true)
    })

    it('accounts.shopify.com は true', () => {
      expect(isShopLoginUrl('https://accounts.shopify.com/store-login')).toBe(true)
    })

    it('/authentication を含むパスは true', () => {
      expect(isShopLoginUrl('https://shopify.com/69465800944/account/authentication/login')).toBe(true)
    })

    it('不正なURLは false', () => {
      expect(isShopLoginUrl('not a url')).toBe(false)
    })
  })

  describe('hashKeywords', () => {
    it('同じキーワード（順序違い）なら同じハッシュ', () => {
      expect(hashKeywords(['a', 'b'])).toBe(hashKeywords(['b', 'a']))
    })

    it('キーワードが変われば別のハッシュ', () => {
      expect(hashKeywords(['a'])).not.toBe(hashKeywords(['b']))
    })

    it('空配列も安定したハッシュを返す', () => {
      expect(hashKeywords([])).toBe(hashKeywords([]))
    })
  })
})

// ============================================================
// collectShopOrders()（DOM・db をモックしたフルフロー）
// ============================================================
describe('collectShopOrders()（フルフロー、DOM/dbはモック）', () => {
  /** parseOrderListHtml が読める最小限の注文一覧HTML（複数注文） */
  function buildListHtml(orders: Array<{ orderNo: string; href: string; status?: string; total?: number }>): string {
    return orders.map(o => `
      <article aria-labelledby="order-${o.orderNo}">
        <a aria-label="注文を表示するテスト" href="${o.href}">link</a>
        <h2 role="presentation">${o.status ?? '確認済み'}</h2>
        <span>￥${(o.total ?? 1000).toLocaleString()} JPY</span>
      </article>
    `).join('')
  }

  /** parseOrderDetailHtml が confirmed にできる最小限の詳細HTML（明細1行・送料0・割引0） */
  function buildDetailHtml(orderNo: string, unitPrice: number): string {
    const yen = (n: number) => `￥${n.toLocaleString()}`
    return `
      <h1>注文 (${orderNo})</h1>
      <span>確認日: 1月1日</span>
      <div role="table" aria-labelledby="ResourceList1">
        <div role="row">
          <div role="cell"><span>数量</span>1</div>
          <div role="cell"><span>テスト商品</span></div>
          <div role="cell"><span>${yen(unitPrice)}</span></div>
        </div>
      </div>
      <h3 id="MoneyLine-Heading1">注文合計</h3>
      <div role="table" aria-labelledby="MoneyLine-Heading1">
        <div role="row"><div role="rowheader"><span>小計・1アイテム</span></div><div role="cell"><span>${yen(unitPrice)}</span></div></div>
        <div role="row"><div role="rowheader"><span>配送</span></div><div role="cell"><span>${yen(0)}</span></div></div>
        <div role="row"><div role="rowheader"><strong>合計</strong></div><div role="cell"><strong>${yen(unitPrice)}</strong></div></div>
      </div>
    `
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.getShopAccount).mockReturnValue({ id: 'shop-1', import_keywords: '' } as never)
    vi.mocked(db.parseKeywords).mockImplementation((raw: string) =>
      raw.split(/[,、\s]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 0))
    vi.mocked(db.matchesAnyKeyword).mockImplementation((text: string, keywords: string[]) =>
      keywords.some(k => text.toLowerCase().includes(k.toLowerCase())))
    vi.mocked(db.existingImportKeys).mockReturnValue(new Set<string>())
    vi.mocked(db.isMellojoyOrderExcluded).mockReturnValue(false)
    state.opts = {
      hasCaptchaFrame: false,
      bodyText: '通常のマイページの本文です。'.repeat(50),
      listHtml: '',
      detailHtmlByUrl: {},
    }
    state.loadedUrls = []
  })

  it('除外済みの注文は詳細を開かず、次の注文へ進む（残りの取得枠は消費しない）', async () => {
    state.opts.listHtml = buildListHtml([
      { orderNo: '#100001', href: 'https://shop.example.com/order/100001' },
      { orderNo: '#100002', href: 'https://shop.example.com/order/100002' },
    ])
    state.opts.detailHtmlByUrl = {
      'https://shop.example.com/order/100002': buildDetailHtml('#100002', 1000),
    }
    vi.mocked(db.isMellojoyOrderExcluded).mockImplementation(
      (_shopAccountId: string, orderKey: string) => orderKey === '#100001',
    )

    const run = await collectShopOrders('shop-1', true)

    expect(state.loadedUrls).not.toContain('https://shop.example.com/order/100001')
    expect(state.loadedUrls).toContain('https://shop.example.com/order/100002')
    expect(db.createPurchase).toHaveBeenCalledTimes(1)
    expect(run.status).toBe('ok')
    expect(run.message).toContain('不一致で除外済み・スキップ 1 件')
  })

  it('詳細ページでキーワード不一致と判明したら markMellojoyOrderExcluded を呼ぶ', async () => {
    state.opts.listHtml = buildListHtml([{ orderNo: '#100003', href: 'https://shop.example.com/order/100003' }])
    state.opts.detailHtmlByUrl = {
      'https://shop.example.com/order/100003': buildDetailHtml('#100003', 1000),
    }
    vi.mocked(db.getShopAccount).mockReturnValue({ id: 'shop-1', import_keywords: '該当しないキーワード' } as never)
    vi.mocked(db.parseKeywords).mockReturnValue(['該当しないキーワード'])

    const run = await collectShopOrders('shop-1', true)

    expect(db.markMellojoyOrderExcluded).toHaveBeenCalledWith(
      'shop-1', '#100003', hashKeywords(['該当しないキーワード']),
    )
    expect(db.createPurchase).not.toHaveBeenCalled()
    expect(run.status).toBe('ok')
  })

  it('詳細取得の対象が全件失敗（解析不能）なら failed になる', async () => {
    state.opts.listHtml = buildListHtml([{ orderNo: '#200001', href: 'https://shop.example.com/order/200001' }])
    // detailHtmlByUrl に何も積まない → outerHTML が空文字 → 明細0行 → shouldSkipDetail で失敗扱い

    const run = await collectShopOrders('shop-1', true)

    expect(run.status).toBe('failed')
  })

  it('既取込のみ（詳細取得の対象0件）なら ok のまま', async () => {
    state.opts.listHtml = buildListHtml([{ orderNo: '#300001', href: 'https://shop.example.com/order/300001' }])
    vi.mocked(db.existingImportKeys).mockReturnValue(new Set(['mellojoy:#300001']))

    const run = await collectShopOrders('shop-1', true)

    expect(run.status).toBe('ok')
    expect(db.createPurchase).not.toHaveBeenCalled()
    expect(state.loadedUrls).not.toContain('https://shop.example.com/order/300001')
  })

  it('状態表示に「キャンセル」の文字がなくても合計￥0なら一覧の時点で除外する（詳細を開かない）', async () => {
    state.opts.listHtml = buildListHtml([
      { orderNo: '#500001', href: 'https://shop.example.com/order/500001', status: '確認済み', total: 0 },
    ])

    const run = await collectShopOrders('shop-1', true)

    expect(state.loadedUrls).not.toContain('https://shop.example.com/order/500001')
    expect(db.createPurchase).not.toHaveBeenCalled()
    expect(run.message).toContain('キャンセル 1')
    expect(run.status).toBe('ok')
  })

  it('一覧の合計が読めない注文が、詳細で合計￥0と判明したらキャンセル扱いにする（失敗にしない）', async () => {
    // 一覧に ￥...JPY の表記が無い＝parseOrderListHtml では total が null になり active に残る
    state.opts.listHtml = `
      <article aria-labelledby="order-#400001">
        <a aria-label="注文を表示するテスト" href="https://shop.example.com/order/400001">link</a>
        <h2 role="presentation">確認済み</h2>
      </article>
    `
    state.opts.detailHtmlByUrl = {
      'https://shop.example.com/order/400001': `
        <h1>注文 (#400001)</h1>
        <span>確認日: 1月1日</span>
        <h3 id="MoneyLine-Heading1">注文合計</h3>
        <div role="table" aria-labelledby="MoneyLine-Heading1">
          <div role="row"><div role="rowheader"><span>小計・0アイテム</span></div><div role="cell"><span>￥0</span></div></div>
          <div role="row"><div role="rowheader"><strong>合計</strong></div><div role="cell"><strong>￥0</strong></div></div>
        </div>
      `,
    }

    const run = await collectShopOrders('shop-1', true)

    expect(state.loadedUrls).toContain('https://shop.example.com/order/400001')
    expect(db.markMellojoyOrderExcluded).toHaveBeenCalledWith('shop-1', '#400001', hashKeywords([]))
    expect(db.createPurchase).not.toHaveBeenCalled()
    expect(run.message).toContain('キャンセル 1')
    expect(run.message).not.toContain('明細が読めませんでした')
    expect(run.status).toBe('ok')
  })

  it('一覧が0件なら従来どおり empty', async () => {
    state.opts.listHtml = ''

    const run = await collectShopOrders('shop-1', true)

    expect(run.status).toBe('empty')
  })
})
