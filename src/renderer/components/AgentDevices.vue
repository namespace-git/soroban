<script setup lang="ts">
// 設定の「取り込み担当の PC」の節（Web 版だけ。Settings.vue が isWeb のときに出す）。
// Web 版の「取り込む」は、ここに並ぶ PC のそろばんが拾って取り込む。一覧（名前・最後に動いた時刻・動いているか）と、取り消し。
import { ref, onMounted, inject } from 'vue'
import type { AgentDevice } from '../../shared/web-types'
import Icon from './Icon.vue'
import StatusChip from './StatusChip.vue'
import { errorText } from './cash-util'
import { dateTime, sinceText } from '../format'

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const web = window.sorobanWeb!

const devices = ref<AgentDevice[]>([])
const loaded = ref(false)
const busyId = ref<string | null>(null)

async function load() {
  try {
    devices.value = await web.listAgentDevices()
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    loaded.value = true
  }
}
onMounted(load)

async function revoke(d: AgentDevice) {
  if (busyId.value) return
  if (!await confirmDialog(`「${d.name}」を取り込み担当から外しますか？`, {
    message: 'この PC は、以後取り込みを受け付けなくなります。',
    okLabel: '外す',
    danger: true,
  })) return
  busyId.value = d.id
  try {
    await web.revokeAgentDevice(d.id)
    toast(`「${d.name}」を外しました`, 'ok')
    await load()
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="panel">
    <div class="section-head">
      <span class="section-head-icon"><Icon name="refresh" :size="16" /></span>
      <h2 class="section-head-title">取り込み担当の PC</h2>
    </div>
    <p class="faint hint first">
      「取り込む」を押すと、ここに並ぶ PC のそろばんが拾ってメルカリ・Yahoo!フリマ・メロジョイを取り込みます。
    </p>

    <ul v-if="devices.length" class="agent-list">
      <li v-for="d in devices" :key="d.id" class="agent" :class="{ revoked: d.revoked }">
        <div class="agent-main">
          <div class="agent-labels">
            <StatusChip v-if="d.revoked" tone="neutral" label="外した" />
            <StatusChip v-else-if="d.online" tone="ok" label="動いている" />
            <StatusChip v-else tone="warn" label="止まっている" />
          </div>
          <div class="agent-name" :title="d.name">{{ d.name }}</div>
          <div class="agent-sub">最後に動いた：{{ dateTime(d.last_seen_at) }}（{{ sinceText(d.last_seen_at) }}）</div>
        </div>
        <button v-if="!d.revoked" class="ghost sm agent-revoke" :disabled="busyId !== null" @click="revoke(d)">外す</button>
      </li>
    </ul>
    <p v-else-if="loaded" class="faint hint">
      PC のそろばんで「取り込み担当になる」を押すと、ここに出ます。
    </p>
  </div>
</template>

<style scoped>
.hint { margin: 10px 0 0; font-size: var(--fs-12); }
.hint.first { margin-top: 0; }

.agent-list { list-style: none; margin: 12px 0 0; padding: 0; }
.agent {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--line-soft);
}
.agent:first-child { border-top: 0; }
.agent.revoked { opacity: .6; }
.agent-main { flex: 1; min-width: 0; }
.agent-labels { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 22px; margin-bottom: 4px; }
.agent-name {
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-sub { margin-top: 2px; font-size: var(--fs-13); color: var(--text-dim); overflow-wrap: anywhere; }
.agent-revoke { flex-shrink: 0; }

/* スマホ幅（768px 未満）：ボタンは 44px 以上。768px 以上には一切効かせない */
@media (max-width: 767px) {
  .agent-revoke { min-height: 44px; border-color: var(--line); }
}
</style>
