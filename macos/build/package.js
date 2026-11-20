// Wraps the staged app folder in Electron for macOS (runs on any OS with Node).
//   node package.js <staged-app-dir> <out-dir> <icon.icns> [arch] [electron-version]
const { packager } = require('@electron/packager')

const [,, appDir, outDir, icon, arch = 'arm64', electronVersion = '45.4.1'] = process.argv

packager({
  dir: appDir,
  out: outDir,
  name: 'AstroSharp',
  platform: 'darwin',
  arch,
  electronVersion,
  icon,
  overwrite: true,
  asar: false, // main.js copies the Shiny app and unpacks R from plain files
  prune: false,
  appBundleId: 'com.deepskydetail.astrosharp',
  appCategoryType: 'public.app-category.photography',
  appVersion: '1.0.0',
  buildVersion: '1.0.0',
  appCopyright: 'AstroSharp by Deep Sky Detail. MIT License.',
  darwinDarkModeSupport: true,
  extendInfo: { NSHumanReadableCopyright: 'AstroSharp by Deep Sky Detail. MIT License.' }
}).then((paths) => console.log('built:', paths.join(', '))).catch((err) => {
  console.error(err)
  process.exit(1)
})
