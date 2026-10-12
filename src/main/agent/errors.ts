import type { AgentErrorCode } from '../../shared/agent-types'

// ============================================================
// 取り込み担当（Web 版の取り込み）の通信まわりのエラー
//
// 文言は人に見せてよい日本語だけ（鍵・トークン・lease_token は入れない）。
// ============================================================

/** 取り込みの権限（lease）が失効した／別の端末が引き継いだ。**取り込みをそのままやめる**（やり直さない） */
export class LeaseLostError extends Error {
  constructor(message = '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）') {
    super(message)
    this.name = 'LeaseLostError'
  }
}

/** ログアウトなどで取り込み担当をやめた。以後の書き込みは通信せずに断る */
export class AgentStoppedError extends Error {
  constructor(message = '取り込み担当をやめたため、取り込みを止めました') {
    super(message)
    this.name = 'AgentStoppedError'
  }
}

/** サーバー（または通信）の失敗。status 0 は通信できなかった（圏外・サーバー停止・時間切れ） */
export class AgentHttpError extends Error {
  readonly code: AgentErrorCode | 'network' | 'server_error'
  readonly status: number

  constructor(code: AgentHttpError['code'], status: number, message: string) {
    super(message)
    this.name = 'AgentHttpError'
    this.code = code
    this.status = status
  }

  /** 5xx と通信切れだけ、やり直してよい（4xx は直さないかぎり同じ結果。lease_lost はやり直さない） */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
