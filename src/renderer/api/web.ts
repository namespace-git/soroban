// Web 版だけの API の入口と、Web 版のときだけ中身が変わる window.soroban の包み。
// auth/boot.ts が動的 import する（Electron 版のビルドには入らない）。
//
//   window.sorobanWeb … WebApi（取り込みの要求・Push 通知・取り込み担当の PC）。通信は createHttpApi と同じ
//   window.soroban    … SorobanApi。次の 4 つだけ Web の動きにし、デスクトップ専用の 15 本は日本語のエラーにする。
//                       画面のコードは Electron 版と同じまま（呼び先が変わるだけ）
//     exportCsv         サーバーは CSV の中身を返す → ブラウザでダウンロードさせる（戻り値はファイル名）
//     openChannelPage   shared/channel-url.ts で URL を作って新しいタブで開く（ホスト・パスは固定）
//     openTracking      追跡番号を取って 17TRACK のページを新しいタブで開く
//     collect           取り込みの要求（sorobanWeb.requestCollect）に回す
import type { CollectorRun, ExportKind, SorobanApi } from '../../shared/types'
import type { WebApi } from '../../shared/web-types'
import { channelPageUrl } from '../../shared/channel-url'
import { todayLocal } from '../../shared/date'
import { createHttpApi } from './http'
import type { HttpApiOptions } from './http'

/** WebApi の入口。メソッド名で `POST /api/rpc/<name>` を呼ぶだけなので、通信は SorobanApi と同じ */
export function createWebApi(options: HttpApiOptions): WebApi {
  return createHttpApi(options) as unknown as WebApi
}

/** 先に開いておいた空のタブ。あとで行き先を入れる／要らなくなったら閉じる */
export interface PendingWindow {
  navigate(url: string): void
  close(): void
}

/** ブラウザに触る部分。テストでは差し替える */
export interface WebEnv {
  /** 新しいタブで開く */
  open(url: string): void
  /**
   * 空のタブを今（クリックの中で）開いておく。通信のあとで開くと、Safari 等のポップアップブロックに止められるため。
   * 開けなかったら null（その場合は navigate のかわりに open を使う）
   */
  openPending(): PendingWindow | null
  /** ファイルとしてダウンロードさせる */
  download(filename: string, content: string, mime: string): void
  now(): Date
}

export function browserEnv(): WebEnv {
  const open = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer') }
  return {
    open,
    openPending() {
      const w = window.open('about:blank', '_blank')
      if (!w) return null
      try { w.opener = null } catch { /* 別オリジンの扱いになっていれば触れない */ }
      return {
        navigate(url) {
          if (w.closed) open(url)
          else w.location.href = url
        },
        close() { w.close() },
      }
    },
    download(filename, content, mime) {
      const url = URL.createObjectURL(new Blob([content], { type: mime }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // すぐ解放するとダウンロードが始まる前に消えることがある
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    },
    now: () => new Date(),
  }
}

const BACKUP_HINT = 'バックアップは Supabase が毎日取っています'
const LOGIN_HINT = 'ログインは取り込み担当の PC のそろばんで行ってください'
const PC_HINT = '取り込み担当の PC のそろばんで行ってください'

/** デスクトップ専用のメソッド → 呼ばれたときに出す案内（画面には出さない。出し忘れても日本語で止まる） */
const DESKTOP_ONLY: Record<string, string> = {
  backupDb: BACKUP_HINT,
  getAutoBackupStatus: BACKUP_HINT,
  setAutoBackupEnabled: BACKUP_HINT,
  runAutoBackupNow: BACKUP_HINT,
  openBackupFolder: BACKUP_HINT,
  revealDbFolder: BACKUP_HINT,
  restoreBackup: '復元は Supabase の管理画面で行ってください',
  resetData: 'データの初期化は Supabase の管理画面で行ってください',
  checkForUpdate: 'Web 版は開くたびに最新になります',
  installUpdate: 'Web 版は開くたびに最新になります',
  openLogin: LOGIN_HINT,
  openYahooLogin: LOGIN_HINT,
  openShopLogin: LOGIN_HINT,
  refetchSaleDates: PC_HINT,
  refetchPurchaseImages: PC_HINT,
}

/** デスクトップ専用のメソッド名（テストと画面の出し分けの確認用） */
export const DESKTOP_ONLY_METHODS: readonly string[] = Object.keys(DESKTOP_ONLY)

export function desktopOnlyMessage(method: string): string | null {
  return Object.prototype.hasOwnProperty.call(DESKTOP_ONLY, method)
    ? `Web 版では使えません（${DESKTOP_ONLY[method]}）`
    : null
}

/**
 * Web 版の window.soroban。`base`（HTTP クライアント）をそのまま使い、下の 4 本と、デスクトップ専用の呼び出しだけ差し替える。
 * 差し替えた 4 本の戻り値の型は Electron 版と同じ（画面は今のまま「書き出しました」などを出せる）
 */
export function createWebSoroban(base: SorobanApi, web: WebApi, env: WebEnv = browserEnv()): SorobanApi {
  const own: Partial<SorobanApi> = {
    async exportCsv(kind: ExportKind = 'sales', month?: string) {
      const csv = await base.exportCsv(kind, month)
      // 対象が 0 件（サーバーは null）。何も書き出さない
      if (!csv) return null
      const filename = `soroban-${kind}-${month ?? todayLocal(env.now())}.csv`
      env.download(filename, csv, 'text/csv;charset=utf-8')
      return filename
    },

    // 規則はデスクトップと同じ（channelPageUrl）。id の形が合わなければ同じ Error を投げて、何も開かない
    async openChannelPage(channel, kind, itemId) {
      env.open(channelPageUrl(channel, kind, itemId))
    },

    async openTracking(purchaseId: string) {
      // 番号を取る通信のあとでは、ブラウザが「クリックから開いたもの」と見なさなくなる。先に空のタブを開いておく
      const pending = env.openPending()
      let num: string | null
      try {
        num = await web.getTrackingNumber(purchaseId)
      } catch (e) {
        pending?.close()
        throw e
      }
      if (!num) {
        pending?.close()
        return
      }
      const url = `https://t.17track.net/#nums=${encodeURIComponent(num)}`
      if (pending) pending.navigate(url)
      else env.open(url)
    },

    // Web 版では「取り込む」は PC への依頼。画面（App.vue）は sorobanWeb を直接使うので、ここは他の呼び出し口の保険
    async collect(): Promise<CollectorRun[]> {
      const job = await web.requestCollect()
      return job.runs ?? []
    },
  }

  return new Proxy({} as SorobanApi, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return undefined
      if (Object.prototype.hasOwnProperty.call(own, prop)) return (own as Record<string, unknown>)[prop]
      const hint = desktopOnlyMessage(prop)
      if (hint) {
        return async () => { throw new Error(hint) }
      }
      return (base as unknown as Record<string, unknown>)[prop]
    },
  })
}
