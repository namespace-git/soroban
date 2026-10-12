// ログインの状態（Supabase Auth のメール＋パスワード）。Web 版だけ。
//
// 画面（WebRoot.vue）は status を見て ログイン画面／アプリ を切り替える。
// HTTP クライアント（api/http.ts）は getAccessToken() で都度トークンを取る。
// 期限切れの更新は supabase-js（autoRefreshToken）に任せる。
import { ref } from 'vue'
import type { AuthError, Session } from '@supabase/supabase-js'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { AUTH_STORAGE_KEY, getSupabase } from './supabase'

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

const status = ref<AuthStatus>('loading')
const email = ref<string | null>(null)
let started: Promise<void> | null = null

function apply(session: Session | null): void {
  status.value = session ? 'signed-in' : 'signed-out'
  email.value = session?.user.email ?? null
}

export function useAuth() {
  return { status, email }
}

/** 保存済みのセッションを読み、以後の変化（ログアウト・別のタブでの変更）を追う。何度呼んでもよい */
export function startAuth(): Promise<void> {
  if (!started) {
    started = (async () => {
      const supabase = getSupabase()
      // コールバックの中では supabase の別の呼び出しをしない（デッドロックする）。状態を写すだけ
      supabase.auth.onAuthStateChange((_event, session) => apply(session))
      try {
        const { data } = await supabase.auth.getSession()
        apply(data.session)
      } catch {
        apply(null)
      }
    })()
  }
  return started
}

/** 今のアクセストークン（JWT）。ログインしていなければ null。通信できないだけのときはログアウト扱いにせず例外にする */
export async function getAccessToken(): Promise<string | null> {
  const { data, error } = await getSupabase().auth.getSession()
  if (data.session) return data.session.access_token
  if (error && isAuthRetryableFetchError(error)) {
    throw new Error('サーバーにつながりません。通信の状態を確かめてください')
  }
  return null
}

/** Supabase の英語のエラーを、人に見せてよい日本語にする（生のエラーは出さない） */
function loginErrorMessage(e: AuthError): string {
  const code = e.code ?? ''
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(e.message)) {
    return 'メールアドレスかパスワードが違います'
  }
  if (code === 'email_not_confirmed') {
    return 'メールアドレスの確認が済んでいません。管理している人に連絡してください'
  }
  if (code === 'user_banned') {
    return 'このアカウントは使えません。管理している人に連絡してください'
  }
  if (code === 'over_request_rate_limit' || e.status === 429) {
    return '試した回数が多すぎます。しばらくしてからもう一度お試しください'
  }
  if (isAuthRetryableFetchError(e) || e.status === 0) {
    return 'サーバーにつながりません。通信の状態を確かめてください'
  }
  return 'ログインできませんでした。しばらくしてからもう一度お試しください'
}

/** 失敗は日本語の Error。成功すると onAuthStateChange が status を動かす */
export async function signIn(emailAddress: string, password: string): Promise<void> {
  let error: AuthError | null
  try {
    ;({ error } = await getSupabase().auth.signInWithPassword({ email: emailAddress.trim(), password }))
  } catch {
    throw new Error('ログインできませんでした。しばらくしてからもう一度お試しください')
  }
  if (error) throw new Error(loginErrorMessage(error))
}

/** ログアウトの前に Push の購読を外すのを待つ上限（ms）。通信が切れていても、ログアウトをこれ以上待たせない */
export const PUSH_RELEASE_TIMEOUT_MS = 3000

/**
 * この端末の Push の購読を外す。ログアウトした端末に、売れた商品名・金額の通知が届き続けないように。
 *   - サーバー側の購読を消す（API が通る、ログイン中のうちに）
 *   - ブラウザ側の購読を外す。サーバーの削除が失敗しても外す：外した購読への送信は 404・410 になり、サーバーが購読ごと消す
 *     （2 つは並べて行う。サーバーの返事を待って外すと、通信が切れているときに外せない）
 * service worker や PushManager が無い環境（デスクトップ版・古いブラウザ）、購読が無い端末では何もしない。
 * どこで失敗しても例外にしない（ログアウトを止めない）
 */
async function releasePushSubscription(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    // ready は service worker が無いと待ち続ける（開発サーバー）。先に登録の有無を見る（PushSettings と同じ）
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = registration ? await registration.pushManager.getSubscription() : null
    if (!subscription) return
    const server = Promise.resolve().then(() => window.sorobanWeb?.deletePushSubscription(subscription.endpoint))
    const browser = Promise.resolve().then(() => subscription.unsubscribe())
    await Promise.allSettled([server, browser])
  } catch {
    // 取れなかった・外せなかった。ログアウトは続ける
  }
}

/** 待ちすぎない：work が終わるか ms 経つか、早い方で解決する（work の失敗は呼び出し側で握りつぶしてある前提） */
function waitAtMost(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void work.then(() => { clearTimeout(timer); resolve() })
  })
}

let signingOut: Promise<void> | null = null

/**
 * この端末のログインを外す。通信できなくても、この端末では必ずログアウトした状態にする。
 * 画面の読み込みで API が一斉に unauthorized を返しても、ログアウトの通信は 1 回だけ。
 * 先に（ログイン中のうちに）この端末の Push の購読を外す。3 秒待っても終わらなければ、そのままログアウトする
 */
export function signOut(): Promise<void> {
  signingOut ??= (async () => {
    await waitAtMost(releasePushSubscription(), PUSH_RELEASE_TIMEOUT_MS)
    try {
      const { error } = await getSupabase().auth.signOut({ scope: 'local' })
      if (error) localStorage.removeItem(AUTH_STORAGE_KEY)
    } catch {
      localStorage.removeItem(AUTH_STORAGE_KEY)
    }
    apply(null)
  })().finally(() => { signingOut = null })
  return signingOut
}
