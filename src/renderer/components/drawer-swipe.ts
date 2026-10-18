// Drawer.vue のスマホ幅（下からのシート）を「下に引いて閉じる」ときの判定。
// 画面（DOM）には触れない純粋な関数だけ。値はここ一か所に持つ（テスト: __tests__/drawer-swipe.test.ts）

/** 縦にこれだけ動くまでは「引いた」ことにしない（タップや指の揺れでシートを動かさない） */
export const SWIPE_SLOP = 6
/** これだけ（px）引いて離したら閉じる */
export const SWIPE_CLOSE_DISTANCE = 80
/** 離す直前の速さ（px/ms）がこれ以上なら、距離が足りなくても閉じる（払う） */
export const SWIPE_CLOSE_VELOCITY = 0.5
/** 払うときの最小の距離（px）。指の揺れが速く見えただけで閉じないための下限 */
export const SWIPE_FLICK_MIN_DISTANCE = 24
/** 速さを測る窓（ms）。離す直前のこの時間だけを見る。止めてから離したら払ったことにしない */
export const SWIPE_VELOCITY_WINDOW_MS = 100
/** 足りなくて元に戻すときの時間（ms）。style.css の --dur と同じ */
export const SWIPE_SETTLE_MS = 180

/** 指の位置の記録（t は PointerEvent.timeStamp の ms、y は clientY） */
export type SwipeSample = { t: number; y: number }

/** 記録を足し、速さの窓より古いものを捨てる */
export function pushSwipeSample(samples: SwipeSample[], sample: SwipeSample): SwipeSample[] {
  return [...samples, sample].filter(s => sample.t - s.t <= SWIPE_VELOCITY_WINDOW_MS)
}

/**
 * 離す直前の下向きの速さ（px/ms）。下に動いていれば正。
 * 最後の記録から窓より長く経ってから離したとき（指を止めていた）は 0
 */
export function swipeVelocity(samples: SwipeSample[], releasedAt: number): number {
  const last = samples[samples.length - 1]
  if (!last) return 0
  if (releasedAt - last.t > SWIPE_VELOCITY_WINDOW_MS) return 0
  const first = samples.find(s => last.t - s.t <= SWIPE_VELOCITY_WINDOW_MS)
  if (!first) return 0
  const dt = last.t - first.t
  if (dt <= 0) return 0
  return (last.y - first.y) / dt
}

/**
 * 離したときに閉じるか。distance は指を置いた位置から下へ動いた px（上へ動いたら負）、velocity は下向きの px/ms。
 * 80px 以上引いたか、0.5px/ms 以上で払った（ただし 24px 以上動いている）と閉じる
 */
export function shouldCloseBySwipe(distance: number, velocity: number): boolean {
  if (distance <= 0) return false
  if (distance >= SWIPE_CLOSE_DISTANCE) return true
  return distance >= SWIPE_FLICK_MIN_DISTANCE && velocity >= SWIPE_CLOSE_VELOCITY
}
