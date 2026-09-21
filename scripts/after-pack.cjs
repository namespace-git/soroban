// electron-builder の afterPack フック。
// macOS: 配布用の署名（Apple Developer Program）は持っていないが、Apple Silicon は
// 「署名が全く無い」アプリを起動させない（起動直後に trace trap で落ちる）。
// そこでパック直後に ad-hoc 署名（identity "-"）を入れる。Gatekeeper には引っかかるので
// 初回は右クリック → 開く（README）。
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  console.log(`  • ad-hoc codesign  ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
