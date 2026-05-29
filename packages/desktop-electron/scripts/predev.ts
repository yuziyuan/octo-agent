import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

if (process.platform === "darwin") {
  // Patch Electron binary Info.plist so macOS menu bar shows "Octo AI" in dev mode.
  // Modifying the plist breaks the original code signature, so we re-sign with ad-hoc
  // identity afterwards. node_modules reinstall resets everything, so we patch every run.
  const electronApp = "./node_modules/electron/dist/Electron.app"
  const plist = `${electronApp}/Contents/Info.plist`
  await $`plutil -replace CFBundleDisplayName -string "Octo AI" ${plist}`.quiet()
  await $`plutil -replace CFBundleName -string "Octo AI" ${plist}`.quiet()
  await $`codesign --force --deep --sign - ${electronApp}`.quiet()
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  await $`${lsregister} -f ${electronApp}`.quiet()
  await $`touch ${electronApp}`.quiet()
  await $`killall Dock`.quiet()
}

await $`cd ../opencode && bun script/build-node.ts`
