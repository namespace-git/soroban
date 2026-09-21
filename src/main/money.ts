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

  const amountBase = (l: LineForAlloc) => l.unit_price * l.quantity
  const quantityBase = (l: LineForAlloc) => l.quantity

  let base = method === 'by_amount' ? amountBase : quantityBase
  let total = lines.reduce((s, l) => s + base(l), 0)

  // 金額按分で重みの合計が0円（仕入額0円の明細だけ等）だと、送料等の配賦先が
  // 消えて原価から抜け落ちてしまう。黙って捨てず、数量按分に切り替える
  if (total === 0 && method === 'by_amount') {
    base = quantityBase
    total = lines.reduce((s, l) => s + base(l), 0)
  }

  if (total === 0) {
    throw new Error('按分できません（金額・数量がすべて0です）')
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

/**
 * 画面からの入力エントリで金額（円）を検証する。Number.isSafeInteger かつ 0 以上でなければ
 * 日本語の Error を投げる。collector 由来など内部で既に整数が保証されている値には使わない。
 */
export function assertYen(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${name}は整数で入力してください`)
  }
}

/** 画面からの入力エントリで数量を検証する。1以上の整数でなければ日本語の Error を投げる */
export function assertQty(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new Error(`${name}は1以上の整数で入力してください`)
  }
}
