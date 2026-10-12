import { beforeEach, describe, expect, it, vi } from 'vitest'

// 取り込み担当の窓（agent/service.ts の createAgentWindow）の安全まわりの配線：
//  - 窓を作る前に、窓と同じ partition へ権限のハンドラ（request・check）を付け、全部断る
//    （Electron はハンドラが無いと、カメラ・マイク・位置情報・通知・クリップボードを全部許可してしまう）
//  - window.open の外部リンクは、許可したホストの https だけ OS のブラウザに渡す（それ以外は何も開かない）
// electron は偽物に差し替える（窓は作らない・実 DB に触らない）。判定そのものは agent-mode.test.ts

type OpenHandler = (details: { url: string }) => { action: string }
type PermissionRequestHandler = (wc: unknown, permission: string, callback: (granted: boolean) => void) => void
type PermissionCheckHandler = () => boolean

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  const ses = {
    setPermissionRequestHandler: vi.fn(() => { calls.push('setPermissionRequestHandler') }),
    setPermissionCheckHandler: vi.fn(() => { calls.push('setPermissionCheckHandler') }),
  }
  const webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }
  const win = {
    webContents,
    on: vi.fn(),
    isDestroyed: () => false,
    loadURL: vi.fn(() => { calls.push('loadURL'); return Promise.resolve() }),
  }
  return {
    calls,
    ses,
    webContents,
    win,
    windowOptions: [] as Array<{ webPreferences: Record<string, unknown> }>,
    fromPartition: vi.fn((_name: string) => ses),
    openExternal: vi.fn(),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: { webPreferences: Record<string, unknown> }) {
      mocks.windowOptions.push(options)
      mocks.calls.push('new BrowserWindow')
      return mocks.win as unknown as object
    }
  },
  Menu: {},
  app: { getPath: () => '' },
  ipcMain: { on: vi.fn() },
  net: { fetch: vi.fn() },
  session: { fromPartition: mocks.fromPartition },
  shell: { openExternal: mocks.openExternal },
}))
// 収集・ログは窓の配線に関係しない（読み込むと実 DB のモジュールまで入るので空にする）
vi.mock('../applog', () => ({ log: vi.fn() }))
vi.mock('../collector', () => ({}))
vi.mock('../collector-mellojoy', () => ({}))
vi.mock('../collector-yahoo', () => ({}))

import { createAgentWindow } from '../agent/service'
import { AGENT_PARTITION } from '../agent/mode'

const ORIGIN = 'https://soroban.pages.dev'

beforeEach(() => {
  mocks.calls.length = 0
  mocks.windowOptions.length = 0
  mocks.ses.setPermissionRequestHandler.mockClear()
  mocks.ses.setPermissionCheckHandler.mockClear()
  mocks.webContents.setWindowOpenHandler.mockClear()
  mocks.openExternal.mockClear()
  mocks.fromPartition.mockClear()
  mocks.win.loadURL.mockClear()
})

describe('createAgentWindow：権限の要求は全部断る', () => {
  it('窓と同じ partition（persist:soroban-web）に、request と check の両方を、窓を作る前に付ける', () => {
    createAgentWindow(ORIGIN)

    expect(mocks.fromPartition).toHaveBeenCalledWith(AGENT_PARTITION)
    expect(mocks.windowOptions).toHaveLength(1)
    expect(mocks.windowOptions[0].webPreferences.partition).toBe(AGENT_PARTITION)

    expect(mocks.ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(mocks.ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    // 順番：ハンドラ → 窓 → Web 版を読み込む（読み込んだ後にはもう遅い）
    const order = mocks.calls
    expect(order.indexOf('setPermissionRequestHandler')).toBeLessThan(order.indexOf('new BrowserWindow'))
    expect(order.indexOf('setPermissionCheckHandler')).toBeLessThan(order.indexOf('new BrowserWindow'))
    expect(order.indexOf('new BrowserWindow')).toBeLessThan(order.indexOf('loadURL'))
  })

  it('付けた request のハンドラは、カメラ・マイク・位置情報・通知・クリップボードなど何を求められても断る', () => {
    createAgentWindow(ORIGIN)
    const request = mocks.ses.setPermissionRequestHandler.mock.calls[0] as unknown as [PermissionRequestHandler]
    for (const permission of [
      'media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'midi', 'fullscreen', 'openExternal',
    ]) {
      const callback = vi.fn()
      request[0](null, permission, callback)
      expect(callback, permission).toHaveBeenCalledWith(false)
      expect(callback, permission).not.toHaveBeenCalledWith(true)
    }
  })

  it('付けた check のハンドラは、何を聞かれても false', () => {
    createAgentWindow(ORIGIN)
    const check = mocks.ses.setPermissionCheckHandler.mock.calls[0] as unknown as [PermissionCheckHandler]
    expect(check[0]()).toBe(false)
  })
})

describe('createAgentWindow：window.open の外部リンクは許可したホストだけ OS のブラウザで開く', () => {
  function openHandler(): OpenHandler {
    createAgentWindow(ORIGIN)
    expect(mocks.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    return (mocks.webContents.setWindowOpenHandler.mock.calls[0] as unknown as [OpenHandler])[0]
  }

  it('メルカリ・Yahoo!フリマ・17TRACK の https は開く。窓は作らない（deny）', () => {
    const handler = openHandler()
    const urls = [
      'https://jp.mercari.com/item/m123456789',
      'https://jp.mercari.com/transaction/m123456789',
      'https://paypayfleamarket.yahoo.co.jp/item/z12345678',
      'https://paypayfleamarket-sec.yahoo.co.jp/item/z12345678/trade/seller',
      'https://t.17track.net/#nums=ABC123',
    ]
    for (const url of urls) {
      mocks.openExternal.mockClear()
      expect(handler({ url }), url).toEqual({ action: 'deny' })
      expect(mocks.openExternal, url).toHaveBeenCalledTimes(1)
      expect(mocks.openExternal, url).toHaveBeenCalledWith(url)
    }
  })

  it('許可していないホスト・http・file・javascript・about:blank・ユーザー名つきなどは何も開かない（それでも deny）', () => {
    const handler = openHandler()
    for (const url of [
      'https://evil.example/', 'https://jp.mercari.com.evil.example/', 'http://jp.mercari.com/item/m1', 'about:blank',
      'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'https://user:pw@jp.mercari.com/',
      'https://jp.mercari.com:8443/', 'https://github.com/namespace-git/soroban/releases/latest', '', 'not a url',
    ]) {
      expect(handler({ url }), url).toEqual({ action: 'deny' })
    }
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
