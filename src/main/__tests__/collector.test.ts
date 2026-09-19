import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// collector.ts は electron（BrowserWindow・session）に依存する。
// ここで検証するのは electron に依存しない純粋関数だけなので、import を通すために潰しておく
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({ setUserAgent: () => {} }) },
}))

import {
  buildUserAgent, extractTotalCount, isChallengeText, parseSoldHtml, parseSoldRow, randomWaitMs,
} from '../collector'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('collector（electronに依存しない部分）', () => {
  describe('randomWaitMs', () => {
    it('2,000〜6,000の範囲に収まる', () => {
      for (let i = 0; i < 200; i++) {
        const ms = randomWaitMs()
        expect(ms).toBeGreaterThanOrEqual(2000)
        expect(ms).toBeLessThanOrEqual(6000)
      }
    })
  })

  describe('buildUserAgent', () => {
    it('Windows：Electron/soroban を含まず、Chrome/メジャー版を含む', () => {
      const ua = buildUserAgent('win32', '130')
      expect(ua).toContain('Chrome/130')
      expect(ua).not.toContain('Electron')
      expect(ua).not.toContain('soroban')
      expect(ua).toContain('Windows NT 10.0')
    })

    it('macOS：Electron/soroban を含まず、Chrome/メジャー版を含む', () => {
      const ua = buildUserAgent('darwin', '130')
      expect(ua).toContain('Chrome/130')
      expect(ua).not.toContain('Electron')
      expect(ua).not.toContain('soroban')
      expect(ua).toContain('Macintosh')
    })
  })

  describe('isChallengeText', () => {
    it('URLにcaptchaが含まれれば true', () => {
      expect(isChallengeText('https://jp.mercari.com/captcha?x=1', '')).toBe(true)
    })

    it('URLにchallenge / verify / /auth/ が含まれれば true', () => {
      expect(isChallengeText('https://jp.mercari.com/challenge', '')).toBe(true)
      expect(isChallengeText('https://jp.mercari.com/verify', '')).toBe(true)
      expect(isChallengeText('https://jp.mercari.com/auth/callback', '')).toBe(true)
    })

    it('hasCaptchaFrame が true なら常に true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '短い', true)).toBe(true)
    })

    it('本文が短く「ロボットではありません」を含めば true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '私はロボットではありません')).toBe(true)
    })

    it('本文が短く「認証コード」を含めば true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '認証コードを入力してください')).toBe(true)
    })

    it('大文字小文字を無視する（CAPTCHA）', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', 'CAPTCHA')).toBe(true)
    })

    it('マイページ本文（長文、「本人確認前」を含む）では false（本人確認だけでは止めない）', () => {
      const longBody = '本人確認前 '.repeat(300) + 'ここはマイページの通常の本文です'
      expect(longBody.length).toBeGreaterThanOrEqual(1500)
      expect(isChallengeText('https://jp.mercari.com/mypage/listings/sold', longBody)).toBe(false)
    })

    it('本文が長ければ「ロボットではありません」等が混ざっていても止めない', () => {
      const longBody = 'x'.repeat(1500) + 'ロボットではありません'
      expect(isChallengeText('https://jp.mercari.com/mypage/listings/sold', longBody)).toBe(false)
    })

    it('通常のページでは false', () => {
      expect(isChallengeText(
        'https://jp.mercari.com/mypage/listings/sold',
        '販売履歴の一覧です',
      )).toBe(false)
    })
  })

  describe('parseSoldRow', () => {
    const cells = ['タイトル欄', '¥8999', '¥899', '¥215', '---', '10%', '¥7885', '---', '2026/09/19']

    it('href から mercariItemId を抜き、¥ 表記の金額を数値に直す', () => {
      const row = parseSoldRow('/transaction/m87039845554', 'テスト商品', cells)
      expect(row).toEqual({
        mercariItemId: 'm87039845554',
        title: 'テスト商品',
        price: 8999,
        fee: 899,
        shippingFee: 215,
        otherCost: null,
        soldAt: '2026-09-19',
      })
    })

    it('「---」は null（他費用）', () => {
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', cells)?.otherCost).toBeNull()
    })

    it('送料 ¥0 は null ではなく 0（着払いの正当な実額）', () => {
      const zeroCells = [...cells]
      zeroCells[3] = '¥0'
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', zeroCells)?.shippingFee).toBe(0)
    })

    it('href に商品IDがなければ null', () => {
      expect(parseSoldRow('/mypage/listings/sold', 'テスト商品', cells)).toBeNull()
    })

    it('価格または購入完了日が読めなければ null', () => {
      const noDate = [...cells]
      noDate[8] = '---'
      expect(parseSoldRow('/transaction/m87039845554', 'テスト商品', noDate)).toBeNull()
    })
  })

  describe('parseSoldHtml（実DOM抜粋のfixture）', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'mercari-sold.html'), 'utf-8')
    const rows = parseSoldHtml(html)

    it('3行取れる', () => {
      expect(rows).toHaveLength(3)
    })

    it('1行目：m87039845554 / 8999 / 899 / 215 / 2026-09-19', () => {
      const r = rows[0]
      expect(r.mercariItemId).toBe('m87039845554')
      expect(r.price).toBe(8999)
      expect(r.fee).toBe(899)
      expect(r.shippingFee).toBe(215)
      expect(r.otherCost).toBeNull()
      expect(r.soldAt).toBe('2026-09-19')
    })

    it('3行目（キャバドレス）は送料 0（着払いの実額）', () => {
      const r = rows[2]
      expect(r.mercariItemId).toBe('m43306721545')
      expect(r.shippingFee).toBe(0)
      expect(r.soldAt).toBe('2020-04-16')
    })

    it('総件数（全18件）を抜く', () => {
      expect(extractTotalCount(html)).toBe(18)
    })
  })

  describe('extractTotalCount', () => {
    it('見つからなければ null', () => {
      expect(extractTotalCount('該当の記載なし')).toBeNull()
    })

    it('カンマ区切りの件数も読む', () => {
      expect(extractTotalCount('1件～20件（全1,234件）')).toBe(1234)
    })
  })
})
