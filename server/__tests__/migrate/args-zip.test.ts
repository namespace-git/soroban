import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs, UsageError, USAGE } from '../../../tools/migrate-to-web/args'

// 引数の「zip をそのまま渡す形」。従来の形（<soroban.db> <thumbs> …）は args.test.ts が見ている

const HH = '11111111-2222-4333-8444-555555555555'
const CWD = resolve('/work/soroban')

describe('zip をそのまま渡す形', () => {
  it('zip 1 つだけ。世帯 id は要らない（ログインした人から引く）', () => {
    const a = parseArgs(['C:\\Users\\me\\Downloads\\soroban-backup-2026-10-09-0016.zip'], CWD)
    expect(a.zipFile).toMatch(/soroban-backup-2026-10-09-0016\.zip$/)
    expect(a).toMatchObject({ dryRun: false, householdId: null, help: false, sqliteFile: '', imagesDir: '' })
    expect(a.repoRoot).toBe(CWD)
    expect(a.migrationsDir).toBe(join(CWD, 'supabase', 'migrations'))
  })

  it('--dry-run・--household・--image-map・--repo-root・--migrations が付けられる。順番は自由', () => {
    const a = parseArgs(['--dry-run', 'backup.ZIP', '--image-map', 'map.json', '--repo-root', 'repo', '--migrations', 'm'], CWD)
    expect(a).toMatchObject({ dryRun: true, zipFile: resolve(CWD, 'backup.ZIP') })
    expect(a.imageMapFile).toBe(resolve(CWD, 'map.json'))
    expect(a.repoRoot).toBe(resolve(CWD, 'repo'))
    expect(a.migrationsDir).toBe(resolve(CWD, 'm'))
    expect(parseArgs([`--household=${HH}`, 'b.zip'], CWD).householdId).toBe(HH)
  })

  it('--household は uuid の形でなければ断る。--yes のような確認を飛ばす口は無い', () => {
    expect(() => parseArgs(['b.zip', '--household', 'abc'], CWD)).toThrow(/uuid/)
    expect(() => parseArgs(['b.zip', '--yes'], CWD)).toThrow(/知らないオプション/)
    expect(() => parseArgs(['b.zip', '-y'], CWD)).toThrow(/知らないオプション/)
    expect(() => parseArgs(['b.zip', '--force'], CWD)).toThrow(UsageError)
  })

  it('従来の形は変わらない。zip でない 1 つだけ・引数なし・3 つは断る', () => {
    const legacy = parseArgs(['a.db', 'thumbs', '--household', HH], CWD)
    expect(legacy.zipFile).toBeNull()
    expect(legacy.sqliteFile).toBe(resolve(CWD, 'a.db'))
    expect(() => parseArgs(['a.db'], CWD)).toThrow(/2 つ必要/)
    expect(() => parseArgs([], CWD)).toThrow(/2 つ必要/)
    expect(() => parseArgs(['a.zip', 'thumbs', 'x'], CWD)).toThrow(/2 つ必要/)
    // zip が 2 つ並んでも、従来の形（soroban.db と thumbs）としては読まない … 2 つなら従来の形として世帯 id を求める
    expect(() => parseArgs(['a.zip', 'b.zip'], CWD)).toThrow(/--household/)
  })

  it('使い方に、zip の形・伏せ字・確認が書いてある', () => {
    expect(USAGE).toContain('pnpm migrate:web <バックアップの zip>')
    expect(USAGE).toContain('伏せ字')
    expect(USAGE).toContain('yes')
    expect(USAGE).not.toContain('--yes')
  })
})
