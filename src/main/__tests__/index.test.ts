import { beforeEach, describe, expect, it, vi } from 'vitest'

// index.ts はトップレベルで protocol.registerSchemesAsPrivileged と app.whenReady().then(...) を
// 実行する。ここで検証したいのは collectAll の実行中ガード（同時に1つだけ）だけなので、
// whenReady が解決しないようにして起動処理（DB初期化・ウィンドウ生成・IPC登録）が走らないようにし、
// electron 以外の依存（db・collector・collector-mellojoy・updater・receipts・applog）は
// 呼び出し回数だけ確認できるよう個別にモックする
vi.mock('electron', () => ({
  app: {
    getPath: () => '',
    whenReady: () => new Promise<void>(() => {}), // 意図的に解決しない
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return [] }
    loadURL(): void {}
    loadFile(): void {}
    on(): void {}
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showErrorBox: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

vi.mock('../db', () => ({
  listShopAccounts: vi.fn(() => []),
  getSettings: vi.fn(() => ({})),
}))

vi.mock('../collector', () => ({
  collect: vi.fn(async () => ({
    id: 'run-1', source: 'mercari', shop_account_id: null, shop_account_name: null,
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z',
    status: 'ok', fetched: 0, inserted: 0, message: null,
  })),
  ensureSession: vi.fn(),
}))

vi.mock('../collector-mellojoy', () => ({
  collectShopOrders: vi.fn(),
}))

// 17TRACK の API。既定では対象0件で何もしない体で返す
vi.mock('../collector-tracking', () => ({
  checkTrackingBatch: vi.fn(async () => ({ registered: 0, checked: 0, delivered: 0, failed: 0, stopped: null })),
}))

vi.mock('../updater', () => ({
  scheduleAutoCheck: vi.fn(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}))

vi.mock('../receipts', () => ({}))

vi.mock('../applog', () => ({
  log: vi.fn(),
  initAppLog: vi.fn(),
}))

import { collectAll } from '../index'
import * as collector from '../collector'
import * as db from '../db'
import * as collectorMellojoy from '../collector-mellojoy'
import * as collectorTracking from '../collector-tracking'
import * as applog from '../applog'
import type { ShopAccount } from '../../shared/types'

/** テスト用の口座レコードを組み立てる（is_active は number＝1/0） */
function makeAccount(id: string, name: string): ShopAccount {
  return {
    id, name, kind: 'mellojoy', note: null, is_active: 1,
    import_keywords: null, auto_tags: [], default_shipping_fee: null,
  }
}

// ============================================================
// collectAll（起動時の裏収集と手動「取り込む」ボタンが同時に走らないようにするガード）
// ============================================================
describe('collectAll（実行中ガード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('同時に2回呼んでも collector.collect は1回だけ実行される', async () => {
    const p1 = collectAll(true)
    const p2 = collectAll(true)

    // 実行中は同じ Promise を共有する
    expect(p1).toBe(p2)

    await Promise.all([p1, p2])

    expect(collector.collect).toHaveBeenCalledTimes(1)
  })

  it('前回が終わっていれば、次の呼び出しであらためて実行される', async () => {
    await collectAll(true)
    await collectAll(true)

    expect(collector.collect).toHaveBeenCalledTimes(2)
  })
})

// ============================================================
// runCollectAll（別サイトの3グループ＝メルカリ／メロジョイ／17TRACK の並列化）
//
// 「同じサイトへの頻度を上げない」＝並列にしてよいのは別サイト同士だけ。
// メロジョイの口座同士は今まで通り直列のチェーンであることも別テストで確かめる。
// ============================================================
describe('runCollectAll（3グループの並列化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('メルカリ・メロジョイ・17TRACK が同時に走る（3つ揃うまで進まない関所で確認）', async () => {
    vi.mocked(db.listShopAccounts).mockReturnValue([makeAccount('a1', '口座A')])

    // 3つのモックが「入ってきた」ことを記録し、3つ揃って初めて全員を解決する関所。
    // 直列のままなら2つ目・3つ目が呼ばれる前に1つ目が止まったままなのでタイムアウトで落ちる
    let arrived = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const arrive = async (): Promise<void> => {
      arrived++
      if (arrived === 3) release()
      await gate
    }

    vi.mocked(collector.collect).mockImplementation(async () => {
      await arrive()
      return {
        id: 'run-1', source: 'mercari', shop_account_id: null, shop_account_name: null,
        started_at: '', finished_at: '', status: 'ok', fetched: 0, inserted: 0, message: null,
      }
    })
    vi.mocked(collectorMellojoy.collectShopOrders).mockImplementation(async () => {
      await arrive()
      return {
        id: 'run-2', source: 'mellojoy', shop_account_id: 'a1', shop_account_name: '口座A',
        started_at: '', finished_at: '', status: 'ok', fetched: 0, inserted: 0, message: null,
      }
    })
    vi.mocked(collectorTracking.checkTrackingBatch).mockImplementation(async () => {
      await arrive()
      return { registered: 0, checked: 0, delivered: 0, failed: 0, stopped: null }
    })

    await collectAll(true)
  }, 2000)

  it('メロジョイの口座同士は直列（1つ目が出る前に2つ目は入らない）', async () => {
    vi.mocked(db.listShopAccounts).mockReturnValue([makeAccount('a1', '口座A'), makeAccount('a2', '口座B')])

    const events: string[] = []
    vi.mocked(collectorMellojoy.collectShopOrders).mockImplementation(async (accountId: string) => {
      events.push(`enter:${accountId}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
      events.push(`exit:${accountId}`)
      return {
        id: `run-${accountId}`, source: 'mellojoy', shop_account_id: accountId, shop_account_name: accountId,
        started_at: '', finished_at: '', status: 'ok', fetched: 0, inserted: 0, message: null,
      }
    })

    await collectAll(true)

    expect(events).toEqual(['enter:a1', 'exit:a1', 'enter:a2', 'exit:a2'])
  })

  it('1つのグループが落ちても他の結果は返る', async () => {
    vi.mocked(db.listShopAccounts).mockReturnValue([makeAccount('a1', '口座A')])
    // Once に留める（clearAllMocks は呼び出し履歴だけ消すので、Once でないと後続のテストの
    // collector.collect にまで失敗が漏れてしまう）
    vi.mocked(collector.collect).mockRejectedValueOnce(new Error('boom'))
    const shopRun = {
      id: 'run-2', source: 'mellojoy' as const, shop_account_id: 'a1', shop_account_name: '口座A',
      started_at: '', finished_at: '', status: 'ok' as const, fetched: 0, inserted: 0, message: null,
    }
    vi.mocked(collectorMellojoy.collectShopOrders).mockResolvedValue(shopRun)

    const runs = await collectAll(true)

    expect(runs).toEqual([shopRun])
    expect(applog.log).toHaveBeenCalledWith(
      'collector', 'mercari', 'メルカリの収集に失敗しました', undefined,
      expect.objectContaining({ error: 'boom' }),
    )
  })

  it('設定が track_shipping=0 なら17TRACKを見に行かない', async () => {
    vi.mocked(db.getSettings).mockReturnValue({ track_shipping: '0' })

    await collectAll(true)

    expect(collectorTracking.checkTrackingBatch).not.toHaveBeenCalled()
  })

  it('戻り値の並びはメルカリが先、その後は口座の順', async () => {
    vi.mocked(db.listShopAccounts).mockReturnValue([makeAccount('a1', '口座A'), makeAccount('a2', '口座B')])
    vi.mocked(collectorMellojoy.collectShopOrders).mockImplementation(async (accountId: string) => ({
      id: `run-${accountId}`, source: 'mellojoy', shop_account_id: accountId, shop_account_name: accountId,
      started_at: '', finished_at: '', status: 'ok', fetched: 0, inserted: 0, message: null,
    }))

    const runs = await collectAll(true)

    expect(runs.map((r) => r.id)).toEqual(['run-1', 'run-a1', 'run-a2'])
  })
})
