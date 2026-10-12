// 出品先のページの URL（shared/channel-url.ts）。デスクトップ（main の shell.openExternal）と
// Web 版（画面の window.open）が同じ規則で開く。ホストとパスは固定、id の形だけを検査する。
import { describe, it, expect } from 'vitest'
import { channelPageUrl } from '../channel-url'

describe('channelPageUrl（出品先のURL組み立て・別サイトのidは弾く）', () => {
  it('メルカリの商品ページ・取引画面', () => {
    expect(channelPageUrl('mercari', 'item', 'm123456789')).toBe('https://jp.mercari.com/item/m123456789')
    expect(channelPageUrl('mercari', 'transaction', 'm123456789')).toBe('https://jp.mercari.com/transaction/m123456789')
  })

  it('Yahoo!フリマの商品ページ・取引画面（取引画面だけ別ホスト -sec で末尾が /trade/seller）', () => {
    expect(channelPageUrl('yahoo', 'item', 'z999999999')).toBe('https://paypayfleamarket.yahoo.co.jp/item/z999999999')
    expect(channelPageUrl('yahoo', 'transaction', 'z999999999'))
      .toBe('https://paypayfleamarket-sec.yahoo.co.jp/item/z999999999/trade/seller')
  })

  it('出品先に合わない id・空文字・桁不足・大文字・空白・記号は Error', () => {
    expect(() => channelPageUrl('mercari', 'item', 'z999999999')).toThrow('メルカリの商品IDではありません')
    expect(() => channelPageUrl('mercari', 'item', '')).toThrow('メルカリの商品IDではありません')
    expect(() => channelPageUrl('mercari', 'item', 'm123')).toThrow('メルカリの商品IDではありません')
    expect(() => channelPageUrl('mercari', 'item', 'M123456789')).toThrow('メルカリの商品IDではありません')
    expect(() => channelPageUrl('mercari', 'item', ' m123456789')).toThrow('メルカリの商品IDではありません')
    expect(() => channelPageUrl('yahoo', 'item', 'z1234567')).toThrow('Yahoo!フリマの商品IDではありません')
    expect(() => channelPageUrl('yahoo', 'item', 'Z693579992')).toThrow('Yahoo!フリマの商品IDではありません')
  })

  it.each([
    'm123456789/../../evil',
    'm123456789?x=1',
    'm123456789#f',
    'm123456789/evil',
  ])('URLに使えない文字を混ぜた id "%s" は Error（別ホストへ飛ぶ URL にならない）', (itemId) => {
    expect(() => channelPageUrl('mercari', 'item', itemId)).toThrow('メルカリの商品IDではありません')
    expect(() => channelPageUrl('yahoo', 'item', itemId)).toThrow('Yahoo!フリマの商品IDではありません')
  })

  it('知らない出品先は Error', () => {
    expect(() => channelPageUrl('rakuma' as never, 'item', 'm123456789')).toThrow('知らない出品先です')
  })
})
