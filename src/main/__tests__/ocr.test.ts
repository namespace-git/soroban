import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// ocr.ts は electron（app.getPath / app.isPackaged）に依存する。テストでは同梱の
// tessdata をそのまま使うため SOROBAN_TESSDATA でパスを渡す（ネットには出ない）
vi.mock('electron', () => ({
  app: {
    getPath: () => __dirname,
    isPackaged: false,
    getAppPath: () => __dirname,
  },
}))

const __dirname = dirname(fileURLToPath(import.meta.url))

process.env.SOROBAN_TESSDATA = join(__dirname, '..', '..', '..', 'resources', 'tessdata')

const { recognizeImage } = await import('../ocr')
const { parseReceiptText } = await import('../receipt-parse')

describe('recognizeImage（実際にtesseract.jsで読む。初回はモデル展開で数秒かかる）', () => {
  it('検証用レシート画像からテキストを読み取り、下書きに落とせる', async () => {
    const imagePath = join(__dirname, 'fixtures', 'receipt-sample.png')
    const { text, confidence } = await recognizeImage(imagePath)

    expect(text).toContain('ダイソー')
    expect(text).toMatch(/合計/)
    expect(text).toContain('880')
    expect(confidence).toBeGreaterThan(0)

    const draft = parseReceiptText(text)
    expect(draft.total).toBe(880)
    expect(draft.lines.length).toBeGreaterThanOrEqual(3)
    expect(draft.occurred_at).toBe('2026-09-15')
  }, 60_000)
})
