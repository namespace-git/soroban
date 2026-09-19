import { describe, expect, it, vi } from 'vitest'

// collector.ts は electron（BrowserWindow・session）に依存する。
// ここで検証するのは electron に依存しない純粋関数だけなので、import を通すために潰しておく
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({ setUserAgent: () => {} }) },
}))

import {
  buildUserAgent, isChallengeText, parseDetailText, randomWaitMs,
} from '../collector'

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

    it('本文に「本人確認」が含まれれば true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', 'ご本人確認をお願いします')).toBe(true)
    })

    it('本文に「ロボットではありません」が含まれれば true', () => {
      expect(isChallengeText('https://jp.mercari.com/mypage', '私はロボットではありません')).toBe(true)
    })

    it('大文字小文字を無視する（CAPTCHA）', () => {
      expect(isChallengeText('https://jp.mercari.com/CAPTCHA', '')).toBe(true)
    })

    it('通常のページでは false', () => {
      expect(isChallengeText(
        'https://jp.mercari.com/mypage/listings/completed',
        '売却済みの商品一覧です',
      )).toBe(false)
    })
  })

  describe('parseDetailText', () => {
    it('「販売手数料 ¥390」から390を抜く', () => {
      expect(parseDetailText('販売手数料 ¥390').fee).toBe(390)
    })

    it('「送料210円」から210を抜く', () => {
      expect(parseDetailText('送料210円').shippingFee).toBe(210)
    })

    it('両方を同時に抜く', () => {
      const r = parseDetailText('商品代金 ¥3,900 販売手数料 ¥390 送料 700円 合計')
      expect(r.fee).toBe(390)
      expect(r.shippingFee).toBe(700)
    })

    it('見つからなければ null（feeもshippingFeeも）', () => {
      const r = parseDetailText('説明文だけのテキストです')
      expect(r.fee).toBeNull()
      expect(r.shippingFee).toBeNull()
    })

    it('0円は実額として返さない（null）', () => {
      expect(parseDetailText('送料 ¥0（送料込み）').shippingFee).toBeNull()
    })

    it('カンマ区切りの金額も数値に直す', () => {
      expect(parseDetailText('販売手数料 ¥1,234').fee).toBe(1234)
    })
  })
})
