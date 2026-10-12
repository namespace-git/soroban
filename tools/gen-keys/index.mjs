// Web 版の鍵を作って、画面に出す。
//
//   pnpm gen-keys
//
// **出力は画面に出すだけ。ファイルには書かない。** 出た値は Cloudflare の環境変数（Pages と定期実行の Worker）に
// 貼ったら、画面を閉じる（メモやチャットに残さない。このリポジトリは Public）。手順は docs/web/01-setup.md の 2-5。
import { generateSecretKeys, generateVapidKeys } from './generate.mjs'

const vapid = await generateVapidKeys()
const secretKeys = generateSecretKeys()

console.log(`
そろばん Web 版の鍵を作りました。
次の値を Cloudflare の環境変数に入れてください（Pages と、定期実行の Worker の両方。手順は docs/web/01-setup.md）。

  ※ 秘密 と書いてあるものは、Cloudflare では Secret（暗号化）として入れる。
  ※ このウィンドウを閉じたら、もう表示できません。ファイル・メモ・チャットには残さないでください。

VAPID_PUBLIC_KEY=${vapid.publicKey}
    （公開してよい。通知の宛先の確認に使う）

VAPID_PRIVATE_KEY=${vapid.privateKey}
    （秘密）

VAPID_SUBJECT=mailto:<あなたのメールアドレス>
    （これは自分で決める。mailto: か https:// で始まる連絡先）

SECRET_KEYS=${secretKeys}
    （秘密。Gemini・17TRACK の API キーを暗号化する鍵。失くすと保存済みの API キーが読めなくなり、入れ直しになります）
`)
