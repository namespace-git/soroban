<script setup lang="ts">
// 売上タブの上部：直近12か月のグラフ（開閉カード）。
// 「今月の粗利」はトップバーのピル（App.vue）と重複するため、ここには置かない。
// 「出品中」「売れた・要入力」は Sales.vue の進捗ストリップ（StageStrip、getSalesProgress）が
// 同じ数字をより詳しく出すため、ここでは重複させない（同じことをする表示を2つ作らない）。
// 合計は既存データを足すだけ（利益の再計算はしない）。
//
// グラフは本来 MiniChart.vue を流用する予定だったが、MiniChart.vue はこのタスクでは
// 読み取り専用（他エージェントの担当範囲外の可能性があるファイル）として指定されたため、
// 系列を増やす改修を加えられなかった。売上（棒）・粗利（線）・純利益（線）は負値になり得るため
// 0 を中心にした独自の簡易 SVG で描画している（親セッションへの申し送り事項）。
// 積み上げ（仕入先・タグごと）は MonthlySummary に内訳が無いため、従来どおり単色のまま
// （無理に変えない。データが増えたら本来の積み上げに直せる）。
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { MonthlySummary, SaleKind } from '../../shared/types'
import { thisMonthLocal } from '../../shared/date'
import Icon from './Icon.vue'
import Skeleton from './Skeleton.vue'

const revision = inject<Ref<number>>('revision')!
// 売上タブ内で引き当て・送料・紐付けを変えた直後にも数字を更新する
const dataRevision = inject<Ref<number>>('dataRevision', ref(0))
const goto = inject<(t: string, payload?: { stage?: 'all'; month?: string }) => void>('goto')!

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const monthly = ref<MonthlySummary[]>([])
const loaded = ref(false)

async function load() {
  monthly.value = await window.soroban.listMonthly()
  loaded.value = true
}
onMounted(load)
watch([revision, dataRevision], load)

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
  forecastRevenue: number
  forecastProfit: number
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
      forecastRevenue: row?.forecast?.revenue ?? 0,
      forecastProfit: row?.forecast?.gross_profit ?? 0,
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
  Math.max(1, ...chartPoints.value.flatMap(p => [p.revenue, p.grossProfit, p.netProfit, p.revenue + p.forecastRevenue, p.grossProfit + p.forecastProfit, p.netProfit + p.forecastProfit])),
)
const domainMin = computed(() =>
  Math.min(0, ...chartPoints.value.flatMap(p => [p.grossProfit, p.netProfit, p.grossProfit + p.forecastProfit, p.netProfit + p.forecastProfit])),
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
const forecastGrossLine = computed(() => chartPoints.value.map((p, i) => `${x(i)},${valueToY(p.grossProfit + p.forecastProfit)}`).join(' '))
const forecastNetLine = computed(() => chartPoints.value.map((p, i) => `${x(i)},${valueToY(p.netProfit + p.forecastProfit)}`).join(' '))

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

      <Skeleton v-if="!loaded" kind="table" :rows="3" />

      <div v-else-if="showChart" class="chart-wrap">
        <svg :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="xMidYMid meet" @mouseleave="onLeaveChart">
          <line v-for="gl in gridLines" :key="gl.y" :x1="PAD_L" :y1="gl.y" :x2="W - PAD_R" :y2="gl.y" class="grid" />
          <text v-for="gl in gridLines" :key="'gl' + gl.y" :x="PAD_L - 6" :y="gl.y + 3" class="grid-label">{{ gl.label }}</text>

          <line
            v-if="hoverIndex !== null"
            class="guide-line"
            :x1="x(hoverIndex)" :y1="PAD_T" :x2="x(hoverIndex)" :y2="PAD_T + plotH"
          />

          <g v-for="(p, i) in chartPoints" :key="p.month">
            <rect :x="x(i) - barW / 2" :y="barRectY(p.revenue + p.forecastRevenue)"
              :width="barW" :height="barRectH(p.revenue + p.forecastRevenue)" class="bar-revenue forecast" />
            <rect
              :x="x(i) - barW / 2" :y="barRectY(p.revenue)"
              :width="barW" :height="barRectH(p.revenue)"
              class="bar-revenue" :class="{ hover: hoverIndex === i }"
            />
            <text :x="x(i)" :y="H - 3" class="axis-label">{{ monthLabel(p.month, i) }}</text>
          </g>

          <polyline :points="forecastGrossLine" class="line-gross forecast" stroke-dasharray="5 4" />
          <polyline :points="forecastNetLine" class="line-net forecast" stroke-dasharray="5 4" />
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
          <div class="chart-tooltip-row">見込み分：売上 {{ yen(tooltip.p.forecastRevenue) }} ・ 粗利 {{ yen(tooltip.p.forecastProfit) }}</div>
          <div class="chart-tooltip-row">売上 {{ yen(tooltip.p.revenue) }}</div>
          <div class="chart-tooltip-row" :class="tooltip.p.grossProfit < 0 ? 'loss' : 'profit'">粗利 {{ yen(tooltip.p.grossProfit) }}</div>
          <div class="chart-tooltip-row">件数 {{ tooltip.p.salesCount }} 件</div>
          <div class="chart-tooltip-row" :class="tooltip.p.netProfit < 0 ? 'loss' : 'profit'">純利益 {{ yen(tooltip.p.netProfit) }}</div>
        </div>
      </div>
      <p v-if="loaded && showChart" class="chart-hint">濃色：実績（取引完了・状態未設定の手入力） ／ 淡色・破線：見込みを含む合計。月をクリックすると販売を表示します</p>
    </div>
  </div>
</template>

<style scoped>
.forecast { opacity: .3; }
.sales-summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 20px;
}

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
</style>
