import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  extractYahooSalesCsvForm,
  extractYahooSoldTotal,
  mapYahooTradstat,
  parseYahooItemHtml,
  parseYahooSalesHtml,
  parseYahooSoldHtml,
} from '../collector-yahoo'
import { CODE_RE, extractCodes } from '../code'

/** クラス名（class="..."）を全部同じダミーに置換する（クラス名に依存していないことの証明用） */
function replaceAllClasses(html: string): string {
  return html.replace(/class="[^"]*"/g, 'class="zz-changed-name"')
}

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('collector-yahoo（electronに依存しない部分）', () => {
  describe('parseYahooSoldHtml（実DOM抜粋のfixture）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
    const rows = parseYahooSoldHtml(html)

    it('4件取れる', () => {
      expect(rows).toHaveLength(4)
    })

    it('id・タイトル・価格・tradstat を4件とも固定で確かめる', () => {
      expect(rows[0].yahooItemId).toBe('z693579992')
      expect(rows[0].price).toBe(5200)
      expect(rows[0].title).toContain('メロジョイ ふわふわ肉球ミルクパフ ねっとりヨーグルト【Z074-4】')

      expect(rows[1].yahooItemId).toBe('z693407762')
      expect(rows[1].price).toBe(6400)
      expect(rows[1].title).toContain('Mellojoy メロジョイ 贅沢スフレ チョコレート Mサイズ 新品未開封【Z072-7】')

      expect(rows[2].yahooItemId).toBe('z693289446')
      expect(rows[2].price).toBe(5899)
      expect(rows[2].title).toContain('Mellojoy メロジョイ いちごショートケーキ ホール スクイーズ 新品未開封')

      expect(rows[3].yahooItemId).toBe('z693287844')
      expect(rows[3].price).toBe(4280)
      expect(rows[3].title).toContain('Mellojoy メロジョイ クッキークラブ クリームブロッサム もちもちもち')
    })

    it('価格は integer で返る（"5,200円" → 5200）', () => {
      for (const r of rows) {
        expect(Number.isInteger(r.price)).toBe(true)
      }
      expect(rows[0].price).toBe(5200)
    })

    it('tradstat は4件とも SELLER_SHIPPED', () => {
      expect(rows.map(r => r.tradstat)).toEqual([
        'SELLER_SHIPPED', 'SELLER_SHIPPED', 'SELLER_SHIPPED', 'SELLER_SHIPPED',
      ])
    })

    it('statusText は「受け取り評価待ち」', () => {
      for (const r of rows) {
        expect(r.statusText).toBe('受け取り評価待ち')
      }
    })

    it('サムネイルURLを img[alt="商品画像"] から拾う', () => {
      expect(rows[0].thumbUrl).toBe(
        'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/xxxx/i-img900x1200-1790553267931ognab8.jpg',
      )
    })

    it('総数（1~4件/4件）を4と取る', () => {
      expect(extractYahooSoldTotal(html)).toBe(4)
    })

    it('型番：タイトルに【Z074-4】【Z072-7】があれば CODE_RE で取れ、型番の無い2件では取れない', () => {
      expect(extractCodes(rows[0].title)).toEqual(['Z074-4'])
      expect(extractCodes(rows[1].title)).toEqual(['Z072-7'])
      expect(CODE_RE.exec(rows[2].title)).toBeNull()
      expect(extractCodes(rows[2].title)).toEqual([])
      expect(CODE_RE.exec(rows[3].title)).toBeNull()
      expect(extractCodes(rows[3].title)).toEqual([])
    })

    it('クラス名（sc-）を別の文字列に置換しても同じ結果になる（クラス名に依存していないことの証明）', () => {
      // fixture 自体にはクラス名が無いので、実DOMに近づけるために a/p/span/div に
      // sc- 始まりのクラス名を足してから、それを丸ごと別の文字列に置換する
      const withClasses = html
        .replace(/<a\b/g, '<a class="sc-a1b2c3d4-0" ')
        .replace(/<div>/g, '<div class="sc-e5f6a7b8-1">')
        .replace(/<p>/g, '<p class="sc-c9d0e1f2-2">')
        .replace(/<span>/g, '<span class="sc-a3b4c5d6-3">')
        .replace(/<img\b/g, '<img class="sc-b7c8d9e0-4" ')
      const renamed = withClasses.replace(/sc-[a-z0-9]{8}-\d/g, 'zz-changed-name')

      expect(parseYahooSoldHtml(renamed)).toEqual(rows)
    })

    it('壊れた HTML（空文字・タグだけ・data-cl-params が無い）は throw せず空配列', () => {
      expect(parseYahooSoldHtml('')).toEqual([])
      expect(parseYahooSoldHtml('<div><span></span></div>')).toEqual([])
      expect(parseYahooSoldHtml('<a href="https://paypayfleamarket-sec.yahoo.co.jp/item/z1/trade/seller">x</a>'))
        .toEqual([])
    })
  })

  describe('mapYahooTradstat', () => {
    it('NONE（出品中。まだ売れていない）は null', () => {
      expect(mapYahooTradstat('NONE')).toBeNull()
    })

    it('WAIT_FOR_SELLER_SHIP（売れて未発送）は waiting_shipment', () => {
      expect(mapYahooTradstat('WAIT_FOR_SELLER_SHIP')).toBe('waiting_shipment')
    })

    it('SELLER_SHIPPED（発送済み・受け取り評価待ち）は shipped', () => {
      expect(mapYahooTradstat('SELLER_SHIPPED')).toBe('shipped')
    })

    it('知らない値は null（推測で埋めない）', () => {
      expect(mapYahooTradstat('SOME_UNKNOWN_STATUS')).toBeNull()
      expect(mapYahooTradstat('')).toBeNull()
    })
  })

  describe('extractYahooSoldTotal', () => {
    it('見つからなければ null', () => {
      expect(extractYahooSoldTotal('該当の記載なし')).toBeNull()
    })

    it('カンマ区切りの件数も読む', () => {
      expect(extractYahooSoldTotal('1~20件/1,234件')).toBe(1234)
    })
  })

  describe('parseYahooSalesHtml（売上金管理。実物のfixture 2026-09-28）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-salesmanagement.html'), 'utf-8')
    const rows = parseYahooSalesHtml(html)

    it('4件取れる', () => {
      expect(rows).toHaveLength(4)
    })

    it('id・取扱日・決済金額・販売手数料・受取額が4件とも実物の数字と一致する', () => {
      expect(rows.map(r => ({
        yahooItemId: r.yahooItemId,
        handledDate: r.handledDate,
        settlementAmount: r.settlementAmount,
        feeAmount: r.feeAmount,
        receivedAmount: r.receivedAmount,
      }))).toEqual([
        { yahooItemId: 'z693579992', handledDate: '2026-09-28', settlementAmount: 5200, feeAmount: 0, receivedAmount: 5200 },
        { yahooItemId: 'z693407762', handledDate: '2026-09-28', settlementAmount: 6400, feeAmount: 320, receivedAmount: 6080 },
        { yahooItemId: 'z693289446', handledDate: '2026-09-28', settlementAmount: 5899, feeAmount: 294, receivedAmount: 5605 },
        { yahooItemId: 'z693287844', handledDate: '2026-09-27', settlementAmount: 4280, feeAmount: 213, receivedAmount: 4067 },
      ])
    })

    it('決済金額 − 販売手数料 = 受取額 が4件とも成り立つ', () => {
      for (const r of rows) {
        expect(r.settlementAmount - r.feeAmount).toBe(r.receivedAmount)
      }
    })

    it('手数料0円は 0（null や undefined にならない）', () => {
      expect(rows[0].feeAmount).toBe(0)
      expect(Number.isInteger(rows[0].feeAmount)).toBe(true)
    })

    it('取扱日は YYYY-MM-DD に正規化される（2026/9/28 → 2026-09-28、2026/9/27 → 2026-09-27）', () => {
      expect(rows.map(r => r.handledDate)).toEqual([
        '2026-09-28', '2026-09-28', '2026-09-28', '2026-09-27',
      ])
    })

    it('決済ID（_settle_id）が4件とも取れる', () => {
      expect(rows.map(r => r.settleId)).toEqual([
        '26092882071555', '26092881969171', '26092881911392', '26092781753104',
      ])
    })

    it('状態は「受取連絡待ち」、内訳に未知のラベルは無い（送料の行はまだ無い）', () => {
      for (const r of rows) {
        expect(r.statusText).toBe('受取連絡待ち')
        expect(r.otherBreakdown).toEqual([])
      }
    })

    it('クラス名を全置換しても同じ結果になる', () => {
      expect(parseYahooSalesHtml(replaceAllClasses(html))).toEqual(rows)
    })

    it('壊れた HTML（空・タグだけ・表が無い）は throw せず空配列', () => {
      expect(parseYahooSalesHtml('')).toEqual([])
      expect(parseYahooSalesHtml('<div><span></span></div>')).toEqual([])
      expect(parseYahooSalesHtml('<table id="salelst"><tbody></tbody></table>')).toEqual([])
    })
  })

  describe('extractYahooSalesCsvForm（売上金管理のCSVダウンロードフォーム）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-salesmanagement.html'), 'utf-8')
    const form = extractYahooSalesCsvForm(html)

    it('送信先が取れる', () => {
      expect(form?.action).toBe('https://salesmanagement.yahoo.co.jp/salesmanagelist_csv')
    })

    it('月の選択肢（i=YYYYMM）が3つ取れる', () => {
      expect(form?.monthOptions).toEqual([
        { value: '', label: '直近3カ月' },
        { value: '202609', label: '2026年9月' },
        { value: '202608', label: '2026年8月' },
        { value: '202607', label: '2026年7月' },
      ])
    })

    it('.crumb は fixture の REDACTED がそのまま読める（実物の値をテストに書かない）', () => {
      expect(form?.crumb).toBe('REDACTED')
    })

    it('壊れた HTML（フォームが無い）は throw せず null', () => {
      expect(extractYahooSalesCsvForm('')).toBeNull()
      expect(extractYahooSalesCsvForm('<div></div>')).toBeNull()
    })
  })

  describe('parseYahooItemHtml（商品ページ。実物のfixture 2026-09-28）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-item.html'), 'utf-8')
    const item = parseYahooItemHtml(html)

    it('商品 id・タイトル・価格・配送の方法が取れる', () => {
      expect(item?.yahooItemId).toBe('z693337994')
      expect(item?.title).toBe('Mellojoy メロジョイ 特濃牛乳アイスS ねっとりヨーグルト スクイーズ 新品未開封【Z088-01】')
      expect(item?.price).toBe(7100)
      expect(Number.isInteger(item?.price)).toBe(true)
      expect(item?.shippingMethod).toBe('おてがる配送（ヤマト運輸）')
    })

    it('商品の状態・発送までの日数・発送元の地域・いいね数・閲覧数が取れる', () => {
      expect(item?.condition).toBe('未使用')
      expect(item?.shippingDays).toBe('2〜3日で発送')
      expect(item?.shippingArea).toBe('福岡県')
      expect(item?.likes).toBe(19)
      expect(item?.views).toBe(213)
    })

    it('出品日時は見える文字（22:15）側で、pageData の starttime（10:15、12時間ずれ）にならない', () => {
      expect(item?.listedAt).toBe('2026-09-27T22:15')
      expect(item?.listedAt).not.toContain('10:15')
      expect(item?.publishedAt).toBe('2026-09-27T22:15')
    })

    it('画像URLは img[alt] がタイトルと一致するものから取れる', () => {
      expect(item?.thumbUrl).toBe(
        'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/xxxx/i-img900x1200-17905717326651snizd.jpg',
      )
    })

    it('タイトルから CODE_RE で Z088-01 が取れる', () => {
      expect(CODE_RE.exec(item?.title ?? '')?.[1]).toBe('Z088-01')
    })

    it('クラス名を全置換しても同じ結果になる', () => {
      expect(parseYahooItemHtml(replaceAllClasses(html))).toEqual(item)
    })

    it('壊れた HTML（空・タグだけ・h1が無い）は throw せず null', () => {
      expect(parseYahooItemHtml('')).toBeNull()
      expect(parseYahooItemHtml('<div><span></span></div>')).toBeNull()
      expect(parseYahooItemHtml('<h1></h1>')).toBeNull()
    })
  })
})
