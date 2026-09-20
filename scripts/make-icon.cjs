// build/icon.svg を Electron の隠しウィンドウで描画して build/icon.png（1024×1024・透過）を作る。
// ImageMagick などの外部ツールに頼らないため、開発に使う Electron だけで完結する。
// macOS の .icns / Windows の .ico は electron-builder がこの PNG から作る。
//
//   pnpm icon
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'build', 'icon.svg')
const outPath = path.join(root, 'build', 'icon.png')

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(svgPath, 'utf8')
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${SIZE}px;height:${SIZE}px}
    </style></head><body>${svg}</body></html>`
    const win = new BrowserWindow({
      width: SIZE, height: SIZE, show: false, transparent: true, frame: false,
      useContentSize: true, webPreferences: { backgroundThrottling: false },
    })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((r) => setTimeout(r, 800))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
    fs.writeFileSync(outPath, img.toPNG())
    const { width, height } = img.getSize()
    console.log(`wrote ${path.relative(root, outPath)} (${width}x${height})`)
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  app.quit()
})
