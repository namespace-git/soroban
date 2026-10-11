# 取り込み担当の PC（エージェント）と Push 通知（Wave 3 の設計・下書き）

`00-architecture.md` の「取り込み」「Push 通知」を、実装できる粒度まで落としたもの。
**下書き。** Wave 2（db.ts の移植）が終わってから確定させる。

---

## 1. 取り込みの流れ（Web 版）

```
 スマホ／PC のブラウザ                         Cloudflare（API）                         PC の Electron（エージェント）
 「取り込む」を押す ──requestCollect──▶ app.enqueue_collect_job（queued）
                                                                     ◀── 20 秒ごと agent/claim ──  起動中はずっと聞いている
                                         app.claim_collect_job（running・lease）──▶ 取り込みを始める
                                                                     ◀── agent/<書き込み> ──────  販売・出品・仕入を 1 件ずつ
                                                                     ◀── agent/heartbeat（60 秒）
                                         app.finish_collect_job（done/failed）◀── agent/finish
 画面は getCollectJob を数秒ごとに読む ◀──                                          配送状況（17TRACK）はサーバーが続けて見る
```

### 契約に足すもの（`src/shared/types.ts`。親が確定させる）

| メソッド | 役割 |
|---|---|
| `requestCollect(): Promise<CollectJob>` | 要求を積む。走っている・クールダウン中なら日本語で断る（SB001・SB002） |
| `getCollectJob(): Promise<CollectJob \| null>` | いま積まれている／走っている／直近に終わった要求。画面はこれを読んで「取り込み中」を出す |
| `cancelCollectJob(id): Promise<void>` | 始まる前なら取り消す（SB004・SB005） |

- デスクトップ版の `collect()` はそのまま（Electron 単体のときは今まで通りその場で走る）
- Web 版の画面は `collect()` を呼ばず、`requestCollect()` → `getCollectJob()` を数秒ごと（走っている間だけ）

### エージェント用の API（`/api/agent/<method>`。画面の `SorobanApi` とは別の契約 `AgentApi`）

- 認証は画面と同じ（同じアカウントの JWT）。**エージェントだけが呼べる口ではない**が、書き込みのたびに
  **ジョブ id と lease_token** を受け取り、`running` かつ token が一致しなければ断る（SB003）。
  lease を失った PC が後から書き込んで、次の取り込みの結果を壊さない
- 中身は db.ts のうち収集が使っている関数（Wave 2 で `server/domain/*` に移植済みのもの）をそのまま出す：

| 収集 | 使う関数 |
|---|---|
| メルカリ・Yahoo | `existingMercariIds` `isMercariItemExcluded` `insertCollected` `updateCollectedActuals` `updateYahooActuals` `updateSaleStatus` `appendModelCodes` `saleMercariItemId` `salesNeedingPurchasedAt` `setSalePurchasedAt` `salesNeedingThumb` `setSaleThumb` `upsertListings` `listingsNeedingThumb` `setListingThumb` `startRun` `finishRun` `getSettings` |
| メロジョイ | `existingImportKeys` `isMellojoyOrderExcluded` `markMellojoyOrderExcluded` `createPurchase` `createPurchaseDraft` `getPurchase` `getShopAccount` `applyFulfillmentFromShop` `updatePurchaseFulfillment` `purchaseDetailRevisitCandidates` `purchaseLinesNeedingImage` `setPurchaseImageChecked` `setPurchaseLineImage` `setPurchaseLineImageUrls` `setSetting` |
| ジョブ | `claim` `heartbeat` `finish` |

- 収集のコード（`collector*.ts`）は `db.x(...)` を `store.x(...)` に替えるだけにする。`store` はローカル（db.ts）と
  リモート（HTTP）の 2 つの実装を持つ。**スクレイピングの中身・待ち時間・CAPTCHA で止まる動きは変えない**
- 画像：エージェントが Storage の `media` に直接上げ（利用者の JWT。Storage の RLS で自分の世帯のフォルダだけ）、
  パスを `setSaleThumb` などで書く

### 17TRACK（配送状況）はサーバーで見る

- スクレイピングではなく API なので、PC は要らない。`finish` の後に API が `waitUntil` で続けて見る
  （`CLAUDE.md` の約束はそのまま：1 リクエスト 40 件・秒間 3 リクエスト・429 と 4xx は再試行しない・`register` は一度だけ）
- API キーは `setting_secret` に、サーバーの鍵（環境変数 `SECRET_KEY`）で AES-GCM 暗号化して持つ。画面にも
  ログにも平文で出さない。Gemini のキーも同じ
- 画面の「配送状況を確認」（`checkTracking`）も Web から動くようになる

### Electron 側

- 設定に「Web 版につなぐ」。つなぐと、**画面のデータは Web（Supabase）を読む**（ローカルの SQLite は凍結して残す）
- ログインは Web 版と同じ画面。セッションは端末に残す（`CLAUDE.md` の「セッションプロファイルのみ」の延長。
  パスワードは保存しない）
- 起動中は 20 秒ごとに `claim`。起動時は自分で `requestCollect` してから `claim`（今の「起動時に取り込む」と同じ）
- PC が複数あれば、どれか 1 台が取る。失敗の通知に PC の名前を入れる（「メルカリにログインが必要です（リビングの PC）」）

---

## 2. Push 通知

### 送るもの（最初の版）

| 出来事 | 書く場所 | 文面の例 |
|---|---|---|
| 販売が増えた | `insertCollected` | 「売れました：【A040】もこ山 スクイーズ ¥5,750」 |
| 発送の番になった | 取引の状態が「発送待ち」に変わったとき | 「発送してください：2 件」（まとめる） |
| 取り込みが終わった（失敗・要ログイン・0 件） | `finish` | 「メルカリにログインが必要です（リビングの PC）」 |
| 仕入が届いた | 17TRACK で到着になったとき | 「メロジョイの荷物が届きました（3 点）」 |

- **業務の書き込みと同じトランザクションで `notification_outbox` に 1 行。** コミットした後に送る
  （送信の失敗で帳簿が巻き戻らない／帳簿が巻き戻ったのに通知だけ飛ぶ、が起きない）
- 送るのは API の `waitUntil`。失敗したら `next_attempt_at` を延ばして残す。**次に誰かが API を呼んだときに
  まとめて送り直す**（エージェントが 20 秒ごとに呼ぶので、PC が動いていれば実質の再送になる）
- 同じ出来事を 2 回送らない（`dedupe_key`）。発送待ちは数分まとめてから送る

### 受け取る側

- 設定に「この端末で通知を受け取る」ボタン。**押したときだけ**許可を求める（iPhone はボタンからでないと出せない）
- iPhone はホーム画面に追加した PWA でしか受け取れない（iOS 16.4 以降）。Safari で開いているときは
  「共有 → ホーム画面に追加」の案内を出す
- 種類ごとに切れる（販売・発送・取り込み・到着）。端末ごとの購読は `push_subscription`
- 通知を押すと該当の画面へ（service worker → 画面に `soroban:open`。受け取る側の実装が要る）

### 鍵

- VAPID の鍵の組は利用者が作って Cloudflare の環境変数に入れる（`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`）。
  **公開鍵は画面にも渡す。秘密鍵はリポジトリに書かない**
- 送信は WebCrypto で書く（Workers で動くこと。`web-push` は Node の crypto 前提なので使わない）

---

## 3. 決めていないこと

- エージェントの API を 1 件ずつの呼び出しにするか、取り込み 1 回分をまとめて送るか（今の案は 1 件ずつ。
  スクレイピングの待ち時間 2〜6 秒に比べれば往復は誤差で、収集のコードをほぼ変えずに済む）
- Electron の画面を Web のデータに切り替えたとき、デスクトップ専用の機能（バックアップ・更新）をどう見せるか
- 17TRACK を `finish` の後に回すか、別の定期実行にするか（Pages には定期実行が無い）
