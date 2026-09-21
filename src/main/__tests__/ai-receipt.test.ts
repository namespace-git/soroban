import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ai-receipt.ts は electron（safeStorage）に依存する。テストでは実際の暗号を通さず、
// 文字列を往復させるだけのダミーに差し替える（実装が encryptString/decryptString の
// 戻り値をそのまま setting に保存・復号する前提を検証できればよい）。
// db.ts 自身も app.getPath を参照するため合わせて潰す
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!s.startsWith('enc:')) throw new Error('復号できません')
      return s.slice('enc:'.length)
    },
  },
}))

import * as db from '../db'
import * as ai from '../ai-receipt'

// 実際のネットワークには一切出ない。fetch はテストごとに差し替える
let mockFetch: ReturnType<typeof vi.fn>

let tmpDir: string
let imagePath: string

beforeEach(() => {
  db.initDb(':memory:')
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
  tmpDir = mkdtempSync(join(tmpdir(), 'soroban-ai-receipt-'))
  imagePath = join(tmpDir, 'receipt.png')
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // 中身はダミー（fetchをモックするので実画像である必要はない）
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  rmSync(tmpDir, { recursive: true, force: true })
})

function geminiResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
    text: async () => '',
  }
}

function geminiHttpError(status: number, body = '') {
  return { ok: false, status, json: async () => ({}), text: async () => body }
}

/** Google風のエラーJSON（{ error: { code, message, status, details } }）を返すfetch応答 */
function geminiApiError(status: number, message: string, opts: { status_?: string; reason?: string } = {}) {
  const error: any = { code: status, message }
  if (opts.status_) error.status = opts.status_
  if (opts.reason) {
    error.details = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: opts.reason }]
  }
  const body = JSON.stringify({ error })
  return { ok: false, status, json: async () => ({}), text: async () => body }
}

/** 思考partが混じったcandidates応答（partsの最初はthought:trueで本文はその後） */
function geminiResponseWithThought(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'うーん、これはレシートですね……' },
            { text: JSON.stringify(payload) },
          ],
        },
      }],
    }),
    text: async () => '',
  }
}

describe('APIキー・モデルの設定', () => {
  it('保存していなければ configured は false', () => {
    expect(ai.getAiStatus()).toEqual({ configured: false, model: 'gemini-2.5-pro', safe_storage: true })
  })

  it('setGeminiApiKeyで保存するとconfiguredがtrueになる。nullで外すとfalseに戻る', () => {
    ai.setGeminiApiKey('secret-key')
    expect(ai.getAiStatus().configured).toBe(true)
    ai.setGeminiApiKey(null)
    expect(ai.getAiStatus().configured).toBe(false)
  })

  it('setAiModelで既定から変えられる。空文字を渡すと既定（gemini-2.5-pro）に戻る', () => {
    ai.setAiModel('gemini-flash-latest')
    expect(ai.getAiStatus().model).toBe('gemini-flash-latest')
    ai.setAiModel('')
    expect(ai.getAiStatus().model).toBe('gemini-2.5-pro')
  })

  it('db.getSettings()の戻りには暗号化済みキーがそのまま含まれる（index.tsのgetSettingsハンドラはdb.getSettings()を直接返すため、ai-receipt.tsの外で漏れる。ここでは修正できない範囲として記録）', () => {
    ai.setGeminiApiKey('secret-key')
    expect(db.getSettings()).toHaveProperty('gemini_api_key_enc')
  })
})

describe('readReceiptWithGemini（fetchをモック）', () => {
  it('キー未設定なら設定を促すエラー', async () => {
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('AI 読み取りの設定がありません')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('正常な応答をReceiptDraftへ変換する（単価はamount/quantityから逆算、box_2dも変換）', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiResponse({
      shop: 'ダイソー 川崎駅前店',
      registration_no: 'T1234567890123',
      date: '2026-09-15',
      total: 880,
      tax: 80,
      lines: [
        // unit_priceは実際と違う値を混ぜる。amount/quantityから計算し直すので無視されるはず
        { name: 'ビニール袋 100枚', unit_price: 999, quantity: 1, amount: 110, category: 'packaging', box_2d: [10, 20, 30, 40] },
        { name: 'OPP袋 A4', unit_price: 999, quantity: 2, amount: 220, category: 'packaging' },
        // 割り切れない：金額そのもの・数量1にフォールバック
        { name: '緩衝材', unit_price: 999, quantity: 3, amount: 100, category: 'noidea' },
      ],
      boxes: { shop: [0, 0, 50, 200], date: null, total: [900, 0, 950, 200] },
      warnings: ['店名の読み取りに自信がありません'],
    }))

    const draft = await ai.readReceiptWithGemini(imagePath)

    expect(draft.shop).toBe('ダイソー 川崎駅前店')
    expect(draft.registration_no).toBe('T1234567890123')
    expect(draft.shop_learned).toBe(false)
    expect(draft.occurred_at).toBe('2026-09-15')
    expect(draft.total).toBe(880)
    expect(draft.tax).toBe(80)
    expect(draft.confidence).toBe(80)
    expect(draft.warnings).toEqual(['店名の読み取りに自信がありません'])

    expect(draft.lines[0]).toEqual({ name: 'ビニール袋 100枚', unit_price: 110, quantity: 1, category: 'packaging', box: [10, 20, 30, 40] })
    expect(draft.lines[1]).toEqual({ name: 'OPP袋 A4', unit_price: 110, quantity: 2, category: 'packaging' })
    // categoryが不正な値（noidea）は落ちる
    expect(draft.lines[2]).toEqual({ name: '緩衝材', unit_price: 100, quantity: 1 })

    expect(draft.boxes).toEqual({ shop: [0, 0, 50, 200], date: null, total: [900, 0, 950, 200] })

    // リクエストの形（URL・ヘッダ・本文）
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    expect(opts.headers['x-goog-api-key']).toBe('secret-key')
    const body = JSON.parse(opts.body)
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe('image/png')
    expect(typeof body.contents[0].parts[0].inline_data.data).toBe('string')
    expect(body.contents[0].parts[1].text).toContain('box_2d')
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  })

  it('不正なbox_2d（要素数が違う・数字でない）はnullにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiResponse({
      lines: [
        { name: 'A', quantity: 1, amount: 100, box_2d: [1, 2, 3] },
        { name: 'B', quantity: 1, amount: 100, box_2d: ['a', 'b', 'c', 'd'] },
        { name: 'C', quantity: 1, amount: 100, box_2d: [-10, 20, 1200, 40] },
      ],
      warnings: [],
    }))

    const draft = await ai.readReceiptWithGemini(imagePath)
    expect(draft.lines[0].box).toBeUndefined()
    expect(draft.lines[1].box).toBeUndefined()
    // 範囲外は0〜1000にクランプする
    expect(draft.lines[2].box).toEqual([0, 20, 1000, 40])
  })

  it('401はAPIキーが無効・権限なしというエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(401, 'Request had invalid authentication credentials.'))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('API キーが無効か、権限がありません')
  })

  it('403もAPIキーが無効・権限なしというエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(403, 'Permission denied'))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('API キーが無効か、権限がありません')
  })

  it('429は無料枠の上限というエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiHttpError(429))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('無料枠の上限に達しました')
  })

  it('400でAPI_KEY_INVALIDならAPIキーが無効というエラーにする（無効なキーでも400が返る）', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(400, 'API key not valid. Please pass a valid API key.', {
      status_: 'INVALID_ARGUMENT',
      reason: 'API_KEY_INVALID',
    }))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('API キーが無効です（AI Studio で作り直してください）')
  })

  it('400でも理由がAPI_KEY_INVALID以外なら要求を拒否された旨のエラーにする（理由の文言を含む）', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(400, 'Request contains an invalid argument.', {
      status_: 'INVALID_ARGUMENT',
    }))
    const err = await ai.readReceiptWithGemini(imagePath).catch((e) => e)
    expect(err.message).toContain('Gemini に要求を拒否されました（400）')
    expect(err.message).toContain('Request contains an invalid argument')
  })

  it('404はモデル名を含むエラーにする', async () => {
    ai.setAiModel('gemini-nope')
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(404, 'models/gemini-nope is not found for API version v1beta'))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('モデル「gemini-nope」が見つかりません')
  })

  it('5xxはGemini側の障害というエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(503, 'The service is currently unavailable.'))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('Gemini 側の障害です（503）')
  })

  it('思考partが混じっていても本文のtextを取り出せる', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiResponseWithThought({ lines: [], warnings: [] }))
    const draft = await ai.readReceiptWithGemini(imagePath)
    expect(draft.lines).toEqual([])
  })

  it('タイムアウト（60秒）はネットに接続できませんというエラーにする', async () => {
    vi.useFakeTimers()
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockImplementation((_url: string, opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))

    const promise = ai.readReceiptWithGemini(imagePath)
    const expectation = expect(promise).rejects.toThrow('ネットに接続できません')
    await vi.advanceTimersByTimeAsync(60_000)
    await expectation
  })

  it('ネットワークエラー（fetch failed）もネットに接続できませんというエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('ネットに接続できません')
  })

  it('応答がJSONとして壊れていれば一般的なエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{not json' }] } }] }),
      text: async () => '',
    })
    await expect(ai.readReceiptWithGemini(imagePath)).rejects.toThrow('AI の応答を読めませんでした')
  })

  it('HEIC画像は読めないというエラーにする', async () => {
    ai.setGeminiApiKey('secret-key')
    const heicPath = join(tmpDir, 'receipt.heic')
    writeFileSync(heicPath, Buffer.from([0x00]))
    await expect(ai.readReceiptWithGemini(heicPath)).rejects.toThrow('HEIC は読めません')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('testGemini', () => {
  it('疎通できればok:true', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiResponse('ok'))
    const result = await ai.testGemini()
    expect(result.ok).toBe(true)
  })

  it('キー未設定ならok:falseで理由が返る', async () => {
    const result = await ai.testGemini()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('設定がありません')
  })

  it('401ならok:falseでAPIキーが無効・権限なしの文言', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(401, 'Request had invalid authentication credentials.'))
    const result = await ai.testGemini()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API キーが無効か、権限がありません（401）')
  })

  it('400でAPI_KEY_INVALIDならok:falseでAPIキーが無効の文言（無効なキーは400で返るため）', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiApiError(400, 'API key not valid. Please pass a valid API key.', {
      status_: 'INVALID_ARGUMENT',
      reason: 'API_KEY_INVALID',
    }))
    const result = await ai.testGemini()
    expect(result).toEqual({ ok: false, message: 'API キーが無効です（AI Studio で作り直してください）' })
  })

  it('疎通確認のリクエストは軽量化のためmaxOutputTokensを指定する', async () => {
    ai.setGeminiApiKey('secret-key')
    mockFetch.mockResolvedValue(geminiResponse('ok'))
    await ai.testGemini()
    const [, opts] = mockFetch.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.generationConfig.maxOutputTokens).toBe(16)
  })
})
