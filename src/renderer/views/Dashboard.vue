<script setup lang="ts">
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { DashboardStats, VariantSummary, SaleStatus } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import Skeleton from '../components/Skeleton.vue'

const stats = ref<DashboardStats | null>(null)
const revision = inject<Ref<number>>('revision')!
const goto = inject<(t: string, payload?: {
  modelCode?: string
  stage?: 'listed' | 'pending' | 'done' | 'all'
  onlyUnallocated?: boolean
  status?: SaleStatus
  inventoryStatus?: 'unlisted' | 'listed' | 'sold' | 'other' | 'all'
  agingMin?: number
}) => void>('goto')!

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

// 在庫の長期滞留とみなす日数（在庫タブ・設定タブと同じ設定値）
const agingWarnDays = ref(90)

async function load() {
  const [dashboard, settings] = await Promise.all([
    window.soroban.getDashboard(),
    window.soroban.getSettings(),
  ])
  stats.value = dashboard
  agingWarnDays.value = Number(settings.aging_warn_days ?? 90)
}
onMounted(load)
watch(revision, load)

// 取り込み元ごとの直近1件のうち、ok以外（=要対応の先頭に出す対象）
const failedRuns = computed(() => (stats.value?.recentRuns ?? []).filter(r => r.status !== 'ok'))

function runSourceLabel(r: { source: string; shop_account_name: string | null }): string {
  return r.source === 'mercari' ? 'メルカリの取り込み' : `メロジョイ（${r.shop_account_name ?? '不明'}）の取り込み`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

// recentRuns はメルカリ・仕入先アカウントの実行をまとめて返すため、取り込み動作自体は1本
// （collect() が内部でメルカリ→有効な仕入先の順に直列で走る。口座単位の再実行はできない）
// App.vue のヘッダの「取り込む」があればそれに任せる（通知・件数更新まで面倒を見てくれる）。
// 無ければ window.soroban.collect() を直接呼ぶ
const injectedCollect = inject<(() => Promise<void>) | undefined>('collect', undefined)
const collecting = ref(false)
async function retryCollect() {
  collecting.value = true
  try {
    if (injectedCollect) {
      await injectedCollect()
    } else {
      await window.soroban.collect()
      revision.value++
    }
  } finally {
    collecting.value = false
  }
}

// ログインが必要なときは、まずログインのウィンドウを開くだけにする（取り込みは人が「取り込む」を押す）
async function openLoginForRun() {
  await window.soroban.openLogin()
}

// 要対応の合計（発送待ち＋送料未入力＋未紐付け＋価格未入力の仕入＋未引き当ての出品）
const needsTotal = computed(() => {
  if (!stats.value) return 0
  return stats.value.needsShipment + stats.value.needsShipping + stats.value.needsMatch
    + stats.value.needsPurchaseConfirm + stats.value.needsListingAllocation
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
              ・ 純利益 {{ yen(stats.thisMonth?.net_profit ?? 0) }}
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
            <button
              v-if="stats.agingCount > 0"
              type="button"
              class="stat-card-sub warn aging-btn"
              @click="goto('inventory', { inventoryStatus: 'all', agingMin: agingWarnDays })"
            >
              長期滞留 {{ stats.agingCount }} 点
            </button>
          </div>
        </div>

        <!-- 要対応の内訳と型番ランキング -->
        <div class="home-detail">
          <div class="panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="alert" :size="16" /></span>
              <h2 class="section-head-title">要対応</h2>
              <StatusChip v-if="failedRuns.length" tone="warn" label="取り込みに問題" />
            </div>

            <div
              v-for="r in failedRuns" :key="r.id"
              class="need-row run-need-row"
            >
              <StatusChip tone="warn" :label="runLabel[r.status] ?? r.status" />
              <span class="run-need-text">
                <span class="need-desc">{{ runSourceLabel(r) }}</span>
                <span v-if="r.message" class="faint">{{ truncate(r.message, 80) }}</span>
              </span>
              <span class="grow" />
              <button
                v-if="r.status === 'auth_required'"
                class="sm link-btn"
                title="ログインのウィンドウが開きます。ログインしたら閉じて「取り込む」を押してください"
                @click="openLoginForRun"
              >ログインする</button>
              <button v-else class="sm link-btn" :disabled="collecting" @click="retryCollect">
                もう一度取り込む
              </button>
            </div>

            <button
              class="need-row"
              :class="{ zero: stats.needsShipment === 0 }"
              @click="goto('sales', { stage: 'all', status: 'waiting_shipment' })"
            >
              <span class="need-count">{{ stats.needsShipment }}</span>
              <span class="need-desc">発送してください</span>
              <span class="grow" />
              <span class="pill">開く <Icon name="arrow-right" :size="12" /></span>
            </button>
            <button
              class="need-row"
              :class="{ zero: stats.needsShipping === 0 }"
              @click="goto('sales', { stage: 'pending' })"
            >
              <span class="need-count">{{ stats.needsShipping }}</span>
              <span class="need-desc">送料が未入力</span>
              <span class="grow" />
              <span class="pill">開く <Icon name="arrow-right" :size="12" /></span>
            </button>
            <button
              class="need-row"
              :class="{ zero: stats.needsMatch === 0 }"
              @click="goto('sales', { stage: 'pending' })"
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
            <button
              class="need-row"
              :class="{ zero: stats.needsListingAllocation === 0 }"
              @click="goto('sales', { stage: 'listed', onlyUnallocated: true })"
            >
              <span class="need-count">{{ stats.needsListingAllocation }}</span>
              <span class="need-desc">未引き当ての出品</span>
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
                <tr
                  v-for="v in variants" :key="v.model_code"
                  class="ranking-row"
                  @click="goto('products', { modelCode: v.model_code })"
                >
                  <td><StatusChip tone="neutral" :label="v.model_code" /></td>
                  <td class="ranking-name" :title="v.name">{{ v.name }}</td>
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
      <template v-if="stats.recentRuns.length">
        <template v-for="r in stats.recentRuns" :key="r.id">
          <div class="intake">
            <StatusChip
              :tone="r.status === 'ok' ? 'ok' : 'warn'"
              :label="runLabel[r.status] ?? r.status"
            />
            <span class="dim">{{ runSourceLabel(r) }}</span>
            <span class="dim">{{ new Date(r.started_at).toLocaleString('ja-JP') }}</span>
            <span class="faint">取得 {{ r.fetched }}／追加 {{ r.inserted }}</span>
          </div>
          <p v-if="r.message" class="faint intake-msg">{{ r.message }}</p>
        </template>
      </template>
      <template v-else>
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
      </template>
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
.aging-btn {
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  text-align: left;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
}
.aging-btn:hover { text-decoration-color: currentColor; }
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

/* --- 取り込み失敗の行（要対応の先頭）。カウント数字の代わりにStatusChipを置く --- */
.run-need-row { cursor: default; }
.run-need-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.run-need-text .faint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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
.ranking-row { cursor: pointer; }
/* 型番・数値列は狭く固定し、商品名の列に幅を残す */
.ranking-table th:nth-child(1), .ranking-table td:nth-child(1) { width: 80px; }
.ranking-table th:nth-child(3), .ranking-table td:nth-child(3),
.ranking-table th:nth-child(4), .ranking-table td:nth-child(4) { width: 52px; }
.ranking-table th:nth-child(5), .ranking-table td:nth-child(5),
.ranking-table th:nth-child(6), .ranking-table td:nth-child(6) { width: 84px; }
.ranking-table th:nth-child(7), .ranking-table td:nth-child(7) { width: 92px; }
/* 商品名は1行省略をやめ、2行まで折り返して省略する */
.ranking-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
  word-break: break-word;
  line-height: 1.35;
}

@media (max-width: 1099px) {
  .home-grid { grid-template-columns: 1fr; }
}
</style>
