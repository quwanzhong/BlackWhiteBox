import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 必须在 import 任何 src 模块之前设置：config.js 在加载时就固定数据目录与库路径。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-control-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'control.db')

const ioStub = { to: () => ({ emit() {} }) }

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function manualFlow(id, hint) {
  return {
    id,
    name: '人工确认流程',
    type: 'whitebox',
    projectId: 'p-control',
    nodes: [
      {
        id: 'm1',
        name: '人工核对库存',
        action: hint ? { type: 'manual', hint } : { type: 'manual' },
      },
    ],
    edges: [],
  }
}

test('调度器：人工步骤等待确认，通过后记录 actual/checks 与提示语', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const session = new RunSession(manualFlow('f-manual-pass'), ioStub)

  const running = session.start()
  await waitFor(() => session.manualWaiters.has('m1'))

  assert.equal(session.steps[0].status, 'waiting')
  const waitEvent = session.events.find((e) => e.type === 'manual_wait')
  assert.equal(waitEvent.payload.hint, '请人工确认该步骤的执行结果')

  assert.equal(session.confirmManual('m1', true, '已核对'), true)
  // 同一个节点重复确认不应生效
  assert.equal(session.confirmManual('m1', true), false)
  await running

  assert.equal(session.status, 'passed')
  assert.equal(session.steps[0].status, 'passed')
  assert.deepEqual(session.steps[0].actual, { manual: true, confirmed: true, note: '已核对' })
  assert.equal(session.steps[0].checks.matched, true)
  assert.match(session.steps[0].checks.results[0].message, /人工确认通过/)
  assert.equal(session.summary.matchedAll, true)
})

test('调度器：人工确认不通过时步骤失败并保留备注', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const session = new RunSession(manualFlow('f-manual-fail', '检查返回码'), ioStub)

  const running = session.start()
  await waitFor(() => session.manualWaiters.has('m1'))
  assert.equal(session.events.find((e) => e.type === 'manual_wait').payload.hint, '检查返回码')

  session.confirmManual('m1', false, '截图不一致')
  await running

  assert.equal(session.status, 'failed')
  assert.equal(session.steps[0].status, 'failed')
  assert.equal(session.steps[0].checks.matched, false)
  assert.match(session.steps[0].checks.results[0].message, /截图不一致/)
  assert.equal(session.summary.failed, 1)
})

test('调度器：暂停 / 恢复 / 停止的状态机与事件', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const session = new RunSession(manualFlow('f-stop'), ioStub)

  const running = session.start()
  await waitFor(() => session.manualWaiters.has('m1'))

  assert.equal(session.pause(), true)
  assert.equal(session.pause(), false, '重复暂停无效')
  assert.equal(session.status, 'paused')
  assert.equal(session.resume(), true)
  assert.equal(session.resume(), false, '未暂停时恢复无效')
  assert.equal(session.status, 'running')

  assert.equal(session.pause(), true)
  assert.equal(session.stop(), true)
  assert.equal(session.stop(), false, '已停止后再次停止无效')
  await running

  assert.equal(session.status, 'stopped')
  assert.equal(session.stopped, true)
  assert.equal(session.steps[0].status, 'failed')
  assert.equal(session.steps[0].actual.note, '执行已手动停止')
  assert.equal(session.summary.message, '执行被手动停止')
  assert.ok(session.events.some((e) => e.type === 'paused'))
  assert.ok(session.events.some((e) => e.type === 'resumed'))
  assert.ok(session.events.some((e) => e.type === 'stopped'))
})

test('调度器：空流程只记录错误并结束', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const session = new RunSession(
    { id: 'f-empty', name: '空流程', type: 'blackbox', nodes: [], edges: [] },
    ioStub
  )
  await session.start()

  assert.equal(session.stopped, true)
  assert.equal(session.summary.total, 0)
  const logs = session.events.filter((e) => e.type === 'log').map((e) => e.payload.message)
  assert.ok(logs.some((m) => m.includes('流程没有节点')))
})

test('调度器：环状图回退到首节点，异常节点记为 failed 并继续统计', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0 }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const flow = {
      id: 'f-cycle',
      name: '环状流程',
      type: 'blackbox',
      nodes: [
        { id: 'n1', name: '节点一', action: { type: 'http', method: 'GET', url: `${base}/one` }, expected: { status: 200 } },
        { id: 'n2', name: '节点二', action: { type: 'http', method: 'GET', url: `${base}/two` }, expected: { status: 200 } },
        { id: 'n3', name: '不支持的节点', action: { type: 'sql' } },
      ],
      // n1/n2 互相成环：没有任何无入边节点，应回退到 nodes[0]
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n1' },
        { id: 'e3', from: 'n2', to: 'n3' },
      ],
    }
    const session = new RunSession(flow, ioStub)
    await session.start()

    assert.deepEqual(
      session.steps.map((s) => [s.nodeId, s.status]),
      [
        ['n1', 'passed'],
        ['n2', 'passed'],
        ['n3', 'failed'],
      ]
    )
    assert.match(session.steps[2].error, /不支持的节点执行类型：sql/)
    assert.equal(session.summary.passed, 2)
    assert.equal(session.summary.failed, 1)
    assert.equal(session.status, 'failed')

    // 未知节点直接返回 false
    const standalone = new RunSession(flow, ioStub)
    assert.equal(await standalone.runNode('missing'), false)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('调度器：事件攒批达到 20 条立即落库，不足 20 条由定时器刷盘', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const session = new RunSession(
    { id: 'f-flush', name: '事件攒批', type: 'blackbox', nodes: [], edges: [] },
    ioStub
  )

  for (let i = 0; i < 20; i++) session.emit('log', { level: 'info', message: `m${i}` })
  assert.equal(session.pendingEvents.length, 0, '满 20 条应立即刷盘')

  session.emit('log', { level: 'info', message: 'last' })
  assert.equal(session.pendingEvents.length, 1)
  await new Promise((r) => setTimeout(r, 260))
  assert.equal(session.pendingEvents.length, 0, '定时器应在 200ms 后刷盘')
})

test('调度器：manual_wait 广播瞬间点确认也不丢（waiter 先于广播注册）', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  let session = null
  let accepted = null
  const immediateConfirm = {
    to: () => ({
      emit: (_name, evt) => {
        if (evt?.type === 'manual_wait') {
          // 模拟用户/前端在收到推送的同一刻点「确认」：此时 waiter 必须已注册
          accepted = session.confirmManual(evt.payload.nodeId, true, '秒点确认')
        }
      },
    }),
  }

  session = new RunSession(manualFlow('f-manual-race'), immediateConfirm)
  await session.start()

  assert.equal(accepted, true, '广播时刻的确认必须被接收，而不是静默返回 false')
  assert.equal(session.status, 'passed')
  assert.equal(session.steps[0].actual.confirmed, true)
  assert.equal(session.steps[0].actual.note, '秒点确认')
})

test('调度器：步骤通过但输出不匹配时 summary 给出对应文案', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const session = new RunSession(
    { id: 'f-summary', name: '摘要', type: 'blackbox', nodes: [], edges: [] },
    ioStub
  )
  session.steps.push({ status: 'passed', checks: { matched: false } })
  session.finish()

  assert.equal(session.summary.matchedAll, false)
  assert.equal(session.summary.message, '步骤执行通过，但存在输出不匹配项')
  assert.equal(session.status, 'passed')
})

test.after(async () => {
  // 会话共享默认连接，先关闭再删目录（Windows 下否则 EBUSY）
  const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
