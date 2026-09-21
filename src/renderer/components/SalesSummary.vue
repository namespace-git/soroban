<script setup lang="ts">
// 売上タブの上部：サマリの stat-card 3枚 と、直近12か月のグラフ。
// 合計は既存データを足すだけ（利益の再計算はしない）。
//
// グラフは本来 MiniChart.vue を流用する予定だったが、MiniChart.vue はこのタスクでは
// 読み取り専用（他エージェントの担当範囲外の可能性があるファイル）として指定されたため、
// 系列を増やす改修を加えられなかった。売上（棒）・粗利（線）・純利益（線）は負値になり得るため
// 0 を中心にした独自の簡易 SVG で描画している（親セッションへの申し送り事項）。
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { MonthlySummary, Listing, SaleProfit, SaleKind } from '../../shared/types'
import { thisMonthLocal } from '../../shared/date'
import Icon from './Icon.vue'
import Skeleton from './Skeleton.vue'

const revision = inject<Ref<number>>('revision')!
const goto = inject<(t: string, payload?: { stage?: 'listed' | 'pending' | 'done' | 'all'; month?: string }) => void>('goto')!

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const monthly = ref<MonthlySummary[]>([])
const listings = ref<Listing[]>([])
const pending = ref<SaleProfit[]>([])
const loaded = ref(false)

async function load() {
  const [m, l, p] = await Promise.all([
    window.soroban.listMonthly(),
    window.soroban.listListings({ status: ['active', 'suspended'] }),
    window.soroban.listSales({ onlyPending: true }),
  ])
  monthly.value = m
  listings.value = l
  pending.value = p
  loaded.value = true
}
onMounted(load)
watch(revision, load)

// --- 今月の粗利（転売のみ。ホームの主要指標と同じ考え方） ---
const thisMonthSummary = computed(() =>
  monthly.value.find(m => m.month === thisMonthLocal() && m.kind === 'resale') ?? null,
)

// --- 出品中 ---
const listingProfitSum = computed(() =>
  listings.value.reduce((s, l) => s + (l.expected_profit ?? 0), 0),
)

// --- 未処理 ---
const pendingShippingCount = computed(() => pending.value.filter(s => !s.is_shipping_confirmed).length)
const pendingUnmatchedCount = computed(() =>
  pending.value.filter(s => s.kind === 'resale' && s.unmatched === 1).length,
)

// --- グラフ：直近12か月。売上（棒）＋粗利（線）＋純利益（線） ---
const chartKind = ref<SaleKind>('resale')

const SHOW_CHART_KEY = 'soroban.salesSummary.showChart'
const showChart = ref(true)
try {
  const saved = localStorage.getItem(SHOW_CHART_KEY)
  if (saved !== null) showChart.value = saved === '1'
} catch { /* localStorage が使えない環境では既定（表示）のまま */ }

function toggleChart() {
  showChart.value = !showChart.value
  try { localStorage.setItem(SHOW_CHART_KEY, showChart.value ? '1' : '0') } catch { /* noop */ }
}

/** 今月を含む直近 n か月（YYYY-MM、昇順） */
function lastMonths(n: number): string[] {
  const [y, m] = thisMonthLocal().split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

interface ChartPoint {
  month: string
  revenue: number
  grossProfit: number
  netProfit: number
  salesCount: number
}

const chartPoints = computed<ChartPoint[]>(() => {
  const months = lastMonths(12)
  const byMonth = new Map(monthly.value.filter(m => m.kind === chartKind.value).map(m => [m.month, m]))
  return months.map(month => {
    const row = byMonth.get(month)
    return {
      month,
      revenue: row?.revenue ?? 0,
      grossProfit: row?.gross_profit ?? 0,
      netProfit: row?.net_profit ?? 0,
      salesCount: row?.sales_count ?? 0,
    }
  })
})

// --- SVG ジオメトリ。0 を中央に置き、売上は上向きの棒、粗利／純利益は上下に振れる線。
//     viewBox の幅をパネルの実幅に近い値にしておくと、幅に応じた拡大率がほぼ1倍になり、
//     font-size や高さの指定値（px）がそのまま見た目の px に近くなる。
//     一覧を下に追いやらないよう、描画領域の高さは 150px 相当に抑える ---
const W = 1200, H = 150
const PAD_L = 48, PAD_R = 16, PAD_T = 14, PAD_B = 26
const plotW = W - PAD_L - PAD_R
const plotH = H - PAD_T - PAD_B
// 上限は最大値、下限は min(0, 最小値)。赤字の月が無ければ 0 が一番下に来て、描画領域を無駄にしない
const domainMax = computed(() =>
  Math.max(1, ...chartPoints.value.flatMap(p => [p.revenue, p.grossProfit, p.netProfit])),
)
const domainMin = computed(() =>
  Math.min(0, ...chartPoints.value.flatMap(p => [p.grossProfit, p.netProfit])),
)
const zeroY = computed(() => valueToY(0))

const groupW = computed(() => (chartPoints.value.length ? plotW / chartPoints.value.length : 0))
const barW = computed(() => Math.max(4, Math.min(18, groupW.value * 0.4)))

function x(i: number): number {
  return PAD_L + groupW.value * i + groupW.value / 2
}
function valueToY(v: number): number {
  const span = domainMax.value - domainMin.value || 1
  return PAD_T + plotH - ((v - domainMin.value) / span) * plotH
}
function barRectY(v: number): number {
  return v >= 0 ? valueToY(v) : zeroY.value
}
function barRectH(v: number): number {
  return Math.abs(valueToY(v) - zeroY.value)
}

const grossLine = computed(() => chartPoints.value.map((p, i) => `${x(i)},${valueToY(p.grossProfit)}`).join(' '))
const netLine = computed(() => chartPoints.value.map((p, i) => `${x(i)},${valueToY(p.netProfit)}`).join(' '))

function monthLabel(month: string, i: number): string {
  const [y, m] = month.split('-')
  const prevYear = i > 0 ? chartPoints.value[i - 1].month.split('-')[0] : null
  return i === 0 || prevYear !== y ? `${y}/${m}` : String(Number(m))
}

// --- ホバー：一番近い月を強調し、カスタムツールチップを出す。月ごとの縦の帯（透明 rect）で
//     ヒットを取るので、点そのものを狙わなくてよい。同じ帯をクリックにも使う ---
const hoverIndex = ref<number | null>(null)

function onEnterMonth(i: number) {
  hoverIndex.value = i
}
function onLeaveChart() {
  hoverIndex.value = null
}
function onClickMonth(i: number) {
  const p = chartPoints.value[i]
  if (!p) return
  goto('sales', { stage: 'all', month: p.month })
}

interface TooltipInfo {
  p: ChartPoint
  leftPct: number
  topPct: number
  align: 'left' | 'right'
}

const tooltip = computed<TooltipInfo | null>(() => {
  if (hoverIndex.value === null) return null
  const i = hoverIndex.value
  const p = chartPoints.value[i]
  if (!p) return null
  const topY = Math.min(valueToY(p.revenue), valueToY(p.grossProfit), valueToY(p.netProfit))
  return {
    p,
    leftPct: (x(i) / W) * 100,
    topPct: (topY / H) * 100,
    // 右端付近では吹き出しが見切れるので、点の左側に開く
    align: x(i) / W > 0.65 ? 'right' : 'left',
  }
})

/** y軸ラベル用の短い表記（¥12,345 → ¥12k） */
function formatShort(n: number): string {
  const sign = n < 0 ? '−' : ''
  const abs = Math.round(Math.abs(n))
  if (abs >= 1000) return `${sign}¥${Math.round(abs / 1000)}k`
  return `${sign}¥${abs}`
}

const gridLines = computed(() => domainMin.value < 0
  ? [
      { y: PAD_T, label: formatShort(domainMax.value) },
      { y: zeroY.value, label: '¥0' },
      { y: PAD_T + plotH, label: formatShort(domainMin.value) },
    ]
  : [
      { y: PAD_T, label: formatShort(domainMax.value) },
      { y: valueToY(domainMax.value / 2), label: formatShort(domainMax.value / 2) },
      { y: PAD_T + plotH, label: '¥0' },
])
</script>

<template>
  <div class="sales-summary">
    <Skeleton v-if="!loaded" kind="stats" />
    <div v-else class="stat-row">
      <div class="stat-card brand">
        <span class="stat-card-label">今月の粗利</span>
        <span class="stat-card-value">{{ yen(thisMonthSummary?.gross_profit ?? 0) }}</span>
        <span class="stat-card-sub">
          売上 {{ yen(thisMonthSummary?.revenue ?? 0) }} ・ 件数 {{ thisMonthSummary?.sales_count ?? 0 }} 件
          ・ 純利益 {{ yen(thisMonthSummary?.net_profit ?? 0) }}
        </span>
      </div>

      <div class="stat-card cream">
        <span class="stat-card-label">出品中</span>
        <span class="stat-card-value">{{ listings.length }}<span class="unit">件</span></span>
        <span class="stat-card-sub">見込み粗利の合計 {{ yen(listingProfitSum) }}</span>
        <span class="stat-card-sub">送料は決めた分だけ引いています</span>
      </div>

      <div class="stat-card cream">
        <span class="stat-card-label">売れた・要入力</span>
        <span class="stat-card-value">{{ pending.length }}<span class="unit">件</span></span>
        <span class="stat-card-sub">
          送料未入力 {{ pendingShippingCount }}・未紐付け {{ pendingUnmatchedCount }}
        </span>
      </div>
    </div>

    <div class="panel chart-panel">
      <div class="section-head">
        <span class="section-head-icon"><Icon name="sales" :size="16" /></span>
        <h2 class="section-head-title">直近12か月</h2>
        <span v-if="showChart" class="legend">
          <span class="legend-item"><span class="dot revenue" />売上</span>
          <span class="legend-item"><span class="dot gross" />粗利</span>
          <span class="legend-item"><span class="dot net" />純利益</span>
        </span>
        <span class="grow" />
        <select v-if="showChart" v-model="chartKind">
          <option value="resale">転売</option>
          <option value="personal">私物</option>
        </select>
        <button class="sm ghost" @click="toggleChart">{{ showChart ? 'グラフを隠す' : 'グラフを見せる' }}</button>
      </div>

      <div v-if="showChart" class="chart-wrap">
        <svg :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="xMidYMid meet" @mouseleave="onLeaveChart">
          <line v-for="gl in gridLines" :key="gl.y" :x1="PAD_L" :y1="gl.y" :x2="W - PAD_R" :y2="gl.y" class="grid" />
          <text v-for="gl in gridLines" :key="'gl' + gl.y" :x="PAD_L - 6" :y="gl.y + 3" class="grid-label">{{ gl.label }}</text>

          <line
            v-if="hoverIndex !== null"
            class="guide-line"
            :x1="x(hoverIndex)" :y1="PAD_T" :x2="x(hoverIndex)" :y2="PAD_T + plotH"
          />

          <g v-for="(p, i) in chartPoints" :key="p.month">
            <rect
              :x="x(i) - barW / 2" :y="barRectY(p.revenue)"
              :width="barW" :height="barRectH(p.revenue)"
              class="bar-revenue" :class="{ hover: hoverIndex === i }"
            />
            <text :x="x(i)" :y="H - 3" class="axis-label">{{ monthLabel(p.month, i) }}</text>
          </g>

          <polyline :points="grossLine" class="line-gross" />
          <circle
            v-for="(p, i) in chartPoints" :key="'g' + p.month"
            :cx="x(i)" :cy="valueToY(p.grossProfit)" :r="hoverIndex === i ? 4.5 : 2.5"
            class="dot-gross"
          />

          <polyline :points="netLine" class="line-net" />
          <circle
            v-for="(p, i) in chartPoints" :key="'n' + p.month"
            :cx="x(i)" :cy="valueToY(p.netProfit)" :r="hoverIndex === i ? 4.5 : 2.5"
            class="dot-net"
          />

          <!-- ヒット領域：月ごとの縦の帯。細い点を狙わなくてよいように、帯全体でホバー・クリックを拾う -->
          <rect
            v-for="(p, i) in chartPoints" :key="'hit' + p.month"
            :x="PAD_L + groupW * i" :y="PAD_T" :width="groupW" :height="plotH"
            class="hit-col"
            @mouseenter="onEnterMonth(i)"
            @mousemove="onEnterMonth(i)"
            @click="onClickMonth(i)"
          />
        </svg>

        <div
          v-if="tooltip"
          class="chart-tooltip"
          :class="tooltip.align"
          :style="{ left: tooltip.leftPct + '%', top: tooltip.topPct + '%' }"
        >
          <div class="chart-tooltip-month">{{ tooltip.p.month }}</div>
          <div class="chart-tooltip-row">売上 {{ yen(tooltip.p.revenue) }}</div>
          <div class="chart-tooltip-row" :class="tooltip.p.grossProfit < 0 ? 'loss' : 'profit'">粗利 {{ yen(tooltip.p.grossProfit) }}</div>
          <div class="chart-tooltip-row">件数 {{ tooltip.p.salesCount }} 件</div>
          <div class="chart-tooltip-row" :class="tooltip.p.netProfit < 0 ? 'loss' : 'profit'">純利益 {{ yen(tooltip.p.netProfit) }}</div>
        </div>
      </div>
      <p v-if="showChart" class="chart-hint">月をクリックすると、その月の販売を売上タブで表示します</p>
    </div>
  </div>
</template>

<style scoped>
.sales-summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 20px;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.stat-card { padding-top: 12px; padding-bottom: 12px; }
.stat-card-label { font-size: var(--fs-12); font-weight: 600; }
.stat-card.cream .stat-card-label { color: var(--brand-ink); }
.stat-card-value {
  font-size: var(--fs-36);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.stat-card.brand .stat-card-value { font-size: var(--fs-44); }
.stat-card-sub { font-size: var(--fs-12); color: var(--text-dim); }
.stat-card.brand .stat-card-sub { color: var(--text); opacity: .75; }
.unit { font-size: var(--fs-12); font-weight: 400; margin-left: 2px; }

.chart-panel .section-head select { margin-right: 4px; }

.legend {
  display: inline-flex;
  gap: 12px;
  font-size: var(--fs-12);
  color: var(--text-dim);
}
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
}
.legend .dot.revenue { background: var(--brand); }
.legend .dot.gross { background: var(--profit-solid); }
.legend .dot.net { background: var(--text); }

.chart-wrap {
  position: relative;
}
.chart {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 4px;
}
.grid { stroke: var(--line-soft); stroke-width: 1; }
.grid-label { font-size: 12px; fill: var(--text-faint); text-anchor: end; }
.bar-revenue { fill: var(--brand); transition: fill 100ms var(--ease); }
.bar-revenue.hover { fill: var(--primary); }
.axis-label { font-size: 12px; fill: var(--text-faint); text-anchor: middle; }
.line-gross { fill: none; stroke: var(--profit-solid); stroke-width: 1.5; }
.line-net { fill: none; stroke: var(--text); stroke-width: 1.5; stroke-dasharray: 3 2; }
.dot-gross { fill: var(--profit-solid); transition: r 100ms var(--ease); }
.dot-net { fill: var(--text); transition: r 100ms var(--ease); }
.guide-line { stroke: var(--text-faint); stroke-width: 1; stroke-dasharray: 2 2; }
.hit-col { fill: transparent; cursor: pointer; }

.chart-tooltip {
  position: absolute;
  z-index: 5;
  min-width: 140px;
  padding: 8px 10px;
  margin-top: -10px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-2);
  font-size: var(--fs-12);
  pointer-events: none;
  transition: left 100ms var(--ease), top 100ms var(--ease);
}
.chart-tooltip.left { transform: translate(0, -100%); }
.chart-tooltip.right { transform: translate(-100%, -100%); }
.chart-tooltip-month { font-weight: 700; margin-bottom: 2px; }
.chart-tooltip-row { color: var(--text-dim); white-space: nowrap; }
.chart-tooltip-row.profit { color: var(--profit); }
.chart-tooltip-row.loss { color: var(--loss); }

.chart-hint {
  margin: 4px 0 0;
  font-size: var(--fs-12);
  color: var(--text-faint);
}

@media (max-width: 1099px) {
  .stat-row { grid-template-columns: 1fr; }
}
</style>
