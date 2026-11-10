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
 *
 * 环境与 verify-m1-3 同口径：临时库 + 真实端口 + token；Apifox 侧只依赖本机缓存文件
 * （oas-cache.json，MCP 拉取的产物格式），不依赖外网。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

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
const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  await sleep(STUB_DELAY)
  if (url.pathname === '/api/login') {
    return send(200, { code: 0, data: { token: 'tok-abc', user: { id: 1, name: 'alice' } } })
  }
  if (url.pathname === '/api/orders') {
    return send(200, { code: 0, data: { orders: [{ id: 11, total: 99 }], count: 1 } })
  }
  if (url.pathname === '/api/echo') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    return send(201, { code: 0, data: { method: req.method, body: raw ? JSON.parse(raw) : null } })
  }
  send(404, { code: 404 })
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

// ---------------------------------------------------------------- 汇总
console.log('\n结论')
console.log('-'.repeat(78))
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
}
console.log('-'.repeat(78))
console.log(`结论：${failed === 0 ? '全部通过' : `${failed} 项失败`}（${results.length} 项检查，6 个场景）`)

await new Promise((resolve) => appCtx.io.close(resolve))
await new Promise((resolve) => appCtx.server.close(resolve))
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
closeDefaultDatabase()
await new Promise((resolve) => stub.close(resolve))
fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
process.exit(failed === 0 ? 0 : 1)
