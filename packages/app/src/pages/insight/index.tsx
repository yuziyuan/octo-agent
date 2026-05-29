import "./octo-tokens.css"
import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { TextPartInput } from "@opencode-ai/sdk/v2/client"
import { DataProvider } from "@opencode-ai/ui/context/data"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Icon } from "@opencode-ai/ui/icon"
import { ModelsProvider } from "@/context/models"
import { LocalProvider } from "@/context/local"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import {
  InsightModelSelectionProvider,
  useInsightModelSelection,
} from "./store/model-selection"
import { AttachmentBar, type Attachment } from "./components/attachment-bar"
import { InsightTurn, type OutputCard } from "./components/insight-turn"
import { PresetPrompts } from "./components/preset-prompts"
import { ResultViewer } from "./components/result-viewer/index"
import { createTabStore } from "./components/result-viewer/tab-store"
import { PRESET_PROMPTS, type PresetPrompt } from "./store/preset-prompts"
import { IllustrationInsightEmpty, IconSendBlue } from "./icons/illustrations"
import { uploadFile, validateFile, formatUploadsForPrompt, UploadError } from "./lib/upload"
import { aggregateTaskCards, readTaskInfo, toolDisplayName, type TaskCardEntry } from "./utils/task-detect"
import { mimeToOutputType } from "./utils/resource-link"
import { clearRefreshState, markRefreshed, isInCooldown } from "./utils/task-refresh"
import { showToast, Toast } from "@opencode-ai/ui/toast"

/**
 * InsightPage —— 用研 agent 页面
 *
 * 数据层完全复用 opencode 原生 globalSync / sync.session.sync / event-reducer，
 * 不再自建本地 dataStore + SSE listener。详见 SPEC-INS-005
 * (docs/specs/ui/insight-data-layer-reuse.md)。
 *
 * 外层 InsightPage：负责拼装 SDKProvider + SyncProvider（依赖 homeDir 就绪）。
 * 内层 InsightContent：所有业务逻辑，可读写 useSync() / useSDK()。
 */
export default function InsightPage() {
  const globalSync = useGlobalSync()
  const homeDir = () => globalSync.data.path.home

  // homeDir 异步就绪。等就绪再挂 SDK/Sync providers，否则 useSDK 拿到空字符串 directory 会异常。
  // keyed: dir 变化时整体重挂，确保 SyncProvider 内部状态干净。
  return (
    <Show when={homeDir()} keyed>
      {(dir) => (
        <SDKProvider directory={() => dir}>
          <SyncProvider>
            <ModelsProvider>
              {/* LocalProvider:为 ModelSelectorPopover 内懒加载的 dialog-manage-models /
                  dialog-select-provider 提供 useLocal()(用于全局模型可见性管理 UI)。
                  我们在主流程里读的是 useInsightModelSelection,跟 useLocal 隔离。 */}
              <LocalProvider>
                <InsightModelSelectionProvider>
                  <InsightContent />
                </InsightModelSelectionProvider>
              </LocalProvider>
            </ModelsProvider>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}

function InsightContent() {
  const params = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const selection = useInsightModelSelection()

  const homeDir = () => globalSync.data.path.home

  // 切 session 时触发原生 sync 加载（带 inflight 去重 + cache + optimistic 合并）
  // event-reducer 已在 GlobalSyncProvider 内部全局唯一注册，无需我们再监听 SSE
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) return
        console.log("[octo:sync] session.sync", { sessionID: id })
        void sync.session.sync(id)
      },
    ),
  )

  const userMessages = createMemo((): Message[] => {
    const id = params.id
    if (!id) return []
    return ((sync.data.message[id] ?? []) as Message[]).filter((m) => m.role === "user")
  })

  // ── 长任务卡片聚合(spec: docs/specs/ui/task-card.md §3.3)──
  // 扫所有 assistant message 的 part,按 task_id 分组取最新状态;锚点 = 最早 part 所在 user message
  const taskCards = createMemo((): Map<string, TaskCardEntry> => {
    const id = params.id
    if (!id) return new Map()
    const messages = (sync.data.message[id] ?? []) as Message[]
    const items: Parameters<typeof aggregateTaskCards>[0] = []
    let lastUserMsgID = ""
    for (const msg of messages) {
      if (msg.role === "user") {
        lastUserMsgID = msg.id
        continue
      }
      if (msg.role !== "assistant" || !lastUserMsgID) continue
      const parts = sync.data.part[msg.id] ?? []
      const msgTime = (msg as { time?: { created?: number } }).time?.created ?? Date.now()
      for (const part of parts) {
        const info = readTaskInfo(part)
        if (!info) continue
        items.push({
          taskId: info.taskId,
          status: info.status,
          message: info.message,
          toolName: info.toolName,
          resultText: info.resultText,
          resourceLinks: info.resourceLinks,
          userMsgID: lastUserMsgID,
          time: msgTime,
        })
      }
    }
    return aggregateTaskCards(items)
  })

  // 按 anchor userMessageID 分组,InsightTurn 接收"挂在自己 turn 下"的卡片
  const taskCardsByAnchor = createMemo((): Map<string, TaskCardEntry[]> => {
    const out = new Map<string, TaskCardEntry[]>()
    for (const card of taskCards().values()) {
      const arr = out.get(card.anchorUserMessageID) ?? []
      arr.push(card)
      out.set(card.anchorUserMessageID, arr)
    }
    return out
  })

  const sessionStatus = createMemo((): SessionStatus => {
    const id = params.id
    if (!id) return { type: "idle" }
    return sync.data.session_status[id] ?? { type: "idle" }
  })

  // 状态变化日志：busy ↔ idle 切换观测点
  createEffect(
    on(
      sessionStatus,
      (status) => {
        console.log("[octo:sync] status", { sessionID: params.id, type: status.type })
      },
      { defer: true },
    ),
  )

  const isBusy = createMemo(() => sessionStatus().type === "busy")

  // busy → idle 时:把刚结束的最新 assistant 消息原始内容完整 dump 到 console。
  // 内网无法抓 SSE network 时,把这条 console 粘到外网即可定位"LLM 究竟返回了什么"。
  createEffect(on(isBusy, (busy, prev) => {
    if (busy || !prev) return  // 只在 idle 切换那一刻打,不在初始 idle 打
    const sid = params.id
    if (!sid) return
    const messages = (sync.data.message[sid] ?? []) as Message[]
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant) return
    const parts = (sync.data.part[lastAssistant.id] ?? []) as Part[]

    const textParts = parts.filter((p) => p.type === "text") as Array<Part & { text?: string }>
    const toolParts = parts.filter((p) => p.type === "tool") as Array<
      Part & { tool?: string; state?: { status?: string; output?: string; metadata?: unknown } }
    >

    console.log("[octo:assistant] turn-complete", {
      sessionID: sid,
      msgID: lastAssistant.id,
      partsCount: parts.length,
      textPartsCount: textParts.length,
      toolPartsCount: toolParts.length,
      toolNames: toolParts.map((p) => p.tool),
    })

    // 每个 text part 单独打,完整内容(不截断)
    for (let i = 0; i < textParts.length; i++) {
      const p = textParts[i]
      console.log("[octo:assistant] text-part-detail", {
        msgID: lastAssistant.id,
        partIdx: i,
        partID: p.id,
        textLen: typeof p.text === "string" ? p.text.length : 0,
        text: p.text,
      })
    }

    // 每个 tool part 单独打,含完整 state(output JSON + metadata + status)
    for (let i = 0; i < toolParts.length; i++) {
      const p = toolParts[i]
      const state = p.state ?? {}
      let parsedOutput: unknown
      try {
        parsedOutput = typeof state.output === "string" ? JSON.parse(state.output) : state.output
      } catch {
        parsedOutput = state.output  // 非 JSON,保持原样
      }
      console.log("[octo:assistant] tool-part-detail", {
        msgID: lastAssistant.id,
        partIdx: i,
        partID: p.id,
        toolName: p.tool,
        status: state.status,
        metadata: state.metadata,
        outputRaw: state.output,
        outputParsed: parsedOutput,
      })
    }
  }, { defer: true }))

  const [prompt, setPrompt] = createSignal("")
  // queue:busy 期间用户继续发送,先入队,idle 后自动 flush(SPEC-INS-007 §3.3.3)
  // 单容量:第二次入队会覆盖上一次;切 session 时清空
  const [queuedText, setQueuedText] = createSignal<string | null>(null)
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [isDragOver, setIsDragOver] = createSignal(false)
  let textareaRef!: HTMLTextAreaElement

  // 聊天区宽度：从 localStorage 恢复，无存储值时取约 50% 可用宽（扣除侧边栏约 240px）
  const CHAT_WIDTH_KEY = "octo:insight:chat-width"
  function getInitialChatWidth(): number {
    const stored = localStorage.getItem(CHAT_WIDTH_KEY)
    if (stored) {
      const n = parseInt(stored, 10)
      if (!isNaN(n) && n >= 240) return n
    }
    return Math.max(360, Math.floor((window.innerWidth - 240) / 2))
  }
  const [chatWidth, setChatWidth] = createSignal(getInitialChatWidth())

  function handleDividerPointerDown(e: PointerEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = chatWidth()
    const target = e.currentTarget as HTMLElement
    // pointer capture:确保 pointermove / pointerup 即使光标移出 webview 也照常派发到本元素,
    // 避免 mouseup 丢失导致 body 样式(userSelect/cursor/overflow) stuck → 输入框看似不可 focus
    target.setPointerCapture(e.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"
    const restore = () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth()))
    }
    const onMove = (ev: PointerEvent) => {
      setChatWidth(Math.max(240, Math.min(Math.floor(window.innerWidth * 0.65), startWidth + ev.clientX - startX)))
    }
    const cleanup = () => {
      restore()
      target.removeEventListener("pointermove", onMove)
      target.removeEventListener("pointerup", cleanup)
      target.removeEventListener("pointercancel", cleanup)
      try { target.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    }
    target.addEventListener("pointermove", onMove)
    target.addEventListener("pointerup", cleanup)
    target.addEventListener("pointercancel", cleanup)
  }

  const tabStore = createTabStore()

  // 自动滚动：session busy 时保持对话区随新内容跟随到底部
  const autoScroll = createAutoScroll({ working: isBusy })

  // 切换 session 时重置 ResultViewer tabs / 任务卡片防抖 / 自动 openTab 记录 / queue
  // queue 必须清:在 session A 排队的 text 不能错发到 session B(SPEC-INS-007 §3.3.5)
  createEffect(on(() => params.id, () => {
    tabStore.reset()
    setQueuedText(null)
    clearRefreshState()
    autoOpenedTaskIds.clear()
    lastTaskSnapshot = new Map()
    console.log("[octo:task] session switched, refresh state cleared", { sessionID: params.id })
  }, { defer: true }))

  // ── session 操作 ──────────────────────────────────────────

  async function createAndNavigate(): Promise<string | undefined> {
    const dir = homeDir()
    if (!dir) return
    try {
      const result = await globalSDK.client.session.create({ directory: dir })
      const session = result.data as Session | undefined
      if (session) {
        navigate(`/insight/${session.id}`)
        return session.id
      }
    } catch (err) {
      console.error("[InsightPage] session.create failed", err)
      showToast({
        title: "新建会话失败",
        description: errorDescription(err),
      })
    }
    return undefined
  }

  /**
   * 错误信息提取(参考 packages/app/src/components/prompt-input/submit.ts errorMessage)
   * SDK 错误通常带 data.message,其次取 err.message,最后回落到通用提示
   */
  function errorDescription(err: unknown): string {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return "请稍后重试"
  }

  /**
   * 共享的 prompt 调用底层(SPEC-INS-007 §3.2 改用 promptAsync + optimistic)
   *   - consumeAttachments=true(用户手动发送):附件随消息发送,发送后清空附件状态
   *   - consumeAttachments=false(刷新/终止/follow-up 按钮 inject):不消费附件,保留用户正在选的附件状态
   * spec: docs/specs/ui/task-card.md §6.1 + docs/specs/ui/insight-prompt-redesign.md §3.2
   */
  async function doSendPrompt(sessionId: string, text: string, opts: { consumeAttachments: boolean; source: string }) {
    const doneAttachments = opts.consumeAttachments
      ? attachments().filter((a) => a.status === "done" && a.url)
      : []
    const fullText = text + formatUploadsForPrompt(
      doneAttachments.map((a) => ({ filename: a.filename, url: a.url! })),
    )
    const textPart: TextPartInput = { type: "text", text: fullText }
    const messageID = Identifier.ascending("message")
    const agent = "insight"

    // 当前 insight 选中的模型(来自 useInsightModelSelection,workspace 级持久化)
    const currentModel = selection.model.current()
    const model = currentModel ? {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    } : undefined

    // optimistic user message —— 立即写入 sync.data,UI 瞬时反馈
    // directory 不传 → 默认走 SDKProvider 注入的 homeDir;model 不传 → 服务端按 agent 默认配置
    const optimisticMessage: Message = {
      id: messageID,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      model,
    } as Message
    const optimisticPart: Part = {
      id: Identifier.ascending("part"),
      sessionID: sessionId,
      messageID,
      type: "text",
      text: fullText,
    } as Part

    console.log("[octo:prompt] send", {
      source: opts.source,
      sessionID: sessionId,
      messageID,
      agent,
      text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      textLen: text.length,
      attachmentsCount: doneAttachments.length,
      uploads: doneAttachments.map((a) => ({ name: a.filename, url: a.url })),
    })
    // 完整 text 单独 dump(不截断),便于内网把怪 case 粘到外网定位
    console.log("[octo:prompt] send-full", {
      source: opts.source,
      messageID,
      fullText,   // 含 attachments 拼接后的最终文本
    })

    sync.session.optimistic.add({
      sessionID: sessionId,
      message: optimisticMessage,
      parts: [optimisticPart],
    })
    console.log("[octo:prompt] optimistic added", { messageID, partsCount: 1 })

    if (opts.consumeAttachments) {
      filesById.clear()
      setAttachments([])
    }

    try {
      await globalSDK.client.session.promptAsync({
        sessionID: sessionId,
        agent,
        model,
        parts: [textPart],
        messageID,
      })
      console.log("[octo:prompt] sent (async)", { messageID, sessionID: sessionId })
    } catch (err) {
      console.error("[octo:prompt] failed", { source: opts.source, messageID, err })
      sync.session.optimistic.remove({ sessionID: sessionId, messageID })
      showToast({
        title: "发送失败",
        description: errorDescription(err),
      })
    }
  }

  function sendMessage(sessionId: string, text: string) {
    return doSendPrompt(sessionId, text, { consumeAttachments: true, source: "user" })
  }

  /** 任务卡片"刷新 / 终止 / follow-up"按钮通过本函数 inject prompt;不消费附件状态 */
  function sendInjectedPrompt(sessionId: string, text: string, source: string) {
    return doSendPrompt(sessionId, text, { consumeAttachments: false, source })
  }

  async function handleSubmit() {
    const text = prompt().trim()
    if (!text || hasUploadingAttachments()) return
    setPrompt("")

    // busy 时入队(SPEC-INS-007 §3.3.3):单容量,第二次会覆盖上一次
    if (isBusy()) {
      setQueuedText(text)
      console.log("[octo:queue] enqueued", { sessionID: params.id, len: text.length })
      return
    }

    let sid = params.id
    if (!sid) {
      sid = await createAndNavigate()
      if (!sid) return
    }
    await sendMessage(sid, text)
  }

  // busy → idle 自动 flush 队列(SPEC-INS-007 §3.3.3)
  createEffect(on(isBusy, (busy, prev) => {
    if (!prev || busy) return
    const text = queuedText()
    const sid = params.id
    if (!text || !sid) return
    setQueuedText(null)
    console.log("[octo:queue] flushing", { sessionID: sid, len: text.length })
    void sendMessage(sid, text)
  }, { defer: true }))

  function cancelQueued() {
    const text = queuedText()
    if (!text) return
    setQueuedText(null)
    setPrompt((cur) => cur ? cur : text)
    console.log("[octo:queue] canceled, restored to input")
  }

  function handlePresetClick(preset: PresetPrompt) {
    setPrompt(preset.text)
    console.log("[octo:preset] click", { id: preset.id, expectedTool: preset.expectedTool })
    requestAnimationFrame(() => {
      textareaRef?.focus()
      // 光标移到文末,便于用户继续编辑
      const len = preset.text.length
      try { textareaRef?.setSelectionRange(len, len) } catch { /* noop */ }
    })
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  // ── 附件管理 ─────────────────────────────────────────────

  let fileInputRef!: HTMLInputElement
  // id -> File，保留原 File 引用以支持重传（不进 Attachment 类型避免污染 chip 渲染）
  const filesById = new Map<string, File>()

  function addAttachments(files: File[]) {
    const slots = 5 - attachments().length
    const toAdd = files.slice(0, slots)
    for (const file of toAdd) {
      const id = crypto.randomUUID()
      const mime = file.type || "application/octet-stream"
      const validationErr = validateFile(file)
      if (validationErr) {
        setAttachments((prev) => [
          ...prev,
          { id, filename: file.name, mime, size: file.size, status: "error", error: validationErr.message },
        ])
        continue
      }
      filesById.set(id, file)
      setAttachments((prev) => [
        ...prev,
        { id, filename: file.name, mime, size: file.size, status: "uploading" },
      ])
      void doUpload(id, file)
    }
  }

  async function doUpload(id: string, file: File) {
    try {
      const result = await uploadFile(file)
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "done", url: result.url, error: undefined } : a)),
      )
    } catch (err) {
      const message =
        err instanceof UploadError ? err.message :
        err instanceof Error ? err.message :
        "上传失败"
      console.error("[InsightPage] upload failed", { id, filename: file.name, err })
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "error", error: message } : a)),
      )
    }
  }

  function removeAttachment(id: string) {
    filesById.delete(id)
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  function retryUpload(id: string) {
    const file = filesById.get(id)
    if (!file) {
      // 客户端 validate 失败的 chip 没有原 File，无法重传；用户应删除重新选
      return
    }
    setAttachments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "uploading", error: undefined } : a)),
    )
    void doUpload(id, file)
  }

  function handleFileInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    if (input.files?.length) {
      addAttachments(Array.from(input.files))
      input.value = ""
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
    setIsDragOver(true)
  }

  function handleDragLeave() {
    setIsDragOver(false)
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length > 0) addAttachments(files)
  }

  function handleOpenResult(card: OutputCard) {
    tabStore.openTab(card)
  }

  // ── 长任务卡片操作(spec: docs/specs/ui/task-card.md §6) ──────

  function handleTaskRefresh(taskId: string) {
    const sid = params.id
    if (!sid) return
    if (isBusy()) {
      console.log("[octo:task] refresh blocked: busy", { taskId })
      return
    }
    if (isInCooldown(taskId)) {
      console.log("[octo:task] refresh blocked: cooldown", { taskId })
      return
    }
    markRefreshed(taskId)
    void sendInjectedPrompt(sid, `查询任务 ${taskId} 的进度`, "task-refresh")
  }

  function handleTaskStop(taskId: string) {
    const sid = params.id
    if (!sid) return
    if (isBusy()) {
      console.log("[octo:task] stop blocked: busy", { taskId })
      return
    }
    void sendInjectedPrompt(sid, `终止任务 ${taskId}`, "task-stop")
  }

  function handleTaskFollowup(taskId: string) {
    // 填种子文本到输入框,光标定位,不自动发送(spec §6.1 "在对话里继续讨论")
    const card = taskCards().get(taskId)
    const toolHint = card ? toolDisplayName(card.toolName) : "任务"
    const seed = `基于 task ${taskId}(${toolHint})的结果,我想…`
    setPrompt(seed)
    console.log("[octo:task] followup seed", { taskId, seed })
    // 滚动到输入框 / focus — 由用户自然交互完成,不强抢焦点
  }

  /**
   * 把 completed task 转成 1~N 个 OutputCard,每个 resource_link 一张;
   * 无 resource_link 但有 resultText 时,fallback 为单张 markdown inline 卡;
   * 无任何产物时返回空数组(尚未 completed 或异常)。
   */
  function buildOutputCardsFromTask(card: TaskCardEntry): OutputCard[] {
    if (card.status !== "completed") return []
    const baseTitle = `${toolDisplayName(card.toolName)} 结果`
    if (card.resourceLinks.length > 0) {
      return card.resourceLinks.map((link, idx) => ({
        id: `task-${card.taskId}-${idx}`,
        title: link.name || `${baseTitle} ${idx + 1}`,
        type: mimeToOutputType(link.mimeType),
        source: "uri" as const,
        uri: link.uri,
        mimeType: link.mimeType,
        fileName: link.name,
        description: link.description,
        createdAt: card.lastUpdatedAt,
      }))
    }
    if (card.resultText && card.resultText.length > 0) {
      return [{
        id: `task-${card.taskId}`,
        title: baseTitle,
        type: "markdown",
        source: "inline",
        content: card.resultText,
        createdAt: card.lastUpdatedAt,
      }]
    }
    return []
  }

  function handleTaskOpenResult(taskId: string) {
    const card = taskCards().get(taskId)
    if (!card) {
      console.warn("[octo:task] openResult: card not found", { taskId })
      return
    }
    const ocs = buildOutputCardsFromTask(card)
    if (ocs.length === 0) {
      console.warn("[octo:task] openResult: no result yet", { taskId, status: card.status })
      return
    }
    console.log("[octo:task] openResult", {
      taskId,
      count: ocs.length,
      tabs: ocs.map((oc) => ({ type: oc.type, source: oc.source, file: oc.fileName })),
    })
    // 多文件:全部 openTab,激活 = 最后一个 openTab 内部已处理(activate first won't override later)
    // 用户视觉上看到最后激活的是数组里最后一个 = 第一张?— 让我们激活第一张
    for (const oc of ocs) tabStore.openTab(oc)
    tabStore.activate(ocs[0].id)
  }

  // ── 自动 openTab(ResultViewer 当前为空时,首个 completed 任务自动开;spec §8.3)──
  const autoOpenedTaskIds = new Set<string>()
  createEffect(() => {
    if (tabStore.tabs().length > 0) return
    for (const card of taskCards().values()) {
      if (card.status !== "completed") continue
      if (autoOpenedTaskIds.has(card.taskId)) continue
      const ocs = buildOutputCardsFromTask(card)
      if (ocs.length === 0) continue
      autoOpenedTaskIds.add(card.taskId)
      console.log("[octo:task] auto-openResult (viewer empty)", {
        taskId: card.taskId,
        count: ocs.length,
        tabs: ocs.map((oc) => ({ type: oc.type, file: oc.fileName })),
      })
      for (const oc of ocs) tabStore.openTab(oc)
      tabStore.activate(ocs[0].id)
      break  // 一次只自动开一个 task 的全部产物
    }
  })

  // ── 全链路 console diff:taskCards 变化时打快照 ──────────────
  let lastTaskSnapshot = new Map<string, string>()
  createEffect(() => {
    const current = taskCards()
    const currentSnap = new Map<string, string>()
    for (const [id, card] of current) {
      currentSnap.set(id, `${card.status}|${card.message ?? ""}`)
    }
    // diff:状态变化的卡片
    const changes: Array<{ taskId: string; from: string | null; to: string }> = []
    for (const [id, sig] of currentSnap) {
      const prev = lastTaskSnapshot.get(id) ?? null
      if (prev !== sig) changes.push({ taskId: id, from: prev, to: sig })
    }
    for (const id of lastTaskSnapshot.keys()) {
      if (!currentSnap.has(id)) changes.push({ taskId: id, from: lastTaskSnapshot.get(id)!, to: "gone" })
    }
    if (changes.length > 0) {
      console.log("[octo:task] aggregate diff", {
        sessionID: params.id,
        total: current.size,
        changes,
        snapshot: Array.from(current.values()).map((c) => ({
          taskId: c.taskId,
          tool: c.toolName,
          status: c.status,
          message: c.message,
          anchor: c.anchorUserMessageID,
          resourceLinkCount: c.resourceLinks.length,
          hasResultText: !!c.resultText,
        })),
      })
    }
    lastTaskSnapshot = currentSnap
  })

  const maxAttachments = () => attachments().length >= 5
  function hasUploadingAttachments() {
    return attachments().some((a) => a.status === "uploading")
  }

  return (
    <DataProvider
      data={sync.data}
      directory={homeDir() || ""}
      onNavigateToSession={(sessionID: string) => navigate(`/insight/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/insight/${sessionID}`}
    >
      <Toast.Region />
      <div class="size-full flex overflow-hidden relative" data-page="insight">

        {/* ── 左栏：对话面板（固定宽度，始终可拖拽） ──── */}
        <div
          class="flex flex-col overflow-hidden flex-shrink-0"
          style={{
            width: `${chatWidth()}px`,
            flex: "0 0 auto",
            background: isDragOver() ? "var(--octo-brand-a3)" : "var(--octo-shell-bg)",
            outline: isDragOver() ? "inset 0 0 0 2px var(--octo-brand-a25)" : "none",
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
            <Show
              when={params.id && userMessages().length > 0}
              fallback={
                <div class="size-full flex flex-col items-center justify-center px-8 py-10 overflow-y-auto">
                  <IllustrationInsightEmpty width={166} height={166} />
                  <div
                    style={{
                      "margin-top": "12px",
                      "font-size": "36px",
                      "font-weight": "600",
                      "line-height": "1.2",
                      color: "var(--octo-text-strong)",
                    }}
                  >
                    Octo Insight
                  </div>
                  <div
                    style={{
                      "margin-top": "8px",
                      "font-size": "16px",
                      color: "var(--octo-text-secondary)",
                    }}
                  >
                    AI辅助用户洞察研究
                  </div>

                  <div style={{ "margin-top": "80px", width: "100%", "max-width": "800px" }}>
                    <AttachmentBar
                      attachments={attachments()}
                      onRemove={removeAttachment}
                      onRetry={retryUpload}
                    />

                    <PresetPrompts
                      prompts={PRESET_PROMPTS}
                      onClick={handlePresetClick}
                    />

                    <div
                      class="rounded-[24px] transition-all duration-300 relative group flex flex-col"
                      style={{
                        border: "1px solid transparent",
                        background: `
                          linear-gradient(var(--octo-surface-page), var(--octo-surface-page)) padding-box,
                          linear-gradient(135deg,
                            rgba(246, 97, 23, 1) 1%,
                            rgba(95, 45, 255, 1) 8%,
                            rgba(61, 93, 255, 1) 22%,
                            rgba(104, 138, 255, 1) 43%,
                            rgba(28, 171, 111, 1) 54%,
                            rgba(61, 93, 255, 1) 87%,
                            rgba(206, 7, 232, 1) 92%) border-box`,
                        "box-shadow": "0 0 5px rgba(0, 0, 0, 0.08), 0 0 10px rgba(74, 81, 255, 0.18), 0 0 20px rgba(89, 74, 255, 0.12)",
                        height: "150px",
                        "margin-top": attachments().length > 0 ? "6px" : "0",
                      }}
                    >
                      <textarea
                        ref={textareaRef!}
                        value={prompt()}
                        onInput={(e) => setPrompt(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="请描述您的需求..."
                        class="w-full flex-1 resize-none px-4 pt-3 bg-transparent text-sm outline-none relative z-10"
                        style={{
                          color: "var(--octo-text-primary)",
                          "font-family": "var(--octo-font)",
                          "overflow-y": "auto",
                        }}
                      />

                      <div class="flex items-center gap-2 px-2.5 pb-2.5 relative z-10">
                        <input
                          ref={fileInputRef!}
                          type="file"
                          multiple
                          class="hidden"
                          accept="*/*"
                          onChange={handleFileInputChange}
                        />
                        <button
                          type="button"
                          onClick={() => { if (!maxAttachments()) fileInputRef.click() }}
                          disabled={maxAttachments()}
                          class="flex flex-shrink-0 items-center justify-center size-8 rounded-full transition-colors hover:bg-black/5 active:bg-black/10 text-gray-800 hover:text-black disabled:text-gray-400"
                          title={maxAttachments() ? "最多 5 个文件" : "添加附件"}
                        >
                          <Icon name="plus" class="size-5" />
                        </button>

                        <ModelSelectorPopover
                          model={selection.model}
                          triggerAs="button"
                          triggerProps={{
                            class: "flex items-center gap-1.5 min-w-0 max-w-[200px] bg-[#f3f3f3] hover:bg-[#e8e8e8] active:bg-[#dedede] transition-colors px-3 py-1.5 rounded-full text-[13px] text-gray-800 font-medium group",
                            "data-action": "prompt-model",
                          }}
                          onClose={() => { requestAnimationFrame(() => textareaRef?.focus()) }}
                        >
                          {/* 不渲染 ProviderIcon:跟底部输入区/UXAI chat 一致 */}
                          <span class="truncate">
                            {selection.model.current()?.name ?? "选择模型"}
                          </span>
                          <Icon name="chevron-down" class="size-3.5 shrink-0 opacity-60" />
                        </ModelSelectorPopover>

                        <button
                          type="button"
                          onClick={() => void handleSubmit()}
                          disabled={!prompt().trim() || hasUploadingAttachments()}
                          title={hasUploadingAttachments() ? "请等待附件上传完成" : (isBusy() ? "LLM 响应中,发送会进入排队" : undefined)}
                          class="flex flex-shrink-0 items-center justify-center ml-auto bg-transparent border-0 p-0 transition-opacity duration-200 disabled:cursor-not-allowed"
                          style={{
                            opacity: (!prompt().trim() || hasUploadingAttachments()) ? 0.4 : 1,
                            filter: (!prompt().trim() || hasUploadingAttachments()) ? "grayscale(0.5)" : "none",
                          }}
                        >
                          <IconSendBlue width={40} height={40} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              }
            >
              {/* 消息列表（autoScroll 挂在 scrollRef 容器，contentRef 挂在内容 div） */}
              <div
                class="flex-1 overflow-y-auto min-h-0"
                ref={autoScroll.scrollRef}
                onScroll={autoScroll.handleScroll}
                onMouseUp={autoScroll.handleInteraction}
              >
                <div ref={autoScroll.contentRef} class="py-3 flex flex-col gap-0">
                  <For each={userMessages()}>
                    {(msg) => (
                      <InsightTurn
                        sessionID={params.id!}
                        messageID={msg.id}
                        status={sessionStatus()}
                        active={isBusy()}
                        onOpenResult={handleOpenResult}
                        taskCards={taskCardsByAnchor().get(msg.id) ?? []}
                        onTaskRefresh={handleTaskRefresh}
                        onTaskStop={handleTaskStop}
                        onTaskOpenResult={handleTaskOpenResult}
                        onTaskFollowup={handleTaskFollowup}
                      />
                    )}
                  </For>
                </div>
              </div>

              {/* 输入区 */}
              <div class="shrink-0 p-4">
                <AttachmentBar
                  attachments={attachments()}
                  onRemove={removeAttachment}
                  onRetry={retryUpload}
                />

                {/* 队列提示条:busy 时点了发送会先入队,这里给反馈 (SPEC-INS-007 §3.3.4) */}
                <Show when={queuedText()}>
                  <div class="octo-queue-banner">
                    <span class="octo-queue-banner-label">排队中</span>
                    <span class="octo-queue-banner-text">{queuedText()}</span>
                    <button
                      type="button"
                      onClick={cancelQueued}
                      class="octo-queue-banner-cancel"
                      title="取消并恢复到输入框"
                      aria-label="取消排队"
                    >
                      ×
                    </button>
                  </div>
                </Show>

                {/* 预置提示词按钮 (SPEC-INS-007 §3.1.3):放在输入框白卡片之外,
                    视觉层级:辅助操作浮在输入框上方,与卡片解耦 */}
                <PresetPrompts
                  prompts={PRESET_PROMPTS}
                  onClick={handlePresetClick}
                />

                <div
                  class="rounded-[var(--octo-radius-lg)] transition-all duration-300 relative group"
                  style={{
                    border: "1px solid transparent",
                    background: `
                      linear-gradient(var(--octo-surface-page), var(--octo-surface-page)) padding-box,
                      linear-gradient(135deg,
                        rgba(246, 97, 23, 0.7) 1%,
                        rgba(95, 45, 255, 0.7) 8%,
                        rgba(61, 93, 255, 0.7) 22%,
                        rgba(104, 138, 255, 0.7) 43%,
                        rgba(28, 171, 111, 0.7) 54%,
                        rgba(61, 93, 255, 0.7) 87%,
                        rgba(206, 7, 232, 0.7) 92%) border-box`,
                    "box-shadow": "0 0 5px rgba(0, 0, 0, 0.08), 0 0 10px rgba(74, 81, 255, 0.18), 0 0 20px rgba(89, 74, 255, 0.12)",
                    "margin-top": attachments().length > 0 ? "6px" : "0",
                  }}
                >
                  <textarea
                    ref={textareaRef!}
                    value={prompt()}
                    onInput={(e) => setPrompt(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="上传评估任务书、逐字稿，智能整理问题和观点"
                    rows={3}
                    class="w-full resize-none px-3 pt-2.5 pb-2 bg-transparent text-sm outline-none relative z-10"
                    style={{
                      color: "var(--octo-text-primary)",
                      "font-family": "var(--octo-font)",
                      "max-height": "120px",
                      "overflow-y": "auto",
                    }}
                  />

                  <div class="flex items-center gap-2 px-2.5 pb-2.5 relative z-10">
                    <input
                      ref={fileInputRef!}
                      type="file"
                      multiple
                      class="hidden"
                      accept="*/*"
                      onChange={handleFileInputChange}
                    />
                    <button
                      type="button"
                      onClick={() => { if (!maxAttachments()) fileInputRef.click() }}
                      disabled={maxAttachments()}
                      class="flex flex-shrink-0 items-center justify-center size-8 rounded-full transition-colors hover:bg-black/5 active:bg-black/10 text-gray-800 hover:text-black disabled:text-gray-400"
                      title={maxAttachments() ? "最多 5 个文件" : "添加附件"}
                    >
                      <Icon name="plus" class="size-5" />
                    </button>

                    <ModelSelectorPopover
                      model={selection.model}
                      triggerAs="button"
                      triggerProps={{
                        class: "flex items-center gap-1.5 min-w-0 max-w-[200px] bg-[#f3f3f3] hover:bg-[#e8e8e8] active:bg-[#dedede] transition-colors px-3 py-1.5 rounded-full text-[13px] text-gray-800 font-medium group",
                        "data-action": "prompt-model",
                      }}
                      onClose={() => { requestAnimationFrame(() => textareaRef?.focus()) }}
                    >
                      {/* 不渲染 ProviderIcon:内网自部署的 provider id 不在 ui sprite 内会落到
                          synthetic 占位图标,跟 UXAI chat 一致(屏蔽 icon 只显示模型名)。 */}
                      <span class="truncate">
                        {selection.model.current()?.name ?? "选择模型"}
                      </span>
                      <Icon name="chevron-down" class="size-3.5 shrink-0 opacity-60" />
                    </ModelSelectorPopover>

                    <button
                      type="button"
                      onClick={() => void handleSubmit()}
                      disabled={!prompt().trim() || hasUploadingAttachments()}
                      title={hasUploadingAttachments() ? "请等待附件上传完成" : (isBusy() ? "LLM 响应中,发送会进入排队" : undefined)}
                      class="flex flex-shrink-0 items-center justify-center ml-auto bg-transparent border-0 p-0 transition-opacity duration-200 disabled:cursor-not-allowed"
                      style={{
                        opacity: (!prompt().trim() || hasUploadingAttachments()) ? 0.4 : 1,
                        filter: (!prompt().trim() || hasUploadingAttachments()) ? "grayscale(0.5)" : "none",
                      }}
                    >
                      <IconSendBlue width={40} height={40} />
                    </button>
                  </div>
                </div>
              </div>
            </Show>

        </div>

        {/* ── 聊天/结果 拖拽分隔线（半侧贴边胶囊）
             top/bottom 缩进 20px：避免与 Windows classic 滚动条两端箭头（~17px）热区重合 */}
        <div
          class="absolute flex items-center justify-center group"
          style={{ top: "20px", bottom: "20px", left: `${chatWidth() - 10}px`, width: "20px", cursor: "col-resize", "z-index": 10 }}
          onPointerDown={handleDividerPointerDown}
        >
          <div
            class="absolute right-[10px] flex items-center justify-center bg-white transition-shadow duration-200"
            style={{
              width: "12px",
              height: "36px",
              "border-radius": "10px 0 0 10px",
              "box-shadow": "-2px 0 4px rgba(0,0,0,0.04), inset 1px 0 0 rgba(0,0,0,0.02)",
              border: "1px solid var(--octo-border-divider)",
              "border-right": "none",
            }}
          >
            <div
              class="w-[2px] h-[14px] rounded-full mr-[2px]"
              style={{ background: "var(--octo-border-input, #c9c9c9)" }}
            />
          </div>
        </div>

        {/* ── 中栏：ResultViewer（始终渲染，无 tab 时显示空态） */}
        <ResultViewer
          tabs={tabStore.tabs()}
          activeId={tabStore.activeId()}
          onActivate={tabStore.activate}
          onClose={tabStore.closeTab}
          onCacheContent={tabStore.cacheContent}
        />

        {/* ── 右栏：Workspace 占位 (P2) ──────────────── */}
        <div />
      </div>
    </DataProvider>
  )
}

