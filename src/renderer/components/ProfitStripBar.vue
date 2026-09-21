<script setup lang="ts">
// ホーム上部の利益ストリップ。トップバーでは compact（1つのピル）で使う。
// 数字はすべて main が計算した ProfitStrip をそのまま出すだけ（ここで再計算しない）。
import type { ProfitStrip } from '../../shared/types'

defineProps<{ strip: ProfitStrip | null; compact?: boolean }>()

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')
</script>

<template>
  <div class="profit-strip-bar">
    <span v-if="compact" class="profit-mini">
      今月の粗利 {{ yen(strip?.gross_profit ?? 0) }} ／ 純利益 {{ yen(strip?.net_profit ?? 0) }}
    </span>

    <div v-else class="profit-strip">
      <div class="p main">
        <span class="p-label">今月の粗利</span>
        <span class="p-value">{{ yen(strip?.gross_profit ?? 0) }}</span>
        <span class="p-sub">
          売上 {{ yen(strip?.revenue ?? 0) }} ・ {{ strip?.sales_count ?? 0 }} 件 ・ 純利益 {{ yen(strip?.net_profit ?? 0) }}
        </span>
      </div>
      <div class="p">
        <span class="p-label">確定待ちの粗利（見込み）</span>
        <span class="p-value dim">{{ yen(strip?.pending_profit_estimate ?? 0) }}</span>
        <span class="p-sub">送料・紐付け待ち {{ strip?.pending_count ?? 0 }} 件。入れると確定します</span>
      </div>
      <div class="p">
        <span class="p-label">売上金の反映待ち</span>
        <span class="p-value dim">{{ yen(strip?.awaiting_payout ?? 0) }}</span>
        <span class="p-sub">発送済み・受取評価待ち {{ strip?.awaiting_payout_count ?? 0 }} 件</span>
      </div>
      <div class="p">
        <span class="p-label">先月の純利益</span>
        <span class="p-value dim">{{ strip?.last_month ? yen(strip.last_month.net_profit) : '—' }}</span>
        <span class="p-sub">{{ strip?.last_month ? (strip.last_month.closed ? '締め済み' : '未締め') : '実績なし' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* compact（トップバーのピル）の見た目は style.css の .topbar .profit-mini にまとめてある */

.profit-strip {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 1fr;
  gap: 12px;
}
.p {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 18px;
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-1);
}
.p.main {
  background: var(--brand);
  box-shadow: none;
}
.p-label {
  font-size: var(--fs-12);
  font-weight: 700;
  color: var(--text-dim);
}
.p.main .p-label { color: var(--text); }
.p-value {
  font-size: var(--fs-28);
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.p-value.dim { font-size: var(--fs-20); }
.p-sub {
  font-size: var(--fs-12);
  color: var(--text-dim);
}
.p.main .p-sub { color: var(--brand-ink); }

@media (max-width: 1099px) {
  .profit-strip { grid-template-columns: 1fr 1fr; }
}
</style>
