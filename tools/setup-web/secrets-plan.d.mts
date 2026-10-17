/** Worker に入れる実行時の Secret。この順で入れる */
export const SECRET_NAMES: readonly ['SECRET_KEYS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']

export type SecretName = (typeof SECRET_NAMES)[number]

export type SecretsPlan =
  | {
      ok: true
      /** 入れる名前 */
      put: SecretName[]
      /** 触らない名前（すでに入っている） */
      skip: SecretName[]
      /** put のうち、すでにあって上書きするもの（force のときだけ空でない） */
      overwrite: SecretName[]
    }
  | { ok: false; error: string }

/** どの Secret を入れるか。existingNames は `wrangler secret list` の名前（4 つ以外が混ざっていてもよい） */
export function planSecrets(existingNames: readonly string[], options?: { force?: boolean }): SecretsPlan

/** `wrangler secret list` の出力から Secret の名前を読む。読めなければ null */
export function parseSecretList(output: string): string[] | null

/** 連絡先を `mailto:…` か `https://…` にそろえる。形が合わなければ null */
export function normalizeSubject(input: string): string | null

export type SetupArgs = { ok: true; force: boolean; subject: string | null } | { ok: false; error: string }

/** `--force` と `--subject <連絡先>`。subject は normalizeSubject を通した形 */
export function parseArgs(argv: readonly string[]): SetupArgs

/** text に混ざった values を `***` に置き換える */
export function redact(text: string, values: readonly string[]): string
