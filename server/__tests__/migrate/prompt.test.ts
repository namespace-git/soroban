import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createTerminalPrompter, PromptCancelled, type TerminalInput } from '../../../tools/migrate-to-web/prompt'

// ターミナルの入力。パスワードは画面に出さない。本物の端末は使えないので、raw モードの偽物の stdin で確かめる

class FakeTty extends EventEmitter implements TerminalInput {
  isTTY = true
  rawMode = false
  rawHistory: boolean[] = []
  paused = true
  encoding: string | null = null
  setRawMode(mode: boolean): this {
    this.rawMode = mode
    this.rawHistory.push(mode)
    return this
  }
  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding
    return this
  }
  resume(): this {
    this.paused = false
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
  /** 入力を 1 塊ずつ送る（次の tick で。質問が先に出てから） */
  type(...chunks: string[]): void {
    setImmediate(() => {
      for (const chunk of chunks) this.emit('data', chunk)
    })
  }
}

function setup(): { tty: FakeTty; screen: () => string; prompter: ReturnType<typeof createTerminalPrompter> } {
  const tty = new FakeTty()
  let screen = ''
  const prompter = createTerminalPrompter(tty, { write: (text) => (screen += text) })
  return { tty, screen: () => screen, prompter }
}

describe('伏せ字の入力（askHidden）', () => {
  it('打った文字を画面に出さない（* も出さない）。質問と改行だけが出る', async () => {
    const { tty, screen, prompter } = setup()
    const answer = prompter.askHidden('パスワード: ')
    tty.type('s', 'e', 'c', 'r', 'e', 't', '\r')
    expect(await answer).toBe('secret')
    expect(screen()).toBe('パスワード: \n')
    expect(screen()).not.toContain('secret')
    expect(screen()).not.toContain('*')
  })

  it('raw モードに入って、終わったら戻す。入力を止める（プロセスが終われるように）', async () => {
    const { tty, prompter } = setup()
    const answer = prompter.askHidden('q: ')
    tty.type('a\r')
    await answer
    expect(tty.rawHistory).toEqual([true, false])
    expect(tty.rawMode).toBe(false)
    expect(tty.paused).toBe(true)
    expect(tty.encoding).toBe('utf8')
    expect(tty.listenerCount('data')).toBe(0)
  })

  it('Backspace（0x7f も 0x08 も）で 1 文字戻る。何も無いときの Backspace は無視', async () => {
    const { tty, prompter } = setup()
    const answer = prompter.askHidden('q: ')
    tty.type('\u007f', 'abX', '\u007f', 'c', '\b', 'd\r')
    expect(await answer).toBe('abd')
  })

  it('貼り付け（1 塊で来る）や、日本語・記号もそのまま読む。矢印キーなどの制御列は文字にしない', async () => {
    const { tty, prompter } = setup()
    const answer = prompter.askHidden('q: ')
    tty.type('p@ss:w/ord#1?\u001b[A\u001b[D日本語\u001bOP\r')
    expect(await answer).toBe('p@ss:w/ord#1?日本語')
  })

  it('Enter より後ろの文字（貼り付けた続きの行）は次の入力に持ち越さない', async () => {
    const { tty, prompter } = setup()
    const first = prompter.askHidden('q1: ')
    tty.type('first\rleftover\n')
    expect(await first).toBe('first')
    const second = prompter.askHidden('q2: ')
    tty.type('second\r')
    expect(await second).toBe('second')
  })

  it('Ctrl-C は中止（PromptCancelled）。raw モードは戻す。Ctrl-D は空のときだけ中止', async () => {
    const a = setup()
    const cancelled = a.prompter.askHidden('q: ')
    a.tty.type('ab', '\u0003')
    await expect(cancelled).rejects.toBeInstanceOf(PromptCancelled)
    expect(a.tty.rawMode).toBe(false)
    expect(a.screen()).not.toContain('ab')

    const b = setup()
    const eof = b.prompter.askHidden('q: ')
    b.tty.type('\u0004')
    await expect(eof).rejects.toBeInstanceOf(PromptCancelled)

    const c = setup()
    const notEmpty = c.prompter.askHidden('q: ')
    c.tty.type('x', '\u0004', 'y\r')
    expect(await notEmpty).toBe('xy')
  })

  it('入力が閉じられたら（端末を閉じた・パイプが切れた）、待ち続けずに中止にする。何も残さない', async () => {
    for (const event of ['end', 'close']) {
      const { tty, prompter } = setup()
      const answer = prompter.askHidden('q: ')
      setImmediate(() => tty.emit('data', 'half-typed'))
      setImmediate(() => tty.emit(event))
      await expect(answer).rejects.toBeInstanceOf(PromptCancelled)
      expect(tty.rawMode).toBe(false)
      expect(tty.listenerCount('data')).toBe(0)
      expect(tty.listenerCount('end')).toBe(0)
      expect(tty.listenerCount('close')).toBe(0)
    }
  })

  it('raw モードに切り替えられない端末では、パスワードを読まずに断る（出てしまうより断る）', async () => {
    const tty = new FakeTty()
    ;(tty as { setRawMode?: unknown }).setRawMode = undefined
    let screen = ''
    const prompter = createTerminalPrompter(tty, { write: (t) => (screen += t) })
    await expect(prompter.askHidden('q: ')).rejects.toThrow(/入力を伏せられない/)
    expect(tty.listenerCount('data')).toBe(0)
    expect(screen).toBe('')
  })
})

describe('見える入力（ask）', () => {
  it('打った文字を画面に出す。Backspace は画面からも戻す', async () => {
    const { tty, screen, prompter } = setup()
    const answer = prompter.ask('メール: ')
    tty.type('yes', '\u007f', 's\r')
    expect(await answer).toBe('yes')
    expect(screen()).toBe('メール: yes\b \bs\n')
  })

  it('空の Enter は空文字', async () => {
    const { tty, prompter } = setup()
    const answer = prompter.ask('q: ')
    tty.type('\r')
    expect(await answer).toBe('')
  })
})
