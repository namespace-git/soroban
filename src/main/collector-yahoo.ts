import { BrowserWindow, app, session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync } from 'node:fs'
import { readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as db from './db'
import {
  buildUserAgent, CHALLENGE_MESSAGE, isChallengeText, randomWait, revealForChallenge, thumbFileName,
} from './collector'
import type { CollectorRun, SaleStatus } from '../shared/types'

// ============================================================
// Yahoo!フリマの取り込み（パーサ＋実行部）
//
// パーサ（① 〜 ④）は純粋関数。実行部（ウィンドウ・session・ネットワーク・DB）は下の
// 「実行部」の節にまとめる。約束（src/main/collector.ts のメルカリ向けと同じ）：
//   * クラス名（styled-components の自動生成。デプロイのたびに変わる）に依存しない。
//     起点は a[href] と data-cl-params、画像は img[alt="商品画像"]、価格は正規表現
//   * 取得できなかったら空配列を返す。0件を「成功」として握りつぶす判断は呼び出し側の仕事
//   * 未知の値・未観測の値は推測で埋めず null を返す
//   * 書き込み操作はしない・認証情報は保存しない（persist:yahoo のセッションだけ）・
//     収集頻度は上げない（ページ間 2〜6 秒・直列）
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
  /**
   * 取扱内容セルの商品名。**途中で切れている**（例：「…新品未開封【Z07」）。型番はここから
   * 取らない。実行部（collect）が「取引ページに全文タイトルが無いとき」だけの代用に使う
   */
  itemName: string
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
  /**
   * `決済金額 − 販売手数料 = 受取額` が成り立つか。パーサは成り立たない行も推測で捨てずに
   * そのまま返す（例えば送料の内訳行が増えて式が崩れたとき）。false の行をどう扱うか
   * （捨てる・要確認として印を付ける等）は呼び出し側が決めること
   */
  amountsConsistent: boolean
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
  // 属性の有無に依存しない（Yahoo が <tr class="..."> を足しただけで0件になる罠を踏んだ）
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g
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

    const infoText = stripTags(infoHtml)
    const idMatch = /\(([a-z]\d{8,})\)/.exec(infoText)
    const yahooItemId = idMatch ? idMatch[1] : null
    if (!yahooItemId) continue

    const itemName = idMatch ? infoText.slice(0, idMatch.index).trim() : infoText

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

    // 送料などの行が増えて式が崩れていないかを呼び出し側が判断できるように、ここでは
    // 落とさず印だけ付ける（推測で送料として扱わない）
    const amountsConsistent = settlementAmount - feeAmount === receivedAmount

    rows.push({
      yahooItemId, itemName, handledDate, statusText, receivedAmount,
      settlementAmount, feeAmount, settleId, otherBreakdown, amountsConsistent,
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

// ============================================================
// ④ 出品中一覧（https://paypayfleamarket.yahoo.co.jp/my/item/selling）
//
// 1件から取るものは全部 data-cl-params（<a> の属性1つ）の中にある。
// opentime（出品日時。unix秒）は実物で確かめた値が商品ページの「出品日時：」と
// 一致する（yahoo-item.html 参照。商品ページ pageData.starttime の12時間ずれとは別物）。
// だからこの一覧だけで出品の取り込みが完結し、商品ページを1件ずつ開く必要がない。
// ============================================================

/** 「出品中」（`/my/item/selling`）の1件（parseYahooSellingHtml の要素） */
export interface YahooScrapedListing {
  yahooItemId: string
  title: string
  price: number
  /**
   * 出品日時。data-cl-params の `opentime`（unix秒）を JST（UTC+9固定。夏時間なし）に
   * 変換した 'YYYY-MM-DDTHH:mm'。実行環境のタイムゾーン設定には依存しない。読めなければ null
   */
  listedAt: string | null
  /** いいね数（`wl`）。読めなければ null */
  likes: number | null
  /** 閲覧数（`viewcnt`）。読めなければ null */
  views: number | null
  /** 検索された数（`srchcnt`）。読めなければ null */
  searchCount: number | null
  /** data-cl-params の tradstat の生の値。出品中は 'NONE' */
  tradstat: string
  /** 商品サムネイルのURL。取れなければ null */
  thumbUrl: string | null
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * unix秒として妥当とみなす範囲。Yahoo!フリマ（前身の PayPayフリマ含む）のサービス開始（2019年）
 * より十分前の 2015-01-01T00:00:00Z を下限、壊れた巨大な値をはじくための 2100-01-01T00:00:00Z を
 * 上限とする。実物の出品日時がこの範囲を超えることは想定しない
 */
const MIN_REASONABLE_UNIX_SECONDS = 1420070400 // 2015-01-01T00:00:00Z
const MAX_REASONABLE_UNIX_SECONDS = 4102444800 // 2100-01-01T00:00:00Z

/**
 * unix秒（UTC）を JST の 'YYYY-MM-DDTHH:mm' に変換する。JST は UTC+9 固定（夏時間なし）
 * なのでオフセットを直接足して UTC のフィールドを読む。実行環境のシステム時刻帯には依存しない。
 *
 * 「読めなければ null」を徹底する：安全な整数（`Number.isSafeInteger`）でない・妥当な範囲
 * （上記）外・変換した Date が無効（`Number.isNaN(d.getTime())`）のどれかに当たれば null を返す。
 * さもないと DOM が壊れて巨大な値が来たときに 'NaN-NaN-NaNTNaN:NaN' のような壊れた日時文字列が
 * できてしまう（実際に踏んだ）。
 */
function unixSecondsToJstIso(unixSeconds: number): string | null {
  if (!Number.isSafeInteger(unixSeconds)) return null
  if (unixSeconds < MIN_REASONABLE_UNIX_SECONDS || unixSeconds > MAX_REASONABLE_UNIX_SECONDS) return null
  const d = new Date(unixSeconds * 1000 + 9 * 60 * 60 * 1000)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

/**
 * 「出品中」一覧の HTML から行を抜く。商品リンクは `data-cl-params` に `rcconid` を持つ
 * `<a>` を起点にする（クラス名には依存しない）。商品 id はその `rcconid`
 * （無ければ href の `/item/<id>`）、タイトルは最初の `<p>`、価格はタイトルより後ろの
 * 「n,nnn円」、いいね・閲覧・検索された数・取引状態・出品日時はすべて data-cl-params から、
 * サムネイルは `img[alt="商品画像"]` の `src` から拾う。
 */
export function parseYahooSellingHtml(html: string): YahooScrapedListing[] {
  const rows: YahooScrapedListing[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let am: RegExpExecArray | null
  while ((am = anchorRe.exec(html))) {
    const attrs = am[1]
    const content = am[2]

    const paramsMatch = /data-cl-params="([^"]*)"/.exec(attrs)
    const params = paramsMatch ? paramsMatch[1] : null
    if (!params || !params.includes('rcconid:')) continue

    const hrefMatch = /href="([^"]*)"/.exec(attrs)
    const hrefIdMatch = hrefMatch ? /\/item\/([a-z]\d{8,})/.exec(hrefMatch[1]) : null
    const yahooItemId = readClParam(params, 'rcconid') || hrefIdMatch?.[1] || null
    if (!yahooItemId) continue

    const titleMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(content)
    const title = titleMatch ? stripTags(titleMatch[1]) : ''
    if (!title) continue

    const afterTitle = content.slice(titleMatch!.index + titleMatch![0].length)
    const price = parseYenAmount(afterTitle)
    if (price === null) continue

    const tradstat = readClParam(params, 'tradstat') ?? ''

    const opentimeText = readClParam(params, 'opentime')
    const listedAt = opentimeText && /^\d+$/.test(opentimeText)
      ? unixSecondsToJstIso(parseInt(opentimeText, 10))
      : null

    const wlText = readClParam(params, 'wl')
    const likes = wlText !== null && /^\d+$/.test(wlText) ? parseInt(wlText, 10) : null
    const viewcntText = readClParam(params, 'viewcnt')
    const views = viewcntText !== null && /^\d+$/.test(viewcntText) ? parseInt(viewcntText, 10) : null
    const srchcntText = readClParam(params, 'srchcnt')
    const searchCount = srchcntText !== null && /^\d+$/.test(srchcntText) ? parseInt(srchcntText, 10) : null

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

    rows.push({ yahooItemId, title, price, listedAt, likes, views, searchCount, tradstat, thumbUrl })
  }
  return rows
}

/** `extractYahooSellingCounts` の返り値 */
export interface YahooSellingCounts {
  /** 出品数（「出品数： 8/100」の 8）。読めなければ null */
  listingCount: number | null
  /** 出品数の上限（同上の 100）。読めなければ null */
  listingLimit: number | null
  /** 一覧の総件数（「1~8件/8件」の 8）。extractYahooSoldTotal と同じ形なのでそのまま使う */
  totalCount: number | null
}

/** 「出品中」一覧の出品数（n/上限）と総件数を抜く */
export function extractYahooSellingCounts(html: string): YahooSellingCounts {
  const m = /出品数[：:]\s*([\d,]+)\s*\/\s*([\d,]+)/.exec(html)
  const listingCount = m ? parseInt(m[1].replace(/,/g, ''), 10) : null
  const listingLimit = m ? parseInt(m[2].replace(/,/g, ''), 10) : null
  const totalCount = extractYahooSoldTotal(html)
  return { listingCount, listingLimit, totalCount }
}

// ============================================================
// 実行部（ウィンドウ・手動ログイン・巡回・DB書き込み）
//
// 巡回する3ページ（直列。ページ間は randomWait）：
//   ① 出品中（selling）② 取引中・取引完了（sold）③ 売上金管理（salesmanagement、別ホスト）
// 商品ページ（/item/<id>）は開かない（opentime が①にあるので不要）。
// ============================================================

const PARTITION = 'persist:yahoo'
const SELLING_URL = 'https://paypayfleamarket.yahoo.co.jp/my/item/selling'
const SOLD_URL = 'https://paypayfleamarket.yahoo.co.jp/my/item/sold'
const SALES_URL = 'https://salesmanagement.yahoo.co.jp/list'
// PayPayフリマに専用のログインページURLは無い（未確認）。マイページを開けば、
// 未ログインなら Yahoo が自動的にログイン画面へ誘導する（メルカリの /login のような
// 固定URLに頼らない）
const LOGIN_URL = SELLING_URL

/** 1回の収集でサムネイルを保存する上限（販売・出品合わせて）。collector.ts と同じ約束 */
const MAX_THUMBS_PER_RUN = 30

const WINDOW_TITLE = 'そろばん — Yahoo!フリマ'

function createWindow(show: boolean, title: string = WINDOW_TITLE): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    show,
    title,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
}

/** ログイン用ウィンドウを開く。ユーザーが手でログインし、Cookieがプロファイルに残る */
export function openYahooLogin(): Promise<void> {
  return new Promise((resolve) => {
    const win = createWindow(true, `${WINDOW_TITLE}（ログイン）`)
    win.loadURL(LOGIN_URL)
    win.on('closed', () => resolve())
  })
}

/** UA・Accept-Language を通常の Chrome に合わせる（collector.ts と同じ） */
export function ensureSession(): void {
  const s = session.fromPartition(PARTITION)
  const chromeMajor = process.versions.chrome.split('.')[0]
  const ua = buildUserAgent(process.platform, chromeMajor)
  s.setUserAgent(ua, 'ja,en-US;q=0.9,en;q=0.8')
}

/**
 * ログイン済みかを判定する。実DOMのマーカーが未確認のため、URLがログイン画面
 * （login.yahoo.co.jp）へ飛ばされていないか、と本文が空でないかだけで見る
 * （メルカリの isLoggedIn より緩いが、CAPTCHA・本人確認は isChallenge が別に見る）。
 */
async function isLoggedIn(win: BrowserWindow): Promise<boolean> {
  const url = win.webContents.getURL()
  if (/login\.yahoo\.co\.jp/i.test(url)) return false

  const hasBody = await win.webContents
    .executeJavaScript(`!!document.body && document.body.innerText.length > 0`)
    .catch(() => false) as boolean
  return hasBody
}

/** 現在のページが CAPTCHA・本人確認を求めていないかを見る（collector.ts の isChallenge と同じ作法） */
async function isChallenge(win: BrowserWindow): Promise<boolean> {
  const url = win.webContents.getURL()
  const bodyText = await win.webContents
    .executeJavaScript(`document.body ? document.body.innerText : ''`)
    .catch(() => '') as string
  const hasCaptchaFrame = await win.webContents.executeJavaScript(`
    !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="arkose"], [data-sitekey]'
    )
  `).catch(() => false) as boolean
  return isChallengeText(url, bodyText, hasCaptchaFrame)
}

async function outerHtml(win: BrowserWindow): Promise<string> {
  return await win.webContents
    .executeJavaScript('document.documentElement.outerHTML')
    .catch(() => '') as string
}

// ------------------------------------------------------------
// サムネイル保存（collector.ts と同じ作法。private ヘルパーは export されていないため
// ここに複製する。thumbFileName だけ collector.ts から借りる）
// ------------------------------------------------------------

function ensureThumbDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function cleanupOldThumbFiles(dir: string, itemId: string, keepFile: string): Promise<void> {
  try {
    const names = await readdir(dir)
    const stale = names.filter(n =>
      n !== keepFile && (n === `${itemId}.jpg` || n.startsWith(`${itemId}-`)))
    await Promise.all(stale.map(n => unlink(join(dir, n)).catch(() => {})))
  } catch {
    // ディレクトリが読めない等は無視
  }
}

async function downloadThumbFile(itemId: string, url: string): Promise<{ file: string; src: string }> {
  const res = await session.fromPartition(PARTITION).fetch(url)
  if (!res.ok) throw new Error(`サムネイル取得に失敗しました（${res.status}）: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const file = thumbFileName(itemId, url)
  const src = db.normalizeThumbSrc(url)
  const dir = ensureThumbDir()
  await writeFile(join(dir, file), buf)
  await cleanupOldThumbFiles(dir, itemId, file)
  return { file, src }
}

interface ThumbSaveResult { saved: number; attempted: number }

async function saveNewThumbs(
  targets: Array<{ id: string; mercariItemId: string; thumbUrl: string }>,
  limit: number,
): Promise<ThumbSaveResult> {
  const list = targets.slice(0, Math.max(0, limit))
  let saved = 0
  let attempted = 0
  for (const t of list) {
    attempted++
    try {
      const { file, src } = await downloadThumbFile(t.mercariItemId, t.thumbUrl)
      db.setSaleThumb(t.id, file, src)
      saved++
    } catch {
      // 失敗しても再試行しない
    }
    await sleep(300 + Math.floor(Math.random() * 500))
  }
  return { saved, attempted }
}

async function saveNewListingThumbs(
  targets: Array<{ id: string; thumbUrl: string }>,
  limit: number,
): Promise<ThumbSaveResult> {
  const list = targets.slice(0, Math.max(0, limit))
  let saved = 0
  let attempted = 0
  for (const t of list) {
    attempted++
    try {
      const { file, src } = await downloadThumbFile(t.id, t.thumbUrl)
      db.setListingThumb(t.id, file, src)
      saved++
    } catch {
      // 失敗しても再試行しない
    }
    await sleep(300 + Math.floor(Math.random() * 500))
  }
  return { saved, attempted }
}

// ------------------------------------------------------------
// ②（取引中・取引完了）と③（売上金管理）の結合（純粋関数。テストで確かめる）
// ------------------------------------------------------------

/** ②と③を商品idで結合した1件（combineYahooSales の要素） */
export interface YahooCombinedSale {
  yahooItemId: string
  /** タイトル。②（取引ページ）の全文があればそれ、無ければ③（売上金管理）の商品名（途中で切れている） */
  title: string
  /** 決済金額（③） */
  price: number
  /** 販売手数料の実額（③。0円もある） */
  fee: number
  /** 取扱日（③。計上日として使う） */
  soldAt: string
  /** ②のtradstatをmapYahooTradstatで判定した状態。②に無ければ null（推測で埋めない） */
  status: SaleStatus | null
  /** ②のサムネイルURL。②に無ければ null */
  thumbUrl: string | null
}

/**
 * 「取引中・取引完了」（②）と「売上金管理」（③）を商品idで結合する。
 *
 * ③を起点にループする（日付・実額が③にしか無いため）。②にしか無い行（まだ売上金管理に
 * 出ていない＝日付が無い）はここでは作らない。次回の収集で③に出てから作る。
 *
 * amountsConsistent が false の行（決済金額－手数料≠受取額。受取連絡後に送料の行が増えて
 * 式が崩れた等）は combine せず、skippedInconsistent の件数だけ増やして返す
 * （黙って通すと送料が利益に残ってしまう）。
 */
export function combineYahooSales(
  soldRows: YahooScrapedSale[],
  salesRows: YahooSalesRow[],
): { sales: YahooCombinedSale[]; skippedInconsistent: number } {
  const soldById = new Map(soldRows.map(r => [r.yahooItemId, r]))
  const sales: YahooCombinedSale[] = []
  let skippedInconsistent = 0

  for (const s of salesRows) {
    if (!s.amountsConsistent) {
      skippedInconsistent++
      continue
    }
    const sold = soldById.get(s.yahooItemId)
    sales.push({
      yahooItemId: s.yahooItemId,
      title: sold && sold.title ? sold.title : s.itemName,
      price: s.settlementAmount,
      fee: s.feeAmount,
      soldAt: s.handledDate,
      status: sold ? mapYahooTradstat(sold.tradstat) : null,
      thumbUrl: sold?.thumbUrl ?? null,
    })
  }

  return { sales, skippedInconsistent }
}

/** splitYahooCombinedSales の返り値 */
export interface YahooCombinedSalesSplit {
  /** 新規（db.insertCollected へ渡す） */
  freshMatched: YahooCombinedSale[]
  /** 既に帳簿にある（db.updateYahooActuals へ渡す） */
  knownMatched: YahooCombinedSale[]
  /** 新規のうちキーワード不一致で弾いた件数 */
  excludedByKeyword: number
  /** 新規のうち削除済み（sale_exclusion）で弾いた件数 */
  excludedDeleted: number
}

/**
 * combineYahooSales の結果を「新規（insertCollected へ）」と「既知（updateYahooActuals へ）」に
 * 分ける（実行部 collect() の配線を単体でテストできるように切り出した純粋関数）。
 *
 * knownIds は db.existingMercariIds、excludedIds は db.isMercariItemExcluded で事前に解決した
 * 結果を呼び出し側が渡す（この関数自体は DB に触らない）。
 *
 * combined は combineYahooSales が amountsConsistent=false の行をすでに除いた後のものなので、
 * ここでは意識しなくてよい（新規・既知のどちらにも式が崩れた行は混ざらない）。
 * 削除済み（sale_exclusion）は新規側だけ弾く（既知はすでに帳簿にある＝削除判定は関係ない）。
 * キーワード不一致は新規・既知の両方から弾く（不一致の詳細・サムネイルを取りに行かない規則と同じ）。
 */
export function splitYahooCombinedSales(
  combined: YahooCombinedSale[],
  knownIds: Set<string>,
  excludedIds: Set<string>,
  keywords: string[],
): YahooCombinedSalesSplit {
  const freshAll = combined.filter(c => !knownIds.has(c.yahooItemId))
  const knownCombined = combined.filter(c => knownIds.has(c.yahooItemId))

  const freshNotDeleted = freshAll.filter(c => !excludedIds.has(c.yahooItemId))
  const excludedDeleted = freshAll.length - freshNotDeleted.length

  const freshMatched = keywords.length > 0
    ? freshNotDeleted.filter(c => db.matchesAnyKeyword(c.title, keywords))
    : freshNotDeleted
  const excludedByKeyword = freshNotDeleted.length - freshMatched.length

  const knownMatched = keywords.length > 0
    ? knownCombined.filter(c => db.matchesAnyKeyword(c.title, keywords))
    : knownCombined

  return { freshMatched, knownMatched, excludedByKeyword, excludedDeleted }
}

/** 3ページとも0件なら true（`empty` 扱い）。1つでも取れていれば false（出品を売り切ると出品0件はあり得る） */
export function isYahooCollectEmpty(
  listingCount: number, soldCount: number, salesCount: number,
): boolean {
  return listingCount === 0 && soldCount === 0 && salesCount === 0
}

// ------------------------------------------------------------
// collect()
// ------------------------------------------------------------

/**
 * 収集を1回実行する。
 * @param silent true なら画面を出さない（起動時の自動実行）
 */
export async function collect(silent: boolean): Promise<CollectorRun> {
  const runId = db.startRun('yahoo')
  const win = createWindow(!silent)
  let keepWindowOpen = false

  try {
    // ① 出品中
    await win.loadURL(SELLING_URL)
    await randomWait()

    if (await isChallenge(win)) {
      keepWindowOpen = true
      revealForChallenge(win, 'Yahoo!フリマ')
      return db.finishRun(runId, 'auth_required', 0, 0, CHALLENGE_MESSAGE)
    }
    if (!(await isLoggedIn(win))) {
      return db.finishRun(
        runId, 'auth_required', 0, 0,
        'Yahoo!フリマにログインし直してください（出品中一覧が開けませんでした）',
      )
    }

    const sellingHtml = await outerHtml(win)
    const scrapedListings = parseYahooSellingHtml(sellingHtml)

    // ② 取引中・取引完了
    await win.loadURL(SOLD_URL)
    await randomWait()

    if (await isChallenge(win)) {
      keepWindowOpen = true
      revealForChallenge(win, 'Yahoo!フリマ')
      return db.finishRun(runId, 'auth_required', 0, 0, CHALLENGE_MESSAGE)
    }
    if (!(await isLoggedIn(win))) {
      return db.finishRun(
        runId, 'auth_required', 0, 0,
        'Yahoo!フリマにログインし直してください（取引中・取引完了が開けませんでした）',
      )
    }

    const soldHtml = await outerHtml(win)
    const soldRows = parseYahooSoldHtml(soldHtml)

    // ③ 売上金管理（別ホスト：salesmanagement.yahoo.co.jp）
    await win.loadURL(SALES_URL)
    await randomWait()

    if (await isChallenge(win)) {
      keepWindowOpen = true
      revealForChallenge(win, 'Yahoo!フリマ')
      return db.finishRun(runId, 'auth_required', 0, 0, CHALLENGE_MESSAGE)
    }
    if (!(await isLoggedIn(win))) {
      // 2つのホストにまたがるため、同じYahoo IDのセッションでもここだけ通らないことがあり得る。
      // 黙って0件にせず、どちらで弾かれたか分かる文言にする
      return db.finishRun(
        runId, 'auth_required', 0, 0,
        '売上金管理（salesmanagement.yahoo.co.jp）でログインが確認できませんでした。'
          + 'Yahoo!フリマにログインし直してください',
      )
    }

    const salesHtml = await outerHtml(win)
    const salesRows = parseYahooSalesHtml(salesHtml)

    if (isYahooCollectEmpty(scrapedListings.length, soldRows.length, salesRows.length)) {
      return db.finishRun(
        runId, 'empty', 0, 0,
        '0件でした。画面構造が変わってセレクタが壊れている可能性があります',
      )
    }

    // --- 販売：②と③を商品idで結合する ---
    const { sales: combined, skippedInconsistent } = combineYahooSales(soldRows, salesRows)

    const keywords = db.parseKeywords(db.getSettings().yahoo_keyword ?? '')

    const known = db.existingMercariIds(combined.map(c => c.yahooItemId))
    // 削除した販売（sale_exclusion）は再取り込みしない（新規側だけ）
    const excludedIds = new Set(
      combined.filter(c => !known.has(c.yahooItemId) && db.isMercariItemExcluded(c.yahooItemId))
        .map(c => c.yahooItemId),
    )

    // キーワードが設定されていれば、不一致は insertCollected / updateYahooActuals どちらにも
    // 渡さない（詳細・サムネイルも取りに行かない）
    const { freshMatched, knownMatched, excludedByKeyword, excludedDeleted } =
      splitYahooCombinedSales(combined, known, excludedIds, keywords)

    const insertedRows = freshMatched.length > 0
      ? db.insertCollected(freshMatched.map(c => ({
          mercariItemId: c.yahooItemId,
          title: c.title,
          price: c.price,
          soldAt: c.soldAt,
          fee: c.fee,
          status: c.status,
        })), 'yahoo')
      : []

    // --- 既に取り込み済みの販売（キーワード一致分だけ）を実額・状態で更新する ---
    // メルカリ用の updateCollectedActuals は status='completed' を決め打ちするため使わない
    // （Yahoo!は受取連絡待ちの取引も出るので、渡された status（null もそのまま）を使う updateYahooActuals を使う）
    const updatedCount = knownMatched.length > 0
      ? db.updateYahooActuals(knownMatched.map(c => ({
          mercariItemId: c.yahooItemId,
          soldAt: c.soldAt,
          fee: c.fee,
          price: c.price,
          status: c.status,
        })))
      : 0

    // --- サムネイル：新規 ＋ 既知（現在のキーワードに一致するもの）。予算は出品と合算で管理 ---

    const thumbTargets = db.salesNeedingThumb(
      [...freshMatched, ...knownMatched]
        .filter((c): c is YahooCombinedSale & { thumbUrl: string } => !!c.thumbUrl)
        .map(c => ({ mercariItemId: c.yahooItemId, thumbUrl: c.thumbUrl })),
    )
    const thumbsResult = await saveNewThumbs(thumbTargets, MAX_THUMBS_PER_RUN)

    // --- 出品中一覧（①）。売却済みの後に読む。キーワードで絞る ---
    const targetListings = keywords.length > 0
      ? scrapedListings.filter(l => db.matchesAnyKeyword(l.title, keywords))
      : scrapedListings

    const listingResult = db.upsertListings(
      targetListings.map(l => ({
        mercariItemId: l.yahooItemId,
        title: l.title,
        price: l.price,
        // Yahoo!フリマの「公開停止中」相当の表示は未観測（tradstat=NONEのみ出品中とみなす）
        suspended: false,
        thumbUrl: l.thumbUrl,
        likes: l.likes,
        listedAt: l.listedAt,
      })),
      'yahoo',
    )

    const listingThumbTargets = db.listingsNeedingThumb(
      targetListings.map(l => ({ mercariItemId: l.yahooItemId, thumbUrl: l.thumbUrl })),
    )
    const listingThumbsResult = await saveNewListingThumbs(
      listingThumbTargets, MAX_THUMBS_PER_RUN - thumbsResult.attempted,
    )

    const parts = [`新規 ${insertedRows.length}・更新 ${updatedCount}`]
    if (excludedByKeyword > 0) parts.push(`キーワード不一致で除外 ${excludedByKeyword} 件`)
    if (excludedDeleted > 0) parts.push(`削除済み ${excludedDeleted} 件`)
    if (skippedInconsistent > 0) parts.push(`確認が要る ${skippedInconsistent} 件（内訳の式が合いません）`)
    const totalThumbsSaved = thumbsResult.saved + listingThumbsResult.saved
    if (totalThumbsSaved > 0) parts.push(`サムネイル ${totalThumbsSaved} 枚`)
    parts.push(`出品 新規 ${listingResult.inserted}・更新 ${listingResult.updated}`)

    const observedIds = new Set([
      ...scrapedListings.map(l => l.yahooItemId),
      ...soldRows.map(r => r.yahooItemId),
      ...salesRows.map(r => r.yahooItemId),
    ])

    return db.finishRun(runId, 'ok', observedIds.size, insertedRows.length, parts.join('。'))

  } catch (e) {
    return db.finishRun(
      runId, 'failed', 0, 0,
      e instanceof Error ? e.message : String(e),
    )
  } finally {
    if (!keepWindowOpen && !win.isDestroyed()) win.destroy()
  }
}
