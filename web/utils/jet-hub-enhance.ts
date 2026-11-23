/**
 * 上游 JetHub 界面的本仓库增强（custom 分支的个人化）。
 *
 * 上游只提供「复制全部 / 复制本组」，网关弹窗里的单条模型行是只读展示。
 * 这里用文档级事件委托补上「点击一行 = 复制这一条的完整模型 ID」：
 * - 完整 ID 取自行 tooltip 的第一行（上游约定：tooltip = 完整 ID + 展示名）；
 *   行内胶囊是去掉供应商前缀的短名，不能用来回填客户端配置。
 * - 复制反馈写成行上的 data 属性交给 CSS 呈现，不往 React 管理的节点里插子节点。
 *
 * 只在 DOM 层增强、不修改上游 bundle：上游升级后类名若变化，本功能会静默失效，
 * 但不会拖垮整个管理界面。
 */
import { copyText } from "./clipboard"

const ROW_SELECTOR = ".dim-jh-gatewayModal .dim-jh-gatewayModelRow"
const FEEDBACK_MS = 1200

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

/** 安装增强（幂等；只需在浏览器入口调用一次）。 */
export function installJetHubEnhancements() {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const w = window as any
  // 与 installOAuthRelay 同一套幂等开关：测试与 HMR 都能通过删标记重装。
  if (w.__c2aJetHubEnhancementsLoaded === true) return
  w.__c2aJetHubEnhancementsLoaded = true
  // 重复安装前先摘掉旧监听，避免同一次点击触发多遍复制。
  if (typeof w.__c2aJetHubEnhancementsHandler === "function") {
    document.removeEventListener("click", w.__c2aJetHubEnhancementsHandler, true)
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
}
