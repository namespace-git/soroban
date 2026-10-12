// ターミナルでの入力。パスワードは**画面に出さない**（伏せ字の * も出さない。長さも見せない）。
// Node の readline は伏せ字に対応していないので、raw モードで 1 文字ずつ読む（PowerShell・Windows Terminal・macOS のターミナルで動く）。
// 入力は変数に持つだけで、ファイル・ログ・履歴に残さない。TTY でないときは作らない（呼び出し側が判断する）

export interface Prompter {
  /** 1 行の入力（画面に出る）。メールアドレス・yes など */
  ask(question: string): Promise<string>
  /** 1 行の入力（画面に出さない）。パスワード・接続文字列など */
  askHidden(question: string): Promise<string>
}

/** Ctrl-C などで入力をやめた */
export class PromptCancelled extends Error {
  constructor() {
    super('入力を中止しました')
    this.name = 'PromptCancelled'
  }
}

/** process.stdin のうち、使うところだけ（テストでは偽物を渡す） */
export interface TerminalInput {
  isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  setEncoding(encoding: BufferEncoding): unknown
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  removeListener(event: 'data', listener: (chunk: string | Buffer) => void): unknown
  removeListener(event: 'end' | 'close', listener: () => void): unknown
  resume(): unknown
  pause(): unknown
}

export interface TerminalOutput {
  write(text: string): unknown
}

// 矢印キーなどの制御列（ESC [ … 終端 / ESC O x）。入力の文字には数えない
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO./g

export function createTerminalPrompter(input: TerminalInput, output: TerminalOutput): Prompter {
  function readLine(question: string, echo: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      if (typeof input.setRawMode !== 'function') {
        // 画面に出さずに読めない端末では、パスワードを読まない（出てしまうより断る）
        reject(new Error('この端末では入力を伏せられないので、パスワードを聞けません。PowerShell か Windows Terminal などで実行してください'))
        return
      }
      let buffer = ''
      let finished = false
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        input.removeListener('data', onData)
        input.removeListener('end', onClosed)
        input.removeListener('close', onClosed)
        input.setRawMode?.(false)
        input.pause()
        output.write('\n')
        const answer = buffer
        buffer = ''
        if (error) reject(error)
        else resolve(answer)
      }
      const onData = (chunk: string | Buffer): void => {
        const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).replace(ESCAPE_SEQUENCE, '')
        for (const ch of text) {
          if (ch === '\r' || ch === '\n') return finish() // 同じ塊の残り（貼り付けた続きの行）は捨てる
          if (ch === '\u0003') return finish(new PromptCancelled()) // Ctrl-C
          if (ch === '\u0004') {
            // Ctrl-D：空のときだけ中止
            if (buffer === '') return finish(new PromptCancelled())
            continue
          }
          if (ch === '\u007f' || ch === '\b') {
            if (buffer.length > 0) {
              buffer = Array.from(buffer).slice(0, -1).join('')
              if (echo) output.write('\b \b')
            }
            continue
          }
          if (ch < ' ') continue // そのほかの制御文字（Tab・Esc の単独など）
          buffer += ch
          if (echo) output.write(ch)
        }
      }
      // 入力が閉じられたら（端末を閉じた・パイプが切れた）、待ち続けずに中止にする（後片付けが走るように）
      const onClosed = (): void => finish(new PromptCancelled())
      output.write(question)
      input.setEncoding('utf8')
      input.setRawMode(true)
      input.resume()
      input.on('data', onData)
      input.on('end', onClosed)
      input.on('close', onClosed)
    })
  }

  return {
    ask: (question) => readLine(question, true),
    askHidden: (question) => readLine(question, false),
  }
}
