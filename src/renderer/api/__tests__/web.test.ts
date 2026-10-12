// Web 版の window.soroban の包み（api/web.ts）と window.sorobanWeb の通信。
//   - 中身が変わる 4 本（exportCsv・openChannelPage・openTracking・collect）
//   - デスクトップ専用の 15 本は日本語のエラー（呼ばれても base には届かない）
//   - それ以外は HTTP クライアントにそのまま通す
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SorobanApi } from '../../../shared/types'
import type { CollectJob, WebApi } from '../../../shared/web-types'
import { createWebApi, createWebSoroban, DESKTOP_ONLY_METHODS, desktopOnlyMessage } from '../web'
import type { PendingWindow, WebEnv } from '../web'

function fakeEnv(opts: { pendingBlocked?: boolean } = {}) {
  const opened: string[] = []
  const downloads: Array<{ filename: string; content: string; mime: string }> = []
  const pendingCalls: string[] = []
  const env: WebEnv = {
    open: (url) => { opened.push(url) },
    openPending: () => {
      if (opts.pendingBlocked) return null
      pendingCalls.push('open')
      const w: PendingWindow = {
        navigate: (url) => { pendingCalls.push(`navigate:${url}`) },
        close: () => { pendingCalls.push('close') },
      }
      return w
    },
    download: (filename, content, mime) => { downloads.push({ filename, content, mime }) },
    now: () => new Date(2026, 9, 12, 8, 30), // 2026-10-12 08:30（ローカル）
  }
  return { env, opened, downloads, pendingCalls }
}

function job(over: Partial<CollectJob> = {}): CollectJob {
  return {
    id: 'j1', status: 'queued', requested_at: '2026-10-12T00:00:00Z', requested_by_me: true, agent_name: null,
    claimed_at: null, heartbeat_at: null, finished_at: null, runs: null, message: null, ...over,
  }
}

describe('createWebSoroban（Web 版の window.soroban）', () => {
  let base: { exportCsv: ReturnType<typeof vi.fn>; getDashboard: ReturnType<typeof vi.fn> }
  let web: { getTrackingNumber: ReturnType<typeof vi.fn>; requestCollect: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    base = { exportCsv: vi.fn(), getDashboard: vi.fn(async () => ({ ok: true })) }
    web = { getTrackingNumber: vi.fn(), requestCollect: vi.fn() }
  })

  const make = (env: WebEnv) => createWebSoroban(base as unknown as SorobanApi, web as unknown as WebApi, env)

  describe('exportCsv', () => {
    it('サーバーが返した CSV の中身をダウンロードさせ、ファイル名を返す（月なしは今日の日付）', async () => {
      const { env, downloads } = fakeEnv()
      base.exportCsv.mockResolvedValue('﻿日付,金額\r\n2026-10-01,1000')
      const name = await make(env).exportCsv('sales')
      expect(name).toBe('soroban-sales-2026-10-12.csv')
      expect(base.exportCsv).toHaveBeenCalledWith('sales', undefined)
      expect(downloads).toEqual([{ filename: 'soroban-sales-2026-10-12.csv', content: '﻿日付,金額\r\n2026-10-01,1000', mime: 'text/csv;charset=utf-8' }])
    })

    it('月を渡すとファイル名は月、kind 省略は販売', async () => {
      const { env, downloads } = fakeEnv()
      base.exportCsv.mockResolvedValue('a,b')
      expect(await make(env).exportCsv('purchases', '2026-09')).toBe('soroban-purchases-2026-09.csv')
      expect(await make(env).exportCsv()).toBe('soroban-sales-2026-10-12.csv')
      expect(base.exportCsv).toHaveBeenNthCalledWith(2, 'sales', undefined)
      expect(downloads.map(d => d.filename)).toEqual(['soroban-purchases-2026-09.csv', 'soroban-sales-2026-10-12.csv'])
    })

    it('対象が 0 件（サーバーは null）なら null で、何もダウンロードしない', async () => {
      const { env, downloads } = fakeEnv()
      base.exportCsv.mockResolvedValue(null)
      expect(await make(env).exportCsv('expenses', '2026-09')).toBeNull()
      expect(downloads).toEqual([])
    })
  })

  describe('openChannelPage', () => {
    it('shared/channel-url.ts で作った URL を開く（デスクトップと同じ規則）', async () => {
      const { env, opened } = fakeEnv()
      const soroban = make(env)
      await soroban.openChannelPage('mercari', 'item', 'm123456789')
      await soroban.openChannelPage('yahoo', 'transaction', 'z999999999')
      expect(opened).toEqual([
        'https://jp.mercari.com/item/m123456789',
        'https://paypayfleamarket-sec.yahoo.co.jp/item/z999999999/trade/seller',
      ])
    })

    it('id の形が合わなければ何も開かず、デスクトップと同じ Error', async () => {
      const { env, opened } = fakeEnv()
      const soroban = make(env)
      await expect(soroban.openChannelPage('mercari', 'item', 'm123456789/../../evil')).rejects.toThrow('メルカリの商品IDではありません')
      await expect(soroban.openChannelPage('yahoo', 'item', 'https://evil.example/')).rejects.toThrow('Yahoo!フリマの商品IDではありません')
      expect(opened).toEqual([])
    })
  })

  describe('openTracking', () => {
    it('空のタブをクリックの中で先に開き、番号が取れたら 17TRACK のページへ進める', async () => {
      const { env, pendingCalls, opened } = fakeEnv()
      let resolve!: (n: string) => void
      web.getTrackingNumber.mockReturnValue(new Promise<string>(r => { resolve = r }))
      const p = make(env).openTracking('p1')
      // 通信の返事を待っているあいだに、空のタブは開いてある（ポップアップブロック対策）
      expect(pendingCalls).toEqual(['open'])
      resolve('JP 123/4')
      await p
      expect(web.getTrackingNumber).toHaveBeenCalledWith('p1')
      expect(pendingCalls).toEqual(['open', 'navigate:https://t.17track.net/#nums=JP%20123%2F4'])
      expect(opened).toEqual([])
    })

    it('追跡番号が無ければ空のタブを閉じる', async () => {
      const { env, pendingCalls } = fakeEnv()
      web.getTrackingNumber.mockResolvedValue(null)
      await make(env).openTracking('p1')
      expect(pendingCalls).toEqual(['open', 'close'])
    })

    it('通信が失敗したら空のタブを閉じて、エラーを投げる', async () => {
      const { env, pendingCalls } = fakeEnv()
      web.getTrackingNumber.mockRejectedValue(new Error('サーバーにつながりません'))
      await expect(make(env).openTracking('p1')).rejects.toThrow('サーバーにつながりません')
      expect(pendingCalls).toEqual(['open', 'close'])
    })

    it('空のタブを開けないブラウザでは、番号が取れてから普通に開く', async () => {
      const { env, opened } = fakeEnv({ pendingBlocked: true })
      web.getTrackingNumber.mockResolvedValue('AB123')
      await make(env).openTracking('p1')
      expect(opened).toEqual(['https://t.17track.net/#nums=AB123'])
    })
  })

  describe('collect', () => {
    it('取り込みの要求（requestCollect）に回す。結果がまだ無ければ空の配列', async () => {
      const { env } = fakeEnv()
      web.requestCollect.mockResolvedValue(job())
      expect(await make(env).collect()).toEqual([])
      expect(web.requestCollect).toHaveBeenCalledTimes(1)
    })

    it('結果（runs）があればそれを返す', async () => {
      const { env } = fakeEnv()
      const runs = [{ id: 'r', started_at: '', finished_at: null, status: 'ok', fetched: 1, inserted: 1, message: null, source: 'mercari', shop_account_id: null, shop_account_name: null }]
      web.requestCollect.mockResolvedValue(job({ status: 'done', runs: runs as never }))
      expect(await make(env).collect()).toEqual(runs)
    })
  })

  describe('デスクトップ専用', () => {
    it('15 本。バックアップ・復元・更新・初期化・各サイトへのログイン・取り直し', () => {
      expect([...DESKTOP_ONLY_METHODS].sort()).toEqual([
        'backupDb', 'checkForUpdate', 'getAutoBackupStatus', 'installUpdate', 'openBackupFolder', 'openLogin', 'openShopLogin',
        'openYahooLogin', 'refetchPurchaseImages', 'refetchSaleDates', 'restoreBackup', 'resetData', 'revealDbFolder',
        'runAutoBackupNow', 'setAutoBackupEnabled',
      ].sort())
    })

    it.each(DESKTOP_ONLY_METHODS)('%s は「Web 版では使えません（…）」の Error で、サーバーには届かない', async (method) => {
      const { env } = fakeEnv()
      const soroban = make(env) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      await expect(soroban[method]('x')).rejects.toThrow(/^Web 版では使えません（.+）$/)
      expect(desktopOnlyMessage(method)).toMatch(/^Web 版では使えません（.+）$/)
    })

    it('それ以外のメソッドと、継承されたキーは対象外', () => {
      expect(desktopOnlyMessage('getDashboard')).toBeNull()
      expect(desktopOnlyMessage('constructor')).toBeNull()
      expect(desktopOnlyMessage('__proto__')).toBeNull()
    })
  })

  it('それ以外は HTTP クライアント（base）にそのまま通す。then は持たない（await しても固まらない）', async () => {
    const { env } = fakeEnv()
    const soroban = make(env)
    expect(await soroban.getDashboard()).toEqual({ ok: true })
    expect((soroban as unknown as { then?: unknown }).then).toBeUndefined()
  })
})

describe('createWebApi（window.sorobanWeb）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('SorobanApi と同じ通信（POST /api/rpc/<メソッド名>・Bearer・{"args": [...]}）で WebApi を呼ぶ', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ result: { sent: 2, failed: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const api = createWebApi({ base: '/api', getToken: async () => 'jwt-abc', onUnauthorized: () => {} })
    expect(await api.sendTestPush()).toEqual({ sent: 2, failed: 0 })
    await api.listPushDevices(null)
    await api.cancelCollectJob('j1')
    expect(calls.map(c => c.url)).toEqual(['/api/rpc/sendTestPush', '/api/rpc/listPushDevices', '/api/rpc/cancelCollectJob'])
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc')
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ args: [null] })
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ args: ['j1'] })
  })
})
