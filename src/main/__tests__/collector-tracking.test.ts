import { beforeEach, describe, expect, it, vi } from 'vitest'

// checkTracking / checkTrackingBatch のフルフロー分岐（対象0件・追跡番号なし）を
// テストするための、実行のたびに差し替え可能な状態。ウィンドウを開いたかどうかは
// windowsCreated で数える（開いてはいけない場面で開いていないかを確かめる）
const state = vi.hoisted(() => ({
  windowsCreated: 0,
}))

// collector-tracking.ts は electron（BrowserWindow）と collector.ts（同じく electron 依存）
// に依存する。collector-mellojoy.test.ts と同じ流儀で最小限のモックを用意する
vi.mock('electron', () => {
  class FakeBrowserWindow {
    private destroyedFlag = false
    webContents = {
      setUserAgent: () => {},
      executeJavaScript: async () => ({ progress: '', body: '' }),
    }

    constructor() {
      state.windowsCreated++
    }

    loadURL(): Promise<void> {
      return Promise.resolve()
    }

    isDestroyed(): boolean {
      return this.destroyedFlag
    }

    destroy(): void {
      this.destroyedFlag = true
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => '' },
    session: { fromPartition: () => ({ setUserAgent: () => {} }) },
  }
})

// randomWait（件の間の待ち）を即時にし、テストを遅くしない
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

// db.ts はテストごとに呼び出しを検証したいので個別にモックする
vi.mock('../db', () => ({
  getPurchaseTrackingNumber: vi.fn(),
  applyTrackingResult: vi.fn(() => true),
  trackingCheckCandidates: vi.fn(() => []),
}))

import {
  checkTracking, checkTrackingBatch, isTrackingBlocked, parseTrackingProgress,
  trackingFulfillment, trackingUrl,
} from '../collector-tracking'
import * as db from '../db'

beforeEach(() => {
  vi.clearAllMocks()
  state.windowsCreated = 0
})

describe('parseTrackingProgress', () => {
  it('配達完了・Time of delivery あり', () => {
    const text = '配達完了\n-\nTime of delivery:\n2026-09-17'
    expect(parseTrackingProgress(text)).toEqual({ statusText: '配達完了', deliveredAt: '2026-09-17' })
  })

  it('輸送中だけ（到着日なし）', () => {
    expect(parseTrackingProgress('輸送中')).toEqual({ statusText: '輸送中', deliveredAt: null })
  })

  it('空文字は両方 null', () => {
    expect(parseTrackingProgress('')).toEqual({ statusText: null, deliveredAt: null })
  })

  it('配達完了だが Time of delivery: が無い場合、本文中の最初の日付を拾う', () => {
    const text = '配達完了\n-\n2026-09-17'
    expect(parseTrackingProgress(text)).toEqual({ statusText: '配達完了', deliveredAt: '2026-09-17' })
  })
})

describe('trackingFulfillment', () => {
  it('配達完了 → delivered', () => {
    expect(trackingFulfillment('配達完了')).toBe('delivered')
  })

  it('未配達 → shipped（delivered にならないこと）', () => {
    expect(trackingFulfillment('未配達')).toBe('shipped')
  })

  it('情報が見つかりません → null', () => {
    expect(trackingFulfillment('情報が見つかりません')).toBeNull()
  })

  it('知らない言葉 → null', () => {
    expect(trackingFulfillment('謎のステータス')).toBeNull()
  })

  it('null → null', () => {
    expect(trackingFulfillment(null)).toBeNull()
  })
})

describe('isTrackingBlocked', () => {
  it('ファイヤーウォールを含む本文で true', () => {
    expect(isTrackingBlocked('アクセスがファイヤーウォールによって拒否されました')).toBe(true)
  })

  it('普通の追跡結果の本文で false', () => {
    expect(isTrackingBlocked('配達完了\nTime of delivery:\n2026-09-17\n配送情報の詳細です。')).toBe(false)
  })
})

describe('trackingUrl', () => {
  it('番号から17TRACKのURLを組み立てる', () => {
    expect(trackingUrl('SF6047853859809')).toBe('https://t.17track.net/ja#nums=SF6047853859809')
  })
})

describe('checkTracking', () => {
  it('追跡番号が無ければ null を返し、applyTrackingResult を呼ばない', async () => {
    vi.mocked(db.getPurchaseTrackingNumber).mockReturnValue(null)

    const result = await checkTracking('purchase-1')

    expect(result).toBeNull()
    expect(db.applyTrackingResult).not.toHaveBeenCalled()
    expect(state.windowsCreated).toBe(0)
  })
})

describe('checkTrackingBatch', () => {
  it('対象0件ならウィンドウを開かない', async () => {
    vi.mocked(db.trackingCheckCandidates).mockReturnValue([])

    const result = await checkTrackingBatch()

    expect(result).toEqual({ checked: 0, delivered: 0, failed: 0, blocked: false })
    expect(state.windowsCreated).toBe(0)
  })
})
