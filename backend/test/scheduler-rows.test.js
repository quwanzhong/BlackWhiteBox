import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 必须在 import 任何 src 模块之前设置：config.js 在加载时就固定数据目录与库路径。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-engine-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'engine.db')

const ioStub = { to: () => ({ emit() {} }) }

function startApi() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { id: 42, path: req.url } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('调度器：步骤按行写入、事件 seq 连续、跳过节点落库、详情可从行表还原', async () => {
  const { server, port } = await startApi()
  const { RunSession } = await import('../src/engine/scheduler.js')
  const { getDefaultDatabase } = await import('../src/infra/store/db.js')
  const { createStore } = await import('../src/infra/store/index.js')

  const base = `http://127.0.0.1:${port}`
  const flow = {
    id: 'f-engine',
    name: '引擎行写入',
    type: 'blackbox',
    projectId: 'p1',
    business: '订单',
    variables: { baseUrl: base },
    nodes: [
      {
        id: 'n1',
        name: '查询订单',
        action: { type: 'http', method: 'GET', url: `${base}/order`, headers: {} },
        expected: { status: 200, checks: [] },
        extract: { orderId: '$.data.id' },
      },
      {
        id: 'n2',
        name: '使用提取变量',
        action: { type: 'http', method: 'GET', url: `${base}/order/{{orderId}}`, headers: {} },
        expected: { status: 200, checks: [] },
      },
      {
        id: 'n3',
        name: '条件不满足的节点',
        action: { type: 'http', method: 'GET', url: `${base}/never`, headers: {} },
        expected: { status: 200, checks: [] },
      },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', condition: '' },
      { id: 'e2', from: 'n2', to: 'n3', condition: '$.code == 999' },
    ],
  }

  try {
    const session = new RunSession(flow, ioStub)
    await session.start()

    const db = getDefaultDatabase()
    const store = createStore(db)
    const id = session.executionId

    // 1) 执行结果
    assert.equal(session.status, 'passed')
    assert.deepEqual(
      {
        total: session.summary.total,
        passed: session.summary.passed,
        failed: session.summary.failed,
        skipped: session.summary.skipped,
      },
      { total: 3, passed: 2, failed: 0, skipped: 1 }
    )

    // 2) execution_steps：3 行（状态更新是 UPSERT，不会多出行），顺序按 seq
    const rows = db
      .prepare('SELECT seq, node_id, status, data_json FROM execution_steps WHERE execution_id = ? ORDER BY seq')
      .all(id)
    assert.deepEqual(
      rows.map((r) => [r.seq, r.node_id, r.status]),
      [
        [1, 'n1', 'passed'],
        [2, 'n2', 'passed'],
        [3, 'n3', 'skipped'],
      ]
    )
    const n1 = JSON.parse(rows[0].data_json)
    assert.equal(n1.request.url, `${base}/order`)
    assert.equal(n1.actual.status, 200)
    assert.equal(n1.checks.matched, true)
    assert.equal(JSON.parse(rows[1].data_json).request.url, `${base}/order/42`, '提取变量应参与后续节点 URL 替换')

    // 3) execution_events：落库条数与内存一致，seq 从 1 连续
    const evts = db
      .prepare('SELECT seq, type FROM execution_events WHERE execution_id = ? ORDER BY seq')
      .all(id)
    assert.equal(evts.length, session.events.length, 'finish() 必须把攒批事件全部刷盘')
    assert.deepEqual(
      evts.map((e) => e.seq),
      evts.map((_, i) => i + 1)
    )
    assert.ok(evts.some((e) => e.type === 'flow_start'))
    assert.ok(evts.some((e) => e.type === 'flow_end'))

    // 4) 行表组装出的详情 == 会话内存中的详情（seq 不泄漏；headers 等类实例按 JSON 归一化后比较）
    assert.deepEqual(store.getExecutionDetail(id), JSON.parse(JSON.stringify(session.detail())))
    assert.equal(store.getExecutionDetail(id).vars.orderId, 42, '响应提取的变量要在结束时落库')

    // 5) 列表只读 meta
    const listed = store.listExecutions().find((e) => e.id === id)
    assert.equal(listed.status, 'passed')
    assert.equal(listed.flowName, '引擎行写入')
    assert.equal(listed.steps, undefined)

    // 6) 再次打开同一个库：行数据仍在，且不会被重复回填
    db.close()
    const { openDatabase } = await import('../src/infra/store/db.js')
    const reopened = openDatabase(process.env.HEIBAIHE_DB)
    try {
      assert.equal(createStore(reopened).getExecutionDetail(id).steps.length, 3)
    } finally {
      reopened.close()
    }
  } finally {
    await new Promise((r) => server.close(r))
    // Windows 上刚关闭的 WAL 文件偶发 EBUSY，用退避重试兜住
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('调度器条件表达式：注入不执行，正常条件与变量可用', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const fake = {
    vars: { x: 1 },
    last: { data: { code: 0 } },
    logs: [],
    log(message) {
      this.logs.push(message)
    },
  }
  const evalCondition = RunSession.prototype.evalCondition

  assert.equal(evalCondition.call(fake, '$.code == 0'), true)
  assert.equal(evalCondition.call(fake, '$.code == 1'), false)
  assert.equal(evalCondition.call(fake, '{{x}} == 1'), true)
  // new Function 时代这段会直接退出进程；现在只是一个解析失败 + warn 日志
  assert.equal(evalCondition.call(fake, 'process.exit()'), false)
  assert.ok(fake.logs.some((m) => String(m).includes('条件表达式解析失败')))
})
