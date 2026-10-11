# db.ts を Postgres に移すときの約束（Wave 2 の手引き）

`src/main/db.ts`（約 7,000 行）・`inbox.ts`・`views.ts` を `server/domain/*` に移す。
**画面（`src/renderer`）と契約（`src/shared/types.ts` の `SorobanApi`）は 1 文字も変えない。**
同じ入力で、デスクトップ版と同じ形・同じ値を返すのがゴール。

設計の全体は `00-architecture.md`。金額のビューは移植済み（`20261012000600_views.sql`、SQLite と全列一致を確認済み）。

---

## 1. ファイルの置き場所と持ち主

| ファイル | 中身（db.ts の関数） | 段 |
|---|---|---|
| `server/domain/_shared.ts` | 文字の正規化・検索の一致・並べ替え・日付（JST）・金額の文言・入力の検査・CSV・画像の URL・設定の読み出し・キーワード・タグの読み込みと派生 | 2a |
| `server/domain/master.ts` | タグ・仕入先アカウント・発送方法・設定・収集の実行記録（runs） | 2a |
| `server/domain/cash.ts` | 口座・借入・入出金・月のお金 | 2a |
| `server/domain/inventory.ts` | 在庫・分割・廃棄・紐付け（linkInventory / unlinkInventory）・候補 | 2b |
| `server/domain/listing.ts` | 出品・引き当て | 2b |
| `server/domain/sale.ts` | 販売・自動紐付け・取り込みの書き込み（insertCollected ほか） | 2b |
| `server/domain/purchase.ts` | 仕入・按分・配送・追跡・明細画像・店名の学習 | 2b |
| `server/domain/monthly.ts` | 月次・経費・月の締め | 2c |
| `server/domain/product.ts` | 商品（型番）・商品画像・履歴（timeline） | 2c |
| `server/domain/home.ts` | ホームの数字・健康診断・横断検索・CSV 書き出し | 2c |
| `server/domain/inbox.ts` / `views.ts` | `src/main/inbox.ts` / `views.ts` の移植 | 2c |
| `server/domain/index.ts` | 各ドメインを import するだけ（登録の副作用）。**親が 1 行ずつ足す** | 親 |

ドメイン同士の呼び出しは `import { linkInventory } from './inventory'` のように直接でよい（循環しても、
関数の中で呼ぶだけなら ESM で動く。モジュールの読み込み時に他のドメインの関数を呼ばないこと）。

**自分の担当でないファイルは編集しない。** 他のドメインに関数が足りなければ、報告に書いて返す。
スキーマ（`supabase/migrations`）に足りないものがあれば、**プロンプトで割り当てられた番号**で新しいファイルを足す
（既存のマイグレーションは書き換えない）。番号が割り当てられていなければ報告に書いて返す。

---

## 2. 関数の形

```ts
import type { Ctx } from '../context'

export async function listSales(ctx: Ctx, filter?: SaleFilter | null): Promise<SaleRow[]> {
  const rows = await ctx.sql.all<Row>(`select … from sale_profit where …`, …)
  …
}
```

- 第 1 引数は必ず `ctx`。SQL は `ctx.sql`（`get` / `all` / `run` / `tx`。better-sqlite3 と同じ形で、`await` が付くだけ）
- `search_path` は `app, public` なので、**テーブル名に `app.` は付けなくてよい**
- **`household_id` は書かない。** insert は既定値（セッションの世帯）で入り、select は RLS で自分の世帯だけになる。
  ただし**結合の条件には `household_id` を入れる**（複合外部キーと索引がそれ前提。ビューの書き方に揃える）
- ビューを `select *` で読まない。**列を選ぶ**（ビューの最後に `household_id` が付いているため）

### 登録（API として出す）

ファイルの最後で登録する。引数は**信用しない**（画面から JSON で来る）。

```ts
import { registerHandler } from '../rpc'

registerHandler('listSales', (ctx, filter) => listSales(ctx, filter ?? undefined))
```

- **`null` は `undefined` と同じに扱う。** HTTP クライアントは途中の `undefined` を `null` で送る
- 型が違う引数は `_shared.ts` の検査（`argText` / `argInt` / `argYen` / `argId` ほか）で `UserError` にする。
  SQL まで変な値を流して 500 にしない
- 契約の型（`HandlerFor<K>`）に合わない戻り値は型エラーになる。`as any` で黙らせない

### 1 リクエスト＝1 トランザクション

- ハンドラ全体がすでに 1 つのトランザクションの中。**例外を投げれば全部巻き戻る**
- `db.transaction(() => …)()` は、そのまま `await` の並びにすればよい。途中で失敗を握りつぶして続けたいときだけ
  `ctx.sql.tx(async (sql) => …)`（SAVEPOINT になる）
- **`Promise.all` で SQL を並べない。`arr.forEach(async …)` も禁止。** 1 本の接続の上なので順番に `await` する
  （`Sql` は並行に投げると例外にする）

### エラー

- 利用者に見せる日本語は **`UserError`**（`server/errors.ts`）。`throw new Error('日本語')` は 500 の
  「サーバーでエラーが起きました」に丸められて、文言が届かない
- 見つからない → `new UserError('…', 'not_found')`、状態の衝突 → `'conflict'`

---

## 3. SQL の書き換え（SQLite → Postgres）

| SQLite | Postgres | 注意 |
|---|---|---|
| `datetime('now')` | `now()` | |
| `date('now','localtime')` | `(now() at time zone 'Asia/Tokyo')::date` | 「今日」は**日本時間** |
| `substr(sold_at,1,7)` | `to_char(sold_at,'YYYY-MM')` | 日付は `date` 型 |
| `julianday(a) - julianday(b)` | `a - b`（`date` 同士は整数の日数） | |
| `IFNULL(a,b)` | `coalesce(a,b)` | |
| `MAX(a,b)`（2 引数） | `greatest(a,b)` | `MIN` は `least` |
| `GROUP_CONCAT(x, ',')` | `string_agg(x, ',')` | |
| `json_each(model_codes)` | `unnest(model_codes)` | `model_codes` は `text[]` |
| `json_extract(raw,'$.a')` | `raw->>'a'` | `raw` は `jsonb` |
| `INSERT OR IGNORE` | `insert … on conflict do nothing` | |
| `INSERT OR REPLACE` | `insert … on conflict (…) do update set …` | 衝突の列を明示 |
| `rowid` | 端数の順は `sale_line.allocation_order`。それ以外は `created_at, id` | |
| `"文字列"` | `'文字列'` | Postgres の `"…"` は列名 |
| `LIKE`（ASCII は大小を区別しない） | `ILIKE` | 検索の一致は JS 側（`matchesQuery`）なら関係ない |
| `ORDER BY x`（NULL が先頭） | `ORDER BY x nulls first` | **Postgres は昇順で NULL が末尾。** 並びを SQLite に揃える |
| `ORDER BY x DESC`（NULL が末尾） | `ORDER BY x desc nulls last` | 同上 |
| `COUNT(*)` / `SUM(int)` | そのまま（アダプタが number にする） | `avg()` は numeric＝**文字列**で返る。`round(avg(x))::int` にする |
| `GROUP BY` で集約していない列 | 全部 `GROUP BY` に入れる（主キーで決まる列は不要） | |
| `changes` | `run()` の戻り `{ changes }` | |

### 列の名前が変わったもの

| SQLite | Postgres | 契約（画面）に返すとき |
|---|---|---|
| `sale.mercari_item_id` / `listing.mercari_item_id` | `channel_item_id` | **契約の名前（`mercari_item_id`）で返す**：`channel_item_id as mercari_item_id` |
| `listing` の主キー `mercari_item_id` | `id uuid` ＋ `unique (household_id, channel, channel_item_id)` | 画面は商品 ID（`channel_item_id`）で呼ぶ。`listing_line.listing_id` は `listing.id`（uuid）で**別物** |
| `thumb_file` | `thumb_path` | 画面には `mediaUrl(ctx, thumb_path)` |
| `purchase_line.image_file` | `image_path` | 同上 |
| `expense.receipt_file` | `receipt_path` | レシートは非公開（後の段） |
| `model_codes`（JSON の文字列） | `text[]` | 配列のまま |
| `raw`（文字列） | `jsonb` | 書くときは `JSON.stringify(x)` を渡す（アダプタはオブジェクトを断る） |

### 日付と時刻

| 型 | 返る値 |
|---|---|
| `date` | `'YYYY-MM-DD'`（アダプタがそのまま） |
| `timestamptz` | `'2026-10-12T03:04:05.123Z'`（UTC の ISO） |

- **契約の文字列の形を変えない。** デスクトップ版が日本時間の素の文字列で返していた列（`sale.purchased_at` の
  `'YYYY-MM-DD HH:MM'` など）は、SQL で `to_char(x at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI')` に戻す。
  画面が `slice(0, 10)` で日付を取るので、UTC の ISO のまま返すと日本時間の 0〜9 時に 1 日ずれる
- デスクトップ版が `datetime('now')`（UTC の `'YYYY-MM-DD HH:MM:SS'`）で返していた列は ISO のままでよい
  （画面は `new Date()` で読む。ISO の方が正しく読める）
- **サーバー（Cloudflare Workers）のタイムゾーンは UTC。** `new Date().getDate()`・`todayLocal()`（`src/shared/date.ts`）
  は**使わない**。`_shared.ts` の `todayJst()` / `thisMonthJst()` / `subtractDaysJst()` を使う。
  `pnpm test:server` は `TZ=UTC` で回る（Workers と同じ）ので、ここを間違えるとテストで分かる

---

## 4. 画像（Storage）

- バケット **`media`（公開）**：販売・出品のサムネイル、仕入明細の画像、商品画像。パスは
  `<household_id>/<種類>/<ランダムな id>.<拡張子>`（推測できない）。中身はフリマ・仕入先で公開されている商品写真
- バケット **`receipts`（非公開）**：レシート。見るときだけ署名 URL（後の段）
- 画面に返す URL は `mediaUrl(ctx, path)`（`path` が null なら null）。デスクトップ版の `toThumbUrl` の置き換え
- 署名 URL にしない理由：署名は毎回変わるので、一覧を開くたびにスマホが全画像を取り直す（キャッシュが効かない）

---

## 5. テスト

- 置き場所：`server/__tests__/domain/<ドメイン>.test.ts`（大きければ分けてよい）
- DB：`server/test/migrate.ts` の `createMigratedDb()`（PGlite に本物のマイグレーションを全部流したもの）
- 世帯：`app.create_household` で **A と B の 2 世帯**を作り、`withHousehold` の中で呼ぶ
- **`src/main/__tests__/db.test.ts` の該当する `describe` を移す。期待値は変えない**（変えたら、なぜかを報告に書く）。
  これがデスクトップ版と同じ振る舞いである証拠になる
- 足すもの：
  - **世帯の分離**：B から A の行が見えない・書けない（id を知っていても）
  - **金額**：按分・均等割りは合計が一致することを数字で
  - **引数の検査**：変な型を渡したら `UserError`（500 にならない）
- `pnpm test:server` が全部通ること。`pnpm typecheck` が通ること。**デスクトップ版の `pnpm test` を落とさないこと**

---

## 6. やらないこと

- `src/shared/types.ts` を変えない（足りなければ報告）
- 画面（`src/renderer`）に手を入れない（Wave 2 では）
- 利益を JS で計算し直さない。ビュー（`sale_profit` / `monthly_summary` / `sale_line_share` / `variant_summary` /
  `inventory_view`）から読む
- `CLAUDE.md` の「絶対に守ること」はすべてそのまま（金額は円の整数、`landed_cost` を書き換えない、
  紐付けを自動確定しない（例外 3 つ）、按分の端数は最終行、実績と見込みを分ける、取得 0 件を成功にしない）
