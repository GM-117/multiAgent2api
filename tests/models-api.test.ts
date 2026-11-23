import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { startTestApp } from "./helpers"

test("旧版 models POST action 协议仍可用（迁移兼容）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const headers = { authorization: `Bearer ${app.adminKey}`, "content-type": "application/json" }
  const listed = await fetch(`${app.origin}/admin/models/api`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "list", provider: "opencode" }),
  })
  assert.equal(listed.status, 200)
  const listBody = await listed.json()
  assert.equal(listBody.provider, "opencode")
  assert.ok(Array.isArray(listBody.models))

  const status = await fetch(`${app.origin}/admin/models/api`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "status", providers: ["opencode"] }),
  })
  assert.equal(status.status, 200)
  assert.ok((await status.json()).statuses)
})

test("模型能力接口需管理鉴权，并按渠道返回能力行", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const unauthorized = await fetch(`${app.origin}/admin/models/api/limits`)
  assert.equal(unauthorized.status, 401)

  const response = await fetch(`${app.origin}/admin/models/api/limits?providers=opencode`, {
    headers: { authorization: `Bearer ${app.adminKey}` },
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(Array.isArray(body.models))
  assert.equal(typeof body.generatedAt, "number")
  for (const row of body.models) {
    assert.equal(typeof row.id, "string")
    assert.ok(row.id.startsWith("opencode/"))
    assert.ok("contextWindow" in row)
    assert.ok("maxOutputTokens" in row)
  }
})
