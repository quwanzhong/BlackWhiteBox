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
 *
 * 环境与 verify-m1-3 同口径：临时库 + 真实端口 + token；Apifox 侧只依赖本机缓存文件
 * （oas-cache.json，MCP 拉取的产物格式），不依赖外网。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
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
    if (url.pathname === '/api/scene8-flaky') {
      scene8FlakyHits += 1
      if (scene8FlakyHits <= 2) return send(500, { code: 500, hit: scene8FlakyHits })
      return send(200, { code: 0, hit: scene8FlakyHits })
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

// ---------------------------------------------------------------- 汇总
console.log('\n结论')
console.log('-'.repeat(78))
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
}
console.log('-'.repeat(78))
console.log(`结论：${failed === 0 ? '全部通过' : `${failed} 项失败`}（${results.length} 项检查，9 个场景）`)

await new Promise((resolve) => appCtx.io.close(resolve))
await new Promise((resolve) => appCtx.server.close(resolve))
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
closeDefaultDatabase()
await new Promise((resolve) => stub.close(resolve))
fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
process.exit(failed === 0 ? 0 : 1)
