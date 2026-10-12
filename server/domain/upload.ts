import type { Ctx } from '../context'
import { registerWebHandler } from '../rpc'
import { bucketOfKind, newUploadPath, UPLOAD_EXTS, UPLOAD_KINDS } from '../storage'
import type { UploadExt, UploadKind, UploadTarget } from '../../src/shared/web-types'
import { argEnum } from './_shared'

// ============================================================
// 画像のアップロードの置き場所（Web 版だけ）
//
// 流れ：画面が prepareUpload で置き場所をもらう → Storage に直接上げる（ログイン中の人の権限。
// Storage の方針で自分の世帯のフォルダにしか書けない）→ attachReceiptPath／readReceiptAt／createExpense の
// receipt_temp_file／setProductImagePath でパスを帳簿に結ぶ。
// パスは**サーバーが**世帯のフォルダの中に乱数（uuid）で作る（画面はパスを組み立てない）。
// 受け取る側（monthly.ts・product.ts）は `assertUploadPath` で、同じ形のものだけを通す。
// ============================================================

/**
 * 置き場所を決める。レシート（receipt）は非公開の receipts バケット、商品画像（product）は公開の media バケット。
 * 何も書き込まない（行も作らない）。上げられなかった・使われなかったファイルは後で回収する
 */
export async function prepareUpload(ctx: Ctx, kind: UploadKind, ext: UploadExt): Promise<UploadTarget> {
  const k = argEnum('画像の種類', kind, UPLOAD_KINDS)
  const e = argEnum('画像の形式', ext, UPLOAD_EXTS)
  return { bucket: bucketOfKind(k), path: newUploadPath(ctx, k, e) }
}

registerWebHandler('prepareUpload', (ctx, kind, ext) => prepareUpload(ctx, kind, ext))
