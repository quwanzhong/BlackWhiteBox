import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// 必须在 import 任何 src 模块之前设置（config.js 加载时固定数据目录与库路径）
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-recovery-'))
const TOKEN = 'recovery-unit-token-0123456789abcdef'
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'recovery.db')
process.env.HEIBAIHE_TOKEN = TOKEN

const auth = { authorization: `Bearer ${TOKEN}` }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 捕获推送给 WS 的事件（按 room 分桶） */
function captureIo() {
  const byRoom = new Map()
  return {
    io: {
      to(room) {
        return {
          emit(event, payload) {
            if (event !== 'exec_event') return
            if (!byRoom.has(room)) byRoom.set(room, [])
            byRoom.get(room).push(payload)
          },
        }
      },
    },
    byRoom,
  }
}

/** 轮询直到条件成立；超时抛出带上下文的错误，避免测试挂死 */
async function waitFor(label, fn, { timeout = 10000, interval = 40 } = {}) {
  const startedAt = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - startedAt > timeout) throw new Error(`等待超时：${label}`)
    await sleep(interval)
  }
}

after(async () => {
  try {
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
  } catch {
    /* 未初始化则忽略 */
  }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------------------------------------------------------------- 共用夹具

function startStub() {
  const hits = new Map()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { path: url.pathname } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        hits: (p) => hits.get(p) || 0,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

/** 两个 HTTP 节点 + 一个 manual 节点：manual 用于把会话稳定停在节点边界 */
function manualFlow(base, id = 'flow-recovery') {
  return {
    id,
    name: '会话恢复流程',
    type: 'blackbox',
    projectId: 'p1',
    business: '订单',
    variables: { baseUrl: base },
    nodes: [
      {
        id: 'n1',
        name: '第一步',
        action: { type: 'http', method: 'GET', url: `${base}/first`, headers: {} },
        expected: { status: 200, checks: [] },
      },
      {
        id: 'n2',
        name: '人工确认',
        action: { type: 'manual', hint: '确认后继续' },
        expected: { status: 200, checks: [] },
      },
      {
        id: 'n3',
        name: '第三步',
        action: { type: 'http', method: 'GET', url: `${base}/third`, headers: {} },
        expected: { status: 200, checks: [] },
      },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', condition: '' },
      { id: 'e2', from: 'n2', to: 'n3', condition: '' },
    ],
  }
}

const stepStatus = (detail, nodeId) =>
  detail.steps.filter((s) => s.nodeId === nodeId).map((s) => s.status)

// ---------------------------------------------------------------- 1. 事件重放

test('事件重放：after/limit 语义稳定，seq 与 WS 同号，404 有 code', async () => {
  const { store } = await import('../src/store.js')
  const id = 'exec-events-1'
  store.saveExecutionMeta({ id, flowId: 'f1', status: 'running', startedAt: 1 })
  store.appendExecutionEvents(id, [
    { type: 'flow_start', ts: 1, payload: {} },
    { type: 'log', ts: 2, payload: { message: 'a' } },
    { type: 'log', ts: 3, payload: { message: 'b' } },
  ])

  const all = store.listExecutionEvents(id, { after: 0 })
  assert.equal(all.lastSeq, 3)
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3], 'seq 从 1 连续分配')
  assert.deepEqual(all.events.map((e) => e.v), [2, 2, 2], '信封统一带版本号')

  const tail = store.listExecutionEvents(id, { after: 1 })
  assert.deepEqual(tail.events.map((e) => e.seq), [2, 3], 'after 之后只返回增量（断线补洞）')

  const page = store.listExecutionEvents(id, { after: 0, limit: 2 })
  assert.deepEqual(page.events.map((e) => e.seq), [1, 2], 'limit 截断，lastSeq 仍是全局游标')
  assert.equal(page.lastSeq, 3)

  // 非法 after 归零、limit 夹紧，不抛错（前端枚举/游标落后时不应炸）
  assert.deepEqual(store.listExecutionEvents(id, { after: 'x' }).events.map((e) => e.seq), [1, 2, 3])
  assert.equal(store.listExecutionEvents(id, { limit: 1e9 }).events.length, 3)
  assert.equal(store.listExecutionEvents('missing', { after: 0 }), null)

  // 同一批事件也要带给 WS 的监听方：seq 必须与落库一致
  const captured = captureIo()
  const { RunSession } = await import('../src/engine/scheduler.js')
  const flow = {
    id: 'f-ws',
    name: '事件号一致性',
    type: 'blackbox',
    nodes: [
      {
        id: 'w1',
        name: '单步',
        action: { type: 'manual' },
        expected: { status: 200, checks: [] },
      },
    ],
    edges: [],
  }
  const session = new RunSession(flow, captured.io)
  const running = session.start()
  await waitFor('会话停在人工确认', () => session.manualWaiters.size > 0)
  session.confirmManual('w1', true, 'ok')
  await running

  const wsSeqs = captured.byRoom.get(`exec:${session.executionId}`).map((e) => e.seq)
  const rowSeqs = store
    .listExecutionEvents(session.executionId, { after: 0 })
    .events.map((e) => e.seq)
  assert.deepEqual(wsSeqs, rowSeqs, 'WebSocket 推送与落库必须同号，否则前端去重会丢事件')
  assert.deepEqual(rowSeqs, rowSeqs.map((_, i) => i + 1), '执行内 seq 严格自增')
})

// ---------------------------------------------------------------- 2. 断点续跑

test('会话恢复：进程重启后从节点边界续跑，已完成节点不重放', async () => {
  const stub = await startStub()
  try {
    const { store } = await import('../src/store.js')
    const { sessions } = await import('../src/engine/registry.js')
    const { restoreSessions } = await import('../src/engine/recovery.js')
    const { RunSession } = await import('../src/engine/scheduler.js')

    const first = captureIo()
    const sessionA = new RunSession(manualFlow(stub.base), first.io)
    // 原会话会一直悬在人工确认上（模拟崩溃前不再写库），因此不 await
    sessionA.start().catch(() => undefined)
    await waitFor('第一个会话停在人工确认', () => sessionA.manualWaiters.size > 0)
    const id = sessionA.executionId

    const before = store.getExecutionDetail(id)
    assert.equal(before.status, 'running')
    assert.deepEqual(stepStatus(before, 'n1'), ['passed'])
    assert.deepEqual(stepStatus(before, 'n2'), ['waiting'])
    assert.equal(stub.hits('/first'), 1)

    // 模拟进程崩溃：内存会话消失，库里仍是 running + waiting
    sessions.delete(id)

    const second = captureIo()
    const result = restoreSessions({ io: second.io })
    assert.ok(result.restored.includes(id), '未完成执行应被重建')
    const sessionB = sessions.get(id)
    assert.ok(sessionB, '重建后的会话要登记到 registry')
    assert.equal(sessionB.resumed, true)

    // 恢复后：中断的等待尝试记为 skipped 留证，同一节点重新执行
    await waitFor('恢复后的会话再次停在人工确认', () => sessionB.manualWaiters.size > 0)
    const interrupted = store.getExecutionDetail(id)
    assert.deepEqual(stepStatus(interrupted, 'n2'), ['skipped', 'waiting'], '中断的尝试保留为 skipped')
    assert.match(
      interrupted.steps.find((s) => s.status === 'skipped').error,
      /服务重启/,
      'skipped 步骤要写明原因'
    )

    sessionB.confirmManual('n2', true, '恢复后确认')
    await waitFor('恢复后的会话执行完毕', () => {
      const detail = store.getExecutionDetail(id)
      return detail.status === 'passed' ? detail : false
    })

    const final = store.getExecutionDetail(id)
    assert.deepEqual(stepStatus(final, 'n1'), ['passed'], '已完成节点不得重跑')
    assert.deepEqual(stepStatus(final, 'n2'), ['skipped', 'passed'])
    assert.deepEqual(stepStatus(final, 'n3'), ['passed'])
    assert.equal(stub.hits('/first'), 1, '第一步只应请求一次（断点续跑的核心断言）')
    assert.equal(stub.hits('/third'), 1)

    const types = final.events.map((e) => e.type)
    assert.equal(types.filter((t) => t === 'flow_start').length, 1, '恢复不重放开场事件')
    assert.equal(types.filter((t) => t === 'flow_resume').length, 1, '要有一条恢复标记')
    const seqs = final.events.map((e) => e.seq)
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '跨进程恢复后 seq 继续自增，不能重号')

    // 恢复事件同样推送给了 WS（房间号不变）
    assert.ok(
      second.byRoom.get(`exec:${id}`).some((e) => e.type === 'flow_resume'),
      '恢复标记要实时推给在线的页面'
    )
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------- 3. 暂停跨重启

test('会话恢复：暂停中的执行重启后仍为 paused，resume 后继续', async () => {
  const stub = await startStub()
  try {
    const { store } = await import('../src/store.js')
    const { sessions } = await import('../src/engine/registry.js')
    const { restoreSessions } = await import('../src/engine/recovery.js')
    const { RunSession } = await import('../src/engine/scheduler.js')

    const sessionA = new RunSession(manualFlow(stub.base, 'flow-paused'), captureIo().io)
    sessionA.start().catch(() => undefined) // 悬在人工确认上，不 await
    await waitFor('会话停在人工确认', () => sessionA.manualWaiters.size > 0)
    assert.equal(sessionA.pause(), true, '运行中应可暂停')
    const id = sessionA.executionId
    assert.equal(store.getExecutionDetail(id).status, 'paused')

    sessions.delete(id) // 模拟重启
    restoreSessions({ io: captureIo().io })
    const sessionB = sessions.get(id)
    assert.ok(sessionB)
    assert.equal(sessionB.status, 'paused', '恢复后保持暂停，不擅自继续执行')

    await sleep(300)
    assert.deepEqual(stepStatus(store.getExecutionDetail(id), 'n3'), [], '暂停期间不得推进到后续节点')
    assert.equal(stub.hits('/third'), 0)

    assert.equal(sessionB.resume(), true)
    await waitFor('恢复暂停后重新跑到人工确认', () => sessionB.manualWaiters.size > 0)
    sessionB.confirmManual('n2', true, '继续')
    await waitFor('暂停恢复后执行完毕', () => store.getExecutionDetail(id).status === 'passed')
    assert.equal(stub.hits('/first'), 1, '暂停恢复同样不重跑已完成节点')
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------- 4. 不可恢复

test('会话恢复：缺少流程快照时收敛为 stopped 并留证', async () => {
  const { store } = await import('../src/store.js')
  const { restoreSessions } = await import('../src/engine/recovery.js')
  const id = 'exec-unrecoverable'
  store.saveExecutionMeta({ id, flowId: 'gone', flowName: '流程已删除', status: 'running', startedAt: 1 })
  store.saveExecutionStep(id, { seq: 1, nodeId: 'n1', status: 'passed', durationMs: 3 })
  store.saveExecutionStep(id, { seq: 2, nodeId: 'n2', status: 'running', durationMs: null })

  const result = restoreSessions({ io: captureIo().io })
  assert.ok(result.unrecoverable.includes(id))

  const detail = store.getExecutionDetail(id)
  assert.equal(detail.status, 'stopped')
  assert.deepEqual(stepStatus(detail, 'n2'), ['skipped'])
  assert.match(detail.steps.find((s) => s.nodeId === 'n2').error, /无法恢复|服务重启/)
  assert.equal(detail.summary.passed, 1)
  assert.equal(detail.summary.skipped, 1)
  assert.equal(detail.summary.status, 'stopped')
})

// ---------------------------------------------------------------- 5. 套件收敛

test('会话恢复：未完成的套件运行收敛为 stopped，并写明原因', async () => {
  const { store } = await import('../src/store.js')
  const { restoreSessions } = await import('../src/engine/recovery.js')
  const suiteId = 'suite-interrupted'
  store.saveSuite({
    id: suiteId,
    name: '中断套件',
    flowIds: [],
    strategy: { concurrency: 1, retry: 0, retryDelayMs: 0, failFast: false },
  })
  store.saveSuiteRun({
    id: 'suite-run-interrupted',
    suiteId,
    suiteName: '中断套件',
    status: 'running',
    strategy: { concurrency: 1, retry: 0, retryDelayMs: 0, failFast: false },
    summary: { total: 2, passed: 1, failed: 0, skipped: 0 },
    startedAt: 1,
  })

  const result = restoreSessions({ io: captureIo().io })
  assert.equal(result.suiteRuns, 1)
  const run = store.getSuiteRun('suite-run-interrupted')
  assert.equal(run.status, 'stopped')
  assert.match(run.summary.message, /服务重启/)
  assert.ok(run.finishedAt, '收敛时必须补结束时间')
})

// ---------------------------------------------------------------- 6. S7 掩码

test('会话恢复：恢复快照里的环境 secret 已掩码，恢复后仍可用', async () => {
  const stub = await startStub()
  try {
    const { store } = await import('../src/store.js')
    const { getDefaultDatabase } = await import('../src/infra/store/db.js')
    const { RunSession } = await import('../src/engine/scheduler.js')

    const SECRET = 'sk-live-should-never-be-stored'
    const flow = manualFlow(stub.base, 'flow-secret')
    const session = new RunSession(flow, captureIo().io, {
      environment: {
        id: 'env-secret',
        name: '带密钥环境',
        version: 1,
        baseUrl: stub.base,
        headers: {},
        variables: { apiKey: SECRET },
        secretValues: [SECRET],
      },
    })
    const running = session.start()
    await waitFor('会话停在人工确认', () => session.manualWaiters.size > 0)

    const raw = getDefaultDatabase()
      .prepare('SELECT resume_json FROM executions WHERE id = ?')
      .get(session.executionId).resume_json
    assert.ok(raw, '节点边界必须写入恢复快照')
    assert.equal(raw.includes(SECRET), false, 'S7：secret 明文不得落库（含恢复快照）')
    assert.match(raw, /\*\*\*/, '快照里的 secret 应替换为掩码')

    // 恢复后环境重新解密：applyResume 只补回被掩码的环境 secret，不覆盖业务变量
    const resumed = new RunSession(flow, captureIo().io, {
      executionId: session.executionId,
      environment: {
        id: 'env-secret',
        name: '带密钥环境',
        version: 1,
        baseUrl: stub.base,
        headers: {},
        variables: { apiKey: SECRET },
        secretValues: [SECRET],
      },
      resume: {
        executed: ['n1'],
        ready: ['n2'],
        vars: store.getExecutionResume(session.executionId).resume.vars,
      },
    })
    assert.equal(resumed.vars.apiKey, SECRET, '恢复后环境 secret 要能重新解密使用')

    session.stop()
    await running.catch(() => undefined)
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------- 7. HTTP 接口

test('HTTP：GET /api/executions/:id/events 支持 after，缺失返回 404 与 code', async () => {
  const { store } = await import('../src/store.js')
  const id = 'exec-http-events'
  store.saveExecutionMeta({ id, flowId: 'f1', status: 'passed', startedAt: 1, finishedAt: 2 })
  store.appendExecutionEvents(id, [
    { type: 'flow_start', ts: 1, payload: {} },
    { type: 'flow_end', ts: 2, payload: { status: 'passed' } },
  ])

  const { createApp } = await import('../src/app.js')
  const ctx = createApp({ token: TOKEN, originPort: 3311, log: { error() {}, warn() {} } })
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  try {
    const all = await fetch(`${base}/api/executions/${id}/events`, { headers: auth }).then((r) => r.json())
    assert.equal(all.lastSeq, 2)
    assert.deepEqual(all.events.map((e) => e.seq), [1, 2])

    const tail = await fetch(`${base}/api/executions/${id}/events?after=1`, { headers: auth }).then((r) => r.json())
    assert.deepEqual(tail.events.map((e) => e.type), ['flow_end'])

    const missing = await fetch(`${base}/api/executions/nope/events`, { headers: auth })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).code, 'EXECUTION_NOT_FOUND')

    const unauthorized = await fetch(`${base}/api/executions/${id}/events`)
    assert.equal(unauthorized.status, 401)
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve))
  }
})
