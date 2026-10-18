// 端末の「戻る」で閉じる層（composables/useBackClose.ts）を固定する。
//   - 積む→戻る で onBack が 1 回。release は history.back() で積んだ 1 段を消し、その popstate では onBack を呼ばない
//   - 2 層積んで戻ると上だけ閉じる。二重 release・一番上でない層の release・pushState が投げる環境でも壊れない
// テストは node で回るので、window / history は最小の偽物（履歴の配列と popstate の配送）に差し替える
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'

type PopListener = (e: { state: unknown }) => void

/** 履歴の配列と現在位置を持つ偽の window。back() は実ブラウザと同じく非同期に popstate を配る */
function installFakeWindow(opts: { pushStateThrows?: boolean } = {}) {
  const entries: unknown[] = [null]
  let index = 0
  const listeners = new Set<PopListener>()

  /** 履歴を delta 動かして popstate を配る（端末の「戻る」はこれ。history.back() の呼び出しには数えない） */
  function traverse(delta: number) {
    const next = index + delta
    if (next < 0 || next >= entries.length) return
    index = next
    for (const l of [...listeners]) l({ state: entries[index] })
  }

  const history = {
    pushState: vi.fn((state: unknown) => {
      if (opts.pushStateThrows) throw new Error('SecurityError')
      entries.splice(index + 1)
      entries.push(state)
      index++
    }),
    back: vi.fn(() => { queueMicrotask(() => traverse(-1)) }),
  }
  const win = {
    history,
    addEventListener: vi.fn((type: string, fn: PopListener) => { if (type === 'popstate') listeners.add(fn) }),
    removeEventListener: vi.fn((type: string, fn: PopListener) => { if (type === 'popstate') listeners.delete(fn) }),
  }
  vi.stubGlobal('window', win)
  return {
    history,
    win,
    /** base（1 つ目の履歴）から数えて、積まれている段の数 */
    depth: () => index,
    /** Android の戻る・ブラウザの戻る。popstate は非同期に届くので、呼んだあと settle() で待つ */
    userBack: () => { queueMicrotask(() => traverse(-1)) },
  }
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

async function load() {
  vi.resetModules()
  return await import('../useBackClose')
}

describe('pushBackLayer', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('積むと history を 1 段足し、戻る（popstate）で onBack が 1 回だけ呼ばれる', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const onBack = vi.fn()
    pushBackLayer(onBack)
    expect(env.history.pushState).toHaveBeenCalledTimes(1)
    expect(env.history.pushState.mock.calls[0][0]).toMatchObject({ sorobanBack: expect.any(Number) })
    expect(env.depth()).toBe(1)

    env.userBack()
    await settle()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(env.depth()).toBe(0)

    // 層は外れたので、もう一度戻っても（ブラウザの戻る＝ここでは何も積まれていない）onBack は呼ばれない
    env.userBack()
    await settle()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('popstate のリスナーはモジュールで 1 つだけ（何層積んでも）', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    pushBackLayer(() => {})
    pushBackLayer(() => {})
    pushBackLayer(() => {})
    expect(env.win.addEventListener).toHaveBeenCalledTimes(1)
    expect(env.win.addEventListener.mock.calls[0][0]).toBe('popstate')
  })

  it('release は history.back() で積んだ 1 段を消し、その popstate では onBack を呼ばない', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const onBack = vi.fn()
    const layer = pushBackLayer(onBack)
    layer.release()
    expect(env.history.back).toHaveBeenCalledTimes(1)
    await settle()
    expect(onBack).not.toHaveBeenCalled()
    expect(env.depth()).toBe(0)

    // 消した分の popstate は使い切っている。次に積んだ層は普通に戻るで閉じる
    const onBack2 = vi.fn()
    pushBackLayer(onBack2)
    env.userBack()
    await settle()
    expect(onBack2).toHaveBeenCalledTimes(1)
  })

  it('2 層積んで戻ると上の層だけが閉じる。もう一度戻ると下の層', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const a = vi.fn()
    const b = vi.fn()
    pushBackLayer(a)
    pushBackLayer(b)
    expect(env.depth()).toBe(2)

    env.userBack()
    await settle()
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()

    env.userBack()
    await settle()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(env.depth()).toBe(0)
  })

  it('release を 2 回呼んでも back は 1 回だけ', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const layer = pushBackLayer(() => {})
    layer.release()
    layer.release()
    await settle()
    expect(env.history.back).toHaveBeenCalledTimes(1)
    expect(env.depth()).toBe(0)
  })

  it('戻るで閉じた層をあとから release しても back は呼ばれない（×と戻るが重なっても履歴を余計に戻さない）', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const layer = pushBackLayer(() => {})
    env.userBack()
    await settle()
    layer.release()
    await settle()
    expect(env.history.back).not.toHaveBeenCalled()
    expect(env.depth()).toBe(0)
  })

  it('一番上でない層を release しても壊れない（段の数とスタックが合ったまま、残った層は戻るで閉じる）', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const a = vi.fn()
    const b = vi.fn()
    const layerA = pushBackLayer(a)
    pushBackLayer(b)

    layerA.release()
    await settle()
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(env.depth()).toBe(1)

    env.userBack()
    await settle()
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    expect(env.depth()).toBe(0)
  })

  it('release の back で popstate が来なかったときも、期限（1.5 秒）を過ぎれば本物の「戻る」を拾う', async () => {
    const env = installFakeWindow()
    const { pushBackLayer } = await load()
    const a = vi.fn()
    const b = vi.fn()
    const layerA = pushBackLayer(a)
    pushBackLayer(b)
    env.history.back.mockImplementation(() => {}) // 取り消されて popstate が来ない
    layerA.release()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2000)
    env.userBack()
    await settle()
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('pushState が例外を投げる環境では何もしない（例外にならず、release も安全、onBack は呼ばれない）', async () => {
    const env = installFakeWindow({ pushStateThrows: true })
    const { pushBackLayer } = await load()
    const onBack = vi.fn()
    let layer: { release(): void } | undefined
    expect(() => { layer = pushBackLayer(onBack) }).not.toThrow()
    expect(() => layer!.release()).not.toThrow()
    await settle()
    expect(env.history.back).not.toHaveBeenCalled()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('window が無い環境でも例外にならない', async () => {
    const { pushBackLayer } = await load()
    const onBack = vi.fn()
    expect(() => pushBackLayer(onBack).release()).not.toThrow()
    expect(onBack).not.toHaveBeenCalled()
  })
})

describe('useBackClose', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('開いたら積み、戻るで close が呼ばれる（閉じたあとの release で履歴を余計に戻さない）', async () => {
    const env = installFakeWindow()
    const { useBackClose } = await load()
    const open = ref(false)
    useBackClose(() => open.value, () => { open.value = false })
    expect(env.history.pushState).not.toHaveBeenCalled()

    open.value = true
    await nextTick()
    expect(env.history.pushState).toHaveBeenCalledTimes(1)
    expect(env.depth()).toBe(1)

    env.userBack()
    await settle()
    await nextTick()
    expect(open.value).toBe(false)
    expect(env.history.back).not.toHaveBeenCalled()
    expect(env.depth()).toBe(0)
  })

  it('自分で閉じたら（×・Esc・確定）積んだ 1 段を消す', async () => {
    const env = installFakeWindow()
    const { useBackClose } = await load()
    const open = ref(true)
    const close = vi.fn()
    useBackClose(() => open.value, close)
    expect(env.depth()).toBe(1)

    open.value = false
    await nextTick()
    expect(env.history.back).toHaveBeenCalledTimes(1)
    await settle()
    expect(env.depth()).toBe(0)
    expect(close).not.toHaveBeenCalled()
  })

  it('最初から開いているときも積む。開閉をくり返しても段が増えない', async () => {
    const env = installFakeWindow()
    const { useBackClose } = await load()
    const open = ref(true)
    useBackClose(() => open.value, () => { open.value = false })
    expect(env.depth()).toBe(1)

    for (let i = 0; i < 3; i++) {
      open.value = false
      await nextTick()
      await settle()
      open.value = true
      await nextTick()
      await settle()
    }
    expect(env.depth()).toBe(1)
  })

  it('戻るで close を呼んでも開いたままなら、次の戻るも拾えるよう積み直す', async () => {
    const env = installFakeWindow()
    const { useBackClose } = await load()
    const open = ref(true)
    const close = vi.fn() // 確認待ちなどで閉じない
    useBackClose(() => open.value, close)

    env.userBack()
    await settle()
    await nextTick()
    expect(close).toHaveBeenCalledTimes(1)
    expect(env.depth()).toBe(1)

    env.userBack()
    await settle()
    await nextTick()
    expect(close).toHaveBeenCalledTimes(2)
  })
})
