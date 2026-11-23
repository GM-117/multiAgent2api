import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { createModelsService } from "../src/modules/models/models.service.ts"

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

function createFakeLlm() {
  const calls = { listProviders: 0, listModels: 0, resolve: 0 }
  const models: Record<string, string[]> = {
    codearts: ["kimi-k3.1-pro", "glm-5.2"],
    buddy: ["hy4-preview"],
    qodercn: ["auto"],
  }
  const infos: Record<string, any> = {
    "codearts/kimi-k3.1-pro": { context: { contextWindow: 1_048_576 } },
    "codearts/glm-5.2": { context: { contextWindow: 202_752 } },
    "buddy/hy4-preview": { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 64_000 },
    "qodercn/auto": { context: { contextWindow: 1_000_000 } },
  }
  const llm = {
    calls,
    listProviders() {
      calls.listProviders += 1
      return [{ id: "codearts" }, { id: "buddy" }, { id: "qodercn" }]
    },
    async listModels(provider: string) {
      calls.listModels += 1
      return (models[provider] ?? []).map((id) => ({ id }))
    },
    async resolveModelInfo(provider: string, model: string) {
      calls.resolve += 1
      return infos[`${provider}/${model}`]
    },
  }
  return { llm, calls, models, infos }
}

function makeService(llm: any) {
  return createModelsService({ rpc: async () => ({}), llm, logger: silent as any })
}

test("能力表：逐模型上下文窗口 + 输出上限，CodeArts 补渠道统一上限", async () => {
  const { llm } = createFakeLlm()
  const value = await makeService(llm).limits()
  const byId = new Map(value.models.map((row: any) => [row.id, row]))

  const codearts = byId.get("codearts/kimi-k3.1-pro") as any
  assert.equal(codearts.contextWindow, 1_048_576)
  assert.equal(codearts.maxOutputTokens, null)
  assert.equal(codearts.maxOutputCap, 65_536)
  assert.equal(codearts.defaultOutputBudget, 32_000)

  const buddy = byId.get("buddy/hy4-preview") as any
  assert.equal(buddy.contextWindow, 1_000_000)
  assert.equal(buddy.maxOutputTokens, 64_000)
  assert.equal(buddy.maxOutputCap, undefined)

  const qoder = byId.get("qodercn/auto") as any
  assert.equal(qoder.contextWindow, 1_000_000)
  assert.equal(qoder.maxOutputTokens, null)
  assert.equal(qoder.maxOutputCap, undefined)
})

test("只解析请求里指定的渠道，不扫全部已注册渠道", async () => {
  const { llm, calls } = createFakeLlm()
  const value = await makeService(llm).limits(["codearts"])
  assert.deepEqual(
    value.models.map((row: any) => row.provider),
    ["codearts", "codearts"],
  )
  assert.equal(calls.listModels, 1)
  assert.equal(calls.resolve, 2)
})

test("同一渠道组合命中缓存，不重复 resolve", async () => {
  const { llm, calls } = createFakeLlm()
  const service = makeService(llm)
  const first = await service.limits(["codearts"])
  const resolves = calls.resolve
  const second = await service.limits(["codearts"])
  assert.equal(calls.resolve, resolves)
  assert.deepEqual(second.models, first.models)
})

test("单模型解析失败只让该行缺值，CodeArts 渠道上限仍显示", async () => {
  const { llm } = createFakeLlm()
  const original = llm.resolveModelInfo
  llm.resolveModelInfo = async (provider: string, model: string) => {
    if (model === "glm-5.2") throw new Error("boom")
    return original(provider, model)
  }
  const value = await makeService(llm).limits(["codearts"])
  const bad = value.models.find((row: any) => row.model === "glm-5.2") as any
  assert.equal(bad.contextWindow, null)
  assert.equal(bad.maxOutputTokens, null)
  assert.equal(bad.maxOutputCap, 65_536)
})

test("某个渠道目录读取失败不影响其他渠道", async () => {
  const { llm, models } = createFakeLlm()
  const original = llm.listModels
  llm.listModels = async (provider: string) => {
    if (provider === "buddy") throw new Error("offline")
    return original(provider)
  }
  const value = await makeService(llm).limits()
  const providers = new Set(value.models.map((row: any) => row.provider))
  assert.equal(providers.has("codearts"), true)
  assert.equal(providers.has("qodercn"), true)
  assert.equal(providers.has("buddy"), false)
  assert.deepEqual(models.codearts.length, 2)
})

test("没有 llm 时返回空能力表而不是抛错", async () => {
  const service = createModelsService({ rpc: async () => ({}), logger: silent as any })
  const value = await service.limits()
  assert.deepEqual(value.models, [])
  assert.equal(typeof value.generatedAt, "number")
})
