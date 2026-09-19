// ============================================================
// 型番（メロジョイの商品コード）・素材・数量の抽出
//
// electron に依存しない純粋関数。db.ts から呼ばれる。
// メロジョイの商品名・バリアント名には【Z078-2】【A035】の形でコードが入っている。
// Shopify の SKU・product ID・variant ID は販売のたびに作り直されるため
// 主キーにしない。安定しているのは商品名の中のコードだけ。
// ============================================================

import type { Material, ProductCode } from '../shared/types'

/** 商品名の【】内のコード。仕入側（メロジョイの商品名）で使う */
export const CODE_RE = /【([A-Z]\d{3}(?:-\d+)?)】/
/** 【】なしでも拾う。販売側（メルカリのタイトル）で使う */
export const CODE_LOOSE_RE = /\b([A-Z]\d{3}(?:-\d+)?)\b/g

const MATERIALS: Material[] = [
  'ムースクリーム',
  'ねっとりヨーグルト',
  'もちもちもち',
  'クリーミークリーム',
]

/**
 * 商品名・バリアント名からコードを1つ抜く。
 * バリアント名に【】があればそれが最小単位。なければ商品名側の【】が最小単位
 * （`Z048-10` を「Z048 の 10 番」と解釈しない）。
 * series_code はハイフンの前。枝番なしなら model_code と同じ。
 */
export function extractCode(productTitle: string, variantTitle?: string | null): ProductCode | null {
  const variantMatch = variantTitle ? CODE_RE.exec(variantTitle) : null
  const match = variantMatch ?? CODE_RE.exec(productTitle)
  if (!match) return null

  const model_code = match[1]
  const series_code = model_code.split('-')[0]
  return { model_code, series_code }
}

/**
 * 販売タイトル・説明文からコードをすべて抜く。【】付き・なし両方に対応し、
 * 重複を除いて出現順に返す。
 */
export function extractCodes(text: string): string[] {
  const combined = new RegExp(`${CODE_RE.source}|${CODE_LOOSE_RE.source}`, 'g')
  const seen = new Set<string>()
  const result: string[] = []

  let m: RegExpExecArray | null
  while ((m = combined.exec(text))) {
    const code = m[1] ?? m[2]
    if (!seen.has(code)) {
      seen.add(code)
      result.push(code)
    }
  }
  return result
}

/**
 * 素材を名前から抜く。最初に現れたものを採用する。
 * variantTitle と productTitle の両方を見る場合は呼び出し側で連結して渡すこと。
 */
export function extractMaterial(text: string): Material | null {
  let best: { material: Material; index: number } | null = null
  for (const material of MATERIALS) {
    const index = text.indexOf(material)
    if (index !== -1 && (best === null || index < best.index)) {
      best = { material, index }
    }
  }
  return best?.material ?? null
}

/**
 * バリアント名の数量表記（'2 * ボックス' '3*ボックス'）から数量を取る。
 * 数量表記がなければ 1（A/B系は箱のままが1点）。
 */
export function extractQuantity(variantTitle: string | null | undefined): number {
  if (!variantTitle) return 1
  const m = /(\d+)\s*\*/.exec(variantTitle)
  return m ? Number(m[1]) : 1
}

/** 装飾・コード・数量表記を落とし、素材で区別できる形に整える */
function stripDecorations(s: string): string {
  let out = s.replace(/^\s*Mellojoy\s*-\s*/i, '')
  // 【】で囲まれた部分（コード・注意書き）をすべて落とす
  out = out.replace(/【[^】]*】/g, '')
  // 二重ブラケット（【【 …】】）の片割れなど、残った【】単体も落とす
  out = out.replace(/[【】]/g, '')
  // 数量表記（'2 * ボックス' 等）
  out = out.replace(/\d+\s*\*\s*\S+/g, '')
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * 在庫の表示名。素材を必ず含める（Z056-1/Z056-2 は素材でしか区別できない）。
 * 'Mellojoy - ' 接頭・装飾用の【】を落とし、「型番 素材 名前」の形にする。
 * variantTitle に固有の名前が残っていればそちらを優先する。
 */
export function displayName(productTitle: string, variantTitle?: string | null): string {
  const code = extractCode(productTitle, variantTitle)
  const material = extractMaterial((variantTitle ?? '') + productTitle)

  const clean = (s: string): string => {
    const stripped = stripDecorations(s)
    return material ? stripped.replace(material, '').trim() : stripped
  }

  const variantName = variantTitle ? clean(variantTitle) : ''
  const productName = clean(productTitle)
  const name = variantName || productName

  return [code?.model_code, material, name].filter(Boolean).join(' ')
}
