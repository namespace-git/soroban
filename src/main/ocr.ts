import { app } from 'electron'
import { join } from 'node:path'
import { createWorker, type Worker } from 'tesseract.js'

// ============================================================
// レシート画像のOCR（Tesseract.js＋日本語モデル、完全オフライン）。
//
// 言語データ（jpn.traineddata.gz）はアプリに同梱（resources/tessdata）。
// ネットには一切出ない。ワーカーは1つを使い回す（初回だけモデル展開で数秒）。
// アプリ終了時に terminate する必要はない（プロセスごと終わる）
// ============================================================

let workerPromise: Promise<Worker> | null = null

/** 同梱した言語データの場所。テストでは SOROBAN_TESSDATA で上書きする */
function resolveTessdataPath(): string {
  if (process.env.SOROBAN_TESSDATA) return process.env.SOROBAN_TESSDATA
  return app.isPackaged
    ? join(process.resourcesPath, 'tessdata')
    : join(app.getAppPath(), 'resources', 'tessdata')
}

async function initWorker(): Promise<Worker> {
  const worker = await createWorker('jpn', 1, {
    langPath: resolveTessdataPath(),
    cachePath: join(app.getPath('userData'), 'tessdata-cache'),
    gzip: true,
    logger: () => {},
  })
  await worker.setParameters({ preserve_interword_spaces: '1' })
  return worker
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) workerPromise = initWorker()
  try {
    return await workerPromise
  } catch (err) {
    // 初期化に失敗したら次回また作り直せるようにする
    workerPromise = null
    throw err
  }
}

/** レシート画像を読み取り、生テキストと信頼度（0〜100）を返す */
export async function recognizeImage(filePath: string): Promise<{ text: string; confidence: number }> {
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(filePath)
    return { text: data.text, confidence: data.confidence }
  } catch (err) {
    console.error(err)
    throw new Error('レシートを読み取れませんでした')
  }
}
