import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在 import 时固定数据目录，因此必须在导入任何 src 模块之前设置
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-cgsvc-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'codegraph.db')
process.env.HEIBAIHE_TOKEN = 'codegraph-unit-token-0123456789abcdef'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-cgsvc-src-'))
function write(rel, content) {
  const full = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

write(
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
write(
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
// 没有任何页面引用它：用于验证「无入口链路」不会被伪装成有入口
write(
  'src/api/account.js',
  ["import request from '@/utils/request'", '', 'export function login(form) {', "  return request({ url: '/system/login', method: 'post', data: form })", '}', ''].join('\n')
)
write('src/utils/request.js', "import axios from 'axios'\nconst service = axios.create({ baseURL: '/prod-api' })\nexport default service\n")
write(
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
write(
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
    '  const res = await getPageList({ billCode: \'\', pageNum: 1 })',
    '  list.value = res.data.rows',
    '}',
    '</script>',
    '',
  ].join('\n')
)
write('src/views/bill/broken.vue', '<template><div/></template>\n<script setup>\nconst x = (\n</script>\n')

const INTERFACES = [
  { id: 'POST /trsCheckBill/page', name: '账单分页', method: 'POST', path: '/trsCheckBill/page', folder: '账单' },
  { id: 'DELETE /trsCheckBill/{id}', name: '账单删除', method: 'DELETE', path: '/trsCheckBill/{id}', folder: '账单' },
  { id: 'POST /system/login', name: '登录', method: 'POST', path: '/system/login', folder: '系统' },
  { id: 'GET /never/called', name: '孤儿接口', method: 'GET', path: '/never/called', folder: '系统' },
]

const service = await import('../src/projects/service.js')
const codegraphService = await import('../src/projects/codegraphService.js')
const { store } = await import('../src/store.js')

after(async () => {
  try {
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
  } catch {
    /* 未初始化则忽略 */
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function setupProject() {
  const created = service.createProject({ name: '调用链项目', codePath: ROOT })
  const project = store.getProject(created.id)
  project.interfaces = INTERFACES
  project.interfaceIds = INTERFACES.map((it) => it.id)
  store.saveProject(project)
  return created.id
}

test('codegraph-service: 未扫描时构建被拒绝，状态为 missing 而不是「0 条链路」', () => {
  const created = service.createProject({ name: '空项目', codePath: ROOT })
  assert.throws(() => codegraphService.buildProjectGraph(created.id), /请先执行代码扫描/)
  const status = codegraphService.graphStatus(created.id)
  assert.equal(status.state, 'missing')
  assert.equal(status.reason, 'no-scan')
  assert.equal(status.summary, null)
})

test('codegraph-service: 扫描后构建调用链图，摘要入项目、全量图入旁路文件', () => {
  const id = setupProject()
  service.scanProject(id, { codePath: ROOT })

  // 扫描完成但未构建：必须显式 stale(not-built)，不能显示成「没有调用方」
  assert.equal(codegraphService.graphStatus(id).state, 'stale')
  assert.equal(codegraphService.graphStatus(id).reason, 'not-built')

  const summary = codegraphService.buildProjectGraph(id)
  assert.equal(summary.stale, false)
  assert.equal(summary.truncated, false)
  assert.ok(summary.stats.endpointCount >= 3)
  assert.ok(summary.stats.callsWithEntry >= 2)

  const status = codegraphService.graphStatus(id)
  assert.equal(status.state, 'fresh')
  assert.equal(status.summary.signature, status.signature)

  const project = store.getProject(id)
  assert.equal(project.codegraph.signature, status.signature)
  assert.ok(fs.existsSync(path.join(DIR, 'codegraph', `${id}.json`)))
  // 库里只留摘要：不能把 nodes/edges 塞进项目文档
  assert.equal(project.codegraph.nodes, undefined)
  assert.equal(project.codegraph.edges, undefined)
  assert.equal(typeof project.codegraph.bytes, 'number')
})

test('codegraph-service: 按接口取链路，带入口/断链与涉及文件', () => {
  const id = setupProject()
  service.scanProject(id, { codePath: ROOT })
  codegraphService.buildProjectGraph(id)

  const byInterface = codegraphService.queryChains(id, { interfaceId: 'DELETE /trsCheckBill/{id}' })
  assert.equal(byInterface.state, 'fresh')
  assert.ok(byInterface.chains.length >= 1)
  assert.equal(byInterface.chains[0].entry.route, '/bill')
  assert.ok(byInterface.chains[0].nodes.some((n) => n.file === 'src/components/PayerDialog.vue'))
  assert.ok(byInterface.files.some((f) => f.file === 'src/api/trsCheckBill.js'))
  assert.equal(byInterface.endpoint.hasEntry, true)

  // 无入口接口：链路存在但必须标 low + no-entry，不能被当成「有调用方」
  const orphanCall = codegraphService.queryChains(id, { interfaceId: 'POST /system/login' })
  assert.ok(orphanCall.chains.length >= 1)
  assert.equal(orphanCall.chains[0].reason, 'no-entry')
  assert.equal(orphanCall.chains[0].confidence, 'low')
  assert.equal(orphanCall.chains[0].entry, null)

  const callSite = codegraphService.queryChains(id, { callId: byInterface.chains[0].callSiteId })
  assert.ok(callSite.chains.length >= 1)
  assert.equal(callSite.chains[0].callSite.id, byInterface.chains[0].callSiteId)

  const all = codegraphService.queryChains(id)
  assert.ok(all.endpoints.length >= 3)
  assert.ok(all.orphanInterfaces.some((o) => o.interfaceId === 'GET /never/called'))
  assert.ok(all.notice === undefined, '已构建时不出现「尚未生成」提示')
})

test('codegraph-service: 断链清单暴露未解析调用与解析错误', () => {
  const id = setupProject()
  service.scanProject(id, { codePath: ROOT })
  codegraphService.buildProjectGraph(id)

  const gaps = codegraphService.listGaps(id)
  assert.equal(gaps.state, 'fresh')
  assert.ok(Array.isArray(gaps.unresolved))
  assert.ok(gaps.parseErrors.length >= 1, 'broken.vue 的解析错误必须上报而不是忽略')
  assert.ok(gaps.parseErrors[0].file.includes('broken.vue'))
  assert.ok(gaps.noEntryCalls.some((c) => c.interfaceId === 'POST /system/login'))
})

test('codegraph-service: 调用方查询与原始图读取带状态', () => {
  const id = setupProject()
  service.scanProject(id, { codePath: ROOT })
  codegraphService.buildProjectGraph(id)

  const callers = codegraphService.queryCallers(id, 'src/api/trsCheckBill.js#removeBill@7')
  assert.equal(callers.state, 'fresh')
  assert.ok(callers.callers.length >= 1)
  assert.equal(callers.callers[0].file, 'src/components/PayerDialog.vue')

  const raw = codegraphService.readGraph(id)
  assert.equal(raw.state, 'fresh')
  assert.ok(raw.graph.nodes.functions.length > 0)
})

test('codegraph-service: 未构建时查询显式返回 stale + 提示，不用空链路冒充证据', () => {
  const id = setupProject()
  service.scanProject(id, { codePath: ROOT })

  const chains = codegraphService.queryChains(id, { interfaceId: 'POST /trsCheckBill/page' })
  assert.equal(chains.state, 'stale')
  assert.equal(chains.chains.length, 0)
  assert.ok(chains.notice, '未构建必须给出提示文案，而不是仅返回空数组')

  assert.deepEqual(codegraphService.queryCallers(id, 'whatever'), { state: 'missing', callers: [] })
  const raw = codegraphService.readGraph(id)
  assert.equal(raw.state, 'stale')
  assert.equal(raw.graph, null)

  const gaps = codegraphService.listGaps(id)
  assert.equal(gaps.state, 'stale')
  assert.deepEqual(gaps.noEntryCalls, [])
  assert.deepEqual(gaps.parseErrors, [])
})

test('codegraph-service: 重新扫描后摘要过期，删除项目同步清理旁路图', () => {
  const id = setupProject()
  service.scanProject(id, { codePath: ROOT })
  codegraphService.buildProjectGraph(id)

  service.scanProject(id, { codePath: ROOT })
  const stale = codegraphService.graphStatus(id)
  assert.equal(stale.state, 'stale')
  assert.equal(stale.reason, 'scan-changed')

  // 过期后仍能读到上一次的图，但必须带 stale 标记
  const chains = codegraphService.queryChains(id, { interfaceId: 'DELETE /trsCheckBill/{id}' })
  assert.equal(chains.state, 'stale')
  assert.equal(chains.stale, true)
  assert.ok(chains.chains.length >= 1)

  service.deleteProject(id)
  assert.equal(fs.existsSync(path.join(DIR, 'codegraph', `${id}.json`)), false)
})
