import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTrackInfo, registerNumbers, track17Fulfillment, track17Label,
  Track17Error, type Track17Status,
} from '../track17'

// 実際のネットワークには一切出ない。fetch はテストごとに差し替える（ai-receipt.test.ts と同じ流儀）
let mockFetch: ReturnType<typeof vi.fn>

const API_KEY = 'super-secret-17track-key-1234567890'

beforeEach(() => {
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 17TRACK の成功応答（HTTP 200・code 0） */
function apiOk(data: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) }
}

/** HTTP は成功だが code が0でない（キー違い等） */
function apiCodeError(status: number, code: number, message = '') {
  return { ok: status < 400, status, text: async () => JSON.stringify({ code, data: { errors: [{ message }] } }) }
}

/** HTTPレベルのエラー（本文は問わない） */
function httpError(status: number, body = '') {
  return { ok: false, status, text: async () => body }
}

// ------------------------------------------------------------
// track17Fulfillment
// ------------------------------------------------------------

describe('track17Fulfillment', () => {
  it('Delivered → delivered', () => {
    expect(track17Fulfillment('Delivered')).toBe('delivered')
  })

  it('InTransit / OutForDelivery / AvailableForPickup / DeliveryFailure / Exception → shipped', () => {
    const shippedLike: Track17Status[] = ['InTransit', 'OutForDelivery', 'AvailableForPickup', 'DeliveryFailure', 'Exception']
    for (const status of shippedLike) {
      expect(track17Fulfillment(status)).toBe('shipped')
    }
  })

  it('DeliveryFailure は delivered にならない（配達失敗を到着扱いしない）', () => {
    expect(track17Fulfillment('DeliveryFailure')).not.toBe('delivered')
  })

  it('InfoReceived → pending', () => {
    expect(track17Fulfillment('InfoReceived')).toBe('pending')
  })

  it('NotFound / Expired / Unknown → null（状態を変えない）', () => {
    expect(track17Fulfillment('NotFound')).toBeNull()
    expect(track17Fulfillment('Expired')).toBeNull()
    expect(track17Fulfillment('Unknown')).toBeNull()
  })
})

// ------------------------------------------------------------
// track17Label
// ------------------------------------------------------------

describe('track17Label', () => {
  it('主要な状態を日本語にする', () => {
    expect(track17Label('Delivered')).toBe('配達完了')
    expect(track17Label('InTransit')).toBe('輸送中')
    expect(track17Label('OutForDelivery')).toBe('配達中')
    expect(track17Label('AvailableForPickup')).toBe('受け取り待ち')
    expect(track17Label('DeliveryFailure')).toBe('配達できず')
    expect(track17Label('Exception')).toBe('異常あり')
    expect(track17Label('InfoReceived')).toBe('受付済み')
    expect(track17Label('NotFound')).toBe('情報が見つかりません')
    expect(track17Label('Expired')).toBe('期限切れ')
    expect(track17Label('Unknown')).toBe('不明')
  })

  it('分かる sub_status は括弧で理由を添える', () => {
    expect(track17Label('Exception', 'Exception_Lost')).toBe('異常あり（紛失）')
  })

  it('知らない sub_status では英語を漏らさない（括弧を付けない）', () => {
    expect(track17Label('Exception', 'Exception_SomethingNew')).toBe('異常あり')
    expect(track17Label('InTransit', 'InTransit_PickedUp')).toBe('輸送中')
  })

  it('sub_status が無ければそのまま', () => {
    expect(track17Label('Delivered', null)).toBe('配達完了')
    expect(track17Label('Delivered')).toBe('配達完了')
  })
})

// ------------------------------------------------------------
// getTrackInfo（到着日の抽出・番号の突き合わせ・バッチ分割）
// ------------------------------------------------------------

describe('getTrackInfo：到着日（JSTのローカル日付）の抽出', () => {
  it('providers[].events[] の Delivered_Other の time_raw から取れる', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{
        number: 'A1',
        track_info: {
          latest_status: { status: 'Delivered', sub_status: 'Delivered_Other' },
          latest_event: { time_iso: '2024-01-01T00:00:00Z' },
          tracking: { providers: [{ events: [{ sub_status: 'Delivered_Other', time_raw: '2024-05-01T10:00:00+09:00' }] }] },
        },
      }],
      rejected: [],
    }))

    const [result] = await getTrackInfo(API_KEY, ['A1'])
    expect(result.status).toBe('Delivered')
    expect(result.deliveredAt).toBe('2024-05-01')
  })

  it('Delivered_Other の event が無ければ latest_event の時刻を使う', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{
        number: 'A2',
        track_info: {
          latest_status: { status: 'Delivered' },
          latest_event: { time_iso: '2024-05-02T23:30:00Z' }, // UTC 23:30 → JST は翌日 08:30
        },
      }],
      rejected: [],
    }))

    const [result] = await getTrackInfo(API_KEY, ['A2'])
    expect(result.deliveredAt).toBe('2024-05-03')
  })

  it('UTC深夜（同日）がJSTでは翌日に繰り上がる境界を正しく日本時間で判定する', async () => {
    // UTC 2024-05-02T15:30:00Z は UTC 側ではまだ5/2だが、+9時間のJSTでは5/3の00:30になる。
    // ISO文字列を単純に slice(0,10) すると 2024-05-02 になってしまう事故を防ぐテスト
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{
        number: 'A3',
        track_info: {
          latest_status: { status: 'Delivered' },
          latest_event: { time_iso: '2024-05-02T15:30:00Z' },
        },
      }],
      rejected: [],
    }))

    const [result] = await getTrackInfo(API_KEY, ['A3'])
    expect(result.deliveredAt).toBe('2024-05-03')
  })

  it('status が Delivered でなければ、Delivered_Other の event があっても deliveredAt は null', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{
        number: 'A4',
        track_info: {
          latest_status: { status: 'InTransit' },
          tracking: { providers: [{ events: [{ sub_status: 'Delivered_Other', time_raw: '2024-05-01T10:00:00+09:00' }] }] },
        },
      }],
      rejected: [],
    }))

    const [result] = await getTrackInfo(API_KEY, ['A4'])
    expect(result.status).toBe('InTransit')
    expect(result.deliveredAt).toBeNull()
  })

  it('到着日の手がかりが何も無ければ null', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{ number: 'A5', track_info: { latest_status: { status: 'Delivered' } } }],
      rejected: [],
    }))

    const [result] = await getTrackInfo(API_KEY, ['A5'])
    expect(result.deliveredAt).toBeNull()
  })
})

describe('getTrackInfo：番号の突き合わせ（核心）', () => {
  it('応答に自分が問い合わせていない番号が混ざっていたら捨てる', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [
        { number: 'REQUESTED-1', track_info: { latest_status: { status: 'InTransit' } } },
        { number: 'NOT-REQUESTED-999', track_info: { latest_status: { status: 'Delivered' } } },
      ],
      rejected: [],
    }))

    const results = await getTrackInfo(API_KEY, ['REQUESTED-1'])
    expect(results).toHaveLength(1)
    expect(results[0].number).toBe('REQUESTED-1')
  })

  it('大文字小文字の違いだけは同一とみなす', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{ number: 'sf6047853859809', track_info: { latest_status: { status: 'InTransit' } } }],
      rejected: [],
    }))

    const results = await getTrackInfo(API_KEY, ['SF6047853859809'])
    expect(results).toHaveLength(1)
  })

  it('知らない状態文字列は Unknown に丸める（勝手に別の状態へ寄せない）', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [{ number: 'A6', track_info: { latest_status: { status: 'SomethingNew' } } }],
      rejected: [],
    }))

    const [result] = await getTrackInfo(API_KEY, ['A6'])
    expect(result.status).toBe('Unknown')
  })
})

describe('getTrackInfo：40件ずつのバッチ分割', () => {
  it('41件渡すと2回に分かれて呼ばれる（40件・1件）', async () => {
    const numbers = Array.from({ length: 41 }, (_, i) => `N${i}`)
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const requested: Array<{ number: string }> = JSON.parse(init.body)
      return apiOk({
        accepted: requested.map(r => ({ number: r.number, track_info: { latest_status: { status: 'InTransit' } } })),
        rejected: [],
      })
    })

    const results = await getTrackInfo(API_KEY, numbers)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const firstBatch = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    const secondBatch = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body)
    expect(firstBatch).toHaveLength(40)
    expect(secondBatch).toHaveLength(1)
    expect(results).toHaveLength(41)
  })
})

// ------------------------------------------------------------
// registerNumbers
// ------------------------------------------------------------

describe('registerNumbers', () => {
  it('-18019901（すでに登録済み）は accepted として扱う', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [],
      rejected: [{ number: 'X1', error: { code: -18019901, message: 'Already registered' } }],
    }))

    const result = await registerNumbers(API_KEY, ['X1'])
    expect(result.accepted).toEqual(['X1'])
    expect(result.rejected).toEqual([])
  })

  it('それ以外の rejected はそのまま rejected として返す', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({
      accepted: [],
      rejected: [{ number: 'X2', error: { code: -18019903, message: 'Carrier not found' } }],
    }))

    const result = await registerNumbers(API_KEY, ['X2'])
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([{ number: 'X2', code: -18019903, message: 'Carrier not found' }])
  })

  it('carrier を付けずに送る（自動判別に任せる）', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({ accepted: [{ number: 'X3' }], rejected: [] }))
    await registerNumbers(API_KEY, ['X3'])
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(body).toEqual([{ number: 'X3' }])
  })

  it('17token ヘッダーで認証する', async () => {
    mockFetch.mockResolvedValueOnce(apiOk({ accepted: [{ number: 'X4' }], rejected: [] }))
    await registerNumbers(API_KEY, ['X4'])
    const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(headers['17token']).toBe(API_KEY)
  })
})

// ------------------------------------------------------------
// エラー（日本語化・再試行方針・キーの非露出）
// ------------------------------------------------------------

describe('エラー', () => {
  it('-18010002（キーが違う）は日本語の案内で Track17Error になる。再試行はしない', async () => {
    mockFetch.mockResolvedValue(apiCodeError(200, -18010002, 'Invalid Sign'))

    await expect(getTrackInfo(API_KEY, ['A'])).rejects.toThrow(Track17Error)
    await expect(getTrackInfo(API_KEY, ['A'])).rejects.toThrow(/キー/)
    expect(mockFetch).toHaveBeenCalledTimes(2) // 上の2つの expect でそれぞれ1回ずつ。再試行していれば増える
  })

  it('HTTP 429 は混み合っている旨の日本語になり、再試行しない', async () => {
    mockFetch.mockResolvedValueOnce(httpError(429, 'Too Many Requests'))

    await expect(getTrackInfo(API_KEY, ['A'])).rejects.toThrow(/混み合って/)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('HTTP 500 は自動再試行のあと、一時的な障害という日本語になる', async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue(httpError(500, 'Internal Server Error'))

    const promise = getTrackInfo(API_KEY, ['A'])
    const expectation = expect(promise).rejects.toThrow(/一時的な障害/)
    await vi.advanceTimersByTimeAsync(2_000 + 5_000)
    await expectation
    expect(mockFetch).toHaveBeenCalledTimes(3) // 初回 + 再試行2回
  })

  it('応答がJSONでなければ「解釈できませんでした」という日本語になる', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'not json' })

    await expect(getTrackInfo(API_KEY, ['A'])).rejects.toThrow('17TRACK の応答を解釈できませんでした')
  })

  it('API キーはどのエラーメッセージにも含まれない', async () => {
    const cases = [
      apiCodeError(200, -18010002, 'Invalid Sign'),
      httpError(429, 'Too Many Requests'),
      httpError(401, API_KEY),
      { ok: true, status: 200, text: async () => 'not json' },
    ]
    for (const response of cases) {
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce(response)
      try {
        await getTrackInfo(API_KEY, ['A'])
        throw new Error('この分岐では必ず投げるはず')
      } catch (e) {
        expect(e).toBeInstanceOf(Track17Error)
        expect((e as Error).message).not.toContain(API_KEY)
      }
    }
  })
})
