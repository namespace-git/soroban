import { beforeEach, describe, expect, it, vi } from 'vitest'

// 17TRACK 公式 API（track17.ts）を叩く「段取り役」のテスト。実際のネットワークには
// 一切出ない：track17 / db / electron（safeStorage）をすべてモックする。
// 最重要の観点は「応答に無かった番号は触らない」（別の番号の結果を書き込む事故防止）と、
// 「checkTrackingBatch は絶対に throw しない」（取り込み全体を落とさない）

const state = vi.hoisted(() => ({
  encryptAvailable: true,
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.encryptAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}))

vi.mock('../db', () => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  trackingRegisterCandidates: vi.fn(() => []),
  markTrackingRegistered: vi.fn(),
  trackingCheckCandidates: vi.fn(() => []),
  trackingCounts: vi.fn(() => ({ unregistered: 0, watching: 0 })),
  getPurchaseTracking: vi.fn(),
  applyTrackingResult: vi.fn(() => true),
}))

vi.mock('../track17', () => ({
  registerNumbers: vi.fn(),
  getTrackInfo: vi.fn(),
  track17Fulfillment: vi.fn(),
  track17Label: vi.fn((status: string) => `label:${status}`),
  Track17Error: class Track17Error extends Error {
    status: number
    apiCode: number | null
    constructor(message: string, status = 0, apiCode: number | null = null) {
      super(message)
      this.name = 'Track17Error'
      this.status = status
      this.apiCode = apiCode
    }
  },
}))

import {
  checkTracking, checkTrackingBatch, getTrackingApiStatus, setTrack17ApiKey,
} from '../collector-tracking'
import * as db from '../db'
import { getTrackInfo, registerNumbers, track17Fulfillment, Track17Error } from '../track17'

const SETTING_KEY = 'track17_api_key_enc'

beforeEach(() => {
  vi.clearAllMocks()
  state.encryptAvailable = true
  vi.mocked(db.getSettings).mockReturnValue({})
  vi.mocked(db.trackingRegisterCandidates).mockReturnValue([])
  vi.mocked(db.trackingCheckCandidates).mockReturnValue([])
  vi.mocked(db.applyTrackingResult).mockReturnValue(true)
})

describe('setTrack17ApiKey / getTrackingApiStatus', () => {
  it('キーを暗号化して保存する', () => {
    setTrack17ApiKey('secret-key')
    expect(db.setSetting).toHaveBeenCalledWith(SETTING_KEY, expect.any(String))
    const saved = vi.mocked(db.setSetting).mock.calls[0][1]
    expect(saved).not.toContain('secret-key')
  })

  it('null で削除する', () => {
    setTrack17ApiKey(null)
    expect(db.setSetting).toHaveBeenCalledWith(SETTING_KEY, '')
  })

  it('safeStorage が使えない環境では保存を断る', () => {
    state.encryptAvailable = false
    expect(() => setTrack17ApiKey('secret-key')).toThrow('この環境では安全に保存できません')
    expect(db.setSetting).not.toHaveBeenCalled()
  })

  it('getTrackingApiStatus はキーそのものを含まない', () => {
    vi.mocked(db.getSettings).mockReturnValue({ [SETTING_KEY]: Buffer.from('enc:secret-key').toString('base64') })
    vi.mocked(db.trackingCounts).mockReturnValue({ unregistered: 2, watching: 3 })

    const status = getTrackingApiStatus()

    expect(status).toEqual({ configured: true, safe_storage: true, unregistered: 2, watching: 3 })
    expect(JSON.stringify(status)).not.toContain('secret-key')
  })
})

describe('checkTrackingBatch', () => {
  it('キーが無ければ何もしない（登録も問い合わせも呼ばれず、stopped は null）', async () => {
    vi.mocked(db.trackingRegisterCandidates).mockReturnValue([{ id: 'p1', tracking_number: 'TRK-1' }])
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([{ id: 'p2', tracking_number: 'TRK-2' }])

    const result = await checkTrackingBatch()

    expect(result).toEqual({ registered: 0, checked: 0, delivered: 0, failed: 0, stopped: null })
    expect(registerNumbers).not.toHaveBeenCalled()
    expect(getTrackInfo).not.toHaveBeenCalled()
  })

  function setKey(): void {
    vi.mocked(db.getSettings).mockReturnValue({
      [SETTING_KEY]: Buffer.from('enc:secret-key').toString('base64'),
    })
  }

  it('未登録のものだけ登録し、accepted の分だけ markTrackingRegistered が呼ばれる（rejected には印を付けない）', async () => {
    setKey()
    vi.mocked(db.trackingRegisterCandidates).mockReturnValue([
      { id: 'p1', tracking_number: 'TRK-1' },
      { id: 'p2', tracking_number: 'TRK-2' },
    ])
    vi.mocked(registerNumbers).mockResolvedValue({
      accepted: ['TRK-1'],
      rejected: [{ number: 'TRK-2', code: 1, message: 'bad' }],
    })

    const result = await checkTrackingBatch()

    expect(registerNumbers).toHaveBeenCalledWith('secret-key', ['TRK-1', 'TRK-2'])
    expect(db.markTrackingRegistered).toHaveBeenCalledWith(['p1'])
    expect(result.registered).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('Delivered が返ったら applyTrackingResult に delivered と到着日が渡り、delivered が 1 になる', async () => {
    setKey()
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([{ id: 'p1', tracking_number: 'TRK-1' }])
    vi.mocked(getTrackInfo).mockResolvedValue([
      { number: 'TRK-1', status: 'Delivered', subStatus: null, deliveredAt: '2026-09-20', latestEventAt: null, error: null },
    ])
    vi.mocked(track17Fulfillment).mockReturnValue('delivered')

    const result = await checkTrackingBatch()

    expect(db.applyTrackingResult).toHaveBeenCalledWith('p1', expect.objectContaining({
      fulfillment: 'delivered',
      delivered_at: '2026-09-20',
    }))
    expect(result.delivered).toBe(1)
    expect(result.checked).toBe(1)
  })

  it('DeliveryFailure で到着済にならない', async () => {
    setKey()
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([{ id: 'p1', tracking_number: 'TRK-1' }])
    vi.mocked(getTrackInfo).mockResolvedValue([
      { number: 'TRK-1', status: 'DeliveryFailure', subStatus: null, deliveredAt: null, latestEventAt: null, error: null },
    ])
    vi.mocked(track17Fulfillment).mockReturnValue('shipped')

    const result = await checkTrackingBatch()

    expect(db.applyTrackingResult).toHaveBeenCalledWith('p1', expect.objectContaining({
      fulfillment: 'shipped',
      delivered_at: null,
    }))
    expect(result.delivered).toBe(0)
  })

  it('応答に無かった番号は applyTrackingResult を呼ばない', async () => {
    setKey()
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([
      { id: 'p1', tracking_number: 'TRK-1' },
      { id: 'p2', tracking_number: 'TRK-2' },
    ])
    vi.mocked(getTrackInfo).mockResolvedValue([
      { number: 'TRK-1', status: 'InTransit', subStatus: null, deliveredAt: null, latestEventAt: null, error: null },
      // TRK-2 は応答に含まれない
    ])
    vi.mocked(track17Fulfillment).mockReturnValue('shipped')

    const result = await checkTrackingBatch()

    expect(db.applyTrackingResult).toHaveBeenCalledTimes(1)
    expect(db.applyTrackingResult).toHaveBeenCalledWith('p1', expect.anything())
    expect(result.checked).toBe(1)
  })

  it('error 付きの応答で failed が増え、tracking_status に理由が入り fulfillment は null', async () => {
    setKey()
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([{ id: 'p1', tracking_number: 'TRK-1' }])
    vi.mocked(getTrackInfo).mockResolvedValue([
      { number: 'TRK-1', status: 'Unknown', subStatus: null, deliveredAt: null, latestEventAt: null, error: { code: 1, message: 'まだデータがありません' } },
    ])

    const result = await checkTrackingBatch()

    expect(db.applyTrackingResult).toHaveBeenCalledWith('p1', {
      status_text: 'まだデータがありません',
      fulfillment: null,
      delivered_at: null,
    })
    expect(result.failed).toBe(1)
    expect(result.checked).toBe(0)
  })

  it('Track17Error で打ち切り、stopped に日本語が入り、例外は外に出ない', async () => {
    setKey()
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([{ id: 'p1', tracking_number: 'TRK-1' }])
    vi.mocked(getTrackInfo).mockRejectedValue(new Track17Error('17TRACK の API キーが正しくありません', 401, -18010002))

    const result = await checkTrackingBatch()

    expect(result.stopped).toBe('17TRACK の API キーが正しくありません')
    expect(result.checked).toBe(0)
  })
})

describe('checkTracking', () => {
  it('追跡番号が無ければ null', async () => {
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: null, fulfillment: null, tracking_status: null, tracking_registered_at: null,
    })

    const result = await checkTracking('purchase-1')

    expect(result).toBeNull()
    expect(getTrackInfo).not.toHaveBeenCalled()
  })

  it('仕入自体が無ければ null', async () => {
    vi.mocked(db.getPurchaseTracking).mockReturnValue(null)

    const result = await checkTracking('no-such-purchase')

    expect(result).toBeNull()
  })

  it('既に到着済なら問い合わせず保存済みを返す（getTrackInfo が呼ばれない）', async () => {
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: 'TRK-1', fulfillment: 'delivered', tracking_status: '配達完了', tracking_registered_at: '2026-01-01',
    })

    const result = await checkTracking('purchase-delivered')

    expect(result).toEqual({ status_text: '配達完了', delivered_at: null })
    expect(getTrackInfo).not.toHaveBeenCalled()
    expect(db.applyTrackingResult).not.toHaveBeenCalled()
  })

  it('未登録なら先に registerNumbers が呼ばれてから getTrackInfo が呼ばれる', async () => {
    vi.mocked(db.getSettings).mockReturnValue({
      [SETTING_KEY]: Buffer.from('enc:secret-key').toString('base64'),
    })
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: 'TRK-1', fulfillment: null, tracking_status: null, tracking_registered_at: null,
    })
    vi.mocked(registerNumbers).mockResolvedValue({ accepted: ['TRK-1'], rejected: [] })
    vi.mocked(getTrackInfo).mockResolvedValue([
      { number: 'TRK-1', status: 'InTransit', subStatus: null, deliveredAt: null, latestEventAt: null, error: null },
    ])
    vi.mocked(track17Fulfillment).mockReturnValue('shipped')

    const result = await checkTracking('purchase-1')

    expect(registerNumbers).toHaveBeenCalledWith('secret-key', ['TRK-1'])
    expect(db.markTrackingRegistered).toHaveBeenCalledWith(['purchase-1'])
    expect(getTrackInfo).toHaveBeenCalledWith('secret-key', ['TRK-1'])
    expect(result?.status_text).toBe('label:InTransit') // track17Label のモック（`label:${status}`）がそのまま返ること
  })

  it('キーが無ければ人に読める日本語の Error を投げる', async () => {
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: 'TRK-1', fulfillment: null, tracking_status: null, tracking_registered_at: '2026-01-01',
    })

    await expect(checkTracking('purchase-1')).rejects.toThrow('17TRACK の設定がありません')
  })

  it('Track17Error はそのまま投げる（日本語メッセージ）', async () => {
    vi.mocked(db.getSettings).mockReturnValue({
      [SETTING_KEY]: Buffer.from('enc:secret-key').toString('base64'),
    })
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: 'TRK-1', fulfillment: null, tracking_status: null, tracking_registered_at: '2026-01-01',
    })
    vi.mocked(getTrackInfo).mockRejectedValue(new Track17Error('17TRACK が混み合っています', 429, null))

    await expect(checkTracking('purchase-1')).rejects.toThrow('17TRACK が混み合っています')
  })

  it('応答にこの番号が無ければ、次の一歩まで書かれた日本語の Error を投げる', async () => {
    vi.mocked(db.getSettings).mockReturnValue({
      [SETTING_KEY]: Buffer.from('enc:secret-key').toString('base64'),
    })
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: 'TRK-1', fulfillment: null, tracking_status: null, tracking_registered_at: '2026-01-01',
    })
    vi.mocked(getTrackInfo).mockResolvedValue([])

    await expect(checkTracking('purchase-1')).rejects.toThrow('少し待ってから')
  })

  it('復号に失敗しても「設定なし」に丸められ、ログにキーは出ない', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const electron = await import('electron')
    const decryptSpy = vi.spyOn(electron.safeStorage, 'decryptString').mockImplementation(() => {
      throw new Error('復号に失敗（キーの中身は含まない）')
    })
    vi.mocked(db.getSettings).mockReturnValue({
      [SETTING_KEY]: Buffer.from('enc:secret-key').toString('base64'),
    })
    vi.mocked(db.getPurchaseTracking).mockReturnValue({
      tracking_number: 'TRK-1', fulfillment: null, tracking_status: null, tracking_registered_at: '2026-01-01',
    })

    await expect(checkTracking('purchase-1')).rejects.toThrow('17TRACK の設定がありません')

    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret-key')
    }
    errorSpy.mockRestore()
    decryptSpy.mockRestore()
  })
})
