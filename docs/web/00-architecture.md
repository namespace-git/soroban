# そろばん Web 化 — 設計

2026-10-12 起草（ブランチ `web`）。**`main` とリリース中のデスクトップ版には一切影響させない。**

## 利用者の要望（原文の要約）

- スマホでも使えるように。**レスポンシブ**
- **取り込みは PC で起動しているどこかの端末から**。同時・連続で走らないよう制御する
- **認証は ID/パスワード**。事前に Supabase に登録されたアカウントのみ
- **Supabase / Cloudflare Pages で Web アプリ・PWA 化**
- **Push 通知**（ステータス変更・追加など）
- これを機に **UI/UX・使い方・DB を見直す**

---

## 全体像

```
 スマホ／PC のブラウザ（PWA）
   Vue 3（既存の src/renderer をほぼそのまま使う）
   window.soroban = HTTP クライアント（SorobanApi の契約はそのまま）
   ログイン = Supabase Auth（メール＋パスワード。サインアップは無効）
        │  Authorization: Bearer <JWT>
        ▼
 Cloudflare Pages
   ├─ 静的配信（manifest.webmanifest / service worker）
   └─ Pages Functions  POST /api/rpc/<method>
        ・JWT を検証 → household のメンバーか確認
        ・1 リクエスト＝1 トランザクション。SET app.household_id
        ・業務ロジック（server/ … db.ts を非同期 Postgres に移植したもの）
        ・Web Push の送信（waitUntil）
        ▼
 Supabase
   ├─ Postgres  … 全テーブルに household_id。RLS で household を強制
   ├─ Auth      … メール＋パスワードのみ。サインアップ無効
   └─ Storage   … サムネイル・レシート・商品画像（非公開バケット＋署名 URL）

 PC の Electron（取り込み担当 ＝「エージェント」）
   ・同じアカウントでログインして待機
   ・取り込み要求（collect_job）を原子的に 1 本取って実行
   ・結果は API 経由で書く（業務ロジックはサーバー 1 か所だけ）
```

### なぜこの形か

1. **API の契約（`src/shared/types.ts` の `SorobanApi`）を変えない。** 126 本の境界がすでにきれいに切れている。
   画面は `window.soroban` の中身を差し替えるだけで動く。**モック（`soroban-mock.ts`）もそのまま使える**
2. **業務ロジックはサーバー 1 か所。** 画面もエージェントも同じ API を叩く。按分・紐付け・金額の規則が
   2 か所に分かれない（`CLAUDE.md`：レンダラー側で利益を再計算しない、の延長）
3. **household（世帯）を最初から持つ。** いまは夫婦 1 世帯だが、外販するなら複数世帯になる。
   後から足すと全テーブルの作り直しになるので、最初に入れる

---

## テナント分離（いちばん大事な安全装置）

**全テーブルに `household_id uuid not null`。** 値は既定でセッション変数から入る。

```sql
household_id uuid not null default (current_setting('app.household_id')::uuid)
```

API は 1 リクエストごとに

```sql
begin;
select set_config('app.household_id', $1, true);   -- その人の世帯
-- 業務ロジック
commit;
```

**RLS（行レベルセキュリティ）で世帯を強制する。**

```sql
alter table sale enable row level security;
create policy household_isolation on sale
  using (household_id = current_setting('app.household_id', true)::uuid)
  with check (household_id = current_setting('app.household_id', true)::uuid);
```

- API が DB につなぐロールは **`soroban_api`（BYPASSRLS なし）**。クエリが世帯の絞り込みを
  書き忘れても、**RLS が他の世帯の行を返さない**
- ビューは `security_invoker = true`（PG15+）で、ビュー越しにも RLS が効く
- Supabase の `anon` / `authenticated` ロールには**何も許可しない**（PostgREST からは 1 行も読めない）。
  データは必ず API を通る
- **移植が楽になる。** SQLite の SQL に `WHERE household_id = ?` を足して回らなくてよい

## 認証

- Supabase Auth のメール＋パスワード。**サインアップは管理画面で無効にする**
- さらに API 側で **`household_member` に載っている人だけ**を通す
  （サインアップを誤って有効にしても、世帯に属していなければ何も見えない）
- アカウントの作成は Supabase の管理画面（または `supabase/seed` のスクリプト）で人が行う

---

## 取り込み（同時・連続の制御）

```sql
create table collect_job (
  id uuid primary key,
  household_id uuid not null,
  requested_by uuid,               -- 押した人
  requested_at timestamptz not null default now(),
  status text not null check (status in ('queued','running','done','failed','cancelled')),
  agent_id text,                   -- 取った PC
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  result jsonb                     -- CollectorRun[] と配送状況の要約
);
-- 同時に走らせない：世帯ごとに queued/running は 1 本だけ
create unique index collect_job_one_active on collect_job (household_id)
  where status in ('queued','running');
```

| 規則 | 実装 |
|---|---|
| **同時に走らない** | 上の部分ユニーク索引。2 本目の要求は「取り込み中です」で断る |
| **連続で走らない** | 直近の完了から **10 分**は新しい要求を断る（`CLAUDE.md`：収集頻度を上げない）。設定で変えられる |
| **1 台だけが取る** | `for update skip locked` で 1 本を原子的に取る（RPC `claim_collect_job`） |
| **PC が落ちたら** | ハートビート（30 秒ごと）が 3 分途切れたら `failed` にして、次の要求を受けられるようにする |
| **時間ごとの自動取り込みは無い** | 今まで通り。人がボタンを押したときと、エージェントの起動時だけ |

エージェントは 20 秒ごとに「取れる要求があるか」を聞く（ポーリング。単純で壊れにくい）。

---

## Push 通知

- **Web Push（VAPID）。** iPhone はホーム画面に追加した PWA で受け取れる（iOS 16.4+）
- `push_subscription`（人ごと・端末ごと）
- `notification_outbox` … 出来事を**業務ロジックと同じトランザクションで**書く。送信は API が
  コミットの後に `waitUntil` で行う（送信の失敗で業務の書き込みが巻き戻らない）
- 通知する出来事（最初の版）

| 出来事 | 例 |
|---|---|
| 販売が増えた | 「売れました：【A040】もこ山 スクイーズ ¥5,750」 |
| 発送の番になった | 「発送してください：2 件」 |
| 取り込みが終わった／失敗した | 「メルカリにログインが必要です」 |
| 仕入が届いた（17TRACK） | 「メロジョイの荷物が届きました」 |

- 通知の種類ごとに設定で切れる

---

## DB の見直し（移すついでに直すもの）

| 今 | 新 | 理由 |
|---|---|---|
| `mercari_item_id`（Yahoo の id も入る） | **`channel_item_id`** | 名前が実態と違う。ずっと先送りしてきた改名 |
| `listing` の主キーが `mercari_item_id` | **`id uuid` ＋ `unique(household_id, channel, channel_item_id)`** | 出品先が増えた |
| 日付が TEXT | **`date`（計上日など）／`timestamptz`（出来事）** | |
| 「今日」を SQL の `'now'`（UTC）で計算 | **ビューで `(now() at time zone 'Asia/Tokyo')::date`** | **UTC で 1 日ずれる不具合をこの系統ごと消す**（何度も踏んだ） |
| `model_codes` が JSON 文字列 | **`text[]`** | |
| `raw` が TEXT | **`jsonb`** | |
| `setting(key, value)` | **`setting(household_id, key, value)`** | 世帯ごと |
| API キーを safeStorage で暗号化 | **サーバーの秘密鍵で AES-GCM 暗号化して DB に**（`setting_secret`） | Web では端末の safeStorage が使えない。平文で持たない方針は同じ |
| 画像をローカルファイルに | **Supabase Storage の非公開バケット**。画面には署名 URL | |
| `thumb_file` | **`thumb_path`**（Storage の中のパス） | |

**変えないもの**：`CLAUDE.md` の「絶対に守ること」はすべてそのまま。金額は円の整数、
`landed_cost` を後から書き換えない、紐付けを自動確定しない（例外 3 つ）、按分の端数は最終行、
実績と見込みを分ける（`isRealized` に一本化）、取得 0 件を成功にしない。

---

## API メソッドの振り分け（126 本）

| 区分 | 本数 | 例 | Web での扱い |
|---|---|---|---|
| **サーバーへ移す** | 約 100 | listSales / createPurchase / linkInventory / getCashMonth … | `POST /api/rpc/<method>` |
| **エージェントでしかできない** | 6 | collect / openLogin / openYahooLogin / openShopLogin / refetchSaleDates / refetchPurchaseImages | Web からは「要求」を積むだけ。PC のエージェントが実行 |
| **デスクトップ専用** | 約 12 | openBackupFolder / revealDbFolder / checkForUpdate / installUpdate / backupDb / restoreBackup / 自動バックアップ系 | Web では出さない（Supabase がバックアップする。書き出しは CSV で） |
| **ブラウザで済む** | 2 | openChannelPage / openTracking | `window.open` |

---

## コードの置き場所

```
src/shared/          契約（そのまま。Web の RPC の契約にもなる）
src/renderer/        画面（Electron と Web で共用）
  api/http.ts        新：SorobanApi の HTTP 実装（fetch ＋ JWT）
  auth/              新：ログイン画面と Supabase Auth
server/              新：業務ロジック（Postgres・非同期）。Pages Functions とテストの両方から使う
  db/                Sql インターフェース。実装は postgres.js（本番）と PGlite（テスト）
  domain/            sales.ts / purchases.ts / inventory.ts / cash.ts / inbox.ts …（db.ts を分割して移植）
  rpc.ts             メソッド名 → 実装の表
functions/api/rpc/[method].ts   Cloudflare Pages Functions の入口（薄い）
supabase/migrations/            Postgres のスキーマ
web/                 Web 専用：vite.config.web.ts、PWA（manifest、service worker）
```

### `Sql` インターフェース（移植の要）

better-sqlite3 と**同じ形**にして、`db.ts` からの移植の差分を `await` だけにする。

```ts
export interface Sql {
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>
}
```

`?` のプレースホルダは実装の中で `$1, $2 …` に置き換える。

### テスト

**Docker が無くても本物の Postgres で回せるよう、PGlite（WASM の Postgres）を使う。**
`supabase/migrations` をそのまま流し込んで、移植した業務ロジックを vitest で叩く。
**既存の 917 件のテスト（SQLite 版）は消さない。** デスクトップ版は切り替えの日まで生きている。

---

## 進め方

| 段 | 中身 | 状態 |
|---|---|---|
| **1** | 設計（この文書）・Postgres スキーマ・`Sql` アダプタ・RPC の骨組み・認証・Web 版の外枠（ログイン・PWA・スマホの画面の骨組み） | **着手** |
| **2** | `db.ts` をドメインごとに移植（読み取り → 書き込み）。エージェント化。画像を Storage へ | |
| **3** | Push 通知。スマホ向けの UI/UX の作り直し。データ移行スクリプト | |
| **4** | 利用者が Supabase と Cloudflare を用意 → デプロイ → データ移行 → 切り替え | 利用者の作業 |

### 利用者にしかできないこと（私は代わりにできない）

- **Supabase のプロジェクトを作る**（アカウント作成は代行できない）。リージョンは東京
- **Cloudflare のアカウントを作り、Pages のプロジェクトを繋ぐ**
- 秘密の値（DB の接続文字列・JWT の秘密・VAPID の秘密鍵・暗号化の鍵）を Cloudflare の環境変数に入れる。
  **このリポジトリは Public なので、秘密の値は絶対にコミットしない**
- 本番データの移行を実行する（データを外部サービスに送る操作なので、本人の判断で）

### 外販の仕様まとめとの関係

仕様まとめでは売りの 2 番目に「**データが手元から出ない**」を挙げていた。Web 化でこれは崩れる
（データは Supabase に置く）。代わりに「**スマホから見られる**」「**夫婦で同じ帳簿を見る**」が売りになる。
仕様まとめは切り替えの時点で書き直す。
