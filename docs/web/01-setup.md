# Web 版の準備（利用者の作業）

**ここに書いてあるのは、私（Claude）が代わりにできないこと**です。アカウントの作成と、
秘密の値の扱いは本人の手で行ってください。

> **このリポジトリは Public です。** 下の「秘密」の印が付いた値は、**ファイルに書いてコミットしないこと。**
> Cloudflare と Supabase の管理画面の中だけに置きます。

画面の項目名は各サービスの更新で変わることがあります。見当たらなければ近い名前のものを探してください。

---

## 1. Supabase

### 1-1. プロジェクトを作る

- リージョンは **東京（Northeast Asia / Tokyo）**
- データベースのパスワードは**強いものを作って、パスワードマネージャーに保存**（秘密）

### 1-2. 新規登録を止める（いちばん大事）

**Authentication → Sign In / Providers → Email** で、
**「新しいユーザーの登録を許可する（Allow new users to sign up）」をオフ**にする。

これを止めないと、URL を知っている誰でもアカウントを作れます。
（そろばんの API 側でも「世帯に入っている人だけ」を通すので二重の守りになりますが、入口はここで閉じる）

### 1-3. 2 人のアカウントを作る

**Authentication → Users → Add user** で、夫婦 2 人ぶん。メールアドレスとパスワード。

### 1-4. テーブルを作る

PC で（Supabase CLI は入っています）：

```bash
supabase login
supabase link --project-ref <プロジェクトの ID>
supabase db push
```

`supabase/migrations/` の SQL が順に流れます。

### 1-5. 世帯を作って 2 人を入れる

**SQL Editor** で 1 行だけ（`<…>` は 1-3 で作ったユーザーの ID。Users の一覧に出ています）：

```sql
select app.create_household('うち', array['<夫のユーザー id>', '<妻のユーザー id>']::uuid[]);
```

返ってきた値が世帯の ID です。**発送方法の既定 8 行と設定の既定値 9 件も、この 1 行で一緒に入ります**
（いまのデスクトップ版を新しく入れたときと同じ中身）。

### 1-6. 控えておく値

| 値 | どこにある | 秘密？ |
|---|---|---|
| Project URL | Project Settings → API | 公開してよい |
| anon（publishable）key | Project Settings → API | **公開してよい**（ブラウザに出る前提の鍵） |
| **service_role（secret）key** | Project Settings → API | **秘密。そろばんでは使わない。どこにも貼らない** |
| **接続文字列（Direct connection）** | Connect → Direct connection | **秘密**（パスワードが入っている）。Cloudflare の Hyperdrive に渡す |

---

## 2. Cloudflare Pages

### 2-1. GitHub と繋ぐ

**Workers & Pages → Create → Pages → Connect to Git** で、このリポジトリを選ぶ。

| 項目 | 値 |
|---|---|
| 本番のブランチ | `web`（切り替えが済んだら `main`） |
| Build command | `pnpm build:web` |
| Build output directory | `dist-web` |

### 2-2. 互換性フラグ

**Settings → Runtime → Compatibility flags** に **`nodejs_compat`** を入れる（API が Postgres のドライバを使うため）。

### 2-3. Hyperdrive（DB への接続）

**Workers & Pages → Hyperdrive → Create** で、1-6 の**接続文字列（Direct connection）**を渡して作る。
できたら Pages の **Settings → Bindings** で **`HYPERDRIVE`** という名前で結び付ける。

> 接続文字列にはパスワードが入っています。Hyperdrive の中にだけ置き、ファイルに書かないこと。

### 2-4. 環境変数

**Settings → Variables and Secrets**。「秘密」は **Encrypt（Secret）** で入れる。

| 名前 | 中身 | 秘密？ | 使う場所 |
|---|---|---|---|
| `VITE_SUPABASE_URL` | 1-6 の Project URL | 公開 | 画面（ビルド時） |
| `VITE_SUPABASE_ANON_KEY` | 1-6 の anon key | 公開 | 画面（ビルド時） |
| `SUPABASE_URL` | 1-6 の Project URL | 公開 | API |

※ Push 通知・API キーの暗号化の値は、その機能ができた段で追記します。

---

## 3. PC（取り込み担当）

**まだできていません。** 次の段で、いまのデスクトップ版を「取り込み担当（エージェント）」として
動かせるようにします。Web 版の「取り込む」ボタンを押すと、PC のそろばんが拾って取り込みます。

---

## 4. いまのデータを移す

**本番のデータを Supabase に送る操作なので、実行は本人の判断で**行ってください。
道具は**空の世帯にしか書きません**（二重に流す事故を防ぐ）。1 つのトランザクションで書き、SQLite と
金額のビュー 5 本を全行・全列で突き合わせ、**1 つでも違えば全部巻き戻して止まります**。

> **Storage のバケットと権限（`media` 公開・`receipts` 非公開、世帯のフォルダにだけ書ける）は、まだリポジトリに
> ありません。** 次の段で足します。それまでは `--dry-run` だけ試せます。

### 4-1. 前の準備

1. デスクトップ版の「バックアップ」で zip を作り、展開する（中に `soroban.db` と `thumbs/` がある）
2. 1-5 で世帯を作り、返ってきた id を控える
3. **まず試走**（何も送らない。このパソコンの中だけで、移して突き合わせるところまで全部やる）：

   ```bash
   pnpm migrate:web <展開した soroban.db> <展開した thumbs> --dry-run
   ```

   最後に「**結果: すべて一致しました**」と出れば OK

### 4-2. 本番

接続の値は**ファイルに書かず、シェルで渡す**（リポジトリは Public。出力でも伏せ字になる）：

| 環境変数 | 値 |
|---|---|
| `SOROBAN_DATABASE_URL` | 1-6 の接続文字列（Direct か Session pooler） |
| `SUPABASE_URL` | 1-6 の Project URL |
| `SUPABASE_ANON_KEY` | 1-6 の anon キー |
| `SUPABASE_USER_JWT` | Web 版にログインした人の JWT（1 時間ほどで切れるので直前に取る。残り 5 分未満なら道具が断る） |

```bash
pnpm migrate:web <展開した soroban.db> <展開した thumbs> --household <世帯の id>
```

### 4-3. 移さないもの

- 操作ログ（14 日で消えるもの）、デスクトップ版の自動バックアップの設定、マイグレーションの印
- **API キー（Gemini・17TRACK）**：端末の中で暗号化されていてサーバーでは読めない。**移した後に Web 版の設定で入れ直す**

### 4-4. 後の確認

1. Web 版のホーム・売上・在庫・月次の数字が、デスクトップ版と同じか見る
2. 設定で API キーを入れ直す
3. **確かめ終わるまでデスクトップ版を消さない。** 移した後にデスクトップ版に足したデータは Web 版に入らない
