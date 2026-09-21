import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// collector-mellojoy.ts は electron（BrowserWindow・session）と collector.ts（同じく electron 依存）
// に依存する。ここで検証するのは electron に依存しない純粋関数だけなので、
// import を通すために両方潰しておく
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({ setUserAgent: () => {} }) },
}))

import {
  filterPurchaseDraftByKeywords, filterPurchaseInputByKeywords, fulfillmentFromStatus, inferOrderDate,
  isShopLoginUrl, parseOrderDetailHtml, parseOrderListHtml, shouldSkipDetail, toPurchaseInput,
} from '../collector-mellojoy'

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
})
