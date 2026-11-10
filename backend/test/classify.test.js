import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// 必须在 import 任何 src 模块之前设置：config.js 加载时就固定数据目录与库路径。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-classify-'))
const TOKEN = 'classify-unit-token-0123456789abcdef'
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'classify.db')
process.env.HEIBAIHE_TOKEN = TOKEN

const auth = { authorization: `Bearer ${TOKEN}` }
const ioStub = { to: () => ({ emit() {} }) }
let realExecutionId = null

after(async () => {
  try {
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
  } catch {
    /* 未初始化则忽略 */
  }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------- 1. 规则本身：8 类可解释、优先级稳定 ----------

test('归类：8 类枚举与中文标签一一对应', async () => {
  const { FAILURE_CLASSES, FAILURE_CLASS_LABELS } = await import('../src/reporting/classify.js')
  assert.equal(FAILURE_CLASSES.length, 8)
  for (const cls of FAILURE_CLASSES) {
    assert.ok(FAILURE_CLASS_LABELS[cls], `${cls} 缺少展示标签`)
  }
  // 前端 constants/failure.ts 与这里必须是同一组键：这里锁死顺序，防止两端漂移
  assert.deepEqual(FAILURE_CLASSES, [
    'network',
    'timeout',
    'status',
    'schema',
    'assertion',
    'dependency',
    'script',
    'manual_reject',
  ])
})

test('归类：通过/执行中的步骤不产生归类，8 类证据各自命中', async () => {
  const { classifyStep } = await import('../src/reporting/classify.js')

  assert.equal(classifyStep(null), null)
  assert.equal(classifyStep({ status: 'passed' }), null)
  assert.equal(classifyStep({ status: 'running' }), null)

  const failed = (patch) => classifyStep({ status: 'failed', ...patch })
  const failedCheck = (check) =>
    failed({ checks: { matched: false, results: [{ type: 'json_path', passed: false, ...check }] } })

  assert.equal(failed({ error: 'connect ECONNREFUSED 127.0.0.1:9' }).failureClass, 'network')
  assert.equal(failed({ error: 'getaddrinfo ENOTFOUND api.example.com' }).failureClass, 'network')
  assert.equal(failed({ error: 'socket hang up' }).failureClass, 'network')
  assert.equal(failed({ error: 'timeout of 15000ms exceeded' }).failureClass, 'timeout')
  assert.equal(failedCheck({ type: 'status', message: '期望 eq 200，实际 500' }).failureClass, 'status')
  assert.equal(failedCheck({ type: 'schema', message: 'data.id 必填' }).failureClass, 'schema')
  assert.equal(failedCheck({ type: 'body_contains' }).failureClass, 'assertion')
  assert.equal(failedCheck({ type: 'json_path' }).failureClass, 'assertion')
  assert.equal(failedCheck({ type: 'duration' }).failureClass, 'timeout')
  assert.equal(failedCheck({ type: 'manual' }).failureClass, 'manual_reject', 'check 类型为 manual 也要归人工驳回')
  assert.match(
    failed({
      checks: {
        matched: false,
        results: [{ type: 'json_path', label: '金额', passed: false, op: 'eq', value: 100, actual: 99 }],
      },
    }).failureReason,
    /期望 eq 100，实际 99/,
    '没有 message 时要用 op/期望/实际生成可解释原因'
  )
  assert.equal(
    classifyStep({ status: 'skipped', error: '前置节点失败' }).failureClass,
    'dependency'
  )
  assert.equal(classifyStep({ status: 'skipped' }).failureClass, 'dependency')
  assert.equal(failed({ error: '不支持的节点执行类型：grpc' }).failureClass, 'script')
  assert.equal(failed({ error: '变量未解析：http://x/{{id}}' }).failureClass, 'script')
  assert.equal(
    classifyStep({
      status: 'failed',
      actual: { manual: true, confirmed: false, note: '返回的金额不对' },
    }).failureClass,
    'manual_reject'
  )
  assert.equal(
    classifyStep({
      status: 'failed',
      actual: { manual: true, confirmed: false, note: '返回的金额不对' },
      checks: { results: [{ type: 'manual', passed: false, message: '人工不通过' }] },
      error: '人工确认不通过',
    }).failureClass,
    'manual_reject',
    '人工驳回优先于错误文本'
  )
})

test('归类：超时先于网络判定（ECONNABORTED 也含 CONN 字样）', async () => {
  const { classifyStep } = await import('../src/reporting/classify.js')
  const r = classifyStep({
    status: 'failed',
    error: 'timeout of 1000ms exceeded (ECONNABORTED ECONNREFUSED)',
  })
  assert.equal(r.failureClass, 'timeout', 'axios 超时会同时带 ECONNABORTED，不能被网络规则抢走')
  assert.match(r.failureReason, /timeout/)
})

test('归类：执行级聚合取首个失败类别 + 全量计数，跳过只在未通过执行中计依赖', async () => {
  const { classifyExecution } = await import('../src/reporting/classify.js')
  const steps = [
    { status: 'passed' },
    { status: 'failed', error: 'timeout of 15000ms exceeded' },
    { status: 'failed', checks: { results: [{ type: 'status', passed: false, message: '500' }] } },
    { status: 'skipped' },
  ]

  const failedRun = classifyExecution(steps, { status: 'failed' })
  assert.equal(failedRun.failureClass, 'timeout', '首个失败步骤决定主归类')
  assert.equal(failedRun.failureReason, 'timeout of 15000ms exceeded')
  assert.equal(failedRun.counts.timeout, 1)
  assert.equal(failedRun.counts.status, 1)
  assert.equal(failedRun.counts.dependency, 1)
  assert.equal(failedRun.counts.passed, undefined, '计数只覆盖 8 类失败')

  const passedRun = classifyExecution(steps, { status: 'passed' })
  assert.equal(passedRun.failureClass, 'timeout', '通过执行里若真有 failed 步骤仍要暴露（数据异常可解释）')
  assert.equal(passedRun.counts.dependency, 0, '通过/停止执行的 skipped 不算依赖失败')

  assert.equal(classifyExecution([{ status: 'skipped' }], { status: 'stopped' }).failureClass, null)
  assert.deepEqual(classifyExecution([], {}).counts.network, 0)
})

test('归类：老执行详情读取时补齐，幂等且不覆盖已有归类', async () => {
  const { enrichExecutionDetail } = await import('../src/reporting/classify.js')
  const detail = {
    status: 'failed',
    steps: [
      { nodeId: 'n1', status: 'failed', error: 'read ECONNRESET' },
      { nodeId: 'n2', status: 'skipped' },
      { nodeId: 'n3', status: 'failed', error: 'x', failureClass: 'assertion', failureReason: '已有结论' },
    ],
  }

  enrichExecutionDetail(detail)
  assert.equal(detail.steps[0].failureClass, 'network')
  assert.match(detail.steps[0].failureReason, /ECONNRESET/)
  assert.equal(detail.steps[1].failureClass, 'dependency')
  assert.equal(detail.steps[2].failureClass, 'assertion', '已落库的归类必须保留')
  assert.equal(detail.steps[2].failureReason, '已有结论')
  assert.equal(detail.failureClass, 'network')
  assert.equal(detail.failureClasses.network, 1)
  assert.equal(detail.failureClasses.dependency, 1)

  const snapshot = JSON.parse(JSON.stringify(detail))
  enrichExecutionDetail(detail)
  assert.deepEqual(detail, snapshot, '重复调用结果必须一致')

  assert.equal(enrichExecutionDetail(null), null)
  assert.equal(enrichExecutionDetail({ status: 'passed' }).steps, undefined)
})

// ---------- 2. 真实执行：归类随步骤/执行落库，事件与套件结果同步 ----------

test('调度器：失败步骤写入归类投影，执行汇总与 step_end 事件一致', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bad')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0 }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const { RunSession } = await import('../src/engine/scheduler.js')
    const { store } = await import('../src/store.js')
    const flow = store.saveFlow({
      name: '归类落库',
      type: 'blackbox',
      nodes: [
        {
          id: 'n1',
          name: '返回 500',
          action: { type: 'http', method: 'GET', url: `${base}/bad` },
          expected: { status: 200, checks: [] },
        },
        {
          id: 'n2',
          name: '依赖节点',
          action: { type: 'http', method: 'GET', url: `${base}/ok` },
          expected: { status: 200, checks: [] },
        },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    })

    const session = new RunSession(flow, ioStub)
    await session.start()
    realExecutionId = session.executionId

    assert.equal(session.status, 'failed')
    assert.equal(session.summary.failureClass, 'status')
    assert.equal(session.summary.failureClasses.status, 1)
    assert.equal(session.summary.failureClasses.dependency, 1)
    assert.equal(session.steps[0].failureClass, 'status')
    assert.equal(session.steps[1].failureClass, 'dependency')

    const stepEnd = session.events.find(
      (e) => e.type === 'step_end' && e.payload.nodeId === 'n1'
    )
    assert.equal(stepEnd.payload.failureClass, 'status', '实时事件要直接带归类')

    const detail = store.getExecutionDetail(session.executionId)
    assert.equal(detail.failureClass, 'status')
    assert.equal(detail.failureReason, detail.steps[0].failureReason)
    assert.equal(detail.steps[0].failureClass, 'status')
    assert.equal(detail.steps[1].failureClass, 'dependency')

    // 列表投影列（不解 JSON）与按归类过滤
    const listed = store.listExecutions().find((e) => e.id === session.executionId)
    assert.equal(listed.failureClass, 'status')
    assert.deepEqual(
      store.listExecutionsByFailureClass('status').map((e) => e.id),
      [session.executionId]
    )
    assert.equal(store.listExecutionsByFailureClass('network').length, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---------- 3. API：老数据按需补齐后参与筛选 ----------

test('API：?failureClass 过滤对新老执行都生效，详情补齐且不写库', async () => {
  const { store } = await import('../src/store.js')
  store.saveExecutionMeta({
    id: 'legacy-network',
    flowId: 'f-legacy',
    flowName: 'M1 时代执行',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    summary: { status: 'failed', total: 2, passed: 0, failed: 1, skipped: 1 },
  })
  store.saveExecutionStep('legacy-network', {
    seq: 1,
    nodeId: 'n1',
    nodeName: '老步骤',
    status: 'failed',
    error: 'connect ECONNREFUSED 127.0.0.1:9',
  })
  store.saveExecutionStep('legacy-network', {
    seq: 2,
    nodeId: 'n2',
    nodeName: '依赖步骤',
    status: 'skipped',
  })

  const { createApp } = await import('../src/app.js')
  const appCtx = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
  await new Promise((resolve) => appCtx.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${appCtx.server.address().port}`
  const get = (p) => fetch(`${base}${p}`, { headers: auth }).then((r) => r.json())

  try {
    const network = await get('/api/executions?failureClass=network')
    assert.deepEqual(network.map((e) => e.id), ['legacy-network'], '老数据要现算归类后命中')
    assert.equal(network[0].failureClass, 'network')

    const status = await get('/api/executions?failureClass=status')
    assert.deepEqual(status.map((e) => e.id), [realExecutionId])

    const detail = await get('/api/executions/legacy-network')
    assert.equal(detail.failureClass, 'network')
    assert.equal(detail.steps[0].failureClass, 'network')
    assert.equal(detail.steps[1].failureClass, 'dependency')
    assert.equal(detail.failureClasses.dependency, 1)

    // 读取时补齐不得回写：投影列仍为空，列表接口按需现算时才补进响应
    const row = store.listExecutions().find((e) => e.id === 'legacy-network')
    assert.equal(row.failureClass, null)
    const raw = await get('/api/executions')
    assert.ok(raw.length >= 2)
    assert.equal((await get('/api/executions?failureClass=bogus')).length, raw.length, '非法归类当作未过滤')

    const newDetail = await get(`/api/executions/${realExecutionId}`)
    assert.equal(newDetail.failureClass, 'status')
    assert.deepEqual(newDetail.failureClasses, {
      network: 0,
      timeout: 0,
      status: 1,
      schema: 0,
      assertion: 0,
      dependency: 1,
      script: 0,
      manual_reject: 0,
    })
  } finally {
    await new Promise((resolve) => appCtx.io.close(resolve))
    if (appCtx.server.listening) await new Promise((resolve) => appCtx.server.close(resolve))
  }
})
