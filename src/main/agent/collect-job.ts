import type { AgentFinishStatus } from '../../shared/agent-types'
import type { CollectorRun } from '../../shared/types'
import type { RemoteStore } from '../store/remote'
import type { CollectorStore } from '../store/types'
import { AgentHttpError, AgentStoppedError, LeaseLostError, errorText } from './errors'
import type { JobGuard } from './guard'

// ============================================================
// 取り込み 1 回分（claim で取った lease の間）に何をどの順で収集するか
//
// 順序は メルカリ → Yahoo!フリマ → メロジョイ（サーバーの計画 getCollectPlan の仕入先ごと）。**直列**。
// 同じサイトを同時に叩かない・頻度を上げない（収集そのもの＝待ち時間・ページ数・CAPTCHA で止まる動きは変えない）。
// 17TRACK はここでは呼ばない（サーバーの定期実行がやる）。
// ============================================================

export interface JobCollectors {
  mercari(silent: boolean, store: CollectorStore): Promise<CollectorRun>
  yahoo(silent: boolean, store: CollectorStore): Promise<CollectorRun>
  mellojoy(shopAccountId: string, silent: boolean, store: CollectorStore): Promise<CollectorRun>
}

export interface CollectJobDeps {
  store: RemoteStore
  guard: JobGuard
  silent: boolean
  collectors: JobCollectors
  log(kind: string, message: string, payload?: Record<string, unknown>): void
}

export interface CollectJobResult {
  /** finish に渡す終わり方。lease を失った・やめたときは意味を持たない（finish を呼ばない） */
  status: AgentFinishStatus
  /** recordRun が返した実行記録の id（finish の run_ids） */
  runIds: string[]
  /** 人に見せる補足（500 文字まで）。実行記録だけで足りるときは null（サーバーが作る） */
  message: string | null
  runs: CollectorRun[]
  /** lease を失った／こちらからやめた（finish を呼ばない） */
  aborted: boolean
}

const MESSAGE_MAX = 500

const isBad = (r: CollectorRun): boolean => r.status === 'failed' || r.status === 'auth_required'

/**
 * 終わり方の決め方（server/agent/jobs.ts の finish の規則に合わせる）。
 *  - 全部 ok / empty で、途中で止めた形跡が無い → done（実行記録が 1 つ以上）
 *  - 途中で止めた（収集が例外・通信が続かない）／失敗・要ログインが混ざる →
 *      終わった分（ok / empty）が 1 つでもあれば partial、1 つも無ければ failed
 *  - 実行記録が 1 つも無い → failed
 */
export function decideFinishStatus(runs: CollectorRun[], incomplete: boolean): AgentFinishStatus {
  if (runs.length === 0) return 'failed'
  const hasGood = runs.some(r => !isBad(r))
  if (!incomplete && !runs.some(isBad)) return 'done'
  return hasGood ? 'partial' : 'failed'
}

/** 収集が投げた例外の扱い。abort＝やめる（lease を失った・こちらから止めた）／ cut＝残りも諦める／ go＝次へ進む */
function classify(e: unknown): 'abort' | 'cut' | 'go' {
  if (e instanceof LeaseLostError || e instanceof AgentStoppedError) return 'abort'
  // サーバーに届かない・5xx・鍵が使えない：残りを続けても書けない。メルカリなどへのアクセスを無駄に増やさない
  if (e instanceof AgentHttpError && (e.status === 0 || e.status >= 500 || e.code === 'unauthorized')) return 'cut'
  return 'go'
}

export async function runCollectJob(deps: CollectJobDeps): Promise<CollectJobResult> {
  const { store, guard, silent, collectors, log } = deps
  const problems: string[] = []
  let incomplete = false

  const finishResult = (): CollectJobResult => {
    const runs = store.recordedRuns()
    const status = decideFinishStatus(runs, incomplete)
    const message = problems.length > 0 ? problems.join('。').slice(0, MESSAGE_MAX) : null
    return { status, runIds: runs.map(r => r.id), message, runs, aborted: guard.tripped }
  }

  // 仕入先の一覧は計画から。読めなければ何も取りに行かない（サーバーの不調のときに外のサイトを叩かない）
  let shopAccounts: Array<{ id: string; name: string }>
  try {
    shopAccounts = (await store.getCollectPlan()).shop_accounts
  } catch (e) {
    if (classify(e) !== 'abort') problems.push(`取り込みの計画を読めませんでした：${errorText(e)}`)
    incomplete = true
    return finishResult()
  }

  const sources: Array<{ label: string; run: () => Promise<CollectorRun> }> = [
    { label: 'メルカリ', run: () => collectors.mercari(silent, store) },
    { label: 'Yahoo!フリマ', run: () => collectors.yahoo(silent, store) },
    ...shopAccounts.map(a => ({
      label: `メロジョイ（${a.name}）`,
      run: () => collectors.mellojoy(a.id, silent, store),
    })),
  ]

  for (const source of sources) {
    if (guard.tripped) { incomplete = true; break }
    try {
      const run = await source.run()
      log('collect_source', `${source.label}: ${run.status}`, { fetched: run.fetched, inserted: run.inserted })
    } catch (e) {
      const kind = classify(e)
      log('collect_source', `${source.label}の収集を続けられませんでした`, { error: errorText(e), kind })
      incomplete = true
      if (kind === 'abort') break
      problems.push(`${source.label}：${errorText(e)}`)
      if (kind === 'cut') break
    }
  }
  // 途中で打ち切られた（guard が立った）のに、最後の source が普通に返ってきた場合も、未完了として扱う
  if (guard.tripped) incomplete = true

  return finishResult()
}
