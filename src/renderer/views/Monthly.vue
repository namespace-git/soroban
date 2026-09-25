<script setup lang="ts">
// 月次タブ：上に月の帯（月を選ぶ）、下に選んだ月の計算書・販売ごとの表・締め／タグ別の集計／仕入先への支払い。
// 計算書とタグ別の集計は getMonthStatement、販売ごとの表・締め・片付けるもの・仕入先への支払いは
// MonthDetail.vue（getMonthDetail）から。どちらも main が計算した値をそのまま出すだけで、ここでは再計算しない。
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { MonthlySummary, MonthStatement, MonthDetail as MonthDetailInfo, ExpenseCategory, ExportKind } from '../../shared/types'
import { thisMonthLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import StatusChip from '../components/StatusChip.vue'
import MonthDetail from './MonthDetail.vue'
import { yen, percent, dateTime } from '../format'

const revision = inject<Ref<number>>('revision')!
// ホーム等から goto('monthly', { month }) で開かれたときに読む
const gotoPayload = inject<Ref<{ month?: string } | null>>('gotoPayload', ref(null))
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const goto = inject<(t: string, payload?: { stage?: 'listed' | 'pending' | 'done' | 'all'; month?: string }) => void>('goto')!
const changed = inject<() => void>('changed', () => {})

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  packaging: '梱包費',
  supplies: '消耗品',
  shipping: '送料',
  fee: '手数料',
  transfer_fee: '振込手数料',
  other: 'その他',
}

const thisMonth = thisMonthLocal()

// --- 月の帯（listMonthly の resale 行だけ。私物は帯に出さない） ---

const monthly = ref<MonthlySummary[]>([])
const loaded = ref(false)

const months = computed(() =>
  monthly.value.filter(m => m.kind === 'resale').sort((a, b) => b.month.localeCompare(a.month)),
)

async function load() {
  monthly.value = await window.soroban.listMonthly()
  loaded.value = true
  if (!selectedMonth.value) selectedMonth.value = months.value[0]?.month ?? null
}
onMounted(load)
watch(revision, () => { load(); loadStatement() })

function statusTone(m: MonthlySummary): 'ok' | 'warn' | 'neutral' {
  if (m.month === thisMonth) return 'neutral'
  return m.closed ? 'ok' : 'warn'
}
function statusLabel(m: MonthlySummary): string {
  if (m.month === thisMonth) return '進行中'
  return m.closed ? '締め済み' : '未締め'
}

// --- 選んだ月 ---

const selectedMonth = ref<string | null>(null)

watch(gotoPayload, (p) => {
  if (p?.month) {
    selectedMonth.value = p.month
    gotoPayload.value = null
  }
}, { immediate: true })

// --- 計算書（左の主役。タグ別の集計にも使う） ---

const statement = ref<MonthStatement | null>(null)
const statementLoaded = ref(false)

async function loadStatement() {
  if (!selectedMonth.value) { statement.value = null; return }
  statementLoaded.value = false
  statement.value = await window.soroban.getMonthStatement(selectedMonth.value)
  statementLoaded.value = true
}
watch(selectedMonth, loadStatement, { immediate: true })

const expenseSubLabel = computed(() =>
  (statement.value?.expenses ?? []).map(e => `${CATEGORY_LABEL[e.category]} ${yen(e.amount)}`).join(' ・ '),
)

function onAllocChanged() {
  loadStatement()
}

// --- この月をCSVで書き出す（クリック数を増やさないよう、選択肢はセレクトでなく小さなボタン3つ） ---

const EXPORT_KIND_LABEL: Record<ExportKind, string> = {
  sales: '販売', purchases: '仕入', expenses: '経費', inventory: '在庫',
}

async function exportMonthCsv(kind: ExportKind) {
  if (!selectedMonth.value) return
  const p = await window.soroban.exportCsv(kind, selectedMonth.value)
  const label = EXPORT_KIND_LABEL[kind]
  if (p) toast(`〈${selectedMonth.value}〉の〈${label}〉を書き出しました`, 'ok')
  else toast(`〈${selectedMonth.value}〉の〈${label}〉は書き出すものがありません`, 'warn')
}

// --- 販売ごとの表（MonthDetail.vue）：締め・片付けるもの・仕入先への支払いもここから受け取る ---

const monthDetail = ref<MonthDetailInfo | null>(null)
const monthDetailRef = ref<InstanceType<typeof MonthDetail> | null>(null)

function onDetailLoaded(d: MonthDetailInfo) {
  monthDetail.value = d
}

// --- 締め ---

const isEnded = computed(() => !!selectedMonth.value && selectedMonth.value < thisMonth)

async function doClose() {
  if (!selectedMonth.value) return
  const ok = await confirmDialog(`${selectedMonth.value} を締めますか？`, { message: '数字を記録します', okLabel: '締める' })
  if (!ok) return
  await window.soroban.closeMonth(selectedMonth.value)
  await load()
  await monthDetailRef.value?.load()
  changed()
  toast('締めました', 'ok')
}

async function doReopen() {
  if (!selectedMonth.value) return
  if (!await confirmDialog('締めを解除しますか？', { okLabel: '解除する' })) return
  await window.soroban.reopenMonth(selectedMonth.value)
  await load()
  await monthDetailRef.value?.load()
  changed()
  toast('締めを解除しました', 'ok')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">月次</h1>
    </div>

    <Skeleton v-if="!loaded" :rows="4" />

    <template v-else-if="months.length">
      <!-- 月の帯 -->
      <div class="month-band">
        <button
          v-for="m in months" :key="m.month"
          type="button"
          class="month-card"
          :class="{ active: m.month === selectedMonth }"
          @click="selectedMonth = m.month"
        >
          <span class="month-card-label">{{ m.month }}{{ m.month === thisMonth ? '（今月）' : '' }}</span>
          <strong class="month-card-value" :class="m.net_profit >= 0 ? 'profit' : 'loss'">{{ yen(m.net_profit) }}</strong>
          <span v-if="m.forecast?.count" class="faint">見込み粗利 {{ yen(m.forecast.gross_profit) }}</span>
          <StatusChip :tone="statusTone(m)" :label="statusLabel(m)" />
        </button>
      </div>

      <div v-if="selectedMonth" class="statement-layout">
        <div class="statement-main">
          <div v-if="statement?.forecast?.count || statement?.personal_forecast?.count" class="panel forecast-panel">
            <p class="panel-title">見込み（取引未完了）</p>
            <p class="faint forecast-note">実績＝取引完了分と、状態が取れていない手入力の販売。</p>
            <div class="stats">
              <div v-if="statement?.forecast?.count" class="stat">
                <span class="stat-label">件数</span>
                <span class="stat-value">{{ statement.forecast.count }}<span class="unit">件</span></span>
              </div>
              <div v-if="statement?.forecast?.count" class="stat">
                <span class="stat-label">見込み売上</span>
                <span class="stat-value">{{ yen(statement.forecast.revenue) }}</span>
              </div>
              <div v-if="statement?.forecast?.count" class="stat">
                <span class="stat-label">見込み粗利</span>
                <span class="stat-value">{{ yen(statement.forecast.gross_profit) }}</span>
              </div>
              <div v-if="statement?.personal_forecast?.count" class="stat">
                <span class="stat-label">私物の見込み（別計）</span>
                <span class="stat-value">{{ yen(statement.personal_forecast.gross_profit) }}</span>
                <span class="stat-sub">売上 {{ yen(statement.personal_forecast.revenue) }}</span>
              </div>
            </div>
          </div>

          <!-- 締める前に -->
          <div
            v-if="monthDetail && (monthDetail.pending.unconfirmed_shipping > 0 || monthDetail.pending.unmatched > 0)"
            class="panel pending-panel"
          >
            <Icon name="alert" :size="16" />
            <span v-if="monthDetail.pending.unconfirmed_shipping > 0">送料未入力 {{ monthDetail.pending.unconfirmed_shipping }} 件</span>
            <span v-if="monthDetail.pending.unmatched > 0">未紐付け {{ monthDetail.pending.unmatched }} 件</span>
            <span class="grow" />
            <button class="sm link-btn" @click="goto('sales', { stage: 'pending', month: selectedMonth ?? undefined })">
              売上タブで片付ける
            </button>
          </div>

          <!-- 計算書 -->
          <div class="panel statement-card">
            <Skeleton v-if="!statementLoaded" class="statement-skeleton" :rows="8" />
            <template v-else-if="statement">
              <div class="statement-head">
                <h2>{{ statement.month }} の計算書</h2>
                <StatusChip tone="brand" :label="`販売用 ${statement.sales_count} 件`" />
                <StatusChip tone="neutral" label="私物は含まない" />
                <span class="grow" />
                <span class="csv-export">
                  <span class="faint csv-export-label">この月をCSVで：</span>
                  <button class="sm ghost" @click="exportMonthCsv('sales')">{{ EXPORT_KIND_LABEL.sales }}</button>
                  <button class="sm ghost" @click="exportMonthCsv('purchases')">{{ EXPORT_KIND_LABEL.purchases }}</button>
                  <button class="sm ghost" @click="exportMonthCsv('expenses')">{{ EXPORT_KIND_LABEL.expenses }}</button>
                </span>
              </div>
              <div class="statement-body">
                <table class="statement-table">
                  <tbody>
                    <tr>
                      <td class="k">売上（販売価格の合計）</td>
                      <td class="num">{{ yen(statement.revenue) }}</td>
                      <td class="hint"></td>
                    </tr>
                    <tr class="sub">
                      <td class="k">− 販売手数料</td>
                      <td class="num minus">−{{ yen(statement.fee) }}</td>
                      <td class="hint"></td>
                    </tr>
                    <tr class="sub">
                      <td class="k">− 発送送料</td>
                      <td class="num minus">−{{ yen(statement.shipping) }}</td>
                      <td class="hint">実額 {{ statement.shipping_actual_count }} ・ 選択 {{ statement.sales_count - statement.shipping_actual_count }}</td>
                    </tr>
                    <tr class="sub">
                      <td class="k">− 梱包材費</td>
                      <td class="num minus">−{{ yen(statement.packaging) }}</td>
                      <td class="hint"></td>
                    </tr>
                    <tr class="sub">
                      <td class="k">− 原価（紐付けた在庫の按分後原価）</td>
                      <td class="num minus">−{{ yen(statement.cost) }}</td>
                      <td class="hint">{{ statement.cost_items }} 点</td>
                    </tr>
                    <tr class="sum">
                      <td>粗利</td>
                      <td class="num"><strong :class="statement.gross_profit >= 0 ? 'profit' : 'loss'">{{ yen(statement.gross_profit) }}</strong></td>
                      <td class="hint">{{ statement.gross_rate != null ? `粗利率 ${percent(statement.gross_rate)}` : '—' }}</td>
                    </tr>
                    <tr class="sub">
                      <td class="k">
                        − 経費（この月に計上）
                        <span v-if="expenseSubLabel" class="why">{{ expenseSubLabel }}</span>
                      </td>
                      <td class="num minus">−{{ yen(statement.expense_total) }}</td>
                      <td class="hint"><button class="sm ghost" @click="goto('expenses')">経費タブ →</button></td>
                    </tr>
                    <tr class="sum">
                      <td>純利益</td>
                      <td class="num"><strong :class="statement.net_profit >= 0 ? 'profit' : 'loss'">{{ yen(statement.net_profit) }}</strong></td>
                      <td class="hint">{{ statement.net_rate != null ? `純利益率 ${percent(statement.net_rate)}` : '—' }}</td>
                    </tr>
                  </tbody>
                </table>

                <h3 class="statement-sub-title">参考</h3>
                <table class="statement-table statement-table-ref">
                  <tbody>
                    <tr>
                      <td class="k">売上金の反映待ち（この月に売れて未完了）</td>
                      <td class="num">{{ yen(statement.awaiting_payout) }}</td>
                      <td class="hint"></td>
                    </tr>
                    <tr>
                      <td class="k">私物の販売</td>
                      <td class="num">{{ yen(statement.personal_revenue) }}</td>
                      <td class="hint">利益の計算に入れない</td>
                    </tr>
                    <tr>
                      <td class="k">この月に注文した仕入（支払）</td>
                      <td class="num">{{ yen(statement.purchase_paid) }}</td>
                      <td class="hint">原価とは別。在庫として残る</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>

          <!-- 販売ごとの表（最初から開いた状態） -->
          <MonthDetail
            ref="monthDetailRef"
            :month="selectedMonth"
            @loaded="onDetailLoaded"
            @alloc-changed="onAllocChanged"
          />
        </div>

        <aside class="statement-side">
          <div class="panel close-card">
            <template v-if="monthDetail?.close">
              <StatusChip tone="ok" :label="'締め済み ' + dateTime(monthDetail.close.closed_at)" />
              <p v-if="monthDetail.changed_since_close" class="changed-note">
                締めた後に数字が変わっています（締め時：純利益 {{ yen(monthDetail.close.net_profit) }} → 今：{{ yen(monthDetail.totals.net_profit) }}）
              </p>
              <button class="sm ghost close-card-btn" @click="doReopen">締めを解除</button>
            </template>
            <template v-else-if="isEnded">
              <div class="close-card-title">この月を締める</div>
              <p class="faint close-card-sub">終わった月の数字を記録します。編集はロックしません（後で変われば差分が出ます）</p>
              <button class="primary close-card-btn" @click="doClose">{{ selectedMonth }} を締める</button>
            </template>
            <template v-else>
              <div class="close-card-title">この月を締める</div>
              <p class="faint">月が終わってから締められます</p>
            </template>
          </div>

          <div class="panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="sales" :size="16" /></span>
              <h2 class="section-head-title">タグ別の集計</h2>
            </div>
            <template v-if="statement && statement.by_tag.length">
              <table class="compact">
                <thead>
                  <tr>
                    <th>タグ</th>
                    <th class="num">件数</th>
                    <th class="num">粗利</th>
                    <th class="num" title="按分後利益＝粗利−按分経費">按分後利益</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in statement.by_tag" :key="t.tag.id">
                    <td><StatusChip tone="info" :label="t.tag.name" /></td>
                    <td class="num">{{ t.count }}</td>
                    <td class="num">{{ yen(t.gross_profit) }}</td>
                    <td class="num" :title="'按分経費 ' + yen(t.allocated_expense)">
                      <strong :class="t.net_profit >= 0 ? 'profit' : 'loss'">{{ yen(t.net_profit) }}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="statement.multi_tag_count > 0" class="multi-tag-note">
                <Icon name="alert" :size="14" />
                {{ statement.multi_tag_count }} 件に複数のタグが付いています
              </p>
            </template>
            <EmptyState v-else-if="statement" title="この月にタグの付いた販売はありません" hint="売上タブでタグを付けると、ここに集計されます" />
          </div>

          <div class="panel table-panel">
            <div class="section-head">
              <span class="section-head-icon"><Icon name="purchase" :size="16" /></span>
              <h2 class="section-head-title">仕入先への支払い</h2>
            </div>
            <table v-if="monthDetail && monthDetail.purchases_by_account.length" class="compact">
              <thead>
                <tr>
                  <th>仕入先</th>
                  <th class="num">件数</th>
                  <th class="num">支払合計</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in monthDetail.purchases_by_account" :key="p.shop_account_id">
                  <td>{{ p.shop_account_name }}</td>
                  <td class="num">{{ p.count }}</td>
                  <td class="num">{{ yen(p.total_cost) }}</td>
                </tr>
              </tbody>
            </table>
            <EmptyState v-else title="この月に注文した仕入はありません" hint="仕入タブで登録すると、ここに集計されます" />
            <p class="faint purchases-note">確定した仕入の総原価（商品計＋送料＋その他−割引）</p>
          </div>
        </aside>
      </div>
    </template>

    <EmptyState
      v-else
      title="月次の集計はまだありません"
      hint="販売を登録すると月ごとに集計されます"
    />
  </div>
</template>

<style scoped>
/* --- 月の帯 --- */
.month-band {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 6px;
  margin-bottom: 16px;
}
.month-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  flex-shrink: 0;
  min-width: 132px;
  height: auto;
  padding: 10px 14px;
  background: var(--surface);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-1);
  text-align: left;
  cursor: pointer;
}
.month-card.active { border-color: var(--primary); }
.month-card-label { font-size: var(--fs-12); color: var(--text-dim); }
.month-card-value {
  font-size: var(--fs-16);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* --- レイアウト：左＝計算書と販売ごとの表、右＝締め・タグ別・仕入先 --- */
.statement-layout {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 16px;
  align-items: start;
}
.statement-main { min-width: 0; }
.statement-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.statement-side .panel { margin-top: 0; }

@media (max-width: 1099px) {
  .statement-layout { grid-template-columns: 1fr; }
}

/* --- 見込み（取引未完了） --- */
.forecast-panel { margin-bottom: 16px; }
.forecast-panel .panel-title { margin-bottom: 4px; }
.forecast-note { margin: 0 0 10px; }

/* --- 締める前に --- */
.pending-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  font-size: var(--fs-13);
}

/* --- 計算書：黄色い帯の見出し --- */
.statement-card { padding: 0; overflow: hidden; }
.statement-skeleton { padding: 20px 24px; }
.statement-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 14px 24px;
  background: var(--brand);
}
.statement-head h2 {
  margin: 0;
  font-size: var(--fs-16);
  font-weight: 700;
  color: var(--text);
}
.csv-export {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.csv-export-label { white-space: nowrap; font-size: var(--fs-12); }
.statement-body { padding: 8px 24px 20px; }

.statement-table { width: 100%; border-collapse: collapse; font-size: var(--fs-14); }
.statement-table td {
  padding: 7px 6px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}
.statement-table td.k { color: var(--text-dim); }
.statement-table td.k .why {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-12);
  color: var(--text-faint);
}
.statement-table td.num { text-align: right; font-variant-numeric: tabular-nums; width: 130px; white-space: nowrap; }
.statement-table td.num.minus { color: var(--text-dim); }
.statement-table td.hint {
  width: 160px;
  text-align: right;
  font-size: var(--fs-12);
  color: var(--text-faint);
  white-space: nowrap;
}
.statement-table td.hint button { height: 26px; padding: 0 10px; font-size: var(--fs-12); }
.statement-table tr.sum td {
  font-weight: 700;
  border-top: 2px solid var(--line);
  border-bottom: 2px solid var(--line);
}
.statement-sub-title {
  margin: 16px 0 6px;
  font-size: var(--fs-13);
  font-weight: 600;
  color: var(--text-dim);
}
.statement-table-ref { font-size: var(--fs-13); }
.statement-table-ref td { color: var(--text-dim); }

/* --- 右：締める --- */
.close-card { background: var(--brand-soft); box-shadow: none; }
.close-card-title { font-size: var(--fs-14); font-weight: 700; color: var(--text); }
.close-card-sub { margin: 4px 0 0; color: var(--brand-ink); }
.close-card-btn { margin-top: 10px; }
.changed-note {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  font-size: var(--fs-12);
}

/* --- 右：タグ別の集計 --- */
.multi-tag-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  padding: 8px 12px;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  font-size: var(--fs-13);
}

/* --- 右：仕入先への支払い --- */
.table-panel { padding: 0; overflow: hidden; }
.table-panel .section-head { padding: 16px 20px 0; margin-bottom: 12px; }
.purchases-note { margin: 12px 20px 16px; }
</style>
