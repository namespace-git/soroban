<script setup lang="ts">
// ホーム＝受信箱。「今やること」を1本のリストに束ね、上から順に片付ければ終わる形にする。
// 数字・文言（title/detail/profit_hint）は main（getInbox）が組み立て済みのものをそのまま出す。
// レンダラー側では利益を再計算しない。
import { ref, reactive, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { Inbox, InboxItem, InboxKind, ShippingMethod, DashboardStats } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import ProfitStripBar from '../components/ProfitStripBar.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import { yen } from '../format'

// グループ見出しの表示名。InboxGroup.label は main が返すが、文言はここで固定する
// （main 側のラベル変更に画面が引きずられないように）
const groupLabels: Record<InboxKind, string> = {
  ship: '発送する',
  shipping: '送料を入れる',
  link: '在庫を紐付ける',
  confirm: '仕入の価格を入れる',
  collect: '取り込みの問題',
  reminder: '忘れていませんか',
}

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const goto = inject<(t: string, payload?: {
  modelCode?: string
  stage?: 'listed' | 'pending' | 'done' | 'all'
  onlyUnallocated?: boolean
  focusId?: string
  month?: string
  inventoryStatus?: 'unlisted' | 'listed' | 'sold' | 'other' | 'all'
  agingMin?: number
}) => void>('goto')!

// App.vue のヘッダの「取り込む」があればそれに任せる（通知・件数更新まで面倒を見てくれる）。
// 無ければ window.soroban.collect() を直接呼ぶ（Dashboard 単体表示など）
const injectedCollect = inject<(() => Promise<void>) | undefined>('collect', undefined)

const inbox = ref<Inbox | null>(null)
// 「見直すもの」の在庫カード（点数・原価）は getInbox に無いので getDashboard から補う
const dashboard = ref<DashboardStats | null>(null)
const methods = ref<ShippingMethod[]>([])

async function load() {
  const [ib, dash, m] = await Promise.all([
    window.soroban.getInbox(),
    window.soroban.getDashboard(),
    window.soroban.listShippingMethods(),
  ])
  inbox.value = ib
  dashboard.value = dash
  methods.value = m
}
onMounted(load)
watch(revision, load)

const totalItems = computed(() => (inbox.value?.groups ?? []).reduce((sum, g) => sum + g.items.length, 0))

// 操作中の行は disabled にする（連打防止）。key は InboxItem.id
const busy = reactive(new Set<string>())
async function withBusy(id: string, fn: () => Promise<void>) {
  busy.add(id)
  try {
    await fn()
    await load()
    changed()
  } finally {
    busy.delete(id)
  }
}

function placeholderChar(title: string): string {
  const bracket = title.match(/【([^】]+)】/)
  const c = (bracket ? bracket[1] : title.trim()).charAt(0)
  return (c || '?').toUpperCase()
}

// profit_hint は数値だけを main が返す。文言（「送料を入れると」「紐付けると」「約」）はここで組む
function profitHintText(kind: string, hint: { min: number; max: number } | null | undefined): string | null {
  if (!hint) return null
  const verb = kind === 'shipping' ? '送料を入れると粗利 ' : kind === 'link' ? '紐付けると粗利 ' : '粗利 '
  return hint.min === hint.max ? `${verb}約 ${yen(hint.min)}` : `${verb}${yen(hint.min)}〜${yen(hint.max)}`
}
// 幅の下限が負なら赤（片方だけ負でも赤）。両方 0 以上なら緑
function profitHintClass(hint: { min: number; max: number } | null | undefined): string {
  return hint && hint.min < 0 ? 'loss' : 'profit'
}

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する（Sales.vue と同じやり方） ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(item: InboxItem): boolean {
  return !!item.thumb_url && !thumbFailed.value.has(item.id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}

// --- ship / shipping：行内の発送方法セレクト ---
async function setShipping(item: InboxItem, methodId: string) {
  if (!item.sale) return
  await withBusy(item.id, () => window.soroban.updateSale(item.sale!.id, { shipping_method_id: methodId || null }))
}

// --- link：候補を紐付ける／私物にする ---
async function linkCandidate(item: InboxItem) {
  if (!item.sale || !item.candidate) return
  await withBusy(item.id, () => window.soroban.linkInventory(item.sale!.id, [item.candidate!.inventory_item_id]))
}
async function markPersonal(item: InboxItem) {
  if (!item.sale) return
  await withBusy(item.id, () => window.soroban.updateSale(item.sale!.id, { kind: 'personal' }))
}
function gotoSaleAll(item: InboxItem) {
  goto('sales', { stage: 'all', focusId: item.sale?.id })
}

// --- confirm：仕入の価格入力は仕入タブへ ---
function goConfirmPurchase(item: InboxItem) {
  if (!item.purchase) return
  goto('purchases', { focusId: item.purchase.id })
}

// --- collect：取り込みの問題 ---
async function retryCollect(item: InboxItem) {
  busy.add(item.id)
  try {
    if (injectedCollect) await injectedCollect()
    else await window.soroban.collect()
    await load()
  } finally {
    busy.delete(item.id)
  }
}
async function openLoginForRun() {
  await window.soroban.openLogin()
}

// --- reminder：自分で入れるものの導線とスヌーズ ---
function reminderAction(item: InboxItem) {
  const r = item.reminder
  if (!r) return
  if (r.type === 'manual_purchase') goto('purchases')
  else if (r.type === 'delivery' && r.purchase_id) {
    void withBusy(item.id, () => window.soroban.updatePurchaseFulfillment(r.purchase_id!, 'delivered'))
  } else if (r.type === 'expense') goto('expenses')
  else if (r.type === 'close_month') goto('monthly', { month: r.month })
}
async function snooze(item: InboxItem) {
  const r = item.reminder
  if (!r) return
  await withBusy(item.id, () => window.soroban.snoozeReminder(r.type, r.purchase_id ?? r.month ?? null))
}

// --- 取引画面を開く（メルカリを既定ブラウザで） ---
async function openTransaction(item: InboxItem) {
  if (!item.sale?.mercari_item_id) return
  await window.soroban.openMercari('transaction', item.sale.mercari_item_id)
}

// --- 見直すもの ---
function gotoAging() {
  goto('inventory', { inventoryStatus: 'all', agingMin: inbox.value?.review.aging_days ?? 90 })
}
function gotoUnallocated() {
  goto('sales', { stage: 'listed', onlyUnallocated: true })
}
function gotoMonth() {
  const m = inbox.value?.review.last_month_unclosed
  goto('monthly', m ? { month: m } : undefined)
}
function gotoTopModel() {
  const code = inbox.value?.review.top_model?.model_code
  if (code) goto('products', { modelCode: code })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">ホーム</h1>
    </div>

    <template v-if="inbox">
      <!-- 上：利益ストリップ（共通部品） -->
      <ProfitStripBar :strip="inbox.strip" />

      <div class="inbox-grid">
        <!-- 左（主）：今やること -->
        <section class="panel inbox-panel">
          <div class="inbox-head">
            <h2 class="section-head-title">今やること</h2>
            <span class="dim">{{ totalItems }} 件 ・ 上から順に片付ければ終わり</span>
          </div>

          <EmptyState v-if="totalItems === 0" title="今日やることはありません" />

          <template v-else>
            <div v-for="group in inbox.groups" :key="group.kind" v-show="group.items.length" class="group">
              <p class="group-title">
                <span class="group-label">{{ groupLabels[group.kind] }}</span>
                <span class="n" :class="{ soft: group.kind === 'reminder' }">{{ group.items.length }}</span>
                <span class="group-hint">{{ group.hint }}</span>
              </p>

              <div v-for="item in group.items" :key="item.id" class="inbox-row">
                <div class="row-thumb">
                  <img
                    v-if="showThumb(item)"
                    class="row-thumb-img"
                    :src="item.thumb_url!"
                    alt=""
                    loading="lazy"
                    @error="onThumbError(item.id)"
                  />
                  <span v-else class="row-thumb-ph" :class="{ warn: group.kind === 'collect' }">
                    {{ group.kind === 'collect' ? '!' : placeholderChar(item.title) }}
                  </span>
                </div>

                <div class="row-main">
                  <div class="row-labels">
                    <StatusPill v-if="group.kind === 'ship'" tone="solid-info" label="発送してください" />
                    <StatusChip v-if="group.kind === 'confirm' && item.purchase" tone="neutral" :label="item.purchase.shop_account_name" />
                  </div>
                  <div class="row-title one-line" :title="item.title">{{ item.title }}</div>
                  <div class="row-sub">
                    <span class="dim">{{ item.detail }}</span>
                    <b v-if="profitHintText(group.kind, item.profit_hint)" class="profit-hint" :class="profitHintClass(item.profit_hint)">
                      ・ {{ profitHintText(group.kind, item.profit_hint) }}
                    </b>
                  </div>
                </div>

                <div class="row-act">
                  <!-- 発送する：発送方法が未定ならセレクトを出す -->
                  <template v-if="group.kind === 'ship'">
                    <select
                      v-if="!item.sale?.shipping_method_id"
                      class="invalid"
                      :disabled="busy.has(item.id)"
                      @change="setShipping(item, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">選択…</option>
                      <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}　{{ yen(m.fee) }}</option>
                    </select>
                    <button class="sm" :disabled="busy.has(item.id)" @click="openTransaction(item)">
                      取引画面を開く <Icon name="external" :size="12" />
                    </button>
                  </template>

                  <!-- 送料を入れる：セレクトを選べばその場で行が消える -->
                  <template v-else-if="group.kind === 'shipping'">
                    <select
                      class="invalid"
                      :disabled="busy.has(item.id)"
                      @change="setShipping(item, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">選択…</option>
                      <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}　{{ yen(m.fee) }}</option>
                    </select>
                  </template>

                  <!-- 在庫を紐付ける -->
                  <template v-else-if="group.kind === 'link'">
                    <template v-if="item.candidate">
                      <button class="sm" :disabled="busy.has(item.id)" @click="linkCandidate(item)">
                        {{ item.candidate.item_code }} を紐付ける
                      </button>
                      <button class="sm link-btn" @click="gotoSaleAll(item)"><Icon name="link" :size="14" /> 在庫を選ぶ</button>
                    </template>
                    <template v-else>
                      <button class="sm" :disabled="busy.has(item.id)" @click="gotoSaleAll(item)">在庫を選ぶ</button>
                      <button class="link-action" :disabled="busy.has(item.id)" @click="markPersonal(item)">私物にする</button>
                    </template>
                  </template>

                  <!-- 仕入の価格を入れる -->
                  <template v-else-if="group.kind === 'confirm'">
                    <button class="sm" @click="goConfirmPurchase(item)">価格を入れて確定</button>
                  </template>

                  <!-- 取り込みの問題 -->
                  <template v-else-if="group.kind === 'collect'">
                    <button
                      v-if="item.run?.status === 'auth_required'"
                      class="sm"
                      title="ログインのウィンドウが開きます。ログインしたら閉じて「取り込む」を押してください"
                      @click="openLoginForRun"
                    >ログインする</button>
                    <button v-else class="sm" :disabled="busy.has(item.id)" @click="retryCollect(item)">もう一度取り込む</button>
                  </template>

                  <!-- 忘れていませんか -->
                  <template v-else-if="group.kind === 'reminder'">
                    <button
                      v-if="item.reminder"
                      class="sm"
                      :disabled="busy.has(item.id)"
                      @click="reminderAction(item)"
                    >{{ item.reminder.action_label }}</button>
                    <button class="link-action" :disabled="busy.has(item.id)" @click="snooze(item)">今はいい</button>
                  </template>
                </div>
              </div>
            </div>
          </template>

          <p class="done-row faint">✓ 今日片付けたもの {{ inbox.done_today }} 件</p>
          <p class="faint foot">送料と紐付けで原価・利益を確認できます。取引完了までは見込みとして表示します。</p>
        </section>

        <!-- 右：見直すもの -->
        <aside class="side-col">
          <div class="stat-card cream">
            <span class="stat-card-label">在庫</span>
            <span class="stat-card-value">{{ dashboard?.stockCount ?? 0 }}<span class="unit">点</span></span>
            <span class="stat-card-sub">{{ yen(dashboard?.stockValue ?? 0) }}</span>
          </div>

          <div class="panel review-panel">
            <h3 class="panel-title">見直すもの</h3>
            <button class="review-row" @click="gotoAging">
              <span>長期滞留（{{ inbox.review.aging_days }}日以上）</span>
              <b>{{ inbox.review.aging_count }} 点 →</b>
            </button>
            <button class="review-row" @click="gotoUnallocated">
              <span>未紐付けの出品</span>
              <b>{{ inbox.review.unallocated_listings }} 件 →</b>
            </button>
            <button class="review-row" @click="gotoMonth">
              <span>先月の締め</span>
              <b>{{ inbox.review.last_month_unclosed ? 'まだ' : '済み' }} →</b>
            </button>
            <button v-if="inbox.review.top_model" class="review-row" @click="gotoTopModel">
              <span>よく売れている型番</span>
              <b>{{ inbox.review.top_model.model_code }} →</b>
            </button>
          </div>
        </aside>
      </div>
    </template>

    <template v-else>
      <div class="profit-strip">
        <div class="stat-card brand"><Skeleton kind="stats" /></div>
        <div class="stat-card"><Skeleton kind="stats" /></div>
        <div class="stat-card"><Skeleton kind="stats" /></div>
        <div class="stat-card"><Skeleton kind="stats" /></div>
      </div>
      <div class="inbox-grid">
        <section class="panel inbox-panel">
          <div class="inbox-head">
            <h2 class="section-head-title">今やること</h2>
          </div>
          <Skeleton :rows="6" />
        </section>
        <aside class="side-col">
          <div class="stat-card cream"><Skeleton kind="stats" /></div>
          <div class="panel review-panel">
            <h3 class="panel-title">見直すもの</h3>
            <Skeleton :rows="4" />
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* --- 利益ストリップ（読み込み中はこのカード分割のまま。読み込み後は ProfitStripBar に置き換える） --- */
.profit-strip-bar {
  margin-bottom: 18px;
}
.profit-strip {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 1fr;
  gap: 12px;
  margin-bottom: 18px;
}
.unit { font-size: var(--fs-12); font-weight: 400; margin-left: 2px; }

/* --- レイアウト。左：今やること（主）、右：見直すもの --- */
.inbox-grid {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 18px;
  align-items: start;
}
@media (max-width: 1099px) {
  .inbox-grid { grid-template-columns: 1fr; }
}

.side-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.inbox-panel { min-width: 0; }
.inbox-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.inbox-head h2 { margin: 0; }

/* --- グループ見出し --- */
.group { margin-top: 14px; }
.group:first-of-type { margin-top: 0; }
.group-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: var(--fs-12);
  color: var(--text-faint);
  letter-spacing: .02em;
}
.group-label { font-weight: 600; color: var(--text-dim); }
.group-hint { font-weight: 400; }
.n {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  min-height: 18px;
  border-radius: 999px;
  background: var(--warn-bg);
  color: var(--warn);
  font-weight: 700;
}
.n.soft { background: var(--surface-hi); color: var(--text-dim); }

/* --- 行 --- */
.inbox-row {
  display: grid;
  grid-template-columns: 44px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 10px 8px;
  border-top: 1px solid var(--line-soft);
}
.group > .inbox-row:first-of-type { border-top: 0; }

.row-thumb {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}
.row-thumb-img { width: 100%; height: 100%; object-fit: cover; }
.row-thumb-ph {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 800;
}
.row-thumb-ph.warn { background: var(--warn-bg); color: var(--warn); }

.row-main { min-width: 0; }
/* .row-labels / .row-title / .row-sub は style.css の共通クラス。色は .profit / .loss に委ねる。負の見込みを緑で出さない */
.profit-hint { font-weight: 700; }

.row-act {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}
.row-act select { max-width: 220px; }

.link-action {
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  color: var(--text-dim);
  font-size: var(--fs-12);
  text-decoration: underline dotted;
  cursor: pointer;
}
.link-action:hover:not(:disabled) { background: transparent; color: var(--text); }

.done-row {
  margin: 14px 0 0;
  font-size: var(--fs-12);
}
.foot { margin: 4px 0 0; font-size: var(--fs-12); }

/* --- 見直すもの --- */
.review-panel { padding: 14px 16px; }
.review-row {
  display: flex;
  width: 100%;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--line-soft);
  background: transparent;
  border-left: none;
  border-right: none;
  border-bottom: none;
  height: auto;
  text-align: left;
  font-size: var(--fs-13);
  color: var(--text);
}
.review-row:first-of-type { border-top: 0; }
.review-row:hover { background: var(--surface-hi); }
.review-row b { font-size: var(--fs-14); font-weight: 700; }
</style>
