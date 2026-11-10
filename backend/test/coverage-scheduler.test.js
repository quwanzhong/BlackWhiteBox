import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在导入时固定数据目录，必须先设环境变量再动态导入 src 模块
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-coverage-engine-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'engine.db')
process.env.HEIBAIHE_TOKEN = 'coverage-engine-token-0123456789abcdef'

const { RunSession } = await import('../src/engine/scheduler.js')
const { getDefaultDatabase, closeDefaultDatabase } = await import('../src/infra/store/db.js')
const { createStore } = await import('../src/infra/store/index.js')

const ioStub = { to: () => ({ emit() {} }) }

after(() => {
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function startApi() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { path: req.url } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('调度器：覆盖率取证只包 HTTP 节点，证据写入步骤并广播 coverage.dump', async () => {
  const { server, port } = await startApi()
  const base = `http://127.0.0.1:${port}`
  const flow = {
    id: 'f-coverage',
    name: '覆盖率取证',
    type: 'whitebox',
    nodes: [
      {
        id: 'n1',
        name: '命中订单',
        action: { type: 'http', method: 'GET', url: `${base}/order`, headers: {} },
        expected: { status: 200, checks: [] },
      },
      {
        id: 'n2',
        name: '人工确认',
        action: { type: 'manual', hint: '看日志' },
        expected: { status: 200, checks: [] },
      },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', condition: '' }],
  }

  try {
    const calls = []
    const coverageCollector = {
      async begin(nodeId) {
        calls.push(`begin:${nodeId}`)
        return { nodeId, reset: true }
      },
      async end(nodeId) {
        calls.push(`end:${nodeId}`)
        return {
          id: `cov-${nodeId}`,
          nodeId,
          source: 'jacoco',
          mode: 'per-node',
          status: 'captured',
          bytes: 12,
          error: null,
          pending: true,
        }
      },
      async close() {
        calls.push('close')
      },
    }
    const session = new RunSession(flow, ioStub, { coverageCollector })
    // 人工节点会挂起：在它进入 waiting 后立即确认
    const running = session.start()
    const tick = setInterval(() => session.confirmManual('n2', true, '已核对'), 10)
    await running
    clearInterval(tick)
    await session.analysis

    // manual 节点不发 HTTP 请求，不做覆盖率取证
    assert.deepEqual(calls, ['begin:n1', 'end:n1', 'close'])
    assert.equal(session.steps.find((s) => s.nodeId === 'n1').coverageId, 'cov-n1')
    assert.equal(session.steps.find((s) => s.nodeId === 'n2').coverageId, undefined)

    const dumped = session.events.filter((e) => e.type === 'coverage.dump')
    assert.equal(dumped.length, 1)
    assert.equal(dumped[0].payload.nodeId, 'n1')
    assert.equal(dumped[0].payload.coverageId, 'cov-n1')
    assert.equal(dumped[0].payload.pending, true)

    const detail = createStore(getDefaultDatabase()).getExecutionDetail(session.executionId)
    assert.equal(detail.steps.find((s) => s.nodeId === 'n1').coverage.status, 'captured')
    assert.equal(detail.steps.find((s) => s.nodeId === 'n1').coverageId, 'cov-n1')
    // 未配置 classfiles：分析器不发 coverage.analyzed，行继续 pending
    assert.ok(!session.events.some((e) => e.type === 'coverage.analyzed'))
    assert.ok(!detail.events.some((e) => e.type === 'coverage.analyzed'))
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('调度器：采集器抛错也不影响节点结论', async () => {  const { server, port } = await startApi()
  try {
    const collector = {
      async begin() {
        throw new Error('boom-begin')
      },
      async end() {
        throw new Error('boom-end')
      },
      async close() {},
    }
    const session = new RunSession(
      {
        id: 'f-coverage-boom',
        name: '采集炸了',
        type: 'blackbox',
        nodes: [
          {
            id: 'n1',
            name: '正常请求',
            action: {
              type: 'http',
              method: 'GET',
              url: `http://127.0.0.1:${port}/ok`,
              headers: {},
            },
            expected: { status: 200, checks: [] },
          },
        ],
        edges: [],
      },
      ioStub,
      { coverageCollector: collector }
    )
    await session.start()
    await session.analysis
    assert.equal(session.status, 'passed')
    assert.equal(session.steps[0].coverageId, undefined)
    assert.ok(session.events.some((e) => String(e.payload.message).includes('boom-begin')))
    assert.ok(session.events.some((e) => String(e.payload.message).includes('boom-end')))
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('调度器：flow_end 后异步分析并补发 coverage.analyzed，不阻塞执行结论', async () => {
  const { server, port } = await startApi()
  const base = `http://127.0.0.1:${port}`
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let session
  let runs = 0
  const analyzer = {
    async run() {
      runs += 1
      await gate
      return {
        executionId: session.executionId,
        analyzed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        reason: null,
        durationMs: 7,
        results: [
          {
            coverageId: 'cov-n1',
            nodeId: 'n1',
            status: 'analyzed',
            covered: 2,
            missed: 1,
            total: 3,
            lineRate: 66.67,
            files: 1,
            classes: 1,
            error: null,
          },
        ],
      }
    },
  }
  const collector = {
    async begin(nodeId) {
      return { nodeId, reset: true }
    },
    async end(nodeId) {
      return {
        id: `cov-${nodeId}`,
        nodeId,
        source: 'jacoco',
        mode: 'per-node',
        status: 'captured',
        bytes: 12,
        error: null,
        pending: true,
      }
    },
    async close() {},
  }

  try {
    session = new RunSession(
      {
        id: 'f-coverage-analysis',
        name: '覆盖率分析',
        type: 'whitebox',
        nodes: [
          {
            id: 'n1',
            name: '命中订单',
            action: { type: 'http', method: 'GET', url: `${base}/order`, headers: {} },
            expected: { status: 200, checks: [] },
          },
        ],
        edges: [],
      },
      ioStub,
      { coverageCollector: collector, coverageAnalyzer: analyzer }
    )
    await session.start()
    // 分析还挂在 gate 上，执行结论与 flow_end 已经完成
    assert.equal(session.status, 'passed')
    assert.equal(runs, 1)
    assert.ok(!session.events.some((e) => e.type === 'coverage.analyzed'))
    assert.equal(session.events.at(-1).type, 'flow_end')
  } finally {
    release()
    await new Promise((r) => server.close(r))
  }

  const summary = await session.analysis
  assert.equal(summary.analyzed, 1)
  const event = session.events.find((e) => e.type === 'coverage.analyzed')
  assert.ok(event)
  assert.equal(event.seq, session.events.at(-1).seq)
  assert.deepEqual(
    {
      analyzed: event.payload.analyzed,
      failed: event.payload.failed,
      total: event.payload.total,
      nodeId: event.payload.coverage[0].nodeId,
      covered: event.payload.coverage[0].covered,
    },
    { analyzed: 1, failed: 0, total: 1, nodeId: 'n1', covered: 2 }
  )

  const detail = createStore(getDefaultDatabase()).getExecutionDetail(session.executionId)
  assert.equal(detail.events.at(-1).type, 'coverage.analyzed')
  assert.equal(detail.events.at(-1).payload.coverage[0].status, 'analyzed')
})
