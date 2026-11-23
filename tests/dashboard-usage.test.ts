import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vite-plus/test"

import { createDashboard } from "../src/modules/dashboard/dashboard.service.ts"

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** UTC+8 日键（与看板一致）。 */
function utc8Day(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600_000 - offsetDays * 86400_000).toISOString().slice(0, 10)
}

async function makeHome(t: any) {
  const home = await mkdtemp(join(tmpdir(), "c2a-dashboard-"))
  t.onTestFinished(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, "jet-hub"), { recursive: true })
  await mkdir(join(home, "caller-usage"), { recursive: true })
  return home
}

async function writeLedger(home: string, days: any) {
  await writeFile(
    join(home, "jet-hub", "token-ledger.json"),
    JSON.stringify({ schema: "dsh-codearts-auth/token-ledger/v2", days }),
    "utf8",
  )
}

async function writeCallerLog(home: string, day: string, rows: any[]) {
  await writeFile(
    join(home, "caller-usage", `${day}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  )
}

function snapshotOf(home: string) {
  return createDashboard({
    dataDir: home,
    rpc: async () => ({}),
    gateway: () => ({}),
    logger: silent,
  }).snapshot()
}

test("今日用量与趋势以 token 账本为主（未配置调用方 Key 也有数据）", async (t) => {
  const home = await makeHome(t)
  const today = utc8Day(0)
  const yesterday = utc8Day(1)
  await writeLedger(home, {
    [today]: {
      "gateway|codearts|acc-1|model-a": {
        requests: 3,
        reportedRequests: 3,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
        reasoningTokens: 10,
        errors: 1,
        ttftSumMs: 3000,
        ttftCount: 2,
      },
    },
    [yesterday]: {
      "direct|buddy|acc-2|model-b": {
        requests: 2,
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 100,
        errors: 0,
        ttftSumMs: 1000,
        ttftCount: 1,
      },
    },
  })

  const snap: any = await snapshotOf(home)
  assert.equal(snap.usage.today.requests, 3)
  assert.equal(snap.usage.today.ok, 2)
  assert.equal(snap.usage.today.errors, 1)
  // 账本 inputTokens 不含缓存读；看板的「输入 tokens」统一成含缓存读口径。
  assert.equal(snap.usage.today.inTokens, 1300)
  assert.equal(snap.usage.today.outTokens, 200)
  assert.equal(snap.usage.today.cacheRead, 300)

  assert.equal(snap.usage.days.length, 14)
  const byDate = new Map(snap.usage.days.map((d: any) => [d.date, d]))
  assert.equal((byDate.get(today) as any).requests, 3)
  assert.equal((byDate.get(today) as any).empty, undefined)
  assert.equal((byDate.get(yesterday) as any).requests, 2)
  assert.equal((byDate.get(utc8Day(2)) as any).empty, true)

  const ledgerToday = snap.ledger.find((x: any) => x.date === today)
  assert.equal(ledgerToday.inTokens, 1000) // 账本原值，供对账
  assert.equal(ledgerToday.cacheRead, 300)
  assert.equal(ledgerToday.cacheWrite, 50)
  assert.equal(ledgerToday.ttftAvgMs, 1500)
})

test("没有账本时回落到调用方日志（含缓存读）", async (t) => {
  const home = await makeHome(t)
  const today = utc8Day(0)
  await writeCallerLog(home, today, [
    { status: 200, in_tokens: 100, out_tokens: 20, cached_tokens: 30, model: "m1", caller: "c1" },
    { status: 500, in_tokens: 50, out_tokens: 0, cached_tokens: 0, model: "m2", caller: "c1" },
  ])

  const snap: any = await snapshotOf(home)
  assert.equal(snap.usage.today.requests, 2)
  assert.equal(snap.usage.today.ok, 1)
  assert.equal(snap.usage.today.errors, 1)
  assert.equal(snap.usage.today.inTokens, 150)
  assert.equal(snap.usage.today.outTokens, 20)
  assert.equal(snap.usage.today.cacheRead, 30)
})

test("账本与调用方日志同时存在时不重复计数，账本口径优先", async (t) => {
  const home = await makeHome(t)
  const today = utc8Day(0)
  await writeLedger(home, {
    [today]: {
      "gateway|codearts|acc-1|model-a": {
        requests: 3,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        errors: 0,
      },
    },
  })
  await writeCallerLog(home, today, [
    { status: 200, in_tokens: 999, out_tokens: 999, cached_tokens: 999, model: "m1", caller: "c1" },
  ])

  const snap: any = await snapshotOf(home)
  assert.equal(snap.usage.today.requests, 3)
  assert.equal(snap.usage.today.inTokens, 1300)
  assert.equal(snap.usage.today.outTokens, 200)
  // 调用方日志仍是明细来源：模型/调用方计数保留下来。
  assert.equal(snap.usage.today.models.m1, 1)
  assert.equal(snap.usage.today.callers.c1, 1)
})
