import type { SaleStatus } from '../shared/types'

// ============================================================
// Yahoo!フリマの取り込み（パーサのみ）
//
// 第1歩：純粋関数のパーサだけをここに置く。実行部（BrowserWindow・session・
// ネットワーク・DB）は次の回で別の担当が書く。ここでは一切触らない。
//
// 約束（src/main/collector.ts のメルカリ向けパーサと同じ）：
//   * クラス名（styled-components の自動生成。デプロイのたびに変わる）に依存しない。
//     起点は a[href] と data-cl-params、画像は img[alt="商品画像"]、価格は正規表現
//   * 取得できなかったら空配列を返す。0件を「成功」として握りつぶす判断は呼び出し側の仕事
//   * 未知の値・未観測の値は推測で埋めず null を返す
// ============================================================

/** 「取引中・取引完了」（`/my/item/sold`）の1件（parseYahooSoldHtml の要素） */
export interface YahooScrapedSale {
  yahooItemId: string
  title: string
  price: number
  /** data-cl-params の tradstat の生の値（例 'SELLER_SHIPPED'） */
  tradstat: string
  /** 状態の日本語表示（「受け取り評価待ち」等） */
  statusText: string
  /** 商品サムネイルのURL。取れなければ null */
  thumbUrl: string | null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim()
}

/** '5,200円' '¥5,200' のどちらの表記でも整数を抜く。読めなければ null */
function parseYenAmount(text: string): number | null {
  const m = /¥\s*([\d,]+)|([\d,]+)\s*円/.exec(text)
  if (!m) return null
  const digits = (m[1] ?? m[2]).replace(/,/g, '')
  return digits ? parseInt(digits, 10) : null
}

/** `data-cl-params`（`key:value;key:value;...`）から1つのキーの値を抜く。無ければ null */
function readClParam(params: string, key: string): string | null {
  const m = new RegExp(`${key}:([^;]*)`).exec(params)
  return m ? m[1] : null
}

/**
 * 「取引中・取引完了」（`https://paypayfleamarket.yahoo.co.jp/my/item/sold`）の
 * HTML から行を抜く（jsdom なしの簡易パース）。
 *
 * ⚠ セレクタは実DOM（fixtures/yahoo-sold.html。利用者の実物から抜粋）に基づくが、
 *   クラス名（styled-components）はデプロイごとに変わるため使っていない。
 *   商品リンクは `data-cl-params` に `rcconid` を持つ `<a>` を起点にする。商品 id は
 *   その `rcconid`（無ければ href の `/item/<id>/trade/seller`）、タイトルは最初の
 *   `<p>`、価格はタイトルより後ろの「n,nnn円」、状態の日本語表示はその後の `<span>`、
 *   サムネイルは `img[alt="商品画像"]` の `src` から拾う。
 */
export function parseYahooSoldHtml(html: string): YahooScrapedSale[] {
  const rows: YahooScrapedSale[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let am: RegExpExecArray | null
  while ((am = anchorRe.exec(html))) {
    const attrs = am[1]
    const content = am[2]

    const paramsMatch = /data-cl-params="([^"]*)"/.exec(attrs)
    const params = paramsMatch ? paramsMatch[1] : null
    if (!params || !params.includes('rcconid:')) continue

    const hrefMatch = /href="([^"]*)"/.exec(attrs)
    const hrefIdMatch = hrefMatch ? /\/item\/([a-z]\d{8,})\/trade\/seller/.exec(hrefMatch[1]) : null
    const yahooItemId = readClParam(params, 'rcconid') || hrefIdMatch?.[1] || null
    if (!yahooItemId) continue

    const titleMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(content)
    const title = titleMatch ? stripTags(titleMatch[1]) : ''
    if (!title) continue

    const afterTitle = content.slice(titleMatch!.index + titleMatch![0].length)
    const price = parseYenAmount(afterTitle)
    if (price === null) continue

    const tradstat = readClParam(params, 'tradstat') ?? ''

    // 状態の日本語表示（「受け取り評価待ち」等）はタイトル・価格より後ろの最後の <span>
    let statusText = ''
    const spanRe = /<span\b[^>]*>([\s\S]*?)<\/span>/g
    let sm: RegExpExecArray | null
    while ((sm = spanRe.exec(afterTitle))) statusText = stripTags(sm[1])

    // サムネイルは img[alt="商品画像"] の src（属性の並び順には依存しない）
    let thumbUrl: string | null = null
    const imgRe = /<img\b([^>]*)>/g
    let im: RegExpExecArray | null
    while ((im = imgRe.exec(content))) {
      if (/\balt="商品画像"/.test(im[1])) {
        const srcMatch = /\bsrc="([^"]*)"/.exec(im[1])
        thumbUrl = srcMatch ? srcMatch[1] : null
        break
      }
    }

    rows.push({ yahooItemId, title, price, tradstat, statusText, thumbUrl })
  }
  return rows
}

/**
 * `data-cl-params` の `tradstat` の値から SaleStatus を判定する。実物で観測した順：
 *   NONE（出品中。まだ売れていない）                         → null（該当する SaleStatus が無い）
 *   WAIT_FOR_SELLER_SHIP（売れて未発送。発送はこちらの番）    → waiting_shipment
 *   SELLER_SHIPPED（発送済み・受け取り評価待ち）              → shipped
 * 「取引完了」の実際の tradstat 文字列は未観測。未知の値は推測で埋めず null を返す。
 */
export function mapYahooTradstat(t: string): SaleStatus | null {
  if (t === 'NONE') return null
  if (t === 'WAIT_FOR_SELLER_SHIP') return 'waiting_shipment'
  if (t === 'SELLER_SHIPPED') return 'shipped'
  return null
}

/** 「1~4件/4件」のような表示から総件数（末尾の件数）を抜く。読めなければ null */
export function extractYahooSoldTotal(html: string): number | null {
  const m = /\d+\s*~\s*\d+\s*件\s*\/\s*([\d,]+)\s*件/.exec(html)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null
}

// ============================================================
// ② 売上金管理（https://salesmanagement.yahoo.co.jp/list）
//
// 帳簿の要。販売の日付と手数料の実額はここでしか取れない。古典的なサーバ描画で
// クラス名も一応安定しているが、ここでも「ラベルの文字」（決済金額：／販売手数料：）
// で引く。取扱内容の商品名は途中で切れているため型番はここから取らない。
// ============================================================

/** 「売上金管理」一覧（`#salelst`）の1行 */
export interface YahooSalesRow {
  yahooItemId: string
  /** 取扱日（YYYY-MM-DD、正規化済み） */
  handledDate: string
  /** 状態の日本語表示（「受取連絡待ち」等） */
  statusText: string
  /** 受取額（金額欄の先頭の太字） */
  receivedAmount: number
  /** 決済金額（内訳の「決済金額：」） */
  settlementAmount: number
  /** 販売手数料。内訳の「販売手数料：」は負符号付き（-320円）で出るので正の整数に直す。0円もある */
  feeAmount: number
  /** 詳細リンクの _settle_id。取れなければ null */
  settleId: string | null
  /**
   * 内訳のうち「決済金額」「販売手数料」以外のラベル（例：送料）。まだ観測できていないため
   * 中身は未知。推測で送料として扱わず、ラベルと金額をそのまま残す（将来行が増えたときに気づける形）
   */
  otherBreakdown: Array<{ label: string; amount: number | null }>
}

/** 'YYYY/M/D' → 'YYYY-MM-DD'。読めなければ null */
function normalizeYahooDate(text: string): string | null {
  const m = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(text)
  if (!m) return null
  const [, y, mo, d] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/** '-320円' '5,200円' のどちらでも「絶対値」の整数を返す（内訳の金額は負符号で出る） */
function parseYenMagnitude(text: string): number | null {
  return parseYenAmount(text.replace(/^-/, ''))
}

/** `<dt>ラベル：</dt><dd>値</dd>` のペアをすべて抜く（属性・改行の有無は問わない） */
function extractDtDdPairs(html: string): Array<{ label: string; valueText: string }> {
  const pairs: Array<{ label: string; valueText: string }> = []
  const dlRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/g
  let m: RegExpExecArray | null
  while ((m = dlRe.exec(html))) {
    pairs.push({ label: stripTags(m[1]), valueText: stripTags(m[2]) })
  }
  return pairs
}

/**
 * 「売上金管理」一覧（`id="salelst"` の表）から行を抜く。
 *
 * 表の起点は `id="salelst"`（クラス名ではなく id）。行は `<tr>` のうち `<td>` を持つもの
 * （見出し行は `<th>` のみ）。商品 id は取扱内容セルの `(z693579992)`、取扱日はその次のセル、
 * 状態はその次、受取額は金額セルの中で最初に現れる「n,nnn円」（内訳より前に出る）。
 * 決済金額・販売手数料は内訳の `<dt>ラベル：</dt><dd>金額</dd>` をラベルの文字で引く。
 */
export function parseYahooSalesHtml(html: string): YahooSalesRow[] {
  const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/g
  let tableHtml: string | null = null
  let tm: RegExpExecArray | null
  while ((tm = tableRe.exec(html))) {
    if (/\bid="salelst"/.test(tm[1])) { tableHtml = tm[2]; break }
  }
  if (!tableHtml) return []

  const rows: YahooSalesRow[] = []
  const trRe = /<tr>([\s\S]*?)<\/tr>/g
  let trMatch: RegExpExecArray | null
  while ((trMatch = trRe.exec(tableHtml))) {
    const rowHtml = trMatch[1]
    if (!/<td\b/.test(rowHtml)) continue // 見出し行（<th> のみ）はスキップ

    const tdHtmls: string[] = []
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g
    let tdm: RegExpExecArray | null
    while ((tdm = tdRe.exec(rowHtml))) tdHtmls.push(tdm[1])
    if (tdHtmls.length < 4) continue

    const [infoHtml, dateHtml, statusHtml, amountHtml, detailHtml] = tdHtmls

    const idMatch = /\(([a-z]\d{8,})\)/.exec(stripTags(infoHtml))
    const yahooItemId = idMatch ? idMatch[1] : null
    if (!yahooItemId) continue

    const handledDate = normalizeYahooDate(stripTags(dateHtml))
    if (!handledDate) continue

    const statusText = stripTags(statusHtml)

    const receivedAmount = parseYenAmount(stripTags(amountHtml))
    if (receivedAmount === null) continue

    let settlementAmount: number | null = null
    let feeAmount: number | null = null
    const otherBreakdown: Array<{ label: string; amount: number | null }> = []
    for (const { label, valueText } of extractDtDdPairs(amountHtml)) {
      const amount = parseYenMagnitude(valueText)
      if (label === '決済金額：') settlementAmount = amount
      else if (label === '販売手数料：') feeAmount = amount
      else otherBreakdown.push({ label: label.replace(/：$/, ''), amount })
    }
    if (settlementAmount === null || feeAmount === null) continue

    const settleIdMatch = detailHtml ? /_settle_id=(\d+)/.exec(detailHtml) : null
    const settleId = settleIdMatch ? settleIdMatch[1] : null

    rows.push({
      yahooItemId, handledDate, statusText, receivedAmount,
      settlementAmount, feeAmount, settleId, otherBreakdown,
    })
  }
  return rows
}

/** CSV ダウンロードに要るもの（`extractYahooSalesCsvForm` の返り値） */
export interface YahooSalesCsvForm {
  /** 送信先（POST）。例 https://salesmanagement.yahoo.co.jp/salesmanagelist_csv */
  action: string
  /** 隠しフィールド `i`（月。空文字なら直近3カ月）の現在値 */
  month: string
  /**
   * 隠しフィールド `.crumb`（CSRF トークン。セッションに紐づく秘密）の値。
   * ⚠ ログに出す・保存する・テストに実物を書く、のどれもしないこと
   */
  crumb: string | null
  /** 月の選択肢（`i` の value と表示ラベル）。例 { value: '202609', label: '2026年9月' } */
  monthOptions: Array<{ value: string; label: string }>
}

/**
 * CSV ダウンロードのフォーム（`name="csvdownload"`）から送信先と `.crumb` を、
 * 月指定の `<select name="i">` から選択肢を抜く。フォームが見つからなければ null。
 */
export function extractYahooSalesCsvForm(html: string): YahooSalesCsvForm | null {
  const formMatch = /<form\b[^>]*name="csvdownload"[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/.exec(html)
  if (!formMatch) return null
  const action = formMatch[1]
  const formContent = formMatch[2]

  const iMatch = /<input\b[^>]*name="i"[^>]*value="([^"]*)"/.exec(formContent)
  const crumbMatch = /<input\b[^>]*name="\.crumb"[^>]*value="([^"]*)"/.exec(formContent)

  const selectMatch = /<select\b[^>]*name="i"[^>]*>([\s\S]*?)<\/select>/.exec(html)
  const monthOptions: Array<{ value: string; label: string }> = []
  if (selectMatch) {
    const optRe = /<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g
    let om: RegExpExecArray | null
    while ((om = optRe.exec(selectMatch[1]))) {
      monthOptions.push({ value: om[1], label: stripTags(om[2]) })
    }
  }

  return {
    action,
    month: iMatch ? iMatch[1] : '',
    crumb: crumbMatch ? crumbMatch[1] : null,
    monthOptions,
  }
}

// ============================================================
// ③ 商品ページ（https://paypayfleamarket.yahoo.co.jp/item/<id>）
//
// ⚠ pageData の starttime は 12 時間ずれる（実物で確認済み）。出品日時・公開日時は
//   必ず「出品日時：」「公開日時：」の見える文字から読む。starttime には触らない
// ============================================================

/** 商品ページの1件（parseYahooItemHtml の返り値） */
export interface YahooScrapedItem {
  yahooItemId: string
  title: string
  price: number
  /** 出品日時（「出品日時：」の見える文字。JST のローカル日時 'YYYY-MM-DDTHH:mm'）。読めなければ null */
  listedAt: string | null
  /** 公開日時（同上） */
  publishedAt: string | null
  shippingMethod: string | null
  condition: string | null
  shippingDays: string | null
  shippingArea: string | null
  likes: number | null
  views: number | null
  /** img[alt] がタイトルと一致するものの src。取れなければ null */
  thumbUrl: string | null
}

/** `<th>…<span>ラベル</span>…</th><td>値</td>` の値をラベルの文字で引く。読めなければ null */
function readLabeledValue(html: string, label: string): string | null {
  const re = new RegExp(`<th\\b[^>]*>[\\s\\S]*?<span\\b[^>]*>${label}<\\/span>[\\s\\S]*?<\\/th>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`)
  const m = re.exec(html)
  return m ? stripTags(m[1]) : null
}

/** 「出品日時：2026年9月27日 22:15」のような見える文字から 'YYYY-MM-DDTHH:mm' を作る */
function readDateTimeLabel(html: string, label: string): string | null {
  const re = new RegExp(`${label}：\\s*(\\d{4})年(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})`)
  const m = re.exec(html)
  if (!m) return null
  const [, y, mo, d, hh, mm] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}`
}

/** `og:url` / `canonical` の URL 末尾から商品 id を拾う（「商品ID」の行が読めなかったときの保険） */
function extractYahooItemIdFromUrl(html: string): string | null {
  const canonical = /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/paypayfleamarket\.yahoo\.co\.jp\/item\/([a-z]\d{8,})"/.exec(html)
  if (canonical) return canonical[1]
  const ogUrl = /<meta\b[^>]*property="og:url"[^>]*content="https:\/\/paypayfleamarket\.yahoo\.co\.jp\/item\/([a-z]\d{8,})"/.exec(html)
  return ogUrl ? ogUrl[1] : null
}

/** img[alt] がタイトルと完全一致するものの src を返す。無ければ null */
function extractThumbByAlt(html: string, title: string): string | null {
  const imgRe = /<img\b([^>]*)>/g
  let im: RegExpExecArray | null
  while ((im = imgRe.exec(html))) {
    const altMatch = /\balt="([^"]*)"/.exec(im[1])
    if (altMatch && decodeEntities(altMatch[1]) === title) {
      const srcMatch = /\bsrc="([^"]*)"/.exec(im[1])
      return srcMatch ? srcMatch[1] : null
    }
  }
  return null
}

/**
 * 商品ページから出品の情報を抜く。タイトルは `<h1>`、価格は「n,nnn」＋「円」の隣接する
 * 2つの `<span>`、商品 id・配送の方法などはラベル行（`readLabeledValue`）から拾う。
 * ⚠ 出品日時・公開日時は必ず見える文字から読む（pageData の starttime は使わない）。
 * タイトル・商品 id・価格のどれかが読めなければ null。
 */
export function parseYahooItemHtml(html: string): YahooScrapedItem | null {
  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)
  const title = h1Match ? stripTags(h1Match[1]) : null
  if (!title) return null

  const yahooItemId = readLabeledValue(html, '商品ID') ?? extractYahooItemIdFromUrl(html)
  if (!yahooItemId) return null

  const priceMatch = /<span\b[^>]*>([\d,]+)<\/span>\s*<span\b[^>]*>円<\/span>/.exec(html)
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null
  if (price === null) return null

  const listedAt = readDateTimeLabel(html, '出品日時')
  const publishedAt = readDateTimeLabel(html, '公開日時')

  const shippingMethod = readLabeledValue(html, '配送の方法')
  const condition = readLabeledValue(html, '商品の状態')
  const shippingDays = readLabeledValue(html, '発送までの日数')
  const shippingArea = readLabeledValue(html, '発送元の地域')

  const likesText = readLabeledValue(html, 'いいね数')
  const likes = likesText ? parseInt(likesText, 10) : null
  const viewsText = readLabeledValue(html, '閲覧数')
  const views = viewsText ? parseInt(viewsText, 10) : null

  const thumbUrl = extractThumbByAlt(html, title)

  return {
    yahooItemId, title, price, listedAt, publishedAt,
    shippingMethod, condition, shippingDays, shippingArea,
    likes, views, thumbUrl,
  }
}
