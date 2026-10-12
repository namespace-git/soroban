// Web 版の「取り込む」ボタンの状態（components/web-collect.ts）。
//   - 積まれた・走っている間だけ数秒ごとに状態を読み、終わったら止まる（裏に回っている間は読まない）
//   - 終わりの見せ方は、デスクトップの collect() の結果（CollectorRun[]）と同じ文
//   - PC が動いていない・クールダウン中は、押す前から分かる
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CollectorRun } from '../../../shared/types'
import type { CollectJob, CollectStatus } from '../../../shared/web-types'
import { COLLECT_POLL_MS, describeJob, formatRemaining, isActiveJob, useWebCollect } from '../web-collect'

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

  function setup(opts: { reads?: Array<CollectStatus | Error>; visible?: () => boolean; request?: () => Promise<CollectJob> } = {}) {
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
    const c = useWebCollect({ api, onFinished: j => finished.push(j), isVisible: opts.visible ?? (() => true) })
    return { c, api, finished }
  }

  it('押す → 待ち → 取り込み中 → 完了。走っている間だけ数秒ごとに読み、終わったら止まる', async () => {
    const { c, api, finished } = setup({
      reads: [
        status(null),
        status(job({ status: 'running', agent_name: 'リビングの PC' })),
        status(job({ status: 'done', runs: [run({})] }), { cooldown: 60 }),
      ],
    })
    await c.start()
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0) // 走っていないあいだは読み続けない

    await c.request()
    expect(api.requestCollect).toHaveBeenCalledTimes(1)
    expect(c.queued.value).toBe(true)
    expect(c.active.value).toBe(true)

    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(c.running.value).toBe(true)
    expect(c.statusLine.value).toEqual({ text: '取り込み中（リビングの PC）', warn: false })
    expect(finished).toEqual([])

    await vi.advanceTimersByTimeAsync(COLLECT_POLL_MS)
    expect(finished).toHaveLength(1)
    expect(finished[0].status).toBe('done')
    expect(c.active.value).toBe(false)

    // 終わったら読むのをやめる（クールダウンの数え下げは画面の中だけで、通信はしない）
    const reads = api.getCollectStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.getCollectStatus.mock.calls.length).toBe(reads)
    expect(finished).toHaveLength(1)
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

  it('PC が動いていない（agents_online が 0）と、押す前から上のバーに出る（警告）', async () => {
    const { c } = setup({ reads: [status(null, { agents: 0 })] })
    expect(c.statusLine.value).toBeNull() // まだ読んでいない間は「動いていない」と決めつけない
    await c.start()
    expect(c.agentsOffline.value).toBe(true)
    expect(c.statusLine.value).toEqual({ text: '取り込み担当の PC が動いていません', warn: true })
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
    expect(c.statusLine.value).toEqual({ text: 'あと 1分30秒 で取り込めます', warn: false })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(c.cooldown.value).toBe(59)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.cooldown.value).toBe(0)
    expect(c.statusLine.value).toBeNull()
    expect(api.getCollectStatus).toHaveBeenCalledTimes(1)
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
