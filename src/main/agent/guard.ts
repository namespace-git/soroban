import { AgentStoppedError, LeaseLostError } from './errors'

/**
 * 取り込み 1 回（1 つの lease）の「続けてよいか」の印。runner（heartbeat・ログアウト）と
 * リモートの store（書き込みの前に check する）が共有する。
 *
 * lease を失った・やめたあとは、store が**通信せずに**投げる（失効した lease で何度も叩かない）。
 * 収集のコード（collector*.ts）は例外を途中で握ることがあるが、次の store 呼び出しで同じ例外が出るので、
 * 最後の recordRun で必ず外に出る。
 */
export class JobGuard {
  private reason: 'lease_lost' | 'stopped' | null = null

  /** lease を失った（heartbeat か書き込みが lease_lost を受けた） */
  loseLease(): void {
    this.reason ??= 'lease_lost'
  }

  /** ログアウト・モードの切り替えなどで、こちらからやめる */
  stop(): void {
    this.reason ??= 'stopped'
  }

  get lost(): boolean {
    return this.reason === 'lease_lost'
  }

  get stopped(): boolean {
    return this.reason === 'stopped'
  }

  get tripped(): boolean {
    return this.reason !== null
  }

  /** 続けてはいけないなら投げる */
  check(): void {
    if (this.reason === 'lease_lost') throw new LeaseLostError()
    if (this.reason === 'stopped') throw new AgentStoppedError()
  }
}
