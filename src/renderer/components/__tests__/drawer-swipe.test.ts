// スマホ幅のシートを下に引いて閉じる判定（components/drawer-swipe.ts）
import { describe, it, expect } from 'vitest'
import {
  SWIPE_CLOSE_DISTANCE, SWIPE_CLOSE_VELOCITY, SWIPE_FLICK_MIN_DISTANCE, SWIPE_VELOCITY_WINDOW_MS,
  pushSwipeSample, shouldCloseBySwipe, swipeVelocity,
} from '../drawer-swipe'

describe('shouldCloseBySwipe（距離と速さから閉じるかを決める）', () => {
  it('値は 80px・0.5px/ms', () => {
    expect(SWIPE_CLOSE_DISTANCE).toBe(80)
    expect(SWIPE_CLOSE_VELOCITY).toBe(0.5)
  })

  it('80px 以上引いて離したら、遅くても閉じる', () => {
    expect(shouldCloseBySwipe(80, 0)).toBe(true)
    expect(shouldCloseBySwipe(81, 0.01)).toBe(true)
    expect(shouldCloseBySwipe(300, 0)).toBe(true)
  })

  it('79px で遅ければ閉じない（元に戻す）', () => {
    expect(shouldCloseBySwipe(79, 0)).toBe(false)
    expect(shouldCloseBySwipe(79, 0.49)).toBe(false)
    expect(shouldCloseBySwipe(40, 0.1)).toBe(false)
  })

  it('速く払えば（0.5px/ms 以上）距離が足りなくても閉じる', () => {
    expect(shouldCloseBySwipe(40, 0.5)).toBe(true)
    expect(shouldCloseBySwipe(40, 1.2)).toBe(true)
    expect(shouldCloseBySwipe(40, 0.49)).toBe(false)
  })

  it('払うにも最小の距離がある（指の揺れが速く見えただけでは閉じない）', () => {
    expect(shouldCloseBySwipe(SWIPE_FLICK_MIN_DISTANCE, 2)).toBe(true)
    expect(shouldCloseBySwipe(SWIPE_FLICK_MIN_DISTANCE - 1, 2)).toBe(false)
    expect(shouldCloseBySwipe(8, 3)).toBe(false)
  })

  it('上へ動いた・動いていない（距離が 0 以下）なら、速さに関わらず閉じない', () => {
    expect(shouldCloseBySwipe(0, 5)).toBe(false)
    expect(shouldCloseBySwipe(-100, 5)).toBe(false)
    expect(shouldCloseBySwipe(-100, -5)).toBe(false)
  })
})

describe('swipeVelocity（離す直前の下向きの速さ）', () => {
  it('窓の中の最初と最後から px/ms を出す', () => {
    // 50ms で 40px 下 → 0.8px/ms
    const samples = [{ t: 1000, y: 100 }, { t: 1025, y: 120 }, { t: 1050, y: 140 }]
    expect(swipeVelocity(samples, 1052)).toBeCloseTo(0.8, 5)
  })

  it('上へ動いていれば負', () => {
    const samples = [{ t: 0, y: 200 }, { t: 50, y: 150 }]
    expect(swipeVelocity(samples, 55)).toBeCloseTo(-1, 5)
  })

  it('記録が無い・1 つだけ・同じ時刻なら 0', () => {
    expect(swipeVelocity([], 100)).toBe(0)
    expect(swipeVelocity([{ t: 10, y: 5 }], 12)).toBe(0)
    expect(swipeVelocity([{ t: 10, y: 5 }, { t: 10, y: 50 }], 12)).toBe(0)
  })

  it('最後の動きから窓より長く止めてから離したら 0（払ったことにしない）', () => {
    const samples = [{ t: 1000, y: 100 }, { t: 1050, y: 200 }]
    expect(swipeVelocity(samples, 1050 + SWIPE_VELOCITY_WINDOW_MS)).toBeCloseTo(2, 5)
    expect(swipeVelocity(samples, 1050 + SWIPE_VELOCITY_WINDOW_MS + 1)).toBe(0)
  })

  it('窓より古い記録は見ない（ゆっくり引いて最後だけ止まった指は遅い）', () => {
    // 0〜400ms でゆっくり 100px、最後の 50ms は動かない
    const samples = [{ t: 0, y: 0 }, { t: 200, y: 50 }, { t: 400, y: 100 }, { t: 450, y: 100 }]
    expect(swipeVelocity(samples, 455)).toBe(0)
  })

  it('払い：ゆっくり引いてから最後の 50ms で素早く動かすと速い', () => {
    const samples = [{ t: 0, y: 0 }, { t: 400, y: 20 }, { t: 450, y: 70 }]
    // 窓は 450-100=350 以降 → 400ms の 20px と 450ms の 70px
    expect(swipeVelocity(samples, 452)).toBeCloseTo(1, 5)
    // 70px は 80 に届かないが、速く払っているので閉じる
    expect(shouldCloseBySwipe(70, swipeVelocity(samples, 452))).toBe(true)
  })
})

describe('pushSwipeSample（記録を足し、窓より古いものを捨てる）', () => {
  it('足したものは残り、窓より古いものは消える', () => {
    let s = pushSwipeSample([], { t: 0, y: 0 })
    s = pushSwipeSample(s, { t: 60, y: 10 })
    s = pushSwipeSample(s, { t: 120, y: 20 })
    expect(s).toEqual([{ t: 60, y: 10 }, { t: 120, y: 20 }])
  })

  it('元の配列は書き換えない', () => {
    const before = [{ t: 0, y: 0 }]
    pushSwipeSample(before, { t: 50, y: 5 })
    expect(before).toEqual([{ t: 0, y: 0 }])
  })
})
