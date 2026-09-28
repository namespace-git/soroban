import { CHANNEL_LABEL } from '../../shared/types'
import type { CollectorRun } from '../../shared/types'

/**
 * 取り込み実行記録（CollectorRun）の「対象」表示名。
 * メルカリ・Yahoo!フリマは CHANNEL_LABEL、メロジョイは複数アカウントがあるのでアカウント名
 * （無ければ「メロジョイ」）。実行履歴・ホームの要対応・取り込み後のトーストで表示が食い違わないよう、
 * ここに一本化する（以前は App.vue と Settings.vue に同じ式が別々に書かれ、
 * CollectorSource に 'yahoo' が増えたときに片方だけ直し忘れて「メロジョイ」と誤表示していた）
 */
export function runSourceLabel(run: Pick<CollectorRun, 'source' | 'shop_account_name'>): string {
  if (run.source === 'mercari' || run.source === 'yahoo') return CHANNEL_LABEL[run.source]
  return run.shop_account_name ?? 'メロジョイ'
}
