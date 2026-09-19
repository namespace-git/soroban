<script setup lang="ts">
import { ref, onMounted, watch, inject, type Ref } from 'vue'
import type { DashboardStats } from '../../shared/types'

const stats = ref<DashboardStats | null>(null)
const revision = inject<Ref<number>>('revision')!
const goto = inject<(t: string) => void>('goto')!

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

async function load() {
  stats.value = await window.soroban.getDashboard()
}
onMounted(load)
watch(revision, load)

const runLabel: Record<string, string> = {
  ok: '正常',
  empty: '0件（要確認）',
  auth_required: 'ログインが必要',
  failed: '失敗',
}
</script>

<template>
  <div v-if="stats" class="wrap">
    <!-- 要対応。ここが0になるまでが毎日の作業 -->
    <section v-if="stats.needsShipping || stats.needsMatch" class="todo">
      <h2>要対応</h2>
      <div class="row">
        <button v-if="stats.needsShipping" class="todo-btn" @click="goto('sales')">
          <strong class="num">{{ stats.needsShipping }}</strong>
          <span>件 送料が未入力</span>
        </button>
        <button v-if="stats.needsMatch" class="todo-btn" @click="goto('sales')">
          <strong class="num">{{ stats.needsMatch }}</strong>
          <span>件 仕入が未紐付け</span>
        </button>
      </div>
      <p class="faint hint">
        送料と紐付けを入れると利益が確定します。1件10秒で終わります。
      </p>
    </section>

    <section v-else class="todo done">
      <h2>要対応なし</h2>
      <p class="dim">すべての販売で利益が確定しています。</p>
    </section>

    <!-- 今月 -->
    <section>
      <h2>今月の転売</h2>
      <div v-if="stats.thisMonth" class="kpis">
        <div class="kpi">
          <span class="label">売上</span>
          <span class="value num">{{ yen(stats.thisMonth.revenue) }}</span>
        </div>
        <div class="kpi">
          <span class="label">原価</span>
          <span class="value num dim">{{ yen(stats.thisMonth.total_cost) }}</span>
        </div>
        <div class="kpi">
          <span class="label">手数料・送料</span>
          <span class="value num dim">
            {{ yen(stats.thisMonth.total_fee + stats.thisMonth.total_shipping) }}
          </span>
        </div>
        <div class="kpi main">
          <span class="label">粗利</span>
          <span
            class="value num"
            :class="stats.thisMonth.gross_profit >= 0 ? 'profit' : 'loss'"
          >{{ yen(stats.thisMonth.gross_profit) }}</span>
          <span class="sub faint">{{ stats.thisMonth.sales_count }}件</span>
        </div>
      </div>
      <div v-else class="empty">今月の販売はまだありません</div>
    </section>

    <!-- 在庫 -->
    <section>
      <h2>在庫</h2>
      <div class="kpis">
        <div class="kpi">
          <span class="label">未販売</span>
          <span class="value num">{{ stats.stockCount }}<small> 点</small></span>
        </div>
        <div class="kpi">
          <span class="label">寝ている資金</span>
          <span class="value num">{{ yen(stats.stockValue) }}</span>
        </div>
        <div class="kpi">
          <span class="label">長期滞留</span>
          <span class="value num" :class="{ warn: stats.agingCount > 0 }">
            {{ stats.agingCount }}<small> 点</small>
          </span>
        </div>
      </div>
    </section>

    <!-- 取り込み -->
    <section>
      <h2>取り込み</h2>
      <div v-if="stats.lastRun" class="run">
        <span class="badge" :class="{ warn: stats.lastRun.status !== 'ok' }">
          {{ runLabel[stats.lastRun.status] ?? stats.lastRun.status }}
        </span>
        <span class="dim">
          {{ new Date(stats.lastRun.started_at).toLocaleString('ja-JP') }}
        </span>
        <span class="faint">
          取得 {{ stats.lastRun.fetched }}／追加 {{ stats.lastRun.inserted }}
        </span>
      </div>
      <p v-if="stats.lastRun?.message" class="faint msg">{{ stats.lastRun.message }}</p>
      <p v-if="!stats.lastRun" class="dim">まだ取り込んでいません。右上の「取り込む」を押してください。</p>
    </section>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; gap: 28px; max-width: 900px; }

h2 {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  margin: 0 0 10px;
}

.todo h2 { color: var(--warn); }
.todo.done h2 { color: var(--profit); }

.todo-btn {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 14px 20px;
  background: var(--warn-bg);
  border-color: var(--warn);
  color: var(--warn);
}
.todo-btn strong { font-size: 24px; font-weight: 600; }
.hint { margin: 10px 0 0; font-size: 12px; }

.kpis { display: flex; gap: 12px; flex-wrap: wrap; }

.kpi {
  flex: 1;
  min-width: 140px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kpi.main { border-color: var(--line); background: var(--surface-hi); }

.label { font-size: 12px; color: var(--text-dim); }
.value { font-size: 20px; font-weight: 600; text-align: left; }
.value small { font-size: 12px; font-weight: 400; color: var(--text-dim); }
.value.warn { color: var(--warn); }
.sub { font-size: 11px; }

.run { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.msg { margin: 8px 0 0; font-size: 12px; }
</style>
