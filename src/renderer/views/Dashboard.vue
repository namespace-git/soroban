<script setup lang="ts">
// ホーム＝受信箱。「今やること」を1本のリストに束ね、上から順に片付ければ終わる形にする。
// 数字・文言（title/detail/profit_hint）は main（getInbox）が組み立て済みのものをそのまま出す。
// レンダラー側では利益を再計算しない。
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, inject, type Ref } from 'vue'
import type { Inbox, InboxItem, InboxKind, ShippingMethod, DashboardStats, ListingStatus, SaleProfit } from '../../shared/types'
import { CHANNEL_LABEL } from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import ProfitStripBar from '../components/ProfitStripBar.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import AllocateDrawer from '../components/AllocateDrawer.vue'
import { yen } from '../format'

// 画面のグループ。main は同じ販売を 'shipping'（送料を入れる）と 'link'（在庫を紐付ける）の両方に出すので、
// 画面の側で 1 販売＝1 カードにまとめて 'settle'（売上を確定する）として出す（表示の組み替えだけ。金額は触らない）
type DisplayKind = Exclude<InboxKind, 'shipping' | 'link'> | 'settle'

// グループ見出しの表示名。InboxGroup.label は main が返すが、文言はここで固定する
// （main 側のラベル変更に画面が引きずられないように）
const groupLabels: Record<DisplayKind, string> = {
  ship: '発送する',
  settle: '売上を確定する',
  confirm: '仕入の価格を入れる',
  collect: '取り込みの問題',
  release: '止めた出品の在庫を外す',
  reminder: '忘れていませんか',
}
const SETTLE_HINT = '送料と、どの仕入の品かが決まると利益が出ます。型番が合えば在庫は自動で入ります'

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

// --- 片付けた部分の「済」 ---
// 送料を入れる／在庫を紐付けると、読み直しで該当の作業が黙って消え、下の行が指の下にせり上がる（誤タップのもと）。
// そこで、片付けた部分は読み直しの前に「済　<内容>」に替えてその場に残し、1.2 秒後に高さを 180ms で畳んでから外す。
// 片方だけ片付いたときは、その部分だけ畳む。カードに残る作業が無くなったら、カードごと畳む。
// 料金は表示だけで、計算には使わない（粗利などは main が返したものをそのまま出す）。
const HOLD_MS = 1200
const COLLAPSE_MS = 180 // style.css の --dur と同じ
type Part = 'shipping' | 'link'
interface Held {
  seq: number
  part: Part
  item: InboxItem     // 押した時点のその部分の行。読み直しで消えても、カードの題・サムネ・販売を描ける
  index: number       // 押した時点のカードの位置（グループの中）
  height: number      // 押した時点のその部分の高さ。「済」に替えても動かさない
  rowHeight: number   // 押した時点のカード全体の高さ。カードが「済」だけになっても動かさない
  label: string       // 「ゆうパケット ¥200」「S-0004 を紐付け」
  reloaded: boolean   // 読み直しが終わった
  elapsed: boolean    // 1.2 秒たった
  collapsing: boolean
}
const held = reactive(new Map<string, Held>())
const holdKey = (part: Part, saleId: string) => `${part}:${saleId}`
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

// 売上を確定するカード 1 枚の中身。残っている作業（shipping／link）と、「済」にしてその場に残している部分
interface DisplayCard {
  shipping: InboxItem | null  // まだ残っている送料の作業（「済」にした分は含めない）
  link: InboxItem | null      // まだ残っている紐付けの作業
  shipHold: Held | null
  linkHold: Held | null
  collapsing: boolean         // 残っているのが畳み始めた「済」だけ＝カードごと畳む
}
// item は題・サムネイル・補足・販売を読む行（settle のカードでは shipping があればそれ、無ければ link。どちらも同じ販売）
interface DisplayItem { key: string; item: InboxItem; card: DisplayCard | null }
interface DisplayGroup {
  kind: DisplayKind
  hint: string
  items: DisplayItem[]
  open: number         // 「済」を除いた、まだやることの数。settle は販売の数
  collapsing: boolean  // 残っているのが畳み始めた「済」だけ＝見出しごと畳む
}
// サーバーが並べる順。グループごと消えたカードの見出しを、元の位置に戻すのに使う
const GROUP_ORDER: DisplayKind[] = ['ship', 'settle', 'release', 'confirm', 'collect', 'reminder']

function makeCard(saleId: string, shipping: InboxItem | null, link: InboxItem | null, holds: Held[]): DisplayItem {
  const shipHold = holds.find(h => h.part === 'shipping') ?? null
  const linkHold = holds.find(h => h.part === 'link') ?? null
  const card: DisplayCard = {
    shipping: shipHold ? null : shipping,
    link: linkHold ? null : link,
    shipHold,
    linkHold,
    collapsing: false,
  }
  const holding = [shipHold, linkHold].filter((h): h is Held => !!h)
  card.collapsing = !card.shipping && !card.link && holding.length > 0 && holding.every(h => h.collapsing)
  return { key: saleId, item: (shipping ?? link ?? holding[0]?.item)!, card }
}

// 画面に出すグループ。main が返した 'shipping' と 'link' は、販売 id ごとに 1 枚のカードにして 'settle' に集める。
//  - 位置は、先に出ていた方（＝'ship' の次）。カードの並びは、'shipping'・'link' を続けて並べたときの先に出ていた順
//  - 「済」にした部分は本物を出さず、押した時点の行を元のカードに差す。読み直しでカードごと消えていれば、元の位置に差す
const displayGroups = computed<DisplayGroup[]>(() => {
  const groups: DisplayGroup[] = []
  const sales = new Map<string, { shipping: InboxItem | null; link: InboxItem | null }>()
  let settleAt = -1
  for (const g of inbox.value?.groups ?? []) {
    if (g.kind === 'shipping' || g.kind === 'link') {
      if (settleAt === -1) settleAt = groups.length
      for (const item of g.items) {
        const s = sales.get(item.id) ?? { shipping: null, link: null }
        s[g.kind] = item
        sales.set(item.id, s)
      }
      continue
    }
    groups.push({
      kind: g.kind,
      hint: g.hint,
      items: g.items.map(item => ({ key: item.id, item, card: null })),
      open: 0,
      collapsing: false,
    })
  }

  const holdsBySale = new Map<string, Held[]>()
  for (const h of held.values()) holdsBySale.set(h.item.id, [...(holdsBySale.get(h.item.id) ?? []), h])
  const cards: DisplayItem[] = []
  for (const [id, s] of sales) cards.push(makeCard(id, s.shipping, s.link, holdsBySale.get(id) ?? []))
  const gone = [...holdsBySale].filter(([id]) => !sales.has(id))
    .sort((a, b) => Math.min(...a[1].map(h => h.index)) - Math.min(...b[1].map(h => h.index)))
  for (const [id, hs] of gone) {
    cards.splice(Math.min(Math.min(...hs.map(h => h.index)), cards.length), 0, makeCard(id, null, null, hs))
  }
  if (cards.length > 0) {
    const at = settleAt !== -1 ? settleAt : groups.findIndex(x => GROUP_ORDER.indexOf(x.kind) > GROUP_ORDER.indexOf('settle'))
    groups.splice(at === -1 ? groups.length : at, 0, { kind: 'settle', hint: SETTLE_HINT, items: cards, open: 0, collapsing: false })
  }

  for (const g of groups) {
    g.open = g.items.filter(d => !d.card || d.card.shipping || d.card.link).length
    g.collapsing = g.items.length > 0 && g.items.every(d => d.card?.collapsing)
  }
  return groups
})
// 「済」だけが残っていても、一覧は出し続ける（空の案内に替えると、その場に残した意味がなくなる）
const displayCount = computed(() => displayGroups.value.reduce((sum, g) => sum + g.items.length, 0))
// 件数は販売の数（売上タブのバッジと揃える）。1 つの販売が送料と紐付けの両方を残していても 1 件
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

// profit_hint は数値だけを main が返す。文言（「送料を入れると」「約」「赤字」）はここで組む。値は変えない
type Hint = { min: number; max: number }
// 見込みの書き方。マイナスは「−¥1,338〜−¥778」と書かず「赤字 ¥778〜¥1,338」と読ませる（絶対値を、損の小さい方から）
function hintBody(h: Hint, approx = false): string {
  const a = approx ? '約 ' : ''
  if (h.min === h.max) return h.min < 0 ? `赤字 ${a}${yen(-h.min)}` : `粗利 ${a}${yen(h.min)}`
  if (h.min >= 0) return `粗利 ${yen(h.min)}〜${yen(h.max)}`
  if (h.max < 0) return `赤字 ${yen(-h.max)}〜${yen(-h.min)}`
  return `赤字 ${yen(-h.min)}〜粗利 ${yen(h.max)}` // 幅がゼロをまたぐ
}
function profitHintText(kind: string, hint: Hint | null | undefined): string | null {
  if (!hint) return null
  const verb = kind === 'shipping' ? '送料を入れると' : ''
  return `${verb}${hintBody(hint, hint.min === hint.max)}`
}
// 幅の下限が負なら赤（片方だけ負でも赤）。両方 0 以上なら緑
function profitHintClass(hint: Hint | null | undefined): string {
  return hint && hint.min < 0 ? 'loss' : 'profit'
}
// 行の補足に添える見込み。売上を確定するカードは、紐付けが残っているあいだは出さない：
// 候補があれば候補ボタンが粗利を持ち、候補が無ければ原価が分からない（main の送料の見込みは原価 0 で数えた値になる）
function rowHint(kind: DisplayKind, d: DisplayItem): { text: string; cls: string } | null {
  let hint: Hint | null | undefined
  let hintKind: string = kind
  if (d.card) {
    if (d.card.link) return null
    hint = d.card.shipping?.profit_hint
    hintKind = 'shipping'
  } else {
    hint = d.item.profit_hint
  }
  const text = profitHintText(hintKind, hint)
  return text ? { text, cls: profitHintClass(hint) } : null
}
function cardDone(d: DisplayItem): boolean {
  return !!d.card && !d.card.shipping && !d.card.link
}
// 「済」の部分は、押した時点の高さを保つ（畳み始めたら外す）
function holdStyle(h: Held | null): { minHeight: string } | undefined {
  return h && !h.collapsing ? { minHeight: h.height + 'px' } : undefined
}
// 残りが「済」だけになったカードは、押した時点のカードの高さを保つ（畳み始めたら外す）
function cardStyle(d: DisplayItem): { minHeight: string } | undefined {
  if (!d.card || !cardDone(d) || d.card.collapsing) return undefined
  const h = Math.max(d.card.shipHold?.rowHeight ?? 0, d.card.linkHold?.rowHeight ?? 0)
  return h > 0 ? { minHeight: h + 'px' } : undefined
}

// --- 1 タップ紐付けのボタン：何を紐付けるのか（在庫コードだけにしない）と、紐付けたときの粗利を見せる ---
type Candidate = NonNullable<InboxItem['candidate']>
// 仕入からの日数。仕入日と今日（日本時間の暦日）の差。表示だけ
function daysSinceAcquired(acquiredAt: string): number | null {
  const [y, m, d] = acquiredAt.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = todayLocal().split('-').map(Number)
  if ([y, m, d].some(n => !Number.isFinite(n))) return null
  return Math.max(0, Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86400000))
}
function candidateMeta(c: Candidate): string {
  const days = daysSinceAcquired(c.acquired_at)
  const age = days == null ? '' : days === 0 ? '・今日仕入' : `・仕入から ${days} 日`
  return `（原価 ${yen(c.landed_cost)}${age}）`
}
// 2 行目「→ 粗利 ¥y」。送料しだいで幅があるときは「（送料しだい）」を添える。null なら 2 行目は出さない
function candidateProfit(item: InboxItem): { text: string; cls: string } | null {
  const h = item.profit_hint
  if (!h) return null
  return { text: `→ ${hintBody(h)}${h.min === h.max ? '' : '（送料しだい）'}`, cls: profitHintClass(h) }
}
function candidateTitle(item: InboxItem): string {
  const c = item.candidate
  if (!c) return ''
  const p = candidateProfit(item)
  return `${c.item_code} ${c.name}${candidateMeta(c)}を紐付ける${p ? `\n${p.text}` : ''}`
}

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する（Sales.vue と同じやり方） ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(item: InboxItem): boolean {
  return !!item.thumb_url && !thumbFailed.value.has(item.id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}

// --- ship / settle：行内の発送方法セレクト ---
function displayIndex(saleId: string): number {
  const i = displayGroups.value.find(g => g.kind === 'settle')?.items.findIndex(d => d.key === saleId) ?? -1
  return Math.max(i, 0)
}
// 押した要素（部分の中にある要素）から、部分とカード全体の高さを測る。「済」に替えても高さを動かさないために、押した時点で測っておく
function measure(from: Element | null): { height: number; rowHeight: number } {
  return {
    height: from?.closest<HTMLElement>('.part')?.offsetHeight ?? 0,
    rowHeight: from?.closest<HTMLElement>('.inbox-row')?.offsetHeight ?? 0,
  }
}
function beginHold(part: Part, item: InboxItem, label: string, size: { height: number; rowHeight: number }, index = displayIndex(item.id)) {
  const key = holdKey(part, item.id)
  const seq = ++holdSeq
  held.set(key, { seq, part, item, label, ...size, index, reloaded: false, elapsed: false, collapsing: false })
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
  // 読み直しても作業が残っている＝片付いていない。「済」をやめて本物に戻す
  const stillThere = inbox.value?.groups.find(g => g.kind === h.part)?.items.some(i => i.id === h.item.id)
  if (stillThere) held.delete(key)
  else settleHold(key)
}

// scope 'ship'：発送するの行（発送が済むまで行は残るので「済」にしない）／'settle'：売上を確定するカードの送料の部分
async function setShipping(item: InboxItem, scope: 'ship' | 'settle', el: HTMLSelectElement) {
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
  const size = measure(el)
  try {
    await withBusy(item.id, async () => {
      await window.soroban.updateSale(sale.id, { shipping_method_id: methodId })
      toast(label ? `${label} を入れました` : '発送方法を入れました', 'ok')
      // 送料の部分は読み直すと消える。読み直しの前に「済」に替えておく（消える瞬間を作らない）
      if (scope === 'settle') beginHold('shipping', item, label || '発送方法', size)
    })
  } catch (e) {
    el.value = ''
    toast(e instanceof Error ? e.message : String(e), 'warn')
  } finally {
    if (scope === 'settle') endReload(holdKey('shipping', item.id))
  }
}
function setCardShipping(d: DisplayItem, el: HTMLSelectElement) {
  if (d.card?.shipping) void setShipping(d.card.shipping, 'settle', el)
}

// --- link：候補を紐付ける／在庫を選ぶ（シート）／私物にする ---
async function linkCandidate(d: DisplayItem, ev: MouseEvent) {
  const item = d.card?.link
  const cand = item?.candidate
  if (!item || !item.sale || !cand) return
  const sale = item.sale
  const size = measure(ev.currentTarget as Element | null)
  try {
    await withBusy(item.id, async () => {
      await window.soroban.linkInventory(sale.id, [cand.inventory_item_id])
      toast(`${cand.item_code} を紐付けました`, 'ok')
      // 読み直すと紐付けの部分は消える。読み直しの前に「済」に替えておく（送料と同じ）
      beginHold('link', item, `${cand.item_code} を紐付け`, size)
    })
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
    await load()
  } finally {
    endReload(holdKey('link', item.id))
  }
}

// 「在庫を選ぶ」：売上へ飛ばさず、ホームの上で紐付けシートを開く。閉じたらホームのまま
const allocSale = ref<SaleProfit | null>(null)
function openAllocate(item: InboxItem) {
  if (item.sale) allocSale.value = item.sale
}
// シートで紐付けた（外した）あと。読み直して上のバーの数字を更新する。紐付けが片付いたら、その部分を「済」で残してから畳む
async function onAllocateChanged() {
  const sale = allocSale.value
  const link = sale ? displayGroups.value.find(g => g.kind === 'settle')?.items.find(x => x.key === sale.id)?.card?.link ?? null : null
  const index = sale ? displayIndex(sale.id) : 0
  const size = measure(sale ? document.querySelector(`.inbox-row[data-sale="${sale.id}"] .part-link`) : null)
  await load()
  changed()
  if (link && !inbox.value?.groups.find(g => g.kind === 'link')?.items.some(i => i.id === link.id)) {
    beginHold('link', link, '在庫を紐付け', size, index)
    endReload(holdKey('link', link.id))
  }
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
            <span class="done-today faint"><Icon name="check" :size="12" />今日片付けたもの {{ inbox.done_today }} 件</span>
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
                  v-for="d in group.items"
                  :key="d.key"
                  class="slot"
                  :class="{ collapsing: !!d.card?.collapsing && !group.collapsing }"
                  :style="cardStyle(d)"
                >
                  <div class="slot-in">
                    <div class="inbox-row" :class="{ settle: !!d.card, held: cardDone(d) }" :data-sale="d.card ? d.key : undefined">
                      <div class="row-thumb">
                        <img
                          v-if="showThumb(d.item)"
                          class="row-thumb-img"
                          :src="d.item.thumb_url!"
                          alt=""
                          loading="lazy"
                          @error="onThumbError(d.item.id)"
                        />
                        <span v-else class="row-thumb-ph" :class="{ warn: group.kind === 'collect' }">
                          {{ group.kind === 'collect' ? '!' : placeholderChar(d.item.title) }}
                        </span>
                      </div>

                      <div class="row-main">
                        <div class="row-labels">
                          <StatusChip v-if="d.item.sale" tone="neutral" :label="CHANNEL_LABEL[d.item.sale.channel]" :title="`出品先：${CHANNEL_LABEL[d.item.sale.channel]}`" />
                          <StatusChip v-if="d.item.release" tone="neutral" :label="CHANNEL_LABEL[d.item.release.listing_channel]" :title="`出品先：${CHANNEL_LABEL[d.item.release.listing_channel]}`" />
                          <StatusPill v-if="group.kind === 'ship'" tone="solid-info" label="発送してください" />
                          <StatusPill v-if="group.kind === 'release'" tone="solid-warn" label="出品停止中" />
                          <StatusChip v-if="group.kind === 'confirm' && d.item.purchase" tone="neutral" :label="d.item.purchase.shop_account_name" />
                        </div>
                        <div class="row-title one-line" :title="d.item.title">{{ d.item.title }}</div>
                        <!-- 「済」だけが残ったカード：補足と粗利の見込みは、片付ける前の言い方のままなので出さない（高さだけ残す） -->
                        <div v-if="cardDone(d)" class="row-sub" aria-hidden="true">&nbsp;</div>
                        <div v-else-if="d.item.release" class="row-sub two-lines" :title="`押さえている在庫（${d.item.release.items.length} 点）：${releaseHeldText(d.item)}`">
                          <b>押さえている在庫 {{ d.item.release.items.length }} 点：</b>{{ releaseHeldText(d.item) }}
                        </div>
                        <div v-else class="row-sub">
                          <span class="dim">{{ d.item.detail }}</span>
                          <b v-if="rowHint(group.kind, d)" class="profit-hint" :class="rowHint(group.kind, d)?.cls">
                            ・ {{ rowHint(group.kind, d)?.text }}
                          </b>
                          <!-- スマホ幅だけ：区切りの「・」なしで、自分の行に出す（デスクトップ幅では出さない。上の文は一切変えない） -->
                          <b v-if="rowHint(group.kind, d)" class="profit-hint-m" :class="rowHint(group.kind, d)?.cls">{{ rowHint(group.kind, d)?.text }}</b>
                        </div>
                      </div>

                      <!-- 売上を確定する：1 販売＝1 カード。残っている作業（送料・在庫）を下に積む。片付いた部分は「済」で残してから畳む -->
                      <div v-if="d.card" class="row-parts">
                        <!-- 送料：セレクトを選べば「済」に替わり、1.2 秒後に畳まれる -->
                        <div
                          v-if="d.card.shipping || d.card.shipHold"
                          class="slot"
                          :class="{ collapsing: !!d.card.shipHold?.collapsing && !d.card.collapsing && !group.collapsing }"
                          :style="holdStyle(d.card.shipHold)"
                        >
                          <div class="slot-in">
                            <div class="part part-shipping">
                              <span v-if="d.card.shipHold" class="held-done"><Icon name="check" :size="14" class="held-check" />済　{{ d.card.shipHold.label }}</span>
                              <select
                                v-else
                                class="invalid"
                                :disabled="busy.has(d.key)"
                                @change="setCardShipping(d, $event.target as HTMLSelectElement)"
                              >
                                <option value="">送料：発送方法を選ぶ…</option>
                                <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}　{{ yen(m.fee) }}</option>
                              </select>
                            </div>
                          </div>
                        </div>

                        <!-- 在庫：候補があれば 1 タップ（何を紐付けるか・粗利まで見せる）。「在庫を選ぶ」はホームの上でシートを開く -->
                        <div
                          v-if="d.card.link || d.card.linkHold"
                          class="slot"
                          :class="{ collapsing: !!d.card.linkHold?.collapsing && !d.card.collapsing && !group.collapsing }"
                          :style="holdStyle(d.card.linkHold)"
                        >
                          <div class="slot-in">
                            <div class="part part-link">
                              <span v-if="d.card.linkHold" class="held-done"><Icon name="check" :size="14" class="held-check" />済　{{ d.card.linkHold.label }}</span>
                              <template v-else-if="d.card.link">
                                <template v-if="d.card.link.candidate">
                                  <button
                                    class="link-btn cand-btn"
                                    :disabled="busy.has(d.key)"
                                    :title="candidateTitle(d.card.link)"
                                    @click="linkCandidate(d, $event)"
                                  >
                                    <span class="cand-line">
                                      <span class="cand-what"><b>{{ d.card.link.candidate.item_code }}</b> {{ d.card.link.candidate.name }}</span><span class="cand-meta">{{ candidateMeta(d.card.link.candidate) }}を紐付ける</span>
                                    </span>
                                    <span v-if="candidateProfit(d.card.link)" class="cand-profit" :class="candidateProfit(d.card.link)?.cls">{{ candidateProfit(d.card.link)?.text }}</span>
                                  </button>
                                  <div class="part-actions secondary">
                                    <button class="sm" :disabled="busy.has(d.key)" @click="openAllocate(d.item)">在庫を選ぶ</button>
                                  </div>
                                </template>
                                <div v-else class="part-actions">
                                  <button class="sm link-btn" :disabled="busy.has(d.key)" @click="openAllocate(d.item)"><Icon name="link" :size="14" /> 在庫を選ぶ</button>
                                  <button class="link-action" :disabled="busy.has(d.key)" @click="markPersonal(d.item)">私物にする</button>
                                </div>
                              </template>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div v-else class="row-act">
                        <!-- 発送する：発送方法が未定ならセレクトを出す -->
                        <template v-if="group.kind === 'ship'">
                          <select
                            v-if="!d.item.sale?.shipping_method_id"
                            class="invalid"
                            :disabled="busy.has(d.key)"
                            @change="setShipping(d.item, 'ship', $event.target as HTMLSelectElement)"
                          >
                            <option value="">選択…</option>
                            <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}　{{ yen(m.fee) }}</option>
                          </select>
                          <button class="sm" :disabled="busy.has(d.key)" @click="openTransaction(d.item)">
                            取引画面を開く <Icon name="external" :size="12" />
                          </button>
                        </template>

                        <!-- 仕入の価格を入れる -->
                        <template v-else-if="group.kind === 'confirm'">
                          <button class="sm" @click="goConfirmPurchase(d.item)">価格を入れて確定</button>
                        </template>

                        <!-- 取り込みの問題 -->
                        <template v-else-if="group.kind === 'collect'">
                          <!-- Web 版：押しても開けるウィンドウが無いので、ボタンは出さず、やることを文で伝える -->
                          <span v-if="isWeb && d.item.run?.status === 'auth_required'" class="web-hint" title="取り込み担当の PC のそろばんでログインしてください"><span>取り込み担当の PC の</span><span>そろばんでログインしてください</span></span>
                          <button
                            v-else-if="d.item.run?.status === 'auth_required'"
                            class="sm"
                            title="ログインのウィンドウが開きます。ログインしたら閉じて「取り込む」を押してください"
                            @click="openLoginForRun"
                          >ログインする</button>
                          <button v-else class="sm" :disabled="busy.has(d.key)" @click="retryCollect(d.item)">もう一度取り込む</button>
                          <span v-if="!isWeb && d.item.run?.status === 'auth_required'" class="m-hint">ログインのウィンドウが開きます。ログインしたら閉じて「取り込む」を押してください</span>
                        </template>

                        <!-- 止めた出品の在庫を外す：1 クリックで全部。押した行はその場で消える -->
                        <template v-else-if="group.kind === 'release'">
                          <button
                            class="sm"
                            :disabled="busy.has(d.key)"
                            title="出品から在庫を外すだけです。在庫も販売の記録も消えません。"
                            @click="releaseListing(d.item)"
                          >{{ releaseButtonLabel(d.item) }}</button>
                          <span class="m-hint">出品から在庫を外すだけです。在庫も販売の記録も消えません。</span>
                        </template>

                        <!-- 忘れていませんか -->
                        <template v-else-if="group.kind === 'reminder'">
                          <button
                            v-if="d.item.reminder"
                            class="sm"
                            :disabled="busy.has(d.key)"
                            @click="reminderAction(d.item)"
                          >{{ d.item.reminder.action_label }}</button>
                          <button class="link-action" :disabled="busy.has(d.key)" @click="snooze(d.item)">今はいい</button>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

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

    <!-- 「在庫を選ぶ」：売上へ飛ばさず、ここで開く。閉じたらホームのまま -->
    <AllocateDrawer
      :open="!!allocSale"
      mode="sale"
      :sale="allocSale"
      @close="allocSale = null"
      @changed="onAllocateChanged"
    />
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
/* 今日片付けた件数。見出しの横に小さく（デスクトップ幅では右端） */
.done-today {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-12);
  white-space: nowrap;
}

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

/* --- 売上を確定する（1 販売＝1 カード）---
   操作（送料・在庫）は名前と補足の下に、名前の左端にそろえて積む。部分ごとに畳めるよう .slot で包み、
   部分どうしの間隔は部分の上の padding で持つ（畳んだとき間隔だけが残らない） */
.inbox-row.settle { row-gap: 0; align-content: start; }
.inbox-row.settle .row-main { grid-column: 2 / -1; }
.row-parts { grid-column: 2 / -1; min-width: 0; }
.part {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding-top: 8px;
  min-width: 0;
}
.part select { max-width: 260px; }
.part-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* 1 タップ紐付けのボタン。全幅・2 行：1 行目「<在庫コード> <商品名>（原価・仕入から○日）を紐付ける」、2 行目「→ 粗利 ¥y」。
   商品名だけが長いときに省略する（原価・日数・「を紐付ける」は切らない）。幅が足りなければ（スマホ）名前の下へ回す。全文は title */
.cand-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  height: auto;
  min-height: 44px;
  padding: 8px 18px;
  text-align: left;
  line-height: 1.4;
  font-size: var(--fs-13);
  border-radius: var(--radius-md); /* 2〜3 行になるので、ピルだと端が丸まりすぎる */
}
.cand-line { display: flex; flex-wrap: wrap; max-width: 100%; min-width: 0; }
.cand-what {
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(100%, 26em);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cand-meta { flex: 0 0 auto; white-space: nowrap; }
/* 色は .profit / .loss（style.css）。利益＝緑・損失＝赤 */
.cand-profit { font-weight: 700; }

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

.foot { margin: 14px 0 0; font-size: var(--fs-12); }

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
  /* 1 行目：見出しと今日片付けた件数（右）、2 行目：残りの件数と案内 */
  .inbox-head .done-today { order: 1; }
  .inbox-head > .dim { order: 2; flex: 1 1 100%; }

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
  .part > .held-done { flex: 0 0 auto; }

  /* 売上を確定するカードの操作：全幅・44px 以上 */
  .row-parts { grid-column: 1 / -1; }
  .part select { max-width: none; width: 100%; height: 44px; }
  .part-actions { width: 100%; }
  .part-actions > button {
    flex: 1 1 140px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 44px;
    font-size: var(--fs-14);
  }
  /* 候補ボタンの下の「在庫を選ぶ」は副。全幅にせず、指で押せる 44px だけ確保する */
  .part-actions.secondary > button { flex: 0 0 auto; padding: 0 20px; }
  .part-actions > button.link-action {
    flex: 0 0 auto;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--fs-13);
    text-decoration: none;
  }
  .cand-btn { min-height: 48px; padding: 8px 16px; }
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
