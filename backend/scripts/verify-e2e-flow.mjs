/**
 * 端到端验收脚本：「流程真的能跑通吗」。
 *
 * 不 mock 执行引擎、不 mock 存储、不 mock WebSocket：
 *  - 起一个真实 HTTP 桩（登录 → 带 token 下单 → 回显），
 *  - 用 createApp() 起真实后端（真实端口 + token + SQLite 临时库），
 *  - 走真实 HTTP / Socket.IO 创建流程、执行、暂停/恢复/停止、人工确认，
 *  - 最后关掉服务再起一次，验证执行详情能从库里完整读回。
 *
 * 覆盖：变量提取与替换、断言通过/失败、条件分支跳过、事件实时推送与落库 seq 连续、
 *      步骤行 UPSERT 不重复、暂停/恢复、停止、人工确认、重启后可读。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-e2e-'))
const TOKEN = 'verify-e2e-token-0123456789abcdef'

process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'heibaihe.db')
process.env.HEIBAIHE_TOKEN = TOKEN

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
}

// ---------------------------------------------------------------- 接口桩
const STUB_DELAY = 100 // 给 WebSocket 订阅留出时间，模拟真实网络耗时
const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  await sleep(STUB_DELAY)
  if (url.pathname === '/login') {
    return send(200, { code: 0, data: { token: 'tok-abc', user: { id: 1, name: 'alice' } } })
  }
  if (url.pathname === '/orders') {
    const auth = String(req.headers.authorization || '')
    if (auth !== 'Bearer tok-abc') return send(401, { code: 401, data: null })
    return send(200, { code: 0, data: { orders: [{ id: 11, total: 99 }], count: 1, tokenEcho: auth.slice(7) } })
  }
  if (url.pathname === '/boom') return send(200, { code: 1, data: null })
  if (url.pathname === '/slow') {
    await sleep(Number(url.searchParams.get('ms') || 500))
    return send(200, { code: 0, data: { ok: true } })
  }
  if (url.pathname === '/echo') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    return send(201, {
      code: 0,
      data: { method: req.method, body: raw ? JSON.parse(raw) : null, contentType: req.headers['content-type'] },
    })
  }
  send(404, { code: 404 })
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const stubBase = `http://127.0.0.1:${stub.address().port}`

// ---------------------------------------------------------------- 真实后端
const { createApp } = await import('../src/app.js')
const { getDefaultDatabase, closeDefaultDatabase } = await import('../src/infra/store/db.js')
const appCtx = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
await new Promise((resolve) => appCtx.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${appCtx.server.address().port}`
const auth = { authorization: `Bearer ${TOKEN}` }

const get = (p) => fetch(`${base}${p}`, { headers: auth })
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body ?? {}),
  })

// ---------------------------------------------------------------- WebSocket
const requireHere = createRequire(import.meta.url)
const { io: clientIO } = requireHere('socket.io-client')
const ws = clientIO(base, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000)
  ws.on('connect', () => {
    clearTimeout(timer)
    resolve()
  })
  ws.on('connect_error', (err) => {
    clearTimeout(timer)
    reject(new Error(`WebSocket 连接失败：${err.message}`))
  })
})
const wsEvents = []
const waiters = []
let stage = 'init'
ws.on('exec_event', (evt) => {
  wsEvents.push(evt)
  for (const w of [...waiters]) {
    if (w.predicate(evt)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(evt)
    }
  }
})
function waitWs(predicate, timeoutMs = 15000) {
  const existing = wsEvents.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve }
    waiters.push(waiter)
    setTimeout(() => {
      const i = waiters.indexOf(waiter)
      if (i >= 0) waiters.splice(i, 1)
      reject(
        new Error(
          `等待 WebSocket 事件超时（阶段=${stage}，已收 ${wsEvents.length} 条：` +
            `${wsEvents.map((e) => e.type).join(',') || '无'}）`
        )
      )
    }, timeoutMs)
  })
}

// ---------------------------------------------------------------- 工具
const node = (id, name, action, expected = { status: 200, checks: [] }, extra = {}) => ({
  id,
  name,
  action,
  input: null,
  expected,
  extract: extra.extract || {},
  position: { x: 80, y: 80 },
})
const edge = (from, to, condition = '') => ({ id: `e_${from}_${to}`, from, to, condition })

async function createFlow(payload) {
  const res = await post('/api/flows', payload)
  return { status: res.status, flow: await res.json() }
}

async function run(flowId, body = {}) {
  const res = await post(`/api/flows/${flowId}/run`, body)
  const { executionId } = await res.json()
  stage = `执行 ${flowId}（HTTP ${res.status}）`
  ws.emit('join', { room: `exec:${executionId}` })
  return { status: res.status, executionId }
}

/** 轮询直到执行结束且 flow_end 已落库（避免和事件攒批赛跑） */
async function waitDone(executionId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = await (await get(`/api/executions/${executionId}`)).json()
    const finished = ['passed', 'failed', 'stopped'].includes(detail.status)
    const ended = (detail.events || []).some((e) => e.type === 'flow_end')
    if (finished && ended) return detail
    await sleep(60)
  }
  throw new Error(`执行未在 ${timeoutMs} ms 内结束：${executionId}`)
}

/** 轮询执行详情（比等 WebSocket 稳：订阅建立前发出的事件不会重放） */
async function waitDetail(executionId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = await (await get(`/api/executions/${executionId}`)).json()
    if (predicate(detail)) return detail
    await sleep(50)
  }
  throw new Error(`等待执行详情条件超时：${executionId}`)
}

/** 前者的类型序列必须是后者的有序子序列 */
function isSubsequence(short, full) {
  let i = 0
  for (const t of full) {
    if (i < short.length && short[i] === t) i += 1
  }
  return i === short.length
}

const stepOf = (detail, nodeId) => detail.steps.find((s) => s.nodeId === nodeId)
const typesOf = (events) => events.map((e) => e.type)

// ================================================================ A. 主链路
const flowA = {
  name: 'E2E 主链路：登录 → 带 token 下单 → 回显',
  type: 'blackbox',
  variables: { greet: 'hi' },
  nodes: [
    node(
      'n1',
      '登录',
      { type: 'http', method: 'GET', url: `${stubBase}/login` },
      {
        status: 200,
        checks: [
          { label: '业务码', path: '$.code', op: 'eq', value: 0 },
          { label: '用户名', path: '$.data.user.name', op: 'eq', value: 'alice' },
        ],
      },
      { extract: { token: '$.data.token' } }
    ),
    node(
      'n2',
      '查询订单',
      { type: 'http', method: 'GET', url: `${stubBase}/orders`, headers: { authorization: 'Bearer {{token}}' } },
      {
        status: 200,
        maxDurationMs: 5000,
        checks: [
          { label: '订单数', path: '$.data.count', op: 'eq', value: 1 },
          { label: '回显 token', path: '$.data.tokenEcho', op: 'eq', value: 'tok-abc' },
          { label: '订单是数组', path: '$.data.orders', op: 'type', value: 'array' },
          { label: '响应体含订单号', type: 'body_contains', value: '"id":11' },
        ],
      }
    ),
    node(
      'n3',
      '回显请求体',
      {
        type: 'http',
        method: 'POST',
        url: `${stubBase}/echo`,
        body: { hello: '{{token}}', greet: '{{greet}}' },
      },
      {
        status: 201,
        checks: [
          { label: '回显变量', path: '$.data.body.hello', op: 'eq', value: 'tok-abc' },
          { label: '方法', path: '$.data.method', op: 'eq', value: 'POST' },
        ],
      }
    ),
  ],
  edges: [edge('n1', 'n2'), edge('n2', 'n3', '$.code == 0')],
}
const createdA = await createFlow(flowA)
const runA = await run(createdA.flow.id)
check('A1 创建流程 → 返回 3 个节点', createdA.status === 200 && createdA.flow.nodes?.length === 3)
check('A2 执行入口 → 返回 executionId', runA.status === 200 && typeof runA.executionId === 'string')
await waitWs((e) => e.executionId === runA.executionId && e.type === 'flow_end')
const detailA = await waitDone(runA.executionId)

check(
  'A3 主链路执行结果 = passed（3/3 通过）',
  detailA.status === 'passed' &&
    detailA.steps.length === 3 &&
    detailA.steps.every((s) => s.status === 'passed'),
  `status=${detailA.status} steps=${detailA.steps.map((s) => s.status).join(',')}`
)
check(
  'A4 断言全部匹配 matchedAll=true',
  detailA.summary?.matchedAll === true && detailA.summary.passed === 3 && detailA.summary.failed === 0,
  `matchedAll=${detailA.summary?.matchedAll}`
)
check(
  'A5 变量提取 token=tok-abc（来自 n1 响应）',
  stepOf(detailA, 'n1')?.extracted?.token === 'tok-abc' && detailA.vars?.token === 'tok-abc',
  `extracted=${JSON.stringify(stepOf(detailA, 'n1')?.extracted)}`
)
check(
  'A6 变量替换生效 {{token}} → 请求头 Bearer tok-abc',
  stepOf(detailA, 'n2')?.request?.headers?.authorization === 'Bearer tok-abc' &&
    stepOf(detailA, 'n2')?.checks?.results?.find((c) => c.label === '回显 token')?.passed === true,
  `header=${stepOf(detailA, 'n2')?.request?.headers?.authorization}`
)
check(
  'A7 请求体变量替换 + 201 状态码判定',
  stepOf(detailA, 'n3')?.request?.body?.hello === 'tok-abc' &&
    stepOf(detailA, 'n3')?.request?.body?.greet === 'hi' &&
    stepOf(detailA, 'n3')?.actual?.status === 201
)
const checksA = detailA.steps.flatMap((s) => s.checks?.results || [])
check(
  'A8 断言明细完整（3 个节点共 12 条：3 状态码 + 8 自定义 + 1 耗时）',
  checksA.length === 12 && checksA.every((c) => c.passed),
  `${checksA.length} 条`
)
const typesA = typesOf(detailA.events)
check(
  'A9 事件流：flow_start / step_start×3 / step_end×3 / flow_end 齐全',
  typesA.filter((t) => t === 'flow_start').length === 1 &&
    typesA.filter((t) => t === 'step_start').length === 3 &&
    typesA.filter((t) => t === 'step_end').length === 3 &&
    typesA.filter((t) => t === 'flow_end').length === 1,
  `events=${typesA.length}`
)
const wsA = wsEvents.filter((e) => e.executionId === runA.executionId)
check(
  'A10 WebSocket 实时推送：step_end×3 + flow_end（含 checks/actual 供 UI 展示）',
  wsA.filter((e) => e.type === 'step_end').length === 3 &&
    wsA.some((e) => e.type === 'flow_end') &&
    wsA.filter((e) => e.type === 'step_end').every((e) => e.payload?.checks && e.payload?.actual),
  `ws=${wsA.length} 条`
)
check(
  'A11 WS 事件顺序与落库顺序一致（有序子序列）',
  isSubsequence(wsA.map((e) => e.type), typesA),
  `ws=${wsA.length} / 落库=${typesA.length}`
)

// ---------------------------------------------------------------- 落库检查
const db = getDefaultDatabase()
const rowsA = db
  .prepare('SELECT seq, status FROM execution_steps WHERE execution_id = ? ORDER BY seq')
  .all(runA.executionId)
const actualSeqA = db
  .prepare('SELECT seq FROM execution_events WHERE execution_id = ? ORDER BY seq')
  .all(runA.executionId)
  .map((r) => r.seq)
check(
  'A12 步骤行：3 行（同一步骤 UPSERT 不追加），seq 1..3',
  rowsA.length === 3 && rowsA.every((r, i) => r.seq === i + 1),
  `${rowsA.length} 行`
)
check(
  'A13 事件行：seq 严格连续 1..N（断线重放基础）',
  actualSeqA.length > 0 && actualSeqA.every((s, i) => s === i + 1),
  `events=${actualSeqA.length}`
)
check(
  'A14 执行上下文落库：nodes=3 / vars.token 可读',
  detailA.nodes?.length === 3 && detailA.vars?.token === 'tok-abc'
)

const listRes = await fetch(`${base}/api/executions?flowId=${createdA.flow.id}`, { headers: auth })
const list = await listRes.json()
check(
  'A15 执行列表按 flowId 过滤且不回传 steps',
  listRes.status === 200 && list.length === 1 && list[0].steps === undefined,
  `${list.length} 条`
)
const stats = await (await get('/api/stats')).json()
check(
  'A16 统计接口已反映本次执行',
  stats.execTotal === list.length && stats.flowTotal === 1,
  `exec=${stats.execTotal}`
)

// ================================================================ B. 断言失败
const createdB = await createFlow({
  name: 'E2E 断言失败',
  nodes: [node('b1', '断言必失败', { type: 'http', method: 'GET', url: `${stubBase}/boom` },
    { status: 200, checks: [{ label: '业务码', path: '$.code', op: 'eq', value: 0 }] })],
  edges: [],
})
const runB = await run(createdB.flow.id)
await waitWs((e) => e.executionId === runB.executionId && e.type === 'flow_end')
const detailB = await waitDone(runB.executionId)
const failedCheckB = detailB.steps[0]?.checks?.results?.find((c) => !c.passed)
check(
  'B1 断言不一致 → 执行 failed，failed=1',
  detailB.status === 'failed' && detailB.summary?.failed === 1 && detailB.steps[0]?.status === 'failed',
  `status=${detailB.status} failed=${detailB.summary?.failed}`
)
check(
  'B2 失败文案可读（期望/实际）',
  /期望 等于 0，实际 1/.test(failedCheckB?.message || ''),
  failedCheckB?.message
)
check(
  'B3 汇总文案点明不一致',
  /存在 1 个未通过步骤/.test(detailB.summary?.message || ''),
  detailB.summary?.message
)

// ================================================================ C. 分支跳过
const createdC = await createFlow({
  name: 'E2E 分支跳过',
  nodes: [
    node('c1', '业务失败', { type: 'http', method: 'GET', url: `${stubBase}/boom` },
      { status: 200, checks: [{ path: '$.code', op: 'eq', value: 1 }] }),
    node('c2', '不该执行', { type: 'http', method: 'GET', url: `${stubBase}/orders` }),
  ],
  edges: [edge('c1', 'c2', '$.code == 0')],
})
const runC = await run(createdC.flow.id)
await waitWs((e) => e.executionId === runC.executionId && e.type === 'flow_end')
const detailC = await waitDone(runC.executionId)
check(
  'C1 条件不满足 → 下游节点 skipped，整体仍 passed',
  detailC.status === 'passed' &&
    detailC.summary?.skipped === 1 &&
    stepOf(detailC, 'c2')?.status === 'skipped',
  `skipped=${detailC.summary?.skipped}`
)
check(
  'C2 跳过事件进入事件流 + warn 日志',
  detailC.events.some((e) => e.type === 'step_end' && e.payload?.status === 'skipped') &&
    detailC.events.some((e) => e.type === 'log' && e.payload?.level === 'warn')
)

// ================================================================ D. 人工确认（白盒）
const createdD = await createFlow({
  name: 'E2E 白盒人工确认',
  type: 'whitebox',
  nodes: [node('d1', '人工核对 Service', { type: 'manual', hint: '确认 Service 是否被调用' })],
  edges: [],
})
const runD = await run(createdD.flow.id)
// manual_wait 在 run 响应返回前就可能已发出，WS 不重放；用库里的 waiting 状态判断
await waitDetail(runD.executionId, (d) => d.steps[0]?.status === 'waiting')
const confirmRes = await post(`/api/executions/${runD.executionId}/manual`, {
  nodeId: 'd1',
  pass: true,
  note: '已核对调用链',
})
const confirmBody = await confirmRes.json()
const detailD = await waitDone(runD.executionId)
check(
  'D1 人工步骤先 waiting，确认后才结束',
  confirmRes.status === 200 && confirmBody.ok === true &&
    detailD.steps[0]?.actual?.manual === true && detailD.steps[0]?.actual?.confirmed === true,
  `ok=${confirmBody.ok}`
)
check(
  'D2 人工确认结果参与最终判定（passed + 人工确认断言）',
  detailD.status === 'passed' &&
    detailD.steps[0]?.checks?.results?.[0]?.type === 'manual' &&
    detailD.steps[0]?.checks?.matched === true
)

// ================================================================ E. 暂停 / 恢复
const createdE = await createFlow({
  name: 'E2E 暂停恢复',
  nodes: [
    node('e1', '慢接口 1', { type: 'http', method: 'GET', url: `${stubBase}/slow?ms=400` }),
    node('e2', '慢接口 2', { type: 'http', method: 'GET', url: `${stubBase}/slow?ms=400` }),
  ],
  edges: [edge('e1', 'e2')],
})
const runE = await run(createdE.flow.id)
await waitDetail(runE.executionId, (d) => d.steps.some((s) => s.status === 'running'))
const pauseRes = await post(`/api/executions/${runE.executionId}/pause`, {})
const pauseBody = await pauseRes.json()
const pausedDetail = await waitDetail(runE.executionId, (d) => d.status === 'paused')
await sleep(150)
const resumeRes = await post(`/api/executions/${runE.executionId}/resume`, {})
const resumeBody = await resumeRes.json()
const detailE = await waitDone(runE.executionId)
check(
  'E1 暂停生效（status=paused + paused 事件）',
  pauseBody.ok === true && pausedDetail.status === 'paused' &&
    detailE.events.some((e) => e.type === 'paused'),
  `status=${pausedDetail.status}`
)
check(
  'E2 恢复后继续跑完并 passed',
  resumeBody.ok === true &&
    detailE.status === 'passed' &&
    detailE.steps.filter((s) => s.status === 'passed').length === 2 &&
    detailE.events.some((e) => e.type === 'resumed')
)

// ================================================================ F. 停止
const createdF = await createFlow({
  name: 'E2E 手动停止',
  nodes: [
    node('f1', '慢接口 1', { type: 'http', method: 'GET', url: `${stubBase}/slow?ms=300` }),
    node('f2', '慢接口 2', { type: 'http', method: 'GET', url: `${stubBase}/slow?ms=300` }),
    node('f3', '慢接口 3', { type: 'http', method: 'GET', url: `${stubBase}/slow?ms=300` }),
  ],
  edges: [edge('f1', 'f2'), edge('f2', 'f3')],
})
const runF = await run(createdF.flow.id)
await waitDetail(runF.executionId, (d) => d.steps.some((s) => s.status === 'running'))
const stopRes = await post(`/api/executions/${runF.executionId}/stop`, {})
const stopBody = await stopRes.json()
const detailF = await waitDone(runF.executionId)
check(
  'F1 停止 → status=stopped + 汇总文案',
  stopBody.ok === true && detailF.status === 'stopped' &&
    /手动停止/.test(detailF.summary?.message || ''),
  `status=${detailF.status}`
)
check(
  'F2 未执行节点标记 skipped（不伪造通过）',
  detailF.summary?.skipped >= 1 &&
    detailF.steps.filter((s) => s.status === 'skipped').length === detailF.summary.skipped,
  `skipped=${detailF.summary?.skipped}`
)

// ================================================================ G. 重启后仍可读
const beforeRestart = {
  steps: detailA.steps.length,
  events: detailA.events.length,
  seq: actualSeqA.length,
}
await new Promise((resolve) => appCtx.io.close(resolve))
await new Promise((resolve) => appCtx.server.close(resolve))
closeDefaultDatabase()
ws.close()

// 真正的进程重启：子进程重新打开同一个库、重新起服务
const probeOut = execFileSync(process.execPath, [path.join(HERE, 'probe-restart.mjs'), runA.executionId], {
  env: process.env,
  encoding: 'utf8',
})
const probe = JSON.parse(probeOut.trim().split(/\r?\n/).pop())
const reopened = probe.detail

check(
  'G1 重启后执行详情完整可读（steps/events/vars 均来自库）',
  probe.detailStatus === 200 &&
    reopened.steps?.length === beforeRestart.steps &&
    reopened.events?.length === beforeRestart.events &&
    reopened.vars?.token === 'tok-abc' &&
    reopened.status === 'passed',
  `status=${probe.detailStatus} steps=${reopened.steps?.length}/${beforeRestart.steps} events=${reopened.events?.length}/${beforeRestart.events}`
)
check('G2 重启后执行列表包含全部 6 次执行', probe.listCount === 6, `${probe.listCount} 条`)
check(
  'G3 重启后旧会话不在内存 → 控制接口明确报错（不静默成功）',
  probe.pauseStatus === 400 && /执行会话不存在/.test(probe.pauseError),
  `status=${probe.pauseStatus}`
)

// ---------------------------------------------------------------- 汇总
console.log('\n结论')
console.log('-'.repeat(78))
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
}
console.log('-'.repeat(78))
console.log(
  `结论：${failed === 0 ? '全部通过' : `${failed} 项失败`}` +
    `（${results.length} 项检查；6 次执行；流程 A 落库 ${beforeRestart.steps} 步 / ${beforeRestart.seq} 事件）`
)

await new Promise((resolve) => stub.close(resolve))
fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
process.exit(failed === 0 ? 0 : 1)
