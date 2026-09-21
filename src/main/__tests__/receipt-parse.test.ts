import { describe, expect, it } from 'vitest'
import { parseReceiptText } from '../receipt-parse'

// ============================================================
// parseReceiptText は電子部品に依存しない純粋関数。OCRの生テキストを
// 想定した文字列を直接渡して検証する（実画像でのOCRは ocr.test.ts）
// ============================================================

const RECEIPT_SAMPLE_TEXT = `
ダイソー 川崎駅前店
TEL 044-000-0000
2026年09月15日(月) 14:32
レジ#03 責:田中
ビニール袋 100枚      110
OPP袋 A4          2点 \\220
緩衝材 プチプチ      y330
ダンボール 小     y220
小計          y880
(内消費税         \\80)
合計            \\880
お預り           ¥1.000
お釣り       ¥120
`

describe('parseReceiptText', () => {
  it('検証用レシート相当のテキストから店・日付・合計・明細を取れる', () => {
    const draft = parseReceiptText(RECEIPT_SAMPLE_TEXT)
    expect(draft.shop).toBe('ダイソー 川崎駅前店')
    expect(draft.occurred_at).toBe('2026-09-15')
    expect(draft.total).toBe(880)
    expect(draft.lines).toHaveLength(4)

    const opp = draft.lines.find(l => l.name.includes('OPP袋'))
    expect(opp).toMatchObject({ quantity: 2, unit_price: 110 })
  })

  it('令和表記（R8.9.15）と下2桁の年（26.09.15）から日付を取れる', () => {
    const reiwa = parseReceiptText('なんとか商店\nR8.9.15\n合計 ¥500')
    expect(reiwa.occurred_at).toBe('2026-09-15')

    const shortYear = parseReceiptText('なんとか商店\n26.09.15\n合計 ¥500')
    expect(shortYear.occurred_at).toBe('2026-09-15')
  })

  it('合計行が無ければ、預り・釣り・ポイント・税を含まない行の金額の最大値を合計にする', () => {
    const text = [
      'なんとか商店',
      '2026年01月10日',
      '商品A          ¥300',
      '商品B          ¥800',
      'お預り          ¥2000',
      'お釣り          ¥900',
      '(内消費税        ¥73)',
    ].join('\n')
    const draft = parseReceiptText(text)
    expect(draft.total).toBe(800)
  })

  it('未来日は無効（occurred_atはnull）', () => {
    const draft = parseReceiptText('なんとか商店\n2099年01月01日\n合計 ¥500')
    expect(draft.occurred_at).toBeNull()
  })

  it('OCRの誤読（¥88ロ→880、y330→330）を数字として補正する', () => {
    const draft = parseReceiptText('なんとか商店\n2026年01月10日\n何か          ¥88ロ\n合計          y330')
    expect(draft.total).toBe(330)
    const item = draft.lines.find(l => l.name.includes('何か'))
    expect(item?.unit_price).toBe(880)
  })
})
