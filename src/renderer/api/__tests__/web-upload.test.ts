// api/web.ts の画像 3 本（attachReceipt・readReceiptImage・setProductImage）の流れ。
// 本物の createImageUploader に、偽の ImageEnv・偽の Storage・偽の WebApi をつないで通す
import { describe, it, expect, vi } from 'vitest'
import type { ReceiptRead, SorobanApi } from '../../../shared/types'
import type { UploadKind, UploadTarget, WebApi } from '../../../shared/web-types'
import { createWebSoroban } from '../web'
import type { WebEnv } from '../web'
import { createImageUploader } from '../upload'
import type { ImageEnv, StorageLike } from '../upload'

const noopEnv: WebEnv = { open() {}, openPending: () => null, download() {}, now: () => new Date(2026, 9, 12) }

const READ: ReceiptRead = {
  temp_file: 'hh-1/receipt/r1.jpg',
  receipt_url: 'https://example.supabase.co/storage/v1/object/sign/receipts/hh-1/receipt/r1.jpg?token=t',
  draft: {
    shop: 'ダイソー', occurred_at: '2026-10-11', total: 330, tax: 30, lines: [], warnings: [], raw_text: '', registration_no: null,
    shop_learned: false, boxes: null,
  } as unknown as ReceiptRead['draft'],
}

function setup(opts: { file?: File | null; uploadError?: unknown } = {}) {
  const order: string[] = []
  const file = opts.file === undefined ? new File([new Uint8Array(2000)], 'r.jpg', { type: 'image/jpeg' }) : opts.file

  const imageEnv: ImageEnv = {
    pickFile: () => { order.push('pick'); return Promise.resolve(file) },
    decode: async () => ({ width: 3000, height: 4000, source: {} as CanvasImageSource, close() {} }),
    encodeJpeg: async () => new Blob([new Uint8Array(800)], { type: 'image/jpeg' }),
  }
  const uploads: Array<{ bucket: string; path: string }> = []
  const removed: Array<{ bucket: string; paths: string[] }> = []
  const storage: StorageLike = {
    from: (bucket) => ({
      upload: async (path) => {
        order.push('upload')
        uploads.push({ bucket, path })
        return { error: (opts.uploadError ?? null) as null }
      },
      remove: async (paths) => { removed.push({ bucket, paths }); return { error: null } },
    }),
  }

  const web = {
    prepareUpload: vi.fn(async (kind: UploadKind, ext: string): Promise<UploadTarget> => {
      order.push(`prepare:${kind}:${ext}`)
      return kind === 'receipt'
        ? { bucket: 'receipts', path: `hh-1/receipt/r1.${ext}` }
        : { bucket: 'media', path: `hh-1/product/p1.${ext}` }
    }),
    attachReceiptPath: vi.fn(async () => 'https://example.supabase.co/signed/r1.jpg'),
    readReceiptAt: vi.fn(async () => READ),
    setProductImagePath: vi.fn(async () => true),
  }
  const base = { attachReceipt: vi.fn(), readReceiptImage: vi.fn(), setProductImage: vi.fn() }
  const soroban = createWebSoroban(
    base as unknown as SorobanApi, web as unknown as WebApi, noopEnv, createImageUploader(storage, imageEnv),
  )
  return { soroban, web, base, uploads, removed, order }
}

describe('画像を選んで上げる 3 本', () => {
  describe('attachReceipt(id)', () => {
    it('選ぶ → 縮める → prepareUpload → Storage → attachReceiptPath → 表示用の URL', async () => {
      const t = setup()
      const url = await t.soroban.attachReceipt('exp-1')
      expect(url).toBe('https://example.supabase.co/signed/r1.jpg')
      expect(t.order).toEqual(['pick', 'prepare:receipt:jpg', 'upload'])
      expect(t.uploads).toEqual([{ bucket: 'receipts', path: 'hh-1/receipt/r1.jpg' }])
      expect(t.web.attachReceiptPath).toHaveBeenCalledWith('exp-1', 'hh-1/receipt/r1.jpg')
      // デスクトップの IPC（base）には行かない
      expect(t.base.attachReceipt).not.toHaveBeenCalled()
    })

    it('呼んだ瞬間（await の前）にファイル選択を開く', () => {
      const t = setup()
      void t.soroban.attachReceipt('exp-1')
      expect(t.order).toEqual(['pick'])
    })

    it('選ばなければ null。何も上げず、結び付けもしない', async () => {
      const t = setup({ file: null })
      expect(await t.soroban.attachReceipt('exp-1')).toBeNull()
      expect(t.web.prepareUpload).not.toHaveBeenCalled()
      expect(t.uploads).toEqual([])
      expect(t.web.attachReceiptPath).not.toHaveBeenCalled()
    })

    it('結び付けが失敗したらそのまま投げる。上げたものは消さない（返事が届かないだけかもしれない）', async () => {
      const t = setup()
      t.web.attachReceiptPath.mockRejectedValue(new Error('経費が見つかりません'))
      await expect(t.soroban.attachReceipt('exp-x')).rejects.toThrow('経費が見つかりません')
      expect(t.removed).toEqual([])
    })

    it('Storage に上げられなかったら日本語のエラーで、結び付けない', async () => {
      const t = setup({ uploadError: { message: 'Failed to fetch' } })
      await expect(t.soroban.attachReceipt('exp-1')).rejects.toThrow('画像を上げられませんでした')
      expect(t.web.attachReceiptPath).not.toHaveBeenCalled()
    })
  })

  describe('readReceiptImage()', () => {
    it('選ぶ → 縮める → 上げる → readReceiptAt(path) → ReceiptRead（temp_file は path のまま）', async () => {
      const t = setup()
      const read = await t.soroban.readReceiptImage()
      expect(read).toBe(READ)
      expect(read?.temp_file).toBe('hh-1/receipt/r1.jpg')
      expect(t.order).toEqual(['pick', 'prepare:receipt:jpg', 'upload'])
      expect(t.web.readReceiptAt).toHaveBeenCalledWith('hh-1/receipt/r1.jpg')
      expect(t.base.readReceiptImage).not.toHaveBeenCalled()
    })

    it('呼んだ瞬間（await の前）にファイル選択を開く', () => {
      const t = setup()
      void t.soroban.readReceiptImage()
      expect(t.order).toEqual(['pick'])
    })

    it('選ばなければ null', async () => {
      const t = setup({ file: null })
      expect(await t.soroban.readReceiptImage()).toBeNull()
      expect(t.web.readReceiptAt).not.toHaveBeenCalled()
    })

    it('読み取りが失敗したら、上げたレシートを消してからエラーを投げる（経費にはまだ付けていない）', async () => {
      const t = setup()
      t.web.readReceiptAt.mockRejectedValue(new Error('AI 読み取りの設定がありません'))
      await expect(t.soroban.readReceiptImage()).rejects.toThrow('AI 読み取りの設定がありません')
      expect(t.removed).toEqual([{ bucket: 'receipts', paths: ['hh-1/receipt/r1.jpg'] }])
    })

    it('読み取りが成功したら消さない（登録のときに createExpense が付ける）', async () => {
      const t = setup()
      await t.soroban.readReceiptImage()
      expect(t.removed).toEqual([])
    })
  })

  describe('setProductImage(modelCode)', () => {
    it('選ぶ → 縮める（商品画像）→ prepareUpload(product) → media に上げる → setProductImagePath → true', async () => {
      const t = setup()
      expect(await t.soroban.setProductImage('A037')).toBe(true)
      expect(t.order).toEqual(['pick', 'prepare:product:jpg', 'upload'])
      expect(t.uploads).toEqual([{ bucket: 'media', path: 'hh-1/product/p1.jpg' }])
      expect(t.web.setProductImagePath).toHaveBeenCalledWith('A037', 'hh-1/product/p1.jpg')
      expect(t.base.setProductImage).not.toHaveBeenCalled()
    })

    it('呼んだ瞬間（await の前）にファイル選択を開く', () => {
      const t = setup()
      void t.soroban.setProductImage('A037')
      expect(t.order).toEqual(['pick'])
    })

    it('選ばなければ false（デスクトップのキャンセルと同じ）', async () => {
      const t = setup({ file: null })
      expect(await t.soroban.setProductImage('A037')).toBe(false)
      expect(t.web.setProductImagePath).not.toHaveBeenCalled()
    })

    it('サーバーが false を返したらそのまま false', async () => {
      const t = setup()
      t.web.setProductImagePath.mockResolvedValue(false)
      expect(await t.soroban.setProductImage('A037')).toBe(false)
    })
  })

  it('uploader を渡さないとき（モックの画面確認）は、これまでどおり base にそのまま通す', async () => {
    const base = { attachReceipt: vi.fn(async () => '/mock/receipt.svg') }
    const soroban = createWebSoroban(base as unknown as SorobanApi, {} as WebApi, noopEnv)
    expect(await soroban.attachReceipt('e1')).toBe('/mock/receipt.svg')
  })
})
