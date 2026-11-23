/**
 * 总览趋势的序列构造（纯函数，便于单测）。
 *
 * - 日级：直接用后端 token 账本的日聚合（完整、持久化）。
 * - 小时级：用上游内存里的最近请求（最多 500 条）。服务重启后重新累计，
 *   更早的小时没有数据 —— 这是上游数据源的硬限制，不在这里编造。
 */

export interface TrendPoint {
  /** React key（小时级同一天会重复 label，必须独立 key）。 */
  key: string
  /** x 轴标签。 */
  label: string
  /** hover 提示用的完整时间。 */
  title: string
  requests: number
  inTokens: number
  outTokens: number
  empty?: boolean
}

const HOUR_MS = 3600_000
const UTC8_MS = 8 * HOUR_MS

function utc8Parts(ts: number) {
  const d = new Date(ts + UTC8_MS)
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }
}

function hourLabel(hour: number) {
  return String(hour).padStart(2, "0") + ":00"
}

function hourTitle(day: string, hour: number) {
  return day.slice(5) + " " + hourLabel(hour)
}

function add(bucket: TrendPoint, entry: any) {
  bucket.requests += 1
  // 与后端「输入 tokens」保持一致：账本的 inputTokens 不含缓存读，这里加回去。
  bucket.inTokens += (Number(entry?.inputTokens) || 0) + (Number(entry?.cacheReadTokens) || 0)
  bucket.outTokens += Number(entry?.outputTokens) || 0
}

/** 今天的 24 个小时桶（UTC+8，00:00–23:00）。 */
export function buildTodayHourly(recent: any[], now = Date.now()): TrendPoint[] {
  const today = utc8Parts(now).day
  const buckets: TrendPoint[] = Array.from({ length: 24 }, (_, hour) => ({
    key: `${today}-${hour}`,
    label: hourLabel(hour),
    title: hourTitle(today, hour),
    requests: 0,
    inTokens: 0,
    outTokens: 0,
  }))
  for (const entry of recent || []) {
    const ts = Number(entry?.ts)
    if (!Number.isFinite(ts)) continue
    const parts = utc8Parts(ts)
    if (parts.day !== today) continue
    add(buckets[parts.hour], entry)
  }
  return buckets
}

/** 最近 24 个小时桶（含当前小时，按整点对齐）。 */
export function buildLast24h(recent: any[], now = Date.now()): TrendPoint[] {
  const endHour = Math.floor(now / HOUR_MS) * HOUR_MS
  const start = endHour - 23 * HOUR_MS
  const buckets: TrendPoint[] = Array.from({ length: 24 }, (_, index) => {
    const parts = utc8Parts(start + index * HOUR_MS)
    return {
      key: String(start + index * HOUR_MS),
      label: hourLabel(parts.hour),
      title: hourTitle(parts.day, parts.hour),
      requests: 0,
      inTokens: 0,
      outTokens: 0,
    }
  })
  for (const entry of recent || []) {
    const ts = Number(entry?.ts)
    if (!Number.isFinite(ts) || ts < start || ts > now) continue
    const index = Math.floor((ts - start) / HOUR_MS)
    if (index >= 0 && index < buckets.length) add(buckets[index], entry)
  }
  return buckets
}

/** 最近 N 个自然日（UTC+8），直接取后端 usage.days 的尾部。 */
export function buildDaily(days: any[], count: number): TrendPoint[] {
  return (days || []).slice(-count).map((day: any) => ({
    key: String(day.date || ""),
    label: String(day.date || "").slice(5),
    title: String(day.date || ""),
    requests: Number(day.requests) || 0,
    inTokens: Number(day.inTokens) || 0,
    outTokens: Number(day.outTokens) || 0,
    ...(day.empty ? { empty: true } : {}),
  }))
}

/** 最近一天正在使用的模型（从最近请求聚合，供小时级窗口与模型分布兜底）。 */
export function topModelsFromRecent(recent: any[], limit = 10): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const entry of recent || []) {
    const model = String(entry?.model || "").trim()
    if (model === "") continue
    const provider = String(entry?.provider || "").trim()
    const key = provider ? `${provider}/${model}` : model
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}
