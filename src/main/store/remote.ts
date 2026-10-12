import type { AgentLease } from '../../shared/agent-types'
import type { CollectorRun } from '../../shared/types'
import { AgentHttpError, AgentStoppedError, LeaseLostError } from '../agent/errors'
import type { JobGuard } from '../agent/guard'
import type { AgentHttp } from '../agent/http'
import type { MediaUploader } from '../agent/media'
import type { CollectorStore } from './types'

// ============================================================
// リモートの store：CollectorStore を `/api/agent/<method>`（Web 版のサーバー）で実装する
//
// 取り込み担当モードの収集（collect / collectShopOrders）に、ローカルの store（store/local.ts）のかわりに渡す。
//   * 呼び出しの先頭に lease（job_id・lease_token）を差し込む。鍵は `Authorization: Agent <鍵>`（http.ts）
//   * 通信の失敗：5xx・通信切れだけ短くやり直す（段は冪等キーを持つので二重に入らない）。4xx・lease_lost はやり直さない
//   * lease_lost（409）は専用の例外（LeaseLostError）で投げ、guard に印を付ける。**以後の呼び出しは通信せずに同じ例外**
//     （収集のコードは例外を途中で握ることがあるが、最後の recordRun で必ず外に出て、収集が止まる）
//   * 画像：収集が userData/thumbs に落としたファイルを Storage の media バケットに上げてから、上げたパスを API に渡す。
//     上げられなければ**例外**＝収集のコードがその画像を飛ばす（収集は続ける）。lease とは無関係なので guard は触らない
//   * 取り込み担当の鍵が register で取り直された直後に、古い鍵で 401 になったら、最新の鍵で 1 度だけ送り直す
//
// 戻りの `already: true`（同じ段を送り直した）はそのまま返す。収集のコードが扱う。
// ============================================================

/** 収集のコードに渡す store ＋ 取り込みが書いた実行記録（finish に渡す id を集める） */
export type RemoteStore = CollectorStore & { recordedRuns(): CollectorRun[] }

export interface RemoteStoreOptions {
  http: AgentHttp
  /** 取り込み担当の鍵（メモリだけ）。呼ぶたびに最新を返す。無ければ null（ログアウトなどで捨てた） */
  getKey: () => string | null
  lease: AgentLease
  guard: JobGuard
  media: MediaUploader
}

export function createRemoteStore(o: RemoteStoreOptions): RemoteStore {
  const runs = new Map<string, CollectorRun>()

  async function send<T>(method: string, args: unknown[], key: string): Promise<T> {
    try {
      return await o.http.agent<T>(method, [o.lease, ...args], key)
    } catch (e) {
      if (e instanceof LeaseLostError) o.guard.loseLease()
      throw e
    }
  }

  async function call<T>(method: string, args: unknown[]): Promise<T> {
    o.guard.check()
    const key = o.getKey()
    if (!key) throw new AgentStoppedError()
    try {
      return await send<T>(method, args, key)
    } catch (e) {
      if (e instanceof AgentHttpError && e.code === 'unauthorized') {
        const latest = o.getKey()
        if (latest && latest !== key) return await send<T>(method, args, latest)
      }
      throw e
    }
  }

  return {
    // ---- 読む ----
    getCollectPlan: () => call('getCollectPlan', []),
    listSalesNeedingDetail: limit => call('listSalesNeedingDetail', [limit]),
    listSalesNeedingPurchasedAt: limit => call('listSalesNeedingPurchasedAt', [limit]),
    existingImportKeys: keys => call('existingImportKeys', [keys]),
    excludedOrders: (shopAccountId, orderNos) => call('excludedOrders', [shopAccountId, orderNos]),
    purchaseRevisitCandidates: (shopAccountId, importKeys) =>
      call('purchaseRevisitCandidates', [shopAccountId, importKeys]),

    // ---- 実行記録 ----
    async recordRun(run) {
      const recorded = await call<CollectorRun>('recordRun', [run])
      runs.set(recorded.id, recorded)
      return recorded
    },

    // ---- メルカリ・Yahoo!フリマ ----
    ingestSoldPage: (page, rows) => call('ingestSoldPage', [page, rows]),
    ingestTrading: rows => call('ingestTrading', [rows]),
    ingestListingsPage: (channel, page, rows) => call('ingestListingsPage', [channel, page, rows]),
    ingestYahooSales: (page, rows) => call('ingestYahooSales', [page, rows]),
    async saveThumb(input) {
      o.guard.check()
      // input.path は収集が落としたファイル名。Storage に上げて、上げたパスに差し替えて渡す
      const path = await o.media.upload(input.kind === 'sale' ? 'sale' : 'listing', input.path)
      return call('saveThumb', [{ ...input, path }])
    },
    applySaleDescription: (saleId, description) => call('applySaleDescription', [saleId, description]),
    setSalePurchasedAt: (saleId, purchasedAt) => call('setSalePurchasedAt', [saleId, purchasedAt]),

    // ---- メロジョイ ----
    updateOrderFulfillments: (shopAccountId, updates) => call('updateOrderFulfillments', [shopAccountId, updates]),
    ingestOrder: (shopAccountId, order) => call('ingestOrder', [shopAccountId, order]),
    revisitOrder: (shopAccountId, purchaseId, detail) => call('revisitOrder', [shopAccountId, purchaseId, detail]),
    async saveLineImage(lineId, file) {
      o.guard.check()
      const path = await o.media.upload('purchase-line', file)
      return call('saveLineImage', [lineId, path])
    },

    recordedRuns: () => [...runs.values()],
  }
}
