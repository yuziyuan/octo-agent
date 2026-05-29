# Octo Agent — 架构

> 上次同步：2026-05-07。任何分歧以代码为准。

---

## 1. 一图看懂

```
┌─────────────────────── Electron 主进程 ───────────────────────┐
│  packages/desktop-electron/  (上游壳，仅品牌+接线)               │
│   ├─ 启动 BrowserWindow                                         │
│   ├─ 内嵌 opencode Server (Node 模块，同进程)                    │
│   └─ 注入 OPENCODE_CONFIG=~/.config/octo/octo.json       │
│                                                                  │
│   ┌─────────────────── Renderer ───────────────────┐             │
│   │  packages/desktop-electron/src/renderer/        │             │
│   │  (上游原版，不动)                                │             │
│   │   └─ AppInterface → RouterRoot                   │             │
│   │       ├─ isInsight()  → OctoShell                │             │
│   │       │   └─ /insight/:id? ← InsightPage         │             │
│   │       ├─ isOctoPage() → OctoPageShell            │             │
│   │       │   ├─ /chat  ← ChatPage                   │             │
│   │       │   └─ /studio  ← StudioPage               │             │
│   │       └─ 其余路由 → AppShellProviders (上游原版)  │             │
│   └─────────┬──────────────────────────────────────┘             │
│             │ HTTP + SSE                                          │
│             ▼                                                     │
│   ┌──────────────────────────────────────┐                       │
│   │  内嵌 opencode Server (动态端口)       │                       │
│   │  来自 packages/opencode (上游冻结)     │                       │
│   │   ├─ Hono HTTP routes                │                       │
│   │   ├─ SSE event bus                   │                       │
│   │   └─ SQLite (Drizzle ORM)            │                       │
│   └─────────┬────────────────────────────┘                       │
│             │ Vercel AI SDK                                       │
└─────────────┼────────────────────────────────────────────────────┘
              ▼
   外部 LLM Provider (Anthropic / DeepSeek / 通义 / Google / ...)
```

opencode 不是 sidecar 二进制，是 `import("virtual:opencode-server")` 加载的 Node 模块，**与 Electron 主进程同进程**，再开一个本地 HTTP 服务给 renderer 用。详见 [ADR-001](adr/001-electron-vs-tauri.md)；后端细节见 [learning/opencode-internals.md](learning/opencode-internals.md)。

---

## 2. 包总览（改动政策一表清）

> 定位任何代码归属的**唯一入口表**。不确定能不能改，先查这里。

### 2.1 Octo 自研 — 自由改

| 路径 | 角色 |
|---|---|
| `packages/app/src/pages/_shell/` | OctoShell 框架层（sidebar + topbar） |
| `packages/app/src/pages/insight/` | 用研 Agent 页面 |
| `packages/app/src/pages/chat/` | Chat 页面 |
| `packages/app/src/pages/studio/` | Studio 页面 |
| `packages/agent/insight/agents/` | opencode agent 配置文件（`.md`） |
| `docs/`、`ROADMAP.md`、`CLAUDE.md` | 文档 |

> 其他 agent 各自在 `packages/app/src/pages/<name>/` 建立相同结构。  
> **合入内网的操作清单见 [docs/intranet-handoff.md §1](intranet-handoff.md)**（避免双写漂移，此处不重复）。

### 2.2 上游核心 — 不动

改了跟上游 diff 会乱，合入内网会冲突。

| 包 / 路径 | 用途 |
|---|---|
| `packages/opencode/` | AI Agent 后端引擎 (Hono HTTP + SSE + SQLite) |
| `packages/sdk/` | OpenAPI 自动生成的 TS 客户端 |
| `packages/ui/`（`@opencode-ai/ui`） | SolidJS 组件库 |
| `packages/app/`（`pages/_shell/`、`insight/`、`chat/`、`studio/` 和 app.tsx 路由分叉除外） | SolidJS 完整 app；`@opencode-ai/app/vite` 提供 Tailwind + 主题 + SolidJS |
| `packages/desktop-electron/src/renderer/` | 上游 renderer，不修改 |
| `packages/desktop-electron/src/preload/` | IPC 桥 |

### 2.3 上游接线壳 — 限改（品牌/接线/调试）

仅允许"应用叫什么"、"如何启动"层面的修改，绝不改业务逻辑。**改动必须同步登记到 §5.4**。

| 文件 | 改动政策 |
|---|---|
| `packages/desktop-electron/src/main/` | 主进程入口、品牌名、env 注入 |
| `packages/desktop-electron/electron-builder.config.ts` | 打包品牌 |
| `packages/desktop-electron/package.json` | 必要依赖调整 |
| `packages/app/src/app.tsx` | **限改**：仅加路由注册行，不动其他 |
| 仓库根 `package.json` | dev 脚本 |

### 2.4 仓库内但完全不用 — 既不动也不删

历史遗留或非桌面端形态，保留是为了便于跟上游同步。**不要 import，不要修改，不要"清理"**。

| 路径 | 用途（仅为认知） |
|---|---|
| `packages/desktop/` | Tauri 壳（被 ADR-001 否决） |
| `packages/web/` | opencode 官网/web 入口 |
| `packages/console/*` | opencode 商业控制台 |
| `packages/enterprise/` | 企业版 |
| `packages/extensions/` | 扩展机制 |
| `packages/containers/` | 容器化运行时 |
| `packages/shared/` | 上游内部共享代码 |
| `packages/storybook/` | UI 组件 storybook |
| `sdks/vscode/` | VS Code 扩展 |

---

## 3. 渲染层定制策略

UI 改动按下表从上往下依次尝试，绝不无理由下沉。

| 层级 | 手段 | 例子 |
|---|---|---|
| **Layer 1** | 自研组件直接用 Tailwind 具名色 | `_shell/`、`insight/` 等 Octo 自研组件 **不继承上游 CSS 变量**，直接写死色值（见下方说明） |
| **Layer 2** | 在 `insight/` 内自写组件，import `@opencode-ai/ui` 零件 | InsightPage 自写 PromptInput，复用 SessionTurn |
| **Layer 3** | 单文件 fork 到 `insight/forks/` 自维护 | 某个上游组件行为差异大时 fork 一份 |
| **Layer 4** | 直接修改上游（需 ADR 决议） | 正常工作流不应走到这里 |

### 3.1 Octo Shell 样式独立原则

上游 `@opencode-ai/ui` 的 CSS 变量（`--background-base`、`--text-base` 等）在浅色模式下对比度不足（如 `--text-base: #6f6f6f`、`--background-base: #f8f8f8` 与 `--background-stronger: #fcfcfc` 几乎无差）。

**决策：`_shell/` 和各 Octo 页面的自研组件，一律使用 Tailwind 具名色（如 `bg-gray-50`、`text-gray-900`、`text-blue-600`），不使用上游 CSS token。** 原因：

1. 上游 token 的实际解析值随主题切换变化，Octo 设计稿只有浅色一版，硬编码更可预期
2. Octo 页面不复用上游组件样式，样式隔离不会产生冲突
3. 设计师切图交付后只需替换 SVG/图片资产，不需要重新梳理 token 映射

---

## 4. 自研代码地图

```
packages/app/src/pages/
├── _shell/            # OctoShell 框架层
│   ├── index.tsx      # OctoShell + OctoPageShell 导出
│   ├── sidebar.tsx    # 左侧导航栏（Insight/Chat/Studio 入口）
│   └── topbar.tsx     # 顶部栏（Logo + Tab 切换）
├── insight/           # 用研 Agent 页面
│   └── index.tsx      # InsightPage（DataStore + PromptInput + SessionTurn）
├── chat/              # Chat 页面（占位）
│   └── index.tsx
└── studio/            # Studio 页面（占位）
    └── index.tsx

packages/agent/research/
└── agents/research.md  # 用研 agent 配置，部署至 ~/.config/octo/agent/
```

---

## 5. 数据流与外部接口

### 5.1 会话与消息

1. 用户在 PromptInput 输入 → `client.session.message.send`
2. opencode 向 LLM provider 发请求，持续推 SSE 事件
3. UI 通过 `client.event.subscribe` 接收 SSE，事件类型：
   - `message.part.updated` — 新增 part
   - `message.part.delta` — 文本/推理流式增量
   - `session.idle` — 该轮结束，**触发 REST 重新拉取作为权威状态**
   - `session.error` — 调用出错
4. UI 仅在 `session.idle` 后用 REST 数据覆盖，SSE 只负责流式打字效果

> "REST 为权威 + SSE 为体验"是为规避 SSE 事件乱序导致的复读 bug。详见 [learning/opencode-internals.md](learning/opencode-internals.md)。

### 5.2 配置文件

opencode 后端启动时优先级：

1. `process.env.OPENCODE_CONFIG`（单文件路径）— Octo 主进程**强制注入**为 `~/.config/octo/octo.json`
2. fallback 到默认 `~/.config/opencode/config.json`

由于第 1 项被主进程注入，**Octo Agent 永远只读 `~/.config/octo/octo.json`**，与用户机器上可能装的 opencode CLI 完全隔离。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "<provider-id>": {
      "npm": "@ai-sdk/<package>",
      "options": { "baseURL": "...", "apiKey": "..." },
      "models": { "<model-id>": { "name": "..." } }
    }
  },
  "model": "<provider-id>/<model-id>"
}
```

### 5.3 持久化

opencode 内置 SQLite（Drizzle ORM），数据在：

- macOS：`~/.local/share/opencode/opencode-local.db`

配置已隔离，数据库仍写到 opencode 默认目录（改路径需侵入上游，代价大）。

### 5.4 上游接线壳改动清单

> **新增改动必须同步更新本表**，否则架构文档会再次跟代码漂移。

#### `packages/desktop-electron/src/main/index.ts`

| 改了什么 | 性质 |
|---|---|
| 应用名 OpenCode → Octo Agent；App ID | 品牌 |
| 在 `initialize()` 最前调用 `initOctoConfig()`，将返回的 runtime 路径写入 `OPENCODE_CONFIG`（替换旧的直接赋值） | 配置隔离 + cascading 合并 |
| 注入 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true` | 防读取用户 `~/.claude/CLAUDE.md` 污染 agent |

#### `packages/desktop-electron/src/main/config-core.ts`（新增）

| 改了什么 | 性质 |
|---|---|
| 纯逻辑层：`buildRuntimeConfig` + `deepMerge` + `STUB_USER_CONFIG`，**无 Electron 依赖** | cascading 配置核心（ADR-008）；可直接 `bun test` |

#### `packages/desktop-electron/src/main/config.ts`（新增）

| 改了什么 | 性质 |
|---|---|
| Electron 入口层：`initOctoConfig()` 解析路径、调用 `buildRuntimeConfig`、弹窗错误处理 | cascading 配置（ADR-008） |
| `getDefaultConfigPath()` 用 `__dirname` 相对路径，dev/prod 统一——dev 指向源文件，prod 指向 asar 内（Electron 的 asar 补丁自动拦截） | 路径策略；不用 `process.resourcesPath`，避免 asar vs 物理路径混淆 |
| `getAgentPromptPath()` prod 时用 `process.resourcesPath/agents/<name>.md`（extraResources 物理文件） | agent prompt 路径（与 `default-config.json` 不同，因为源路径结构差异需要 `isPackaged` 分支） |

#### `packages/desktop-electron/src/main/config.test.ts`（新增）

| 改了什么 | 性质 |
|---|---|
| 7 个 bun:test 用例：读**真实** `insight.md` + `default-config.json` 源文件，验证 V-01/V-02/V-04 | 自动化验证；`bun run test` 触发，无需打包 |

#### `packages/desktop-electron/src/main/windows.ts`

| 改了什么 | 性质 |
|---|---|
| dev 模式自动开 DevTools；`OCTO_DEVTOOLS=1` 打开打包版 DevTools | 调试 |
| 注入 `__OPENCODE__.windowChrome`（mac 红绿灯位置 + sidebar inset） | 接线 |

#### `packages/desktop-electron/electron-builder.config.ts`

| 改了什么 | 性质 |
|---|---|
| 包名 / 图标 / 产品标识 | 品牌 |
| 新增 `extraResources`：将 `packages/agent/insight/agents/insight.md` 打包到 `resources/agents/insight.md` | cascading 配置（ADR-008）；dev 模式直读源文件，production 打包后从此路径读 |

#### `packages/app/src/app.tsx`

| 改了什么 | 性质 |
|---|---|
| 新增 `OctoShell`、`OctoPageShell` import（来自 `@/pages/_shell`） | OctoShell 路由分叉 |
| 新增 `InsightPage`、`ChatPage`、`StudioPage` lazy import | 页面注册 |
| `RouterRoot` 加 `isInsight()` / `isOctoPage()` 分支，insight 走 `OctoShell`，chat/studio 走 `OctoPageShell`，其余走原版 `AppShellProviders` | 路由分叉核心逻辑 |
| 新增 `/`、`/insight/:id?`、`/chat`、`/studio` 路由声明 | 路由注册 |

#### `packages/desktop-electron/package.json`

| 改了什么 | 性质 |
|---|---|
| 移除 `@octo/app` workspace devDependency（随 octo-app 删除） | 清理 |
| 新增 `test`（`bun test src/main/config.test.ts`）和 `check-bundle`（`bun ./scripts/check-bundle.ts`）脚本 | 配置合并验证（cascading 配置 ADR-008） |

#### `packages/desktop-electron/icons/prod/`

| 改了什么 | 性质 |
|---|---|
| `icon.icns`、`icon.png`、`dock.png`、`128x128.png`、`128x128@2x.png`、`32x32.png`、`64x64.png` 全部替换为设计师提供的 `OctoLogo-大-1.png`（800×800）导出尺寸 | 品牌 — 应用图标替换 |

#### `packages/desktop-electron/icons/dev/` 和 `icons/beta/`

| 改了什么 | 性质 |
|---|---|
| `icon.icns`、`icon.png`、`dock.png`、`128x128.png`、`128x128@2x.png`、`32x32.png`、`64x64.png` 替换为 Octo 新图标 | 品牌 — `predev.ts` 在 `bun dev` 前自动把 `icons/${channel}/` 覆盖 `resources/icons/`，所以**必须改各 channel 目录**；直接改 `resources/icons/` 会被覆盖 |

#### `packages/desktop-electron/resources/icons/`

| 改了什么 | 性质 |
|---|---|
| `icon.icns`、`icon.png`、`dock.png`、`128x128.png`、`128x128@2x.png` 替换（临时，每次 dev 启动会被 `copy-icons.ts` 覆盖） | 仅供当前运行实例使用，**持久改动应改 `icons/${channel}/`** |

#### `packages/desktop-electron/package.json`（补充）

| 改了什么 | 性质 |
|---|---|
| 新增 `productName: "OctoAI"` | 品牌 — Electron 在 dev 模式下读 `productName` 作为 macOS 菜单栏 app 名，不设则显示 "Electron" |

#### `packages/desktop-electron/src/main/index.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| `APP_NAMES.dev` 改为 `"OctoAI"`，`APP_NAMES.prod` 改为 `"OctoAI"`，`APP_NAMES.beta` 改为 `"OctoAI Beta"`；`app.setName()` dev 分支改为 `"OctoAI"` | 品牌 — 应用名统一为 OctoAI |
| `app.whenReady()` 入口处提前调用 `createMenu()`（空 deps）| 品牌 — 消除 server 启动期间菜单栏显示默认 "Electron" 的闪烁 |

#### `packages/desktop-electron/src/main/menu.ts`

| 改了什么 | 性质 |
|---|---|
| Application Menu 第一项 label 从硬编码 `"OpenCode"` 改为 `app.getName()` | 品牌 — **这才是 macOS 菜单栏显示名的真正来源**；electron-vite dev 模式不读 `.app` bundle 的 plist，菜单栏名来自 `Menu.setApplicationMenu()` 第一项的 label |

#### `packages/desktop-electron/scripts/predev.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| 新增 `plutil` patch + `codesign --force --deep --sign -` + `lsregister -f` 步骤（保留，对 Dock label 有效） | 对 macOS 菜单栏名称**无效**：electron-vite dev 模式不加载 `.app` bundle，plist 完全不被读取 |
| 用 `if (process.platform === "darwin") { ... }` 包裹 `plutil` / `codesign` / `lsregister` / `touch` / `killall Dock` 五行 macOS 专属调用（2026-05-28，dev 环境兼容） | 跨平台 — Windows/Linux 上 `plutil` 不存在导致 `bun run dev` 在 predev 阶段 exit 1；包裹后非 macOS 直接跳过 plist 补丁，`copy-icons` 和 `cd ../opencode && bun script/build-node.ts` 保留 |

#### `packages/app/public/assets/insight/`

| 改了什么 | 性质 |
|---|---|
| 新增 `IllustrationInsightEmpty.svg`、`IllustrationResultEmpty.svg` | Insight 页面插图静态资源；以 `<img src="/assets/insight/...">` 引用，避免 SVG `innerHTML` 内联无法渲染 base64 PNG |

#### `packages/app/package.json`（补充）

| 改了什么 | 性质 |
|---|---|
| 新增 `write-excel-file`（~30KB）依赖 | OutputCard Excel 导出（[spec](specs/ui/output-renderers.md) §3.3）；选 ESM/小体积库代替 SheetJS/exceljs |
| 新增 `markmap-lib` + `markmap-view`（~300KB）依赖 | OutputCard 思维导图渲染器（[spec](specs/ui/output-renderers.md) §4.2）；视觉效果优于 jsmind/G6，bundle 桌面端可接受 |

#### `packages/app/.env.example`（新增）

| 改了什么 | 性质 |
|---|---|
| 新增环境变量模板，含 `VITE_OCTO_UPLOAD_ENDPOINT` 注释 | 文件上传服务端点配置入口（[spec](specs/infra/file-upload.md) §端点）。模板 commit 进 repo，内网集成时 `cp .env.example .env.local` 填实际地址；客户端 [`lib/upload.ts`](../packages/app/src/pages/insight/lib/upload.ts) 通过 `import.meta.env.VITE_OCTO_UPLOAD_ENDPOINT` 读取 |

#### `packages/app/src/env.d.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| `ImportMetaEnv` 接口加 `readonly VITE_OCTO_UPLOAD_ENDPOINT?: string` | 给上一条 `.env.example` 里新增的环境变量做 TypeScript 类型声明；与上游 `VITE_OPENCODE_SERVER_*` 并列追加，一行 diff，不破坏上游同步 |

#### `.gitignore`（补充）

| 改了什么 | 性质 |
|---|---|
| 在 `.env` 一行下追加 `.env.local` / `.env.*.local` 两行 | 配合 `.env.example` 模板使用；vite 官方标准忽略模式，让开发者复制出的本地配置（含真实端点）不会被误提交 |

#### `packages/desktop-electron/electron.vite.config.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| `main.build.rollupOptions` 新增 `external: [/\.wasm$/]`（2026-05-28，dev/build 兼容） | 接线 — 主进程通过 `virtual:opencode-server` 引入 `packages/opencode/dist/node/node.js`，该 bundle 内含 `import("…tree-sitter.wasm")` 动态 wasm 导入；Vite 7 默认不处理 ESM-wasm，报 "ESM integration proposal for Wasm is not supported"。外置后 wasm 由运行时从 node_modules 解析（opencode build-node.ts 本身就把 `*.wasm` 列为 external），与 `opencode:copy-server-assets` 插件互补 |
| `opencode:copy-server-assets` 插件在拷 `.wasm` 之后追加拷贝 `packages/opencode/node_modules/jsonc-parser/lib/umd/impl/*` 到 `out/main/chunks/impl/`，并在该目录写一份 `package.json: {"type":"commonjs"}` 局部 scope override（2026-05-28，dev sidecar 启动修复 + JSONC parse 修复） | 接线 — 两层 bug：(1) Bun bundler 把 jsonc-parser 的 UMD `main.js` 内联进 opencode bundle，但没递归打包其 `./impl/{format,edit,parser,scanner}.js` 这四个相对 require，运行时报 `Cannot find module './impl/format'`，sidecar 启动 unhandled rejection；(2) 拷过去后 `desktop-electron/package.json` 有 `"type":"module"`，Node 把 `chunks/impl/*.js` 这堆 CJS 风格 UMD 文件当 ESM 拒绝 `require()` 加载（ERR_REQUIRE_ESM 被 bundle 内 commonJS shim 吞掉），`require_main()` 返回的子模块全是空对象，表现为 `TypeError: import_jsonc_parser.parse is not a function`，`/provider` `/global/config` 等端点全 500。修法：(a) 拷文件，(b) 同目录写 `{"type":"commonjs"}` 把 impl/ 这一层覆盖成 CJS scope（不影响 chunks 根的 ESM bundle 文件）。不是 Windows 专属 |
| `opencode:copy-server-assets` 插件追加拷贝 `packages/opencode/migration/` 整树到 `out/migration/`（2026-05-28，dev `/provider` `/global/config` 等端点 500 修复） | 接线 — opencode bundle 里 SQLite migrations 用 `path.join(import.meta.dirname, "../../migration")` 定位迁移文件。在 opencode 原位置 `packages/opencode/dist/node/` 这条路径解析为 `packages/opencode/migration/`（正确），但 electron-vite 把 bundle 重定位到 `out/main/chunks/` 后变成 `out/migration/`（不存在）。`readdirSync` 抛 `ENOENT: scandir 'out/migration'`，opencode `/provider` `/global/config` `/path` `/project` 端点的 effect chain 在初始化 migration 表时全 500，UI 上 chat 区降级隐藏。同样的相对路径资源 bug 模式（参见上一行 jsonc-parser），不是 Windows 专属 |

#### `packages/desktop-electron/resources/default-config.json`（补充）

| 改了什么 | 性质 |
|---|---|
| 删掉 `agent.interview-worker` 段（2026-05-28，dev sidecar 500 修复） | 接线 — 该 agent 在 [ADR-005](adr/005-prompt-template-vs-subagent.md) 是 fallback 设想，但 `packages/agent/interview-worker/` 目录从未实际创建，prompt 文件缺失。[config-core.ts:74-81](../packages/desktop-electron/src/main/config-core.ts) 合并时 prompt 缺失只 `console.warn` 不剔除 agent，导致 runtime 配置里出现无 prompt 的瘸腿 subagent，opencode 后端 Zod strict schema 拒收 → `/provider` `/global/config` `/path` `/project` 端点全 500，UI 上 chat 区降级隐藏。以后真要实现 interview-worker subagent 时，先在 `packages/agent/interview-worker/agents/interview-worker.md` 创建 prompt，再同步加回 default-config.json |

#### `packages/desktop-electron/src/preload/index.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| 新增 `downloadResource(url, destPath)` → IPC `download-resource` | 接线 — 给 InsightPage FileFallback 把远程 resource_link 落地本地文件（[ADR-009](adr/009-no-office-preview.md) 双按钮：「用本地应用打开」需要先 download 再 `openPath`）|

#### `packages/desktop-electron/src/preload/types.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| `ElectronAPI` 接口加 `downloadResource(url: string, destPath: string): Promise<void>` | 接线 — 给 `window.api.downloadResource` 提供 TS 类型 |

#### `packages/desktop-electron/src/main/ipc.ts`（补充）

| 改了什么 | 性质 |
|---|---|
| 新增 `ipcMain.handle("download-resource", ...)`：node fetch 下载远程 URL，落地到指定本地路径（mkdir -p + fs.writeFile） | 接线 — 配合 FileFallback「用本地应用打开」前置步骤；通用底层能力（不仅限 office），未来视频 / 图片 / 任意二进制都可复用 |

#### `packages/desktop-electron/package.json`

| 改了什么 | 性质 |
|---|---|
| `electron` 依赖 `40.4.1` → `42` | 依赖升级（避免 native 模块预编译差异）。**已知 quirk**：bun 跨主版本升级 electron 时**不自动重跑** postinstall，导致 `node_modules/.bun/electron@<new>/node_modules/electron/dist/` 不存在，启动报 `Info.plist not found`。修复：手动跑 `node node_modules/.bun/electron@<version>/node_modules/electron/install.js`。typecheck 通过，未跑 dev/build/package。 |

#### `bun.lock`

随 `octo-app` workspace 条目删除自动更新；后续随 `packages/app/package.json` 新增 `write-excel-file` / `markmap-*` 自动更新；随 `packages/desktop-electron/package.json` electron 主版本升级自动更新。非手动修改。

**撤回到纯上游**（合入内网最坏情况）：

1. 上面所有改动逆向回滚
2. → 仓库可跑通上游原版

---

## 6. 上游同步策略

所有上游目录不动（§2.2）。需要从上游同步新版时直接 git merge / pull，无冲突。

接线壳（§2.3）有少量改动，新版上游出现时对照 §5.4 清单手动评估是否影响接线。

---

## 7. 相关 ADR 与 learning

- [ADR-001 — 桌面壳：Electron vs Tauri](adr/001-electron-vs-tauri.md)
- [ADR-002 — Vue 3 替换 SolidJS](adr/002-vue3-ui-rewrite.md) **（已弃用）**
- [ADR-003 — LLM Provider 接入方案](adr/003-openai-compat-provider.md)
- [ADR-004 — 切回 SolidJS，复用上游 UI](adr/004-solidjs-ui-reuse.md) **（当前生效）**
- [learning/opencode-internals.md](learning/opencode-internals.md)
- [learning/agent-mental-model.md](learning/agent-mental-model.md)
- [learning/skill-and-mcp.md](learning/skill-and-mcp.md)
- [learning/provider-protocols.md](learning/provider-protocols.md)
- [learning/context-and-memory.md](learning/context-and-memory.md)
