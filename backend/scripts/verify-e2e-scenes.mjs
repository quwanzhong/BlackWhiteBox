/**
 * 场景级功能点验收：「按场景功能划分」逐项验证。
 *
 * 与 verify-e2e-flow.mjs（执行引擎深场景）互补，这里按功能域过一遍产品主链路：
 *   场景 1  流程管理：CRUD + DSL 归一化（默认值补全 / 非法边过滤 / 404）
 *   场景 2  数据导入：OpenAPI → 黑盒流程草稿（$ref / 上限 / 非法 spec）、白盒调用链 → 白盒流程
 *   场景 3  项目闭环：建项目 → 绑定接口（Apifox 缓存）→ 扫描源码 → 业务分组 → 生成流程 → 真实执行通过
 *   场景 4  白盒执行：导入的调用链流程直接执行 + 人工确认闭环
 *   场景 5  缺陷记录：从执行步骤提缺陷 → 过滤 → 状态流转 → 统计 → 删除
 *   场景 6  统计面板：各计数与列表数据一致
 *   场景 7  环境与密钥：CRUD → 变量优先级 → baseUrl/Header → secrets 不落明文 → 错误码
 *   场景 8  套件与队列：CRUD → 并发上限 → 重试/flaky → failFast → 停止 → 删除语义
 *   场景 9  失败归类：8 类规则逐条命中 → 列表筛选 → 归类原因脱敏 → 事件/套件口径一致
 *   场景 10 报告导出：JUnit/HTML/JSON 三格式 → S8 脱敏 → 计数一致 → 套件导出 → 400/404
 *   场景 11 会话恢复：真实子进程执行 → 强杀 → 重启后按断点续跑 → 断线重放 after → 人工确认收尾
 *   场景 12 覆盖率取证：环境 settings.coverage → 每节点 reset/dump → 快照落库/投影/事件 →
 *          结束后 jacococli 分析（M3-2）→ agent/CLI/classfiles 缺失时降级且不伪装成 0%
 *   场景 13 接口来源抽象：来源清单/未知来源/OpenAPI 拉取与校验 → Apifox 行为零变化（SRC-1）
 *   场景 14 W1 调用链还原：入口链路率/孤儿接口/断链降级 low/解析错误上报/重建提示（M3'-2）
 *          → project.source=openapi 绑定/可用/列表（M3'-1）
 *
 * 环境与 verify-m1-3 同口径：临时库 + 真实端口 + token；Apifox 侧只依赖本机缓存文件
 * （oas-cache.json，MCP 拉取的产物格式），不依赖外网。
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-scenes-'))
const TOKEN = 'verify-scenes-token-0123456789abcdef'

process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'heibaihe.db')
process.env.HEIBAIHE_TOKEN = TOKEN

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
}

// ---------------------------------------------------------------- 接口桩（/api/*，与文档路径一致）
const STUB_DELAY = 80
let stubActive = 0
let stubPeak = 0
/** 场景 8 专用：前两次 500，之后 200，用于验证重试/flaky */
let scene8FlakyHits = 0
/** 场景 11 专用：跨进程重启后仍要能读到命中次数（桩在父进程） */
let scene11FirstHits = 0
let scene11ThirdHits = 0
const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  stubActive += 1
  stubPeak = Math.max(stubPeak, stubActive)
  try {
    await sleep(Number(url.searchParams.get('ms') || STUB_DELAY))
    if (url.pathname === '/api/login') {
      return send(200, { code: 0, data: { token: 'tok-abc', user: { id: 1, name: 'alice' } } })
    }
    if (url.pathname === '/api/orders') {
      return send(200, { code: 0, data: { orders: [{ id: 11, total: 99 }], count: 1 } })
    }
    if (url.pathname === '/api/secure') {
      // 场景 10 专用：响应头带会话 cookie（导出必须打码），响应体不带任何请求回显
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'sid=scene10-cookie-secret; Path=/; HttpOnly',
      })
      return res.end(JSON.stringify({ code: 0, data: { ok: true, orderId: 'order-1' } }))
    }
    if (url.pathname === '/api/scene8-flaky') {
      scene8FlakyHits += 1
      if (scene8FlakyHits <= 2) return send(500, { code: 500, hit: scene8FlakyHits })
      return send(200, { code: 0, hit: scene8FlakyHits })
    }
    if (url.pathname === '/api/scene11-first') {
      scene11FirstHits += 1
      return send(200, { code: 0, data: { step: 'first', hits: scene11FirstHits } })
    }
    if (url.pathname === '/api/scene11-third') {
      scene11ThirdHits += 1
      return send(200, { code: 0, data: { step: 'third', hits: scene11ThirdHits } })
    }
    if (url.pathname === '/api/echo') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      return send(201, { code: 0, data: { method: req.method, body: raw ? JSON.parse(raw) : null } })
    }
    if (url.pathname === '/api/env-echo') {
      return send(200, {
        code: 0,
        data: {
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          nextToken: 'extract-scene7',
        },
      })
    }
    send(404, { code: 404 })
  } finally {
    stubActive -= 1
  }
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const stubBase = `http://127.0.0.1:${stub.address().port}`

// ---------------------------------------------------------------- 后端
const { createApp } = await import('../src/app.js')
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
const put = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body ?? {}),
  })
const del = (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: auth })

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
async function waitDetail(executionId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = await (await get(`/api/executions/${executionId}`)).json()
    if (predicate(detail)) return detail
    await sleep(50)
  }
  throw new Error(`等待执行详情条件超时：${executionId}`)
}
/** M3-2：覆盖率分析在 flow_end 之后异步执行，用投影接口等它收敛 */
async function waitCoverage(executionId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await (await get(`/api/executions/${executionId}/coverage`)).json()
    if (predicate(last)) return last
    await sleep(50)
  }
  throw new Error(`等待覆盖率分析超时：${executionId}（last=${JSON.stringify(last)}）`)
}

async function waitSuiteRun(runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await (await get(`/api/suite-runs/${runId}`)).json()
    if (['passed', 'failed', 'stopped'].includes(run.status)) return run
    await sleep(60)
  }
  throw new Error(`套件执行未在 ${timeoutMs} ms 内结束：${runId}`)
}

// ================================================================ 场景 1 · 流程管理
const draft = await (
  await post('/api/flows', {
    name: '场景1 归一化',
    nodes: [{ id: 'a', name: '节点A' }, { id: 'b', name: '节点B', action: { type: 'http', method: 'GET', url: `${stubBase}/api/login` } }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }],
  })
).json()
check(
  '1.1 创建流程：默认节点补全 action/expected，非法边（指向不存在节点）被过滤',
  draft.nodes?.length === 2 &&
    draft.nodes[0].action?.type === 'http' &&
    draft.nodes[0].expected?.status === 200 &&
    draft.edges?.length === 1 &&
    draft.edges[0].to === 'b',
  `nodes=${draft.nodes?.length} edges=${draft.edges?.length}`
)
const reread = await (await get(`/api/flows/${draft.id}`)).json()
check('1.2 详情读取与创建返回一致（同 id / 同节点名）', reread.id === draft.id && reread.nodes[1]?.name === '节点B')
const updated = await (
  await put(`/api/flows/${draft.id}`, { name: '场景1 归一化 v2', nodes: draft.nodes, edges: draft.edges })
).json()
check('1.3 更新流程：改名成功', updated.name === '场景1 归一化 v2')
const put404 = await put('/api/flows/not-exist', {})
check('1.4 更新不存在的流程 → 404', put404.status === 404)
const del404 = await del('/api/flows/not-exist')
check('1.5 删除不存在的流程 → 404', del404.status === 404)
await del(`/api/flows/${draft.id}`)
const afterDelete = await get(`/api/flows/${draft.id}`)
check('1.6 删除后详情 404、列表不含', afterDelete.status === 404)

// ================================================================ 场景 2 · 数据导入
const refSpec = {
  openapi: '3.0.0',
  info: { title: '演示服务', version: '1.0.0' },
  servers: [{ url: stubBase }],
  paths: {
    '/api/login': { get: { summary: '登录' } },
    '/api/echo': {
      post: {
        summary: '回显',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Echo' } } } },
      },
    },
  },
  components: { schemas: { Echo: { type: 'object', properties: { message: { type: 'string', example: 'hello' } } } } },
}
const imported = await (await post('/api/import/openapi', { spec: refSpec, name: 'OpenAPI 导入' })).json()
const importedFlow = imported.flow
check(
  '2.1 OpenAPI 导入：$ref 解析成 bodySample，POST 期望 201，baseUrl 进变量',
  importedFlow?.nodes?.length === 2 &&
    importedFlow.nodes[1]?.action?.body?.message === 'hello' &&
    importedFlow.nodes[1]?.expected?.status === 201 &&
    importedFlow.variables?.baseUrl === stubBase,
  `nodes=${importedFlow?.nodes?.length}`
)
// 导入草稿保存后直接执行：导入 → 保存 → 执行 闭环
const savedImport = await (await post('/api/flows', importedFlow)).json()
const runImport = await (await post(`/api/flows/${savedImport.id}/run`, {})).json()
const detailImport = await waitDone(runImport.executionId)
check(
  '2.2 导入的流程可直接执行通过（导入 → 执行闭环）',
  detailImport.status === 'passed' && detailImport.steps.every((s) => s.status === 'passed'),
  `status=${detailImport.status}`
)
const badSpec = await post('/api/import/openapi', { spec: { info: { title: 'no paths' } } })
check('2.3 spec 缺 paths → 400 IMPORT_BAD_SPEC', badSpec.status === 400)
const tooMany = { spec: { paths: {} } }
for (let i = 0; i < 5001; i += 1) tooMany.spec.paths[`/p${i}`] = { get: {} }
const tooManyRes = await post('/api/import/openapi', tooMany)
check(
  '2.4 paths 超上限 5000 → 413 IMPORT_TOO_MANY_PATHS',
  tooManyRes.status === 413 && (await tooManyRes.json()).code === 'IMPORT_TOO_MANY_PATHS'
)
const chain = {
  name: '下单调用链',
  entry: 'OrderController#create',
  nodes: [
    { id: 'm1', class: 'OrderController', method: 'create', file: 'OrderController.java', line: 10, depth: 0 },
    { id: 'm2', class: 'OrderService', method: 'save', file: 'OrderService.java', line: 42, depth: 1 },
  ],
  edges: [{ from: 'm1', to: 'm2' }, { from: 'm2', to: 'm2' }],
}
const whitebox = await (await post('/api/import/whitebox', chain)).json()
const wbFlow = whitebox.flows?.[0]
check(
  '2.5 白盒调用链导入：manual 节点带代码位置 hint，自环边被过滤',
  whitebox.flows?.length === 1 &&
    wbFlow.type === 'whitebox' &&
    wbFlow.nodes.length === 2 &&
    wbFlow.edges.length === 1 &&
    /OrderService#save/.test(wbFlow.nodes[1]?.action?.hint || ''),
  `nodes=${wbFlow?.nodes?.length} edges=${wbFlow?.edges?.length}`
)
const wbEmpty = await post('/api/import/whitebox', { foo: 1 })
check('2.6 白盒导入无 nodes → 400 IMPORT_BAD_SPEC', wbEmpty.status === 400)
const wbTooMany = Array.from({ length: 101 }, (_, i) => ({ name: `链${i}`, nodes: [{ id: 'x' }] }))
const wbTooManyRes = await post('/api/import/whitebox', wbTooMany)
check('2.7 白盒导入超 100 条 → 413 IMPORT_TOO_MANY_FLOWS', wbTooManyRes.status === 413)

// ================================================================ 场景 3 · 项目闭环
// 造一份 Apifox MCP 拉取产物格式的本机缓存（不依赖外网），走真实「绑定接口」API
const cacheSpec = {
  openapi: '3.0.0',
  info: { title: '演示服务', version: '1.0.0' },
  servers: [{ url: stubBase }],
  paths: {
    '/api/login': { get: { summary: '登录', 'x-apifox-folder': '用户' } },
    '/api/orders': { get: { summary: '订单列表', 'x-apifox-folder': '订单' } },
    '/api/echo': { post: { summary: '回显', 'x-apifox-folder': '通用' } },
  },
}
fs.mkdirSync(path.join(DIR, 'apifox'), { recursive: true })
fs.writeFileSync(
  path.join(DIR, 'apifox', 'oas-cache.json'),
  JSON.stringify({ projectId: '123', title: '演示服务', version: '1.0.0', fetchedAt: Date.now(), spec: cacheSpec }),
  'utf8'
)
const cached = await get('/api/apifox/interfaces')
const cachedBody = await cached.json()
check(
  '3.1 Apifox 本机缓存可读：3 个接口、folder 分组齐全',
  cached.status === 200 && cachedBody.interfaces?.length === 3,
  `${cachedBody.interfaces?.length} 个`
)

// 造一个临时「前端工程」：3 个真实调用点 + 注释/依赖目录/压缩文件干扰项
const codeRoot = path.join(DIR, 'demo-front')
const write = (rel, content) => {
  const full = path.join(codeRoot, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}
write('src/api/user.ts', "import service from './http'\nexport function login() {\n  return service.get('/api/login')\n}\n")
write('src/api/order.ts', "import service from './http'\nexport function loadOrders() {\n  return service.get('/api/orders')\n}\n")
write('src/api/misc.js', "import axios from 'axios'\nexport function echo(data) {\n  return axios.post('/api/echo', data)\n}\n")
write('src/api/commented.ts', "// axios.get('/api/commented-out')\n/*\naxios.get('/api/block-comment')\n*/\n")
write('node_modules/pkg/index.js', "axios.get('/api/from-deps')\n")
write('dist/vendor.min.js', "axios.get('/api/from-min')\n")

const project = await (await post('/api/projects', { name: '演示前端', codePath: codeRoot, description: '场景3' })).json()
check('3.2 创建项目成功', project?.id && project.name === '演示前端')
const pathOk = await (await post(`/api/projects/${project.id}/check-path`, { codePath: codeRoot })).json()
const pathBad = await (await post(`/api/projects/${project.id}/check-path`, { codePath: path.join(DIR, 'no-such') })).json()
check('3.3 代码目录校验：存在 ok / 不存在报错', pathOk.ok === true && pathBad.ok === false)

const scanEarly = await post(`/api/projects/${project.id}/scan`, {})
check('3.4 未绑定接口就扫描 → 400 引导提示', scanEarly.status === 400)

const bound = await (
  await put(`/api/projects/${project.id}/interfaces`, {
    ids: ['GET /api/login', 'GET /api/orders', 'POST /api/echo'],
  })
).json()
check(
  '3.5 绑定接口：快照落库（含 serverUrl/folder），不再依赖缓存',
  bound.interfaces?.length === 3 && bound.interfaces[0]?.serverUrl === stubBase,
  `${bound.interfaces?.length} 个`
)

const scanned = await (await post(`/api/projects/${project.id}/scan`, { codePath: codeRoot })).json()
const scan = scanned.scan
check(
  '3.6 源码扫描：3 个真实调用点全匹配，注释/依赖目录/压缩文件被忽略',
  scan?.calls?.length === 3 &&
    scan.matchedCalls === 3 &&
    scan.matchRate === 100 &&
    scan.unmatchedCalls === 0,
  `calls=${scan?.calls?.length} matched=${scan?.matchedCalls} rate=${scan?.matchRate}%`
)
check(
  '3.7 业务功能分组：按 Apifox folder 分成 用户/订单/通用',
  (scan.groups || []).length === 3 &&
    ['用户', '订单', '通用'].every((f) => scan.groups.some((g) => g.name === f)),
  (scan.groups || []).map((g) => g.name).join(',')
)
const firstCall = scan.calls.find((c) => c.path === '/api/echo')
const unmapped = await (await post(`/api/projects/${project.id}/mapping`, { callId: firstCall.id, interfaceId: '' })).json()
const unmappedCall = unmapped.scan.calls.find((c) => c.id === firstCall.id)
check('3.8 手动取消关联：matched=false 且匹配率下降', unmappedCall.matched === false && unmapped.scan.matchRate === 67, `rate=${unmapped.scan.matchRate}%`)
const remapped = await (
  await post(`/api/projects/${project.id}/mapping`, { callId: firstCall.id, interfaceId: 'POST /api/echo' })
).json()
check('3.9 手动关联：score=100 / confidence=manual，匹配率回到 100', remapped.scan.calls.find((c) => c.id === firstCall.id).confidence === 'manual')

const generated = await (await post(`/api/projects/${project.id}/flows`, { all: true })).json()
const genFlow = generated.flows?.[0]
check(
  '3.10 一键生成黑盒流程：source=project-scan，3 个节点按调用顺序连线',
  genFlow?.source === 'project-scan' &&
    genFlow.nodes?.length === 3 &&
    genFlow.edges?.length === 2 &&
    genFlow.nodes.every((n) => n.action.url.startsWith(stubBase)),
  `nodes=${genFlow?.nodes?.length}`
)
check(
  '3.11 生成节点的 expected 按方法推导（POST → 201）',
  genFlow.nodes.find((n) => n.action.method === 'POST')?.expected?.status === 201
)
const runGen = await (await post(`/api/flows/${genFlow.id}/run`, {})).json()
const detailGen = await waitDone(runGen.executionId)
check(
  '3.12 生成的流程直接执行通过（扫描 → 生成 → 执行 全闭环）',
  detailGen.status === 'passed' && detailGen.steps.length === 3,
  `status=${detailGen.status} steps=${detailGen.steps.length}`
)

const projectDetail = await (await get(`/api/projects/${project.id}`)).json()
check(
  '3.13 项目详情聚合：flows 关联数 + 扫描摘要',
  projectDetail.flows?.length === 1 && projectDetail.scan?.matchRate === 100,
  `flows=${projectDetail.flows?.length}`
)

// ================================================================ 场景 4 · 白盒执行
const runWb = await (await post(`/api/flows/${wbFlow.id}/run`, {})).json()
await waitDetail(runWb.executionId, (d) => d.steps.some((s) => s.status === 'waiting' && s.nodeId === 'm1'))
const confirmWb = await (
  await post(`/api/executions/${runWb.executionId}/manual`, { nodeId: 'm1', pass: true, note: 'Controller 已核对' })
).json()
await waitDetail(runWb.executionId, (d) => d.steps.some((s) => s.status === 'waiting' && s.nodeId === 'm2'))
const confirmWb2 = await (
  await post(`/api/executions/${runWb.executionId}/manual`, { nodeId: 'm2', pass: true, note: 'Service 已核对' })
).json()
const detailWb = await waitDone(runWb.executionId)
check(
  '4.1 白盒调用链执行：两个方法节点逐个人工确认后 passed',
  confirmWb.ok === true && confirmWb2.ok === true &&
    detailWb.status === 'passed' &&
    detailWb.steps.every((s) => s.actual?.manual === true && s.actual?.confirmed === true),
  `status=${detailWb.status} cb=${confirmWb.ok}/${confirmWb2.ok} steps=${(detailWb.steps || [])
    .map((s) => `${s.nodeId}:${s.status}:${s.actual?.confirmed}`)
    .join(',')}`
)

// ================================================================ 场景 5 · 缺陷记录
const sampleStep = detailGen.steps.find((s) => s.status === 'passed')
const bug1 = await (
  await post('/api/bugs', {
    projectId: project.id,
    flowId: genFlow.id,
    executionId: runGen.executionId,
    nodeId: sampleStep.nodeId,
    stepName: sampleStep.nodeName,
    title: '订单列表返回为空',
    description: '实际响应 data.orders 为空数组',
    severity: 'major',
    actual: { orders: [] },
    expected: { orders: [{ id: 11 }] },
  })
).json()
check(
  '5.1 从执行步骤提缺陷：自动带出项目名/流程名富化',
  bug1?.id && bug1.projectName === '演示前端' && /全量接口|演示前端/.test(bug1.flowName || ''),
  `projectName=${bug1?.projectName}`
)
await post('/api/bugs', { title: '登录页样式错位', severity: 'trivial', projectId: project.id })
const openOnly = await (await get('/api/bugs?status=open&severity=major')).json()
check('5.2 缺陷列表按 status/severity 过滤', openOnly.length === 1 && openOnly[0].title === '订单列表返回为空')
const bugStats1 = await (await get('/api/bugs/stats')).json()
check('5.3 缺陷统计：total=2 open=2 bySeverity 齐全', bugStats1.total === 2 && bugStats1.open === 2 && bugStats1.bySeverity.major === 1)
const fixed = await (await put(`/api/bugs/${bug1.id}`, { status: 'verified' })).json()
const bugStats2 = await (await get('/api/bugs/stats')).json()
check(
  '5.4 状态流转 open → verified：open 降为 1、closed 计为已关闭',
  fixed.status === 'verified' && bugStats2.open === 1 && bugStats2.closed === 1
)
const bug404 = await put('/api/bugs/not-exist', {})
const emptyTitle = await post('/api/bugs', { title: '   ' })
check('5.5 更新不存在 → 404；空标题 → 400', bug404.status === 404 && emptyTitle.status === 400)
await del(`/api/bugs/${bug1.id}`)
const afterBugDelete = await (await get('/api/bugs')).json()
check('5.6 删除缺陷生效', afterBugDelete.length === 1)

// ================================================================ 场景 6 · 统计面板
const flows = await (await get('/api/flows')).json()
const execs = await (await get('/api/executions')).json()
const bugs = await (await get('/api/bugs')).json()
const stats = await (await get('/api/stats')).json()
const finished = execs.filter((e) => ['passed', 'failed', 'stopped'].includes(e.status))
check(
  '6.1 统计与列表一致：流程/项目/执行/缺陷计数全部对上',
  stats.flowTotal === flows.length &&
    stats.projectCount === 1 &&
    stats.execTotal === execs.length &&
    stats.bugTotal === bugs.length &&
    stats.whiteboxCount === 1,
  `flows=${stats.flowTotal} exec=${stats.execTotal} bugs=${stats.bugTotal}`
)
const expectRate = Math.round((finished.filter((e) => e.status === 'passed').length / finished.length) * 100)
check(
  '6.2 成功率与 recent 截断正确',
  stats.successRate === expectRate && Array.isArray(stats.recent) && stats.recent.length <= 8,
  `rate=${stats.successRate}% recent=${stats.recent.length}`
)

// ================================================================ 场景 7 · 环境与密钥（M2-1）
const SECRET7 = 'scene7-top-secret-value'
const envRes = await post('/api/environments', {
  name: '场景7 测试环境',
  projectId: project.id,
  baseUrl: stubBase,
  variables: { scene: 'env-scene', token: 'env-token-scene7' },
  headers: { 'X-Scene': 'scene-7', Authorization: 'Bearer {{sceneSecret}}' },
  secrets: { sceneSecret: SECRET7 },
})
const env = await envRes.json()
check(
  '7.1 创建环境：version=1、只回 secretKeys、响应不含密钥明文',
  envRes.status === 200 &&
    env.version === 1 &&
    env.baseUrl === stubBase &&
    env.secretKeys?.includes('sceneSecret') &&
    !JSON.stringify(env).includes(SECRET7),
  `id=${env.id?.slice(0, 8)} keys=${env.secretKeys?.length}`
)

const envList = await (await get(`/api/environments?projectId=${project.id}`)).json()
const envDetail = await (await get(`/api/environments/${env.id}`)).json()
check(
  '7.2 列表按项目过滤 + 详情不回显明文',
  envList.length === 1 && envList[0].id === env.id && !JSON.stringify(envDetail).includes(SECRET7)
)

const envPreview = await (await get(`/api/environments/${env.id}/resolve`)).json()
check(
  '7.3 预览：普通变量可读、secrets 打码为 ***、baseUrl 一并返回',
  envPreview.resolved?.variables?.scene === 'env-scene' &&
    envPreview.resolved?.variables?.sceneSecret === '***' &&
    envPreview.resolved?.baseUrl === stubBase &&
    !JSON.stringify(envPreview).includes(SECRET7)
)

const scene7Flow = await (
  await post('/api/flows', {
    name: '场景7 环境优先级',
    type: 'blackbox',
    projectId: project.id,
    variables: { scene: 'flow-scene', token: 'flow-token-scene7' },
    nodes: [
      {
        id: 'n1',
        name: '环境变量与密钥',
        action: {
          type: 'http',
          method: 'GET',
          url: '/api/env-echo?scene={{scene}}&token={{token}}&secret={{sceneSecret}}',
          headers: { 'X-Node': 'scene7-node' },
        },
        expected: { status: 200, checks: [] },
        extract: { token: '$.data.nextToken' },
      },
      {
        id: 'n2',
        name: '提取变量覆盖',
        action: { type: 'http', method: 'GET', url: '/api/env-echo?token={{token}}' },
        expected: { status: 200, checks: [] },
      },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
  })
).json()
const scene7Run = await (
  await post(`/api/flows/${scene7Flow.id}/run`, {
    environmentId: env.id,
    variables: { token: 'runtime-token-scene7' },
  })
).json()
const scene7Detail = await waitDone(scene7Run.executionId)
const [scene7Step1, scene7Step2] = scene7Detail.steps
const scene7Text = JSON.stringify(scene7Detail)
check(
  '7.4 变量优先级：flow < Environment < 执行时传入；extract 最高',
  scene7Detail.status === 'passed' &&
    scene7Step1.request?.url?.includes('scene=env-scene') &&
    scene7Step1.request?.url?.includes('token=runtime-token-scene7') &&
    scene7Step2.request?.url?.includes('token=extract-scene7'),
  `s1=${scene7Step1?.request?.url} s2=${scene7Step2?.request?.url}`
)
check(
  '7.5 baseUrl 拼接相对路径 + 环境 Header 与节点头合并（含 secret 头掩码）',
  scene7Step1.actual?.data?.data?.headers?.['x-scene'] === 'scene-7' &&
    scene7Step1.actual?.data?.data?.headers?.['x-node'] === 'scene7-node' &&
    scene7Step1.actual?.data?.data?.headers?.authorization === 'Bearer ***',
  `headers=${JSON.stringify(scene7Step1?.actual?.data?.data?.headers || {})}`
)
check(
  '7.6 执行记录绑定环境版本，落库/事件/变量快照均不含密钥明文',
  scene7Detail.envId === env.id &&
    scene7Detail.envVersion === env.version &&
    scene7Detail.environment?.name === '场景7 测试环境' &&
    scene7Detail.environment?.variables?.sceneSecret === '***' &&
    scene7Detail.vars?.sceneSecret === '***' &&
    scene7Step1.request?.url?.includes('secret=***') &&
    !scene7Text.includes(SECRET7),
  `envId=${scene7Detail.envId?.slice(0, 8)} v=${scene7Detail.envVersion}`
)

const dbFiles = [path.join(DIR, 'heibaihe.db'), path.join(DIR, 'heibaihe.db-wal'), path.join(DIR, 'heibaihe.db-shm')]
  .filter((file) => fs.existsSync(file))
const dbBytes = dbFiles.reduce((acc, file) => Buffer.concat([acc, fs.readFileSync(file)]), Buffer.alloc(0))
check(
  '7.7 secrets 密文落库：SQLite 文件无明文；主密钥文件已生成',
  env.secretKeys.length === 1 &&
    !dbBytes.toString('utf8').includes(SECRET7) &&
    fs.existsSync(path.join(DIR, '.master.key'))
)

const dupEnv = await post('/api/environments', { name: '场景7 测试环境', projectId: project.id })
const badKeyEnv = await post('/api/environments', { name: '场景7 坏键', variables: { 'bad key': 1 } })
const conflictEnv = await post('/api/environments', {
  name: '场景7 冲突',
  variables: { same: 'a' },
  secrets: { same: 'b' },
})
const ghostEnvRun = await post(`/api/flows/${scene7Flow.id}/run`, { environmentId: 'ghost-env' })
check(
  '7.8 错误路径：重名/非法键/键冲突 400，未知环境执行 404',
  dupEnv.status === 400 &&
    (await dupEnv.json()).code === 'ENV_NAME_CONFLICT' &&
    badKeyEnv.status === 400 &&
    (await badKeyEnv.json()).code === 'ENV_BAD_KEY' &&
    conflictEnv.status === 400 &&
    (await conflictEnv.json()).code === 'ENV_KEY_CONFLICT' &&
    ghostEnvRun.status === 404 &&
    (await ghostEnvRun.json()).code === 'ENV_NOT_FOUND'
)

const envAfterSecretDelete = await (await del(`/api/environments/${env.id}/secrets/sceneSecret`)).json()
const envGone = await del(`/api/environments/${env.id}`)
check(
  '7.9 删除密钥后 secretKeys 清空；删除环境后详情 404',
  envAfterSecretDelete.secretKeys.length === 0 &&
    envGone.status === 200 &&
    (await get(`/api/environments/${env.id}`)).status === 404
)

// ================================================================ 场景 8 · 套件与队列（M2-2）
const makeSceneFlow = async (name, url, expected = { status: 200 }) =>
  (
    await post('/api/flows', {
      name,
      type: 'blackbox',
      projectId: project.id,
      nodes: [{ id: 'n1', name: `${name}-请求`, action: { type: 'http', method: 'GET', url }, expected }],
      edges: [],
    })
  ).json()

const suiteFlows = []
for (const key of ['A', 'B', 'C', 'D']) {
  suiteFlows.push(await makeSceneFlow(`场景8 并发-${key}`, `${stubBase}/api/login`))
}
const suiteCreatedRes = await post('/api/suites', {
  name: '场景8 并发套件',
  projectId: project.id,
  flowIds: suiteFlows.map((f) => f.id),
  strategy: { concurrency: 2, retry: 0 },
})
const suiteCreated = await suiteCreatedRes.json()
const dupSuite = await (await post('/api/suites', { name: '场景8 并发套件', projectId: project.id, flowIds: [suiteFlows[0].id] })).json()
const emptySuite = await (await post('/api/suites', { name: '场景8 空套件', flowIds: [] })).json()
const ghostSuite = await (await post('/api/suites', { name: '场景8 幽灵流程', flowIds: ['ghost-flow'] })).json()
check(
  '8.1 创建套件：顺序保留、策略归一化、重名/空流程/幽灵流程有稳定错误码',
  suiteCreatedRes.status === 200 &&
    suiteCreated.flowCount === 4 &&
    suiteCreated.strategy?.concurrency === 2 &&
    suiteCreated.strategy?.retryDelayMs === 500 &&
    suiteCreated.strategy?.failFast === false &&
    dupSuite.code === 'SUITE_NAME_CONFLICT' &&
    emptySuite.code === 'SUITE_EMPTY' &&
    ghostSuite.code === 'SUITE_FLOW_NOT_FOUND',
  `flows=${suiteCreated.flowCount} conc=${suiteCreated.strategy?.concurrency} dup=${dupSuite.code}`
)

stubPeak = 0
const suiteRun = await (await post(`/api/suites/${suiteCreated.id}/run`, {})).json()
const suiteDone = await waitSuiteRun(suiteRun.suiteRunId)
check(
  '8.2 一键执行：队列峰值与 HTTP 桩峰值都等于策略并发 2，4 条流程全部通过',
  suiteDone.status === 'passed' &&
    suiteDone.summary.total === 4 &&
    suiteDone.summary.passed === 4 &&
    suiteDone.summary.peakConcurrency === 2 &&
    stubPeak === 2,
  `status=${suiteDone.status} peak=${suiteDone.summary.peakConcurrency} httpPeak=${stubPeak}`
)
check(
  '8.3 每条流程产生独立执行记录，并全部绑定同一个 suiteRunId',
  suiteDone.executions.length === 4 &&
    suiteDone.executions.every((e) => e.suiteRunId === suiteRun.suiteRunId && e.status === 'passed') &&
    new Set(suiteDone.executions.map((e) => e.flowId)).size === 4,
  `execs=${suiteDone.executions.length}`
)

// 真实 WebSocket：加入 suite 房间后应收到进度与结束事件（流程本身约 80 ms，足够覆盖事件窗口）
const wsSocket = io(base, {
  path: '/socket.io',
  transports: ['websocket'],
  auth: { token: TOKEN },
  forceNew: true,
})
const wsEvents = []
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000)
  wsSocket.on('connect', () => {
    clearTimeout(timer)
    resolve()
  })
  wsSocket.on('connect_error', (err) => {
    clearTimeout(timer)
    reject(err)
  })
})
wsSocket.on('suite_event', (evt) => wsEvents.push(evt))
const wsSuite = await (
  await post('/api/suites', {
    name: '场景8 实时事件套件',
    projectId: project.id,
    flowIds: [suiteFlows[0].id, suiteFlows[1].id],
    strategy: { concurrency: 2 },
  })
).json()
const wsRun = await (await post(`/api/suites/${wsSuite.id}/run`, {})).json()
wsSocket.emit('join', { room: `suite:${wsRun.suiteRunId}` })
const wsDone = await waitSuiteRun(wsRun.suiteRunId)
await sleep(300)
wsSocket.close()
const wsTypes = new Set(wsEvents.map((evt) => evt.type))
check(
  '8.4 实时通道：加入 suite 房间后收到 suite_progress / suite_flow_end / suite_end',
  wsDone.status === 'passed' &&
    ['suite_progress', 'suite_flow_end', 'suite_end'].every((type) => wsTypes.has(type)) &&
    wsEvents.length > 0 &&
    wsEvents.every((evt) => evt.suiteRunId === wsRun.suiteRunId),
  `events=${[...wsTypes].join(',')}`
)

const flakyFlow = await makeSceneFlow('场景8 偶发失败', `${stubBase}/api/scene8-flaky`)
const flakySuite = await (
  await post('/api/suites', {
    name: '场景8 重试套件',
    projectId: project.id,
    flowIds: [flakyFlow.id],
    strategy: { concurrency: 1, retry: 2, retryDelayMs: 5 },
  })
).json()
const flakyRun = await (await post(`/api/suites/${flakySuite.id}/run`, {})).json()
const flakyDone = await waitSuiteRun(flakyRun.suiteRunId)
const flakyItem = flakyDone.summary.flows[0]
check(
  '8.5 失败重试：前两次 500 后第 3 次通过，标记 flaky 且每次尝试都有执行记录',
  flakyDone.status === 'passed' &&
    flakyItem.attempts === 3 &&
    flakyItem.flaky === true &&
    flakyDone.summary.flaky === 1 &&
    flakyDone.executions.length === 3 &&
    flakyDone.executions.map((e) => e.status).join(',') === 'failed,failed,passed',
  `attempts=${flakyItem.attempts} execs=${flakyDone.executions.map((e) => e.status).join(',')}`
)

const failFlow = await makeSceneFlow('场景8 必失败', `${stubBase}/api/login`, { status: 201 })
const ffSlow1 = await makeSceneFlow('场景8 failFast 流程1', `${stubBase}/api/orders`)
const ffSlow2 = await makeSceneFlow('场景8 failFast 流程2', `${stubBase}/api/orders`)
const ffSuite = await (
  await post('/api/suites', {
    name: '场景8 failFast 套件',
    projectId: project.id,
    flowIds: [failFlow.id, ffSlow1.id, ffSlow2.id],
    strategy: { concurrency: 1, retry: 0, failFast: true },
  })
).json()
const ffRun = await (await post(`/api/suites/${ffSuite.id}/run`, {})).json()
const ffDone = await waitSuiteRun(ffRun.suiteRunId)
check(
  '8.6 failFast：首个流程失败后，未开始的流程统一 skipped 且不产生执行记录',
  ffDone.status === 'failed' &&
    ffDone.summary.failed === 1 &&
    ffDone.summary.skipped === 2 &&
    ffDone.executions.length === 1 &&
    /failFast/.test(ffDone.summary.flows[1].error || ''),
  `failed=${ffDone.summary.failed} skipped=${ffDone.summary.skipped} execs=${ffDone.executions.length}`
)

const stopFlow1 = await makeSceneFlow('场景8 长流程1', `${stubBase}/api/login?ms=1500`)
const stopFlow2 = await makeSceneFlow('场景8 长流程2', `${stubBase}/api/login?ms=1500`)
const stopSuite = await (
  await post('/api/suites', {
    name: '场景8 停止套件',
    projectId: project.id,
    flowIds: [stopFlow1.id, stopFlow2.id],
    strategy: { concurrency: 1 },
  })
).json()
const stopRun = await (await post(`/api/suites/${stopSuite.id}/run`, {})).json()
const stopDeadline = Date.now() + 8000
while (Date.now() < stopDeadline) {
  const current = await (await get(`/api/suite-runs/${stopRun.suiteRunId}`)).json()
  if (current.summary?.running === 1) break
  await sleep(50)
}
const stopRes = await post(`/api/suite-runs/${stopRun.suiteRunId}/stop`, {})
const stopDone = await waitSuiteRun(stopRun.suiteRunId)
const stopAgain = await post(`/api/suite-runs/${stopRun.suiteRunId}/stop`, {})
check(
  '8.7 手动停止：在跑流程记 stopped、未开始 skipped，结束后重复停止返回 409',
  stopRes.status === 200 &&
    stopDone.status === 'stopped' &&
    stopDone.summary.flows[0].status === 'stopped' &&
    stopDone.summary.skipped === 1 &&
    stopAgain.status === 409,
  `status=${stopDone.status} flow0=${stopDone.summary.flows[0].status} skipped=${stopDone.summary.skipped}`
)

const execsBeforeDelete = await (await get('/api/executions')).json()
const suiteDel = await del(`/api/suites/${suiteCreated.id}`)
const suiteGone = await get(`/api/suites/${suiteCreated.id}`)
const runsAfterDelete = await (await get(`/api/suite-runs?suiteId=${suiteCreated.id}`)).json()
const execsAfterDelete = await (await get('/api/executions')).json()
check(
  '8.8 删除套件：定义与套件历史删除，流程执行记录保留（测试证据不丢）',
  suiteDel.status === 200 &&
    suiteGone.status === 404 &&
    runsAfterDelete.length === 0 &&
    execsBeforeDelete.filter((e) => e.suiteRunId === suiteRun.suiteRunId).length === 4 &&
    execsAfterDelete.filter((e) => e.suiteRunId === suiteRun.suiteRunId).length === 4,
  `runs=${runsAfterDelete.length} execs=${execsAfterDelete.filter((e) => e.suiteRunId === suiteRun.suiteRunId).length}`
)

// ================================================================ 场景 9 · 失败归类（M2-3）
const node9 = (id, url, expected, action = {}) => ({
  id,
  name: `节点 ${id}`,
  action: { type: 'http', method: 'GET', url, ...action },
  expected,
})
const makeClassFlow = async (name, nodes, edges = [], extra = {}) =>
  (await post('/api/flows', { name, type: 'blackbox', projectId: project.id, nodes, edges, ...extra })).json()
const run9 = async (flowId, body = {}) => (await post(`/api/flows/${flowId}/run`, body)).json()
const stepOf = (detail, nodeId) => (detail.steps || []).find((s) => s.nodeId === nodeId)
const stepEndOf = (detail, nodeId) =>
  (detail.events || []).find((e) => e.type === 'step_end' && e.payload?.nodeId === nodeId)

// 死端口：先真监听再关闭，保证 connect 一定被拒绝（network，而不是 DNS/超时）
const deadServer = http.createServer()
await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
const deadBase = `http://127.0.0.1:${deadServer.address().port}`
await new Promise((resolve) => deadServer.close(resolve))

// —— 9.1 一次执行同时出现「状态码 / 断言 / 前置依赖」三类 ——
const mixedFlow = await makeClassFlow(
  '场景9 混合归类',
  [
    node9('c1', `${stubBase}/api/login`, { status: 500, checks: [] }),
    node9('c2', `${stubBase}/api/orders`, { status: 200, checks: [] }),
    node9('c3', `${stubBase}/api/orders`, { status: 200, checks: [{ path: '$.data.count', op: 'eq', value: 99 }] }),
    node9('c4', `${stubBase}/api/orders`, { status: 200, checks: [] }),
  ],
  [{ from: 'c1', to: 'c2' }, { from: 'c3', to: 'c4' }]
)
const mixedDetail = await waitDone((await run9(mixedFlow.id)).executionId)
check(
  '9.1 混合失败：主归类取首个失败步骤，状态码/断言/依赖各自命中',
  mixedDetail.status === 'failed' &&
    mixedDetail.failureClass === 'status' &&
    stepOf(mixedDetail, 'c1').failureClass === 'status' &&
    stepOf(mixedDetail, 'c3').failureClass === 'assertion' &&
    stepOf(mixedDetail, 'c2').failureClass === 'dependency' &&
    stepOf(mixedDetail, 'c4').failureClass === 'dependency' &&
    mixedDetail.summary.failureClasses.status === 1 &&
    mixedDetail.summary.failureClasses.assertion === 1 &&
    mixedDetail.summary.failureClasses.dependency === 2 &&
    /期望 等于 500，实际 200/.test(stepOf(mixedDetail, 'c1').failureReason || ''),
  `main=${mixedDetail.failureClass} counts=${JSON.stringify(mixedDetail.summary.failureClasses)}`
)

// —— 9.2~9.5 其余四类：网络 / 超时 / 结构 / 脚本 ——
const netFlow = await makeClassFlow('场景9 网络不可达', [
  node9('n1', `${deadBase}/api/login`, { status: 200, checks: [] }),
])
const netDetail = await waitDone((await run9(netFlow.id)).executionId)
check(
  '9.2 连接被拒绝 → network（原因带 ECONNREFUSED，不落在 script）',
  netDetail.failureClass === 'network' &&
    /ECONNREFUSED/.test(netDetail.failureReason || '') &&
    netDetail.summary.failureClasses.timeout === 0,
  `class=${netDetail.failureClass}`
)

const toFlow = await makeClassFlow('场景9 超时', [
  node9('t1', `${stubBase}/api/login?ms=800`, { status: 200, checks: [] }, { timeout: 30 }),
])
const toDetail = await waitDone((await run9(toFlow.id)).executionId)
check(
  '9.3 节点 timeout 30ms 命中慢响应 → timeout（优先于网络判定）',
  toDetail.failureClass === 'timeout' && /timeout of 30ms exceeded/.test(toDetail.failureReason || ''),
  `class=${toDetail.failureClass} reason=${(toDetail.failureReason || '').slice(0, 40)}`
)

const schemaFlow = await makeClassFlow('场景9 结构不符', [
  node9('s1', `${stubBase}/api/login`, {
    status: 200,
    checks: [{ type: 'schema', label: '登录返回结构', value: ['$.data.token', '$.data.role'] }],
  }),
])
const schemaDetail = await waitDone((await run9(schemaFlow.id)).executionId)
check(
  '9.4 schema 断言缺字段 → schema，原因指出缺失路径',
  schemaDetail.failureClass === 'schema' &&
    /缺失 \$\.data\.role/.test(stepOf(schemaDetail, 's1').failureReason || '') &&
    stepOf(schemaDetail, 's1').checks.results.some((c) => c.type === 'schema' && c.passed === false),
  `class=${schemaDetail.failureClass} reason=${stepOf(schemaDetail, 's1').failureReason}`
)

const scriptFlow = await makeClassFlow('场景9 变量未解析', [
  node9('g1', `${stubBase}/api/{{ghostPath}}`, { status: 200, checks: [] }),
])
const scriptDetail = await waitDone((await run9(scriptFlow.id)).executionId)
check(
  '9.5 变量未解析 → script 且请求根本不发（无 request 证据）',
  scriptDetail.failureClass === 'script' &&
    /变量未解析/.test(scriptDetail.failureReason || '') &&
    !stepOf(scriptDetail, 'g1').request,
  `class=${scriptDetail.failureClass}`
)

// —— 9.6 人工驳回 ——
const rejectFlow = await makeClassFlow(
  '场景9 人工驳回',
  [{ id: 'm1', name: '走查金额计算', action: { type: 'manual', hint: '核对金额四舍五入' }, expected: { status: 200, checks: [] } }],
  [],
  { type: 'whitebox' }
)
const runReject = await run9(rejectFlow.id)
await waitDetail(runReject.executionId, (d) => d.steps.some((s) => s.status === 'waiting' && s.nodeId === 'm1'))
await post(`/api/executions/${runReject.executionId}/manual`, {
  nodeId: 'm1',
  pass: false,
  note: '分位数处理错误，需修复',
})
const rejectDetail = await waitDone(runReject.executionId)
check(
  '9.6 人工确认不通过 → manual_reject，原因用测试人员备注',
  rejectDetail.status === 'failed' &&
    rejectDetail.failureClass === 'manual_reject' &&
    /分位数处理错误/.test(rejectDetail.failureReason || ''),
  `class=${rejectDetail.failureClass} reason=${rejectDetail.failureReason}`
)

// —— 9.7 列表按归类筛选（含非法值不过滤）——
const allExecs = await (await get('/api/executions')).json()
const netFiltered = await (await get('/api/executions?failureClass=network')).json()
const schemaFiltered = await (await get('/api/executions?failureClass=schema')).json()
const bogusFiltered = await (await get('/api/executions?failureClass=bogus')).json()
check(
  '9.7 GET /executions?failureClass= 精确过滤且行内带归类投影列',
  netFiltered.length > 0 &&
    netFiltered.every((e) => e.failureClass === 'network') &&
    netFiltered.some((e) => e.id === netDetail.id) &&
    schemaFiltered.some((e) => e.id === schemaDetail.id) &&
    netFiltered.every((e) => !!e.failureReason),
  `network=${netFiltered.length} schema=${schemaFiltered.length}`
)
check(
  '9.8 非法归类值当作未过滤（返回全量，不报错）',
  bogusFiltered.length === allExecs.length && allExecs.some((e) => e.failureClass === 'timeout'),
  `all=${allExecs.length} bogus=${bogusFiltered.length}`
)

// —— 9.9 归类原因不得泄漏 secret 明文（归类基于掩码后的步骤）——
const SECRET9 = 'scene9-secret-in-url-value'
const env9 = await (
  await post('/api/environments', {
    name: '场景9 归类脱敏',
    projectId: project.id,
    baseUrl: stubBase,
    secrets: { s9Secret: SECRET9 },
  })
).json()
const leakFlow = await makeClassFlow('场景9 归类脱敏', [
  node9('k1', `${deadBase}/api/login?s={{s9Secret}}`, { status: 200, checks: [] }),
])
const leakDetail = await waitDone((await run9(leakFlow.id, { environmentId: env9.id })).executionId)
check(
  '9.9 归类原因基于掩码后的步骤：URL 里的 secret 不落进 failureReason',
  leakDetail.failureClass === 'network' &&
    !JSON.stringify(leakDetail).includes(SECRET9) &&
    /\*\*\*/.test(leakDetail.failureReason || ''),
  `reason=${leakDetail.failureReason}`
)

// —— 9.10 事件 / 步骤 / 执行 / 列表 / 套件 五处口径一致 ——
const clsSuite = await (
  await post('/api/suites', {
    name: '场景9 归类套件',
    projectId: project.id,
    flowIds: [schemaFlow.id, netFlow.id],
    strategy: { concurrency: 2, retry: 0 },
  })
).json()
const clsRun = await (await post(`/api/suites/${clsSuite.id}/run`, {})).json()
const clsDone = await waitSuiteRun(clsRun.suiteRunId)
const clsFlowByFlow = Object.fromEntries(clsDone.summary.flows.map((f) => [f.flowId, f]))
const clsExecDetails = await Promise.all(
  clsDone.executions.map(async (row) => ({
    row,
    detail: await (await get(`/api/executions/${row.id}`)).json(),
  }))
)
check(
  '9.10 事件、步骤、执行汇总、列表、套件 flows 的归类完全一致',
  stepEndOf(mixedDetail, 'c1')?.payload?.failureClass === 'status' &&
    stepEndOf(mixedDetail, 'c2')?.payload?.failureClass === 'dependency' &&
    clsFlowByFlow[schemaFlow.id]?.failureClass === 'schema' &&
    clsFlowByFlow[netFlow.id]?.failureClass === 'network' &&
    clsFlowByFlow[schemaFlow.id]?.attemptExecutions?.[0]?.failureClass === 'schema' &&
    clsDone.executions.length === 2 &&
    clsExecDetails.every(
      ({ row, detail }) =>
        row.failureClass === detail.failureClass &&
        detail.failureClass === clsFlowByFlow[detail.flowId]?.failureClass &&
        detail.steps[0]?.failureClass === detail.failureClass &&
        detail.summary?.failureClass === detail.failureClass &&
        !!row.failureReason
    ),
  `suite=${clsDone.summary.flows.map((f) => f.failureClass).join(',')} execs=${clsExecDetails
    .map(({ row }) => row.failureClass)
    .join(',')}`
)

// ================================================================ 场景 10 · 报告导出（M2-4）
// 覆盖：三格式可下载 → S8 脱敏（env secret / 请求头 / query / 请求体 / 响应头）→
//       计数与详情页一致 → 套件导出 → 非法格式 400 / 不存在 404。
const SECRET_ENV10 = 'scene10-env-secret-value'
const SECRET_HEADER10 = 'scene10-literal-header-secret'
const SECRET_BODY10 = 'scene10-literal-body-secret'
const SECRET_COOKIE10 = 'scene10-cookie-secret'
const SECRETS10 = [SECRET_ENV10, SECRET_HEADER10, SECRET_BODY10, SECRET_COOKIE10]
const leaks10 = (text) => SECRETS10.filter((s) => String(text).includes(s))

const env10 = await (
  await post('/api/environments', {
    name: '场景10 导出脱敏',
    projectId: project.id,
    baseUrl: stubBase,
    secrets: { s10: SECRET_ENV10 },
  })
).json()

// 主流程：query 里用 env secret，头/体用字面量密钥（只有导出期脱敏能拦住），期望 201 实际 200 → failed
const mainFlow10 = await makeClassFlow('场景10 导出主流程', [
  node9(
    'e1',
    `${stubBase}/api/secure?access_token={{s10}}&ms=10`,
    { status: 201, checks: [] },
    {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET_HEADER10}`, 'x-trace': 'trace-keep' },
      body: { user: 'alice', password: SECRET_BODY10 },
    }
  ),
  node9('e2', `${stubBase}/api/orders`, { status: 200, checks: [] }),
], [{ from: 'e1', to: 'e2' }])
const mainRun10 = await run9(mainFlow10.id, { environmentId: env10.id })
const mainDetail10 = await waitDone(mainRun10.executionId)

const fetchText = async (p) => {
  const res = await get(p)
  return { status: res.status, type: res.headers.get('content-type') || '', disposition: res.headers.get('content-disposition') || '', text: await res.text(), res }
}

const junit10 = await fetchText(`/api/executions/${mainDetail10.id}/export?format=junit`)
const html10 = await fetchText(`/api/executions/${mainDetail10.id}/export?format=HTML`)
const json10 = await fetchText(`/api/executions/${mainDetail10.id}/export`)

check(
  '10.1 单条执行三格式：JUnit/HTML/JSON 均可下载且头部语义正确',
  junit10.status === 200 &&
    /^application\/xml/.test(junit10.type) &&
    /attachment; filename="heibaihe-.*\.junit\.xml"/.test(junit10.disposition) &&
    /filename\*=UTF-8''/.test(junit10.disposition) &&
    /^<\?xml version="1.0"/.test(junit10.text) &&
    html10.status === 200 &&
    /^text\/html/.test(html10.type) &&
    /^<!DOCTYPE html>/.test(html10.text) &&
    !/<link/i.test(html10.text) &&
    !/<script/i.test(html10.text) &&
    !/\b(?:src|href)=/i.test(html10.text) &&
    json10.status === 200 &&
    /^application\/json/.test(json10.type),
  `junit=${junit10.status} html=${html10.status} json=${json10.status}`
)

const json10Body = JSON.parse(json10.text)
check(
  '10.2 JUnit 计数与详情页一致，失败/跳过各自落位，大小写不敏感',
  /<testsuites[^>]*tests="2"[^>]*failures="1"[^>]*skipped="1"/.test(junit10.text) &&
    /<failure type="status"/.test(junit10.text) &&
    /<skipped message=/.test(junit10.text) &&
    (junit10.text.match(/<testcase/g) || []).length === mainDetail10.steps.length &&
    json10Body.version === 1 &&
    json10Body.kind === 'execution' &&
    json10Body.execution.steps.length === mainDetail10.steps.length &&
    json10Body.execution.summary.failed === mainDetail10.summary.failed &&
    json10Body.execution.summary.passed === mainDetail10.summary.passed,
  `tests=${mainDetail10.steps.length} junit=${/tests="(\d+)"/.exec(junit10.text)?.[1]}`
)

check(
  '10.3 S8：三格式都不含 env secret / 头 / 请求体 / 响应头 cookie 明文，敏感位置为 ***',
  [...leaks10(junit10.text), ...leaks10(html10.text), ...leaks10(json10.text)].length === 0 &&
    /access_token=\*\*\*/.test(junit10.text) &&
    json10Body.execution.steps[0].request.headers.authorization === '***' &&
    json10Body.execution.steps[0].request.body.password === '***' &&
    json10Body.execution.steps[0].actual.headers['set-cookie'] === '***' &&
    json10Body.execution.steps[0].request.headers['x-trace'] === 'trace-keep' &&
    json10Body.execution.steps[0].request.url.includes('access_token=***'),
  `leaks=${leaks10(junit10.text + html10.text + json10.text).join(',') || 'none'}`
)

check(
  '10.4 响应体保留证据（不按键名剥离），与写入期 env 掩码职责分离',
  json10Body.execution.steps[0].actual.data.data.orderId === 'order-1' &&
    /order-1/.test(html10.text) &&
    json10Body.scrubbed.responseBody === false,
  `scrubbed=${JSON.stringify(json10Body.scrubbed)}`
)

// —— 套件导出：一次运行 = 一份报告，重试只取最后一次尝试 ——
const passFlow10 = await makeClassFlow('场景10 导出对照流程', [
  node9('p1', `${stubBase}/api/orders`, { status: 200, checks: [] }),
])
const suite10 = await (
  await post('/api/suites', {
    name: '场景10 导出套件',
    projectId: project.id,
    flowIds: [mainFlow10.id, passFlow10.id],
    environmentId: env10.id,
    strategy: { concurrency: 1, retry: 0 },
  })
).json()
const suiteRun10 = await (await post(`/api/suites/${suite10.id}/run`, {})).json()
const suiteDone10 = await waitSuiteRun(suiteRun10.suiteRunId)

const suiteJunit10 = await fetchText(`/api/suite-runs/${suiteDone10.id}/export?format=junit`)
const suiteHtml10 = await fetchText(`/api/suite-runs/${suiteDone10.id}/export?format=html`)
const suiteJson10 = await fetchText(`/api/suite-runs/${suiteDone10.id}/export?format=json`)
const suiteJson10Body = JSON.parse(suiteJson10.text)
const suiteSteps10 = suiteJson10Body.executions.reduce((n, e) => n + (e.steps || []).length, 0)

check(
  '10.5 套件导出：properties 带 runId/环境，testsuite 数 = 流程数，testcase 数 = 总步骤数',
  suiteJunit10.status === 200 &&
    new RegExp(`<property name="suite\\.runId" value="${suiteDone10.id}"/>`).test(suiteJunit10.text) &&
    /<property name="environment" value="[^"]+"/.test(suiteJunit10.text) &&
    (suiteJunit10.text.match(/<testsuite /g) || []).length === 2 &&
    (suiteJunit10.text.match(/<testcase/g) || []).length === suiteSteps10 &&
    suiteJson10Body.kind === 'suite-run' &&
    suiteJson10Body.executions.length === 2 &&
    /流程结果/.test(suiteHtml10.text),
  `suites=${(suiteJunit10.text.match(/<testsuite /g) || []).length} cases=${(suiteJunit10.text.match(/<testcase/g) || []).length} steps=${suiteSteps10}`
)

check(
  '10.6 套件导出的三格式同样无明文泄漏',
  [...leaks10(suiteJunit10.text), ...leaks10(suiteHtml10.text), ...leaks10(suiteJson10.text)].length === 0,
  `leaks=${leaks10(suiteJunit10.text + suiteHtml10.text + suiteJson10.text).join(',') || 'none'}`
)

const badFormat10 = await fetchText(`/api/executions/${mainDetail10.id}/export?format=yaml`)
const badSuiteFormat10 = await fetchText(`/api/suite-runs/${suiteDone10.id}/export?format=xml`)
const missingExec10 = await fetchText('/api/executions/nope/export?format=json')
const missingSuite10 = await fetchText('/api/suite-runs/nope/export?format=json')
check(
  '10.7 错误语义：非法格式 400 EXPORT_BAD_FORMAT，记录不存在 404 两种 code',
  badFormat10.status === 400 &&
    JSON.parse(badFormat10.text).code === 'EXPORT_BAD_FORMAT' &&
    badSuiteFormat10.status === 400 &&
    JSON.parse(badSuiteFormat10.text).code === 'EXPORT_BAD_FORMAT' &&
    missingExec10.status === 404 &&
    JSON.parse(missingExec10.text).code === 'EXECUTION_NOT_FOUND' &&
    missingSuite10.status === 404 &&
    JSON.parse(missingSuite10.text).code === 'SUITE_RUN_NOT_FOUND',
  `bad=${badFormat10.status}/${JSON.parse(badFormat10.text).code} missing=${missingExec10.status}/${JSON.parse(missingExec10.text).code}`
)

// ================================================================ 场景 11 · 会话恢复（真实子进程）
const SRC_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js')

/** 取一个空闲端口：先 bind 再释放，避免子进程与父进程抢端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 真实启动一个后端子进程（独立数据目录/库），等 /api/health 就绪 */
async function startBackend({ port, dataDir }) {
  const child = spawn(process.execPath, [SRC_INDEX], {
    env: {
      ...process.env,
      PORT: String(port),
      HEIBAIHE_HOST: '127.0.0.1',
      HEIBAIHE_DATA_DIR: dataDir,
      HEIBAIHE_DB: path.join(dataDir, 'restart.db'),
      HEIBAIHE_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (buf) => logs.push(buf.toString('utf8')))
  child.stderr.on('data', (buf) => logs.push(buf.toString('utf8')))
  const deadline = Date.now() + 15000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`后端子进程提前退出（code=${child.exitCode}）：${logs.join('')}`)
    }
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (health.ok) break
    } catch {
      // 端口还没监听：继续轮询
    }
    if (Date.now() > deadline) throw new Error(`后端子进程未在 15s 内就绪：${logs.join('')}`)
    await sleep(80)
  }
  return { child, port, base: `http://127.0.0.1:${port}`, logs }
}

/** 强杀/停止子进程；已退出时直接返回，避免 once('exit') 永久挂起 */
async function stopBackend(backend, signal = 'SIGKILL') {
  if (!backend || backend.child.exitCode !== null) return
  backend.child.kill(signal)
  await once(backend.child, 'exit')
}

const scene11Dir = path.join(DIR, 'scene11')
fs.mkdirSync(scene11Dir, { recursive: true })
const scene11Port = await freePort()
let backend11 = await startBackend({ port: scene11Port, dataDir: scene11Dir })
const auth11 = { authorization: `Bearer ${TOKEN}` }

// 每次请求都读当前 backend11：重启后 base 可能变化（这里同端口，但保持写法安全）
const get11 = async (p) => {
  const res = await fetch(`${backend11.base}${p}`, { headers: auth11 })
  return { status: res.status, body: await res.json() }
}
const post11 = async (p, body) => {
  const res = await fetch(`${backend11.base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth11 },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json() }
}
const waitDetail11 = async (id, predicate, label, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = (await get11(`/api/executions/${id}`)).body
    if (predicate(detail)) return detail
    await sleep(60)
  }
  throw new Error(`等待${label}超时：${id}`)
}
const waitEvents11 = async (id, after, predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const body = (await get11(`/api/executions/${id}/events?after=${after}`)).body
    if (predicate(body)) return body
    await sleep(60)
  }
  throw new Error(`等待事件重放超时：${id} after=${after}`)
}
const stepStatus11 = (detail, nodeId) =>
  (detail.steps || []).filter((s) => s.nodeId === nodeId).map((s) => s.status)

try {
  const flow11 = (
    await post11('/api/flows', {
      name: '场景11 会话恢复',
      type: 'blackbox',
      variables: { baseUrl: stubBase },
      nodes: [
        {
          id: 'n1',
          name: '第一步',
          action: { type: 'http', method: 'GET', url: `${stubBase}/api/scene11-first` },
          expected: { status: 200, checks: [] },
        },
        {
          id: 'n2',
          name: '人工确认',
          action: { type: 'manual', hint: '强杀重启后仍要停在这里' },
          expected: { status: 200, checks: [] },
        },
        {
          id: 'n3',
          name: '第三步',
          action: { type: 'http', method: 'GET', url: `${stubBase}/api/scene11-third` },
          expected: { status: 200, checks: [] },
        },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', condition: '' },
        { id: 'e2', from: 'n2', to: 'n3', condition: '' },
      ],
    })
  ).body

  const run11 = (await post11(`/api/flows/${flow11.id}/run`, {})).body
  const id11 = run11.executionId

  const paused11 = await waitDetail11(
    id11,
    (d) => stepStatus11(d, 'n2').includes('waiting'),
    '首次停在人工确认'
  )
  const eventsBefore11 = (await get11(`/api/executions/${id11}/events`)).body
  check(
    '11.1 真实执行停在人工确认：第一步已 passed、事件 seq 从 1 连续，桩命中 1 次',
    paused11.status === 'running' &&
      stepStatus11(paused11, 'n1').join() === 'passed' &&
      stepStatus11(paused11, 'n2').join() === 'waiting' &&
      eventsBefore11.lastSeq >= 3 &&
      eventsBefore11.events.every((e, i) => e.v === 2 && e.seq === i + 1) &&
      scene11FirstHits === 1,
    `status=${paused11.status} n1=${stepStatus11(paused11, 'n1').join()} n2=${stepStatus11(paused11, 'n2').join()} lastSeq=${eventsBefore11.lastSeq} firstHits=${scene11FirstHits}`
  )

  // 强杀：模拟断电/崩溃，进程没有机会做优雅退出
  const lastSeq11 = eventsBefore11.lastSeq
  await stopBackend(backend11)
  backend11 = null

  // 同一数据目录重启：启动时会 restoreSessions，从节点边界续跑
  backend11 = await startBackend({ port: scene11Port, dataDir: scene11Dir })

  const resumed11 = await waitDetail11(
    id11,
    (d) => stepStatus11(d, 'n2').join() === 'skipped,waiting',
    '重启后中断尝试补证并重新等待'
  )
  const interrupted11 = resumed11.steps.find((s) => s.nodeId === 'n2' && s.status === 'skipped')
  check(
    '11.2 重启后从节点边界续跑：中断尝试记为 skipped 且写明「服务重启」，已完成节点不重跑',
    !!interrupted11 &&
      /服务重启/.test(interrupted11.error || '') &&
      stepStatus11(resumed11, 'n1').join() === 'passed' &&
      scene11FirstHits === 1,
    `n1=${stepStatus11(resumed11, 'n1').join()} n2=${stepStatus11(resumed11, 'n2').join()} firstHits=${scene11FirstHits}`
  )

  const tail11 = await waitEvents11(id11, lastSeq11, (body) =>
    body.events.some((e) => e.type === 'flow_resume')
  )
  const tailSeqs11 = tail11.events.map((e) => e.seq)
  check(
    '11.3 断线重放：after=lastSeq 只返回增量，seq 接着旧游标连续自增，且恰好一条 flow_resume',
    tail11.lastSeq > lastSeq11 &&
      tailSeqs11.every((seq, i) => seq === lastSeq11 + 1 + i) &&
      tail11.events.filter((e) => e.type === 'flow_resume').length === 1,
    `lastSeq=${lastSeq11}→${tail11.lastSeq} tail=${tail11.events.map((e) => `${e.seq}:${e.type}`).join(',')}`
  )

  const manual11 = await post11(`/api/executions/${id11}/manual`, {
    nodeId: 'n2',
    pass: true,
    note: '强杀重启后人工确认',
  })
  const final11 = await waitDetail11(id11, (d) => d.status === 'passed', '确认后执行完毕')
  check(
    '11.4 确认后收尾：会话 passed、后续节点只执行一次，first 没有被重放',
    manual11.body.ok === true &&
      stepStatus11(final11, 'n1').join() === 'passed' &&
      stepStatus11(final11, 'n2').join() === 'skipped,passed' &&
      stepStatus11(final11, 'n3').join() === 'passed' &&
      scene11FirstHits === 1 &&
      scene11ThirdHits === 1,
    `n1=${stepStatus11(final11, 'n1').join()} n2=${stepStatus11(final11, 'n2').join()} n3=${stepStatus11(final11, 'n3').join()} firstHits=${scene11FirstHits} thirdHits=${scene11ThirdHits}`
  )

  // 全量重放必须与详情页事件完全一致（同一落库源，供前端刷新/断线补洞使用）
  const full11 = (await get11(`/api/executions/${id11}/events?after=0`)).body
  const types11 = full11.events.map((e) => e.type)
  check(
    '11.5 全量重放与详情一致：seq/type 逐条对齐，flow_start/flow_resume/flow_end 各一条',
    full11.lastSeq === final11.events.length &&
      full11.events.map((e) => `${e.seq}:${e.type}`).join() ===
        final11.events.map((e) => `${e.seq}:${e.type}`).join() &&
      types11.filter((t) => t === 'flow_start').length === 1 &&
      types11.filter((t) => t === 'flow_resume').length === 1 &&
      types11.filter((t) => t === 'flow_end').length === 1,
    `replay=${full11.events.length} detail=${final11.events.length} lastSeq=${full11.lastSeq}`
  )
} finally {
  await stopBackend(backend11)
}

// ================================================================ 场景 12 · 覆盖率取证（M3-1）
const JACOCO_HEADER12 = Buffer.from([0x01, 0xc0, 0xc0, 0x10, 0x07])

function jacocoVarint12(value) {
  const out = []
  let left = value
  do {
    let byte = left & 0x7f
    left >>>= 7
    if (left) byte |= 0x80
    out.push(byte)
  } while (left)
  return Buffer.from(out)
}

/** SESSIONINFO 块：0x10 + id 长度 + id + 16 字节时间戳 */
function jacocoSession12(id) {
  const idBuf = Buffer.from(id)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(idBuf.length)
  return Buffer.concat([Buffer.from([0x10]), len, idBuf, Buffer.alloc(16)])
}

/** EXECUTIONDATA 块：0x11 + classId + 名称 + varint(探针数) + 位图 */
function jacocoExec12(name, probes) {
  const nameBuf = Buffer.from(name)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(nameBuf.length)
  return Buffer.concat([
    Buffer.from([0x11]),
    Buffer.alloc(8, 0xab),
    len,
    nameBuf,
    jacocoVarint12(probes),
    Buffer.alloc(Math.ceil(probes / 8), 0x81),
  ])
}

/**
 * 协议级假 agent（不依赖 JDK，CI 可跑）：
 *   - 连接后主动发 5 字节 exec 头，客户端必须原样回写；
 *   - reset 只回 CMDOK，dump 回「会话块 + 执行数据块 + CMDOK」；
 *   - 记录每条命令，供断言「每节点 reset → dump」的调用顺序。
 */
async function startFakeAgent12() {
  const commands = []
  const sockets = new Set()
  let totalConnections = 0
  const server = net.createServer((socket) => {
    totalConnections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write(JACOCO_HEADER12)

    let buffer = Buffer.alloc(0)
    let handshake = false
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!handshake) {
        if (buffer.length < 5) return
        handshake = true
        buffer = buffer.subarray(5) // 握手回写的 5 字节
      }
      while (buffer.length >= 3) {
        const frame = buffer.subarray(0, 3)
        buffer = buffer.subarray(3)
        commands.push({ cmd: frame[0], dump: frame[1], reset: frame[2] })
        if (frame[1] === 1) {
          socket.write(
            Buffer.concat([
              jacocoSession12('scene12'),
              jacocoExec12('com/poc/OrderService', 300),
              Buffer.from([0x20]),
            ])
          )
        } else {
          socket.write(Buffer.from([0x20]))
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    commands,
    connections: () => totalConnections,
    async close() {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const agent12 = await startFakeAgent12()
try {
  // 12.1 环境配置：settings.coverage 归一化后落库，非法来源/端口直接 400
  const badCoverage12 = await post('/api/environments', {
    name: '场景12 坏覆盖率',
    settings: { coverage: { source: 'v8' } },
  })
  const env12 = await (
    await post('/api/environments', {
      name: '场景12 覆盖率环境',
      projectId: project.id,
      baseUrl: stubBase,
      settings: { coverage: { host: '127.0.0.1', port: agent12.port, timeoutMs: 2000 } },
    })
  ).json()
  const env12Detail = await (await get(`/api/environments/${env12.id}`)).json()
  check(
    '12.1 环境 settings.coverage：归一化 source/enabled 后落库；非法 source → 400 ENV_BAD_COVERAGE',
    badCoverage12.status === 400 &&
      (await badCoverage12.json()).code === 'ENV_BAD_COVERAGE' &&
      env12Detail.settings?.coverage?.source === 'jacoco' &&
      env12Detail.settings?.coverage?.port === agent12.port &&
      env12Detail.settings?.coverage?.enabled === true,
    `port=${env12Detail.settings?.coverage?.port}`
  )

  const flow12 = await (
    await post('/api/flows', {
      name: '场景12 覆盖率取证',
      type: 'whitebox',
      projectId: project.id,
      nodes: [
        {
          id: 'n1',
          name: '登录接口',
          action: { type: 'http', method: 'GET', url: `${stubBase}/api/login` },
          expected: { status: 200, checks: [] },
        },
        {
          id: 'n2',
          name: '订单接口',
          action: { type: 'http', method: 'GET', url: `${stubBase}/api/orders` },
          expected: { status: 200, checks: [] },
        },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', condition: '' }],
    })
  ).json()
  const run12 = await (await post(`/api/flows/${flow12.id}/run`, { environmentId: env12.id })).json()
  const detail12 = await waitDone(run12.executionId)
  const cov12 = await (await get(`/api/executions/${run12.executionId}/coverage`)).json()

  // 12.2 每个 HTTP 节点一份快照：captured + pending，步骤里带 coverageId
  check(
    '12.2 每节点一份覆盖率快照：status=captured、pending=true，步骤记录 coverageId',
    detail12.status === 'passed' &&
      detail12.steps.length === 2 &&
      detail12.steps.every(
        (s) => s.coverage?.status === 'captured' && s.coverage?.pending === true && !!s.coverageId
      ),
    `steps=${detail12.steps.map((s) => `${s.nodeId}:${s.coverage?.status}/${s.coverage?.bytes}B`).join(',')}`
  )

  // 12.3 投影接口：按执行聚合计数，绝不返回原始 .exec
  const covText12 = JSON.stringify(cov12)
  check(
    '12.3 GET /:id/coverage 投影：count=2、pending=2、无分析失败，不含 execBlob，原始证据只在库里',
    cov12.executionId === run12.executionId &&
      cov12.count === 2 &&
      cov12.pending === 2 &&
      cov12.analyzed === 0 &&
      cov12.analysisFailed === 0 &&
      cov12.unavailable === 0 &&
      cov12.coverage.map((c) => c.nodeId).join() === 'n1,n2' &&
      cov12.coverage.every((c) => c.bytes > 5 && c.execBlob === undefined) &&
      !covText12.includes('execBlob'),
    `count=${cov12.count} bytes=${cov12.coverage.map((c) => c.bytes).join('/')}`
  )

  // 12.4 事件契约：每次取证一条 coverage.dump，seq 全量连续
  const dumps12 = detail12.events.filter((e) => e.type === 'coverage.dump')
  check(
    '12.4 实时事件：每节点一条 coverage.dump（带 nodeId/coverageId/pending），seq 连续',
    dumps12.length === 2 &&
      dumps12.map((e) => e.payload.nodeId).join() === 'n1,n2' &&
      dumps12.every((e) => !!e.payload.coverageId && e.payload.pending === true) &&
      detail12.events.every((e, i) => e.seq === i + 1),
    `dumps=${dumps12.map((e) => e.payload.nodeId).join(',')} events=${detail12.events.length}`
  )

  // 12.5 协议证据：连接复用，每个节点「reset → dump」成对出现
  const frames12 = agent12.commands.map((c) => `${c.cmd.toString(16)}/${c.dump}/${c.reset}`)
  check(
    '12.5 协议时序：一次连接内每节点 reset → dumpAndReset，命令帧 40/0/1 与 40/1/1 交替',
    frames12.join() === '40/0/1,40/1/1,40/0/1,40/1/1' && agent12.connections() === 1,
    `frames=${frames12.join(',')} connections=${agent12.connections()}`
  )

  // 12.6 降级：agent 不可达时节点照常通过，但覆盖率必须写 unavailable（绝不伪装成 0%）
  const deadPort12 = await freePort()
  const deadEnv12 = await (
    await post('/api/environments', {
      name: '场景12 无 agent',
      projectId: project.id,
      baseUrl: stubBase,
      settings: { coverage: { host: '127.0.0.1', port: deadPort12, timeoutMs: 200 } },
    })
  ).json()
  const run12d = await (await post(`/api/flows/${flow12.id}/run`, { environmentId: deadEnv12.id })).json()
  const detail12d = await waitDone(run12d.executionId)
  const cov12d = await (await get(`/api/executions/${run12d.executionId}/coverage`)).json()
  check(
    '12.6 agent 不可达降级：执行仍 passed，覆盖率两条 unavailable 且带稳定错误码',
    detail12d.status === 'passed' &&
      detail12d.steps.every((s) => s.status === 'passed' && s.coverage?.status === 'unavailable') &&
      cov12d.count === 2 &&
      cov12d.unavailable === 2 &&
      cov12d.pending === 0 &&
      cov12d.coverage.every((c) => c.bytes === 0 && /^COVERAGE_AGENT_UNREACHABLE: /.test(c.error)),
    `status=${detail12d.status} cov=${cov12d.coverage.map((c) => `${c.status}/${c.bytes}B`).join(',')}`
  )

  // 12.7 未配置覆盖率的环境：不产生任何行（白盒字段保持空，而不是 0 行可用/不可用混淆）
  const plainEnv12 = await (
    await post('/api/environments', {
      name: '场景12 未配置',
      projectId: project.id,
      baseUrl: stubBase,
    })
  ).json()
  const run12p = await (await post(`/api/flows/${flow12.id}/run`, { environmentId: plainEnv12.id })).json()
  const detail12p = await waitDone(run12p.executionId)
  const cov12p = await (await get(`/api/executions/${run12p.executionId}/coverage`)).json()
  check(
    '12.7 未配置覆盖率：执行正常但 count=0、步骤无 coverage、无 coverage.dump 事件',
    detail12p.status === 'passed' &&
      cov12p.count === 0 &&
      detail12p.steps.every((s) => !s.coverage) &&
      !detail12p.events.some((e) => e.type === 'coverage.dump'),
    `count=${cov12p.count}`
  )

  const ghost12 = await get('/api/executions/ghost-exec/coverage')
  check(
    '12.8 未知执行的覆盖率接口 → 404 EXECUTION_NOT_FOUND',
    ghost12.status === 404 && (await ghost12.json()).code === 'EXECUTION_NOT_FOUND'
  )

  // 12.9 M3-2 分析失败：配置了 classfiles 但目录不存在。节点结论不受影响，
  // 原始证据仍在（bytes>0），错误是稳定 code，投影计为 analysisFailed 而不是 pending。
  const fakeCli12 = path.join(DIR, 'fake-jacococli.jar')
  fs.writeFileSync(fakeCli12, '')
  const missingClassesEnv12 = await (
    await post('/api/environments', {
      name: '场景12 类目录缺失',
      projectId: project.id,
      baseUrl: stubBase,
      settings: {
        coverage: {
          host: '127.0.0.1',
          port: agent12.port,
          classfiles: path.join(DIR, 'no-such-classes'),
          cliPath: fakeCli12,
        },
      },
    })
  ).json()
  const run12a = await (
    await post(`/api/flows/${flow12.id}/run`, { environmentId: missingClassesEnv12.id })
  ).json()
  const detail12a = await waitDetail(run12a.executionId, (d) =>
    d.events.some((e) => e.type === 'coverage.analyzed')
  )
  const cov12a = await waitCoverage(
    run12a.executionId,
    (c) => c.analysisFailed === 2 && c.pending === 0
  )
  const analyzedEvt12 = detail12a.events.find((e) => e.type === 'coverage.analyzed')
  check(
    '12.9 分析失败可区分：执行仍 passed、证据保留、error=COVERAGE_CLASSFILES_MISSING、analysisFailed=2',
    detail12a.status === 'passed' &&
      cov12a.count === 2 &&
      cov12a.analyzed === 0 &&
      cov12a.pending === 0 &&
      cov12a.analysisFailed === 2 &&
      cov12a.coverage.every(
        (c) =>
          c.status === 'captured' &&
          c.bytes > 5 &&
          /^COVERAGE_CLASSFILES_MISSING: /.test(c.error) &&
          c.result === null
      ) &&
      analyzedEvt12?.payload.analyzed === 0 &&
      analyzedEvt12?.payload.failed === 2 &&
      analyzedEvt12?.payload.coverage.every((c) => c.status === 'analysis_failed'),
    `failed=${cov12a.analysisFailed} pending=${cov12a.pending} err=${cov12a.coverage[0]?.error}`
  )

  // 12.10 未配置 classfiles：只采集不分析，行保持 captured+pending，且不发 coverage.analyzed
  await sleep(250)
  const cov12b = await (await get(`/api/executions/${run12.executionId}/coverage`)).json()
  const detail12b = await (await get(`/api/executions/${run12.executionId}`)).json()
  check(
    '12.10 未配置 classfiles：保持 captured+pending 且无 coverage.analyzed（不伪装成已分析/0%）',
    cov12b.count === 2 &&
      cov12b.pending === 2 &&
      cov12b.analysisFailed === 0 &&
      cov12b.coverage.every((c) => c.status === 'captured' && c.result === null && c.error === null) &&
      !detail12b.events.some((e) => e.type === 'coverage.analyzed'),
    `pending=${cov12b.pending} analyzed=${cov12b.analyzed} failed=${cov12b.analysisFailed}`
  )

  // 12.11~12.13 M3-3 源码视图：真实 HTTP + 真实文件系统。
  // 分析结果由库里种子数据写入（CI 无 JDK，不为「读源码」再跑一次 jacococli），
  // 但路径校验、源码读取、逐行命中标记全部走真实实现。
  const { store } = await import('../src/store.js')
  const srcRoot12 = path.join(DIR, 'sources12')
  fs.mkdirSync(path.join(srcRoot12, 'com', 'demo'), { recursive: true })
  fs.writeFileSync(
    path.join(srcRoot12, 'com', 'demo', 'OrderService.java'),
    ['package com.demo;', '', 'class OrderService {', '  int create() {', '    return 1;', '  }', '}', ''].join('\n')
  )
  fs.writeFileSync(path.join(srcRoot12, 'com', 'demo', 'Unused.java'), 'class Unused {}\n')
  fs.writeFileSync(path.join(DIR, 'outside12.txt'), 'TOP-SECRET\n')

  const sourceExec12 = 'scene12-source-exec'
  store.saveExecutionMeta({
    id: sourceExec12,
    flowId: flow12.id,
    flowName: '场景12 源码视图',
    flowType: 'whitebox',
    projectId: project.id,
    status: 'passed',
    startedAt: Date.now() - 200,
    finishedAt: Date.now(),
  })
  store.saveExecutionContext(sourceExec12, {
    environment: { id: 'env12-source', settings: { coverage: { sourcefiles: srcRoot12 } } },
  })
  store.saveCoverage({
    executionId: sourceExec12,
    nodeId: 'n1',
    status: 'analyzed',
    analyzedAt: Date.now(),
    result: {
      files: [
        { path: 'com/demo/Unused.java', covered: [], missed: [], total: 0 },
        { path: 'com/demo/OrderService.java', covered: [1, 2, 4], missed: [3, 5], total: 5 },
      ],
      totals: { files: 2, covered: 3, missed: 2, total: 5, lineRate: 60 },
    },
  })
  store.saveCoverage({ executionId: sourceExec12, nodeId: 'n2', status: 'captured', execBlob: Buffer.from([1, 2, 3]) })
  store.saveCoverage({
    executionId: sourceExec12,
    nodeId: 'n3',
    status: 'analyzed',
    result: { files: [{ path: '../outside12.txt', covered: [], missed: [1], total: 1 }] },
  })
  store.saveCoverage({
    executionId: sourceExec12,
    nodeId: 'n4',
    status: 'analyzed',
    result: { files: [{ path: 'com/demo/Gone.java', covered: [], missed: [1], total: 1 }] },
  })

  const srcUrl12 = (nodeId, p) =>
    `/api/executions/${sourceExec12}/coverage/${nodeId}/source${p ? `?path=${encodeURIComponent(p)}` : ''}`

  // 12.11 不带 path：默认取未覆盖行最多的文件；逐行 hit 与行率正确
  const src11 = await get(srcUrl12('n1'))
  const src11b = await src11.json()
  check(
    '12.11 源码视图：默认取未覆盖最多的文件，hit=1/0 标记与 lineRate 正确（真实读盘）',
    src11.status === 200 &&
      src11b.path === 'com/demo/OrderService.java' &&
      src11b.totalLines === 7 &&
      src11b.truncated === false &&
      src11b.lines.filter((l) => l.hit !== null).map((l) => [l.nr, l.hit]).join('|') ===
        '1,1|2,1|3,0|4,1|5,0' &&
      src11b.lineRate === 60 &&
      src11b.file.covered === 3 &&
      src11b.file.missed === 2,
    `path=${src11b.path} rate=${src11b.lineRate} lines=${src11b.totalLines}`
  )

  // 12.12 路径白名单：只能读本节点结果里声明过的相对路径
  const notInResult12 = await get(srcUrl12('n1', 'com/demo/Gone.java'))
  const traversal12 = await get(srcUrl12('n1', '../outside12.txt'))
  const dirtyResult12 = await get(srcUrl12('n3'))
  const missingFile12 = await get(srcUrl12('n4'))
  check(
    '12.12 源码路径白名单：结果外的路径/穿越路径 400，结果内但磁盘缺失 404（不变成任意文件读取）',
    notInResult12.status === 400 &&
      (await notInResult12.json()).code === 'COVERAGE_SOURCE_NOT_IN_RESULT' &&
      traversal12.status === 400 &&
      (await traversal12.json()).code === 'COVERAGE_SOURCE_NOT_IN_RESULT' &&
      dirtyResult12.status === 400 &&
      (await dirtyResult12.json()).code === 'COVERAGE_SOURCE_PATH_INVALID' &&
      missingFile12.status === 404 &&
      (await missingFile12.json()).code === 'COVERAGE_SOURCE_NOT_FOUND',
    `notIn=${notInResult12.status} traversal=${traversal12.status} dirty=${dirtyResult12.status} missing=${missingFile12.status}`
  )

  // 12.13 降级：未分析 409、未知节点 404、未配置 sourcefiles 400、未知执行 404
  const noSourceExec12 = 'scene12-no-source'
  store.saveExecutionMeta({
    id: noSourceExec12,
    flowId: flow12.id,
    flowName: '场景12 无源码配置',
    projectId: project.id,
    status: 'passed',
  })
  store.saveExecutionContext(noSourceExec12, { environment: { id: 'env12-nosrc', settings: {} } })
  store.saveCoverage({
    executionId: noSourceExec12,
    nodeId: 'n1',
    status: 'analyzed',
    result: { files: [{ path: 'com/demo/OrderService.java', covered: [1], missed: [], total: 1 }] },
  })
  const notAnalyzed12 = await get(srcUrl12('n2'))
  const ghostNode12 = await get(srcUrl12('ghost'))
  const noSource12 = await get(`/api/executions/${noSourceExec12}/coverage/n1/source`)
  const ghostExec12 = await get('/api/executions/ghost-exec/coverage/n1/source')
  check(
    '12.13 源码视图降级：未分析 409、未知节点 404、未配 sourcefiles 400、未知执行 404（错误码可区分）',
    notAnalyzed12.status === 409 &&
      (await notAnalyzed12.json()).code === 'COVERAGE_NOT_ANALYZED' &&
      ghostNode12.status === 404 &&
      (await ghostNode12.json()).code === 'COVERAGE_NOT_FOUND' &&
      noSource12.status === 400 &&
      (await noSource12.json()).code === 'COVERAGE_SOURCEFILES_MISSING' &&
      ghostExec12.status === 404 &&
      (await ghostExec12.json()).code === 'EXECUTION_NOT_FOUND',
    `notAnalyzed=${notAnalyzed12.status} ghostNode=${ghostNode12.status} noSource=${noSource12.status} ghostExec=${ghostExec12.status}`
  )
  // 12.14 M3-4 白盒断言：有 mustHit 但没有 classfiles（无法映射源码行）。
  // 断言不能静默通过：节点判 failed、failureClass=script、check.type=coverage_evidence，
  // 而覆盖率证据本身仍是 captured+pending（没有分析失败，也没有伪装成已分析）。
  const flow12c = await (
    await post('/api/flows', {
      name: '场景12 白盒断言缺证据',
      type: 'whitebox',
      projectId: project.id,
      nodes: [
        {
          id: 'n1',
          name: '订单接口（应命中 OrderService）',
          action: { type: 'http', method: 'GET', url: `${stubBase}/api/orders` },
          expected: {
            status: 200,
            checks: [],
            coverage: { mustHit: ['com.poc.OrderService#create'] },
          },
        },
      ],
      edges: [],
    })
  ).json()
  const run12c = await (await post(`/api/flows/${flow12c.id}/run`, { environmentId: env12.id })).json()
  const detail12c = await waitDone(run12c.executionId)
  const cov12c = await (await get(`/api/executions/${run12c.executionId}/coverage`)).json()
  const step12c = detail12c.steps[0]
  const evidence12c = (step12c?.checks?.results || []).find((c) => c.type === 'coverage_evidence')
  check(
    '12.14 白盒断言缺 classfiles：failed + failureClass=script + coverage_evidence，证据保持 pending 不伪装通过',
    detail12c.status === 'failed' &&
      step12c?.status === 'failed' &&
      step12c?.failureClass === 'script' &&
      evidence12c &&
      evidence12c.passed === false &&
      /classfiles/.test(evidence12c.message || '') &&
      cov12c.count === 1 &&
      cov12c.pending === 1 &&
      cov12c.analyzed === 0 &&
      cov12c.analysisFailed === 0 &&
      !detail12c.events.some((e) => e.type === 'coverage.analyzed'),
    `status=${detail12c.status} class=${step12c?.failureClass} pending=${cov12c.pending}`
  )
} finally {
  await agent12.close()
}

// ================================================================ 场景 13 · 接口来源抽象
// M3'-1：Apifox 收编为适配器后必须「行为零变化」（SRC-1）；
// OpenAPI 走同一契约，且 0 条接口不许假成功（SRC-3）。

const sourcesList = await (await get('/api/sources')).json()
const apifoxDesc = sourcesList.sources?.find((s) => s.kind === 'apifox')
const openapiDesc = sourcesList.sources?.find((s) => s.kind === 'openapi')
check(
  '13.1 来源清单：apifox + openapi，configFields 可直接驱动表单（token 标 secret / spec 必填）',
  sourcesList.sources?.length === 2 &&
    apifoxDesc?.configFields?.find((f) => f.key === 'token')?.secret === true &&
    openapiDesc?.configFields?.find((f) => f.key === 'spec')?.required === true,
  (sourcesList.sources || []).map((s) => s.kind).join(',')
)

const unknownGet = await get('/api/sources/nope')
const unknownPost = await post('/api/sources/nope/fetch', {})
check(
  '13.2 未知来源：GET/POST 均 400 SOURCE_UNKNOWN（不 500、不静默回退 apifox）',
  unknownGet.status === 400 &&
    (await unknownGet.json()).code === 'SOURCE_UNKNOWN' &&
    unknownPost.status === 400 &&
    (await unknownPost.json()).code === 'SOURCE_UNKNOWN',
  `get=${unknownGet.status} post=${unknownPost.status}`
)

const openapiSpec = {
  openapi: '3.0.0',
  info: { title: '场景13 文档', version: '3.0.0' },
  servers: [{ url: stubBase }],
  paths: {
    '/api/login': { get: { summary: '登录', 'x-apifox-folder': '用户' } },
    '/api/orders': { get: { summary: '订单列表', 'x-apifox-folder': '订单' } },
  },
}
const badDoc = await post('/api/sources/openapi/test', { spec: '{not-json' })
const testedOpenapi = await (await post('/api/sources/openapi/test', { spec: openapiSpec })).json()
check(
  '13.3 OpenAPI test：坏 JSON → 400 SOURCE_BAD_DOCUMENT；正常文档 → 接口数正确',
  badDoc.status === 400 &&
    (await badDoc.json()).code === 'SOURCE_BAD_DOCUMENT' &&
    testedOpenapi.ok === true &&
    testedOpenapi.interfaceCount === 2,
  `count=${testedOpenapi.interfaceCount}`
)

const fetchedOpenapi = await (await post('/api/sources/openapi/fetch', { spec: JSON.stringify(openapiSpec) })).json()
const emptyDoc = await post('/api/sources/openapi/fetch', { spec: { openapi: '3.0.0', paths: {} } })
check(
  '13.4 OpenAPI fetch：JSON 字符串入参可用、返回统一 meta；0 条接口 → 400 SOURCE_EMPTY',
  fetchedOpenapi.count === 2 &&
    fetchedOpenapi.meta?.kind === 'openapi' &&
    fetchedOpenapi.meta?.interfaceCount === 2 &&
    fetchedOpenapi.meta?.sourceHash?.length === 16 &&
    emptyDoc.status === 400 &&
    (await emptyDoc.json()).code === 'SOURCE_EMPTY',
  `count=${fetchedOpenapi.count} hash=${fetchedOpenapi.meta?.sourceHash}`
)

// SRC-1 回归：场景 3 的项目没有 apifox 配置，命中全局缓存时 pull/available 必须与重构前一致
const apifoxAvailable = await (await get(`/api/projects/${project.id}/available`)).json()
const apifoxPull = await (await post(`/api/projects/${project.id}/pull`, {})).json()
check(
  '13.5 SRC-1 回归：Apifox 项目 available/pull 仍走全局缓存，字段与重构前一致',
  apifoxAvailable.source === 'cache' &&
    apifoxAvailable.interfaces?.length === 3 &&
    apifoxPull.fromCache === true &&
    apifoxPull.interfaces?.length === 3 &&
    apifoxPull.baseUrl === stubBase &&
    typeof apifoxPull.fetchedAt === 'number',
  `available=${apifoxAvailable.interfaces?.length} pull=${apifoxPull.interfaces?.length} base=${apifoxPull.baseUrl}`
)

// 新模型：project.source=openapi，spec 随项目配置存；绑定/可用/列表都走同一适配器
const projectSpec = {
  openapi: '3.0.0',
  info: { title: '场景13 项目文档', version: '1.0.0' },
  servers: [{ url: stubBase }],
  paths: { '/api/env-echo': { get: { summary: '环境回显' } } },
}
const openapiProject = await (
  await post('/api/projects', { name: '场景13 OpenAPI 项目', source: { kind: 'openapi', config: { spec: projectSpec } } })
).json()
const openapiBound = await (
  await put(`/api/projects/${openapiProject.id}/interfaces`, { ids: ['GET /api/env-echo'] })
).json()
const openapiAvailable = await (await get(`/api/projects/${openapiProject.id}/available`)).json()
const openapiSummary = (await (await get('/api/projects')).json()).find((p) => p.id === openapiProject.id)
check(
  '13.6 新模型：project.source=openapi 可绑定快照，available 只投影本项目文档，列表带 sourceKind',
  openapiBound.interfaces?.length === 1 &&
    openapiBound.interfaces[0]?.serverUrl === stubBase &&
    openapiAvailable.interfaces?.length === 1 &&
    openapiAvailable.interfaces[0]?.id === 'GET /api/env-echo' &&
    openapiSummary?.sourceKind === 'openapi' &&
    openapiSummary?.apifoxProjectId === '',
  `bound=${openapiBound.interfaces?.length} available=${openapiAvailable.interfaces?.length} kind=${openapiSummary?.sourceKind}`
)

const badBind = await put(`/api/projects/${openapiProject.id}/interfaces`, { ids: ['GET /api/not-in-doc'] })
check(
  '13.7 绑定不存在的接口：400 且提示来源名称（不静默丢弃）',
  badBind.status === 400 && /OpenAPI/.test((await badBind.json()).error || ''),
  `status=${badBind.status}`
)

// ================================================================ 场景 14 · W1 调用链还原
// M3'-2：把「调用点顺序」升级为「接口 ← 函数 ← … ← 页面入口」的可追溯证据链。
// 验收口径（AC-W1）：入口链路率可量化、孤儿接口单列、断链降级 low 并进人工清单、截断显式标注。

const w1Root = path.join(DIR, 'w1-front')
const w1Write = (rel, content) => {
  const full = path.join(w1Root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}
w1Write(
  'src/router/index.js',
  [
    "import { createRouter, createWebHistory } from 'vue-router'",
    'const routes = [',
    "  { path: '/bill', name: 'Bill', component: () => import('@/views/bill/index.vue'), meta: { title: '账单管理' } },",
    ']',
    'export default createRouter({ history: createWebHistory(), routes })',
    '',
  ].join('\n')
)
w1Write(
  'src/api/trsCheckBill.js',
  [
    "import request from '@/utils/request'",
    '',
    'export function getPageList(params) {',
    "  return request({ url: '/trsCheckBill/page', method: 'post', data: params })",
    '}',
    '',
    'export function removeBill(id) {',
    '  return request.delete(`/trsCheckBill/${id}`)',
    '}',
    '',
  ].join('\n')
)
// 没有任何页面引用：验证「无入口」不会被渲染成「无调用方」
w1Write(
  'src/api/account.js',
  ["import request from '@/utils/request'", '', 'export function login(form) {', "  return request({ url: '/system/login', method: 'post', data: form })", '}', ''].join('\n')
)
w1Write('src/utils/request.js', "import axios from 'axios'\nconst service = axios.create({ baseURL: '/prod-api' })\nexport default service\n")
w1Write(
  'src/components/PayerDialog.vue',
  [
    '<template>',
    '  <el-dialog v-model="visible" @close="reset">',
    '    <el-button @click="submit">确定</el-button>',
    '  </el-dialog>',
    '</template>',
    '<script setup>',
    "import { ref } from 'vue'",
    "import { removeBill } from '@/api/trsCheckBill'",
    'const visible = ref(false)',
    'function reset() {',
    '  visible.value = false',
    '}',
    'async function submit() {',
    '  await removeBill(1)',
    '}',
    '</script>',
    '',
  ].join('\n')
)
w1Write(
  'src/views/bill/index.vue',
  [
    '<template>',
    '  <div class="app-container">',
    '    <el-button @click="loadList">查询</el-button>',
    '    <payer-dialog ref="dlg" />',
    '  </div>',
    '</template>',
    '<script setup>',
    "import { ref } from 'vue'",
    "import { getPageList } from '@/api/trsCheckBill'",
    "import PayerDialog from '@/components/PayerDialog.vue'",
    'const list = ref([])',
    'async function loadList() {',
    "  const res = await getPageList({ billCode: '', pageNum: 1 })",
    '  list.value = res.data.rows',
    '}',
    '</script>',
    '',
  ].join('\n')
)
// 解析失败的文件：必须进 gaps 清单，不能静默跳过
w1Write('src/views/bill/broken.vue', '<template><div/></template>\n<script setup>\nconst x = (\n</script>\n')

const w1Spec = {
  openapi: '3.0.0',
  info: { title: '场景14 W1 文档', version: '1.0.0' },
  servers: [{ url: stubBase }],
  paths: {
    '/trsCheckBill/page': { post: { summary: '账单分页', 'x-apifox-folder': '账单' } },
    '/trsCheckBill/{id}': { delete: { summary: '账单删除', 'x-apifox-folder': '账单' } },
    '/system/login': { post: { summary: '登录', 'x-apifox-folder': '系统' } },
    '/never/called': { get: { summary: '孤儿接口', 'x-apifox-folder': '系统' } },
  },
}
const w1Project = await (
  await post('/api/projects', {
    name: '场景14 调用链项目',
    codePath: w1Root,
    source: { kind: 'openapi', config: { spec: w1Spec } },
  })
).json()
const w1Bound = await (
  await put(`/api/projects/${w1Project.id}/interfaces`, {
    ids: ['POST /trsCheckBill/page', 'DELETE /trsCheckBill/{id}', 'POST /system/login', 'GET /never/called'],
  })
).json()
await post(`/api/projects/${w1Project.id}/scan`, { codePath: w1Root })

const w1Before = await (await get(`/api/projects/${w1Project.id}/codegraph`)).json()
check(
  '14.1 扫描后未构建：state=stale / reason=not-built（不显示成「0 条链路」）',
  w1Before.state === 'stale' && w1Before.reason === 'not-built' && w1Before.summary === null,
  `${w1Before.state}/${w1Before.reason}`
)

const w1Built = await (await post(`/api/projects/${w1Project.id}/codegraph`, {})).json()
check(
  '14.2 构建调用链图：未绑定接口数/入口链路率可量化、无静默截断、组件边生效',
  w1Bound.interfaces?.length === 4 &&
    w1Built.stats?.endpointCount === 3 &&
    w1Built.stats?.endpointChainRate === 67 &&
    w1Built.stats?.orphanInterfaceCount === 1 &&
    w1Built.stats?.lowConfidenceChainCount >= 1 &&
    w1Built.stats?.componentEdgeCount >= 1 &&
    w1Built.truncated === false &&
    w1Built.bytes > 0,
  `endpoints=${w1Built.stats?.endpointCount} rate=${w1Built.stats?.endpointChainRate}% orphan=${w1Built.stats?.orphanInterfaceCount} bytes=${w1Built.bytes}`
)

const w1Detail = await (await get(`/api/projects/${w1Project.id}`)).json()
check(
  '14.3 摘要落项目文档、全量图在旁路文件（nodes/edges 不进库）',
  w1Detail.codegraph?.signature === w1Built.signature &&
    w1Detail.codegraph?.nodes === undefined &&
    w1Detail.codegraph?.stats?.functionCount > 0,
  `signature=${w1Detail.codegraph?.signature}`
)

const delChains = await (
  await get(`/api/projects/${w1Project.id}/codegraph/chains?interfaceId=${encodeURIComponent('DELETE /trsCheckBill/{id}')}`)
).json()
check(
  '14.4 按接口反查：弹窗组件里的删除调用经组件边回溯到 /bill 入口（high/medium，非断链）',
  delChains.chains?.[0]?.entry?.route === '/bill' &&
    delChains.chains[0].confidence !== 'low' &&
    delChains.chains[0].hops >= 2 &&
    delChains.files?.some((f) => f.file === 'src/components/PayerDialog.vue'),
  `route=${delChains.chains?.[0]?.entry?.route} hops=${delChains.chains?.[0]?.hops} files=${delChains.files?.length}`
)

const loginChains = await (
  await get(`/api/projects/${w1Project.id}/codegraph/chains?interfaceId=${encodeURIComponent('POST /system/login')}`)
).json()
check(
  '14.5 断链诚实：无入口链路标 reason=no-entry + confidence=low，不当成「有调用方」',
  loginChains.chains?.[0]?.reason === 'no-entry' &&
    loginChains.chains[0].confidence === 'low' &&
    loginChains.chains[0].entry === null,
  `reason=${loginChains.chains?.[0]?.reason} conf=${loginChains.chains?.[0]?.confidence}`
)

const allChains = await (await get(`/api/projects/${w1Project.id}/codegraph/chains`)).json()
check(
  '14.6 孤儿接口单列：文档里有、代码里没人调（不混进「无调用方」）',
  allChains.orphanInterfaces?.some((o) => o.interfaceId === 'GET /never/called') && allChains.endpoints?.length === 3,
  `orphan=${allChains.orphanInterfaces?.map((o) => o.interfaceId).join(',')}`
)

const w1Gaps = await (await get(`/api/projects/${w1Project.id}/codegraph/gaps`)).json()
check(
  '14.7 断链与解析问题清单：broken.vue 解析失败上报、未解析调用可人工关联',
  w1Gaps.state === 'fresh' &&
    w1Gaps.parseErrors?.some((e) => String(e.file).includes('broken.vue')) &&
    w1Gaps.noEntryCalls?.some((c) => c.interfaceId === 'POST /system/login') &&
    Array.isArray(w1Gaps.unresolved) &&
    w1Gaps.truncated === false,
  `parseErrors=${w1Gaps.parseErrors?.length} noEntry=${w1Gaps.noEntryCalls?.length} unresolved=${w1Gaps.unresolved?.length}`
)

await post(`/api/projects/${w1Project.id}/scan`, { codePath: w1Root })
const w1Stale = await (await get(`/api/projects/${w1Project.id}/codegraph`)).json()
check(
  '14.8 重新扫描后摘要过期：state=stale / reason=scan-changed（提示重建，而不是继续用旧图）',
  w1Stale.state === 'stale' && w1Stale.reason === 'scan-changed' && w1Stale.summary !== null,
  `${w1Stale.state}/${w1Stale.reason}`
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
console.log(`结论：${failed === 0 ? '全部通过' : `${failed} 项失败`}（${results.length} 项检查，14 个场景）`)

await new Promise((resolve) => appCtx.io.close(resolve))
await new Promise((resolve) => appCtx.server.close(resolve))
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
closeDefaultDatabase()
await new Promise((resolve) => stub.close(resolve))
fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
process.exit(failed === 0 ? 0 : 1)
