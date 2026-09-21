<script setup lang="ts">
import { computed } from 'vue'

export type IconName =
  | 'home' | 'sales' | 'purchase' | 'inventory' | 'monthly' | 'settings'
  | 'plus' | 'close' | 'trash' | 'link' | 'unlink' | 'check' | 'alert'
  | 'search' | 'arrow-right' | 'refresh' | 'login' | 'external' | 'folder' | 'download' | 'note'
  | 'product' | 'history' | 'listing' | 'help' | 'receipt'
  | 'inbox' | 'truck' | 'sparkle' | 'check-circle' | 'clock'

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), {
  size: 20,
})

// authored SVG（1系統のストローク）。外部アイコンライブラリは使わない。
const paths: Record<IconName, string> = {
  home: `
    <path d="M4 10 L10 4 L16 10" />
    <path d="M6 9 V16 H14 V9" />
    <path d="M8.5 16 V12 H11.5 V16" />
  `,
  sales: `
    <polyline points="4,14 8,9.5 11,12.5 16,6" />
    <polyline points="12,6 16,6 16,10" />
  `,
  purchase: `
    <path d="M8 7 V5 A2 2 0 0 1 12 5 V7" />
    <path d="M6 7 H14 L13 16 H7 Z" />
  `,
  inventory: `
    <path d="M10 3 L17 6.5 V13.5 L10 17 L3 13.5 V6.5 Z" />
    <path d="M3 6.5 L10 10 L17 6.5" />
    <line x1="10" y1="10" x2="10" y2="17" />
  `,
  monthly: `
    <rect x="3" y="4" width="14" height="13" rx="2" />
    <line x1="3" y1="8" x2="17" y2="8" />
    <line x1="7" y1="2.5" x2="7" y2="5.5" />
    <line x1="13" y1="2.5" x2="13" y2="5.5" />
  `,
  settings: `
    <circle cx="10" cy="10" r="3" />
    <line x1="10" y1="2.3" x2="10" y2="4.8" />
    <line x1="10" y1="15.2" x2="10" y2="17.7" />
    <line x1="2.3" y1="10" x2="4.8" y2="10" />
    <line x1="15.2" y1="10" x2="17.7" y2="10" />
    <line x1="4.9" y1="4.9" x2="6.6" y2="6.6" />
    <line x1="13.4" y1="13.4" x2="15.1" y2="15.1" />
    <line x1="4.9" y1="15.1" x2="6.6" y2="13.4" />
    <line x1="13.4" y1="6.6" x2="15.1" y2="4.9" />
  `,
  plus: `
    <line x1="10" y1="4" x2="10" y2="16" />
    <line x1="4" y1="10" x2="16" y2="10" />
  `,
  close: `
    <line x1="5" y1="5" x2="15" y2="15" />
    <line x1="15" y1="5" x2="5" y2="15" />
  `,
  trash: `
    <path d="M4 6 H16" />
    <path d="M7.5 6 V4 H12.5 V6" />
    <path d="M6 6 L6.8 17 H13.2 L14 6" />
    <line x1="10" y1="9" x2="10" y2="14" />
  `,
  link: `
    <rect x="2" y="7" width="8" height="6" rx="3" />
    <rect x="10" y="7" width="8" height="6" rx="3" />
  `,
  unlink: `
    <rect x="2" y="7" width="6" height="6" rx="3" />
    <rect x="12" y="7" width="6" height="6" rx="3" />
    <line x1="4" y1="4" x2="16" y2="16" />
  `,
  check: `
    <polyline points="4,10 8,14 16,5" />
  `,
  alert: `
    <path d="M10 3 L18 17 H2 Z" />
    <line x1="10" y1="8" x2="10" y2="12" />
    <line x1="10" y1="14.4" x2="10" y2="14.5" />
  `,
  search: `
    <circle cx="8.5" cy="8.5" r="5" />
    <line x1="12.5" y1="12.5" x2="17" y2="17" />
  `,
  'arrow-right': `
    <line x1="3" y1="10" x2="15" y2="10" />
    <polyline points="11,6 15,10 11,14" />
  `,
  refresh: `
    <path d="M4 10a6 6 0 0 1 10.5-4" />
    <polyline points="14.5,2 14.5,6 10.5,6" />
    <path d="M16 10a6 6 0 0 1-10.5 4" />
    <polyline points="5.5,18 5.5,14 9.5,14" />
  `,
  login: `
    <path d="M9 4 H5 A1 1 0 0 0 4 5 V15 A1 1 0 0 0 5 16 H9" />
    <line x1="8" y1="10" x2="17" y2="10" />
    <polyline points="13,6 17,10 13,14" />
  `,
  external: `
    <path d="M8 4 H4 V16 H16 V12" />
    <line x1="9" y1="11" x2="16" y2="4" />
    <polyline points="11,4 16,4 16,9" />
  `,
  folder: `
    <path d="M3 6 H8 L10 8 H17 V16 H3 Z" />
  `,
  download: `
    <path d="M10 3 V13" />
    <polyline points="6,9 10,13 14,9" />
    <path d="M4 16 H16" />
  `,
  note: `
    <path d="M5 3 H12 L15 6 V17 H5 Z" />
    <path d="M12 3 V6 H15" />
    <line x1="7.5" y1="10" x2="12.5" y2="10" />
    <line x1="7.5" y1="13" x2="11.5" y2="13" />
  `,
  product: `
    <path d="M11 3 H16 A1 1 0 0 1 17 4 V9 L9.5 16.5 A1.4 1.4 0 0 1 7.5 16.5 L3.5 12.5 A1.4 1.4 0 0 1 3.5 10.5 L11 3 Z" />
    <circle cx="13.3" cy="6.7" r="1.3" />
  `,
  history: `
    <circle cx="10" cy="10.5" r="6.5" />
    <polyline points="10,7 10,10.5 13,12.5" />
    <path d="M6 3.5 L8.3 3.5" />
  `,
  listing: `
    <path d="M9 6.5 H14 A1 1 0 0 1 15 7.5 V11 L9.3 17 A1 1 0 0 1 7.6 17 L4.5 13.8 A1 1 0 0 1 4.5 12.1 L9 6.5 Z" />
    <circle cx="11.5" cy="9.7" r="1" />
    <path d="M11.5 5.5 V2" />
    <polyline points="10,3.5 11.5,1.8 13,3.5" />
  `,
  help: `
    <circle cx="10" cy="10" r="7" />
    <path d="M7.5 8.2 A2.5 2.5 0 1 1 10.5 12 C9.9 12.4 9.6 12.9 9.6 13.5" />
    <line x1="9.6" y1="15.6" x2="9.6" y2="15.7" />
  `,
  receipt: `
    <path d="M5 3 H15 V17 L13 15.3 L11 17 L9 15.3 L7 17 L5 15.3 Z" />
    <line x1="7.5" y1="7" x2="12.5" y2="7" />
    <line x1="7.5" y1="10" x2="12.5" y2="10" />
    <line x1="7.5" y1="13" x2="10.5" y2="13" />
  `,
  inbox: `
    <path d="M3 10 H7 L8.5 12.5 H11.5 L13 10 H17" />
    <path d="M3 10 V16 A1 1 0 0 0 4 17 H16 A1 1 0 0 0 17 16 V10" />
    <path d="M3 10 L5.3 4 H14.7 L17 10" />
  `,
  truck: `
    <path d="M3 6 H12 V14 H3 Z" />
    <path d="M12 9 H15.3 L17 11.2 V14 H12" />
    <circle cx="6.2" cy="15.5" r="1.5" />
    <circle cx="14.3" cy="15.5" r="1.5" />
  `,
  sparkle: `
    <path d="M9.5 3 L10.8 8 L15.8 9.3 L10.8 10.6 L9.5 15.6 L8.2 10.6 L3.2 9.3 L8.2 8 Z" />
    <path d="M15.8 3.2 L16.3 5 L18 5.5 L16.3 6 L15.8 7.8 L15.3 6 L13.6 5.5 L15.3 5 Z" />
  `,
  'check-circle': `
    <circle cx="10" cy="10" r="7" />
    <polyline points="7,10.2 9.2,12.5 13.3,7.7" />
  `,
  clock: `
    <circle cx="10" cy="10" r="7" />
    <polyline points="10,6 10,10.3 13,12" />
  `,
}

const markup = computed(() => paths[props.name] ?? '')
</script>

<template>
  <svg
    :width="size" :height="size"
    viewBox="0 0 20 20" fill="none"
    stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"
    v-html="markup"
  />
</template>
