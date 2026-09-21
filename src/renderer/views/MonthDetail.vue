<script setup lang="ts">
// 月次タブ：1か月の明細。販売・経費・按分・仕入先への支払い・締めをまとめて見る。
// 金額はすべて main（getMonthDetail）から来た値をそのまま出すだけで、ここでは再計算しない。
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { MonthDetail, MonthSaleRow, MonthTotals, AllocMethod, Expense, ExpenseCategory, Tag } from '../../shared/types'
import { thisMonthLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'

const props = defineProps<{ month: string }>()
const emit = defineEmits<{ back: [] }>()

const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const goto = inject<(t: string, payload?: { stage?: 'listed' | 'pending' | 'done' | 'all'; month?: string }) => void>('goto')!
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  packaging: '梱包費',
  supplies: '消耗品',
  shipping: '送料',
  fee: '手数料',
  transfer_fee: '振込手数料',
  other: 'その他',
}

const detail = ref<MonthDetail | null>(null)
const loaded = ref(false)
const tagFilter = ref('')
const allTags = ref<Tag[]>([])
const showPersonal = ref(false)

async function load() {
  loaded.value = false
  detail.value = await window.soroban.getMonthDetail(props.month, { tagId: tagFilter.value || null })
  loaded.value = true
}
async function loadTags() {
  allTags.value = await window.soroban.listTags()
}

onMounted(async () => {
  await loadTags()
  await load()
})
watch(() => props.month, async () => {
  tagFilter.value = ''
  showPersonal.value = false
  await load()
})
watch(tagFilter, load)
watch(revision, async () => {
  await loadTags()
  await load()
})

// --- 締め ---

const isEnded = computed(() => props.month < thisMonthLocal())

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function doClose() {
  const ok = await confirmDialog(`${props.month} を締めますか？`, { message: '数字を記録します', okLabel: '締める' })
  if (!ok) return
  await window.soroban.closeMonth(props.month)
  await load()
  changed()
  toast('締めました', 'ok')
}

async function doReopen() {
  if (!await confirmDialog('締めを解除しますか？', { okLabel: '解除する' })) return
  await window.soroban.reopenMonth(props.month)
  await load()
  changed()
  toast('締めを解除しました', 'ok')
}

// --- 按分方法 ---

async function setAlloc(method: string) {
  await window.soroban.setMonthAllocMethod(props.month, method as AllocMethod)
  await load()
  changed()
}

// --- タグの絞り込み候補：出どころで分ける（Sales.vue と同じ考え方） ---

function tagOptionsOf(pick: (s: MonthSaleRow) => Tag[]): Array<{ id: string; name: string }> {
  const map = new Map<string, string>()
  for (const s of detail.value?.sales ?? []) for (const t of pick(s)) map.set(t.id, t.name)
  if (tagFilter.value && !map.has(tagFilter.value)) {
    const t = allTags.value.find(x => x.id === tagFilter.value)
    if (t) map.set(t.id, t.name)
  }
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}
const directTagOptions = computed(() => tagOptionsOf(s => s.tags))
const purchaseTagOptions = computed(() => tagOptionsOf(s => s.inherited_tags.filter(t => t.from === 'purchase')))
const productTagOptions = computed(() => tagOptionsOf(s => s.inherited_tags.filter(t => t.from === 'product')))
const inventoryTagOptions = computed(() => tagOptionsOf(s => s.inherited_tags.filter(t => t.from === 'inventory')))

// --- 販売の表：タグで絞っているときは該当行だけを表示する（金額はどれも main の値のまま） ---

function saleHasTag(s: MonthSaleRow, tagId: string): boolean {
  return s.tags.some(t => t.id === tagId) || s.inherited_tags.some(t => t.id === tagId)
}
const filteredSales = computed(() => {
  const sales = detail.value?.sales ?? []
  return tagFilter.value ? sales.filter(s => saleHasTag(s, tagFilter.value)) : sales
})

// タグで絞っているとき、絞った販売のうち別のタグも付いているものの件数
// （同じ販売が別のタグの集計にも数えられてしまう。払う相手のタグは1販売に1つにする運用を促す注意）
const multiTagCount = computed(() => {
  if (!tagFilter.value) return 0
  return filteredSales.value.filter(s => {
    const otherTagIds = [...s.tags.map(t => t.id), ...s.inherited_tags.map(t => t.id)]
      .filter(id => id !== tagFilter.value)
    return otherTagIds.length > 0
  }).length
})

// 表の合計行：タグで絞っているときは filtered、そうでなければ totals（どちらも main が計算済み）
const footerTotals = computed<MonthTotals | null>(() => {
  if (!detail.value) return null
  return tagFilter.value && detail.value.filtered ? detail.value.filtered : detail.value.totals
})

// --- 経費の表：内容は明細名をつなげる。無ければメモ ---

function expenseContent(e: Expense): string {
  if (e.lines.length) return e.lines.map(l => l.name).join('・')
  return e.note ?? ''
}
</script>

<template>
  <div class="page">
    <button class="ghost back-btn" @click="emit('back')">
      <Icon name="arrow-right" :size="14" class="flip" /> 月次へ
    </button>

    <div class="page-head">
      <h1 class="page-title">{{ month }} の明細</h1>
      <span class="grow" />
      <template v-if="detail">
        <template v-if="detail.close">
          <StatusChip tone="ok" :label="`締め済み ${formatDateTime(detail.close.closed_at)}`" />
          <button class="sm ghost" @click="doReopen">締めを解除</button>
        </template>
        <template v-else-if="isEnded">
          <button class="primary" @click="doClose">この月を締める</button>
        </template>
        <span v-else class="faint">月が終わってから締められます</span>
      </template>
    </div>

    <p v-if="detail?.changed_since_close" class="changed-note">
      締めた後に数字が変わっています（締め時：純利益 {{ yen(detail.close!.net_profit) }} → 今：{{ yen(detail.totals.net_profit) }}）
    </p>

    <Skeleton v-if="!loaded" :rows="6" />

    <template v-else-if="detail">
      <!-- 片付けるもの -->
      <div v-if="detail.pending.unconfirmed_shipping > 0 || detail.pending.unmatched > 0" class="panel pending-panel">
        <Icon name="alert" :size="16" />
        <span v-if="detail.pending.unconfirmed_shipping > 0">送料未入力 {{ detail.pending.unconfirmed_shipping }} 件</span>
        <span v-if="detail.pending.unmatched > 0">未紐付け {{ detail.pending.unmatched }} 件</span>
        <span class="grow" />
        <button class="sm link-btn" @click="goto('sales', { stage: 'pending', month })">売上タブで片付ける</button>
      </div>

      <!-- 合計カード -->
      <div class="stat-row">
        <div class="stat-card brand">
          <span class="stat-card-label">売上</span>
          <span class="stat-card-value">{{ yen(detail.totals.revenue) }}</span>
          <span class="stat-card-sub">件数 {{ detail.totals.sales_count }} 件</span>
        </div>
        <div class="stat-card cream">
          <span class="stat-card-label">粗利</span>
          <span class="stat-card-value">
            <strong :class="detail.totals.gross_profit >= 0 ? 'profit' : 'loss'">{{ yen(detail.totals.gross_profit) }}</strong>
          </span>
          <span class="stat-card-sub">
            手数料 {{ yen(detail.totals.total_fee) }} ・ 送料 {{ yen(detail.totals.total_shipping) }} ・ 原価 {{ yen(detail.totals.total_cost) }}
          </span>
        </div>
        <div class="stat-card cream">
          <span class="stat-card-label">経費</span>
          <span class="stat-card-value">{{ yen(detail.totals.expense_total) }}</span>
        </div>
        <div class="stat-card cream">
          <span class="stat-card-label">純利益</span>
          <span class="stat-card-value">
            <strong :class="detail.totals.net_profit >= 0 ? 'profit' : 'loss'">{{ yen(detail.totals.net_profit) }}</strong>
          </span>
        </div>
      </div>

      <!-- 絞り込み -->
      <div class="toolbar">
        <select v-model="tagFilter">
          <option value="">すべてのタグ</option>
          <optgroup v-if="directTagOptions.length" label="直接">
            <option v-for="t in directTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
          </optgroup>
          <optgroup v-if="purchaseTagOptions.length" label="仕入から">
            <option v-for="t in purchaseTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
          </optgroup>
          <optgroup v-if="productTagOptions.length" label="商品から">
            <option v-for="t in productTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
          </optgroup>
          <optgroup v-if="inventoryTagOptions.length" label="在庫から">
            <option v-for="t in inventoryTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
          </optgroup>
        </select>
        <select :value="detail.alloc_method" @change="setAlloc(($event.target as HTMLSelectElement).value)">
          <option value="by_amount">按分：金額（既定）</option>
          <option value="by_quantity">按分：数量</option>
        </select>
        <span class="grow" />
      </div>

      <div v-if="tagFilter && detail.filtered" class="panel tag-filtered-panel">
        <StatusChip tone="info" :label="detail.filtered.tag.name" />
        <span class="num">粗利 {{ yen(detail.filtered.gross_profit) }}</span>
        <span class="num dim">按分した経費 {{ yen(detail.filtered.expense_total) }}</span>
        <strong class="num" :class="detail.filtered.net_profit >= 0 ? 'profit' : 'loss'">
          按分後の利益 {{ yen(detail.filtered.net_profit) }}
        </strong>
        <span class="faint">（{{ detail.filtered.sales_count }} 件）</span>
      </div>

      <p v-if="multiTagCount > 0" class="multi-tag-note">
        <Icon name="alert" :size="14" />
        {{ multiTagCount }} 件に別のタグも付いています。別のタグで絞っても同じ販売が数えられます（払う相手のタグは1販売に1つに）
      </p>
      <p class="faint alloc-hint">
        経費は販売用の販売に、金額（販売価格の比）か数量（点数の比）で配賦。端数は最後の行
      </p>

      <!-- 販売の表 -->
      <div class="panel table-panel">
        <table v-if="filteredSales.length">
          <thead>
            <tr>
              <th>販売日</th>
              <th>商品</th>
              <th class="num">価格</th>
              <th class="num">手数料</th>
              <th class="num">送料</th>
              <th class="num">梱包</th>
              <th class="num">原価</th>
              <th class="num">粗利</th>
              <th class="num">按分経費</th>
              <th class="num">按分後利益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in filteredSales" :key="s.id">
              <td class="dim nowrap">{{ s.sold_at }}</td>
              <td class="title-cell">
                <div class="item-name">{{ s.title }}</div>
                <div class="chip-row">
                  <CodeChip v-for="mc in s.model_codes" :key="mc" kind="model" :code="mc" />
                  <StatusChip v-for="t in s.tags" :key="t.id" tone="info" :label="t.name" />
                  <StatusChip v-for="t in s.inherited_tags" :key="'i' + t.id" tone="neutral" :label="t.name" />
                </div>
              </td>
              <td class="num">{{ yen(s.price) }}</td>
              <td class="num dim">{{ yen(s.fee) }}</td>
              <td class="num dim">{{ yen(s.shipping_fee) }}</td>
              <td class="num dim">{{ yen(s.packaging_cost) }}</td>
              <td class="num dim">{{ yen(s.cost) }}</td>
              <td class="num"><strong :class="s.gross_profit >= 0 ? 'profit' : 'loss'">{{ yen(s.gross_profit) }}</strong></td>
              <td class="num dim">{{ yen(s.allocated_expense) }}</td>
              <td class="num"><strong :class="s.net_profit >= 0 ? 'profit' : 'loss'">{{ yen(s.net_profit) }}</strong></td>
            </tr>
          </tbody>
          <tfoot v-if="footerTotals">
            <tr class="total-row" :class="{ loss: footerTotals.net_profit < 0 }">
              <td colspan="2">合計</td>
              <td class="num">{{ yen(footerTotals.revenue) }}</td>
              <td class="num">{{ yen(footerTotals.total_fee) }}</td>
              <td class="num">{{ yen(footerTotals.total_shipping) }}</td>
              <td class="num">{{ yen(footerTotals.total_packaging) }}</td>
              <td class="num">{{ yen(footerTotals.total_cost) }}</td>
              <td class="num">{{ yen(footerTotals.gross_profit) }}</td>
              <td class="num">{{ yen(footerTotals.expense_total) }}</td>
              <td class="num">{{ yen(footerTotals.net_profit) }}</td>
            </tr>
          </tfoot>
        </table>
        <EmptyState v-else title="この月の販売はありません" />
      </div>

      <!-- 経費の表 -->
      <div class="panel table-panel">
        <div class="section-head">
          <span class="section-head-icon"><Icon name="monthly" :size="16" /></span>
          <h2 class="section-head-title">経費</h2>
          <div class="chip-row category-chips">
            <StatusChip
              v-for="c in detail.expense_by_category" :key="c.category"
              tone="neutral" :label="`${CATEGORY_LABEL[c.category]} ${yen(c.amount)}`"
            />
          </div>
          <span class="grow" />
          <button class="sm ghost" @click="goto('expenses')">経費タブで登録</button>
        </div>
        <table v-if="detail.expenses.length" class="compact">
          <thead>
            <tr>
              <th>購入日</th>
              <th>購入店</th>
              <th>内容</th>
              <th>項目</th>
              <th class="num">金額</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in detail.expenses" :key="e.id">
              <td class="dim nowrap">{{ e.occurred_at }}</td>
              <td>{{ e.shop ?? '—' }}</td>
              <td class="dim">{{ expenseContent(e) }}</td>
              <td>{{ CATEGORY_LABEL[e.category] }}</td>
              <td class="num">{{ yen(e.amount) }}</td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="この月の経費はまだありません" />
        <p class="faint expenses-note">経費はこの画面では登録できません。経費タブで登録してください</p>
      </div>

      <!-- 仕入先への支払い -->
      <div class="panel table-panel">
        <div class="section-head">
          <span class="section-head-icon"><Icon name="purchase" :size="16" /></span>
          <h2 class="section-head-title">仕入先への支払い</h2>
        </div>
        <table v-if="detail.purchases_by_account.length" class="compact">
          <thead>
            <tr>
              <th>仕入先</th>
              <th class="num">件数</th>
              <th class="num">支払合計</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in detail.purchases_by_account" :key="p.shop_account_id">
              <td>{{ p.shop_account_name }}</td>
              <td class="num">{{ p.count }}</td>
              <td class="num">{{ yen(p.total_cost) }}</td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="この月に注文した仕入はありません" />
        <p class="faint">その月に注文した仕入（確定分）</p>
      </div>

      <!-- 私物（参考） -->
      <div class="panel">
        <button class="sm ghost" @click="showPersonal = !showPersonal">
          私物 {{ detail.personal_sales.length }} 件を{{ showPersonal ? '隠す' : '表示' }}
        </button>
        <template v-if="showPersonal">
          <p class="faint personal-note">私物の販売は按分の対象外です（参考表示）</p>
          <table v-if="detail.personal_sales.length" class="compact">
            <thead>
              <tr>
                <th>販売日</th>
                <th>商品</th>
                <th class="num">価格</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in detail.personal_sales" :key="s.id">
                <td class="dim nowrap">{{ s.sold_at }}</td>
                <td>{{ s.title }}</td>
                <td class="num">{{ yen(s.price) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.back-btn { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.back-btn .flip { transform: scaleX(-1); }

.changed-note {
  margin: -8px 0 16px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  font-size: var(--fs-13);
}

.pending-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px 16px;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  font-size: var(--fs-13);
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.toolbar { margin-bottom: 12px; }

.tag-filtered-panel {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 10px 20px;
  margin-bottom: 8px;
  font-size: var(--fs-13);
}

.alloc-hint { margin: 0 4px 16px; }

.multi-tag-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 4px 16px;
  padding: 8px 12px;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  font-size: var(--fs-13);
}

.table-panel { padding: 0; overflow-x: auto; margin-bottom: 16px; }
.table-panel .section-head { padding: 16px 20px 0; margin-bottom: 12px; }
.table-panel table { min-width: 960px; }

.category-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; }

.title-cell { max-width: 320px; }
.item-name { font-size: var(--fs-14); font-weight: 500; }

.expenses-note { margin: 12px 20px 16px; }
.personal-note { margin: 10px 0 0; }

@media (max-width: 1099px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
}
</style>
