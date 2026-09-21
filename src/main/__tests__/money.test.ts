import { describe, expect, it } from 'vitest'
import { allocate, assertQty, assertYen, calcFee, splitEvenly } from '../money'

describe('splitEvenly', () => {
  it('100を3分割すると端数は最後に寄る', () => {
    expect(splitEvenly(100, 3)).toEqual([33, 33, 34])
  })

  it('負の値でも合計が一致する（floorで成立）', () => {
    const parts = splitEvenly(-100, 3)
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-100)
    expect(parts).toEqual([-34, -33, -33])
  })

  it('totalが0なら全部0', () => {
    expect(splitEvenly(0, 3)).toEqual([0, 0, 0])
  })

  it('count=1ならtotalをそのまま返す', () => {
    expect(splitEvenly(100, 1)).toEqual([100])
  })

  it('count=0なら空配列', () => {
    expect(splitEvenly(100, 0)).toEqual([])
  })
})

describe('allocate', () => {
  it('by_amount：2行の丸めで合計がpoolと一致する', () => {
    const lines = [
      { id: 'a', unit_price: 100, quantity: 1 },
      { id: 'b', unit_price: 200, quantity: 1 },
    ]
    const result = allocate(lines, 100, 'by_amount')
    const total = [...result.values()].reduce((s, v) => s + v.allocated, 0)
    expect(total).toBe(100)
    // 単純な比率どおりなら a=33.33→33, b=66.67→67(端数寄せ)
    expect(result.get('a')!.allocated).toBe(33)
    expect(result.get('b')!.allocated).toBe(67)
  })

  it('by_quantity：数量比で配賦する', () => {
    const lines = [
      { id: 'a', unit_price: 100, quantity: 1 },
      { id: 'b', unit_price: 100, quantity: 2 },
    ]
    const result = allocate(lines, 90, 'by_quantity')
    const total = [...result.values()].reduce((s, v) => s + v.allocated, 0)
    expect(total).toBe(90)
    expect(result.get('a')!.allocated).toBe(30)
    expect(result.get('b')!.allocated).toBe(60)
  })

  it('poolが負（割引が送料を上回る）でも合計が一致する', () => {
    const lines = [
      { id: 'a', unit_price: 100, quantity: 1 },
      { id: 'b', unit_price: 300, quantity: 1 },
    ]
    const result = allocate(lines, -100, 'by_amount')
    const total = [...result.values()].reduce((s, v) => s + v.allocated, 0)
    expect(total).toBe(-100)
  })

  it('by_amount：単価0の明細だけだと重みの合計が0円になるので、数量按分にフォールバックしてpoolを取りこぼさない', () => {
    const lines = [
      { id: 'a', unit_price: 0, quantity: 1 },
      { id: 'b', unit_price: 0, quantity: 1 },
    ]
    const result = allocate(lines, 100, 'by_amount')
    const total = [...result.values()].reduce((s, v) => s + v.allocated, 0)
    expect(total).toBe(100)
    expect(result.get('a')!.allocated).toBe(50)
    expect(result.get('b')!.allocated).toBe(50)
  })

  it('数量按分でも重みの合計が0（数量0の明細のみ）ならError', () => {
    const lines = [{ id: 'a', unit_price: 0, quantity: 0 }]
    expect(() => allocate(lines, 100, 'by_quantity')).toThrow()
  })

  it('明細が空なら空のMapを返す', () => {
    expect(allocate([], 100, 'by_amount').size).toBe(0)
  })
})

describe('assertYen', () => {
  it('安全な整数かつ0以上ならエラーにならない', () => {
    expect(() => assertYen('単価', 0)).not.toThrow()
    expect(() => assertYen('単価', 1000)).not.toThrow()
  })

  it('小数・負数・非安全整数は日本語のErrorを投げる', () => {
    expect(() => assertYen('単価', 100.5)).toThrow(/単価は整数で入力してください/)
    expect(() => assertYen('単価', -1)).toThrow(/単価は整数で入力してください/)
    expect(() => assertYen('単価', Number.MAX_SAFE_INTEGER + 1)).toThrow(/単価は整数で入力してください/)
  })
})

describe('assertQty', () => {
  it('1以上の整数ならエラーにならない', () => {
    expect(() => assertQty('数量', 1)).not.toThrow()
  })

  it('0以下・小数は日本語のErrorを投げる', () => {
    expect(() => assertQty('数量', 0)).toThrow(/数量は1以上の整数で入力してください/)
    expect(() => assertQty('数量', 1.5)).toThrow(/数量は1以上の整数で入力してください/)
  })
})

describe('calcFee', () => {
  it('10%（1000bp）はfloorで切り捨てる', () => {
    expect(calcFee(1234, 1000)).toBe(123)
    expect(calcFee(1235, 1000)).toBe(123)
    expect(calcFee(1000, 1000)).toBe(100)
  })

  it('価格0なら手数料も0', () => {
    expect(calcFee(0, 1000)).toBe(0)
  })
})
