import { beforeEach, describe, expect, it, vi } from 'vitest'

// receipts.ts は electron（app・dialog）と ai-receipt.ts（safeStorage）に依存し、db.ts も app.getPath を参照する。
// ここで見るのは applyShopAlias（店名の学習の当て込み）だけなので、import が通る最小限のダミーで足りる
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

import * as db from '../db'
import { applyShopAlias } from '../receipts'
import type { ReceiptDraft } from '../../shared/types'

// receipts.ts の重複（extractRegistrationNoFallback・applyShopAlias）を gemini-core.ts の
// receiptRegistrationNo・applyLearnedShop に寄せた。寄せる前の実装をそのまま写したものを「基準」にして、
// デスクトップの結果が変わっていないことを、同じ入力の表で確かめる
function referenceFallback(text: string): string | null {
  const m = text.normalize('NFKC').match(/T\s*(\d{13})/)
  return m ? `T${m[1]}` : null
}
function referenceApplyShopAlias(draft: ReceiptDraft): ReceiptDraft {
  const registrationNo = draft.registration_no ?? referenceFallback(draft.raw_text)
  if (!registrationNo) return draft
  const learned = db.lookupShopAlias(registrationNo)
  if (!learned) return { ...draft, registration_no: registrationNo }
  return { ...draft, registration_no: registrationNo, shop: learned, shop_learned: true }
}

function draftOf(patch: Partial<ReceiptDraft>): ReceiptDraft {
  return {
    shop: 'OCR が読んだ店名', registration_no: null, shop_learned: false, occurred_at: '2026-10-01', total: 1000,
    lines: [], boxes: { shop: null, date: null, total: null }, tax: null, warnings: [], raw_text: '', confidence: 80,
    ...patch,
  }
}

beforeEach(() => {
  db.initDb(':memory:')
  db.learnShopAlias('T2290801007056', 'セブンイレブン 小倉貫店')
})

describe('applyShopAlias（receipts.ts。gemini-core の receiptRegistrationNo・applyLearnedShop を使う）', () => {
  it('登録番号が学習済みなら、店名を学習したものにして shop_learned を立てる', () => {
    const out = applyShopAlias(draftOf({ registration_no: 'T2290801007056' }))
    expect(out.shop).toBe('セブンイレブン 小倉貫店')
    expect(out.shop_learned).toBe(true)
    expect(out.registration_no).toBe('T2290801007056')
  })

  it('AI が登録番号を抜けなくても、生テキストの T＋13 桁（全角・空白まじり）から拾って当てる', () => {
    const out = applyShopAlias(draftOf({ raw_text: '登録番号 Ｔ ２２９０８０１００７０５６ 領収書' }))
    expect(out.registration_no).toBe('T2290801007056')
    expect(out.shop).toBe('セブンイレブン 小倉貫店')
    expect(out.shop_learned).toBe(true)
  })

  it('学習していない番号なら、店名はそのまま・登録番号だけ入る（shop_learned も今のまま）', () => {
    const out = applyShopAlias(draftOf({ registration_no: 'T9999999999999', shop_learned: true }))
    expect(out.shop).toBe('OCR が読んだ店名')
    expect(out.shop_learned).toBe(true)
    expect(out.registration_no).toBe('T9999999999999')
  })

  it('登録番号がどこにも無ければ、下書きをそのまま（同じオブジェクトで）返す', () => {
    const draft = draftOf({ raw_text: '合計 1,000円' })
    expect(applyShopAlias(draft)).toBe(draft)
  })

  it('寄せる前の実装と、同じ入力の表で同じ結果になる', () => {
    const drafts: ReceiptDraft[] = [
      draftOf({ registration_no: 'T2290801007056' }),
      draftOf({ registration_no: 'T9999999999999' }),
      draftOf({ registration_no: 'T9999999999999', shop_learned: true }),
      draftOf({ registration_no: 'T2290801007056', shop: null }),
      draftOf({ raw_text: 'T2290801007056' }),
      draftOf({ raw_text: '登録番号 T 2290801007056' }),
      draftOf({ raw_text: '登録番号 Ｔ２２９０８０１００７０５６' }),
      draftOf({ raw_text: 'T0000000000001 / T2290801007056' }), // 最初に見つかった番号だけを使う
      draftOf({ raw_text: 'T229080100705' }), // 12 桁：番号ではない
      draftOf({ raw_text: '' }),
      draftOf({ registration_no: 'T2290801007056', raw_text: 'T0000000000001' }), // AI が読めた番号を優先
      draftOf({ registration_no: '', raw_text: 'T2290801007056' }), // 空文字は読めた番号ではないが ?? は空文字を通す（今までどおり）
    ]
    for (const d of drafts) {
      expect(applyShopAlias(d)).toEqual(referenceApplyShopAlias(d))
    }
  })
})
