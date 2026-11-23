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

function snapshotOf(home: string, rpc: (method: string, payload?: any) => Promise<any> = async () => ({})) {
  return createDashboard({
    dataDir: home,
    rpc,
    gateway: () => ({}),
    logger: silent,
    // 单测完全控制余额读数，不能让后台采样先建基线。
    autoSampleCredits: false,
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
  // 模型分布必须来自账本桶键（gateway|provider|account|model），不能只靠调用方日志。
  assert.equal(snap.usage.today.models["codearts/model-a"], 3)

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
  // 模型分布以账本为主（调用方日志是子集，不叠加）。
  assert.equal(snap.usage.today.models["codearts/model-a"], 3)
  assert.equal(snap.usage.today.models.m1, undefined)
  // 调用方日志的 caller 维度仍保留。
  assert.equal(snap.usage.today.callers.c1, 1)
})

test("最近请求进入 snapshot.recent（小时级趋势数据源）", async (t) => {
  const home = await makeHome(t)
  const now = Date.now()
  const snap: any = await snapshotOf(home, async (method) => {
    if (method !== "usage.tokenLedger") return {}
    return {
      snapshot: {
        entries: [
          {
            ts: now - 1000,
            provider: "codearts",
            model: "m",
            channel: "gateway",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 3,
          },
          {
            ts: now - 2000,
            provider: "codearts",
            model: "m",
            channel: "gateway",
            inputTokens: 20,
            outputTokens: 4,
            cacheReadTokens: 5,
          },
        ],
      },
    }
  })
  assert.equal(snap.recent.length, 2)
  assert.ok(snap.recent[0].ts < snap.recent[1].ts)
  assert.equal(snap.recent[0].inputTokens, 20)
  assert.equal(snap.recent[1].cacheReadTokens, 3)
})

test("积分消耗按余额快照增量统计，重置不记负数", async (t) => {
  const home = await makeHome(t)
  await writeFile(
    join(home, "jet-hub", "state.json"),
    JSON.stringify({
      accounts: [{ id: "codearts-1", provider: "codearts", credentialRef: "CODEARTS_ACCOUNT_X", enabled: true }],
    }),
    "utf8",
  )
  let used = 100
  const rpc = async (method: string) => {
    if (method !== "credits.balances") return {}
    return {
      accounts: [
        {
          accountId: "codearts-1",
          nickname: "u",
          balance: {
            total: 1000,
            packages: [{ name: "p", unit: "credit", total: 1000, used, remaining: 1000 - used, active: true }],
          },
        },
      ],
    }
  }
  const dashboard = createDashboard({
    dataDir: home,
    rpc,
    gateway: () => ({}),
    logger: silent,
    autoSampleCredits: false,
  })

  const first: any = await dashboard.snapshot({ fresh: true })
  assert.equal(first.credits.consumption.periods.today.total, 0)
  assert.equal(typeof first.credits.consumption.since, "number")

  used = 150
  const second: any = await dashboard.snapshot({ fresh: true })
  assert.equal(second.credits.consumption.periods.today.total, 50)
  assert.equal(second.credits.consumption.periods.today.byUnit.credit, 50)
  assert.equal(second.credits.consumption.periods.today.byProvider.codearts, 50)
  assert.deepEqual(Object.values(second.credits.consumption.periods.today.byPackage), [50])

  // 包重置/补发会让 used 下降：不记负数，只更新基线。
  used = 120
  const third: any = await dashboard.snapshot({ fresh: true })
  assert.equal(third.credits.consumption.periods.today.total, 50)
  assert.equal(third.credits.consumption.periods.d7.total, 50)
})

test("同名积分包按周期字段区分，不把不同包的 used 混在一起", async (t) => {
  const home = await makeHome(t)
  await writeFile(
    join(home, "jet-hub", "state.json"),
    JSON.stringify({
      accounts: [{ id: "buddy-1", provider: "buddy", credentialRef: "BUDDY_ACCOUNT_X", enabled: true }],
    }),
    "utf8",
  )
  let usedA = 10
  let usedB = 20
  const rpc = async (method: string) => {
    if (method !== "credits.balances") return {}
    return {
      accounts: [
        {
          accountId: "buddy-1",
          nickname: "u",
          balance: {
            total: 100,
            packages: [
              {
                name: "同名包",
                unit: "credits",
                total: 50,
                used: usedA,
                remaining: 50 - usedA,
                active: true,
                cycleStartTime: "2026-11-01 12:00:00",
                cycleEndTime: "2026-11-24 12:00:00",
              },
              {
                name: "同名包",
                unit: "credits",
                total: 50,
                used: usedB,
                remaining: 50 - usedB,
                active: true,
                cycleStartTime: "2026-11-02 12:00:00",
                cycleEndTime: "2026-11-25 12:00:00",
              },
            ],
          },
        },
      ],
    }
  }
  const dashboard = createDashboard({
    dataDir: home,
    rpc,
    gateway: () => ({}),
    logger: silent,
    autoSampleCredits: false,
  })
  await dashboard.snapshot({ fresh: true })
  usedA = 15
  usedB = 25
  const second: any = await dashboard.snapshot({ fresh: true })
  assert.equal(second.credits.consumption.periods.today.total, 10)
  assert.deepEqual(Object.values(second.credits.consumption.periods.today.byPackage).sort(), [5, 5])
})
