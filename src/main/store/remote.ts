import type { AgentLease } from '../../shared/agent-types'
import type { CollectorRun } from '../../shared/types'
import { AgentHttpError, AgentStoppedError, LeaseLostError } from '../agent/errors'
import type { JobGuard } from '../agent/guard'
import type { AgentHttp, CallOptions } from '../agent/http'
import type { MediaKind, MediaUploader } from '../agent/media'
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
//     上げられなければ**例外**＝収集のコードがその画像を飛ばす（収集は続ける）。lease とは無関係なので guard は触らない。
//     API が書かなかった・`already: true` のときは、上げた画像を消してみる（消せなくても続ける。詳細は uploadThen）
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

/** 画像の書き込みはやり直さない（理由は uploadThen）。失敗した画像は次の収集でもう一度取れる */
const NO_RETRY: CallOptions = { retry: false }

export function createRemoteStore(o: RemoteStoreOptions): RemoteStore {
  const runs = new Map<string, CollectorRun>()

  async function send<T>(method: string, args: unknown[], key: string, opts?: CallOptions): Promise<T> {
    try {
      return await o.http.agent<T>(method, [o.lease, ...args], key, opts)
    } catch (e) {
      if (e instanceof LeaseLostError) o.guard.loseLease()
      throw e
    }
  }

  async function call<T>(method: string, args: unknown[], opts?: CallOptions): Promise<T> {
    o.guard.check()
    const key = o.getKey()
    if (!key) throw new AgentStoppedError()
    try {
      return await send<T>(method, args, key, opts)
    } catch (e) {
      if (e instanceof AgentHttpError && e.code === 'unauthorized') {
        const latest = o.getKey()
        if (latest && latest !== key) return await send<T>(method, args, latest, opts)
      }
      throw e
    }
  }

  /**
   * 画像を Storage に上げてから、上げたパスを API に渡す。API が書かなかった（失敗した）・書く必要が無かった
   * （`already: true`＝前に送った段がもう書かれていて、今回上げたものは使われない）ときは、上げた画像を消してみる
   * （消せなくても例外にしない）。
   * ただし**答えが返らなかった**（通信切れ・時間切れ）ときは、サーバーが書いたかどうか分からない。書いたあとに
   * 消すと参照だけが残るので、消さない（孤児のファイルは後で回収する）。同じ理由で、この呼び出しはやり直さない
   * （やり直して `already: true` が返ると、自分が書いたパスを消してしまう。画像は次の収集でもう一度取れる）
   */
  async function uploadThen<T extends { already: boolean }>(
    kind: MediaKind, file: string, write: (path: string) => Promise<T>,
  ): Promise<T> {
    o.guard.check()
    const path = await o.media.upload(kind, file)
    let result: T
    try {
      result = await write(path)
    } catch (e) {
      if (!(e instanceof AgentHttpError && e.status === 0)) await discard(path)
      throw e
    }
    if (result.already) await discard(path)
    return result
  }

  async function discard(path: string): Promise<void> {
    try {
      await o.media.remove(path)
    } catch {
      // 消せなくても収集は続ける
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
    saveThumb: input =>
      // input.path は収集が落としたファイル名。Storage に上げて、上げたパスに差し替えて渡す
      uploadThen(input.kind === 'sale' ? 'sale' : 'listing', input.path,
        path => call('saveThumb', [{ ...input, path }], NO_RETRY)),
    applySaleDescription: (saleId, description) => call('applySaleDescription', [saleId, description]),
    setSalePurchasedAt: (saleId, purchasedAt) => call('setSalePurchasedAt', [saleId, purchasedAt]),

    // ---- メロジョイ ----
    updateOrderFulfillments: (shopAccountId, updates) => call('updateOrderFulfillments', [shopAccountId, updates]),
    ingestOrder: (shopAccountId, order) => call('ingestOrder', [shopAccountId, order]),
    revisitOrder: (shopAccountId, purchaseId, detail) => call('revisitOrder', [shopAccountId, purchaseId, detail]),
    saveLineImage: (lineId, file) =>
      uploadThen('purchase-line', file, path => call('saveLineImage', [lineId, path], NO_RETRY)),

    recordedRuns: () => [...runs.values()],
  }
}
