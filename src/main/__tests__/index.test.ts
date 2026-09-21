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
