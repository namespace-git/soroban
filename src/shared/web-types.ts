// ============================================================
// Web 版だけの契約（WebApi）
//
// `SorobanApi`（types.ts）はデスクトップ版と Web 版の共通の契約で、変えない。
// Web 版にしか無いもの（取り込みの要求・Push 通知・取り込み担当の PC）はここに置く。
// 画面からは `window.sorobanWeb`（Web 版のときだけ在る。デスクトップ版では undefined）で呼ぶ。
// 通信は `SorobanApi` と同じ `POST /api/rpc/<method>`（server/rpc.ts が両方の名前を受け付ける）。
//
// 設計：docs/web/03-agent-and-push.md
// ============================================================
import type { CollectorRun } from './types'

/**
 * 取り込みの要求の状態。
 * queued = 積まれた（PC が拾うのを待っている）／ running = PC が取り込み中 ／
 * done = 全部終わった ／ partial = 途中で止まった（終わった段の分は入っている。次の取り込みで埋まる）／
 * failed = 失敗（要ログインなど）／ cancelled = 始まる前に取り消された・誰も拾わなかった
 */
export type CollectJobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled'

export interface CollectJob {
  id: string
  status: CollectJobStatus
  /** 押した日時（ISO） */
  requested_at: string
  /** 押したのが今ログインしている人か */
  requested_by_me: boolean
  /** 拾った PC の名前（「リビングの PC」）。まだ拾われていなければ null */
  agent_name: string | null
  claimed_at: string | null
  /** PC から最後に「生きている」と届いた日時 */
  heartbeat_at: string | null
  finished_at: string | null
  /** 取り込みの結果（デスクトップ版の `collect()` の戻りと同じ形）。終わっていなければ null */
  runs: CollectorRun[] | null
  /** 失敗・取り消しの理由など、人に見せる日本語。無ければ null */
  message: string | null
}

/** 「取り込む」ボタンの横に出す状態 */
export interface CollectStatus {
  /** いま積まれている・走っている要求。無ければ直近に終わったもの。1 度も無ければ null */
  job: CollectJob | null
  /** 直近の 5 分以内に「生きている」と届いた取り込み担当の PC の数（0 なら押しても誰も拾わない） */
  agents_online: number
  /** 次に押せるまでの秒数（クールダウン中でなければ 0） */
  cooldown_seconds: number
}

/** 通知の種類ごとの受け取り設定 */
export interface PushKinds {
  /** 売れた */
  sale: boolean
  /** 発送の番になった */
  shipping: boolean
  /** 取り込みが失敗した・ログインが要る・0 件だった */
  collect: boolean
  /** 仕入が届いた */
  arrival: boolean
}

/** 通知を受け取る端末（ブラウザの購読） */
export interface PushDevice {
  id: string
  /** 端末の名前（「iPhone」「リビングの PC」など。登録のときに付ける） */
  label: string
  kinds: PushKinds
  created_at: string
  /** この端末（いま開いているブラウザ）か */
  is_this_device: boolean
}

export interface PushSubscriptionInput {
  /** PushSubscription.endpoint */
  endpoint: string
  /** PushSubscription.getKey('p256dh') の base64url */
  p256dh: string
  /** PushSubscription.getKey('auth') の base64url */
  auth: string
  label: string
  kinds: PushKinds
}

/** 取り込み担当の PC */
export interface AgentDevice {
  id: string
  name: string
  first_seen_at: string
  last_seen_at: string
  /** 直近の 5 分以内に「生きている」と届いたか */
  online: boolean
  /** 取り消し済み（以後、取り込み担当の鍵を出さない） */
  revoked: boolean
}

export interface WebApi {
  // --- 取り込み（PC の取り込み担当に頼む） ---
  /** 取り込みを頼む。走っている・クールダウン中なら日本語のエラー */
  requestCollect(): Promise<CollectJob>
  /** 「取り込む」ボタンの状態。走っている間は画面が数秒ごとに読む */
  getCollectStatus(): Promise<CollectStatus>
  /** 始まる前（queued）なら取り消す。始まった後は日本語のエラー */
  cancelCollectJob(id: string): Promise<void>

  // --- 取り込み担当の PC ---
  listAgentDevices(): Promise<AgentDevice[]>
  /** その PC に、以後取り込み担当の鍵を出さない */
  revokeAgentDevice(id: string): Promise<void>

  // --- Push 通知 ---
  /** VAPID の公開鍵。サーバーに設定が無ければ null（通知の設定を出さない） */
  getPushConfig(): Promise<{ vapid_public_key: string | null }>
  /** この端末で受け取る（同じ endpoint があれば上書き） */
  savePushSubscription(input: PushSubscriptionInput): Promise<void>
  /** この端末で受け取るのをやめる */
  deletePushSubscription(endpoint: string): Promise<void>
  /** 通知を受け取る端末の一覧。`currentEndpoint` はこの端末の endpoint（無ければ null） */
  listPushDevices(currentEndpoint: string | null): Promise<PushDevice[]>
  setPushKinds(deviceId: string, kinds: PushKinds): Promise<void>
  /** 自分の端末すべてに試しの通知を送る（届くかの確認） */
  sendTestPush(): Promise<{ sent: number; failed: number }>

  // --- ブラウザで開くもの ---
  /** 仕入の追跡番号（17TRACK のページを画面が開く）。無ければ null */
  getTrackingNumber(purchaseId: string): Promise<string | null>
}
