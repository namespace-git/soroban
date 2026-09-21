// 列見出しクリックでの並び替え。仕入タブ・在庫タブ・（次の波で）売上タブ・商品タブで共通に使う。
import { ref, type Ref } from 'vue'

export type SortDir = 'asc' | 'desc'

export function useSort<K extends string>(defaultKey: K | null, defaultDir: SortDir = 'desc') {
  const sortKey = ref(defaultKey) as Ref<K | null>
  const sortDir = ref<SortDir>(defaultDir)

  /** 同じ列なら向きを反転、別の列なら desc から */
  function toggle(key: K) {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortDir.value = 'desc'
    }
  }

  /** null/undefined は常に末尾。文字列は localeCompare('ja')。同値・未指定は元の順序を保つ（安定） */
  function sortRows<T>(rows: T[], get: (row: T, key: K) => string | number | null | undefined): T[] {
    const key = sortKey.value
    if (!key) return rows
    const dir = sortDir.value === 'asc' ? 1 : -1
    return rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const av = get(a.row, key)
        const bv = get(b.row, key)
        if (av == null && bv == null) return a.i - b.i
        if (av == null) return 1
        if (bv == null) return -1
        const cmp = typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv), 'ja')
          : av === bv ? 0 : av < bv ? -1 : 1
        return cmp !== 0 ? cmp * dir : a.i - b.i
      })
      .map(x => x.row)
  }

  return { sortKey, sortDir, toggle, sortRows }
}
