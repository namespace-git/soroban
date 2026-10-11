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

  it('SB004（取り消せない）は 409 conflict、SB005（取り込みの要求が見つからない）は 404 not_found。メッセージは関数が出した日本語のまま', () => {
    const cannot = mapDbError({ code: 'SB004', message: '取り込みはもう始まっているので取り消せません', detail: '状態：running' })
    expect(cannot).toBeInstanceOf(UserError)
    expect(cannot?.code).toBe('conflict')
    expect(cannot?.message).toBe('取り込みはもう始まっているので取り消せません（状態：running）')
    expect(mapDbError({ code: 'SB004', message: '取り込みはもう終わっています' })?.code).toBe('conflict')

    const missing = mapDbError({ code: 'SB005', message: '取り込みの要求が見つかりません' })
    expect(missing).toBeInstanceOf(UserError)
    expect(missing?.code).toBe('not_found')
    expect(missing?.message).toBe('取り込みの要求が見つかりません')
    expect(HTTP_STATUS[missing!.code]).toBe(404)
    // SB で始まる他の errcode は、これまでどおり 409
    expect(mapDbError({ code: 'SB006', message: 'これから足す関数' })?.code).toBe('conflict')
  })

  it('22P02（uuid・数値・日付などの形が不正）は 400「値の形が正しくありません」。SQL の中身は出さない', () => {
    const e = mapDbError({ code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' })
    expect(e).toBeInstanceOf(UserError)
    expect(e?.code).toBe('bad_request')
    expect(e?.message).toBe('値の形が正しくありません')
    expect(e?.message).not.toContain('uuid')
  })

  it('22003（integer に入らない大きさ）と 22021（text に入れられない文字）も 400', () => {
    expect(mapDbError({ code: '22003', message: 'integer out of range' })).toMatchObject({ code: 'bad_request', message: '数値が大きすぎます' })
    expect(mapDbError({ code: '22021', message: 'invalid byte sequence for encoding "UTF8": 0x00' })).toMatchObject({
      code: 'bad_request',
      message: '使えない文字が含まれています',
    })
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
