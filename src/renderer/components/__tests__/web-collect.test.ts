// Web 版の「取り込む」ボタンの状態（components/web-collect.ts）。
//   - 積まれた・走っている間は数秒ごと、何もしていない間は 2 分ごと（PC が動いていない表示のあいだは 20 秒ごと）に状態を読む
//     （裏に回っている間は読まない。戻ったら 1 回読んで、そこからまた周期が始まる）
//   - 終わりの見せ方は、デスクトップの collect() の結果（CollectorRun[]）と同じ文
//   - PC が動いていない・クールダウン中は、押す前から分かる
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CollectorRun } from '../../../shared/types'
import type { CollectJob, CollectStatus } from '../../../shared/web-types'
import {
  COLLECT_IDLE_POLL_MS, COLLECT_OFFLINE_POLL_MS, COLLECT_POLL_MS,
  describeJob, formatRemaining, isActiveJob, useWebCollect, widestRemaining,
} from '../web-collect'

function job(over: Partial<CollectJob> = {}): CollectJob {
  return {
    id: 'j1', status: 'queued', requested_at: '2026-10-12T00:00:00Z', requested_by_me: true, agent_name: null,
    claimed_at: null, heartbeat_at: null, finished_at: null, runs: null, message: null, ...over,
  }
}

function status(j: CollectJob | null, o: { agents?: number; cooldown?: number } = {}): CollectStatus {
  return { job: j, agents_online: o.agents ?? 1, cooldown_seconds: o.cooldown ?? 0 }
}

function run(over: Partial<CollectorRun>): CollectorRun {
  return {
    id: 'r', started_at: '2026-10-12T00:00', finished_at: null, status: 'ok', fetched: 3, inserted: 1, message: null,
    source: 'mercari', shop_account_id: null, shop_account_name: null, ...over,
  }
}

describe('formatRemaining / isActiveJob', () => {
  it('秒と分で出す（切り上げ。負は 0 秒）', () => {
    expect(formatRemaining(45)).toBe('45秒')
    expect(formatRemaining(60)).toBe('1分')
    expect(formatRemaining(90)).toBe('1分30秒')
    expect(formatRemaining(0.2)).toBe('1秒')
    expect(formatRemaining(-5)).toBe('0秒')
  })

  it('積まれた・走っているだけが「進行中」', () => {
    expect(isActiveJob(job({ status: 'queued' }))).toBe(true)
    expect(isActiveJob(job({ status: 'running' }))).toBe(true)
    for (const s of ['done', 'partial', 'failed', 'cancelled'] as const) expect(isActiveJob(job({ status: s }))).toBe(false)
    expect(isActiveJob(null)).toBe(false)
  })
})

describe('widestRemaining（数え下げの間でいちばん幅を取る残りの見本。数字は 0 に置き換える）', () => {
  it('秒だけのうちは 1 桁→2 桁。1 分を超えると「分＋2 桁の秒」（「1分」より「59秒」のほうが幅を取る）', () => {
    expect(widestRemaining(9)).toBe('0秒')
    expect(widestRemaining(45)).toBe('00秒')
    expect(widestRemaining(60)).toBe('00秒')
    expect(widestRemaining(90)).toBe('0分00秒')
    expect(widestRemaining(125)).toBe('0分00秒')
    expect(widestRemaining(600)).toBe('0分00秒')
  })

  it('分の桁が増えれば、そのぶん広い（10 分以上）', () => {
    expect(widestRemaining(700)).toBe('00分00秒')
  })

  it('0 以下・極端に長くても落ちない（上限あり）', () => {
    expect(widestRemaining(0)).toBe('0秒')
    expect(widestRemaining(-5)).toBe('0秒')
    expect(widestRemaining(1_000_000)).toBe(widestRemaining(3600))
  })

  it('見本の幅は、数え下げのどの時点の文字列よりも狭くならない', () => {
    const width = (s: string) => [...s].reduce((w, c) => w + (c >= '0' && c <= '9' ? 0.55 : 1), 0)
    for (const total of [30, 60, 90, 119, 600, 725]) {
      const sample = width(widestRemaining(total))
      for (let s = 1; s <= total; s++) expect(width(formatRemaining(s))).toBeLessThanOrEqual(sample)
    }
  })
})

describe('describeJob（終わった要求の見せ方）', () => {
  const line = (r: CollectorRun) => `${r.source}: ${r.status === 'ok' ? `新規 ${r.inserted}件（取得 ${r.fetched}件）` : (r.message ?? r.status)}`

  it('done：デスクトップの reportRun と同じ「対象: 結果」を ／ でつなぐ。全部 ok なら ok', () => {
    const n = describeJob(job({ status: 'done', runs: [run({}), run({ source: 'yahoo', fetched: 1, inserted: 0 })] }), line)
    expect(n).toEqual({ text: 'mercari: 新規 1件（取得 3件）／yahoo: 新規 0件（取得 1件）', kind: 'ok' })
  })

  it('done でも 0 件（empty）・要ログインが混ざれば warn（取得 0 件を成功にしない）', () => {
    const n = describeJob(job({ status: 'done', runs: [run({}), run({ status: 'empty', message: '0件でした' })] }), line)
    expect(n.kind).toBe('warn')
    expect(n.text).toContain('0件でした')
  })

  it('partial：「途中で止まりました。次の取り込みで続きを取ります」＋理由＋終わった分', () => {
    const n = describeJob(job({ status: 'partial', message: 'メロジョイA：通信に失敗しました', runs: [run({})] }), line)
    expect(n.kind).toBe('warn')
    expect(n.text).toBe('途中で止まりました。次の取り込みで続きを取ります（メロジョイA：通信に失敗しました）／mercari: 新規 1件（取得 3件）')
    expect(describeJob(job({ status: 'partial' }), line).text).toBe('途中で止まりました。次の取り込みで続きを取ります')
  })

  it('failed：理由（無ければ既定の文）＋各対象の結果。常に warn', () => {
    const n = describeJob(job({ status: 'failed', message: 'メルカリにログインが必要です（リビングの PC）', runs: [run({ status: 'auth_required', message: 'ログインが必要です' })] }), line)
    expect(n).toEqual({ text: 'メルカリにログインが必要です（リビングの PC）／mercari: ログインが必要です', kind: 'warn' })
    expect(describeJob(job({ status: 'failed' }), line)).toEqual({ text: '取り込みに失敗しました', kind: 'warn' })
  })

  it('cancelled：理由（誰も拾わなかった等）を出す', () => {
    expect(describeJob(job({ status: 'cancelled', message: '5 分たっても PC が拾いませんでした' }), line))
      .toEqual({ text: '5 分たっても PC が拾いませんでした', kind: 'warn' })
    expect(describeJob(job({ status: 'cancelled' }), line).text).toBe('取り込みは取り消されました')
  })
})

describe('useWebCollect（状態を読む・押す・取り消す）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(opts: {
    reads?: Array<CollectStatus | Error>
    visible?: () => boolean
    request?: () => Promise<CollectJob>
    intervals?: { pollMs?: number; idlePollMs?: number; offlinePollMs?: number }
  } = {}) {
    const reads = [...(opts.reads ?? [])]
    const finished: CollectJob[] = []
    const api = {
      requestCollect: vi.fn(opts.request ?? (async () => job({ status: 'queued' }))),
      getCollectStatus: vi.fn(async () => {
        const next = reads.length > 1 ? reads.shift()! : reads[0]
        if (next instanceof Error) throw next
        return next ?? status(null)
      }),
      cancelCollectJob: vi.fn(async () => {}),
    }
    const c = useWebCollect({ api, onFinished: j => finished.push(j), isVisible: opts.visible ?? (() => true), ...opts.intervals })
    return { c, api, finished }
  }

  it('押す → 待ち → 取り込み中 → 完了。走っている間は数秒ごとに読み、終わったら何もしていない間隔（2 分）に戻る', async () => {
    const { c, api, finished } = setup({
      reads: [
        status(null),
        status(job({ status: 'running', agent_name: 'リビングの PC' })),
        status(job({ status: 'done', runs: [run({})] }), { cooldown: 60 }),
      ],
    })
    await c.start()
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // 何もしていないあいだの周期（2 分）だけ。数秒ごとには読まない
    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1)

    await c.request()
    expect(api.requestCollect).toHaveBeenCalledTimes(1)
    expect(c.queued.value).toBe(true)
    expect(c.active.value).toBe(true)

    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(c.running.value).toBe(true)
    expect(c.statusLine.value).toEqual({ text: '取り込み中（リビングの PC）', warn: false, short: '取り込み中' })
    expect(finished).toEqual([])

    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(finished).toHaveLength(1)
    expect(finished[0].status).toBe('done')
    expect(c.active.value).toBe(false)

    // 終わったら数秒ごとの読みはやめる（クールダウンの数え下げは画面の中だけで、通信はしない）。次に読むのは 2 分後
    const reads = api.getCollectStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.getCollectStatus.mock.calls.length).toBe(reads)
    expect(finished).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS - 30_000)
    expect(api.getCollectStatus.mock.calls.length).toBe(reads + 1)
    expect(finished).toHaveLength(1) // 終わった要求を読み直しても、知らせは 2 度出さない
  })

  it('開いた時点で走っていた要求は追い続け、終わったら知らせる。もう終わっていたものは知らせない', async () => {
    const a = setup({ reads: [status(job({ status: 'running' })), status(job({ status: 'failed', message: 'x' }))] })
    await a.c.start()
    expect(a.c.running.value).toBe(true)
    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(a.finished.map(j => j.status)).toEqual(['failed'])

    const b = setup({ reads: [status(job({ status: 'done' }))] })
    await b.c.start()
    expect(b.finished).toEqual([])
    expect(b.c.active.value).toBe(false)
  })

  it('画面が裏に回っている間は読まない。戻ったら 1 回読み直して続ける', async () => {
    let visible = true
    const { c, api, finished } = setup({
      visible: () => visible,
      reads: [status(null), status(job({ status: 'running' })), status(job({ status: 'done' }))],
    })
    await c.start()
    await c.request()
    visible = false
    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS * 3)
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1) // start の 1 回だけ

    visible = true
    c.onVisible()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
    expect(c.running.value).toBe(true)

    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(finished).toHaveLength(1)
  })

  it('stop すると読むのをやめる', async () => {
    const { c, api } = setup({ reads: [status(null), status(job({ status: 'running' }))] })
    await c.start()
    await c.request()
    c.stop()
    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS * 3)
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('読み取りが一瞬失敗しても、走っている間は次の周期でまた読む', async () => {
    const { c, api, finished } = setup({
      reads: [status(null), new Error('サーバーにつながりません'), status(job({ status: 'done' }))],
    })
    await c.start()
    await c.request()
    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS) // 失敗
    expect(c.queued.value).toBe(true)
    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
    expect(finished).toHaveLength(1)
  })

  describe('何もしていない間の読み直し', () => {
    it('PC が動いていない表示のままなら 20 秒ごとに読み直し、動き出したら表示が消えて 2 分ごとになる', async () => {
      // 窓が開いてから PC が取り込み担当に登録される（PC の窓の中の Web 版は必ずこうなる）
      const { c, api } = setup({ reads: [status(null, { agents: 0 }), status(null, { agents: 0 }), status(null, { agents: 1 })] })
      await c.start()
      expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
      expect(c.statusLine.value).toEqual({ text: '取り込み担当の PC が動いていません', warn: true, short: 'PC 停止中' })

      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS - 1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      expect(c.statusLine.value?.text).toBe('取り込み担当の PC が動いていません') // まだ 0 台。表示は残る

      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
      expect(c.agentsOffline.value).toBe(false)
      expect(c.statusLine.value).toBeNull() // 「動いていません」が消える

      // 動いている表示になったら 20 秒では読まない
      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS * 2)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS - COLLECT_OFFLINE_POLL_MS * 2)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(4)
    })

    it('PC が動いている（agents_online が 1 以上）なら 2 分ごと。20 秒では読まない', async () => {
      const { c, api } = setup({ reads: [status(null, { agents: 1 })] })
      await c.start()
      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS)
      await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS - COLLECT_OFFLINE_POLL_MS - 1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
    })

    it('動いている PC が途中で 0 台になれば、20 秒ごとに切り替わって表示が出る', async () => {
      const { c, api } = setup({ reads: [status(null, { agents: 2 }), status(null, { agents: 0 })] })
      await c.start()
      expect(c.statusLine.value).toBeNull()
      await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS)
      expect(c.statusLine.value?.warn).toBe(true)
      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
    })

    it('裏に回っている間は読まない。戻ったら 1 回読み、そこからまた周期が始まる', async () => {
      let visible = true
      const { c, api } = setup({
        visible: () => visible,
        reads: [status(null, { agents: 0 }), status(null, { agents: 0 }), status(null, { agents: 1 })],
      })
      await c.start()
      visible = false
      await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS * 3)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0) // 裏にいる間は周期も止まっている

      visible = true
      c.onVisible()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      expect(c.agentsOffline.value).toBe(true)

      // まだ 0 台。20 秒後にまた読み、1 台になったら表示が消える
      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
      expect(c.statusLine.value).toBeNull()
    })

    it('積まれた・走っている間は今まで通りの間隔（PC が動いていなくても）', async () => {
      const { c, api } = setup({ reads: [status(job({ status: 'queued' }), { agents: 0 })] })
      await c.start()
      await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS - 1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
    })

    it('読み取りに失敗しても周期は続く（PC が動いていない表示は消えず、次の周期でまた読む）', async () => {
      const { c, api } = setup({ reads: [status(null, { agents: 0 }), new Error('サーバーにつながりません'), status(null, { agents: 1 })] })
      await c.start()
      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS) // 失敗
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      expect(c.agentsOffline.value).toBe(true)
      await vi.advanceTimersByTimeAsync(COLLECT_OFFLINE_POLL_MS)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
      expect(c.statusLine.value).toBeNull()
    })

    it('stop すると読まない', async () => {
      const { c, api } = setup({ reads: [status(null, { agents: 0 })] })
      await c.start()
      c.stop()
      await vi.advanceTimersByTimeAsync(COLLECT_IDLE_POLL_MS * 2)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('タイマーは二重に走らない（戻る・押すを重ねても、周期は常に 1 本）', async () => {
      const { c, api } = setup({ reads: [status(null, { agents: 1 })] })
      await c.start()
      expect(vi.getTimerCount()).toBe(1)
      c.onVisible()
      c.onVisible()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)

      await c.request() // 周期が数秒ごとに置き換わる（足されない）
      expect(vi.getTimerCount()).toBe(1)
    })

    it('間隔は差し替えられる', async () => {
      const { c, api } = setup({
        reads: [status(null, { agents: 0 }), status(null, { agents: 1 })],
        intervals: { idlePollMs: 5000, offlinePollMs: 1000 },
      })
      await c.start()
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(4999)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(api.getCollectStatus).toHaveBeenCalledTimes(3)
    })
  })

  it('PC が動いていない（agents_online が 0）と、押す前から上のバーに出る（警告）', async () => {
    const { c } = setup({ reads: [status(null, { agents: 0 })] })
    expect(c.statusLine.value).toBeNull() // まだ読んでいない間は「動いていない」と決めつけない
    await c.start()
    expect(c.agentsOffline.value).toBe(true)
    expect(c.statusLine.value).toEqual({ text: '取り込み担当の PC が動いていません', warn: true, short: 'PC 停止中' })
  })

  it('積まれたあいだの文：PC が動いていなければそれも添える', async () => {
    const { c } = setup({ reads: [status(job({ status: 'queued' }), { agents: 0 })] })
    await c.start()
    expect(c.queuedText.value).toBe('PC が拾うのを待っています（取り込み担当の PC が動いていません）')
    const ok = setup({ reads: [status(job({ status: 'queued' }), { agents: 2 })] })
    await ok.c.start()
    expect(ok.c.queuedText.value).toBe('PC が拾うのを待っています')
  })

  it('クールダウンの残りを出し、1 秒ずつ減らす（通信はしない）', async () => {
    const { c, api } = setup({ reads: [status(null, { cooldown: 90 })] })
    await c.start()
    expect(c.cooldown.value).toBe(90)
    expect(c.statusLine.value).toMatchObject({ text: 'あと 1分30秒 で取り込めます', warn: false })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(c.cooldown.value).toBe(59)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.cooldown.value).toBe(0)
    expect(c.statusLine.value).toBeNull()
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
  })

  it('クールダウン中は、狭い幅用の短い文言と、数え下げの間ずっと同じ「確保する幅」を持つ', async () => {
    const { c } = setup({ reads: [status(null, { cooldown: 90 })] })
    await c.start()
    const first = c.statusLine.value
    expect(first?.short).toBe('あと 1分30秒')
    expect(first?.reserve).toEqual({ text: 'あと 0分00秒 で取り込めます', short: 'あと 0分00秒' })

    // 数え下げて桁が変わっても（1分30秒 → 59秒 → 9秒）、確保する幅は動かない
    for (const advance of [31_000, 50_000]) {
      await vi.advanceTimersByTimeAsync(advance)
      const line = c.statusLine.value
      expect(line?.reserve).toEqual(first?.reserve)
    }
    expect(c.statusLine.value?.short).toBe('あと 9秒')
  })

  it('押したときに走っている・クールダウン中ならエラーを投げ、その状態を画面に出す', async () => {
    const { c } = setup({
      reads: [status(null), status(job({ status: 'running', agent_name: 'リビングの PC' }))],
      request: async () => { throw new Error('いま取り込み中です') },
    })
    await c.start()
    await expect(c.request()).rejects.toThrow('いま取り込み中です')
    expect(c.running.value).toBe(true)
    expect(c.active.value).toBe(true)
  })

  it('取り消す：積まれた要求だけ。取り消したあとは終わりの知らせを出さない', async () => {
    const { c, api, finished } = setup({ reads: [status(null), status(job({ status: 'cancelled' }))] })
    await c.start()
    await c.request()
    await c.cancel()
    expect(api.cancelCollectJob).toHaveBeenCalledWith('j1')
    expect(c.active.value).toBe(false)
    expect(finished).toEqual([])

    // 走り出していれば取り消しの口には行かない
    const b = setup({ reads: [status(job({ status: 'running' }))] })
    await b.c.start()
    await b.c.cancel()
    expect(b.api.cancelCollectJob).not.toHaveBeenCalled()
  })

  it('取り消しが断られたら（もう始まっていた）エラーを投げ、最新の状態を読み直す', async () => {
    const { c, api } = setup({ reads: [status(null), status(job({ status: 'running' }))] })
    api.cancelCollectJob.mockRejectedValue(new Error('もう始まっています'))
    await c.start()
    await c.request()
    await expect(c.cancel()).rejects.toThrow('もう始まっています')
    expect(c.running.value).toBe(true)
  })
})
