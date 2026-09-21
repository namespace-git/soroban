import { describe, expect, it, vi } from 'vitest'

// updater.ts は electron（app・shell）と electron-updater（autoUpdater）に依存する。
// ここで検証するのは依存しない純粋関数（compareVersions・toUpdateStatus）と、
// dev（未パッケージ）では確認しない、という分岐だけなので、両方潰しておく
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.0', isPackaged: false },
  shell: { openExternal: vi.fn() },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

import { checkForUpdate, compareVersions, toUpdateStatus } from '../updater'

describe('compareVersions', () => {
  it('新しい方が大きい', () => {
    expect(compareVersions('1.3.0', '1.2.0')).toBeGreaterThan(0)
  })

  it('同じなら0', () => {
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
  })

  it('古い方が小さい', () => {
    expect(compareVersions('1.2.0', '1.3.0')).toBeLessThan(0)
  })

  it('桁数が違っても比較できる（1.2 と 1.2.1）', () => {
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })

  it('先頭のv・プレリリース識別子は無視する', () => {
    expect(compareVersions('v1.3.0-beta.1', '1.2.0')).toBeGreaterThan(0)
  })
})

describe('toUpdateStatus', () => {
  const base = { current: '1.2.0', downloaded: false, canAutoInstall: true, url: 'https://example.com/releases/latest' }

  it('latestがcurrent以下ならnone（最新）', () => {
    const status = toUpdateStatus({ ...base, latest: '1.2.0', notes: 'note' })
    expect(status).toEqual({
      current: '1.2.0', state: 'none', latest: null, notes: null, url: null,
      canAutoInstall: true, message: null,
    })
  })

  it('latestが新しければavailable', () => {
    const status = toUpdateStatus({ ...base, latest: '1.3.0', notes: 'v1.3.0の変更点' })
    expect(status.state).toBe('available')
    expect(status.latest).toBe('1.3.0')
    expect(status.notes).toBe('v1.3.0の変更点')
    expect(status.url).toBe(base.url)
  })

  it('ダウンロード済みならdownloaded', () => {
    const status = toUpdateStatus({ ...base, latest: '1.3.0', notes: null, downloaded: true })
    expect(status.state).toBe('downloaded')
  })

  it('macOS（canAutoInstall=false）はそのままcanAutoInstallに反映する', () => {
    const status = toUpdateStatus({ ...base, latest: '1.3.0', notes: null, canAutoInstall: false })
    expect(status.canAutoInstall).toBe(false)
  })
})

describe('checkForUpdate（dev環境）', () => {
  it('未パッケージ（app.isPackaged=false）では確認しにnoneを返す', async () => {
    const status = await checkForUpdate()
    expect(status).toEqual({
      current: '1.2.0', state: 'none', latest: null, notes: null, url: null,
      canAutoInstall: process.platform === 'win32', message: '開発環境',
    })
  })
})
