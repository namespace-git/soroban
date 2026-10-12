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

### 1-2b. ログインの署名を「非対称鍵」にする（これをしないと全部 401）

**Project Settings → JWT Keys（JWT signing keys）** で、署名鍵が **ECC (P-256) か RSA** になっていることを確かめる。
古い「Legacy JWT secret（HS256）」だけのときは、**新しい署名鍵を作って「現在の鍵」に切り替える**（画面の案内どおり。
古い鍵は「以前の鍵」として残ってよい）。

そろばんの API は、Supabase が公開している鍵の一覧（JWKS）でログインを確かめます。共有の秘密（HS256）は、
リポジトリにもサーバーにも置かない方針なので受け付けません。切り替えていないと、**ログインはできるのに画面の読み込みが
すべて「ログインが必要です」になり、ログイン画面に戻され続けます**。

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
| **接続文字列（Direct connection）** | Connect → Direct connection | **秘密**（パスワードが入っている）。ユーザー名が `postgres` のこの文字列は**全テーブルの持ち主**の権限。Hyperdrive には**そのまま渡さず**、1-8 で `soroban_gateway` に差し替えたものを渡す |

### 1-7. Storage（画像の置き場）を確かめる

1-4 の `supabase db push` で、画像の置き場も一緒にできます（`20261012001530_storage.sql`）。**自分では作らなくてよい**ので、
できているかだけ Supabase の画面で見ます。

- **Storage → Files（バケットの一覧）**に 2 つ出ていること：
  - **`media`**：**公開（Public）**。商品・販売・出品の写真。パスは `世帯の id/種類/ランダムな id.拡張子` で、推測できない
  - **`receipts`**：**非公開（Private）**。レシート。見るときだけ署名つきの URL を出す
    （公開になっていると `supabase db push` が止まって知らせます。**Public をオフ**に直してから流し直す）
- **Storage → Policies**（`storage.objects`）に、`soroban_media_insert / select / delete` と
  `soroban_receipts_insert / select / delete` の 6 本が出ていること。どれも「パスの先頭のフォルダが**自分の世帯の id**のときだけ」
  通す条件で、他の世帯のフォルダには入れません（匿名のアクセスには何も出していません）
- 同じ画面の **バケットの設定**（Storage → バケットの右の「…」→ Edit bucket）に、大きさと種類の制限が入っていること：
  - **`media`**：最大 **5 MB**、許可する種類は画像（`image/jpeg`・`image/png`・`image/webp`・`image/gif`・`image/avif`）
  - **`receipts`**：最大 **10 MB**、許可する種類は同じ画像
  - 画面の項目の名前は「ファイルサイズの制限（Restrict file upload size）」「許可する MIME タイプ（Allowed MIME types）」あたり。
    Supabase のプロジェクト全体の上限（Project Settings → Storage）がこれより小さいと、そちらが先に効く
  - 入っていなければ、SQL Editor で `select id, file_size_limit, allowed_mime_types from storage.buckets;` を見て、
    画面から同じ値に直す（`supabase db push` が入れるのは新しく流すときだけ）

### 1-8. API の接続用ロール（soroban_gateway）にパスワードを付ける

1-4 の `supabase db push` で、`soroban_gateway` というロールができます。**ログインできない状態**で作られるので、
**パスワードとログインの許可を自分で付けます**（パスワードをこのリポジトリに書かないため）。

このロールは、**ログインして「世帯の確認」をするだけ**の権限しか持ちません（テーブルは 1 つも読めません）。
API は、ログインした人の世帯が決まってから、読み書き用のロール（`soroban_api`）に切り替えて帳簿を読み書きします。
今まで使っていた `postgres`（全テーブルの持ち主）の接続だと、切り替えを書き忘れたコードが全世帯の行を読めてしまいます。
`soroban_gateway` なら、書き忘れても**権限エラーで止まります**。

1. **SQL Editor** で 1 行だけ（`<…>` は**自分で決めた**強いパスワードに置き換える。ここに書いてある値は例ではありません）：

   ```sql
   alter role soroban_gateway with login password '<自分で決めたパスワード>';
   ```

2. パスワードは**パスワードマネージャーに保存**（秘密）。SQL Editor の履歴や保存したスニペットにパスワードが残るので、
   実行したら履歴・スニペットから**削除**する
3. 接続文字列を作る：1-6 の Direct connection の文字列の**ユーザー名の `postgres` を `soroban_gateway` に、パスワードを 2 のものに**
   替える。Session pooler を使うときは、ユーザー名が `postgres.<プロジェクトの ID>` の形なので、
   `soroban_gateway.<プロジェクトの ID>` にする
4. この文字列を **2-3 の Hyperdrive に渡す**（`postgres` のものは渡さない）。定期実行の Worker（2-6）も同じ Hyperdrive を使う
5. 確かめる（SQL Editor）：
   - `select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname = 'soroban_gateway';` → `true, false, false`
     （ログインできる・権限を引き継がない・行の保護をすり抜けない）
   - `set role soroban_gateway; select * from app.sale;` → **`permission denied for table sale`** と出れば正しい
     （表は 1 つも読めない）。確かめたら `reset role;` で戻す

> **パスワードを変える・止めるとき**：`alter role soroban_gateway with password '<新しい>';`（Hyperdrive の接続文字列も同じように替える）／
> `alter role soroban_gateway with nologin;`（ログインを止める。API も定期実行も動かなくなる）。

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

**Workers & Pages → Hyperdrive → Create** で、**1-8 で作った `soroban_gateway` の接続文字列**（1-6 の Direct connection の
文字列の、ユーザー名とパスワードを替えたもの）を渡して作る。
できたら Pages の **Settings → Bindings** で **`HYPERDRIVE`** という名前で結び付ける。

> **`postgres` の接続文字列は渡さない。** `postgres` は全テーブルの持ち主で、API が世帯の切り替えを書き忘れても全世帯の行が読めてしまいます。
> `soroban_gateway` なら、書き忘れは権限エラーで止まります（1-8）。
> すでに `postgres` のもので作ってしまったときは、Hyperdrive の設定（Edit）で接続文字列を `soroban_gateway` のものに差し替える
> （`HYPERDRIVE` の結び付けや id は変わらない）。
>
> 接続文字列にはパスワードが入っています。Hyperdrive の中にだけ置き、ファイルに書かないこと。

### 2-4. 環境変数

**Settings → Variables and Secrets**。「秘密」は **Encrypt（Secret）** で入れる。

| 名前 | 中身 | 秘密？ | Pages（画面・API） | 定期実行の Worker（2-6） |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | 1-6 の Project URL | 公開 | 要る（ビルド時） | 要らない |
| `VITE_SUPABASE_ANON_KEY` | 1-6 の anon key | 公開 | 要る（ビルド時） | 要らない |
| `SUPABASE_URL` | 1-6 の Project URL | 公開 | 要る（ログインの検証・画像の URL） | 要らない |
| `SUPABASE_ANON_KEY` | 1-6 の anon key（`VITE_SUPABASE_ANON_KEY` と同じ値） | 公開 | 要る（レシート・商品画像の署名・削除・読み出し。ログインした人の権限で Storage を呼ぶときの `apikey`。無ければ画像まわりだけ使えない） | 要らない |
| `VAPID_PUBLIC_KEY` | 2-5 で作った値（通知の公開鍵） | 公開してよい | 要る | 要る |
| `VAPID_PRIVATE_KEY` | 2-5 で作った値（通知の署名鍵） | **秘密** | 要る（「試しに送る」と、操作の直後の通知） | 要る（通知の送信） |
| `VAPID_SUBJECT` | `mailto:自分のメールアドレス`（連絡先） | 秘密にしておく（メールアドレスが入る） | 要る | 要る |
| `SECRET_KEYS` | 2-5 で作った値（API キーを暗号化する鍵） | **秘密** | 要る（Gemini・17TRACK のキーの保存） | 要る（17TRACK のキーの読み出し） |

- DB への接続は、Pages も Worker も **`HYPERDRIVE` のバインディング**（2-3）だけ。`DATABASE_URL` は要りません
- **`VAPID_*` と `SECRET_KEYS` は、Pages と定期実行の Worker に「同じ値」を入れる。** 違うと、Worker が通知を送れない・保存した API キーを読めない
- `SECRET_KEYS` を失くす（または別の値にする）と、保存済みの Gemini・17TRACK の API キーが読めなくなります（設定で入れ直せば元に戻る）
- 入れ忘れたとき：`VAPID_*` が無ければ通知は使えないだけ（設定画面に出ない）。`SECRET_KEYS` が無ければ API キーの保存を
  「この環境では安全に保存できません」と断ります（平文では持たない）

### 2-5. 鍵を作る（VAPID と SECRET_KEYS）

PC で（このリポジトリのフォルダ）：

```bash
pnpm gen-keys
```

画面に `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`（雛形）・`SECRET_KEYS` が出ます。

- **出た値は、どこにも保存しない。** ファイル・メモ・チャットに貼らない（このリポジトリは Public）。道具もファイルには書きません
- **2-4 の表のとおり、Cloudflare の Pages に入れ、2-6 の Worker にも同じ値を入れたら、ターミナルを閉じる**
- `VAPID_SUBJECT` だけは自分で決める（`mailto:` か `https://` で始まる連絡先）
- もう一度 `pnpm gen-keys` を実行すると**別の鍵**ができます。作り直すと、通知の登録はやり直し（`VAPID_*`）、
  保存済みの API キーは入れ直し（`SECRET_KEYS`）になります。**鍵は 1 回作ったら変えない**

### 2-6. 定期実行の Worker

> **利用者に確認中の事項です。** Cloudflare に Worker をもう 1 本（定期実行用）デプロイしてよいか、
> 無料枠で足りなければ **Workers Paid（月 5 ドル）**にしてよいか。決まるまでは、この節は**実行しないでください**。
> （Worker を入れなくても、画面と API は動きます。動かないのは「通知の再送」「17TRACK の確認」「期限切れの取り込み要求の片付け」だけ。
> 操作の直後の通知は、Pages 側が急ぎで送ってみます）

5 分ごとに、次の 3 つを順に行う小さな Worker です（`workers/cron/`）。どれかが失敗しても残りは続けます。

1. 期限切れの取り込み要求の片付け
2. 通知の送信（Push サービスへ。1 回 30 本まで）
3. 17TRACK の配送状況の確認（1 回 15 本まで。秒間 3 リクエストを守る）

外部への通信は合計 45 本まで（Cloudflare の無料枠は 1 回の呼び出しで 50 本）。DB は Hyperdrive 経由で、この本数に数えません。
CPU 時間の上限（無料枠は 10ms）を超える日があれば、Workers Paid にします（通知を送るときは暗号化の計算で超えやすい）。

**手順**（`workers/cron/` のフォルダで）：

1. `wrangler.toml` の `id = "<ここに Hyperdrive の id>"` を、**2-3 で作った Hyperdrive の id** に書き換える
   （Workers & Pages → Hyperdrive の一覧に出る識別子。パスワードではありませんが、**書き換えたファイルはコミットしない**）
2. デプロイ：

   ```bash
   pnpm dlx wrangler deploy
   ```

3. 秘密と環境変数を **4 つ**入れる（実行すると値の入力を求められる。入力は画面に残らず、ファイルにも書かれません）：

   ```bash
   pnpm dlx wrangler secret put VAPID_PUBLIC_KEY
   pnpm dlx wrangler secret put VAPID_PRIVATE_KEY
   pnpm dlx wrangler secret put VAPID_SUBJECT
   pnpm dlx wrangler secret put SECRET_KEYS
   ```

4. 確かめる：Cloudflare の **Workers & Pages → soroban-cron → Settings → Triggers** に `*/5 * * * *` が出ていること。
   5 分待って `pnpm dlx wrangler tail`（または管理画面の Logs）を見て、`[cron] … に失敗しました` が出ていないこと
   （出ていれば、続きの文が原因です。鍵の値は出しません）

> `HYPERDRIVE` は `wrangler.toml` の `[[hyperdrive]]` で結び付くので、`secret put` は要りません。
> `compatibility_flags = ["nodejs_compat"]`（postgres.js が Node の API を使う）も `wrangler.toml` に入っています。

### 2-7. /api に回数の制限をかける（Cloudflare の Rate Limiting）

`/api/*`（画面の API と取り込み担当の API）には、アプリの側に回数の制限がありません。ログインした人・取り込み担当の鍵を持つ PC
だけが通れますが、鍵やトークンを持たない相手に叩かれ続けても、Workers の呼び出しと DB の接続を食われます。Cloudflare 側で
上限をかけておきます（コードは変えません）。

**Cloudflare のダッシュボード → 対象のドメイン（または Pages のカスタムドメイン）→ Security → WAF → Rate limiting rules → Create rule**
（`*.pages.dev` の URL は自分の Cloudflare のドメイン（ゾーン）ではないので、WAF のルールを付けられないことがあります。
独自ドメインを繋いだサイトで設定してください。付けられないときは、この節は飛ばしてよい — 回数の制限が無いだけで、他の守りは変わりません）：

| 項目 | 値 |
|---|---|
| ルールの名前 | `soroban-api`（なんでもよい） |
| 条件（When incoming requests match） | URI Path **starts with** `/api/` |
| 数える単位（Characteristics） | IP アドレス |
| 上限（Requests） / 期間（Period） | **1 分あたり 300 回**を目安（選べる期間が限られるプランでは、いちばん近い期間で同じ割合に） |
| 超えたとき（Action） | Block（待ち時間は 1 分） |

- 目安の根拠：画面は 1 回の操作で `/api/rpc/…` を数回、取り込み担当の PC は 20 秒ごとの確認（`claim`）と 60 秒ごとの生存の通知、
  取り込み中は段ごとの書き込み（ページ・注文・画像ごと）を呼びます。同じ家の PC とスマホは同じ IP から出るので、1 人分の通常の使い方の
  数倍に余裕を持たせてあります。**Security → Events で、止められたのが自分たちのアクセスでないか**を最初の数日は見てください。
  止まってしまうなら上限を上げる（API は 429 を返し、取り込み担当の PC は 4xx を再試行しません）
- 無料のプランでは、使えるルールの数・期間・条件の選び方に制限があります（画面の案内に従い、近い設定にしてください）
- 取り込み担当の鍵を出す `/api/agent/register` だけ、さらに厳しく（例：1 分あたり 10 回）したいときは、有料のプランで
  URI Path **equals** `/api/agent/register` のルールをもう 1 本足す

### 2-8. 画面のセキュリティヘッダー（確認だけ）

Pages は `web/public/_headers`（ビルドで `dist-web/_headers` に出る）の内容を、画面（HTML・JS・画像）のレスポンスに付けます。
`X-Frame-Options: DENY`・`Content-Security-Policy: frame-ancestors 'none'`（埋め込みの禁止）、`X-Content-Type-Options: nosniff`、
`Referrer-Policy`、`Permissions-Policy`、`Strict-Transport-Security` が入っています。デプロイしたら、ブラウザの開発者ツールの
Network で画面のレスポンスにこれらが付いていることを確かめてください。`/api/*` の応答のヘッダーはコード（`functions/`）が付けます。

---

## 3. PC（取り込み担当）

Web 版の「取り込む」を押すと、PC のそろばんが拾ってメルカリ・Yahoo!フリマ・メロジョイを取り込みます。
メルカリなどはログインしたブラウザで読む必要があるので、取り込みはサーバーではなく PC で行います。
**4（データの移行）が済んでから**切り替えてください（切り替えると、この PC の帳簿は凍結されます）。

### 3-1. 取り込み担当になる

1. PC のそろばん（このブランチでビルドしたもの）を開き、**設定 →「Web 版の取り込み担当」**
2. Web 版の URL（2-1 の `https://….pages.dev`）と、PC の名前（例「リビングの PC」。空ならパソコンの名前）を入れる
3. **「取り込み担当になる」** → 確認で OK。窓が Web 版に切り替わり、タイトルが「そろばん（取り込み担当）」になる
4. 窓の中の Web 版に**ログインしたままにする**（ログインが切れると取り込み担当も止まる）
5. メニュー「取り込み担当」から、メルカリ・Yahoo!フリマ・メロジョイに**ログイン**する（今までと同じ窓）
6. スマホの Web 版の 設定 →「取り込み担当の PC」に、この PC が「動いている」で出れば OK

- そろばんが起動している間、20 秒ごとに「頼まれていないか」を確かめます（メルカリなどにはアクセスしません）
- 起動したとき、前回の取り込みから設定の間隔（既定 1 時間）が空いていれば、1 回だけ取り込みます（今までと同じ）
- 取り込み担当の鍵は**この PC のメモリにだけ**持ち、ファイルには書きません。PC を閉じれば消えます。
  鍵は **2 時間**で切れ、期限の 30 分前に（ログインしたままなら）自動で取り直します。**ログアウトするとサーバーの鍵もすぐ捨てます**
  （通信できなくても、2 時間で切れます）
- 鍵を出せる人は**世帯のメンバーだけ**で、鍵が使えるのは**鍵を作った人が世帯にいる間だけ**です。世帯から外した人が登録した PC は、
  自動で取り消されます（外した人が戻っても、その PC は取り消されたまま。別の名前で登録し直す）
- 同じ名前の PC は、**鍵が生きている間は、鍵を作った人しか取り直せません**。夫婦で 1 台の PC を使うときは、先の人がログアウトする
  （鍵を捨てる）と、次の人が同じ名前で入れます。ログアウトできなかったときは、設定の「取り込み担当の PC」から外すか、2 時間待ちます
- 取り込み担当の PC は、取り消していないものが**世帯ごとに 10 台まで**。使わない PC は設定から外してください
- 取ってきた画像は Supabase の Storage に上がります

### 3-2. やめる

メニュー「取り込み担当」→「取り込み担当をやめる（この PC の帳簿に戻る）」。凍結していた帳簿の画面に戻ります
（Web 版で足したデータは入っていません）。スマホの「取り込み担当の PC」から**外す**こともできます。

### 3-3. 初めて動かすときに確かめること

まだ実機で動かしていない部分です。最初の 1 回は PC の前で様子を見てください。

- 窓の中の Web 版にログインすると、スマホの「取り込み担当の PC」に出るか
- スマホで「取り込む」→ PC が拾い、結果がスマホに出るか。サムネイルが表示されるか
- CAPTCHA や本人確認が出たら、PC の窓で止まって人に渡るか（今までと同じ）
- PC をスリープさせて戻したとき、取り込みが止まり、次の要求でまた動くか

---

## 4. いまのデータを移す

**本番のデータを Supabase に送る操作なので、実行は本人の判断で**行ってください。
道具は**空の世帯にしか書きません**（二重に流す事故を防ぐ）。1 つのトランザクションで書き、SQLite と
金額のビュー 5 本を全行・全列で突き合わせ、**1 つでも違えば全部巻き戻して止まります**。

> **Storage のバケットと権限（`media` 公開・`receipts` 非公開、世帯のフォルダにだけ書ける）は、`supabase db push`（1-4）で
> 入ります。** 本番に流す前に、1-7 のとおり Supabase の画面でできているか確かめてください。

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
| `SOROBAN_DATABASE_URL` | **1-8 の `soroban_gateway` の接続文字列**（Direct か Session pooler。`postgres` のものは要りません）。道具は書き込みも読み戻しも、`soroban_api` に切り替えて世帯の文脈の中で行うので、ゲートウェイの権限で足ります（PGlite の上で、最後まで動き・突き合わせが全部一致することは確かめ済み。本物の Supabase ではまだ） |
| `SUPABASE_URL` | 1-6 の Project URL |
| `SUPABASE_ANON_KEY` | 1-6 の anon キー |
| `SUPABASE_USER_JWT` | Web 版にログインした人の JWT（1 時間ほどで切れるので直前に取る。残り 5 分未満なら道具が断る） |

```bash
pnpm migrate:web <展開した soroban.db> <展開した thumbs> --household <世帯の id>
```

> もし `permission denied` で止まったら（ゲートウェイの権限で足りない書き込みが見つかったとき）、**移行のときだけ**
> `postgres`（1-6 の Direct connection のそのままの文字列）を `SOROBAN_DATABASE_URL` に渡して流し直す。道具はどちらでも
> 世帯の文脈の中でしか書かないので結果は同じです。終わったらターミナルを閉じて、`postgres` の文字列をどこにも残さない。

### 4-3. 移さないもの

- 操作ログ（14 日で消えるもの）、デスクトップ版の自動バックアップの設定、マイグレーションの印
- **API キー（Gemini・17TRACK）**：端末の中で暗号化されていてサーバーでは読めない。**移した後に Web 版の設定で入れ直す**

### 4-4. 後の確認

1. Web 版のホーム・売上・在庫・月次の数字が、デスクトップ版と同じか見る
2. 設定で API キーを入れ直す
3. **確かめ終わるまでデスクトップ版を消さない。** 移した後にデスクトップ版に足したデータは Web 版に入らない
