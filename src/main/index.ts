import { app, BrowserWindow, ipcMain, dialog, shell, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import * as db from './db'
import * as collector from './collector'
import * as collectorMellojoy from './collector-mellojoy'
import * as collectorTracking from './collector-tracking'
import * as updater from './updater'
import * as receipts from './receipts'
import * as productImage from './product-image'
import * as ai from './ai-receipt'
import * as backup from './backup'
import * as inbox from './inbox'
import * as views from './views'
import * as applog from './applog'
import type { CollectorRun, ExportKind, SorobanApi } from '../shared/types'

// ============================================================
// そろばん — メインプロセス
//
// 単一Electronアプリ。DBはローカルSQLite。外部に出るのは3つだけ：
// メルカリ・メロジョイ（読み取り）、レシート読み取り（利用者自身の Gemini キー）、
// 追跡番号の配送状況（17TRACK。メロジョイが「配達済み」を出さないため。設定で切れる）。
// 収集は起動時（間隔が空いていれば）と手動ボタンで走る。
// ============================================================

// 保存したサムネイルを画面（<img src>）から読ませるための独自スキーム。
// app.whenReady() より前（トップレベル）で登録しないと反映されない。
// standard: true にするとホスト部が小文字化されるが、ファイル名は
// `m` + 数字 + `.jpg`（collector.ts が生成）なので影響しない
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'soroban-thumb',
    privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false },
  },
])

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'そろばん',
    backgroundColor: '#f3f5f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ------------------------------------------------------------
// 収集：別サイト（メルカリ／メロジョイ／17TRACK）は同時に走らせる。
// 同じサイトへの頻度は変えない＝メロジョイの口座同士は直列のチェーンのまま。
// どの関数も絶対に reject しない（例外はここで畳んで applog に残す）。
// ------------------------------------------------------------

// 起動時収集（collectInBackground）と手動収集（IPC 'collect'）が同時に走ると、メルカリ・
// メロジョイのウィンドウが並行して開いてしまう。実行中の Promise を共有し、同時には1つだけに絞る
let collectAllRunning: Promise<CollectorRun[]> | null = null

export function collectAll(silent: boolean): Promise<CollectorRun[]> {
  if (collectAllRunning) return collectAllRunning
  collectAllRunning = runCollectAll(silent).finally(() => { collectAllRunning = null })
  return collectAllRunning
}

/** メルカリを1回収集する。失敗しても reject しない（[] を返す） */
async function collectMercari(silent: boolean): Promise<CollectorRun[]> {
  try {
    const run = await collector.collect(silent)
    applog.log('collector', 'mercari', `メルカリ: ${run.status}`, {
      fetched: run.fetched, inserted: run.inserted, message: run.message,
    })
    return [run]
  } catch (e) {
    console.error('メルカリの収集に失敗しました', e)
    applog.log('collector', 'mercari', 'メルカリの収集に失敗しました', undefined, {
      error: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

/**
 * 有効な仕入先アカウント（メロジョイ）を順に直列で収集する。同じサイトを2窓で
 * 叩くと頻度が倍になるため、口座同士は並列にしない。1件失敗しても次へ進む。
 */
async function collectShopAccountsSerially(
  accounts: ReturnType<typeof db.listShopAccounts>,
  silent: boolean,
): Promise<CollectorRun[]> {
  const runs: CollectorRun[] = []
  for (const account of accounts) {
    try {
      const run = await collectorMellojoy.collectShopOrders(account.id, silent)
      runs.push(run)
      applog.log('collector', 'mellojoy', `仕入先「${account.name}」: ${run.status}`, {
        fetched: run.fetched, inserted: run.inserted, message: run.message,
      })
    } catch (e) {
      console.error(`仕入先「${account.name}」の収集に失敗しました`, e)
      applog.log('collector', 'mellojoy', `仕入先「${account.name}」の収集に失敗しました`, undefined, {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return runs
}

/**
 * 到着の確認。メロジョイの注文詳細は「発送準備中 → 配達中」までしか出さないので、
 * 到着済にできるのは追跡番号を 17TRACK の API で見たときだけ（画面の DOM は
 * 別物を読んでしまうので使わない）。API キーが無ければ何もしない。
 * collector_run は作らない（メロジョイ自体は成功しているのに失敗として出さないため）。
 * 設定で切られていれば何もしない。失敗しても reject しない。
 */
async function checkShippingIfEnabled(): Promise<void> {
  try {
    // getSettings も try の中に置く。ここで投げると Promise.all が reject して、
    // 並行して成功していたメルカリ・メロジョイの結果まで捨ててしまう
    if (db.getSettings().track_shipping === '0') return
    const t = await collectorTracking.checkTrackingBatch()
    if (t.registered > 0 || t.checked > 0 || t.failed > 0 || t.stopped) {
      applog.log('collector', 'tracking', '配送状況を確認しました', t)
    }
    if (t.stopped) console.warn('配送状況の確認を中断しました:', t.stopped)
  } catch (e) {
    console.error('配送状況の確認に失敗しました', e)
    applog.log('collector', 'tracking', '配送状況の確認に失敗しました', undefined, {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

async function runCollectAll(silent: boolean): Promise<CollectorRun[]> {
  applog.log('collector', 'collect_start', `収集を開始（silent=${silent}）`)

  const shopAccounts = db.listShopAccounts()
    .filter(a => a.is_active && a.kind === 'mellojoy')

  // 別サイトの3グループを同時に走らせる。同じサイト（メロジョイの口座同士）は直列。
  // どのグループも内側で例外を畳むので reject しない（Promise.all で安全に待てる）
  const [mercariRuns, shopRuns] = await Promise.all([
    collectMercari(silent),
    collectShopAccountsSerially(shopAccounts, silent),
    checkShippingIfEnabled(),
  ])

  return [...mercariRuns, ...shopRuns]
}

// ------------------------------------------------------------
// IPC
//
// ハンドラ名は shared/types.ts の SorobanApi と1対1で対応させる。
// ここに増やしたら preload とインターフェースも直すこと。
// ------------------------------------------------------------

/**
 * 読み取りだけのハンドラは記録しない（呼び出し頻度が高く、ログが読み取り操作で埋まってしまう）。
 * logClient 自身も対象外（記録用の呼び出しを記録すると無限に増える）。
 */
const UNLOGGED_HANDLERS = new Set<keyof SorobanApi>([
  'logClient', 'getDashboard', 'listSales', 'listListings', 'listInventory',
  'getAutoBackupStatus', 'getHealthChecks', 'getTrackingApiStatus',
  'suggestProductInventory',
  'listPurchases', 'listMonthly', 'listExpenses', 'searchAll', 'getSettings',
  'getMonthDetail', 'listProducts', 'listTags', 'listShopAccounts', 'listShippingMethods',
  // 引数に API キーが載るので記録しない（summarize はキー名でしか伏せられない）
  'setGeminiApiKey', 'setTrack17ApiKey',
])

function registerIpc(): void {
  const handle = <K extends keyof SorobanApi>(
    name: K,
    fn: (...args: Parameters<SorobanApi[K]>) => unknown,
  ) => {
    ipcMain.handle(name, async (_e, ...args) => {
      const typedArgs = args as Parameters<SorobanApi[K]>
      if (UNLOGGED_HANDLERS.has(name)) return fn(...typedArgs)

      const startedAt = Date.now()
      try {
        const result = await fn(...typedArgs)
        applog.log('ipc', name, name, typedArgs, { duration_ms: Date.now() - startedAt })
        return result
      } catch (e) {
        applog.log('ipc', name, name, typedArgs, {
          duration_ms: Date.now() - startedAt,
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
    })
  }

  handle('getDashboard', () => db.getDashboard())
  handle('getInbox', () => inbox.getInbox())
  handle('snoozeReminder', (type, id) => inbox.snoozeReminder(type, id ?? null))
  handle('getSalesProgress', () => views.getSalesProgress())
  handle('getInventoryOverview', () => views.getInventoryOverview())
  handle('listInventoryGroups', (f) => views.listInventoryGroups(f))
  handle('getProductKarte', (code) => views.getProductKarte(code))
  handle('getMonthStatement', (m) => views.getMonthStatement(m))
  handle('listPurchaseAccountCards', (from, to) => views.listPurchaseAccountCards(from, to))

  handle('listSales', (filter) => db.listSales(filter))
  handle('saleTotals', (filter) => db.saleTotals(filter))
  handle('createSale', (input) => db.createSale(input))
  handle('updateSale', (id, patch) => db.updateSale(id, patch))
  handle('deleteSale', (id) => db.deleteSale(id))

  handle('linkInventory', (saleId, ids, opts) => db.linkInventory(saleId, ids, 'manual', opts))
  handle('autoLinkPending', () => db.autoLinkPending())
  handle('unlinkInventory', (saleId, id) => db.unlinkInventory(saleId, id))
  handle('suggestInventory', (saleId, limit, opts) => db.suggestInventory(saleId, limit, opts))
  handle('suggestProductInventory', (modelCode, quantity, excludeIds) => db.suggestProductInventory(modelCode, quantity, excludeIds))
  handle('listSaleLines', (saleId) => db.listSaleLines(saleId))

  handle('listPurchases', () => db.listPurchases())
  handle('getPurchase', (id) => db.getPurchase(id))
  handle('createPurchase', (input) => db.createPurchase(input))
  handle('importPurchases', (inputs) => db.importPurchases(inputs))
  handle('confirmPurchase', (id, input) => db.confirmPurchase(id, input))
  handle('updatePurchaseNote', (id, note) => db.updatePurchaseNote(id, note))
  handle('updatePurchaseFulfillment', (id, f) => db.setPurchaseFulfillment(id, f))
  handle('deletePurchase', (id) => db.deletePurchase(id))

  handle('listInventory', (status) => db.listInventory(status))
  handle('updateInventory', (id, patch) => db.updateInventory(id, patch))
  handle('splitInventory', (id, count) => db.splitInventory(id, count))
  handle('mergeSplitInventory', (id) => db.mergeSplitInventory(id))
  handle('disposeInventory', (id, note, status) => db.disposeInventory(id, note, status))
  // 追跡番号を 17TRACK で開く。URL は main で組み立てる（画面から任意の URL を開かせない）
  // 1件だけ今すぐ 17TRACK を見る（画面のメンテナンス用ボタン）
  handle('checkTracking', (purchaseId) => collectorTracking.checkTracking(purchaseId))

  handle('openTracking', async (purchaseId) => {
    const num = db.getPurchaseTrackingNumber(purchaseId)
    if (!num) return
    await shell.openExternal(`https://t.17track.net/#nums=${encodeURIComponent(num)}`)
  })
  handle('restoreInventory', (id) => db.restoreInventory(id))

  handle('listMonthly', () => db.listMonthly())

  handle('listExpenses', (month) => db.listExpenses(month))
  handle('createExpense', (input) => db.createExpense(input))
  handle('deleteExpense', (id) => db.deleteExpense(id))
  handle('updateExpense', (id, input) => db.updateExpense(id, input))
  handle('attachReceipt', (id) => receipts.attachReceipt(id, mainWindow))
  handle('removeReceipt', (id) => receipts.removeReceipt(id))
  handle('readReceiptImage', () => receipts.readReceiptImage(mainWindow))
  handle('readReceipt', (id) => receipts.readReceipt(id))
  handle('getAiStatus', () => ai.getAiStatus())
  handle('getTrackingApiStatus', () => collectorTracking.getTrackingApiStatus())
  handle('setTrack17ApiKey', (key) => collectorTracking.setTrack17ApiKey(key))
  handle('setGeminiApiKey', (key) => ai.setGeminiApiKey(key))
  handle('setAiModel', (model) => ai.setAiModel(model))
  handle('testGemini', () => ai.testGemini())
  handle('listGeminiModels', () => ai.listGeminiModels())
  handle('getMonthDetail', (month, opts) => db.getMonthDetail(month, opts))
  handle('setMonthAllocMethod', (month, method) => db.setMonthAllocMethod(month, method))
  handle('closeMonth', (month) => db.closeMonth(month))
  handle('reopenMonth', (month) => db.reopenMonth(month))

  handle('listTags', () => db.listTags())
  handle('createTag', (name) => db.createTag(name))
  handle('renameTag', (id, name) => db.renameTag(id, name))
  handle('deleteTag', (id) => db.deleteTag(id))
  handle('setSaleTags', (saleId, tagIds) => db.setSaleTags(saleId, tagIds))
  handle('setInventoryTags', (itemId, tagIds) => db.setInventoryTags(itemId, tagIds))
  handle('setPurchaseTags', (purchaseId, tagIds) => db.setPurchaseTags(purchaseId, tagIds))
  handle('setProductTags', (modelCode, tagIds) => db.setProductTags(modelCode, tagIds))
  handle('setProductName', (code, name) => db.setProductName(code, name))
  handle('setProductNote', (code, note) => db.setProductNote(code, note))
  handle('setProductImage', (code) => productImage.setProductImage(code, mainWindow))
  handle('setProductImageAuto', (code, auto) => productImage.setProductImageAuto(code, auto))
  handle('refetchSaleDates', (saleId) => collector.refetchSaleDates(saleId))
  handle('refetchPurchaseImages', (purchaseId) => collectorMellojoy.refetchPurchaseImages(purchaseId))
  handle('listShopAccountStats', () => db.listShopAccountStats())
  handle('listVariantSummary', (sort) => db.listVariantSummary(sort))

  handle('listProducts', (sort) => db.listProducts(sort))
  handle('getProduct', (modelCode) => db.getProduct(modelCode))
  handle('getItemTimeline', (id) => db.getItemTimeline(id))

  handle('listListings', (filter) => db.listListings(filter))
  handle('reserveInventory', (mercariItemId, ids, opts) => db.reserveInventory(mercariItemId, ids, opts))
  handle('unreserveInventory', (mercariItemId, id) => db.unreserveInventory(mercariItemId, id))
  handle('suggestForListing', (mercariItemId, limit, opts) => db.suggestForListing(mercariItemId, limit, opts))
  handle('endListing', (mercariItemId) => db.endListing(mercariItemId))
  handle('autoReserveListings', () => db.autoReserveListings())
  handle('setListingShipping', (mercariItemId, shippingMethodId) =>
    db.setListingShipping(mercariItemId, shippingMethodId))

  handle('searchAll', (query, limit) => db.searchAll(query, limit))

  handle('listShopAccounts', () => db.listShopAccounts())
  handle('createShopAccount', (name, kind) => db.createShopAccount(name, kind))
  handle('updateShopAccount', (id, patch) => db.updateShopAccount(id, patch))
  handle('deleteShopAccount', async (id) => {
    db.deleteShopAccount(id)
    await collectorMellojoy.clearShopSession(id)
  })
  handle('listShippingMethods', () => db.listShippingMethods())
  handle('saveShippingMethod', (m) => db.saveShippingMethod(m))
  handle('deleteShippingMethod', (id) => db.deleteShippingMethod(id))
  // 暗号化済みの API キーは画面に出さない（getAiStatus で有無だけ返す）
  handle('getSettings', () => { const { gemini_api_key_enc: _k, track17_api_key_enc: _t, ...rest } = db.getSettings() as Record<string, string>; return rest })
  handle('setSetting', (k, v) => db.setSetting(k, v))

  handle('collect', () => collectAll(db.getSettings().collect_show_window !== '1'))
  handle('openLogin', () => collector.openLoginWindow())
  handle('estimateSaleProfit', (input) => db.estimateSaleProfit(input))
  handle('listSaleExclusions', () => db.listSaleExclusions())
  handle('removeSaleExclusion', (id) => db.removeSaleExclusion(id))
  handle('openShopLogin', (id) => collectorMellojoy.openShopLoginWindow(id))
  handle('listRuns', (limit) => db.listRuns(limit))

  // --- バックアップ ---
  // DBがローカル1ファイルなので、退避手段は必ず用意しておく

  const EXPORT_LABEL: Record<ExportKind, string> = {
    sales: '販売', purchases: '仕入', expenses: '経費', inventory: '在庫',
  }

  handle('getHealthChecks', () => db.getHealthChecks())

  handle('exportCsv', async (kind = 'sales', month) => {
    const label = EXPORT_LABEL[kind] ?? EXPORT_LABEL.sales
    const csv = db.exportCsvRows(kind, month)
    if (!csv) return null
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: `${label}をCSVで書き出す`,
      defaultPath: `soroban-${kind}-${month ?? new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, csv, 'utf-8')
    return filePath
  })

  handle('getAutoBackupStatus', () => backup.getAutoBackupStatus())
  handle('setAutoBackupEnabled', (enabled) => backup.setAutoBackupEnabled(enabled))
  handle('runAutoBackupNow', () => backup.runAutoBackup(true))
  handle('openBackupFolder', () => backup.openBackupFolder())
  handle('backupDb', () => backup.backupToZip(mainWindow))
  handle('restoreBackup', () => backup.restoreFromZip(mainWindow))

  handle('revealDbFolder', () => {
    shell.showItemInFolder(db.getDbPath())
  })

  handle('resetData', () => db.resetData())

  handle('openMercari', async (kind, mercariItemId) => {
    if (!/^m\d{9,}$/.test(mercariItemId)) {
      throw new Error(`不正な商品IDです: ${mercariItemId}`)
    }
    const path = kind === 'item' ? 'item' : 'transaction'
    await shell.openExternal(`https://jp.mercari.com/${path}/${mercariItemId}`)
  })

  handle('logClient', (kind, message, payload) => applog.log('renderer', kind, message, payload))

  handle('checkForUpdate', () => updater.checkForUpdate())
  handle('installUpdate', () => updater.installUpdate())
}

/**
 * soroban-thumb://<file> を userData/thumbs/<file> に対応させる（collector.ts が保存した画像を読む）。
 *
 * ファイル名の取り出しは `new URL(req.url).hostname` ではなく文字列操作でやる。
 * standard スキームは Web の URL パーサに則って解釈されるため、ホスト部は
 * 仕様上小文字化される（テストでは確かめられない部分）。ファイル名は
 * collector.ts が `m` + 数字 + `.jpg` の形でしか作らないので実害は無いが、
 * `req.url.slice(...).split(/[/?#]/)[0]` の方が「大文字小文字化されるURLパーサの癖」に
 * 依存しない分だけ安全と判断した。
 */
function registerThumbProtocol(): void {
  protocol.handle('soroban-thumb', async (req) => {
    const file = req.url.slice('soroban-thumb://'.length).split(/[/?#]/)[0]
    // 親ディレクトリへの脱出やパス区切りを含む名前は拒否する
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      return new Response(null, { status: 404 })
    }
    const filePath = join(app.getPath('userData'), 'thumbs', file)
    try {
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    db.initDb()
  } catch (e) {
    // DB が開けない・マイグレーションに失敗したら黙って止まらず、理由を出して終了する
    dialog.showErrorBox(
      'そろばんを起動できません',
      `データベースの初期化に失敗しました。\n${e instanceof Error ? e.message : String(e)}\n\n${db.getDbPath()}`,
    )
    app.quit()
    return
  }
  applog.initAppLog()
  collector.ensureSession()
  registerThumbProtocol()
  registerIpc()
  createMainWindow()

  // 起動時に、前回から間隔が空いていれば裏で収集する。
  // OSのスケジューラは使わない（アプリを開いたときに追いつけばよい）
  collectInBackground()

  // 週に1回、前回から7日空いていれば裏でバックアップを取る（失敗しても起動は止めない）
  backup.maybeRunAutoBackup()

  // 起動10秒後・以後6時間ごとにアプリの更新を裏で確認する（dev では走らない）
  updater.scheduleAutoCheck(() => mainWindow)
})

async function collectInBackground(): Promise<void> {
  if (process.env.SOROBAN_NO_COLLECT) return // 検証用：自動収集を止める
  try {
    const intervalH = Number(db.getSettings().collect_interval_h ?? 1)
    if (db.hoursSinceLastOk() < intervalH) return

    const runs = await collectAll(true)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collect:done', runs)
    }
  } catch {
    // 起動を妨げない。失敗は collector_run に残る
  }
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.on('window-all-closed', () => {
  // 常駐しない。macOSでも終了させる
  app.quit()
})
