import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import {
  combineYahooSales,
  extractYahooSalesCsvForm,
  extractYahooSellingCounts,
  extractYahooSoldTotal,
  formatYahooDebugSavedNote,
  formatYahooHtmlSummary,
  formatYahooInconsistentNote,
  formatYahooRenderTimeoutNote,
  formatYahooTruncatedTitleNote,
  hasYahooItemLinks,
  isYahooCollectEmpty,
  mapYahooTradstat,
  parseYahooItemHtml,
  parseYahooSalesHtml,
  parseYahooSellingHtml,
  parseYahooSoldHtml,
  splitYahooCombinedSales,
  summarizeYahooHtml,
  zeroYahooPageNames,
  type YahooCombinedSale,
  type YahooSalesRow,
  type YahooScrapedSale,
} from '../collector-yahoo'
import { CODE_RE, extractCodes } from '../code'
import { matchesAnyKeyword, parseKeywords } from '../db'

/** クラス名（class="..."）を全部同じダミーに置換する（クラス名に依存していないことの証明用） */
function replaceAllClasses(html: string): string {
  return html.replace(/class="[^"]*"/g, 'class="zz-changed-name"')
}

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('collector-yahoo（electronに依存しない部分）', () => {
  describe('parseYahooSoldHtml（実機の出力そのままのfixture。<!-- --> を含む）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
    const rows = parseYahooSoldHtml(html)

    it('6件取れる', () => {
      expect(rows).toHaveLength(6)
    })

    it('id・タイトル・価格・tradstat を6件とも固定で確かめる', () => {
      expect(rows[0].yahooItemId).toBe('z100000008')
      expect(rows[0].price).toBe(7100)
      expect(rows[0].title).toBe('Mellojoy メロジョイ 特濃牛乳アイスS ねっとりヨーグルト スクイーズ 新品未開封【Z088-01】')
      expect(rows[0].tradstat).toBe('WAIT_FOR_SELLER_SHIP')

      expect(rows[1].yahooItemId).toBe('z100000009')
      expect(rows[1].price).toBe(6400)
      expect(rows[1].title).toBe('Mellojoy メロジョイ トーストスティック 未開封【A036】')
      expect(rows[1].tradstat).toBe('WAIT_FOR_SELLER_SHIP')

      expect(rows[2].yahooItemId).toBe('z100000010')
      expect(rows[2].price).toBe(5200)
      expect(rows[2].title).toBe('メロジョイ ふわふわ肉球ミルクパフ ねっとりヨーグルト【Z074-4】')
      expect(rows[2].tradstat).toBe('SELLER_SHIPPED')

      expect(rows[3].yahooItemId).toBe('z100000011')
      expect(rows[3].price).toBe(6400)
      expect(rows[3].title).toBe('Mellojoy メロジョイ 贅沢スフレ チョコレート Mサイズ 新品未開封【Z072-7】')
      expect(rows[3].tradstat).toBe('SELLER_SHIPPED')

      expect(rows[4].yahooItemId).toBe('z100000012')
      expect(rows[4].price).toBe(5899)
      expect(rows[4].title).toBe('Mellojoy メロジョイ いちごショートケーキ ホール スクイーズ 新品未開封')
      expect(rows[4].tradstat).toBe('SELLER_SHIPPED')

      expect(rows[5].yahooItemId).toBe('z100000013')
      expect(rows[5].price).toBe(4280)
      expect(rows[5].title).toBe('Mellojoy メロジョイ クッキークラブ クリームブロッサム もちもちもち')
      expect(rows[5].tradstat).toBe('SELLER_SHIPPED')
    })

    it('価格は integer で返る（HTML中は "7,100<!-- -->円" という形）', () => {
      for (const r of rows) {
        expect(Number.isInteger(r.price)).toBe(true)
      }
      expect(rows[0].price).toBe(7100)
    })

    it('コメントを消してから数字を読むので、隣り合う数字がくっつかない（"7,100<!-- -->円" が "7100円" にならず、7100 と正しく読める）', () => {
      expect(html).toContain('7,100<!-- -->円')
      expect(rows[0].price).toBe(7100)
    })

    it('tradstat は WAIT_FOR_SELLER_SHIP が2件・SELLER_SHIPPED が4件', () => {
      expect(rows.map(r => r.tradstat)).toEqual([
        'WAIT_FOR_SELLER_SHIP', 'WAIT_FOR_SELLER_SHIP',
        'SELLER_SHIPPED', 'SELLER_SHIPPED', 'SELLER_SHIPPED', 'SELLER_SHIPPED',
      ])
    })

    it('statusText はWAIT_FOR_SELLER_SHIPが「商品を発送したら発送連絡をしてください」、SELLER_SHIPPEDが「受け取り評価待ち」', () => {
      expect(rows[0].statusText).toBe('商品を発送したら発送連絡をしてください')
      expect(rows[1].statusText).toBe('商品を発送したら発送連絡をしてください')
      for (const r of rows.slice(2)) {
        expect(r.statusText).toBe('受け取り評価待ち')
      }
    })

    it('サムネイルURLを img[alt="商品画像"] から拾う', () => {
      expect(rows[0].thumbUrl).toBe(
        'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/deadbeefcafebabe0123456789abcdef01234567/i-img900x1200-17905717326651snizd.jpg',
      )
    })

    it('総数（1~6件/6件）を6と取る（HTML中は "1<!-- -->~<!-- -->6<!-- -->件/<!-- -->6<!-- -->件" という形）', () => {
      expect(html).toContain('1<!-- -->~<!-- -->6<!-- -->件/<!-- -->6<!-- -->件')
      expect(extractYahooSoldTotal(html)).toBe(6)
    })

    it('型番：タイトルに【Z088-01】【A036】【Z074-4】【Z072-7】があれば CODE_RE で取れ、型番の無い2件では取れない', () => {
      expect(extractCodes(rows[0].title)).toEqual(['Z088-01'])
      expect(extractCodes(rows[1].title)).toEqual(['A036'])
      expect(extractCodes(rows[2].title)).toEqual(['Z074-4'])
      expect(extractCodes(rows[3].title)).toEqual(['Z072-7'])
      expect(CODE_RE.exec(rows[4].title)).toBeNull()
      expect(extractCodes(rows[4].title)).toEqual([])
      expect(CODE_RE.exec(rows[5].title)).toBeNull()
      expect(extractCodes(rows[5].title)).toEqual([])
    })

    it('クラス名（sc-）を別の文字列に置換しても同じ結果になる（クラス名に依存していないことの証明）', () => {
      expect(parseYahooSoldHtml(replaceAllClasses(html))).toEqual(rows)
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

  describe('hasYahooItemLinks（Next.jsのクライアント描画が終わったかの判定。実機で「2ページが空のまま読まれる」を踏んだ対策）', () => {
    it('出品中一覧（実物fixture・描画済み）は true', () => {
      const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-selling.html'), 'utf-8')
      expect(hasYahooItemLinks(html)).toBe(true)
    })

    it('取引中・取引完了一覧（実物fixture・描画済み）は true', () => {
      const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
      expect(hasYahooItemLinks(html)).toBe(true)
    })

    it('描画前の空の殻（ナビの /my/item/selling /my/item/sold だけがあり、商品へのリンクが無い）は false', () => {
      const shellHtml = `
        <html><body>
          <div id="__next">
            <nav>
              <a href="/my/item/selling">出品中</a>
              <a href="/my/item/sold">取引中・取引完了</a>
            </nav>
            <div class="loading-skeleton"></div>
          </div>
        </body></html>
      `
      expect(hasYahooItemLinks(shellHtml)).toBe(false)
    })

    it('空文字・タグだけも false（throwしない）', () => {
      expect(hasYahooItemLinks('')).toBe(false)
      expect(hasYahooItemLinks('<div><span></span></div>')).toBe(false)
    })
  })

  describe('summarizeYahooHtml（0件だったときの切り分け用。各パーサが頼っている手がかりの有無・個数を数える）', () => {
    it('出品中一覧（実物fixture）：data-cl-params・rcconid・商品リンクがあり、__NEXT_DATA__ あり、salelst表は無い', () => {
      const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-selling.html'), 'utf-8')
      const s = summarizeYahooHtml(html)
      expect(s.length).toBe(html.length)
      expect(s.dataClParamsCount).toBeGreaterThan(0)
      expect(s.rcconidCount).toBeGreaterThan(0)
      expect(s.itemHrefCount).toBeGreaterThan(0)
      expect(s.hasSalelstTable).toBe(false)
    })

    it('取引中・取引完了一覧（実物fixture）：data-cl-params・rcconid・商品リンクがある', () => {
      const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
      const s = summarizeYahooHtml(html)
      expect(s.dataClParamsCount).toBeGreaterThan(0)
      expect(s.rcconidCount).toBeGreaterThan(0)
      expect(s.itemHrefCount).toBeGreaterThan(0)
    })

    it('売上金管理（実物fixture）：salelst表があり、data-cl-params・rcconidは無い', () => {
      const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-salesmanagement.html'), 'utf-8')
      const s = summarizeYahooHtml(html)
      expect(s.hasSalelstTable).toBe(true)
      expect(s.dataClParamsCount).toBe(0)
      expect(s.rcconidCount).toBe(0)
    })

    it('空の殻（商品リンクも data-cl-params も無い）は全部0・falseになる（throwしない）', () => {
      const shellHtml = `
        <html><body>
          <div id="__next">
            <nav>
              <a href="/my/item/selling">出品中</a>
              <a href="/my/item/sold">取引中・取引完了</a>
            </nav>
          </div>
        </body></html>
      `
      const s = summarizeYahooHtml(shellHtml)
      expect(s.dataClParamsCount).toBe(0)
      expect(s.rcconidCount).toBe(0)
      expect(s.itemHrefCount).toBe(0)
      expect(s.hasNextData).toBe(false)
      expect(s.hasSalelstTable).toBe(false)
    })

    it('空文字も throw せず全部0・falseになる', () => {
      const s = summarizeYahooHtml('')
      expect(s).toEqual({
        length: 0,
        dataClParamsCount: 0,
        rcconidCount: 0,
        itemHrefCount: 0,
        hasNextData: false,
        hasSalelstTable: false,
      })
    })

    it('summarizeYahooHtml は <!-- --> を消さずに length を数える（意図的。0件だったときに「実際に何文字受信できたか」を切り分けるための関数なので、他のパーサのようにコメントを除去してから数えると受信量が分からなくなる）', () => {
      const withComment = '<p>7,500<!-- -->円</p>'
      const s = summarizeYahooHtml(withComment)
      expect(s.length).toBe(withComment.length)
      // 比較：他のパーサの起点として使う stripHtmlComments 相当の処理をした場合より長い
      expect(s.length).toBeGreaterThan(withComment.replace(/<!--[\s\S]*?-->/g, '').length)
    })
  })

  describe('formatYahooHtmlSummary / formatYahooDebugSavedNote（実行記録に出す文言）', () => {
    it('summarizeYahooHtml の結果を1行にまとめる', () => {
      const note = formatYahooHtmlSummary({
        length: 12345,
        dataClParamsCount: 8,
        rcconidCount: 8,
        itemHrefCount: 5,
        hasNextData: true,
        hasSalelstTable: false,
      })
      expect(note).toBe(
        '長さ12345・data-cl-params 8・rcconid 8・商品リンク 5・__NEXT_DATA__有・salelst表無',
      )
    })

    it('保存先のパスと特徴が1行になる', () => {
      const note = formatYahooDebugSavedNote('出品中', 'C:\\Users\\x\\AppData\\Roaming\\soroban\\debug\\yahoo-selling.html', {
        length: 100,
        dataClParamsCount: 0,
        rcconidCount: 0,
        itemHrefCount: 0,
        hasNextData: false,
        hasSalelstTable: false,
      })
      expect(note).toBe(
        '出品中：0件のHTMLを保存しました（C:\\Users\\x\\AppData\\Roaming\\soroban\\debug\\yahoo-selling.html'
        + '｜長さ100・data-cl-params 0・rcconid 0・商品リンク 0・__NEXT_DATA__無・salelst表無）',
      )
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
        { yahooItemId: 'z100000010', handledDate: '2026-09-28', settlementAmount: 5200, feeAmount: 0, receivedAmount: 5200 },
        { yahooItemId: 'z100000011', handledDate: '2026-09-28', settlementAmount: 6400, feeAmount: 320, receivedAmount: 6080 },
        { yahooItemId: 'z100000012', handledDate: '2026-09-28', settlementAmount: 5899, feeAmount: 294, receivedAmount: 5605 },
        { yahooItemId: 'z100000013', handledDate: '2026-09-27', settlementAmount: 4280, feeAmount: 213, receivedAmount: 4067 },
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

    it('決済ID（_settle_id）が4件とも取れる（架空の値。実物の決済記録の番号はテストに書かない）', () => {
      expect(rows.map(r => r.settleId)).toEqual([
        '10000000000001', '10000000000002', '10000000000003', '10000000000004',
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

    it('<tr> <td> <dt> <dd> <table> に属性を足しても同じ結果になる（属性の有無に依存しない）', () => {
      // fixture の <tr> <td> は元々属性を持たない（Yahoo が class や data-* を足しただけで
      // 表も金額も正常なのに0件になった実害があった箇所）。dt/dd/table は元々属性を持つ
      // 行もあるが、念のためさらに属性を足しても崩れないことを確かめる
      const withAttrs = html
        .replace(/<tr>/g, '<tr class="zz-changed-name" data-yy="1">')
        .replace(/<td>/g, '<td data-yy="1">')
        .replace(/<dt class="u-floatL">/g, '<dt class="u-floatL" data-yy="1">')
        .replace(/<dd class="u-floatR">/g, '<dd class="u-floatR" data-yy="1">')
        .replace(/<table\b/, '<table data-yy="1"')
      expect(parseYahooSalesHtml(withAttrs)).toEqual(rows)
    })

    it('決済金額 − 販売手数料 = 受取額 が成り立つ行は amountsConsistent が true', () => {
      for (const r of rows) {
        expect(r.amountsConsistent).toBe(true)
      }
    })

    it('恒等式が成り立たない行（決済5,000－手数料250－送料750＝受取4,000）は amountsConsistent が false で、行自体は返り、未知の内訳（送料）は otherBreakdown にそのまま残る', () => {
      const brokenHtml = `
        <table id="salelst"><tbody>
          <tr><th>取扱内容</th><th>取扱日</th><th>状態</th><th>金額</th><th>詳細</th></tr>
          <tr>
            <td>ダミー商品<br>(z600000000)</td>
            <td>2026/9/1</td>
            <td><span>受取連絡待ち</span></td>
            <td>
              <span class="u-fontSize16 u-textBold suspend">4,000円</span>
              <dl><dt>決済金額：</dt><dd>5,000円</dd></dl>
              <dl><dt>販売手数料：</dt><dd>-250円</dd></dl>
              <dl><dt>送料：</dt><dd>-750円</dd></dl>
            </td>
            <td></td>
          </tr>
        </tbody></table>
      `
      const brokenRows = parseYahooSalesHtml(brokenHtml)
      expect(brokenRows).toHaveLength(1)
      const r = brokenRows[0]
      expect(r.yahooItemId).toBe('z600000000')
      expect(r.receivedAmount).toBe(4000)
      expect(r.settlementAmount).toBe(5000)
      expect(r.feeAmount).toBe(250)
      expect(r.amountsConsistent).toBe(false)
      expect(r.otherBreakdown).toEqual([{ label: '送料', amount: 750 }])
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
      expect(item?.yahooItemId).toBe('z100000008')
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
        'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/deadbeefcafebabe0123456789abcdef01234567/i-img900x1200-17905717326651snizd.jpg',
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

    it('商品ページ（yahoo-item.html）と取引中一覧（yahoo-sold.html）は実物2つの別々の取得だが、同じ商品（同じid・タイトル・価格）を指す（整合性の確認）', () => {
      const soldHtml = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
      const soldRows = parseYahooSoldHtml(soldHtml)
      const soldRow = soldRows.find(r => r.yahooItemId === item?.yahooItemId)
      expect(soldRow).toBeTruthy()
      expect(soldRow?.title).toBe(item?.title)
      expect(soldRow?.price).toBe(item?.price)
    })
  })

  describe('parseYahooSellingHtml（出品中。実機の出力そのままのfixture。<!-- --> を含む）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-selling.html'), 'utf-8')
    const rows = parseYahooSellingHtml(html)

    it('7件取れる', () => {
      expect(rows).toHaveLength(7)
    })

    it('id・出品日時・価格・いいね・閲覧が7件とも実物の数字と一致する', () => {
      expect(rows.map(r => ({
        yahooItemId: r.yahooItemId,
        listedAt: r.listedAt,
        price: r.price,
        likes: r.likes,
        views: r.views,
      }))).toEqual([
        { yahooItemId: 'z100000001', listedAt: '2026-09-28T22:24', price: 7500, likes: 0, views: 13 },
        { yahooItemId: 'z100000002', listedAt: '2026-09-28T14:33', price: 7999, likes: 0, views: 17 },
        { yahooItemId: 'z100000003', listedAt: '2026-09-28T13:34', price: 4800, likes: 1, views: 33 },
        { yahooItemId: 'z100000004', listedAt: '2026-09-28T09:55', price: 9100, likes: 6, views: 80 },
        { yahooItemId: 'z100000005', listedAt: '2026-09-28T08:53', price: 7350, likes: 5, views: 71 },
        { yahooItemId: 'z100000006', listedAt: '2026-09-28T08:51', price: 6900, likes: 0, views: 29 },
        { yahooItemId: 'z100000007', listedAt: '2026-09-28T07:27', price: 5750, likes: 7, views: 121 },
      ])
    })

    it('価格は integer で返る（HTML中は "7,500<!-- -->円" という形）', () => {
      for (const r of rows) {
        expect(Number.isInteger(r.price)).toBe(true)
      }
    })

    it('コメントを消してから数字を読むので、隣り合う数字がくっつかない（"出品数： <!-- -->7<!-- -->/<!-- -->100" が "710100" のような形にならず、7・100 と正しく読める）', () => {
      expect(html).toContain('出品数： <!-- -->7<!-- -->/<!-- -->100')
      expect(extractYahooSellingCounts(html)).toEqual({ listingCount: 7, listingLimit: 100, totalCount: 7 })
    })

    it('検索された数（srchcnt）が取れる。7件とも実物の値は0', () => {
      expect(rows.map(r => r.searchCount)).toEqual([0, 0, 0, 0, 0, 0, 0])
    })

    it('tradstat は7件とも NONE（出品中）', () => {
      expect(rows.every(r => r.tradstat === 'NONE')).toBe(true)
    })

    it('サムネイルURLを img[alt="商品画像"] から拾う', () => {
      expect(rows[0].thumbUrl).toBe(
        'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/deadbeefcafebabe0123456789abcdef01234567/i-img900x1200-1790601766052nqgzoq.jpg',
      )
    })

    it('出品日時：z100000001 が 2026-09-28 22:24（日本時間）になる', () => {
      expect(rows[0].yahooItemId).toBe('z100000001')
      expect(rows[0].listedAt).toBe('2026-09-28T22:24')
    })

    it('型番：7件のうち6件は CODE_RE で取れ、1件（z100000001。閉じ括弧が無い）は取れない', () => {
      const codes = rows.map(r => CODE_RE.exec(r.title)?.[1] ?? null)
      expect(codes).toEqual([null, 'A039', 'B001', 'A035', 'Z072-14', 'A037', 'A040'])
    })

    it('】が無い出品（z100000001。実物でもタイトルの型番の閉じ括弧が無いまま）は、【】厳密一致の CODE_RE では型番を取れない（自動確定①「型番が1つで在庫の model_code と完全一致」の対象にならず、候補止まりになるのが正しい挙動。直さない）', () => {
      expect(rows[0].yahooItemId).toBe('z100000001')
      expect(rows[0].title).toBe('ミニランド 未開封 1つ&のんびりシリーズセット メロジョイ 【A035')
      expect(rows[0].title).not.toContain('】')
      expect(CODE_RE.exec(rows[0].title)).toBeNull()
      // extractCodes は【】無し（CODE_LOOSE_RE）でも拾う候補表示用の関数なので、
      // 裸の "A035" は拾える。「候補止まり」になるのは CODE_RE 側（自動確定の判定）の話であって、
      // 候補としてすら出せなくなるわけではない
      expect(extractCodes(rows[0].title)).toEqual(['A035'])
    })

    it('opentime が壊れている（空・文字・巨大な値・負数・小数）と listedAt は null で、NaN を含む文字列にならない（行自体は返る）', () => {
      for (const broken of ['', 'abc', '9999999999999999', '-1234567890', '1790601874.5']) {
        const brokenHtml = html.replace('opentime:1790601874', `opentime:${broken}`)
        const brokenRows = parseYahooSellingHtml(brokenHtml)
        const row = brokenRows.find(r => r.yahooItemId === 'z100000001')
        expect(row).toBeTruthy()
        expect(row?.listedAt).toBeNull()
      }
    })

    it('壊れた HTML（空・タグだけ・data-cl-params 無し）は throw せず空配列', () => {
      expect(parseYahooSellingHtml('')).toEqual([])
      expect(parseYahooSellingHtml('<div><span></span></div>')).toEqual([])
      expect(parseYahooSellingHtml('<a href="/item/z1">x</a>')).toEqual([])
    })

    it('クラス名（sc-）を全置換しても同じ結果になる（クラス名に依存していないことの証明）', () => {
      expect(parseYahooSellingHtml(replaceAllClasses(html))).toEqual(rows)
    })
  })

  describe('extractYahooSellingCounts（出品中一覧の出品数・総件数）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'yahoo-selling.html'), 'utf-8')

    it('出品数（7/100）と総件数（1~7件/7件 → 7）が取れる', () => {
      expect(extractYahooSellingCounts(html)).toEqual({
        listingCount: 7,
        listingLimit: 100,
        totalCount: 7,
      })
    })

    it('見つからなければ null', () => {
      expect(extractYahooSellingCounts('該当の記載なし')).toEqual({
        listingCount: null,
        listingLimit: null,
        totalCount: null,
      })
    })
  })

  describe('combineYahooSales（②取引中・取引完了 と ③売上金管理 の結合。実行部の心臓）', () => {
    const soldHtml = readFileSync(join(__dirname, 'fixtures', 'yahoo-sold.html'), 'utf-8')
    const salesHtml = readFileSync(join(__dirname, 'fixtures', 'yahoo-salesmanagement.html'), 'utf-8')
    const soldRows = parseYahooSoldHtml(soldHtml)
    const salesRows = parseYahooSalesHtml(salesHtml)

    function makeSoldRow(overrides: Partial<YahooScrapedSale> = {}): YahooScrapedSale {
      return {
        yahooItemId: 'z600000001',
        title: 'ダミー商品タイトル全文【Z001】',
        price: 1000,
        tradstat: 'SELLER_SHIPPED',
        statusText: '受け取り評価待ち',
        thumbUrl: 'https://example.com/thumb.jpg',
        ...overrides,
      }
    }

    function makeSalesRow(overrides: Partial<YahooSalesRow> = {}): YahooSalesRow {
      return {
        yahooItemId: 'z600000001',
        itemName: 'ダミー商品タイトル全文',
        handledDate: '2026-09-01',
        statusText: '受取連絡待ち',
        receivedAmount: 1000,
        settlementAmount: 1000,
        feeAmount: 0,
        settleId: '12345',
        otherBreakdown: [],
        amountsConsistent: true,
        ...overrides,
      }
    }

    it('実物2件（yahoo-sold.html・yahoo-salesmanagement.html）を商品idで結合すると、4件とも②の全文タイトル・③の日付と実額・②のtradstatから判定したstatusになる（titleTruncatedはすべてfalse＝②の全文がある）。まだ売上金管理に出ていない2件（WAIT_FOR_SELLER_SHIP）は結合結果に出てこない', () => {
      const { sales, inconsistent } = combineYahooSales(soldRows, salesRows)
      expect(inconsistent).toEqual([])
      expect(sales).toHaveLength(4)
      expect(sales).toEqual([
        {
          yahooItemId: 'z100000010',
          title: 'メロジョイ ふわふわ肉球ミルクパフ ねっとりヨーグルト【Z074-4】',
          titleTruncated: false,
          price: 5200,
          fee: 0,
          soldAt: '2026-09-28',
          status: 'shipped',
          thumbUrl: soldRows[2].thumbUrl,
        },
        {
          yahooItemId: 'z100000011',
          title: 'Mellojoy メロジョイ 贅沢スフレ チョコレート Mサイズ 新品未開封【Z072-7】',
          titleTruncated: false,
          price: 6400,
          fee: 320,
          soldAt: '2026-09-28',
          status: 'shipped',
          thumbUrl: soldRows[3].thumbUrl,
        },
        {
          yahooItemId: 'z100000012',
          title: 'Mellojoy メロジョイ いちごショートケーキ ホール スクイーズ 新品未開封',
          titleTruncated: false,
          price: 5899,
          fee: 294,
          soldAt: '2026-09-28',
          status: 'shipped',
          thumbUrl: soldRows[4].thumbUrl,
        },
        {
          yahooItemId: 'z100000013',
          title: 'Mellojoy メロジョイ クッキークラブ クリームブロッサム もちもちもち',
          titleTruncated: false,
          price: 4280,
          fee: 213,
          soldAt: '2026-09-27',
          status: 'shipped',
          thumbUrl: soldRows[5].thumbUrl,
        },
      ])
    })

    it('売上金管理（③）にだけある行は作る：日付・実額があるので、タイトルは③の商品名（途中で切れている）で代え、titleTruncatedはtrue、statusはnull（②が無いので推測しない）', () => {
      const sales = [makeSoldRow()] // ②はダミー1件だけ（結合先を確保するためのノイズ）
      const salesOnly = [
        makeSalesRow(),
        makeSalesRow({ yahooItemId: 'z900000001', itemName: '売上金管理にしか無い商品名【Z9', handledDate: '2026-09-15', settlementAmount: 3000, feeAmount: 150, receivedAmount: 2850 }),
      ]
      const { sales: combined } = combineYahooSales(sales, salesOnly)
      expect(combined).toHaveLength(2)
      const onlyInSales = combined.find(c => c.yahooItemId === 'z900000001')
      expect(onlyInSales).toEqual({
        yahooItemId: 'z900000001',
        title: '売上金管理にしか無い商品名【Z9', // 途中で切れたままでよい（型番の救済はしない）
        titleTruncated: true,
        price: 3000,
        fee: 150,
        soldAt: '2026-09-15',
        status: null,
        thumbUrl: null,
      })
    })

    it('取引ページ（②）にだけある行は作らない：日付が無いので次回に持ち越す（結合結果に出てこない）', () => {
      const soldOnly = [
        makeSoldRow(),
        makeSoldRow({ yahooItemId: 'z700000001', title: '取引ページにしか無い商品' }),
      ]
      const salesOnly = [makeSalesRow()] // z600000001 だけが③にある
      const { sales } = combineYahooSales(soldOnly, salesOnly)
      expect(sales).toHaveLength(1)
      expect(sales.map(s => s.yahooItemId)).toEqual(['z600000001'])
      expect(sales.some(s => s.yahooItemId === 'z700000001')).toBe(false)
    })

    it('amountsConsistent が false の行は販売にしない。inconsistent に商品id・タイトル・金額の内訳がそのまま残る（受取連絡後に送料の行が増えて式が崩れたケースを想定）', () => {
      const soldOk = [makeSoldRow(), makeSoldRow({ yahooItemId: 'z600000002' })]
      const salesMixed = [
        makeSalesRow(),
        makeSalesRow({
          yahooItemId: 'z600000002', itemName: 'ダミー商品タイトル全文（送料あり）', amountsConsistent: false,
          settlementAmount: 5000, feeAmount: 250, receivedAmount: 4000, // 送料750円ぶん合わない
          otherBreakdown: [{ label: '送料', amount: 750 }],
        }),
      ]
      const { sales, inconsistent } = combineYahooSales(soldOk, salesMixed)
      expect(inconsistent).toEqual([
        {
          yahooItemId: 'z600000002',
          itemName: 'ダミー商品タイトル全文（送料あり）',
          settlementAmount: 5000,
          feeAmount: 250,
          receivedAmount: 4000,
          otherBreakdown: [{ label: '送料', amount: 750 }],
        },
      ])
      expect(sales).toHaveLength(1)
      expect(sales[0].yahooItemId).toBe('z600000001')
    })

    it('②のtradstatが未知の値なら status は null（mapYahooTradstatの規則どおり、推測で埋めない）', () => {
      const sold = [makeSoldRow({ tradstat: 'SOME_UNKNOWN_STATUS' })]
      const sales = [makeSalesRow()]
      const { sales: combined } = combineYahooSales(sold, sales)
      expect(combined[0].status).toBeNull()
    })
  })

  describe('splitYahooCombinedSales（既に帳簿にある販売を updateYahooActuals に渡す配線。collect() の心臓の続き）', () => {
    function makeCombined(overrides: Partial<YahooCombinedSale> = {}): YahooCombinedSale {
      return {
        yahooItemId: 'z600000001',
        title: 'ダミー商品タイトル全文【Z001】',
        titleTruncated: false,
        price: 1000,
        fee: 50,
        soldAt: '2026-09-01',
        status: 'shipped',
        thumbUrl: 'https://example.com/thumb.jpg',
        ...overrides,
      }
    }

    it('新規（knownIdsに無い）は freshMatched、既知（knownIdsにある）は knownMatched に分かれ、混ざらない', () => {
      const fresh = makeCombined({ yahooItemId: 'z600000001' })
      const known = makeCombined({ yahooItemId: 'z600000002' })
      const result = splitYahooCombinedSales(
        [fresh, known], new Set(['z600000002']), new Set(), [],
      )
      expect(result.freshMatched).toEqual([fresh])
      expect(result.knownMatched).toEqual([known])
      // 取り違えがないこと（同じ商品が両方に入らない）
      expect(result.freshMatched.map(c => c.yahooItemId))
        .not.toEqual(expect.arrayContaining(result.knownMatched.map(c => c.yahooItemId)))
    })

    it('knownMatched から updateYahooActuals へ渡す行は mercariItemId/soldAt/fee/price/status/title の形になる（collect()と同じマッピング）', () => {
      const known = makeCombined({
        yahooItemId: 'z600000002', soldAt: '2026-09-15', fee: 320, price: 6400, status: 'completed',
        title: '全文タイトル【Z072】', titleTruncated: false,
      })
      const { knownMatched } = splitYahooCombinedSales(
        [known], new Set(['z600000002']), new Set(), [],
      )
      const rows = knownMatched.map(c => ({
        mercariItemId: c.yahooItemId, soldAt: c.soldAt, fee: c.fee, price: c.price, status: c.status,
        title: c.titleTruncated ? undefined : c.title,
      }))
      expect(rows).toEqual([
        {
          mercariItemId: 'z600000002', soldAt: '2026-09-15', fee: 320, price: 6400, status: 'completed',
          title: '全文タイトル【Z072】',
        },
      ])
    })

    it('titleTruncated=true（③の切れた商品名しか無い）の行は、collect()と同じマッピングで title が undefined になる（切れたタイトルで上書きしない）', () => {
      const knownTruncated = makeCombined({
        yahooItemId: 'z600000003', title: '切れたタイトル…新品未開封【Z0', titleTruncated: true,
      })
      const { knownMatched } = splitYahooCombinedSales(
        [knownTruncated], new Set(['z600000003']), new Set(), [],
      )
      const rows = knownMatched.map(c => ({
        mercariItemId: c.yahooItemId, title: c.titleTruncated ? undefined : c.title,
      }))
      expect(rows).toEqual([{ mercariItemId: 'z600000003', title: undefined }])
    })

    it('status が null（②取引ページにまだ出ていない）の行は null のまま渡る（勝手に completed 等で埋めない）', () => {
      const known = makeCombined({ yahooItemId: 'z600000002', status: null })
      const { knownMatched } = splitYahooCombinedSales(
        [known], new Set(['z600000002']), new Set(), [],
      )
      expect(knownMatched[0].status).toBeNull()
    })

    it('キーワードを設定していても、既知は不一致のタイトルでも knownMatched に残る（キーワードは「取り込むか」を決めるだけで「もう帳簿にあるものを更新するか」ではない。後からキーワードを絞っても既知の更新が止まらないことの確認）', () => {
      const knownMatch = makeCombined({ yahooItemId: 'z600000002', title: 'メロジョイ 贅沢スフレ【Z072】' })
      const knownUnmatch = makeCombined({ yahooItemId: 'z600000003', title: '全く関係ない商品' })
      const result = splitYahooCombinedSales(
        [knownMatch, knownUnmatch],
        new Set(['z600000002', 'z600000003']),
        new Set(),
        ['メロジョイ'],
      )
      expect(result.knownMatched.map(c => c.yahooItemId)).toEqual(['z600000002', 'z600000003'])
    })

    it('新規はキーワード不一致なら freshMatched から弾かれる（今までどおり。既知とは違う扱い）', () => {
      const freshMatch = makeCombined({ yahooItemId: 'z600000010', title: 'メロジョイ 贅沢スフレ【Z072】' })
      const freshUnmatch = makeCombined({ yahooItemId: 'z600000011', title: '全く関係ない商品' })
      const result = splitYahooCombinedSales(
        [freshMatch, freshUnmatch], new Set(), new Set(), ['メロジョイ'],
      )
      expect(result.freshMatched.map(c => c.yahooItemId)).toEqual(['z600000010'])
      expect(result.excludedByKeyword).toBe(1)
    })

    it('新規でタイトルが途中で切れている行（titleTruncated=true）は、キーワードに関わらず freshMatched に含まれ、idが truncatedTitleIds に残る', () => {
      const truncatedUnmatch = makeCombined({
        yahooItemId: 'z600000020', title: '切れたタイトル…新品未開封【Z0', titleTruncated: true,
      })
      const judgeableMatch = makeCombined({
        yahooItemId: 'z600000021', title: 'メロジョイ 全文タイトル【Z072】', titleTruncated: false,
      })
      const result = splitYahooCombinedSales(
        [truncatedUnmatch, judgeableMatch], new Set(), new Set(), ['メロジョイ'],
      )
      expect(result.freshMatched.map(c => c.yahooItemId).sort()).toEqual(['z600000020', 'z600000021'])
      expect(result.truncatedTitleIds).toEqual(['z600000020'])
      expect(result.excludedByKeyword).toBe(0)
    })

    it('タイトルが途中で切れていても判定できるもの（titleTruncated=false）はキーワードで普通に弾かれる。truncatedTitleIds には出ない', () => {
      const judgeableUnmatch = makeCombined({
        yahooItemId: 'z600000030', title: '全く関係ない商品', titleTruncated: false,
      })
      const result = splitYahooCombinedSales(
        [judgeableUnmatch], new Set(), new Set(), ['メロジョイ'],
      )
      expect(result.freshMatched).toEqual([])
      expect(result.excludedByKeyword).toBe(1)
      expect(result.truncatedTitleIds).toEqual([])
    })

    it('削除済み（sale_exclusion）は新規側だけ弾く。既知の判定には関係しない', () => {
      const freshDeleted = makeCombined({ yahooItemId: 'z600000001' })
      const known = makeCombined({ yahooItemId: 'z600000002' })
      const result = splitYahooCombinedSales(
        [freshDeleted, known],
        new Set(['z600000002']),
        new Set(['z600000001']),
        [],
      )
      expect(result.freshMatched).toEqual([])
      expect(result.excludedDeleted).toBe(1)
      expect(result.knownMatched).toEqual([known])
    })

    it('amountsConsistent=false の行は combineYahooSales の時点で既に除かれているので、既知でも更新に渡らない', () => {
      const soldRow: YahooScrapedSale = {
        yahooItemId: 'z600000002',
        title: 'ダミー商品',
        price: 1000,
        tradstat: 'SELLER_SHIPPED',
        statusText: '受け取り評価待ち',
        thumbUrl: null,
      }
      const inconsistentSalesRow: YahooSalesRow = {
        yahooItemId: 'z600000002',
        itemName: 'ダミー商品',
        handledDate: '2026-09-01',
        statusText: '受取連絡待ち',
        receivedAmount: 4000, // 決済金額－手数料と合わない（送料の行が増えたケースを想定）
        settlementAmount: 5000,
        feeAmount: 250,
        settleId: null,
        otherBreakdown: [{ label: '送料', amount: 750 }],
        amountsConsistent: false,
      }
      const { sales: combined, inconsistent } = combineYahooSales([soldRow], [inconsistentSalesRow])
      expect(inconsistent).toHaveLength(1)
      expect(combined).toHaveLength(0)

      // z600000002 は帳簿に既にある（known）としても、combined に入っていない以上 knownMatched にも出ない
      const result = splitYahooCombinedSales(combined, new Set(['z600000002']), new Set(), [])
      expect(result.knownMatched).toEqual([])
      expect(result.freshMatched).toEqual([])
    })
  })

  describe('キーワードでの絞り込み（collect() が db.matchesAnyKeyword で行うのと同じ規則）', () => {
    it('yahoo_keyword が空なら全部通る', () => {
      const keywords = parseKeywords('')
      expect(keywords).toEqual([])
      const titles = ['メロジョイ ふわふわ肉球ミルクパフ', '無関係な商品']
      const matched = keywords.length > 0 ? titles.filter(t => matchesAnyKeyword(t, keywords)) : titles
      expect(matched).toEqual(titles)
    })

    it('yahoo_keyword が設定されていれば、一致するタイトルだけが残る（大小無視）', () => {
      const keywords = parseKeywords('メロジョイ, mellojoy')
      const titles = [
        'メロジョイ ふわふわ肉球ミルクパフ【Z074-4】',
        'Mellojoy メロジョイ 贅沢スフレ【Z072-7】',
        '全く関係ない商品',
      ]
      const matched = titles.filter(t => matchesAnyKeyword(t, keywords))
      expect(matched).toEqual([
        'メロジョイ ふわふわ肉球ミルクパフ【Z074-4】',
        'Mellojoy メロジョイ 贅沢スフレ【Z072-7】',
      ])
    })
  })

  describe('isYahooCollectEmpty（3ページとも0件のときだけ empty）', () => {
    it('3ページとも0件なら true', () => {
      expect(isYahooCollectEmpty(0, 0, 0)).toBe(true)
    })

    it('出品だけ1件以上なら false（出品を売り切ると出品0件はあり得るが、この逆は false のまま）', () => {
      expect(isYahooCollectEmpty(1, 0, 0)).toBe(false)
    })

    it('取引中・取引完了だけ1件以上なら false', () => {
      expect(isYahooCollectEmpty(0, 1, 0)).toBe(false)
    })

    it('売上金管理だけ1件以上なら false（出品を売り切った直後はこれだけになり得る）', () => {
      expect(isYahooCollectEmpty(0, 0, 1)).toBe(false)
    })

    it('全部1件以上なら false', () => {
      expect(isYahooCollectEmpty(2, 3, 4)).toBe(false)
    })
  })

  describe('zeroYahooPageNames（1ページだけ0件でも、okで握りつぶさず分かる形にする）', () => {
    it('出品中だけ0件なら「出品中」だけ返る（他2ページは1件以上ある）', () => {
      expect(zeroYahooPageNames(0, 5, 3)).toEqual(['出品中'])
    })

    it('取引中・取引完了だけ0件なら「取引中・取引完了」だけ返る', () => {
      expect(zeroYahooPageNames(8, 0, 3)).toEqual(['取引中・取引完了'])
    })

    it('売上金管理だけ0件なら「売上金管理」だけ返る', () => {
      expect(zeroYahooPageNames(8, 5, 0)).toEqual(['売上金管理'])
    })

    it('2ページが0件なら両方返る', () => {
      expect(zeroYahooPageNames(0, 0, 3)).toEqual(['出品中', '取引中・取引完了'])
    })

    it('3ページとも0件なら3つとも返る（isYahooCollectEmptyがtrueになるケース。呼び出し側はこちらを使わずemptyにする）', () => {
      expect(zeroYahooPageNames(0, 0, 0)).toEqual(['出品中', '取引中・取引完了', '売上金管理'])
    })

    it('全部1件以上なら空配列', () => {
      expect(zeroYahooPageNames(8, 5, 3)).toEqual([])
    })
  })

  describe('formatYahooTruncatedTitleNote（タイトルが途中で切れていて判定できなかった件数とidの記録）', () => {
    it('0件なら空文字', () => {
      expect(formatYahooTruncatedTitleNote([])).toBe('')
    })

    it('id が少ないときは全部並ぶ', () => {
      expect(formatYahooTruncatedTitleNote(['z1', 'z2'])).toBe(
        'タイトルが途中で切れていて判定できなかった 2 件（z1・z2）',
      )
    })

    it('id が多いときはメッセージが壊れない：先頭5件＋残り件数で示す', () => {
      const ids = Array.from({ length: 12 }, (_, i) => `z${i}`)
      const note = formatYahooTruncatedTitleNote(ids)
      expect(note).toBe('タイトルが途中で切れていて判定できなかった 12 件（z0・z1・z2・z3・z4、他7件）')
    })
  })

  describe('formatYahooRenderTimeoutNote（描画待ちが上限に達したページの記録。静かに0件で成功にしないための文言）', () => {
    it('0件なら空文字', () => {
      expect(formatYahooRenderTimeoutNote([])).toBe('')
    })

    it('1ページなら名前がそのまま出る', () => {
      expect(formatYahooRenderTimeoutNote(['出品中'])).toBe(
        '描画待ちが上限に達しました（読み取れていない可能性があります）：出品中',
      )
    })

    it('2ページとも上限に達したときは両方出る', () => {
      expect(formatYahooRenderTimeoutNote(['出品中', '取引中・取引完了'])).toBe(
        '描画待ちが上限に達しました（読み取れていない可能性があります）：出品中・取引中・取引完了',
      )
    })
  })

  describe('formatYahooInconsistentNote（恒等式が崩れた行の商品id・内訳の記録）', () => {
    function makeInconsistent(overrides: Partial<{
      yahooItemId: string; itemName: string; settlementAmount: number; feeAmount: number
      receivedAmount: number; otherBreakdown: Array<{ label: string; amount: number | null }>
    }> = {}) {
      return {
        yahooItemId: 'z600000002',
        itemName: 'ダミー商品',
        settlementAmount: 5000,
        feeAmount: 250,
        receivedAmount: 4000,
        otherBreakdown: [{ label: '送料', amount: 750 }],
        ...overrides,
      }
    }

    it('0件なら空文字', () => {
      expect(formatYahooInconsistentNote([])).toBe('')
    })

    it('商品idと金額の内訳がメッセージに出る', () => {
      const note = formatYahooInconsistentNote([makeInconsistent()])
      expect(note).toBe('確認が要る 1 件（内訳の式が合いません）：z600000002（決済5000－手数料250≠受取4000）')
    })

    it('件数が多いときはメッセージが壊れない：先頭3件の内訳＋残り件数で示す', () => {
      const rows = Array.from({ length: 5 }, (_, i) => makeInconsistent({ yahooItemId: `z${i}` }))
      const note = formatYahooInconsistentNote(rows)
      expect(note).toBe(
        '確認が要る 5 件（内訳の式が合いません）：'
        + 'z0（決済5000－手数料250≠受取4000）、'
        + 'z1（決済5000－手数料250≠受取4000）、'
        + 'z2（決済5000－手数料250≠受取4000）、他2件',
      )
    })
  })
})
