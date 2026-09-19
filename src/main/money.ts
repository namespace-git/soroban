// ============================================================
// 純粋な金額計算
//
// electron に依存しない。db.ts から呼ばれる。
// 金額は integer（円）のみを扱う。
// ============================================================

export interface LineForAlloc {
  id: string
  unit_price: number
  quantity: number
}

/**
 * 送料等（pool）を明細に配賦する。
 * 端数は最終行に寄せて、配賦総額が必ず pool と一致するようにする。
 *
 * 戻り値は allocated（明細に配賦された金額）のみ。
 * 明細内の各アイテムへのさらなる配分は splitEvenly で行う。
 */
export function allocate(
  lines: LineForAlloc[],
  pool: number,
  method: 'by_amount' | 'by_quantity',
): Map<string, { allocated: number }> {
  const result = new Map<string, { allocated: number }>()
  if (lines.length === 0) return result

  const base = (l: LineForAlloc) =>
    method === 'by_amount' ? l.unit_price * l.quantity : l.quantity
  const total = lines.reduce((s, l) => s + base(l), 0)

  if (total === 0) {
    for (const l of lines) {
      result.set(l.id, { allocated: 0 })
    }
    return result
  }

  let assigned = 0
  lines.forEach((l, idx) => {
    const isLast = idx === lines.length - 1
    // 端数は最終行へ。合計を pool と一致させるため
    const share = isLast
      ? pool - assigned
      : Math.round((pool * base(l)) / total)
    if (!isLast) assigned += share

    result.set(l.id, { allocated: share })
  })

  return result
}

/**
 * total を count 個に均等配分する。合計は必ず total と一致する。
 * base = floor(total / count)、余り r（0 <= r < count）を最後の r 個に +1 して配る。
 * total が負でも floor で成立する。count が 0 のときは空配列。
 */
export function splitEvenly(total: number, count: number): number[] {
  if (count === 0) return []

  const base = Math.floor(total / count)
  const r = total - base * count // 0 <= r < count

  return Array.from({ length: count }, (_, i) => base + (i >= count - r ? 1 : 0))
}

/** 販売手数料。rateBp はベーシスポイント（1000 = 10.00%） */
export function calcFee(price: number, rateBp: number): number {
  return Math.floor((price * rateBp) / 10000)
}
