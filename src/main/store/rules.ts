import { createHash } from 'node:crypto'
import * as db from '../db'
import type { PurchaseDraftInput, PurchaseInput } from '../../shared/types'

// ============================================================
// 取り込みの仕分けの規則（キーワード・除外）
//
// ローカルの store（local.ts）が使う。collector-mellojoy.ts・collector-yahoo.ts はここから再 export する
// （既存のテストと呼び出しが今までの場所から取れるように。規則はここ 1 か所）。
// electron に依存しない純粋な関数だけを置く。
// ============================================================

/**
 * import_keywords（db.parseKeywords で正規化済みの配列）から sha1 を作る。
 * 順序に依らないよう並べ替えてから連結する。キーワードを変えればハッシュが変わり、
 * 除外記録（mellojoy_excluded_order）が再評価される。
 */
export function hashKeywords(keywords: string[]): string {
  return createHash('sha1').update(keywords.slice().sort().join('\n')).digest('hex')
}

/**
 * 口座の import_keywords で確定済みの仕入を絞り込む。confirmed / draft の判定は
 * 絞り込む前の注文全体で終わっているので、ここでは既に確定した PurchaseInput の
 * 明細を削るだけ（判定のやり直しはしない）。
 *
 * - keywords が空なら input をそのまま返す（絞り込みなし）
 * - 一致する明細が1つも無ければ null（その注文は取り込まない）
 * - 一部だけ一致するなら、一致した明細だけに絞り、送料・割引は注文全体の金額比
 *   （一致した明細の小計 ÷ 全明細の小計）で按分する。小計が0なら按分せず0
 */
export function filterPurchaseInputByKeywords(
  input: PurchaseInput, keywords: string[],
): PurchaseInput | null {
  if (keywords.length === 0) return input

  const matched = input.lines.filter(l => db.matchesAnyKeyword(l.name, keywords))
  if (matched.length === 0) return null
  if (matched.length === input.lines.length) return input

  const fullSubtotal = input.lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const matchedSubtotal = matched.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const ratio = fullSubtotal > 0 ? matchedSubtotal / fullSubtotal : 0

  const excluded = input.lines.length - matched.length
  const addition = `キーワード不一致の明細 ${excluded} 件を除外（送料・割引は金額比で按分）`

  return {
    ...input,
    lines: matched,
    shipping_fee: Math.round((input.shipping_fee ?? 0) * ratio),
    discount: Math.round((input.discount ?? 0) * ratio),
    note: input.note ? `${input.note}\n${addition}` : addition,
  }
}

/**
 * 下書き版。下書きは単価が確定していない（quantity当たりの金額が分からない）ことがあるため、
 * 金額比の按分はできない。送料・割引は注文全体の値のまま残し、note で「確定時に見直してください」
 * と伝える。私物だけの注文が価格未入力の下書きとして要対応に出続けないよう、confirmed と同じく
 * 一致0件は null（取り込まない）にする。
 */
export function filterPurchaseDraftByKeywords(
  input: PurchaseDraftInput, keywords: string[],
): PurchaseDraftInput | null {
  if (keywords.length === 0) return input

  const matched = input.lines.filter(l => db.matchesAnyKeyword(l.name, keywords))
  if (matched.length === 0) return null
  if (matched.length === input.lines.length) return input

  const excluded = input.lines.length - matched.length
  const addition =
    `キーワード不一致の明細 ${excluded} 件を除外（送料・割引は注文全体の値。確定時に見直してください）`

  return {
    ...input,
    lines: matched,
    note: input.note ? `${input.note}\n${addition}` : addition,
  }
}

/** splitYahooCombinedSales が見る列（YahooCombinedSale・AgentYahooSaleRow のどちらも満たす） */
export interface YahooSplitCandidate {
  yahooItemId: string
  title: string
  titleTruncated: boolean
}

/** splitYahooCombinedSales の返り値 */
export interface YahooCombinedSalesSplit<T extends YahooSplitCandidate = YahooSplitCandidate> {
  /** 新規（db.insertCollected へ渡す） */
  freshMatched: T[]
  /** 既に帳簿にある（db.updateYahooActuals へ渡す） */
  knownMatched: T[]
  /** 新規のうちキーワード不一致で弾いた件数（タイトルが途中で切れている行は含まない） */
  excludedByKeyword: number
  /** 新規のうち削除済み（sale_exclusion）で弾いた件数 */
  excludedDeleted: number
  /**
   * 新規のうち、タイトルが③（売上金管理）の商品名しか無く途中で切れていたため、キーワードでの
   * 判定をスキップしてそのまま freshMatched に含めた行の商品id（実行記録に残すため）
   */
  truncatedTitleIds: string[]
}

/**
 * Yahoo!フリマの売上（②と③を結合したもの）を「新規（insertCollected へ）」と「既知（updateYahooActuals へ）」に
 * 分ける（ローカルの store の ingestYahooSales が使う。単体でテストできるように切り出した純粋関数）。
 *
 * knownIds は db.existingMercariIds、excludedIds は db.isMercariItemExcluded で事前に解決した
 * 結果を呼び出し側が渡す（この関数自体は DB に触らない）。
 *
 * combined は combineYahooSales が amountsConsistent=false の行をすでに除いた後のものなので、
 * ここでは意識しなくてよい（新規・既知のどちらにも式が崩れた行は混ざらない）。
 * 削除済み（sale_exclusion）は新規側だけ弾く（既知はすでに帳簿にある＝削除判定は関係ない）。
 *
 * キーワードは「取り込むかどうか」を決めるものであって「もう帳簿にあるものを更新するかどうか」
 * ではない。だから既知（knownMatched）は現在のキーワードに関わらず全件を updateYahooActuals へ
 * 渡す。キーワードで絞るのは新規（freshMatched）だけ（今までどおり）。
 *
 * タイトルが③（売上金管理）の商品名しか無く途中で切れている行（titleTruncated）は、切れた
 * 部分にキーワードがあった場合に誤って「不一致」と判定してしまう。だからキーワード判定を
 * スキップし、そのまま freshMatched に含める（黙って捨てない）。id は truncatedTitleIds に
 * 残し、呼び出し側が実行記録に書けるようにする。
 */
export function splitYahooCombinedSales<T extends YahooSplitCandidate>(
  combined: T[],
  knownIds: Set<string>,
  excludedIds: Set<string>,
  keywords: string[],
): YahooCombinedSalesSplit<T> {
  const freshAll = combined.filter(c => !knownIds.has(c.yahooItemId))
  const knownMatched = combined.filter(c => knownIds.has(c.yahooItemId))

  const freshNotDeleted = freshAll.filter(c => !excludedIds.has(c.yahooItemId))
  const excludedDeleted = freshAll.length - freshNotDeleted.length

  const freshTruncated = freshNotDeleted.filter(c => c.titleTruncated)
  const freshJudgeable = freshNotDeleted.filter(c => !c.titleTruncated)

  const freshJudgeableMatched = keywords.length > 0
    ? freshJudgeable.filter(c => db.matchesAnyKeyword(c.title, keywords))
    : freshJudgeable
  const excludedByKeyword = freshJudgeable.length - freshJudgeableMatched.length

  const freshMatched = [...freshJudgeableMatched, ...freshTruncated]
  const truncatedTitleIds = freshTruncated.map(c => c.yahooItemId)

  return { freshMatched, knownMatched, excludedByKeyword, excludedDeleted, truncatedTitleIds }
}
