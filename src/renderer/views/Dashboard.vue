<script setup lang="ts">
// ホーム＝受信箱。「今やること」を1本のリストに束ね、上から順に片付ければ終わる形にする。
// 数字・文言（title/detail/profit_hint）は main（getInbox）が組み立て済みのものをそのまま出す。
// レンダラー側では利益を再計算しない。
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, inject, type Ref } from 'vue'
import type { Inbox, InboxItem, InboxKind, ShippingMethod, DashboardStats, ListingStatus } from '../../shared/types'
import { CHANNEL_LABEL } from '../../shared/types'
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
  release: '止めた出品の在庫を外す',
  reminder: '忘れていませんか',
}

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const toast = inject<(text: string, kind: 'ok' | 'warn', action?: { label: string; run: () => void | Promise<void> }) => void>('toast')!
const goto = inject<(t: string, payload?: {
  modelCode?: string
  stage?: 'listed' | 'pending' | 'done' | 'all'
  onlyUnallocated?: boolean
  focusId?: string
  month?: string
  listingStatus?: ListingStatus
  inventoryStatus?: 'unlisted' | 'listed' | 'sold' | 'other' | 'all'
  agingMin?: number
}) => void>('goto')!

// App.vue のヘッダの「取り込む」があればそれに任せる（通知・件数更新まで面倒を見てくれる）。
// 無ければ window.soroban.collect() を直接呼ぶ（Dashboard 単体表示など）
const injectedCollect = inject<(() => Promise<void>) | undefined>('collect', undefined)

// Web 版（auth/boot.ts が window.sorobanWeb を差す）。ログインのウィンドウはこの端末では開けない（取り込み担当の PC のそろばんで行う）
const isWeb = !!window.sorobanWeb

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

// --- 発送方法を選んだあとの「済」の行 ---
// 送料を入れる行は、選んで読み直すと黙って消え、下の行が指の下にせり上がる（誤タップのもと）。
// そこで、選んだ行は読み直しの前に「済　<発送方法> ¥<料金>」に替えてその場に残し、1.2 秒後に高さを 180ms で畳んでから外す。
// 料金は表示だけで、計算には使わない（粗利などは main が返したものをそのまま出す）。
const HOLD_MS = 1200
const COLLAPSE_MS = 180 // style.css の --dur と同じ
interface Held {
  seq: number
  kind: InboxKind
  item: InboxItem     // 押した時点の行。読み直しで消えても描ける
  hint: string        // グループごと消えるときの見出し用
  index: number       // グループの中の並び（表示している行の中での位置）
  height: number      // 押した時点の行の高さ。「済」に替えても動かさない
  label: string       // 「ゆうパケット ¥200」
  reloaded: boolean   // 読み直しが終わった
  elapsed: boolean    // 1.2 秒たった
  collapsing: boolean
}
const held = reactive(new Map<string, Held>())
const holdKey = (kind: InboxKind, id: string) => `${kind}:${id}`
let holdSeq = 0
const holdTimers = new Set<ReturnType<typeof setTimeout>>()
function later(fn: () => void, ms: number) {
  const t = setTimeout(() => { holdTimers.delete(t); fn() }, ms)
  holdTimers.add(t)
}
onBeforeUnmount(() => { holdTimers.forEach(clearTimeout); holdTimers.clear() })
function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface DisplayItem { item: InboxItem; hold: Held | null }
interface DisplayGroup {
  kind: InboxKind
  hint: string
  items: DisplayItem[]
  open: number         // 「済」を除いた、まだやることの数
  collapsing: boolean  // 残っているのが畳み始めた「済」だけ＝見出しごと畳む
}
// サーバーが並べる順。グループごと消えた行の見出しを、元の位置に戻すのに使う
const GROUP_ORDER: InboxKind[] = ['ship', 'shipping', 'link', 'release', 'confirm', 'collect', 'reminder']

// 画面に出す行。main が返した行のうち「済」にした行は本物を出さず、押した時点の行を元の位置に差す
const displayGroups = computed<DisplayGroup[]>(() => {
  const groups: DisplayGroup[] = (inbox.value?.groups ?? []).map(g => ({
    kind: g.kind,
    hint: g.hint,
    items: g.items.filter(i => !held.has(holdKey(g.kind, i.id))).map(item => ({ item, hold: null })),
    open: 0,
    collapsing: false,
  }))
  const byKind = new Map<InboxKind, Held[]>()
  for (const h of held.values()) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h])
  for (const [kind, hs] of byKind) {
    let g = groups.find(x => x.kind === kind)
    if (!g) {
      g = { kind, hint: hs[0].hint, items: [], open: 0, collapsing: false }
      const at = groups.findIndex(x => GROUP_ORDER.indexOf(x.kind) > GROUP_ORDER.indexOf(kind))
      groups.splice(at === -1 ? groups.length : at, 0, g)
    }
    for (const h of [...hs].sort((a, b) => a.index - b.index)) {
      g.items.splice(Math.min(h.index, g.items.length), 0, { item: h.item, hold: h })
    }
  }
  for (const g of groups) {
    g.open = g.items.filter(d => !d.hold).length
    g.collapsing = g.items.length > 0 && g.items.every(d => d.hold?.collapsing)
  }
  return groups
})
// 「済」の行だけが残っていても、一覧は出し続ける（空の案内に替えると、その場に残した意味がなくなる）
const displayCount = computed(() => displayGroups.value.reduce((sum, g) => sum + g.items.length, 0))
const totalItems = computed(() => displayGroups.value.reduce((sum, g) => sum + g.open, 0))

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
function displayIndex(kind: InboxKind, id: string): number {
  const i = displayGroups.value.find(g => g.kind === kind)?.items.findIndex(d => d.item.id === id) ?? -1
  return Math.max(i, 0)
}
function beginHold(kind: InboxKind, item: InboxItem, height: number, label: string) {
  const key = holdKey(kind, item.id)
  const seq = ++holdSeq
  held.set(key, {
    seq, kind, item, label, height,
    hint: displayGroups.value.find(g => g.kind === kind)?.hint ?? '',
    index: displayIndex(kind, item.id),
    reloaded: false, elapsed: false, collapsing: false,
  })
  later(() => {
    const h = held.get(key)
    if (!h || h.seq !== seq) return // 早く外れた／同じ行でやり直した
    h.elapsed = true
    settleHold(key)
  }, HOLD_MS)
}
// 1.2 秒たち、読み直しも終わったら畳む。どちらかが遅れたら、遅れた方を待つ（読み直し前の古い行を出さないため）
function settleHold(key: string) {
  const h = held.get(key)
  if (!h || h.collapsing || !h.reloaded || !h.elapsed) return
  if (reducedMotion()) { held.delete(key); return }
  const seq = h.seq
  h.collapsing = true
  later(() => { if (held.get(key)?.seq === seq) held.delete(key) }, COLLAPSE_MS)
}
function endReload(key: string) {
  const h = held.get(key)
  if (!h) return
  h.reloaded = true
  // 読み直しても行が残っている＝片付いていない。「済」をやめて本物の行に戻す
  const stillThere = inbox.value?.groups.find(g => g.kind === h.kind)?.items.some(i => i.id === h.item.id)
  if (stillThere) held.delete(key)
  else settleHold(key)
}

async function setShipping(item: InboxItem, kind: InboxKind, el: HTMLSelectElement) {
  const sale = item.sale
  if (!sale) return
  const methodId = el.value
  // 「選択…」に戻した＝送料を空に戻す。「入れました」とも「済」とも言わない
  if (!methodId) {
    await withBusy(item.id, () => window.soroban.updateSale(sale.id, { shipping_method_id: null }))
    return
  }
  const method = methods.value.find(m => m.id === methodId)
  const label = method ? `${method.name} ${yen(method.fee)}` : ''
  const height = el.closest<HTMLElement>('.inbox-row')?.offsetHeight ?? 0
  try {
    await withBusy(item.id, async () => {
      await window.soroban.updateSale(sale.id, { shipping_method_id: methodId })
      toast(label ? `${label} を入れました` : '発送方法を入れました', 'ok')
      // 送料を入れる行は読み直すと消える。読み直しの前に「済」に替えておく（消える瞬間を作らない）
      if (kind === 'shipping') beginHold(kind, item, height, label || '発送方法')
    })
  } catch (e) {
    el.value = ''
    toast(e instanceof Error ? e.message : String(e), 'warn')
  } finally {
    endReload(holdKey(kind, item.id))
  }
}

// --- link：候補を紐付ける／私物にする ---
async function linkCandidate(item: InboxItem) {
  if (!item.sale || !item.candidate) return
  await withBusy(item.id, () => window.soroban.linkInventory(item.sale!.id, [item.candidate!.inventory_item_id]))
}
async function markPersonal(item: InboxItem) {
  const sale = item.sale
  if (!sale) return
  await withBusy(item.id, () => window.soroban.updateSale(sale.id, { kind: 'personal' }))
  // 確認ダイアログは挟まない（タップ数を増やさない）。間違えたときは通知の「元に戻す」で、種別を戻すだけ
  toast('私物にしました', 'ok', {
    label: '元に戻す',
    run: async () => {
      try {
        await window.soroban.updateSale(sale.id, { kind: 'resale' })
        await load()
        changed()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'warn')
      }
    },
  })
}
function gotoSaleAll(item: InboxItem) {
  goto('sales', { stage: 'all', focusId: item.sale?.id })
}

// --- release：止めた出品が押さえている在庫を、出品から外す（在庫・販売の記録は消えない） ---
// 1 つの出品が複数点を押さえていることがあるので、点数ぶんを 1 クリックでまとめて外す
function releaseHeldText(item: InboxItem): string {
  const items = item.release?.items ?? []
  return items.map(i => `${i.item_code} ${i.name}`).join('、')
}
function releaseButtonLabel(item: InboxItem): string {
  const n = item.release?.items.length ?? 0
  return n > 1 ? `${n} 点とも出品から外す` : '在庫を出品から外す'
}
async function releaseListing(item: InboxItem) {
  const r = item.release
  if (!r || r.items.length === 0) return
  const codes = r.items.map(i => i.item_code).join('、')
  try {
    await withBusy(item.id, async () => {
      for (const it of r.items) await window.soroban.unreserveInventory(r.listing_id, it.inventory_item_id)
    })
    toast(`${codes} を出品から外しました（在庫は残っています）`, 'ok')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
    await load()
  }
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

// --- 取引画面を開く（既定ブラウザで。出品先に応じて正しい URL を main が組み立てる） ---
async function openTransaction(item: InboxItem) {
  if (!item.sale?.mercari_item_id) return
  try {
    await window.soroban.openChannelPage(item.sale.channel, 'transaction', item.sale.mercari_item_id)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
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
  <div class="page home-page">
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

          <EmptyState v-if="displayCount === 0" title="今日やることはありません" hint="「取り込む」で新しい動きがあれば表示されます" />

          <template v-else>
            <!-- .slot は畳むための入れ物（畳むとき以外は何もしない）。グループは、残りが「済」だけになったら見出しごと畳む -->
            <div v-for="group in displayGroups" :key="group.kind" class="slot group-slot" :class="{ collapsing: group.collapsing }">
              <div class="group">
                <p class="group-title">
                  <span class="group-label">{{ groupLabels[group.kind] }}</span>
                  <span class="n" :class="{ soft: group.kind === 'reminder' || group.open === 0 }">{{ group.open }}</span>
                  <span class="group-hint">{{ group.hint }}</span>
                </p>

                <div
                  v-for="{ item, hold } in group.items"
                  :key="item.id"
                  class="slot"
                  :class="{ collapsing: !!hold?.collapsing && !group.collapsing }"
                  :style="hold && !hold.collapsing ? { minHeight: hold.height + 'px' } : undefined"
                >
                  <div class="slot-in">
                    <div class="inbox-row" :class="{ held: !!hold }">
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
                          <StatusChip v-if="item.sale" tone="neutral" :label="CHANNEL_LABEL[item.sale.channel]" :title="`出品先：${CHANNEL_LABEL[item.sale.channel]}`" />
                          <StatusChip v-if="item.release" tone="neutral" :label="CHANNEL_LABEL[item.release.listing_channel]" :title="`出品先：${CHANNEL_LABEL[item.release.listing_channel]}`" />
                          <StatusPill v-if="group.kind === 'ship'" tone="solid-info" label="発送してください" />
                          <StatusPill v-if="group.kind === 'release'" tone="solid-warn" label="出品停止中" />
                          <StatusChip v-if="group.kind === 'confirm' && item.purchase" tone="neutral" :label="item.purchase.shop_account_name" />
                        </div>
                        <div class="row-title one-line" :title="item.title">{{ item.title }}</div>
                        <!-- 「済」の行：補足と粗利の見込みは、送料を入れる前の言い方のままなので出さない（高さだけ残す） -->
                        <div v-if="hold" class="row-sub" aria-hidden="true">&nbsp;</div>
                        <div v-else-if="item.release" class="row-sub two-lines" :title="`押さえている在庫（${item.release.items.length} 点）：${releaseHeldText(item)}`">
                          <b>押さえている在庫 {{ item.release.items.length }} 点：</b>{{ releaseHeldText(item) }}
                        </div>
                        <div v-else class="row-sub">
                          <span class="dim">{{ item.detail }}</span>
                          <b v-if="profitHintText(group.kind, item.profit_hint)" class="profit-hint" :class="profitHintClass(item.profit_hint)">
                            ・ {{ profitHintText(group.kind, item.profit_hint) }}
                          </b>
                          <!-- スマホ幅だけ：区切りの「・」なしで、自分の行に出す（デスクトップ幅では出さない。上の文は一切変えない） -->
                          <b v-if="profitHintText(group.kind, item.profit_hint)" class="profit-hint-m" :class="profitHintClass(item.profit_hint)">{{ profitHintText(group.kind, item.profit_hint) }}</b>
                        </div>
                      </div>

                      <div class="row-act">
                        <!-- 発送方法を入れた行：選んだ場所に、入れたものを出す（1.2 秒後に畳まれる） -->
                        <span v-if="hold" class="held-done"><Icon name="check" :size="14" class="held-check" />済　{{ hold.label }}</span>

                        <!-- 発送する：発送方法が未定ならセレクトを出す -->
                        <template v-else-if="group.kind === 'ship'">
                          <select
                            v-if="!item.sale?.shipping_method_id"
                            class="invalid"
                            :disabled="busy.has(item.id)"
                            @change="setShipping(item, group.kind, $event.target as HTMLSelectElement)"
                          >
                            <option value="">選択…</option>
                            <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}　{{ yen(m.fee) }}</option>
                          </select>
                          <button class="sm" :disabled="busy.has(item.id)" @click="openTransaction(item)">
                            取引画面を開く <Icon name="external" :size="12" />
                          </button>
                        </template>

                        <!-- 送料を入れる：セレクトを選べば「済」に替わり、1.2 秒後に畳まれる -->
                        <template v-else-if="group.kind === 'shipping'">
                          <select
                            class="invalid"
                            :disabled="busy.has(item.id)"
                            @change="setShipping(item, group.kind, $event.target as HTMLSelectElement)"
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
                          <!-- Web 版：押しても開けるウィンドウが無いので、ボタンは出さず、やることを文で伝える -->
                          <span v-if="isWeb && item.run?.status === 'auth_required'" class="web-hint" title="取り込み担当の PC のそろばんでログインしてください"><span>取り込み担当の PC の</span><span>そろばんでログインしてください</span></span>
                          <button
                            v-else-if="item.run?.status === 'auth_required'"
                            class="sm"
                            title="ログインのウィンドウが開きます。ログインしたら閉じて「取り込む」を押してください"
                            @click="openLoginForRun"
                          >ログインする</button>
                          <button v-else class="sm" :disabled="busy.has(item.id)" @click="retryCollect(item)">もう一度取り込む</button>
                          <span v-if="!isWeb && item.run?.status === 'auth_required'" class="m-hint">ログインのウィンドウが開きます。ログインしたら閉じて「取り込む」を押してください</span>
                        </template>

                        <!-- 止めた出品の在庫を外す：1 クリックで全部。押した行はその場で消える -->
                        <template v-else-if="group.kind === 'release'">
                          <button
                            class="sm"
                            :disabled="busy.has(item.id)"
                            title="出品から在庫を外すだけです。在庫も販売の記録も消えません。"
                            @click="releaseListing(item)"
                          >{{ releaseButtonLabel(item) }}</button>
                          <span class="m-hint">出品から在庫を外すだけです。在庫も販売の記録も消えません。</span>
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

/* --- 畳むための入れ物（.slot）---
   行（とグループ）を高さごと畳む。grid の行を 1fr → 0fr に動かすと、中身の高さを測らずに畳める。
   畳むとき以外は、幅いっぱいの 1 マスなだけで見た目は変わらない。
   行は padding・罫線を持つので、そのままでは 0 まで縮まない。padding の無い .slot-in で包んで、そちらを縮める。 */
.slot {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: 1fr;
  min-height: 0; /* 「済」の間だけ行の高さを保つ min-height（インライン）を、畳むときに 0 へ動かせるよう明示しておく */
}
.slot > * { min-height: 0; }
.slot-in { display: grid; grid-template-columns: minmax(0, 1fr); }
/* 動かすのは畳むときだけ。「済」に替える瞬間（min-height が 0 → 行の高さになる）は動かさない */
.slot.collapsing {
  grid-template-rows: 0fr;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  transition: grid-template-rows var(--dur) var(--ease), min-height var(--dur) var(--ease), opacity var(--dur) var(--ease), margin-top var(--dur) var(--ease);
}

/* --- グループ見出し --- */
.group-slot { margin-top: 14px; }
.group-slot.collapsing { margin-top: 0; }
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
.group > .slot:first-of-type > .slot-in > .inbox-row { border-top: 0; }

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
/* スマホ幅だけで出す版（下の @media）。デスクトップ幅では出さない */
.profit-hint-m { display: none; font-weight: 700; }

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
@media (hover: hover) and (pointer: fine) {
  .link-action:hover:not(:disabled) { background: transparent; color: var(--text); }
}

/* --- 発送方法を入れた行（「済」。1.2 秒だけ残って畳まれる）--- */
.inbox-row.held .row-thumb { opacity: .6; }
.inbox-row.held .row-title { color: var(--text-dim); }
.held-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-14);
  font-weight: 600;
  white-space: nowrap;
}
.held-check { color: var(--profit); flex: 0 0 auto; }

/* スマホ幅だけで出す補足（デスクトップ幅ではボタンの title＝ホバーで読めるもの） */
.m-hint { display: none; }

/* Web 版だけ：ログインのボタンの代わりに出す 1 文（どの幅でも出す）。右の列を広げないよう折り返す */
.web-hint {
  max-width: 220px;
  font-size: var(--fs-12);
  line-height: 1.5;
  color: var(--text-dim);
  text-align: right;
}
/* 折り返すときは句の切れ目で（「ログイン／してください」と割れない） */
.web-hint > span { display: inline-block; }

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
@media (hover: hover) and (pointer: fine) {
  .review-row:hover { background: var(--surface-hi); }
}
.review-row b { font-size: var(--fs-14); font-weight: 700; }

/* ============================================================
   スマホ幅（768px 未満）
   「今やること」（要対応）を最初に。数字（利益ストリップ）と見直すものはその下に回す。
   行は 上：サムネイルと文章、下：操作（全幅・44px 以上）。ホバーでしか読めなかったタイトルと補足は切らずに見せる。
   デスクトップ幅（768px 以上）の見た目には一切効かせない。
   ============================================================ */
@media (max-width: 767px) {
  .home-page { display: flex; flex-direction: column; }
  .home-page > .page-head { margin-bottom: 12px; }
  /* 2 列の入れ物をやめて、中の 2 つ（今やること／見直すもの）を並べ替えられるようにする */
  .inbox-grid { display: contents; }
  .inbox-panel { order: 1; }
  .profit-strip-bar,
  .profit-strip { order: 2; margin: 12px 0 0; }
  .profit-strip { grid-template-columns: 1fr 1fr; gap: 8px; }
  .side-col { order: 3; margin-top: 12px; }

  /* 見出し：「今やること」を縦書きにつぶさない。件数と案内は次の行へ回してよい */
  .inbox-head { flex-wrap: wrap; gap: 0 12px; }
  .inbox-head h2 { flex: 0 0 auto; }

  .inbox-row {
    grid-template-columns: 44px minmax(0, 1fr);
    align-items: start;
    gap: 10px 12px;
    padding: 12px 0;
  }
  .inbox-row .row-title.one-line { -webkit-line-clamp: 3; min-height: 0; }
  .inbox-row .row-sub { -webkit-line-clamp: 3; min-height: 0; }
  .inbox-row .row-sub.two-lines { -webkit-line-clamp: 4; min-height: 0; }
  /* 粗利の見込みは、日付・金額・買い手・発送方法の続きに詰めず、自分の行に出す（文の途中で割れない・いちばん目立つ） */
  .inbox-row .profit-hint { display: none; }
  .inbox-row .profit-hint-m { display: block; margin-top: 2px; }

  .row-act { grid-column: 1 / -1; justify-content: stretch; flex-wrap: wrap; }
  .row-act > button,
  .row-act > select {
    flex: 1 1 140px;
    height: 44px;
    max-width: none;
  }
  .row-act > select { flex-basis: 100%; }
  .m-hint {
    display: block;
    flex: 1 1 100%;
    font-size: var(--fs-12);
    color: var(--text-dim);
  }
  .web-hint { flex: 1 1 100%; max-width: none; text-align: left; }
  /* 「済」は、選んだセレクトがあった場所（全幅・44px）にそのまま出す */
  .held-done { flex: 1 1 100%; min-height: 44px; }
  .row-act > button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: var(--fs-14);
  }
  /* 下線だけの小さな文字は指で押せない。枠つきの 44px にする */
  .row-act > button.link-action {
    flex: 0 0 auto;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--fs-13);
    text-decoration: none;
  }

  .side-col .stat-card { padding: 14px 16px; }
  .side-col .stat-card-value { font-size: var(--fs-28); }
  .review-row { min-height: 48px; padding: 8px 0; border-radius: 0; font-size: var(--fs-14); }
}
</style>
