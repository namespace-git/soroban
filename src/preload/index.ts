import { contextBridge, ipcRenderer } from 'electron'
import type { SorobanApi, CollectorRun, UpdateStatus } from '../shared/types'

// ============================================================
// レンダラーへ公開するAPI
//
// SorobanApi（shared/types.ts）と1対1で対応させる。
// ここで生の ipcRenderer を渡さないこと。
// ============================================================

const invoke = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(name, ...args)

const api: SorobanApi = {
  getDashboard: invoke('getDashboard'),

  listSales: invoke('listSales'),
  saleTotals: invoke('saleTotals'),
  createSale: invoke('createSale'),
  updateSale: invoke('updateSale'),
  deleteSale: invoke('deleteSale'),

  linkInventory: invoke('linkInventory'),
  autoLinkPending: invoke('autoLinkPending'),
  unlinkInventory: invoke('unlinkInventory'),
  suggestInventory: invoke('suggestInventory'),
  listSaleLines: invoke('listSaleLines'),

  listPurchases: invoke('listPurchases'),
  getPurchase: invoke('getPurchase'),
  createPurchase: invoke('createPurchase'),
  importPurchases: invoke('importPurchases'),
  confirmPurchase: invoke('confirmPurchase'),
  updatePurchaseNote: invoke('updatePurchaseNote'),
  updatePurchaseFulfillment: invoke('updatePurchaseFulfillment'),
  deletePurchase: invoke('deletePurchase'),

  listInventory: invoke('listInventory'),
  updateInventory: invoke('updateInventory'),
  splitInventory: invoke('splitInventory'),
  disposeInventory: invoke('disposeInventory'),

  listMonthly: invoke('listMonthly'),

  listExpenses: invoke('listExpenses'),
  createExpense: invoke('createExpense'),
  deleteExpense: invoke('deleteExpense'),
  updateExpense: invoke('updateExpense'),
  attachReceipt: invoke('attachReceipt'),
  removeReceipt: invoke('removeReceipt'),
  readReceiptImage: invoke('readReceiptImage'),
  readReceipt: invoke('readReceipt'),
  getMonthDetail: invoke('getMonthDetail'),
  setMonthAllocMethod: invoke('setMonthAllocMethod'),
  closeMonth: invoke('closeMonth'),
  reopenMonth: invoke('reopenMonth'),

  listTags: invoke('listTags'),
  createTag: invoke('createTag'),
  renameTag: invoke('renameTag'),
  deleteTag: invoke('deleteTag'),
  setSaleTags: invoke('setSaleTags'),
  setInventoryTags: invoke('setInventoryTags'),
  setPurchaseTags: invoke('setPurchaseTags'),
  setProductTags: invoke('setProductTags'),
  listVariantSummary: invoke('listVariantSummary'),

  listProducts: invoke('listProducts'),
  getProduct: invoke('getProduct'),
  getItemTimeline: invoke('getItemTimeline'),

  listListings: invoke('listListings'),
  reserveInventory: invoke('reserveInventory'),
  unreserveInventory: invoke('unreserveInventory'),
  suggestForListing: invoke('suggestForListing'),
  endListing: invoke('endListing'),
  autoReserveListings: invoke('autoReserveListings'),
  setListingShipping: invoke('setListingShipping'),

  searchAll: invoke('searchAll'),

  listShopAccounts: invoke('listShopAccounts'),
  createShopAccount: invoke('createShopAccount'),
  updateShopAccount: invoke('updateShopAccount'),
  deleteShopAccount: invoke('deleteShopAccount'),
  listShippingMethods: invoke('listShippingMethods'),
  saveShippingMethod: invoke('saveShippingMethod'),
  deleteShippingMethod: invoke('deleteShippingMethod'),
  getSettings: invoke('getSettings'),
  setSetting: invoke('setSetting'),

  collect: invoke('collect'),
  openLogin: invoke('openLogin'),
  openShopLogin: invoke('openShopLogin'),
  listRuns: invoke('listRuns'),

  exportCsv: invoke('exportCsv'),
  backupDb: invoke('backupDb'),
  revealDbFolder: invoke('revealDbFolder'),
  resetData: invoke('resetData'),

  openMercari: invoke('openMercari'),

  checkForUpdate: invoke('checkForUpdate'),
  installUpdate: invoke('installUpdate'),
} as SorobanApi

// 'soroban' ではなく 'sorobanBridge' として出す。contextBridge の境界は Vue のリアクティブ（Proxy）を
// 渡すと同期例外（An object could not be cloned）になるので、renderer/main.ts が引数を素の
// オブジェクトに直す包みを window.soroban として定義する
contextBridge.exposeInMainWorld('sorobanBridge', api)

// 起動時の自動収集が終わったら知らせる（メルカリ→仕入先の順の配列）
contextBridge.exposeInMainWorld('sorobanEvents', {
  onCollectDone(cb: (runs: CollectorRun[]) => void) {
    ipcRenderer.on('collect:done', (_e, runs: CollectorRun[]) => cb(runs))
  },
  // 裏の自動確認（起動10秒後・6時間ごと）で新しい版が見つかったら知らせる
  onUpdateStatus(cb: (status: UpdateStatus) => void) {
    ipcRenderer.on('update:status', (_e, status: UpdateStatus) => cb(status))
  },
})
