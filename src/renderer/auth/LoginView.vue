<script setup lang="ts">
// ログイン画面。メールアドレスとパスワードだけ（新規登録は出さない。アカウントは事前に登録されたものだけ）。
import { ref } from 'vue'
import Icon from '../components/Icon.vue'
import { signIn } from './session'

const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  if (busy.value) return
  if (!email.value.trim() || !password.value) {
    error.value = 'メールアドレスとパスワードを入れてください'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await signIn(email.value, password.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'ログインできませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="auth-screen">
    <form class="auth-card" novalidate @submit.prevent="submit">
      <div class="auth-brand">
        <span class="auth-badge">そ</span>
        <h1 class="auth-title">そろばん</h1>
      </div>

      <label class="field">
        メールアドレス
        <input
          v-model.trim="email"
          type="email"
          name="email"
          autocomplete="username"
          inputmode="email"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          :disabled="busy"
        />
      </label>

      <label class="field">
        パスワード
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          :disabled="busy"
        />
      </label>

      <p v-if="error" class="auth-error" role="alert">
        <Icon name="alert" :size="16" />
        <span>{{ error }}</span>
      </p>

      <button class="primary auth-submit" type="submit" :disabled="busy">
        {{ busy ? 'ログインしています…' : 'ログイン' }}
      </button>

      <p class="auth-help">ログインできないときは、管理している人に連絡してください。</p>
    </form>
  </div>
</template>

<style scoped>
/* 外枠（.auth-screen / .auth-card など）は style.css。ここはログインの入力欄だけ */

/* 触る場所なので 44px 以上。文字は 16px（iPhone は 16px 未満の入力欄に触れると画面を拡大してしまう） */
.auth-card input {
  height: 44px;
  font-size: var(--fs-16);
}
.auth-submit {
  height: 48px;
  font-size: var(--fs-16);
}

.auth-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--warn-bg);
  color: var(--warn);
  font-size: var(--fs-13);
}
.auth-error :deep(svg) { flex-shrink: 0; margin-top: 2px; }
</style>
