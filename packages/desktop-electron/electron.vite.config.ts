import { defineConfig } from "electron-vite"
import desktopPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import * as path from "node:path"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        external: [/\.wasm$/],
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
          // jsonc-parser 的 UMD main 被 Bun bundle 内联进 opencode/dist/node/node.js，但其
          // ./impl/{format,edit,parser,scanner}.js 这几个相对 require 没递归打包，
          // 运行时报 Cannot find module './impl/format'，sidecar 启动直接 unhandled rejection。
          // 从 opencode 包内拷 jsonc-parser 的 lib/umd/impl/* 到 chunks/impl/ 让相对 require 解析得到。
          const implSrc = path.join(OPENCODE_SERVER_DIST, "../../node_modules/jsonc-parser/lib/umd/impl")
          const implDst = "./out/main/chunks/impl"
          await fs.mkdir(implDst, { recursive: true })
          for (const f of await fs.readdir(implSrc)) {
            await fs.copyFile(path.join(implSrc, f), path.join(implDst, f))
          }
          // desktop-electron package.json 有 "type": "module"，Node 把 chunks/impl/*.js
          // 视为 ESM 拒绝 require() 加载，require_main() 拿到的子模块全是空对象，
          // 表现为 `import_jsonc_parser.parse is not a function`。在 impl/ 下放一个局部
          // package.json 把该目录覆盖成 CJS scope（不影响 chunks 根的 ESM bundle 文件）。
          await fs.writeFile(path.join(implDst, "package.json"), '{"type":"commonjs"}\n')
          // opencode bundle 里 SQLite migrations 用相对路径定位：
          //   path.join(import.meta.dirname, "../../migration")
          // 在 opencode 原位置 (packages/opencode/dist/node/) 解析为 packages/opencode/migration/，
          // 但 electron-vite 把 bundle 重定位到 out/main/chunks/ 后，../../migration 变成
          // out/migration/——目录不存在，所有 /provider /global/config /path /project 端点
          // 在 readdirSync 时抛 ENOENT，全 500。把 packages/opencode/migration/ 整树拷到 out/migration/。
          const migSrc = path.join(OPENCODE_SERVER_DIST, "../../migration")
          const migDst = "./out/migration"
          await fs.cp(migSrc, migDst, { recursive: true })
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
      },
    },
  },
  renderer: {
    plugins: [desktopPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
