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

let signingOut: Promise<void> | null = null

/**
 * この端末のログインを外す。通信できなくても、この端末では必ずログアウトした状態にする。
 * 画面の読み込みで API が一斉に unauthorized を返しても、ログアウトの通信は 1 回だけ
 */
export function signOut(): Promise<void> {
  signingOut ??= (async () => {
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
