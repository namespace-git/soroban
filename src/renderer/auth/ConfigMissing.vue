<script setup lang="ts">
// Supabase の設定（環境変数）が足りないときの画面。何が足りないかを日本語で出す。
// 設定を入れるのは管理している人（家族は触らない）。
defineProps<{ problems: string[] }>()
</script>

<template>
  <div class="auth-screen">
    <div class="auth-card" role="alert">
      <div class="auth-brand">
        <span class="auth-badge">そ</span>
        <h1 class="auth-title">そろばん</h1>
      </div>

      <p class="auth-lead">Web 版をつなぐための設定が足りません。</p>

      <ul class="auth-problems">
        <li v-for="p in problems" :key="p">{{ p }}</li>
      </ul>

      <div class="auth-how">
        <p class="auth-how-title">設定のしかた</p>
        <ol>
          <li><code>web/.env.web.example</code> を <code>web/.env.web.local</code> という名前でコピーする</li>
          <li>Supabase の Project URL と anon キーを入れる（service_role キーは入れない）</li>
          <li>開発サーバーを起動し直す（Cloudflare Pages では「環境変数」に入れて再デプロイ）</li>
        </ol>
        <p class="auth-help">くわしくは <code>docs/web/01-setup.md</code> にあります。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 外枠（.auth-screen / .auth-card など）は style.css。ここは説明が長いぶん少し広く */
.auth-card { max-width: 480px; }

.auth-lead {
  margin: 0;
  font-weight: 600;
}

.auth-problems {
  margin: 0;
  padding: 10px 12px 10px 28px;
  border-radius: var(--radius-md);
  background: var(--warn-bg);
  color: var(--warn);
  font-size: var(--fs-13);
  overflow-wrap: anywhere;
}

.auth-how {
  font-size: var(--fs-13);
  color: var(--text-dim);
}
.auth-how-title {
  margin: 0 0 6px;
  font-weight: 600;
  color: var(--text);
}
.auth-how ol {
  margin: 0;
  padding-left: 20px;
}
.auth-how li + li { margin-top: 4px; }
.auth-how code {
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--surface-hi);
  font-size: var(--fs-12);
  overflow-wrap: anywhere;
}

.auth-help {
  margin-top: 8px;
  text-align: left;
}
</style>
