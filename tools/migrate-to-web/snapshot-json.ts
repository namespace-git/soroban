import type { SourceSnapshot } from './types'

// SQLite の読み込み結果（SourceSnapshot）を JSON で受け渡す。
// better-sqlite3 は Electron 向けにビルドされていて、Electron の Node でしか開けない。ところが Windows の Electron は
// 端末（TTY）を持たない（stdin/stdout の isTTY が undefined。実機で確認）ので、パスワードを伏せて聞けない。
// そこで zip の形では、全体を普通の Node で動かし、SQLite を読むところだけ Electron の子プロセスにやらせて、結果を JSON で受け取る。
//
// JSON で形が変わりうる値（BLOB・BigInt・NaN/Infinity）は、黙って変えずに**断る**（静かな欠損が最も危険）

export class SnapshotJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotJsonError'
  }
}

export function snapshotToJson(snapshot: SourceSnapshot): string {
  return JSON.stringify(snapshot, function (this: Record<string, unknown>, key: string, value: unknown) {
    // toJSON 済みの値ではなく、元の値で見る（Buffer は toJSON で {type:'Buffer'} に変わってから渡る）
    const original = this[key]
    if (typeof original === 'bigint') throw new SnapshotJsonError(`SQLite の値が BigInt のため、JSON で受け渡せません（${key}）`)
    if (original instanceof Uint8Array) throw new SnapshotJsonError(`SQLite の値が BLOB のため、JSON で受け渡せません（${key}）`)
    if (typeof original === 'number' && !Number.isFinite(original)) throw new SnapshotJsonError(`SQLite の値が数でない（NaN / Infinity）ため、JSON で受け渡せません（${key}）`)
    if (original instanceof Date) throw new SnapshotJsonError(`SQLite の値が Date のため、JSON で受け渡せません（${key}）`)
    return value
  })
}

export function snapshotFromJson(text: string): SourceSnapshot {
  const parsed = JSON.parse(text) as Partial<SourceSnapshot> | null
  if (
    typeof parsed !== 'object' || parsed === null || typeof parsed.tables !== 'object' || typeof parsed.views !== 'object' ||
    typeof parsed.skippedTables !== 'object' || typeof parsed.unknownTables !== 'object'
  ) {
    throw new SnapshotJsonError('SQLite の読み込み結果の形が違います')
  }
  return parsed as SourceSnapshot
}
