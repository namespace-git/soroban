import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Workers の入口（worker/index.ts）のテストの共通部品。Cloudflare には出ない。

/** リポジトリの直下 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
}

/**
 * 本物の ExecutionContext と同じく、waitUntil を ctx から外して呼ぶと「Illegal invocation」で落ちる偽物。
 * 入口が `const { waitUntil } = ctx` のように外して呼ぶ書き方をしたら、ここで気づく。
 */
export function fakeCtx() {
  const waited: Promise<unknown>[] = []
  const ctx = {
    waitUntil(this: unknown, promise: Promise<unknown>) {
      if (this !== ctx) throw new TypeError('Illegal invocation: function called with incorrect `this` reference')
      waited.push(promise)
    },
  }
  return { ctx, waited, done: () => Promise.all(waited) }
}

/** JSONC（コメント・末尾のカンマつきの JSON）を読む。文字列の中の `//`（URL など）はコメントとして扱わない */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '"') {
      // 文字列は閉じる " まで（\ のあとの 1 文字は読み飛ばす）
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  // 末尾のカンマ（`,` のあとに `}` か `]`）を落とす。文字列の外にしか現れないので単純な置換でよい
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** 相対 import を辿って、届くファイルと、出てくる外部モジュール（bare specifier）を集める */
export function walkImports(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const queue = [entry]
  const FROM = /^\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*['"]([^'"]+)['"]|^\s*\}\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(FROM)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec)
        const found = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p))
        if (!found) throw new Error(`${file} の import ${spec} を解決できません`)
        queue.push(found)
      } else {
        bare.add(spec)
      }
    }
  }
  return { files, bare }
}

/** リポジトリ直下からの相対パス（/ 区切り） */
export function relativeFiles(files: Iterable<string>): string[] {
  return [...files].map((f) => f.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'))
}
