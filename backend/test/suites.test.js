import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在 import 时就固定库路径，必须先设环境变量再动态 import src。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-suite-'))
const TOKEN = 'suite-unit-token-0123456789abcdef'
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'suite.db')
process.env.HEIBAIHE_TOKEN = TOKEN

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fakeIo = { to: () => ({ emit() {} }) }

let active = 0
let peak = 0
const hits = new Map()

const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const ms = Number(url.searchParams.get('ms') || 0)
  active += 1
  peak = Math.max(peak, active)
  try {
    if (ms > 0) await sleep(ms)
    if (url.pathname === '/api/echo') {
      return send(200, { code: 0, data: { query: Object.fromEntries(url.searchParams), headers: req.headers } })
    }
    if (url.pathname === '/api/fail') return send(500, { code: 500 })
    if (url.pathname === '/api/flaky') {
      const key = url.searchParams.get('key') || 'default'
      const failTimes = Number(url.searchParams.get('fail') || 1)
      const count = (hits.get(key) || 0) + 1
      hits.set(key, count)
      return count <= failTimes ? send(500, { code: 500, count }) : send(200, { code: 0, count })
    }
    send(404, { code: 404 })
  } finally {
    active -= 1
  }
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const stubBase = `http://127.0.0.1:${stub.address().port}`

after(async () => {
  const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
  closeDefaultDatabase()
  await new Promise((resolve) => stub.close(resolve))
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 50 })
})

function resetStub() {
  active = 0
  peak = 0
  hits.clear()
}

async function waitRun(runId, timeoutMs = 15000) {
  const { store } = await import('../src/store.js')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = store.getSuiteRun(runId)
    if (run && ['passed', 'failed', 'stopped'].includes(run.status)) return run
    await sleep(30)
  }
  throw new Error(`套件执行未在 ${timeoutMs} ms 内结束：${runId}`)
}

function makeFlow(store, name, url, extra = {}) {
  return store.saveFlow({
    name,
    type: 'blackbox',
    variables: extra.variables || {},
    nodes: [
      {
        id: 'n1',
        name: `${name}-请求`,
        action: { type: 'http', method: 'GET', url },
        expected: { status: extra.status ?? 200, checks: [] },
      },
    ],
    edges: [],
  })
}

test('策略归一化：默认并发 3、重试 0、failFast 关闭；非法值收敛到安全区间', async () => {
  const { normalizeStrategy, DEFAULT_STRATEGY } = await import('../src/suites/service.js')
  assert.deepEqual(normalizeStrategy(), DEFAULT_STRATEGY)
  assert.deepEqual(normalizeStrategy({ concurrency: 99, retry: -2, retryDelayMs: 999999, failFast: 'yes' }), {
    concurrency: 8,
    retry: 0,
    retryDelayMs: 60000,
    failFast: false,
  })
  assert.equal(normalizeStrategy({ failFast: true }).failFast, true)
  assert.equal(normalizeStrategy({ concurrency: 'abc' }).concurrency, 3)
})

test('套件校验：名称 / 项目 / 流程归属 / 环境归属 / 重名都有稳定错误码', async () => {
  const { store } = await import('../src/store.js')
  const service = await import('../src/suites/service.js')
  const project = store.saveProject({ name: '套件校验项目' })
  const other = store.saveProject({ name: '另一个项目' })
  const flow = makeFlow(store, '校验流程', `${stubBase}/api/echo`)
  const flow2 = makeFlow(store, '校验流程2', `${stubBase}/api/echo`)
  store.saveFlow({ ...flow, projectId: project.id })
  store.saveFlow({ ...flow2, projectId: project.id })
  const otherFlow = makeFlow(store, '别的流程', `${stubBase}/api/echo`)
  store.saveFlow({ ...otherFlow, projectId: other.id })

  const expectCode = (fn, code) =>
    assert.throws(fn, (err) => {
      assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}（${err.message}）`)
      return true
    })

  expectCode(() => service.createSuite({}), 'SUITE_BAD_NAME')
  expectCode(() => service.createSuite({ name: '空套件', flowIds: [] }), 'SUITE_EMPTY')
  expectCode(
    () => service.createSuite({ name: '坏流程', flowIds: ['ghost-flow'] }),
    'SUITE_FLOW_NOT_FOUND'
  )
  expectCode(
    () => service.createSuite({ name: '项目不符', projectId: project.id, flowIds: [otherFlow.id] }),
    'SUITE_FLOW_PROJECT_MISMATCH'
  )
  expectCode(
    () => service.createSuite({ name: '环境不符', projectId: project.id, flowIds: [flow.id], environmentId: 'ghost-env' }),
    'SUITE_ENV_NOT_FOUND'
  )

  const suite = service.createSuite({
    name: '  冒烟套件  ',
    projectId: project.id,
    flowIds: [flow.id, flow2.id],
    strategy: { concurrency: 2, retry: 1, failFast: true },
  })
  assert.equal(suite.name, '冒烟套件')
  assert.equal(suite.flowCount, 2)
  assert.deepEqual(suite.flowIds, [flow.id, flow2.id], '顺序必须保留')
  assert.deepEqual(suite.strategy, { concurrency: 2, retry: 1, retryDelayMs: 500, failFast: true })

  expectCode(() => service.createSuite({ name: '冒烟套件', projectId: project.id, flowIds: [flow.id] }), 'SUITE_NAME_CONFLICT')

  const updated = service.updateSuite(suite.id, { name: '冒烟套件 v2', flowIds: [flow.id] })
  assert.equal(updated.name, '冒烟套件 v2')
  assert.equal(updated.flowCount, 1)
  assert.equal(updated.strategy.retry, 1, '未传 strategy 时保留原策略')

  const detail = service.getSuiteDetail(suite.id)
  assert.equal(detail.flows.length, 1)
  assert.equal(detail.flows[0].exists, true)
  assert.deepEqual(detail.missingFlowIds, [])
  assert.deepEqual(detail.runs, [])

  store.deleteFlow(flow.id)
  assert.deepEqual(service.getSuiteDetail(suite.id).missingFlowIds, [flow.id], '被删流程要显式暴露')

  service.deleteSuite(suite.id)
  assert.equal(service.getSuite(suite.id), null)
  expectCode(() => service.deleteSuite(suite.id), 'SUITE_NOT_FOUND')
})

test('套件执行：并发受策略限制，变量域隔离，执行记录关联 suiteRunId', async () => {
  resetStub()
  const { store } = await import('../src/store.js')
  const service = await import('../src/suites/service.js')
  const { startSuiteRun } = await import('../src/suites/runner.js')

  const project = store.saveProject({ name: '并发项目' })
  const flows = ['A', 'B', 'C', 'D'].map((key, i) =>
    makeFlow(store, `并发-${key}`, `${stubBase}/api/echo?ms=150&token=${key}`, {
      variables: { token: key, index: i },
    })
  )
  const suite = service.createSuite({
    name: '并发套件',
    projectId: project.id,
    flowIds: flows.map((f) => f.id),
    strategy: { concurrency: 2, failFast: false },
  })

  const run = startSuiteRun({ suiteId: suite.id, io: fakeIo })
  const finished = await waitRun(run.id)

  assert.equal(finished.status, 'passed')
  assert.equal(finished.summary.total, 4)
  assert.equal(finished.summary.passed, 4)
  assert.equal(finished.summary.failed, 0)
  assert.equal(finished.summary.peakConcurrency, 2, '队列峰值必须等于策略并发')
  assert.equal(peak, 2, 'HTTP 层同时最多 2 个请求')

  const executions = store.listExecutionsBySuiteRun(run.id)
  assert.equal(executions.length, 4)
  assert.ok(executions.every((e) => e.suiteRunId === run.id))

  for (const flow of flows) {
    const exec = executions.find((e) => e.flowId === flow.id)
    assert.ok(exec, `流程 ${flow.name} 必须有执行记录`)
    const detail = store.getExecutionDetail(exec.id)
    assert.equal(detail.steps[0].actual.data.data.query.token, flow.variables.token, '每个会话变量独立')
    assert.equal(detail.suiteRunId, run.id)
  }
})

test('套件执行：失败重试后通过标记 flaky，每次尝试都是独立执行记录', async () => {
  resetStub()
  const { store } = await import('../src/store.js')
  const service = await import('../src/suites/service.js')
  const { startSuiteRun } = await import('../src/suites/runner.js')

  const flow = makeFlow(store, '偶发失败', `${stubBase}/api/flaky?key=retry&fail=2`)
  const suite = service.createSuite({
    name: '重试套件',
    flowIds: [flow.id],
    strategy: { concurrency: 1, retry: 2, retryDelayMs: 5 },
  })

  const run = startSuiteRun({ suiteId: suite.id, io: fakeIo })
  const finished = await waitRun(run.id)
  assert.equal(finished.status, 'passed')
  assert.equal(finished.summary.flaky, 1)
  const item = finished.summary.flows[0]
  assert.equal(item.attempts, 3)
  assert.equal(item.flaky, true)
  assert.equal(item.executionId, item.attemptExecutions.at(-1).executionId)

  const executions = store.listExecutionsBySuiteRun(run.id)
  assert.equal(executions.length, 3)
  assert.deepEqual(
    executions.map((e) => e.status),
    ['failed', 'failed', 'passed']
  )
})

test('套件执行：failFast 触发后未开始的流程统一 skipped，不再产生执行记录', async () => {
  resetStub()
  const { store } = await import('../src/store.js')
  const service = await import('../src/suites/service.js')
  const { startSuiteRun } = await import('../src/suites/runner.js')

  const fail = makeFlow(store, '失败流程', `${stubBase}/api/fail`, { status: 200 })
  const slow1 = makeFlow(store, '慢流程1', `${stubBase}/api/echo?ms=120`)
  const slow2 = makeFlow(store, '慢流程2', `${stubBase}/api/echo?ms=120`)
  const suite = service.createSuite({
    name: 'failFast 套件',
    flowIds: [fail.id, slow1.id, slow2.id],
    strategy: { concurrency: 1, failFast: true },
  })

  const run = startSuiteRun({ suiteId: suite.id, io: fakeIo })
  const finished = await waitRun(run.id)
  assert.equal(finished.status, 'failed')
  assert.equal(finished.summary.failed, 1)
  assert.equal(finished.summary.skipped, 2)
  assert.equal(finished.summary.flows[1].status, 'skipped')
  assert.match(finished.summary.flows[1].error, /failFast/)
  assert.equal(store.listExecutionsBySuiteRun(run.id).length, 1)
})

test('套件执行：停止时在跑的流程记 stopped，未开始的流程 skipped', async () => {
  resetStub()
  const { store } = await import('../src/store.js')
  const service = await import('../src/suites/service.js')
  const { startSuiteRun, stopSuiteRun } = await import('../src/suites/runner.js')

  const slow1 = makeFlow(store, '停止流程1', `${stubBase}/api/echo?ms=600`)
  const slow2 = makeFlow(store, '停止流程2', `${stubBase}/api/echo?ms=600`)
  const suite = service.createSuite({
    name: '停止套件',
    flowIds: [slow1.id, slow2.id],
    strategy: { concurrency: 1 },
  })

  const run = startSuiteRun({ suiteId: suite.id, io: fakeIo })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = store.getSuiteRun(run.id)
    if (current?.summary?.running === 1) break
    await sleep(20)
  }
  assert.equal(stopSuiteRun(run.id), true)
  const finished = await waitRun(run.id)
  assert.equal(finished.status, 'stopped')
  assert.equal(finished.summary.skipped, 1)
  assert.equal(finished.summary.flows[0].status, 'stopped')
  assert.equal(stopSuiteRun(run.id), false, '结束后再停止应返回 false')
})

test('套件 HTTP API：CRUD / 错误码 / 一键执行 / 历史 / 停止 / 删除', async () => {
  resetStub()
  const { createApp } = await import('../src/app.js')
  const { store } = await import('../src/store.js')
  const appCtx = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
  await new Promise((resolve) => appCtx.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${appCtx.server.address().port}`
  const auth = { authorization: `Bearer ${TOKEN}` }
  const json = async (res) => ({ status: res.status, body: await res.json() })
  const get = (p) => fetch(`${base}${p}`, { headers: auth }).then(json)
  const post = (p, body) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    }).then(json)
  const put = (p, body) =>
    fetch(`${base}${p}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    }).then(json)
  const del = (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: auth }).then(json)

  try {
    const project = store.saveProject({ name: '套件 API 项目' })
    const env = store.saveEnvironment({
      id: 'env-suite-api',
      projectId: project.id,
      name: '套件环境',
      baseUrl: stubBase,
      variables: { token: 'from-env' },
      headers: {},
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const flow1 = makeFlow(store, 'API 流程1', '/api/echo?token={{token}}')
    const flow2 = makeFlow(store, 'API 流程2', '/api/echo?token={{token}}')

    assert.equal((await post('/api/suites', { name: 'x', flowIds: [] })).body.code, 'SUITE_EMPTY')
    assert.equal((await post('/api/suites', { name: 'x', flowIds: ['ghost'] })).body.code, 'SUITE_FLOW_NOT_FOUND')

    const created = await post('/api/suites', {
      name: 'API 套件',
      projectId: project.id,
      flowIds: [flow1.id, flow2.id],
      environmentId: env.id,
      strategy: { concurrency: 2, retry: 1 },
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.flowCount, 2)
    assert.equal(created.body.strategy.concurrency, 2)
    const suiteId = created.body.id

    assert.equal((await post('/api/suites', { name: 'API 套件', projectId: project.id, flowIds: [flow1.id] })).body.code, 'SUITE_NAME_CONFLICT')
    assert.equal((await get('/api/suites?projectId=' + project.id)).body.length, 1)
    assert.equal((await get('/api/suites/ghost')).status, 404)

    const detail = await get(`/api/suites/${suiteId}`)
    assert.equal(detail.body.flows.length, 2)
    assert.deepEqual(detail.body.runs, [])

    const renamed = await put(`/api/suites/${suiteId}`, { name: 'API 套件 v2' })
    assert.equal(renamed.body.name, 'API 套件 v2')

    const started = await post(`/api/suites/${suiteId}/run`, {})
    assert.equal(started.status, 200)
    const suiteRunId = started.body.suiteRunId
    const finished = await waitRun(suiteRunId)
    assert.equal(finished.status, 'passed')

    const runDetail = await get(`/api/suite-runs/${suiteRunId}`)
    assert.equal(runDetail.body.executions.length, 2)
    assert.ok(runDetail.body.executions.every((e) => e.suiteRunId === suiteRunId))
    assert.equal(runDetail.body.executions[0].envId, env.id)
    assert.equal((await get(`/api/suite-runs?suiteId=${suiteId}`)).body.length, 1)
    assert.equal((await post(`/api/suite-runs/${suiteRunId}/stop`)).status, 409)

    // 删除套件：定义与历史一起删除，但执行记录保留
    assert.equal((await del(`/api/suites/${suiteId}`)).status, 200)
    assert.equal((await get(`/api/suites/${suiteId}`)).status, 404)
    assert.equal((await get(`/api/suite-runs?suiteId=${suiteId}`)).body.length, 0)
    assert.equal(store.listExecutionsBySuiteRun(suiteRunId).length, 2)
  } finally {
    await new Promise((resolve) => appCtx.io.close(resolve))
    await new Promise((resolve) => appCtx.server.close(resolve))
  }
})
