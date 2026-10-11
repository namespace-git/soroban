<script setup lang="ts">
// Web 版のいちばん外側。ログインの状態で ログイン画面／アプリ を切り替える。
// ログインしていればログイン画面を出さずにそのままアプリ。ログアウト（またはサーバーの unauthorized）で
// アプリごと外す（次にログインする人に前の人の画面が残らない）。
import { onMounted, provide, reactive } from 'vue'
import App from '../App.vue'
import LoginView from './LoginView.vue'
import ConfigMissing from './ConfigMissing.vue'
import { configProblems } from './supabase'
import { startAuth, useAuth, signOut } from './session'

const problems = configProblems()
const { status, email } = useAuth()

// App.vue が（Web のときだけ）ログアウトとアカウントを出すための受け口。Electron 版には存在しない
provide('webAccount', reactive({ email, logout: signOut }))

onMounted(() => {
  if (!problems.length) startAuth()
})
</script>

<template>
  <ConfigMissing v-if="problems.length" :problems="problems" />
  <div v-else-if="status === 'loading'" class="boot">
    <span class="auth-badge">そ</span>
    <span class="boot-text">読み込み中…</span>
  </div>
  <LoginView v-else-if="status === 'signed-out'" />
  <App v-else />
</template>

<style scoped>
.boot {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--canvas);
  color: var(--text-faint);
  font-size: var(--fs-13);
}
</style>
