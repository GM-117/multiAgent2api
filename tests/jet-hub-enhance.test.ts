/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { afterEach, beforeEach, test, vi } from "vite-plus/test"

import { installJetHubEnhancements } from "../web/utils/jet-hub-enhance.ts"

const copied: string[] = []
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

/** 摘掉已安装的监听并清空状态（测试之间必须显式移除文档级监听）。 */
function teardown() {
  vi.useRealTimers()
  document.body.innerHTML = ""
  const handler = (window as any).__c2aJetHubEnhancementsHandler
  if (typeof handler === "function") document.removeEventListener("click", handler, true)
  delete (window as any).__c2aJetHubEnhancementsLoaded
  delete (window as any).__c2aJetHubEnhancementsHandler
  window.getSelection()?.removeAllRanges()
}

beforeEach(() => {
  teardown()
  copied.length = 0
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true })
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (value: string) => {
        copied.push(value)
        return Promise.resolve()
      },
    },
    configurable: true,
  })
  installJetHubEnhancements()
})

afterEach(teardown)

function makeGatewayRow(id: string, name: string) {
  const modal = document.createElement("div")
  modal.className = "dim-jh-modal dim-jh-gatewayModal"
  const row = document.createElement("div")
  row.className = "dim-jh-gatewayModelRow"
  row.setAttribute("title", `${id}\n${name}`)
  const code = document.createElement("code")
  code.className = "dim-jh-modelId"
  code.textContent = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id
  row.append(code)
  modal.append(row)
  document.body.append(modal)
  return { row, code }
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }))

test("点击模型行复制完整 ID（含供应商前缀）并显示成功反馈", async () => {
  const { row, code } = makeGatewayRow("codearts/deepseek-v4.1-flash-1017", "DeepSeek-V4.1-Flash-1017")
  click(code)
  await flush()
  assert.deepEqual(copied, ["codearts/deepseek-v4.1-flash-1017"])
  assert.equal(row.getAttribute("data-c2a-copied"), "true")
})

test("点击行内展示名同样复制；不在网关弹窗内的同名行不响应", async () => {
  const { row } = makeGatewayRow("codearts/kimi-k3", "Kimi-K3")
  click(row)
  await flush()
  assert.deepEqual(copied, ["codearts/kimi-k3"])

  copied.length = 0
  const outside = document.createElement("div")
  outside.className = "dim-jh-gatewayModelRow"
  outside.setAttribute("title", "other/model\nOther")
  document.body.append(outside)
  click(outside)
  await flush()
  assert.deepEqual(copied, [])
})

test("行内拖选文本时不抢点击", async () => {
  const { code } = makeGatewayRow("codearts/glm-5.2", "GLM-5.2")
  const range = document.createRange()
  range.selectNodeContents(code)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  click(code)
  await flush()
  assert.deepEqual(copied, [])
})

test("复制失败时显示失败反馈", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.reject(new Error("denied")) },
    configurable: true,
  })
  const { row } = makeGatewayRow("codearts/speed", "智速模式")
  click(row)
  await flush()
  assert.equal(row.getAttribute("data-c2a-copied"), "error")
})

test("反馈 1.2 秒后自动消失", async () => {
  vi.useFakeTimers()
  const { row } = makeGatewayRow("codearts/glm-5.2", "GLM-5.2")
  click(row)
  await flush()
  assert.equal(row.getAttribute("data-c2a-copied"), "true")
  vi.advanceTimersByTime(1300)
  assert.equal(row.getAttribute("data-c2a-copied"), null)
})

test("重复安装不会让一次点击复制多遍", async () => {
  installJetHubEnhancements()
  installJetHubEnhancements()
  const { row } = makeGatewayRow("codearts/kimi-k3", "Kimi-K3")
  click(row)
  await flush()
  assert.deepEqual(copied, ["codearts/kimi-k3"])
})
