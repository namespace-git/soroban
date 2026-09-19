import { describe, expect, it } from 'vitest'
import { allocate, calcFee, splitEvenly } from '../money'

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

  it('totalが0（単価0の明細のみ）ならallocatedは全て0', () => {
    const lines = [
      { id: 'a', unit_price: 0, quantity: 1 },
      { id: 'b', unit_price: 0, quantity: 1 },
    ]
    const result = allocate(lines, 100, 'by_amount')
    expect(result.get('a')!.allocated).toBe(0)
    expect(result.get('b')!.allocated).toBe(0)
  })

  it('明細が空なら空のMapを返す', () => {
    expect(allocate([], 100, 'by_amount').size).toBe(0)
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
