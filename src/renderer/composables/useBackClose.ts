// 端末の「戻る」（Android の戻る・ブラウザの戻る・マウスの戻るボタン）で閉じる「層」。
// シート・ドロワー・「その他」・ホーム以外のタブのように、画面の上に積まれていて「戻る」で外れるものに使う。
// 積んだ分だけ history に 1 段ずつ足し、戻るが来たら一番上の層だけを閉じる。アプリごと閉じるのは層が無いときだけ。
import { getCurrentInstance, nextTick, onBeforeUnmount, watch } from 'vue'

type Layer = { id: number; onBack: () => void; released: boolean }

/** 積まれている層。末尾が一番上 */
const stack: Layer[] = []
let seq = 0
let listening = false
/**
 * release() が呼んだ history.back() が起こす popstate の「期限」（1 つにつき 1 件）。その popstate では onBack を呼ばない。
 * back() が取り消されて popstate が来なかったときに、あとの本物の「戻る」を飲み込み続けないよう期限を付ける
 */
const SILENT_POP_TTL_MS = 1500
const silentPops: number[] = []

function onPopState() {
  const now = Date.now()
  while (silentPops.length && silentPops[0] < now) silentPops.shift()
  if (silentPops.length) {
    silentPops.shift()
    return
  }
  const top = stack.pop()
  if (!top) return
  top.released = true
  top.onBack()
}

/**
 * pushBackLayer(onBack) … history.pushState で 1 段積む。popstate が来て、その層がスタックの一番上なら
 * onBack() を呼んで層を外す。
 * 戻り値の release() … 自分で閉じたとき（×・Esc・確定・幕を押した）に呼ぶ。積んだ 1 段を history.back() で消す
 * （その back で起きる popstate では、どの onBack も呼ばない）。2 回呼んでも安全。一番上でない層を release しても、
 * 積んだ段の数とスタックの数は合ったまま（どの段が消えるかは問わない）。
 * history が使えない環境（pushState が例外を投げる）では何もしない（onBack は呼ばれないだけ）。
 */
export function pushBackLayer(onBack: () => void): { release(): void } {
  const layer: Layer = { id: ++seq, onBack, released: false }
  try {
    window.history.pushState({ sorobanBack: layer.id }, '')
  } catch {
    return { release() {} }
  }
  if (!listening) {
    window.addEventListener('popstate', onPopState)
    listening = true
  }
  stack.push(layer)
  return {
    release() {
      if (layer.released) return
      layer.released = true
      const i = stack.indexOf(layer)
      if (i >= 0) stack.splice(i, 1)
      silentPops.push(Date.now() + SILENT_POP_TTL_MS)
      try {
        window.history.back()
      } catch {
        silentPops.pop()
      }
    },
  }
}

/** Vue 用：isOpen() が true になったら pushBackLayer、false になったら release。アンマウント時も release */
export function useBackClose(isOpen: () => boolean, close: () => void): void {
  let layer: { release(): void } | null = null
  let disposed = false

  function push() {
    layer = pushBackLayer(() => {
      layer = null
      close()
      // 戻るで close() を呼んだのに開いたまま（確認待ちなど）なら、次の戻るも拾えるよう積み直す
      void nextTick(() => {
        if (!disposed && !layer && isOpen()) push()
      })
    })
  }

  function sync(open: boolean) {
    if (open && !layer) {
      push()
    } else if (!open && layer) {
      const l = layer
      layer = null
      l.release()
    }
  }

  watch(isOpen, sync, { immediate: true })
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      disposed = true
      sync(false)
    })
  }
}
