import { randomBytes, randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { Ctx } from '../../context'
import { createShopAccount } from '../../domain/master'
import type { IntegrationCtx } from '../../domain/integrations'
import type { Member } from '../domain/helpers'

// 秘密の値・17TRACK の定期実行・Gemini の設定のテスト用の道具。本物の 17TRACK・Gemini には出ない（偽の fetch だけ）

/** 32 バイトの乱数の base64（SECRET_KEYS の鍵）。テストごとに作る（リポジトリに鍵を書かない） */
export const newKey = (): string => randomBytes(32).toString('base64')

/** 偽の API キー（形だけ本物らしい）。ログ・結果・エラーに出ていないかを調べる目印にもする */
export const fakeApiKey = (): string => `k${randomBytes(15).toString('hex')}`

export const keyRing = (...versions: Array<[number, string]>): string => versions.map(([v, k]) => `${v}:${k}`).join(',')

/** Ctx に SECRET_KEYS・偽の fetch を足す（入口がやる分） */
export function withEnv(ctx: Ctx, env: { secretKeys?: string | null; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): IntegrationCtx {
  return { ...ctx, ...env }
}

// ---- 偽の時計 ----

export interface FakeClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** sleep が呼ばれた長さの記録 */
  sleeps: number[]
}

export function fakeClock(start = 1_000_000): FakeClock {
  let t = start
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
  }
}

// ---- 偽の 17TRACK ----

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const apiOk = (data: unknown): Response => jsonResponse({ code: 0, data })

export interface Track17Call {
  path: 'register' | 'gettrackinfo'
  numbers: string[]
  /** 送られた時刻（偽の時計） */
  at: number
  token: string | null
}

type TrackInfoItem = Record<string, unknown>

/** gettrackinfo の accepted の 1 件（状態だけ指定） */
export const info = (number: string, status: string, extra: Record<string, unknown> = {}): TrackInfoItem => ({
  number,
  track_info: { latest_status: { status }, ...extra },
})

export interface Fake17 {
  fetch: typeof fetch
  calls: Track17Call[]
}

/**
 * 17TRACK の偽物。既定は register＝全部 accepted、gettrackinfo＝全部「輸送中」。
 * on で応答を差し替える（Response を返す／例外を投げる）。呼び出しは記録する
 */
export function fakeTrack17(
  clock: FakeClock,
  on: Partial<Record<Track17Call['path'], (numbers: string[], call: Track17Call, index: number) => Response | Promise<Response>>> = {},
): Fake17 {
  const calls: Track17Call[] = []
  const counts = { register: 0, gettrackinfo: 0 }
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = String(input)
    const path = url.endsWith('/register') ? 'register' : url.endsWith('/gettrackinfo') ? 'gettrackinfo' : null
    if (!path) throw new Error(`想定外の URL: ${url}`)
    const headers = new Headers(init?.headers)
    const numbers = (JSON.parse(String(init?.body)) as Array<{ number: string }>).map(x => x.number)
    const call: Track17Call = { path, numbers, at: clock.now(), token: headers.get('17token') }
    calls.push(call)
    const handler = on[path]
    if (handler) return handler(numbers, call, counts[path]++)
    counts[path]++
    if (path === 'register') return apiOk({ accepted: numbers.map(number => ({ number })), rejected: [] })
    return apiOk({ accepted: numbers.map(n => info(n, 'InTransit')), rejected: [] })
  }) as typeof fetch
  return { fetch: f, calls }
}

// ---- 仕入 ----

const shops = new WeakMap<Member, Promise<string>>()

export interface PurchaseSeed {
  number: string | null
  fulfillment?: 'pending' | 'shipped' | 'delivered' | null
  queued?: boolean
  registered?: boolean
  pending?: boolean
  /** 新しい注文が先に登録されることの確認用 */
  orderedAt?: string
}

/** 追跡番号つきの仕入を 1 件入れて id を返す（仕入先は世帯ごとに 1 つ使い回す） */
export async function addPurchase(member: Member, seed: PurchaseSeed): Promise<string> {
  return (await addPurchases(member, [seed]))[0]
}

/** 追跡番号つきの仕入をまとめて入れて id を返す（入れた順） */
export async function addPurchases(member: Member, seeds: PurchaseSeed[]): Promise<string[]> {
  if (!shops.has(member)) shops.set(member, member.run(ctx => createShopAccount(ctx, `店 ${randomUUID().slice(0, 6)}`)))
  const shopId = await shops.get(member)!
  return member.run(async (ctx) => {
    const ids: string[] = []
    for (const seed of seeds) {
      const row = await ctx.sql.get<{ id: string }>(
        `insert into purchase (shop_account_id, ordered_at, fulfillment, tracking_number,
                               tracking_queued_at, tracking_registered_at, tracking_register_pending_at)
         values (?, ?, ?, ?, ?, ?, ?) returning id`,
        shopId, seed.orderedAt ?? '2026-10-01', seed.fulfillment === undefined ? 'shipped' : seed.fulfillment, seed.number,
        seed.queued === false ? null : new Date().toISOString(),
        seed.registered ? new Date().toISOString() : null,
        seed.pending ? new Date().toISOString() : null,
      )
      ids.push(row!.id)
    }
    return ids
  })
}

/** 追跡番号 N0…N(n-1) の登録済み・積まれた仕入を n 件 */
export const registeredQueue = (n: number, prefix = 'N'): PurchaseSeed[] =>
  Array.from({ length: n }, (_, i) => ({ number: `${prefix}${String(i).padStart(3, '0')}`, registered: true }))

export interface PurchaseState {
  fulfillment: string | null
  delivered_at: string | null
  tracking_status: string | null
  checked: boolean
  queued: boolean
  registered: boolean
  pending: boolean
}

export const stateOf = (member: Member, id: string): Promise<PurchaseState> =>
  member.run(async (ctx) =>
    (await ctx.sql.get<PurchaseState>(
      `select fulfillment, delivered_at, tracking_status,
              tracking_checked_at is not null as checked,
              tracking_queued_at is not null as queued,
              tracking_registered_at is not null as registered,
              tracking_register_pending_at is not null as pending
         from purchase where id = ?`, id))!,
  )

/** console に出たものを文字列にして集める（鍵・平文が出ていないかを調べる） */
export function spyConsole(): { text: () => string; restore: () => void } {
  const lines: string[] = []
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name =>
    vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }),
  )
  return { text: () => lines.join('\n'), restore: () => spies.forEach(s => s.mockRestore()) }
}
