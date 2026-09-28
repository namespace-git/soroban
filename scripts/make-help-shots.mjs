// ヘルプに貼るスクリーンショットを、mock（架空データ）から自動で撮る。
//
//   node scripts/make-help-shots.mjs
//
// 絶対に本番のDB（%APPDATA%\soroban）は使わない。`pnpm exec vite --config vite.review.config.ts`
// （port 5199）が動かす src/renderer/mock/soroban-mock.ts の架空データだけを撮る。
// 撮影は Electron のオフスクリーン BrowserWindow（show:false・webPreferences.offscreen:true）と
// capturePage()。素の node から呼ばれたときは、自分を electron 本体で再実行する
//（pnpm icon の scripts/make-icon.cjs と同じ考え方）。
//
// 撮り直すと、日付の入った数枚だけ中身が変わることがある。これは不具合ではない。
// mock の日付は new Date() / Date.now() から組み立てているので、撮った日が違えば
// 「n日前」「滞留 n日」などの表示が当然ずれる。原因を探しに行かないこと。
//
// 1枚ごとの手順は SHOTS 配列にデータで持つ。`go` はその画面・状態に持っていく手順
//（クラス名ではなく、ボタン等の文字で探してクリックする）。`clip` は切り抜く範囲を
// CSS セレクタで指定する（querySelector の getBoundingClientRect + 余白）。
//
// 画像は src/renderer/help/shots/<id>.png に置く。src/renderer/help/shots.ts が
// import.meta.glob で拾うので、そちらは触らない（このスクリプトが書くのは png だけ）。

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'src/renderer/help/shots')
const TOPICS_PATH = path.join(ROOT, 'src/renderer/help/topics.ts')
const PORT = 5199
// 127.0.0.1 だと、vite が ::1（IPv6）にしか bind していない環境で誤って「空いている」と
// 判定してしまう（実際に踏んだ）。localhost で名前解決させて実体に合わせる
const BASE_URL = `http://localhost:${PORT}/`
const WINDOW_WIDTH = 1366
// 768 だと縦に長いパネル（設定 → 取り込みの実行履歴など）が下端で切れる（実際に踏んだ）。
// capturePage は今見えているビューポートしか撮れないため、スクロールでは直せない。少し広げておく
const WINDOW_HEIGHT = 1000
const MAX_IMAGE_WIDTH = 900

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================================
// 素の node から呼ばれたら、Electron 本体で自分を再実行する
// ============================================================

if (!process.versions.electron) {
  const electronPath = require('electron')
  // ELECTRON_RUN_AS_NODE が立っていると electron.exe がただの node として動いてしまい、
  // app / BrowserWindow が使えない（pnpm test 用の env が漏れてくることがある。実際に踏んだ）
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: childEnv,
  })
  child.on('exit', (code) => process.exit(code == null ? 1 : code))
  child.on('error', (e) => { console.error(e); process.exit(1) })
} else {
  main().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
}

// ============================================================
// vite（review 用サーバ、port 5199）。既に空いていなければそのまま使う
// ============================================================

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/', timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) return true
    await delay(300)
  }
  return false
}

async function ensureVite() {
  if (await checkPort(PORT)) {
    console.log(`[vite] port ${PORT} は既に使われているので、そのまま使います（このスクリプトでは起動・停止しません）`)
    return { started: false, proc: null }
  }
  console.log('[vite] 起動します：pnpm exec vite --config vite.review.config.ts')
  // Windows は .cmd を shell 無しで spawn すると EINVAL になることがある（実際に踏んだ）。
  // shell:true のときは引数を配列のまま渡すと Node が警告を出すので、1本の文字列にする
  // （固定のコマンドで利用者の入力は混ざらないため、エスケープの心配は無い）
  const isWin = process.platform === 'win32'
  const proc = spawn(
    isWin ? 'pnpm exec vite --config vite.review.config.ts' : 'pnpm',
    isWin ? [] : ['exec', 'vite', '--config', 'vite.review.config.ts'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin },
  )
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  const ok = await waitForPort(PORT, 30000)
  if (!ok) {
    stopVite(proc)
    throw new Error(`vite dev server（port ${PORT}）が起動しませんでした`)
  }
  console.log(`[vite] 起動しました（pid ${proc.pid}）`)
  return { started: true, proc }
}

function stopVite(proc) {
  if (!proc || proc.killed) return
  console.log(`[vite] 止めます（pid ${proc.pid}）`)
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'])
  } else {
    try { proc.kill('SIGTERM') } catch { /* noop */ }
  }
}

// ============================================================
// ページ内で使う小さなヘルパー（クラス名ではなく文字で探す）。
// ページ読み込みのたびに window.__sb として差し込み直す
// ============================================================

const HELPERS_JS = `
(function () {
  window.__sb = {
    visible: function (el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    },
    findByText: function (text, opts) {
      opts = opts || {};
      var exact = opts.exact !== false;
      var root = opts.within ? document.querySelector(opts.within) : document;
      if (!root) return [];
      var all = Array.prototype.slice.call(root.querySelectorAll('*'));
      var self = this;
      var matches = all.filter(function (el) {
        if (!self.visible(el)) return false;
        var t = (el.textContent || '').trim();
        if (!t) return false;
        return exact ? t === text : t.indexOf(text) !== -1;
      });
      matches.sort(function (a, b) {
        return a.textContent.trim().length - b.textContent.trim().length;
      });
      return matches;
    },
    climbClickable: function (el) {
      var cur = el;
      while (cur && cur !== document.body) {
        var tag = cur.tagName;
        if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'LABEL' ||
            cur.getAttribute('role') === 'button' || cur.hasAttribute('tabindex')) return cur;
        cur = cur.parentElement;
      }
      return el;
    },
    clickText: function (text, opts) {
      opts = opts || {};
      var matches = this.findByText(text, opts);
      var el = matches[opts.nth || 0];
      if (!el) return false;
      var target = this.climbClickable(el);
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    },
    clickSelector: function (sel, nth) {
      var els = document.querySelectorAll(sel);
      var el = els[nth || 0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    },
    setSelect: function (sel, value, nth) {
      var els = document.querySelectorAll(sel);
      var el = els[nth || 0];
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    mark: function (rootSel, textSel, text, as, opts) {
      opts = opts || {};
      var exact = opts.exact !== false;
      var roots = Array.prototype.slice.call(document.querySelectorAll(rootSel));
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        if (!this.visible(root)) continue;
        var target = textSel ? root.querySelector(textSel) : root;
        if (!target) continue;
        var t = (target.textContent || '').trim();
        var ok = exact ? t === text : t.indexOf(text) !== -1;
        if (ok) { root.setAttribute('data-shot', as); return true; }
      }
      return false;
    },
    markHasChild: function (rootSel, childSel, as) {
      var roots = Array.prototype.slice.call(document.querySelectorAll(rootSel));
      for (var i = 0; i < roots.length; i++) {
        if (roots[i].querySelector(childSel)) { roots[i].setAttribute('data-shot', as); return true; }
      }
      return false;
    },
    // 「下書き（価格未入力）」のような、金額が全部0の見本行を撮ってしまわないための除外版。
    // 文字列で見るので、クラス名が変わっても壊れない
    markExcludingText: function (rootSel, excludeText, as) {
      var roots = Array.prototype.slice.call(document.querySelectorAll(rootSel));
      for (var i = 0; i < roots.length; i++) {
        var t = roots[i].textContent || '';
        if (t.indexOf(excludeText) === -1) { roots[i].setAttribute('data-shot', as); return true; }
      }
      return false;
    },
    scrollTo: function (sel, nth) {
      var els = document.querySelectorAll(sel);
      var el = els[nth || 0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    },
    // clip 用。'center' だと縦に長いパネル（.page 全体など）ではパネルの真ん中まで
    // スクロールしてしまい、見出しや上のほうが切れて中途半端な位置を撮ってしまう
    //（実際に踏んだ）。撮る前は常に「先頭が見える位置」に揃える
    scrollToStart: function (sel, nth) {
      var els = document.querySelectorAll(sel);
      var el = els[nth || 0];
      if (!el) return false;
      el.scrollIntoView({ block: 'start' });
      return true;
    },
    // overflow-x:auto な内側の要素を右端までスクロールする（表の右のほうの列を撮るとき用）。
    // ページ自体のスクロールではなく、その要素自身の scrollLeft を動かす
    scrollRight: function (sel, nth) {
      var els = document.querySelectorAll(sel);
      var el = els[nth || 0];
      if (!el) return false;
      el.scrollLeft = el.scrollWidth;
      return true;
    },
  };
  return true;
})()
`

async function installHelpers(win) {
  await win.webContents.executeJavaScript(HELPERS_JS)
}

async function waitForSelector(win, sel, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = await win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(sel)})`)
    if (found) return true
    await delay(120)
  }
  throw new Error(`タイムアウト：${sel} が出てきません`)
}

// --- CSV ファイル選択のような <input type=file> は、実 OS のダイアログを開けないので
//     CDP（Chrome DevTools Protocol）の DOM.setFileInputFiles で「選んだこと」にする ---
async function injectFile(win, sel, filePath) {
  const wc = win.webContents
  wc.debugger.attach('1.3')
  try {
    const doc = await wc.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: sel,
    })
    if (!nodeId) throw new Error(`ファイル選択欄が見つかりません：${sel}`)
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId })
  } finally {
    try { wc.debugger.detach() } catch { /* noop */ }
  }
}

async function runStep(win, step) {
  if (step.wait != null) { await delay(step.wait); return }
  if (step.waitFor) { await waitForSelector(win, step.waitFor, step.timeout ?? 8000); await delay(80); return }
  if (step.scrollTo) {
    await win.webContents.executeJavaScript(
      `window.__sb.scrollTo(${JSON.stringify(step.scrollTo)}, ${step.nth || 0})`,
    )
    await delay(step.after ?? 150)
    return
  }
  if (step.scrollRight) {
    const { sel, nth } = step.scrollRight
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.scrollRight(${JSON.stringify(sel)}, ${nth || 0})`,
    )
    if (!ok) throw new Error(`横スクロールの対象が見つかりません：${sel}`)
    await delay(step.after ?? 250)
    return
  }
  if (step.click != null || step.clickContains != null) {
    const text = step.click != null ? step.click : step.clickContains
    const exact = step.click != null
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.clickText(${JSON.stringify(text)}, ${JSON.stringify({ exact, nth: step.nth || 0, within: step.within || null })})`,
    )
    if (!ok) throw new Error(`クリック対象の文字が見つかりません：「${text}」`)
    await delay(step.after ?? 320)
    return
  }
  if (step.clickSelector != null) {
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.clickSelector(${JSON.stringify(step.clickSelector)}, ${step.nth || 0})`,
    )
    if (!ok) throw new Error(`クリック対象のセレクタが見つかりません：${step.clickSelector}`)
    await delay(step.after ?? 320)
    return
  }
  if (step.selectOption) {
    const { sel, value, nth } = step.selectOption
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.setSelect(${JSON.stringify(sel)}, ${JSON.stringify(value)}, ${nth || 0})`,
    )
    if (!ok) throw new Error(`セレクトが見つかりません：${sel}`)
    await delay(step.after ?? 300)
    return
  }
  if (step.mark) {
    const { root, textSel, text, as, mode } = step.mark
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.mark(${JSON.stringify(root)}, ${JSON.stringify(textSel || null)}, ${JSON.stringify(text)}, ${JSON.stringify(as)}, ${JSON.stringify({ exact: mode !== 'contains' })})`,
    )
    if (!ok) throw new Error(`目印を付ける対象が見つかりません：「${text}」（${root}）`)
    return
  }
  if (step.markHasChild) {
    const { root, child, as } = step.markHasChild
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.markHasChild(${JSON.stringify(root)}, ${JSON.stringify(child)}, ${JSON.stringify(as)})`,
    )
    if (!ok) throw new Error(`目印を付ける対象が見つかりません：${root} に ${child} を含むもの`)
    return
  }
  if (step.markExcludingText) {
    const { root, exclude, as } = step.markExcludingText
    const ok = await win.webContents.executeJavaScript(
      `window.__sb.markExcludingText(${JSON.stringify(root)}, ${JSON.stringify(exclude)}, ${JSON.stringify(as)})`,
    )
    if (!ok) throw new Error(`目印を付ける対象が見つかりません：${root}（「${exclude}」を含まないもの）`)
    return
  }
  if (step.setFile) {
    await injectFile(win, step.setFile.sel, step.setFile.file)
    await delay(step.after ?? 500)
    return
  }
  throw new Error(`未知の手順：${JSON.stringify(step)}`)
}

// --- clip：CSS セレクタ（複数なら外接の範囲）の getBoundingClientRect + 余白 ---
async function resolveClipRect(win, clip) {
  const selectors = typeof clip === 'string' ? [clip] : clip.union ? clip.union : [clip.sel]
  const nth = typeof clip === 'object' && !clip.union ? (clip.nth || 0) : 0
  // まず対象の先頭が画面内に入るようスクロールしておく（縦に長いパネルだと 'center' では
  // 真ん中までスクロールして見出しが切れる。実際に踏んだ）
  await win.webContents.executeJavaScript(
    `window.__sb.scrollToStart(${JSON.stringify(selectors[0])}, ${selectors.length > 1 ? 0 : nth})`,
  )
  await delay(120)
  const js = `
    (function () {
      var sels = ${JSON.stringify(selectors)};
      var nth = ${nth};
      var rects = [];
      for (var i = 0; i < sels.length; i++) {
        var els = document.querySelectorAll(sels[i]);
        var el = sels.length > 1 ? els[0] : els[nth];
        if (!el) continue;
        rects.push(el.getBoundingClientRect());
      }
      if (!rects.length) return null;
      var pad = 12;
      var top = Math.min.apply(null, rects.map(function (r) { return r.top; }));
      var left = Math.min.apply(null, rects.map(function (r) { return r.left; }));
      var right = Math.max.apply(null, rects.map(function (r) { return r.right; }));
      var bottom = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
      var x = Math.max(0, Math.floor(left - pad));
      var y = Math.max(0, Math.floor(top - pad));
      var rx = Math.min(window.innerWidth, Math.ceil(right + pad));
      var ry = Math.min(window.innerHeight, Math.ceil(bottom + pad));
      return { x: x, y: y, width: Math.max(1, rx - x), height: Math.max(1, ry - y) };
    })()
  `
  return win.webContents.executeJavaScript(js)
}

// ============================================================
// 1枚ごとの手順。id はファイル名（help/shots/<id>.png）。
// go は「その画面・状態に持っていく手順」（文字で探してクリック、クラス名には頼らない）。
// clip は「切り抜く範囲」（CSS セレクタ、getBoundingClientRect + 余白で切る）。
// caption はここでは書かない（別タスクが topics.ts に書く）。
// ============================================================

/** CSV 取り込みの見本（scripts が一時ファイルに書き、CDP で「選んだこと」にする） */
const SAMPLE_CSV = [
  '仕入先,注文日,注文番号,商品名,型番,単価,数量,送料,その他費用,割引,配送状態,メモ',
  'メロジョイA,2026-09-20,300210,【Z078-2】ムースクリーム S,Z078-2,2699,2,499,,,到着済,',
  'TikTok Shop,2026/9/18,,クリーミークリーム ポーチ,,1500,1,,,,発送準備中,手入力の仕入',
  'メロジョイC,2026-09-15,300211,仕入先が見つからない例,,1000,1,,,,,',
].join('\r\n')

const SHOTS = [
  // ---------------- ホーム ----------------
  {
    id: 'home-overview',
    go: [{ waitFor: '.inbox-panel' }, { wait: 300 }],
    clip: '.page',
  },
  {
    id: 'home-todo',
    go: [{ waitFor: '.inbox-panel' }, { wait: 300 }],
    clip: '.inbox-panel',
  },
  {
    id: 'home-ship-row',
    go: [
      { waitFor: '.inbox-panel' }, { wait: 300 },
      { mark: { root: '.group', textSel: '.group-label', text: '発送する', as: 'ship' } },
    ],
    clip: { sel: '[data-shot="ship"] .inbox-row', nth: 0 },
  },
  {
    id: 'home-shipping-row',
    go: [
      { waitFor: '.inbox-panel' }, { wait: 300 },
      { mark: { root: '.group', textSel: '.group-label', text: '送料を入れる', as: 'shipping' } },
    ],
    clip: { sel: '[data-shot="shipping"] .inbox-row', nth: 0 },
  },
  {
    id: 'home-link-row',
    go: [
      { waitFor: '.inbox-panel' }, { wait: 300 },
      { mark: { root: '.group', textSel: '.group-label', text: '在庫を紐付ける', as: 'link' } },
    ],
    clip: { sel: '[data-shot="link"] .inbox-row', nth: 0 },
  },
  {
    id: 'home-profit-strip',
    go: [{ waitFor: '.inbox-panel' }, { wait: 300 }],
    clip: 'main .profit-strip-bar',
  },

  // ---------------- 売上 ----------------
  {
    id: 'sales-toolbar',
    go: [{ click: '売上' }, { waitFor: '.work-panel' }, { wait: 250 }],
    clip: '.toolbar',
  },
  {
    id: 'sales-stage-tabs',
    go: [{ click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 }],
    clip: '.stage-strip',
  },
  {
    id: 'sales-needs-input-row',
    // 「未紐付け」の入力バンドのピル（2番目の .input-pill-btn）で絞ると、原価欄に
    // 「在庫を選ぶ」が出る本当に未紐付けの行だけになる（既定の並びだと自動紐付け済みの行が
    // 先頭に来ることがあり、間違って撮ってしまう。実際に踏んだ）
    go: [
      { click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 },
      { clickSelector: '.input-pill-btn', nth: 1, after: 500 },
    ],
    clip: { sel: '.work-row:not(.work-row-hdr)', nth: 0 },
  },
  {
    id: 'sales-ship-select',
    go: [{ click: '売上' }, { waitFor: '.work-panel' }, { wait: 250 }],
    // .cell-ship は見出し行（.work-row-hdr）にもあるので、データ行に絞る
    clip: { sel: '.work-row:not(.work-row-hdr) .cell-ship', nth: 0 },
  },
  {
    id: 'sales-cost-pick',
    go: [{ click: '売上' }, { waitFor: '.work-panel' }, { wait: 250 }],
    clip: { sel: '.work-row:not(.work-row-hdr) .cell-cost', nth: 0 },
  },
  {
    id: 'sales-alloc-drawer',
    go: [
      { click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 },
      // 「発送する」段は紐付け済みが多いので、出品も混ざる「すべて」で未紐付けを確実に探す
      { click: 'すべて' }, { wait: 400 },
      { click: '在庫を選ぶ', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
    ],
    clip: '.drawer[role="dialog"]',
  },
  {
    id: 'sales-alloc-checked-profit',
    go: [
      { click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 },
      { click: 'すべて' }, { wait: 400 },
      { click: '在庫を選ぶ', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
      { clickSelector: '.candidates .item input[type="checkbox"]', after: 500 },
    ],
    clip: '.drawer[role="dialog"]',
  },
  {
    id: 'sales-profit-confirmed-row',
    // 先頭行（既定の並び）は「未確定が先」なので、そのままでは送料・紐付けが未入力の行を
    // 撮ってしまう（実際に踏んだ）。.settled（=未確定ではない行）のうち、粗利がプラスの
    // （.profit が付く＝私物でも赤字でもない）最初の行を選ぶ
    go: [
      { click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 },
      { click: '取引完了' }, { wait: 400 },
      { markHasChild: { root: '.work-row.settled', child: '.cell-profit .profit', as: 'confirmed-row' } },
    ],
    clip: '[data-shot="confirmed-row"]',
  },
  {
    id: 'sales-manual-form',
    go: [{ click: '売上' }, { waitFor: '.page-head' }, { click: '販売を登録', after: 300 }],
    clip: '.form',
  },
  {
    id: 'sales-timeline',
    go: [
      { click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 },
      { click: '取引完了' }, { wait: 400 },
      { clickSelector: '.work-row:not(.work-row-hdr) .row-title.clickable', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
    ],
    clip: '.drawer[role="dialog"]',
  },
  {
    id: 'sales-row-ops',
    // 行末の操作ボタン（タグ・履歴・メモ・梱包・手数料・削除）。手数料ボタンの説明用
    go: [
      { click: '売上' }, { waitFor: '.stage-strip' }, { wait: 250 },
      { click: '取引完了' }, { wait: 400 },
      { markHasChild: { root: '.work-row.settled', child: '.cell-profit .profit', as: 'ops-row' } },
    ],
    clip: '[data-shot="ops-row"] .cell-ops',
  },

  // ---------------- 仕入 ----------------
  {
    id: 'purchases-list',
    go: [{ click: '仕入' }, { waitFor: '.table-panel table' }, { wait: 300 }],
    clip: '.table-panel',
  },
  {
    id: 'purchases-account-cards',
    go: [{ click: '仕入' }, { waitFor: '.acc-row' }, { wait: 300 }],
    clip: '.acc-row',
  },
  {
    id: 'purchases-drawer',
    go: [
      { click: '仕入' }, { waitFor: 'tbody tr.clickable' }, { wait: 250 },
      { clickSelector: 'tbody tr.clickable', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
    ],
    clip: '.drawer[role="dialog"]',
  },
  {
    id: 'purchases-lines-alloc',
    go: [
      { click: '仕入' }, { waitFor: 'tbody tr.clickable' }, { wait: 250 },
      // 先頭は「価格未入力」の下書きのことがあり、金額が全部0で按分の見本にならない。除いて選ぶ
      { markExcludingText: { root: 'tbody tr.clickable', exclude: '価格未入力', as: 'confirmed' } },
      { clickSelector: '[data-shot="confirmed"]', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
    ],
    clip: { union: ['.lines-list', '.totals-block'] },
  },
  {
    id: 'purchases-shipping-progress',
    go: [
      { click: '仕入' }, { waitFor: 'tbody tr.clickable' }, { wait: 250 },
      { markExcludingText: { root: 'tbody tr.clickable', exclude: '価格未入力', as: 'confirmed' } },
      { clickSelector: '[data-shot="confirmed"]', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
    ],
    clip: { sel: '.drawer[role="dialog"] .ship-progress', nth: 0 },
  },
  {
    id: 'purchases-tracking-row',
    go: [
      { click: '仕入' }, { waitFor: 'tbody tr.clickable' }, { wait: 250 },
      { markHasChild: { root: 'tbody tr.clickable', child: '.ship-tracking-icon', as: 'tracking' } },
      { clickSelector: '[data-shot="tracking"]', after: 500 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 300 },
    ],
    clip: '.tracking-block',
  },
  {
    id: 'purchases-csv-import',
    go: [
      { click: '仕入' }, { waitFor: '.page-head' },
      { click: 'CSV で一括登録', after: 400 },
      { waitFor: '.drawer[role="dialog"]' }, { wait: 200 },
      { setFile: { sel: 'input[type="file"]', file: null /* main() が実ファイルに差し替える */ }, after: 500 },
    ],
    clip: '.drawer[role="dialog"]',
  },
  {
    id: 'purchases-register-form',
    go: [{ click: '仕入' }, { waitFor: '.page-head' }, { click: '仕入を登録', after: 300 }],
    clip: '.form',
  },

  // ---------------- 在庫 ----------------
  {
    id: 'inventory-list',
    go: [{ click: '在庫' }, { waitFor: '.group' }, { wait: 300 }],
    clip: '.page',
  },
  {
    id: 'inventory-group',
    go: [{ click: '在庫' }, { waitFor: '.group' }, { wait: 300 }],
    clip: { sel: '.group', nth: 0 },
  },
  {
    id: 'inventory-flat',
    go: [{ click: '在庫' }, { waitFor: '.group' }, { click: '1点ずつ', after: 400 }],
    clip: '.table-panel',
  },
  {
    id: 'inventory-split',
    go: [
      { click: '在庫' }, { waitFor: '.group' }, { wait: 300 },
      { click: '分割', after: 400 },
      { waitFor: '.scrim .panel' }, { wait: 250 },
    ],
    clip: '.scrim .panel',
  },
  {
    id: 'inventory-dispose',
    go: [
      { click: '在庫' }, { waitFor: '.group' }, { wait: 300 },
      { click: '廃棄', after: 400 },
      { waitFor: '.scrim .panel' }, { wait: 250 },
    ],
    clip: '.scrim .panel',
  },

  // ---------------- 商品 ----------------
  {
    id: 'products-list',
    go: [{ click: '商品' }, { waitFor: '.karte' }, { wait: 400 }],
    clip: '.list-panel',
  },
  {
    id: 'products-karte',
    go: [{ click: '商品' }, { waitFor: '.karte' }, { wait: 400 }],
    clip: '.karte-head',
  },
  {
    id: 'products-estimate',
    go: [{ click: '商品' }, { waitFor: '.karte' }, { wait: 400 }],
    clip: { sel: '.calc', nth: 0 },
  },
  {
    id: 'products-image-set',
    go: [{ click: '商品' }, { waitFor: '.karte' }, { wait: 400 }],
    clip: '.karte-thumb-col',
  },

  // ---------------- 月次 ----------------
  {
    id: 'monthly-list',
    go: [{ click: '月次' }, { waitFor: '.month-band' }, { wait: 400 }],
    clip: '.month-band',
  },
  {
    id: 'monthly-detail-alloc',
    // 販売ごとの表は列が多く（.table-panel { overflow-x: auto }）、既定のスクロール位置（左端）
    // だと右端の「按分経費」「按分後利益」が枠の外に隠れて写らない（実際に踏んだ）。
    // 内側を右端までスクロールしてから、ツールバー（按分方法のセレクト）と表をまとめて撮る
    go: [
      { click: '月次' }, { waitFor: '.statement-card' }, { wait: 500 },
      { scrollRight: { sel: '.sales-block .table-panel' } },
    ],
    clip: { union: ['.sales-block .toolbar', '.sales-block .table-panel'] },
  },
  {
    id: 'monthly-realized-forecast',
    go: [
      { click: '月次' }, { waitFor: '.month-band' }, { wait: 300 },
      { clickContains: '（今月）', after: 500 },
    ],
    clip: '.forecast-panel',
  },

  // ---------------- 経費 ----------------
  {
    id: 'expenses-list',
    go: [{ click: '経費' }, { waitFor: '.list-panel' }, { wait: 300 }],
    clip: '.list-panel',
  },
  {
    id: 'expenses-receipt-read',
    go: [
      { click: '経費' }, { waitFor: '.page-head' },
      { click: 'レシートを読み取って登録', after: 700 },
      { waitFor: '.detail-panel' }, { wait: 300 },
    ],
    clip: '.detail-panel',
  },
  {
    id: 'expenses-alloc',
    go: [{ click: '月次' }, { waitFor: '.statement-card' }, { wait: 500 }],
    clip: { sel: '.sales-block .table-panel', nth: 1 },
  },

  // ---------------- 設定 ----------------
  {
    id: 'settings-import',
    // 先にヘッダの「取り込む」を1回押しておくと、実行履歴にメルカリ・メロジョイ・Yahoo!フリマの
    // 3件が並ぶ（モックの collect() が合成する）。Yahoo!フリマの取り込みが実行履歴に出ることを
    // 見せるのに使う（ヘルプの yahoo-channel からも参照）。完了直後に出る通知バナーが
    // パネルに重なって写ってしまうため、消えるまで（5秒で自動で消える）待ってから開く
    go: [
      { click: '取り込む', after: 6200 },
      { click: '設定' }, { waitFor: '.section-head-title' }, { wait: 400 },
      { mark: { root: '.panel', textSel: '.section-head-title', text: '取り込み', as: 'import' } },
    ],
    clip: '[data-shot="import"]',
  },
  {
    id: 'settings-channel-keywords',
    go: [
      { click: '設定' }, { waitFor: '.section-head-title' }, { wait: 400 },
      { mark: { root: '.panel', textSel: '.section-head-title', text: 'メルカリ', as: 'mercari-panel' } },
      { mark: { root: '.panel', textSel: '.section-head-title', text: 'Yahoo!フリマ', as: 'yahoo-panel' } },
    ],
    clip: { union: ['[data-shot="mercari-panel"]', '[data-shot="yahoo-panel"]'] },
  },
  {
    id: 'settings-fee',
    go: [
      { click: '設定' }, { waitFor: '.section-head-title' }, { wait: 400 },
      { mark: { root: '.panel', textSel: '.section-head-title', text: '手数料', as: 'fee' } },
    ],
    clip: '[data-shot="fee"]',
  },
  {
    id: 'settings-shipping-methods',
    go: [
      { click: '設定' }, { waitFor: '.section-head-title' }, { wait: 400 },
      { mark: { root: '.panel', textSel: '.section-head-title', text: '発送方法', as: 'ship-methods' } },
    ],
    clip: '[data-shot="ship-methods"]',
  },
  {
    id: 'settings-csv-export',
    go: [{ click: '設定' }, { waitFor: '.csv-title' }, { wait: 400 }],
    clip: { union: ['.csv-title', '.csv-title + .row'] },
  },
  {
    id: 'settings-health',
    go: [{ click: '設定' }, { waitFor: '.health-head' }, { wait: 400 }],
    clip: { union: ['.health-head', '.health-list'] },
  },
  {
    id: 'settings-backup',
    go: [{ click: '設定' }, { waitFor: '.auto-backup-title' }, { wait: 400 }],
    clip: { union: ['.auto-backup-title', '.manual-backup-title'] },
  },
  {
    id: 'settings-app-update',
    go: [
      { click: '設定' }, { waitFor: '.section-head-title' }, { wait: 400 },
      { mark: { root: '.panel', textSel: '.section-head-title', text: 'アプリの更新', as: 'app-update' } },
    ],
    clip: '[data-shot="app-update"]',
  },
]

// ============================================================
// 実行
// ============================================================

async function processShot(win, shot, tempCsvPath) {
  await win.loadURL(BASE_URL)
  await waitForSelector(win, '.page-title', 20000)
  await installHelpers(win)
  await delay(350)
  for (const rawStep of shot.go ?? []) {
    const step = rawStep.setFile && rawStep.setFile.file === null
      ? { ...rawStep, setFile: { ...rawStep.setFile, file: tempCsvPath } }
      : rawStep
    await runStep(win, step)
  }
  await delay(150)
  const rect = await resolveClipRect(win, shot.clip)
  if (!rect || rect.width <= 1 || rect.height <= 1) {
    throw new Error(`切り抜く範囲が見つかりません（clip=${JSON.stringify(shot.clip)}）`)
  }
  await delay(80)
  const full = await win.webContents.capturePage()
  let img = full.crop(rect)
  const size = img.getSize()
  if (size.width > MAX_IMAGE_WIDTH) img = img.resize({ width: MAX_IMAGE_WIDTH })
  const buf = img.toPNG()
  fs.writeFileSync(path.join(OUT_DIR, `${shot.id}.png`), buf)
  return buf.length
}

function extractShotIdsFromTopics(text) {
  const ids = new Set()
  const objRe = /\{[^{}]*\}/gs
  let m
  while ((m = objRe.exec(text))) {
    const obj = m[0]
    if (!/kind:\s*'shot'/.test(obj)) continue
    const idm = /id:\s*'([^']+)'/.exec(obj)
    if (idm) ids.add(idm[1])
  }
  return ids
}

function checkTopics(availableIds) {
  console.log('\n=== topics.ts との照合 ===')
  let text
  try {
    text = fs.readFileSync(TOPICS_PATH, 'utf8')
  } catch {
    console.log('topics.ts が読めませんでした（存在しない？）。照合をスキップします')
    return
  }
  const referenced = extractShotIdsFromTopics(text)
  if (referenced.size === 0) {
    console.log('参照 0 件（まだ topics.ts に kind: \'shot\' の参照がありません）')
    return
  }
  console.log(`参照: ${referenced.size} 件`)
  const missing = [...referenced].filter((id) => !availableIds.has(id))
  const unused = [...availableIds].filter((id) => !referenced.has(id))
  if (missing.length) {
    console.log('✗ topics.ts が参照しているのに画像が無い id：')
    missing.forEach((id) => console.log(`  - ${id}`))
    process.exitCode = 1
  } else {
    console.log('topics.ts が参照する画像はすべて揃っています')
  }
  if (unused.length) {
    console.log('（警告）画像はあるが topics.ts が参照していない id：')
    unused.forEach((id) => console.log(`  - ${id}`))
  }
}

async function main() {
  // import('electron') は Electron 本体の main プロセスから .mjs 経由で呼ぶと named export が
  // 空になることがある（実際に踏んだ）。require('electron') は昔からの CJS 経路なので確実に動く
  const { app, BrowserWindow } = require('electron')
  // 既定の userData（%APPDATA%\Electron）は、他の Electron プロセス（本体アプリや別の
  // 検証作業）と共有され、ディスクキャッシュの取り合いで network service が落ちることがある
  //（実際に踏んだ：ERR_CONNECTION_REFUSED で以降すべて失敗する）。専用の場所に逃がす
  app.setName('soroban-help-shots')
  app.setPath('userData', path.join(os.tmpdir(), 'soroban-help-shots-userdata'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-http-cache')
  await app.whenReady()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tempCsvPath = path.join(os.tmpdir(), `soroban-help-shot-sample-${Date.now()}.csv`)
  fs.writeFileSync(tempCsvPath, '﻿' + SAMPLE_CSV, 'utf8')

  const { started, proc } = await ensureVite()
  let win
  try {
    win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      show: false,
      useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    })
    // オフスクリーンは 'paint' を一度でも購読しないと合成が回らないことがあるため、空でも listen する
    win.webContents.on('paint', () => {})

    // ウォームアップ：Vite の初回変換（mock ファイルが大きい）を先に済ませておく
    await win.loadURL(BASE_URL)
    await waitForSelector(win, '.page-title', 30000)
    await delay(500)

    const results = []
    for (const shot of SHOTS) {
      try {
        const bytes = await processShot(win, shot, tempCsvPath)
        results.push({ id: shot.id, bytes })
        console.log(`[ok]     ${shot.id}.png  ${(bytes / 1024).toFixed(1)} KB`)
      } catch (e) {
        results.push({ id: shot.id, error: e instanceof Error ? e.message : String(e) })
        console.error(`[failed] ${shot.id}: ${e instanceof Error ? e.message : e}`)
      }
    }

    console.log('\n=== 生成結果 ===')
    let totalBytes = 0
    let okCount = 0
    for (const r of results) {
      if (r.error) {
        console.log(`  ✗ ${r.id}: ${r.error}`)
      } else {
        totalBytes += r.bytes
        okCount++
        console.log(`  ${r.id}.png  ${(r.bytes / 1024).toFixed(1)} KB`)
      }
    }
    console.log(`合計 ${okCount}/${results.length} 枚, ${(totalBytes / 1024).toFixed(1)} KB`)

    const availableIds = new Set(results.filter((r) => !r.error).map((r) => r.id))
    checkTopics(availableIds)

    if (results.some((r) => r.error)) process.exitCode = 1
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    if (started) stopVite(proc)
    try { fs.unlinkSync(tempCsvPath) } catch { /* noop */ }
  }
  app.quit()
}
