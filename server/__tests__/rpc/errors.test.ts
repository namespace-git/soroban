import { describe, expect, it } from 'vitest'
import { ApiError, HTTP_STATUS, UserError, mapDbError, registerDbErrorRule } from '../../errors'

describe('UserError / ApiError', () => {
  it('UserError は日本語のメッセージを持ち、code の既定は bad_request', () => {
    const e = new UserError('販売が見つかりません')
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('bad_request')
    expect(e.message).toBe('販売が見つかりません')
    expect(new UserError('x', 'not_found').code).toBe('not_found')
    expect(new UserError('x', 'conflict').code).toBe('conflict')
  })

  it('code と HTTP ステータスの対応', () => {
    expect(HTTP_STATUS).toEqual({
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      not_implemented: 501,
      bad_request: 400,
      conflict: 409,
      internal: 500,
    })
  })
})

describe('mapDbError', () => {
  // postgres.js の PostgresError は constraint_name / table_name、PGlite の DatabaseError は constraint / table
  it('SB で始まる SQLSTATE（DB 関数の利用者向けの日本語）はメッセージをそのまま 409 に', () => {
    const e = mapDbError({ code: 'SB001', message: '取り込み中です' })
    expect(e).toBeInstanceOf(UserError)
    expect(e?.code).toBe('conflict')
    expect(e?.message).toBe('取り込み中です')
    expect(mapDbError({ code: 'SB002', message: '前回の取り込みから10分たっていません', detail: 'あと 42 秒' })?.message).toBe(
      '前回の取り込みから10分たっていません（あと 42 秒）',
    )
    expect(mapDbError({ code: 'SB003', message: '取り込みの権限が失効しています' })?.code).toBe('conflict')
  })

  it('collect_job_one_active の一意制約違反は「取り込み中です」（どちらのドライバの形でも）', () => {
    expect(mapDbError({ code: '23505', message: 'duplicate key', constraint_name: 'collect_job_one_active' })?.message).toContain('取り込み中です')
    expect(mapDbError({ code: '23505', message: 'duplicate key', constraint: 'collect_job_one_active' })?.code).toBe('conflict')
  })

  it('他の一意制約違反や、知らない SQLSTATE は写さない（internal のまま）', () => {
    expect(mapDbError({ code: '23505', message: 'duplicate key', constraint_name: 'sale_pkey' })).toBeUndefined()
    expect(mapDbError({ code: '42P01', message: 'relation "x" does not exist' })).toBeUndefined()
    expect(mapDbError({ code: 'P0001', message: 'raise exception の英語' })).toBeUndefined()
  })

  it('シリアライズ失敗・デッドロックは conflict', () => {
    expect(mapDbError({ code: '40001', message: 'could not serialize' })?.code).toBe('conflict')
    expect(mapDbError({ code: '40P01', message: 'deadlock detected' })?.code).toBe('conflict')
  })

  it('DB の例外ではないもの（通信のエラー・普通の Error・文字列）は undefined', () => {
    expect(mapDbError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBeUndefined()
    expect(mapDbError(new Error('boom'))).toBeUndefined()
    expect(mapDbError('SB001')).toBeUndefined()
    expect(mapDbError(null)).toBeUndefined()
  })

  it('規則を足せる（制約名から日本語に）。条件の無い規則は断る', () => {
    registerDbErrorRule({ code: '23505', constraint: 'tag_name_key', message: '同じ名前のタグがあります', as: 'conflict' })
    const e = mapDbError({ code: '23505', message: 'duplicate key', constraint_name: 'tag_name_key' })
    expect(e?.message).toBe('同じ名前のタグがあります')
    expect(e?.code).toBe('conflict')
    expect(() => registerDbErrorRule({ message: 'すべて' })).toThrow('どれかが必要')
  })
})
