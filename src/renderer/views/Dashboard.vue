<script setup lang="ts">
import { ref, onMounted, watch, inject, type Ref } from 'vue'
import type { DashboardStats, VariantSummary } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import Skeleton from '../components/Skeleton.vue'

const stats = ref<DashboardStats | null>(null)
const revision = inject<Ref<number>>('revision')!
const goto = inject<(t: string) => void>('goto')!

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

async function load() {
  stats.value = await window.soroban.getDashboard()
}
onMounted(load)
watch(revision, load)

// 型番ランキング
const variants = ref<VariantSummary[]>([])
const variantsLoaded = ref(false)
const variantSort = ref<'total_profit' | 'avg_profit' | 'sold'>('total_profit')

async function loadVariants() {
  variantsLoaded.value = false
  variants.value = (await window.soroban.listVariantSummary(variantSort.value)).slice(0, 8)
  variantsLoaded.value = true
}
onMounted(loadVariants)
watch(revision, loadVariants)
watch(variantSort, loadVariants)

const runLabel: Record<string, string> = {
  ok: '正常',
  empty: '0件（要確認）',
  auth_required: 'ログインが必要',
  failed: '失敗',
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">ホーム</h1>
    </div>

    <template v-if="stats">
      <!-- 要対応。ここが0になるまでが毎日の作業 -->
      <div class="panel">
        <template v-if="stats.needsShipping || stats.needsMatch || stats.needsPurchaseConfirm">
          <p class="panel-title">要対応</p>
          <button v-if="stats.needsShipping" class="todo-row" @click="goto('sales')">
            <span class="num warn">{{ stats.needsShipping }}</span>
            <span>件 送料が未入力</span>
            <span class="grow" />
            <Icon name="arrow-right" :size="16" />
          </button>
          <button v-if="stats.needsMatch" class="todo-row" @click="goto('sales')">
            <span class="num warn">{{ stats.needsMatch }}</span>
            <span>件 仕入が未紐付け</span>
            <span class="grow" />
            <Icon name="arrow-right" :size="16" />
          </button>
          <button v-if="stats.needsPurchaseConfirm" class="todo-row" @click="goto('purchases')">
            <span class="num warn">{{ stats.needsPurchaseConfirm }}</span>
            <span>件 価格未入力の仕入</span>
            <span class="grow" />
            <Icon name="arrow-right" :size="16" />
          </button>
          <p class="faint hint">
            送料と紐付けを入れると利益が確定します。1件10秒で終わります。
          </p>
        </template>
        <div v-else class="todo-ok">
          <Icon name="check" :size="16" class="todo-ok-icon" />
          <span class="todo-ok-title">要対応なし</span>
          <span class="dim">すべての販売で利益が確定しています。</span>
        </div>
      </div>

      <!-- 今月 -->
      <div class="panel">
        <p class="panel-title">今月の転売</p>
        <div v-if="stats.thisMonth" class="stats">
          <div class="stat">
            <span class="stat-label">売上</span>
            <span class="stat-value num">{{ yen(stats.thisMonth.revenue) }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">原価</span>
            <span class="stat-value num dim">{{ yen(stats.thisMonth.total_cost) }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">手数料・送料</span>
            <span class="stat-value num dim">
              {{ yen(stats.thisMonth.total_fee + stats.thisMonth.total_shipping) }}
            </span>
          </div>
          <div class="stat">
            <span class="stat-label">粗利</span>
            <span
              class="stat-value lg num"
              :class="stats.thisMonth.gross_profit >= 0 ? 'profit' : 'loss'"
            >{{ yen(stats.thisMonth.gross_profit) }}</span>
            <span class="stat-sub">{{ stats.thisMonth.sales_count }}件</span>
          </div>
        </div>
        <p v-else class="dim">今月の販売はまだありません</p>

        <!-- 在庫。今月の転売と同じ白面の続きとして1行で -->
        <div class="stock-divider">
          <p class="panel-title">在庫</p>
          <div class="stats">
            <div class="stat">
              <span class="stat-label">未販売</span>
              <span class="stat-value num">{{ stats.stockCount }}<span class="unit"> 点</span></span>
            </div>
            <div class="stat">
              <span class="stat-label">寝ている資金</span>
              <span class="stat-value num">{{ yen(stats.stockValue) }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">長期滞留</span>
              <span class="stat-value num" :class="{ warn: stats.agingCount > 0 }">
                {{ stats.agingCount }}<span class="unit"> 点</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 型番ランキング -->
      <div class="panel">
        <div class="ranking-head">
          <p class="panel-title">型番ランキング</p>
          <span class="grow" />
          <select v-model="variantSort">
            <option value="total_profit">粗利合計</option>
            <option value="avg_profit">平均粗利</option>
            <option value="sold">販売数</option>
          </select>
        </div>
        <Skeleton v-if="!variantsLoaded" :rows="4" />
        <table v-else-if="variants.length" class="compact ranking-table">
          <thead>
            <tr>
              <th>型番</th>
              <th>商品</th>
              <th class="num">在庫</th>
              <th class="num">販売</th>
              <th class="num">平均売価</th>
              <th class="num">平均粗利</th>
              <th class="num">粗利計</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in variants" :key="v.model_code">
              <td><StatusChip tone="neutral" :label="v.model_code" /></td>
              <td class="ranking-name">{{ v.name }}</td>
              <td class="num">{{ v.in_stock }}</td>
              <td class="num">{{ v.sold }}</td>
              <td class="num">{{ v.avg_price != null ? yen(v.avg_price) : '—' }}</td>
              <td
                class="num"
                :class="v.avg_profit != null ? (v.avg_profit >= 0 ? 'profit' : 'loss') : ''"
              >{{ v.avg_profit != null ? yen(v.avg_profit) : '—' }}</td>
              <td class="num">
                <strong :class="v.total_profit >= 0 ? 'profit' : 'loss'">{{ yen(v.total_profit) }}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="dim">型番付きの在庫・販売が増えると、ここに実績が並びます</p>
      </div>

      <!-- 取り込み -->
      <div v-if="stats.lastRun" class="intake">
        <StatusChip
          :tone="stats.lastRun.status === 'ok' ? 'ok' : 'warn'"
          :label="runLabel[stats.lastRun.status] ?? stats.lastRun.status"
        />
        <span class="dim">
          {{ new Date(stats.lastRun.started_at).toLocaleString('ja-JP') }}
        </span>
        <span class="faint">
          取得 {{ stats.lastRun.fetched }}／追加 {{ stats.lastRun.inserted }}
        </span>
      </div>
      <p v-if="stats.lastRun?.message" class="faint intake-msg">{{ stats.lastRun.message }}</p>
      <p v-if="!stats.lastRun" class="dim intake">
        まだ取り込んでいません。右上の「取り込む」を押してください。
      </p>
    </template>

    <template v-else>
      <div class="panel">
        <p class="panel-title">要対応</p>
        <Skeleton kind="stats" />
      </div>
      <div class="panel">
        <p class="panel-title">今月の転売</p>
        <Skeleton kind="stats" />
      </div>
      <div class="panel">
        <p class="panel-title">在庫</p>
        <Skeleton kind="stats" />
      </div>
      <div class="panel">
        <p class="panel-title">型番ランキング</p>
        <Skeleton :rows="4" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.todo-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 10px 4px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  height: auto;
}
.todo-row:last-of-type { border-bottom: none; }
.todo-row:hover { background: var(--surface-hi); }
.todo-row .num.warn {
  font-size: var(--fs-20);
  font-weight: 600;
  text-align: left;
}

.hint { margin: 10px 0 0; font-size: var(--fs-12); }

.todo-ok {
  display: flex;
  align-items: center;
  gap: 8px;
}
.todo-ok-icon { color: var(--profit); flex-shrink: 0; }
.todo-ok-title { font-size: var(--fs-14); font-weight: 600; }

.unit { font-size: var(--fs-12); font-weight: 400; color: var(--text-faint); }

.stock-divider {
  border-top: 1px solid var(--line-soft);
  margin-top: 16px;
  padding-top: 16px;
}

.intake {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  font-size: var(--fs-13);
}
.intake-msg { margin: 4px 0 0; font-size: var(--fs-13); }

.ranking-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.ranking-head .panel-title { margin: 0; }
.ranking-table { table-layout: fixed; }
.ranking-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
