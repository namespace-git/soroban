// electron-builder の afterPack フック。
// macOS: 配布用の署名（Apple Developer Program）は持っていないが、Apple Silicon は
// 「署名が全く無い」アプリを起動させない（起動直後に trace trap で落ちる）。
// そこでパック直後に ad-hoc 署名（identity "-"）を入れる。Gatekeeper には引っかかるので
// 初回は右クリック → 開く（README）。
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  // OCR ヘルパー（soroban-ocr）は Resources 直下に置かれた裸の Mach-O 実行ファイルで、
  // codesign --deep がバンドル（.app/.framework/.xpc）以外の裸の実行ファイルまで
  // 確実に拾うとは限らないため、先に単体で ad-hoc 署名しておく。
  const ocrHelperPath = path.join(appPath, 'Contents', 'Resources', 'soroban-ocr')
  if (fs.existsSync(ocrHelperPath)) {
    console.log(`  • ad-hoc codesign  ${ocrHelperPath}`)
    execFileSync('codesign', ['--force', '--sign', '-', ocrHelperPath], { stdio: 'inherit' })
  }

  console.log(`  • ad-hoc codesign  ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
