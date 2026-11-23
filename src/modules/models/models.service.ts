import { AppError } from "../../core/errors.ts"
import type { Logger } from "../../core/types.ts"

/**
 * 供应商「可用模型」领域服务。
 *
 * 上游只有两个原始事实源（model.list 目录 / account.list 的 modelRateLimits），
 * “模型能不能用”必须按账号聚合 —— 这是本模块唯一的业务判断。
 */
export class ModelsError extends AppError {
  constructor(status: number, message: string) {
    super(status, "models", message)
  }
}

/** 目录 + 账号限流 → 逐模型状态。 */
function summarize(models: any[], accounts: any[], now: number) {
  const list = Array.isArray(accounts) ? accounts : []
  const enabled = list.filter((a) => a.enabled !== false)
  return (Array.isArray(models) ? models : []).map((m) => {
    const id = String(m.id)
    const limits: { accountId: string; resetAt: number }[] = []
    for (const acc of enabled) {
      const raw = acc.modelRateLimits
      if (raw === null || typeof raw !== "object") continue
      const at = raw[id]
      if (typeof at === "number" && Number.isFinite(at) && at > now)
        limits.push({ accountId: String(acc.id), resetAt: at })
    }
    const limitedAccounts = limits.length
    const usableAccounts = Math.max(0, enabled.length - limitedAccounts)
    const nextResetAt = limits.length > 0 ? Math.min(...limits.map((l) => l.resetAt)) : null
    let state: string
    if (m.dead === true) state = "dead"
    else if (m.disabled === true) state = "off"
    else if (enabled.length === 0) state = "ok"
    else if (usableAccounts > 0) state = limitedAccounts > 0 ? "partial" : "ok"
    else state = "limited"
    return {
      id,
      name: String(m.name ?? m.id),
      disabled: m.disabled === true,
      dead: m.dead === true,
      isFree: m.isFree === true || m.free === true,
      state,
      limitedAccounts,
      usableAccounts,
      enabledAccounts: enabled.length,
      nextResetAt,
    }
  })
}

function summarizeCounts(rows: any[]) {
  const counts: any = { total: rows.length, ok: 0, partial: 0, limited: 0, off: 0, dead: 0, usable: 0 }
  for (const r of rows) if (counts[r.state] !== undefined) counts[r.state] += 1
  counts.usable = counts.ok + counts.partial
  return counts
}

export interface ModelsServiceOptions {
  rpc: (method: string, payload?: any) => Promise<any>
  /**
   * 真实的 DSH LLM 运行时（`ctx.llm`）。
   *
   * 上下文窗口与逐模型输出上限只存在于它的 `resolveModelInfo()` 里：
   * `/v1/models` 的 `max_tokens` 恒空（DSH 的 `listModels` 不携带该字段），
   * 不能从网关响应反推。缺失时能力表返回空数组，不影响其余模型接口。
   */
  llm?: ModelsLlm
  logger?: Logger
}

/** `ctx.llm` 的最小调用面（便于单测注入桩，不复制 DSH 类型）。 */
export interface ModelsLlm {
  listProviders(): Array<{ id?: unknown }>
  listModels(provider: string): Promise<Array<{ id?: unknown }>>
  resolveModelInfo(provider: string, model: string): Promise<any>
}

/** 逐模型能力行；`null` = 上游未声明（不猜）。 */
export interface ModelLimit {
  /** 网关里的完整模型 ID（`provider/model`）。 */
  id: string
  provider: string
  model: string
  contextWindow: number | null
  maxOutputTokens: number | null
  /** 渠道级统一输出上限（仅 CodeArts：适配器不声明逐模型值）。 */
  maxOutputCap?: number
  /** 渠道级默认输出预算（仅 CodeArts）。 */
  defaultOutputBudget?: number
}

/**
 * 渠道级输出上限（**仅用于展示**）。
 *
 * CodeArts 适配器刻意不声明逐模型 `maxTokens`（见上游 `llm-adapter.ts` 的
 * `CODEARTS_MAX_OUTPUT_TOKENS` / `CODEARTS_DEFAULT_MAX_OUTPUT_TOKENS`）：
 * 出站统一收敛到 65,536，未指定时默认 32,000。于是 `resolveModelInfo()` 的
 * `defaultMaxTokens` 恒为 undefined —— 这里补一个展示值，避免用户照第三方
 * 静态表填 131072（那会超过本网关的实际上限）。
 *
 * ⚠️ 不参与任何请求预算；上游若调整这两个常量，需要同步这里。
 */
const CHANNEL_OUTPUT_LIMITS: Record<string, { cap: number; defaultBudget: number }> = {
  codearts: { cap: 65_536, defaultBudget: 32_000 },
}

const LIMITS_TTL_MS = 60_000
const LIMITS_CONCURRENCY = 6

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 固定并发跑一批异步任务（目录最多百来条，逐条串行在大目录上会明显变慢）。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export function createModelsService(options: ModelsServiceOptions) {
  const rpc = options.rpc
  const llm = options.llm
  const logger = options.logger ?? console
  if (typeof rpc !== "function") throw new Error("models service 需要 rpc 依赖")
  const limitsCache = new Map<string, { at: number; value: any }>()

  async function list(provider: string) {
    if (!provider) throw new ModelsError(400, "provider 必填")
    const value = await rpc("model.list", { provider })
    return { provider, models: Array.isArray(value?.models) ? value.models : [] }
  }

  async function overview(provider: string) {
    if (!provider) throw new ModelsError(400, "provider 必填")
    const value = await rpc("model.list", { provider })
    const models = Array.isArray(value?.models) ? value.models : []
    const now = Date.now()
    const [accountsRes, statusRes] = await Promise.all([
      rpc("account.list", { provider }).catch(() => null),
      rpc("provider.status", { providers: [provider] }).catch(() => null),
    ])
    const accounts = Array.isArray(accountsRes?.accounts) ? accountsRes.accounts : []
    const rows = summarize(models, accounts, now)
    return {
      provider,
      now,
      models: rows,
      counts: summarizeCounts(rows),
      accounts: accounts.map((a: any) => ({
        id: String(a.id),
        nickname: String(a.nickname ?? a.id),
        enabled: a.enabled !== false,
      })),
      accountsError: accountsRes === null ? "账号列表读取失败（限流状态不可用）" : null,
      providerStatus: statusRes?.statuses?.[provider] ?? null,
    }
  }

  async function status(providers: string[]) {
    const value = await rpc("provider.status", { providers })
    return { statuses: value?.statuses ?? {} }
  }

  async function toggle({ provider, modelId, disabled }: any) {
    if (!provider || !modelId) throw new ModelsError(400, "provider 与 modelId 必填")
    if (typeof disabled !== "boolean") throw new ModelsError(400, "disabled 必须是布尔值（上游不做默认值猜测）")
    const value = await rpc("model.setDisabled", { provider, modelId, disabled })
    logger?.info?.(`[models] ${disabled ? "关闭" : "打开"} ${provider}/${modelId}`)
    return { ok: true, warnings: value?.warnings ?? [] }
  }

  async function toggleMany({ provider, modelIds, disabled }: any) {
    if (!provider || !Array.isArray(modelIds) || modelIds.length === 0)
      throw new ModelsError(400, "provider 与 modelIds（非空数组）必填")
    if (typeof disabled !== "boolean") throw new ModelsError(400, "disabled 必须是布尔值")
    const value = await rpc("model.setDisabledMany", { provider, modelIds, disabled })
    logger?.info?.(`[models] ${provider} 批量${disabled ? "关闭" : "打开"} ${modelIds.length} 个`)
    return { ok: true, warnings: value?.warnings ?? [] }
  }

  /**
   * 逐模型的上下文窗口与输出上限（网关模型清单展示用）。
   *
   * 数据源是 `ctx.llm.resolveModelInfo()`，**不是** `/v1/models`：
   * 后者虽然输出 `context_window`，但 `max_tokens` 恒为空（DSH 的模型列表
   * 结构不携带该字段）。这里逐模型解析；单条失败只让该行缺值，不影响整表。
   *
   * @param providers 只解析这些渠道（前端按当前清单里的前缀传，避免为 30+
   *                  家未登录渠道白跑一轮）；空数组 = 全部已注册渠道。
   */
  async function limits(providers: string[] = []) {
    if (llm === undefined) return { generatedAt: Date.now(), models: [] as ModelLimit[] }
    const cacheKey = [...providers].sort().join(",")
    const cached = limitsCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < LIMITS_TTL_MS) return cached.value

    let registered: string[] = []
    try {
      const raw = await Promise.resolve(llm.listProviders())
      if (Array.isArray(raw)) registered = raw.map((entry) => String(entry?.id ?? "")).filter(Boolean)
    } catch (error) {
      logger?.warn?.(
        `[models] 渠道列表读取失败，能力表返回空：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const wanted = providers.length > 0 ? new Set(providers) : null
    const selected = registered.filter((provider) => wanted === null || wanted.has(provider))

    const groups = await Promise.all(
      selected.map(async (provider) => {
        try {
          const models = await llm.listModels(provider)
          return { provider, models: Array.isArray(models) ? models : [] }
        } catch (error) {
          logger?.warn?.(
            `[models] ${provider} 模型目录读取失败（能力表跳过该渠道）：${error instanceof Error ? error.message : String(error)}`,
          )
          return { provider, models: [] }
        }
      }),
    )
    const entries = groups
      .flatMap(({ provider, models }) => models.map((model) => ({ provider, model: String(model?.id ?? "") })))
      .filter((entry) => entry.model !== "")

    const rows = await mapWithConcurrency(entries, LIMITS_CONCURRENCY, async ({ provider, model }) => {
      let info: any
      try {
        info = await llm.resolveModelInfo(provider, model)
      } catch {
        // 单模型解析失败 ≠ 整表失败：窗口/输出留空，前端显示「未声明」。
        info = undefined
      }
      const contextWindow = positiveInteger(info?.context?.contextWindow)
      const maxOutputTokens = positiveInteger(info?.defaultMaxTokens)
      const channel = CHANNEL_OUTPUT_LIMITS[provider]
      const row: ModelLimit = {
        id: `${provider}/${model}`,
        provider,
        model,
        contextWindow,
        maxOutputTokens,
        ...(channel !== undefined && maxOutputTokens === null
          ? { maxOutputCap: channel.cap, defaultOutputBudget: channel.defaultBudget }
          : {}),
      }
      return row
    })

    const value = { generatedAt: Date.now(), models: rows }
    limitsCache.set(cacheKey, { at: Date.now(), value })
    // 缓存条目只随「渠道组合」增长，上限 8 个足以覆盖面板里的常见筛选。
    if (limitsCache.size > 8) {
      const oldest = limitsCache.keys().next().value
      if (oldest !== undefined) limitsCache.delete(oldest)
    }
    return value
  }

  return { list, overview, status, toggle, toggleMany, limits }
}

export type ModelsService = ReturnType<typeof createModelsService>
