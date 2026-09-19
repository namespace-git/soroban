<script setup lang="ts">
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
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

// 要対応の合計（送料未入力＋未紐付け＋価格未入力の仕入）
const needsTotal = computed(() => {
  if (!stats.value) return 0
  return stats.value.needsShipping + stats.value.needsMatch + stats.value.needsPurchaseConfirm
})

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
      <div class="home-grid">
        <!-- 主要指標。ここだけ見れば今の状態がわかる -->
        <div class="home-summary">
          <div class="stat-card brand">
            <span class="stat-card-label">今月の粗利</span>
            <span class="stat-card-value">{{ yen(stats.thisMonth?.gross_profit ?? 0) }}</span>
            <span class="stat-card-sub">
              売上 {{ yen(stats.thisMonth?.revenue ?? 0) }} ・ 件数 {{ stats.thisMonth?.sales_count ?? 0 }} 件
            </span>
          </div>

          <div class="stat-card cream">
            <span class="stat-card-label">要対応</span>
            <span class="stat-card-value">{{ needsTotal }}<span class="unit">件</span></span>
          </div>

          <div class="stat-card cream">
            <span class="stat-card-label">在庫</span>
            <span class="stat-card-value">{{ stats.stockCount }}<span class="unit">点</span></span>
            <span class="stat-card-sub">{{ yen(stats.stockValue) }}</span>
            <span v-if="stats.agingCount > 0" class="stat-card-sub warn">
              長期滞留 {{ stats.agingCount }} 点
            </span>
          </div>
        </div>

        <!-- 要対応の内訳と型番ランキング -->
        <div class="home-detail">
          <div class="panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="alert" :size="16" /></span>
              <h2 class="section-head-title">要対応</h2>
            </div>

            <button
              class="need-row"
              :class="{ zero: stats.needsShipping === 0 }"
              @click="goto('sales')"
            >
              <span class="need-count">{{ stats.needsShipping }}</span>
              <span class="need-desc">送料が未入力</span>
              <span class="grow" />
              <span class="pill">開く <Icon name="arrow-right" :size="12" /></span>
            </button>
            <button
              class="need-row"
              :class="{ zero: stats.needsMatch === 0 }"
              @click="goto('sales')"
            >
              <span class="need-count">{{ stats.needsMatch }}</span>
              <span class="need-desc">仕入が未紐付け</span>
              <span class="grow" />
              <span class="pill">開く <Icon name="arrow-right" :size="12" /></span>
            </button>
            <button
              class="need-row"
              :class="{ zero: stats.needsPurchaseConfirm === 0 }"
              @click="goto('purchases')"
            >
              <span class="need-count">{{ stats.needsPurchaseConfirm }}</span>
              <span class="need-desc">価格未入力の仕入</span>
              <span class="grow" />
              <span class="pill">開く <Icon name="arrow-right" :size="12" /></span>
            </button>

            <p class="faint hint">
              送料と紐付けを入れると利益が確定します。1件10秒で終わります。
            </p>
          </div>

          <div class="panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="sales" :size="16" /></span>
              <h2 class="section-head-title">型番ランキング</h2>
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
        </div>
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
      <div class="home-grid">
        <div class="home-summary">
          <div class="stat-card brand"><Skeleton kind="stats" /></div>
          <div class="stat-card cream"><Skeleton kind="stats" /></div>
          <div class="stat-card cream"><Skeleton kind="stats" /></div>
        </div>
        <div class="home-detail">
          <div class="panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="alert" :size="16" /></span>
              <h2 class="section-head-title">要対応</h2>
            </div>
            <Skeleton kind="stats" />
          </div>
          <div class="panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="sales" :size="16" /></span>
              <h2 class="section-head-title">型番ランキング</h2>
            </div>
            <Skeleton :rows="4" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* --- レイアウト。左：主要指標カード、右：要対応の内訳とランキング --- */
.home-grid {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 20px;
  align-items: start;
}
.home-summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.home-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* --- 数字のカード。基本の見た目（面・角丸・余白）は style.css の .stat-card / .brand / .cream
       に任せる。ここでは値のタイポグラフィと修飾だけ定義する --- */
.stat-card.brand {
  color: var(--text);
}
.stat-card.cream {
  color: var(--text);
}
.stat-card-label {
  font-size: var(--fs-12);
  font-weight: 600;
}
.stat-card.cream .stat-card-label { color: var(--brand-ink); }
.stat-card-value {
  font-size: var(--fs-36);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.stat-card.brand .stat-card-value { font-size: var(--fs-44); }
.stat-card-sub {
  font-size: var(--fs-12);
  color: var(--text-dim);
}
.stat-card.brand .stat-card-sub { color: var(--text); opacity: .75; }
.stat-card-sub.warn { color: var(--warn); }
.unit { font-size: var(--fs-12); font-weight: 400; margin-left: 2px; }

.section-head select { margin-left: auto; }

/* --- 要対応の行 --- */
.need-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 4px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  height: auto;
}
.need-row:last-of-type { border-bottom: none; }
.need-row:hover { background: var(--surface-hi); }
.need-row.zero { opacity: .45; }
.need-count {
  font-size: var(--fs-28);
  font-weight: 700;
  color: var(--warn);
  min-width: 2ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.need-row.zero .need-count { color: var(--text-faint); }
.need-desc { font-size: var(--fs-14); }

.hint { margin: 12px 0 0; font-size: var(--fs-12); }

.intake {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  font-size: var(--fs-13);
}
.intake-msg { margin: 4px 0 0; font-size: var(--fs-13); }

.ranking-table { table-layout: fixed; }
.ranking-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1099px) {
  .home-grid { grid-template-columns: 1fr; }
}
</style>
