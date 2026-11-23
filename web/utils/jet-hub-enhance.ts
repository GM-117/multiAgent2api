/**
 * 上游 JetHub 界面的本仓库增强（custom 分支的个人化）。
 *
 * 1. 网关弹窗里的单条模型行是只读展示，上游只提供「复制全部 / 复制本组」。
 *    这里用文档级事件委托补上「点击一行 = 复制这一条的完整模型 ID」：
 *    - 完整 ID 取自行 tooltip 的第一行（上游约定：tooltip = 完整 ID + 展示名）；
 *      行内胶囊是去掉供应商前缀的短名，不能用来回填客户端配置。
 *    - 复制反馈写成行上的 data 属性交给 CSS 呈现，不往 React 管理的节点里插子节点。
 *
 * 2. 模型行右侧显示上下文窗口与输出上限（数据来自 `/admin/models/api/limits`），
 *    方便照着网关的真实能力填客户端配置。同样只写 data 属性，由 CSS `::after`
 *    渲染；React 重渲染/搜索过滤后由 MutationObserver 重新补上。
 *
 * 只在 DOM 层增强、不修改上游 bundle：上游升级后类名若变化，本功能会静默失效，
 * 但不会拖垮整个管理界面。
 */
import { copyText } from "./clipboard"

const ROW_SELECTOR = ".dim-jh-gatewayModal .dim-jh-gatewayModelRow"
const FEEDBACK_MS = 1200
const LIMITS_URL = "/admin/models/api/limits"
const LIMITS_ATTR = "data-c2a-limits"
const LIMITS_RETRY_MS = 30_000

const feedbackTimers = new WeakMap<HTMLElement, number>()

function showFeedback(row: HTMLElement, state: "true" | "error") {
  const previous = feedbackTimers.get(row)
  if (previous !== undefined) window.clearTimeout(previous)
  row.setAttribute("data-c2a-copied", state)
  const timer = window.setTimeout(() => {
    row.removeAttribute("data-c2a-copied")
    feedbackTimers.delete(row)
  }, FEEDBACK_MS)
  feedbackTimers.set(row, timer)
}

/** 模型行对应的完整 ID（含供应商前缀）；取不到时返回空串。 */
function modelIdOf(row: HTMLElement): string {
  const fromTitle = (row.getAttribute("title") ?? "").split("\n")[0]?.trim() ?? ""
  if (fromTitle !== "") return fromTitle
  return row.querySelector(".dim-jh-modelId")?.textContent?.trim() ?? ""
}

/** 后端 `/admin/models/api/limits` 的一行（字段与 models.service.ts 对齐）。 */
export interface ModelLimit {
  id: string
  contextWindow: number | null
  maxOutputTokens: number | null
  /** 渠道级统一输出上限（CodeArts：适配器不声明逐模型值）。 */
  maxOutputCap?: number
}

interface LimitsState {
  map: Map<string, ModelLimit>
  loaded: Set<string>
  promise: Promise<void> | null
  failedAt: number
}

function limitsState(): LimitsState {
  const w = window as any
  w.__c2aModelLimitsState ??= {
    map: new Map<string, ModelLimit>(),
    loaded: new Set<string>(),
    promise: null,
    failedAt: 0,
  }
  return w.__c2aModelLimitsState
}

function formatCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** 把一行能力格式化成行内文案；未声明的字段如实写「未声明」，不猜。 */
export function formatModelLimits(limit: ModelLimit): string {
  const context = formatCount(limit.contextWindow)
  const output = formatCount(limit.maxOutputTokens)
  const cap = formatCount(limit.maxOutputCap)
  return [
    context === null ? "上下文 未声明" : `上下文 ${context}`,
    output !== null ? `输出 ${output}` : cap !== null ? `输出上限 ${cap}（统一）` : "输出 未声明",
  ].join(" · ")
}

/** 把能力表写到当前所有模型行上（找不到对应行的渠道不受影响）。 */
export function applyModelLimits(root: ParentNode, limits: ReadonlyMap<string, ModelLimit>): void {
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const limit = limits.get(modelIdOf(row))
    if (limit === undefined) row.removeAttribute(LIMITS_ATTR)
    else row.setAttribute(LIMITS_ATTR, formatModelLimits(limit))
  }
}

/** 按渠道拉一次能力表；只拉当前清单里出现过的渠道，避免为未登录渠道白跑。 */
async function loadLimits(providers: string[]): Promise<void> {
  const state = limitsState()
  if (state.promise !== null) await state.promise
  const missing = providers.filter((provider) => !state.loaded.has(provider))
  if (missing.length === 0) return
  if (state.failedAt !== 0 && Date.now() - state.failedAt < LIMITS_RETRY_MS) return
  if (typeof fetch !== "function") return

  state.promise = (async () => {
    try {
      const query = `?providers=${encodeURIComponent([...missing].sort().join(","))}`
      const response = await fetch(`${LIMITS_URL}${query}`, { headers: { accept: "application/json" } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const rows = Array.isArray(body?.models) ? body.models : []
      for (const row of rows) {
        if (typeof row?.id !== "string" || row.id === "") continue
        state.map.set(row.id, {
          id: row.id,
          contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : null,
          maxOutputTokens: typeof row.maxOutputTokens === "number" ? row.maxOutputTokens : null,
          ...(typeof row.maxOutputCap === "number" ? { maxOutputCap: row.maxOutputCap } : {}),
        })
      }
      for (const provider of missing) state.loaded.add(provider)
      state.failedAt = 0
    } catch {
      // 静默失败：管理页照常可用，只是不显示能力值；30 秒后随下次渲染再试。
      state.failedAt = Date.now()
    }
  })()
  try {
    await state.promise
  } finally {
    state.promise = null
    applyModelLimits(document, state.map)
  }
}

let scheduled = false

function scheduleRefresh() {
  if (scheduled) return
  scheduled = true
  window.setTimeout(() => {
    scheduled = false
    const rows = document.querySelectorAll<HTMLElement>(ROW_SELECTOR)
    if (rows.length === 0) return
    const state = limitsState()
    // 先用已有缓存刷新（例如数据已到、React 又重渲染了一批行），再补拉缺失渠道。
    applyModelLimits(document, state.map)
    const providers = new Set<string>()
    for (const row of rows) {
      const id = modelIdOf(row)
      const slash = id.indexOf("/")
      if (slash > 0) providers.add(id.slice(0, slash))
    }
    const missing = [...providers].filter((provider) => !state.loaded.has(provider))
    if (missing.length > 0) void loadLimits(missing)
  }, 50)
}

/** 安装增强（幂等；只需在浏览器入口调用一次）。 */
export function installJetHubEnhancements() {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const w = window as any
  // 与 installOAuthRelay 同一套幂等开关：测试与 HMR 都能通过删标记重装。
  if (w.__c2aJetHubEnhancementsLoaded === true) return
  w.__c2aJetHubEnhancementsLoaded = true
  // 重复安装前先摘掉旧监听/观察器，避免同一次点击或渲染被处理多遍。
  if (typeof w.__c2aJetHubEnhancementsHandler === "function") {
    document.removeEventListener("click", w.__c2aJetHubEnhancementsHandler, true)
  }
  if (w.__c2aJetHubEnhancementsObserver !== undefined) {
    w.__c2aJetHubEnhancementsObserver.disconnect()
  }
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest("button, a, input, textarea, select")) return
    const row = target.closest<HTMLElement>(ROW_SELECTOR)
    if (!row) return
    // 用户在行内拖选文本时不抢点击（那是在手动复制展示名）。
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed && row.contains(selection.anchorNode)) return
    const id = modelIdOf(row)
    if (id === "") return
    void copyText(id).then(
      () => showFeedback(row, "true"),
      () => showFeedback(row, "error"),
    )
  }
  w.__c2aJetHubEnhancementsHandler = onClick
  document.addEventListener("click", onClick, true)

  if (document.body !== null) {
    const observer = new MutationObserver(() => scheduleRefresh())
    observer.observe(document.body, { childList: true, subtree: true })
    w.__c2aJetHubEnhancementsObserver = observer
    // 安装时弹窗可能已经打开（HMR / 语言切换重装）。
    scheduleRefresh()
  }
}
