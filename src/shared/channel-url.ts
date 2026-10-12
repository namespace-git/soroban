// ============================================================
// 出品先のページの URL（メルカリ・Yahoo!フリマ）
//
// 画面から任意の URL を開かせないため、URL はここだけが組み立てる。
// デスクトップ版は main（shell.openExternal）、Web 版は画面（window.open）が、この関数の結果だけを開く。
// ============================================================
import type { SalesChannel } from './types'

/**
 * 出品先のページの URL を組み立てる。**ここだけが URL を知っている**。
 *
 * この検査が守っているのは「**id が安全な字だけで出来ていること**」で、ホストとパスは
 * ここのリテラルで固定される。だから画面がどんな値を渡しても**別サイトへは飛べない**
 * （`/` `?` `#` `..` はどれも `^…$` で弾かれる。テスト済み）。
 *
 * 一方で「**id が本当にその出品先のものか**」までは見分けていない。Yahoo!フリマの
 * `^[a-z]\d{8,}$` はメルカリの `m123456789` も通す（先頭 1 文字が何でもよいため）。
 * Yahoo の id は実物で `z` `b` `p` `t` `d` を観測しており、`m` で始まるものが無いとは
 * 言い切れないので、**先頭文字で出品先を当てる推測はしない**。
 * channel と id の食い違いは DB 側の整合性の話で、ここで直すものではない
 * （食い違えば 404 になるだけで、別サイトへは飛ばない）
 */
export function channelPageUrl(
  channel: SalesChannel, kind: 'item' | 'transaction', itemId: string,
): string {
  if (channel === 'mercari') {
    if (!/^m\d{9,}$/.test(itemId)) throw new Error(`メルカリの商品IDではありません: ${itemId}`)
    return `https://jp.mercari.com/${kind === 'item' ? 'item' : 'transaction'}/${itemId}`
  }
  if (channel === 'yahoo') {
    if (!/^[a-z]\d{8,}$/.test(itemId)) throw new Error(`Yahoo!フリマの商品IDではありません: ${itemId}`)
    // 取引画面だけ別ホスト（-sec）で、末尾が /trade/seller になる
    return kind === 'item'
      ? `https://paypayfleamarket.yahoo.co.jp/item/${itemId}`
      : `https://paypayfleamarket-sec.yahoo.co.jp/item/${itemId}/trade/seller`
  }
  throw new Error(`知らない出品先です: ${String(channel)}`)
}
