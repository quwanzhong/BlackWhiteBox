import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在导入时固定数据目录，必须先设环境变量再动态导入 src 模块
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-coverage-assertions-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'assertions.db')
process.env.HEIBAIHE_TOKEN = 'coverage-assertions-token-0123456789abcdef'

const {
  parseCoverageTarget,
  coverageSpecOf,
  hasCoverageAssertions,
  evaluateCoverageAssertions,
} = await import('../src/coverage/assertions.js')
const { RunSession } = await import('../src/engine/scheduler.js')
const { getDefaultDatabase, closeDefaultDatabase } = await import('../src/infra/store/db.js')
const { createStore } = await import('../src/infra/store/index.js')

const ioStub = { to: () => ({ emit() {} }) }

after(() => {
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------------------------------------------------------------- 纯函数

test('parseCoverageTarget：类 / 方法 / 构造器 / 内部类都接受，非法目标返回 null', () => {
  assert.deepEqual(parseCoverageTarget('com.demo.OrderService'), {
    className: 'com.demo.OrderService',
    methodName: null,
    kind: 'class',
  })
  assert.deepEqual(parseCoverageTarget(' com/demo/OrderService#create '), {
    className: 'com.demo.OrderService',
    methodName: 'create',
    kind: 'method',
  })
  assert.equal(parseCoverageTarget('com.demo.OrderService#<init>').methodName, '<init>')
  assert.equal(parseCoverageTarget('com.demo.Outer$Inner#run').className, 'com.demo.Outer$Inner')

  for (const bad of ['', '   ', '#create', 'com.demo.Service#', 'com demo.Service', 'com..Service', 'com.demo.Service#a b', 'com.demo.Service#create#x', null, 42]) {
    assert.equal(parseCoverageTarget(bad), null, `应拒绝：${JSON.stringify(bad)}`)
  }
})

test('coverageSpecOf / hasCoverageAssertions：去空行、去重、保序，非法 shape 视为未声明', () => {
  const expected = {
    coverage: {
      mustHit: [' A#x ', 'B', 'A#x', '', null],
      mustMiss: ['C#y'],
    },
  }
  assert.deepEqual(coverageSpecOf(expected), {
    mustHit: ['A#x', 'B'],
    mustMiss: ['C#y'],
  })
  assert.equal(hasCoverageAssertions(expected), true)
  assert.equal(hasCoverageAssertions({}), false)
  assert.equal(hasCoverageAssertions({ coverage: { mustHit: [] } }), false)
  assert.deepEqual(coverageSpecOf({ coverage: ['A'] }), { mustHit: [], mustMiss: [] })
  assert.deepEqual(coverageSpecOf(null), { mustHit: [], mustMiss: [] })
})

const RESULT = {
  files: [],
  classes: [
    {
      name: 'com.demo.OrderService',
      covered: 4,
      missed: 1,
      total: 5,
      methods: [
        { name: 'create', covered: 3, missed: 0, total: 3 },
        { name: '<init>', covered: 1, missed: 1, total: 2 },
      ],
    },
    {
      name: 'com.demo.OrderRepository',
      covered: 2,
      missed: 0,
      total: 2,
      methods: [
        { name: 'insert', covered: 1, missed: 0, total: 1 },
        { name: 'insert', covered: 1, missed: 0, total: 1 },
        { name: 'bindCoupon', covered: 0, missed: 2, total: 2 },
      ],
    },
  ],
  totals: { files: 0, classes: 2, covered: 6, missed: 1, total: 7, lineRate: 85.71 },
}
const ANALYZED = { status: 'analyzed', error: null, result: RESULT }

test('evaluateCoverageAssertions：未声明断言不产生 check', () => {
  assert.deepEqual(evaluateCoverageAssertions({}, ANALYZED), [])
  assert.deepEqual(evaluateCoverageAssertions({ coverage: { mustHit: [] } }, null), [])
})

test('evaluateCoverageAssertions：mustHit 命中通过，未命中 / 报告缺失都失败且归类为断言', () => {
  const hit = evaluateCoverageAssertions(
    { coverage: { mustHit: ['com.demo.OrderService', 'com.demo.OrderService#create'] } },
    ANALYZED
  )
  assert.equal(hit.length, 2)
  assert.ok(hit.every((c) => c.passed && c.type === 'coverage'))

  const zero = evaluateCoverageAssertions(
    { coverage: { mustHit: ['com.demo.OrderRepository#bindCoupon'] } },
    ANALYZED
  )
  assert.equal(zero[0].passed, false)
  assert.equal(zero[0].type, 'coverage')
  assert.match(zero[0].message, /期望命中.*covered 0\/2/)

  const missing = evaluateCoverageAssertions(
    { coverage: { mustHit: ['com.demo.PaymentClient#refund'] } },
    ANALYZED
  )
  assert.equal(missing[0].passed, false)
  assert.match(missing[0].message, /报告里没有该方法/)
})

test('evaluateCoverageAssertions：mustMiss 未命中通过，命中失败；方法级按重载聚合', () => {
  const ok = evaluateCoverageAssertions(
    { coverage: { mustMiss: ['com.demo.OrderRepository#bindCoupon', 'com.demo.Missing#x'] } },
    ANALYZED
  )
  assert.equal(ok.length, 2)
  assert.ok(ok.every((c) => c.passed && c.type === 'coverage'))

  const violated = evaluateCoverageAssertions(
    { coverage: { mustMiss: ['com.demo.OrderService#create'] } },
    ANALYZED
  )
  assert.equal(violated[0].passed, false)
  assert.match(violated[0].message, /期望不命中.*covered 3\/3/)

  // 两个 insert 重载合计 covered 2 => mustHit 通过、mustMiss 失败
  const hit = evaluateCoverageAssertions({ coverage: { mustHit: ['com.demo.OrderRepository#insert'] } }, ANALYZED)
  assert.equal(hit[0].passed, true)
  assert.match(hit[0].message, /2 个重载合计/)
  const miss = evaluateCoverageAssertions({ coverage: { mustMiss: ['com.demo.OrderRepository#insert'] } }, ANALYZED)
  assert.equal(miss[0].passed, false)
})

test('evaluateCoverageAssertions：证据不可用一律失败，type=coverage_evidence（不静默通过）', () => {
  const expected = { coverage: { mustHit: ['com.demo.OrderService'] } }
  for (const analysis of [
    null,
    { status: 'disabled' },
    { status: 'pending' },
    { status: 'analysis_failed', error: 'COVERAGE_ANALYZE_FAILED: boom' },
    { status: 'unavailable', error: 'COVERAGE_AGENT_UNREACHABLE: x' },
    { status: 'skipped' },
  ]) {
    const checks = evaluateCoverageAssertions(expected, analysis)
    assert.equal(checks.length, 1, JSON.stringify(analysis))
    assert.equal(checks[0].passed, false)
    assert.equal(checks[0].type, 'coverage_evidence')
  }
  const pending = evaluateCoverageAssertions(expected, { status: 'pending' })
  assert.match(pending[0].message, /classfiles/)
})

test('evaluateCoverageAssertions：非法目标报配置错误；全非法时不再叠加证据错误', () => {
  const checks = evaluateCoverageAssertions(
    { coverage: { mustHit: ['com demo OrderService'] } },
    ANALYZED
  )
  assert.equal(checks.length, 1)
  assert.equal(checks[0].type, 'coverage_evidence')
  assert.match(checks[0].message, /不合法/)

  const mixed = evaluateCoverageAssertions(
    { coverage: { mustHit: ['com.demo.OrderService', 'com demo OrderService'] } },
    ANALYZED
  )
  assert.equal(mixed.length, 2)
  assert.equal(mixed.find((c) => c.type === 'coverage')?.passed, true)
  assert.equal(mixed.find((c) => c.type === 'coverage_evidence')?.passed, false)
})

// ---------------------------------------------------------------- 调度集成（真实 HTTP + 真实 SQLite）

function startApi() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { path: req.url } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function httpNode(id, coverage) {
  return {
    id,
    name: `节点 ${id}`,
    action: { type: 'http', method: 'GET', url: 'http://127.0.0.1:PORT/ok', headers: {} },
    expected: { status: 200, checks: [], ...(coverage ? { coverage } : {}) },
  }
}

function fakeCollector(prefix = 'cov') {
  return {
    async begin() {},
    async end(nodeId) {
      return {
        id: `${prefix}-${nodeId}`,
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
}

function fakeAnalyzer(outcome) {
  const calls = { analyze: [], run: [] }
  const analyzer = {
    async analyzeOne(id) {
      calls.analyze.push(id)
      return typeof outcome === 'function' ? outcome(id) : outcome
    },
    async run(opts) {
      calls.run.push(opts)
      return {
        executionId: 'x',
        analyzed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        reason: 'NO_PENDING_EVIDENCE',
        durationMs: 0,
        results: [],
      }
    },
  }
  return { analyzer, calls }
}

async function runFlow({ nodes, analyzer, collector = fakeCollector(), manual = null }) {
  const { server, port } = await startApi()
  const resolved = nodes.map((n) => ({
    ...n,
    action: {
      ...n.action,
      url: String(n.action?.url || '').replace('PORT', String(port)),
    },
  }))
  const session = new RunSession(
    { id: `f-${Math.random().toString(16).slice(2)}`, name: '白盒断言', type: 'whitebox', nodes: resolved, edges: [] },
    ioStub,
    { coverageCollector: collector, coverageAnalyzer: analyzer }
  )
  let timer = null
  try {
    const running = session.start()
    if (manual) {
      let confirmed = false
      timer = setInterval(() => {
        if (confirmed || !session.steps.some((s) => s.status === 'waiting')) return
        confirmed = true
        session.confirmManual(manual.nodeId, manual.pass, manual.note)
      }, 10)
    }
    await running
    await session.analysis
    return { session, port }
  } finally {
    if (timer) clearInterval(timer)
    await new Promise((resolve) => server.close(resolve))
  }
}

test('调度集成：mustHit 命中 → passed，记录同步分析并跳过异步重跑', async () => {
  const { analyzer, calls } = fakeAnalyzer(ANALYZED)
  const { session } = await runFlow({
    nodes: [httpNode('n1', { mustHit: ['com.demo.OrderService#create'] })],
    analyzer,
  })

  const step = session.steps[0]
  assert.equal(step.status, 'passed')
  assert.equal(step.failureClass ?? null, null)
  assert.ok(step.checks.results.find((c) => c.type === 'coverage')?.passed)
  assert.deepEqual(calls.analyze, ['cov-n1'])
  assert.ok(calls.run.at(-1).skipIds.has('cov-n1'))
})

test('调度集成：mustHit 未命中 → failed + failureClass=assertion', async () => {
  const { analyzer, calls } = fakeAnalyzer(ANALYZED)
  const { session } = await runFlow({
    nodes: [httpNode('n1', { mustHit: ['com.demo.OrderRepository#bindCoupon'] })],
    analyzer,
  })

  const step = session.steps[0]
  assert.equal(step.status, 'failed')
  assert.equal(step.failureClass, 'assertion')
  assert.match(step.failureReason, /期望命中/)
  assert.deepEqual(calls.analyze, ['cov-n1'])
  // 同步分析过的行交给异步 run 时被跳过，避免「结论失败但徽标变已分析」
  assert.ok(calls.run.at(-1).skipIds.has('cov-n1'))
  assert.ok(session.events.some((e) => e.type === 'coverage.analyzed' && e.payload.coverage[0].nodeId === 'n1'))
  const detail = createStore(getDefaultDatabase()).getExecutionDetail(session.executionId)
  assert.equal(detail.status, 'failed')
  assert.equal(detail.steps[0].failureClass, 'assertion')
})

test('调度集成：mustMiss 命中 → failed；未命中 → passed', async () => {
  const first = await runFlow({
    nodes: [httpNode('n1', { mustMiss: ['com.demo.OrderService#create'] })],
    analyzer: fakeAnalyzer(ANALYZED).analyzer,
  })
  assert.equal(first.session.steps[0].status, 'failed')
  assert.equal(first.session.steps[0].failureClass, 'assertion')
  assert.match(first.session.steps[0].failureReason, /期望不命中/)

  const second = await runFlow({
    nodes: [httpNode('n1', { mustMiss: ['com.demo.OrderRepository#bindCoupon'] })],
    analyzer: fakeAnalyzer(ANALYZED).analyzer,
  })
  assert.equal(second.session.steps[0].status, 'passed')
})

test('调度集成：有断言但无 classfiles（pending）→ failed + failureClass=script，证据仍保留', async () => {
  const pending = { status: 'pending', reason: 'CLASSFILES_NOT_CONFIGURED', error: null, result: null }
  const { analyzer, calls } = fakeAnalyzer(pending)
  const { session } = await runFlow({
    nodes: [httpNode('n1', { mustHit: ['com.demo.OrderService'] })],
    analyzer,
  })

  const step = session.steps[0]
  assert.equal(step.status, 'failed')
  assert.equal(step.failureClass, 'script')
  assert.ok(step.checks.results.find((c) => c.type === 'coverage_evidence' && !c.passed))
  // pending 不写入 syncedCoverage（异步 run 本来也会因缺 classfiles 跳过）
  assert.equal(calls.run.at(-1).skipIds.has('cov-n1'), false)
  // pending 不伪装成已分析：不发 analyzed 事件
  assert.ok(!session.events.some((e) => e.type === 'coverage.analyzed'))
})

test('调度集成：analyzeOne 抛错也收敛为失败，不带崩执行', async () => {
  const analyzer = fakeAnalyzer(() => {
    throw new Error('analyzer exploded')
  }).analyzer
  const { session } = await runFlow({
    nodes: [httpNode('n1', { mustHit: ['com.demo.OrderService'] })],
    analyzer,
  })
  assert.equal(session.steps[0].status, 'failed')
  assert.equal(session.steps[0].failureClass, 'script')
  assert.match(session.steps[0].failureReason, /analyzer exploded/)
})

test('调度集成：manual 节点声明覆盖率断言 → 明确失败（不支持即不通过）', async () => {
  const { session } = await runFlow({
    nodes: [
      {
        id: 'm1',
        name: '人工确认',
        action: { type: 'manual', hint: '看日志' },
        expected: { coverage: { mustHit: ['com.demo.OrderService#create'] } },
      },
    ],
    analyzer: fakeAnalyzer(ANALYZED).analyzer,
    manual: { nodeId: 'm1', pass: true, note: '人工通过' },
  })

  const step = session.steps[0]
  assert.equal(step.status, 'failed')
  assert.equal(step.failureClass, 'script')
  assert.match(step.checks.results.find((c) => c.type === 'coverage_evidence').message, /人工节点不支持覆盖率断言/)
})

test('调度集成：未声明断言的节点不触发同步分析，保持异步路径', async () => {
  const { analyzer, calls } = fakeAnalyzer(ANALYZED)
  const { session } = await runFlow({
    nodes: [httpNode('n1', null)],
    analyzer,
  })
  assert.equal(session.steps[0].status, 'passed')
  assert.deepEqual(calls.analyze, [])
  assert.equal(calls.run.at(-1).skipIds.size, 0)
})

