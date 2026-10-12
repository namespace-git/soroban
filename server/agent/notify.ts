import type { AgentFinishStatus } from '../../src/shared/agent-types'
import type { CollectorRun } from '../../src/shared/types'

/** 取り込みの終わりの通知（kind = 'collect'）。押すと開く画面（ホームの「要対応」） */
export const COLLECT_NOTIFICATION_URL = '/'

const TITLE_MAX = 200
const BODY_MAX = 1000

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** 取り込み元の呼び名（メロジョイは仕入先の名前つき） */
export function runLabel(run: Pick<CollectorRun, 'source' | 'shop_account_name'>): string {
  if (run.source === 'mercari') return 'メルカリ'
  if (run.source === 'yahoo') return 'Yahoo!フリマ'
  return run.shop_account_name ? `メロジョイ（${run.shop_account_name}）` : 'メロジョイ'
}

const STATUS_TEXT: Record<CollectorRun['status'], string> = {
  ok: '成功',
  auth_required: 'ログインが必要です',
  failed: '失敗しました',
  empty: '0 件でした',
}

/** 問題のある実行記録（ok 以外）を 1 行ずつ。通知の本文と、画面に出す補足に使う */
export function describeProblems(runs: CollectorRun[]): string {
  return runs
    .filter((r) => r.status !== 'ok')
    .map((r) => `${runLabel(r)}：${STATUS_TEXT[r.status]}${r.message ? `（${r.message}）` : ''}`)
    .join('\n')
}

const joinLabels = (runs: CollectorRun[]): string => [...new Set(runs.map(runLabel))].join('・')

/**
 * 取り込みが終わったときの通知の文面。**失敗・要ログイン・0 件**のどれかがあるとき（または途中で止まった／失敗で終わった）
 * だけ作る。全部 ok なら null（通知を積まない）。文面に PC の名前を入れる。
 * 優先は 要ログイン > 失敗 > 0 件 > 途中で止まった。
 */
export function collectNotification(
  status: AgentFinishStatus, runs: CollectorRun[], pcName: string, message: string | null,
): { title: string; body: string } | null {
  const auth = runs.filter((r) => r.status === 'auth_required')
  const failed = runs.filter((r) => r.status === 'failed')
  const empty = runs.filter((r) => r.status === 'empty')

  let title: string | null = null
  if (auth.length > 0) title = `${joinLabels(auth)}にログインが必要です（${pcName}）`
  else if (failed.length > 0) title = `${joinLabels(failed)}の取り込みに失敗しました（${pcName}）`
  else if (status === 'failed') title = `取り込みに失敗しました（${pcName}）`
  else if (empty.length > 0) title = `${joinLabels(empty)}の取り込みが 0 件でした（${pcName}）`
  else if (status === 'partial') title = `取り込みが途中で止まりました（${pcName}）`
  if (title === null) return null

  const problems = describeProblems(runs)
  const body = [problems, message ?? ''].filter((s) => s !== '').join('\n')
  return { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX) }
}
