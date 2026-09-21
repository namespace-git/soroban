import { describe, expect, it } from 'vitest'
import {
  CODE_LOOSE_RE, CODE_RE, displayName, extractCode, extractCodeQuantities, extractCodes,
  extractItemCodes, extractMaterial, extractQuantity,
} from '../code'

describe('code（型番・素材・数量の抽出）', () => {
  describe('正規表現そのもの', () => {
    it('CODE_RE は【】付きコードにマッチする', () => {
      expect(CODE_RE.exec('【Z078-2】')?.[1]).toBe('Z078-2')
      expect(CODE_RE.exec('【A035】')?.[1]).toBe('A035')
      expect(CODE_RE.exec('コードなし')).toBeNull()
    })

    it('CODE_LOOSE_RE は【】なしでもマッチする', () => {
      CODE_LOOSE_RE.lastIndex = 0
      expect(CODE_LOOSE_RE.exec('クリームわん Z078-2 未使用')?.[1]).toBe('Z078-2')
    })
  })

  describe('extractCode', () => {
    it('バリアント名に【】があればそれが最小単位（Z080 → Z080-1）', () => {
      expect(extractCode('Mellojoy - クリームわん【Z080】', '【Z080-1】ねっとりヨーグルト'))
        .toEqual({ model_code: 'Z080-1', series_code: 'Z080' })
    })

    it('バリアント名に【】がなければ商品名側のコードが最小単位（Z072-8）', () => {
      expect(extractCode('Mellojoy - いちごスフレ【Z072-8】', '1 * ボックス'))
        .toEqual({ model_code: 'Z072-8', series_code: 'Z072' })
    })

    it('枝番なしなら series_code は model_code と同じ（A035）', () => {
      expect(extractCode('Mellojoy - ミニランド【A035】', '2 * ボックス'))
        .toEqual({ model_code: 'A035', series_code: 'A035' })
    })

    it('Z048-10 を「Z048 の 10 番」と解釈しない（ハイフン付きのまま1つのコード）', () => {
      expect(extractCode('Mellojoy - なにか【Z048-10】', null))
        .toEqual({ model_code: 'Z048-10', series_code: 'Z048' })
    })

    it('Z001-4 も同様に枝番まで1つのコードとして抜く', () => {
      expect(extractCode('Mellojoy - なんとかシリーズ【Z001-4】', null))
        .toEqual({ model_code: 'Z001-4', series_code: 'Z001' })
    })

    it('コードが見つからなければ null', () => {
      expect(extractCode('コードなしの商品名', null)).toBeNull()
    })

    it('variantTitle がなければ productTitle 側だけを見る', () => {
      expect(extractCode('Mellojoy - なにか【Z088-2】')).toEqual({
        model_code: 'Z088-2', series_code: 'Z088',
      })
    })
  })

  describe('extractCodes（販売タイトル用）', () => {
    it('【】付きのコードを拾う', () => {
      expect(extractCodes('【Z080-1】クリームわん')).toEqual(['Z080-1'])
    })

    it('【】なしでもタイトルからコードを拾う', () => {
      expect(extractCodes('クリームわん Z078-2 未使用')).toEqual(['Z078-2'])
    })

    it('複数型番（まとめ売り）を出現順ですべて拾う', () => {
      expect(extractCodes('【Z080-1】【Z088-2】まとめ売り')).toEqual(['Z080-1', 'Z088-2'])
    })

    it('重複は除いて1つにする', () => {
      expect(extractCodes('【Z080-1】クリームわん Z080-1 セット')).toEqual(['Z080-1'])
    })

    it('コードがなければ空配列', () => {
      expect(extractCodes('私物の売却です')).toEqual([])
    })
  })

  describe('extractItemCodes（在庫コード）', () => {
    it('【】付きの在庫コードを複数拾う', () => {
      expect(extractItemCodes('【S-0012】【S-0013】')).toEqual(['S-0012', 'S-0013'])
    })

    it('【】なしでも拾う', () => {
      expect(extractItemCodes('S-0012 と S-0040')).toEqual(['S-0012', 'S-0040'])
    })

    it('重複は除いて1つにする', () => {
      expect(extractItemCodes('【S-0012】S-0012')).toEqual(['S-0012'])
    })

    it('在庫コードが無ければ空配列（型番だけでは拾わない）', () => {
      expect(extractItemCodes('【Z078-2】いちごスフレ')).toEqual([])
    })
  })

  describe('extractCodeQuantities（型番直後の個数表記）', () => {
    it('【Z078-2】×2 → qty 2', () => {
      expect(extractCodeQuantities('【Z078-2】×2')).toEqual([{ code: 'Z078-2', qty: 2 }])
    })

    it('Z078-2 2個セット → qty 2', () => {
      expect(extractCodeQuantities('Z078-2 2個セット')).toEqual([{ code: 'Z078-2', qty: 2 }])
    })

    it('Z078-2 100円 → 単位が違う数字は個数と見なさず qty 1', () => {
      expect(extractCodeQuantities('Z078-2 100円')).toEqual([{ code: 'Z078-2', qty: 1 }])
    })

    it('個数表記が無ければ qty 1', () => {
      expect(extractCodeQuantities('【Z078-2】いちごスフレ')).toEqual([{ code: 'Z078-2', qty: 1 }])
    })

    it('x2・✕2 も半角×と同様に拾う', () => {
      expect(extractCodeQuantities('Z078-2 x2')).toEqual([{ code: 'Z078-2', qty: 2 }])
      expect(extractCodeQuantities('Z078-2 ✕2')).toEqual([{ code: 'Z078-2', qty: 2 }])
    })

    it('2点セット も個数表記として拾う', () => {
      expect(extractCodeQuantities('Z078-2 2点セット')).toEqual([{ code: 'Z078-2', qty: 2 }])
    })

    it('複数型番はそれぞれの個数を拾う', () => {
      expect(extractCodeQuantities('【Z080-1】【Z088-2】×3')).toEqual([
        { code: 'Z080-1', qty: 1 },
        { code: 'Z088-2', qty: 3 },
      ])
    })
  })

  describe('extractMaterial', () => {
    it('Z056-1 と Z056-2 を素材で区別する', () => {
      expect(extractMaterial('【Z056-1】ムースクリーム ふわふわパンダ')).toBe('ムースクリーム')
      expect(extractMaterial('【Z056-2】ねっとりヨーグルト ふわふわパンダ')).toBe('ねっとりヨーグルト')
    })

    it('複数の素材語があれば最初に現れたものを採用する', () => {
      expect(extractMaterial('もちもちもちのあとにクリーミークリーム')).toBe('もちもちもち')
    })

    it('見つからなければ null', () => {
      expect(extractMaterial('素材の記載なし【A035】')).toBeNull()
    })
  })

  describe('extractQuantity', () => {
    it("'2 * ボックス' → 2", () => {
      expect(extractQuantity('2 * ボックス')).toBe(2)
    })
    it("'3*ボックス'（空白なし） → 3", () => {
      expect(extractQuantity('3*ボックス')).toBe(3)
    })
    it("'1 * ボックス' → 1", () => {
      expect(extractQuantity('1 * ボックス')).toBe(1)
    })
    it('数量表記がなければ 1', () => {
      expect(extractQuantity('ねっとりヨーグルト')).toBe(1)
    })
    it('未指定（null/undefined）でも 1', () => {
      expect(extractQuantity(null)).toBe(1)
      expect(extractQuantity(undefined)).toBe(1)
    })
  })

  describe('displayName', () => {
    it('型番・素材・名前をこの順で組み立てる（Z080-1）', () => {
      expect(displayName(
        'Mellojoy - クリームわん【Z080】【【 ブラインドボックスのおもちゃ】】',
        '【Z080-1】ねっとりヨーグルト',
      )).toBe('Z080-1 ねっとりヨーグルト クリームわん')
    })

    it('素材がなければ型番と名前だけになる（A035・2箱）', () => {
      expect(displayName(
        'Mellojoy - ミニランド【A035】【【 ブラインドボックスのおもちゃ】】',
        '2 * ボックス',
      )).toBe('A035 ミニランド')
    })

    it('Z056-1 と Z056-2 は同じ商品名でも素材で表示名が変わる', () => {
      const product = 'Mellojoy - ふわふわパンダ【Z056】【 開封後のキャンセルができません】'
      expect(displayName(product, '【Z056-1】ムースクリーム'))
        .toBe('Z056-1 ムースクリーム ふわふわパンダ')
      expect(displayName(product, '【Z056-2】ねっとりヨーグルト'))
        .toBe('Z056-2 ねっとりヨーグルト ふわふわパンダ')
    })

    it('variantTitle がなくても productTitle だけで組み立てられる', () => {
      expect(displayName('Mellojoy - いちごスフレ【Z072-8】')).toBe('Z072-8 いちごスフレ')
    })
  })
})
