import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { buildDaily, buildLast24h, buildTodayHourly, topModelsFromRecent } from "../web/pages/overview/trend.ts"

const at = (iso: string) => Date.parse(iso)
const entry = (iso: string, patch: any = {}) => ({
  ts: at(iso),
  provider: "codearts",
  model: "m",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  ...patch,
})

test("今天：按 UTC+8 小时聚合，跨日边界正确", () => {
  const now = at("2026-11-23T12:00:00Z") // 20:00 CST
  const points = buildTodayHourly(
    [
      entry("2026-11-23T01:30:00Z"), // 09:30 CST
      entry("2026-11-23T02:15:00Z", { inputTokens: 20, cacheReadTokens: 5, outputTokens: 4 }), // 10:15
      entry("2026-11-22T16:30:00Z"), // 11-23 00:30 CST
      entry("2026-11-22T15:30:00Z"), // 11-22 23:30 CST → 不计入今天
    ],
    now,
  )
  assert.equal(points.length, 24)
  assert.equal(points[0].label, "00:00")
  assert.equal(points[0].title, "11-23 00:00")
  assert.equal(points[0].requests, 1)
  assert.equal(points[9].requests, 1)
  assert.equal(points[9].inTokens, 13) // 10 + cache 3
  assert.equal(points[10].requests, 1)
  assert.equal(points[10].inTokens, 25)
  assert.equal(points[10].outTokens, 4)
  assert.equal(points[23].requests, 0)
  assert.equal(new Set(points.map((p) => p.key)).size, 24)
})

test("近24小时：按整点对齐的 24 个桶，窗口外数据丢弃", () => {
  const now = at("2026-11-23T12:00:00Z") // 20:00 CST
  const points = buildLast24h(
    [
      entry("2026-11-22T16:30:00Z"), // 11-23 00:30 CST → 第 4 桶
      entry("2026-11-23T01:30:00Z"), // 09:30 → 第 13 桶
      entry("2026-11-23T02:15:00Z"), // 10:15 → 第 14 桶
      entry("2026-11-22T12:30:00Z"), // 11-22 20:30 CST → 窗口外
      entry("2026-11-23T12:30:00Z"), // 未来 → 窗口外
    ],
    now,
  )
  assert.equal(points.length, 24)
  assert.equal(points[3].requests, 1)
  assert.equal(points[3].label, "00:00")
  assert.equal(points[12].requests, 1)
  assert.equal(points[12].label, "09:00")
  assert.equal(points[13].requests, 1)
  assert.equal(points[13].label, "10:00")
  assert.equal(points[23].label, "20:00")
  assert.equal(
    points.reduce((sum, p) => sum + p.requests, 0),
    3,
  )
})

test("日级：取 usage.days 尾部并保留空日标记", () => {
  const days = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-11-${String(i + 10).padStart(2, "0")}`,
    requests: i,
    inTokens: i * 10,
    outTokens: i,
    ...(i === 13 ? { empty: true } : {}),
  }))
  const points = buildDaily(days, 3)
  assert.deepEqual(
    points.map((p) => p.label),
    ["11-21", "11-22", "11-23"],
  )
  assert.equal(points[0].requests, 11)
  assert.equal(points[2].empty, true)
  assert.equal(points[2].key, "2026-11-23")
})

test("最近请求的模型聚合按 provider/model 去重计数", () => {
  const top = topModelsFromRecent(
    [
      entry("2026-11-23T01:00:00Z", { model: "m1" }),
      entry("2026-11-23T01:01:00Z", { model: "m1" }),
      entry("2026-11-23T01:02:00Z", { provider: "trae", model: "m2" }),
    ],
    10,
  )
  assert.deepEqual(top, [
    ["codearts/m1", 2],
    ["trae/m2", 1],
  ])
})
