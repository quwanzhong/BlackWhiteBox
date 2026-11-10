import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { buildCodeGraph, callSiteConfidence, classifyFile, weakest } from '../src/codegraph/build.js'
import { extractTemplateBindings, extractTemplateComponents, parseFile, pluginsFor, parseCode } from '../src/codegraph/parse.js'
import { extractUnit } from '../src/codegraph/extract.js'
import { nameOf, paramNames } from '../src/codegraph/walker.js'
import { createResolver } from '../src/codegraph/resolve.js'
import { loadGraph, removeGraph, saveGraph } from '../src/codegraph/store.js'
import { chainsForEndpoint, graphSignature } from '../src/codegraph/index.js'
import { matchCalls, scanDirectory } from '../src/projects/scanner.js'

/** 建一个临时前端工程：router → page → api + 用 `<payer-dialog>` 的弹窗组件 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-cg-'))
  const write = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }
  write(
    'src/router/index.js',
    [
      "import { createRouter, createWebHistory } from 'vue-router'",
      'const routes = [',
      "  { path: '/bill', name: 'Bill', component: () => import('@/views/bill/index.vue'), meta: { title: '账单管理' } },",
      "  { path: '/bill/detail', component: () => import('@/views/bill/detail.vue') },",
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
      'const form = ref({ patientId: \'\' })',
      'function reset() {',
      '  form.value = { patientId: \'\' }',
      '}',
      'async function submit() {',
      '  await removeBill(form.value.patientId)',
      '  visible.value = false',
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
  return root
}

const ROOT = makeFixture()
const INTERFACES = [
  { id: 'POST /trsCheckBill/page', name: '账单分页', method: 'POST', path: '/trsCheckBill/page', folder: '账单' },
  { id: 'DELETE /trsCheckBill/{id}', name: '账单删除', method: 'DELETE', path: '/trsCheckBill/{id}', folder: '账单' },
  { id: 'GET /never/called', name: '孤儿接口', method: 'GET', path: '/never/called', folder: '系统' },
]

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-cg-data-'))

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------- parse

test('codegraph: parseCode 用 @babel/parser 解析，解析失败不抛且带错误信息', () => {
  const ok = parseCode('const x = () => 1\nexport default x', pluginsFor('a.js'))
  assert.equal(ok.error, '')
  assert.ok(ok.ast)

  const bad = parseCode('const === =', pluginsFor('a.js'))
  assert.ok(bad.error)
  assert.equal(bad.ast, null)
})

test('codegraph: .vue 只分析 <script>/<script setup> 块并保留 lineOffset，template 绑定可抽', () => {
  const source = [
    '<template>',
    '  <div>@click="ok">x</div>',
    '</template>',
    '<script setup lang="ts">',
    "import { ref } from 'vue'",
    'function ok() {}',
    '</script>',
    '',
  ].join('\n')
  const parsed = parseFile('src/views/Bill.vue', source, path.join(ROOT, 'src/views/Bill.vue'))
  assert.equal(parsed.units.length, 1)
  assert.equal(parsed.units[0].setup, true)
  assert.equal(parsed.units[0].lineOffset, 3)

  const bindings = extractTemplateBindings(source)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].event, 'click')
  assert.equal(bindings[0].name, 'ok')

  const components = extractTemplateComponents(source)
  assert.deepEqual(components.map((c) => c.name), ['div'])
})

test('codegraph: pluginsFor 对 ts/jsx/vue 差异化', () => {
  assert.ok(pluginsFor('a.ts').includes('typescript'))
  assert.ok(pluginsFor('a.tsx').includes('typescript'))
  assert.ok(pluginsFor('a.tsx').includes('jsx'))
  assert.ok(pluginsFor('a.vue', 'ts').includes('typescript'))
})

// ---------------------------------------------------------------- extract

test('codegraph: extractUnit 抽出 import/函数/调用事实，url/method 不进业务参数键集', () => {
  const source = [
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
  const parsed = parseFile('src/api/trsCheckBill.js', source, path.join(ROOT, 'src/api/trsCheckBill.js'))
  const extracted = extractUnit(parsed.units[0], 'src/api/trsCheckBill.js', source.split(/\r?\n/), { template: [] })

  assert.equal(extracted.imports.length, 1)
  assert.equal(extracted.functions.length, 2)
  assert.equal(extracted.defaultExport, null)

  const getCall = extracted.calls.find((c) => c.fnId.includes('#getPageList@'))
  assert.ok(getCall)
  assert.equal(getCall.method, 'POST')
  assert.ok(getCall.path.includes('trsCheckBill'))
  // url/method 是传输键，不进入业务参数键集；data 是变量引用，无法静态展开
  assert.deepEqual(getCall.paramKeys, { query: [], body: [], payload: [] })

  const delCall = extracted.calls.find((c) => c.fnId.includes('#removeBill@'))
  assert.equal(delCall.method, 'DELETE')
  assert.ok(delCall.rawPath.includes('trsCheckBill'))
})

test('codegraph: extractUnit 从对象参数里拿业务参数键（payload 只含业务键）', () => {
  const source = [
    '<script setup>',
    "import { getPageList } from '@/api/trsCheckBill'",
    'async function loadList() {',
    '  return getPageList({ billCode: \'\', pageNum: 1 })',
    '}',
    '</script>',
    '',
  ].join('\n')
  const parsed = parseFile('src/views/bill/index.vue', source, path.join(ROOT, 'src/views/bill/index.vue'))
  const extracted = extractUnit(parsed.units[0], 'src/views/bill/index.vue', source.split(/\r?\n/))
  const call = extracted.calls.find((c) => c.name === 'getPageList')
  assert.deepEqual(call.paramKeys, { query: [], body: [], payload: ['billCode', 'pageNum'] })
})

// ---------------------------------------------------------------- build

test('codegraph: buildCodeGraph 识别 router 入口，并把组件使用边连到子组件', () => {
  const scan = scanDirectory(ROOT)
  const graph = buildCodeGraph(ROOT, { calls: scan.calls, interfaces: INTERFACES })

  const routerEntry = graph.entries.find((e) => e.via === 'router' && e.file === 'src/views/bill/index.vue')
  assert.ok(routerEntry, 'router 入口应指向 bill 页面')
  assert.equal(routerEntry.route, '/bill')

  const componentEdge = graph.edges.components.find((e) => e.type === 'component')
  assert.ok(componentEdge, '应有组件使用边（父页面 → 弹窗组件）')
  assert.equal(componentEdge.from, 'src/views/bill/index.vue#<module>@1')
  assert.equal(componentEdge.to, 'src/components/PayerDialog.vue#<module>@1')
  assert.equal(graph.stats.componentEdgeCount > 0, true)
})

test('codegraph: 组件边后的接口调用回溯到入口；无调用接口进入 orphan 清单', () => {
  const scan = scanDirectory(ROOT)
  const calls = matchCalls(scan.calls, INTERFACES)
  const graph = buildCodeGraph(ROOT, { calls, interfaces: INTERFACES })

  const delInterface = graph.endpoints.find((e) => e.method === 'DELETE')
  assert.ok(delInterface)
  assert.equal(delInterface.hasEntry, true, '组件边让删除链路回到 /bill 入口')

  const delChains = graph.chains.filter((c) => c.interfaceId === delInterface.interfaceId)
  assert.ok(delChains.length)
  const delChain = delChains.find((c) => c.entry)
  assert.ok(delChain, '至少一条链路能回溯到入口')
  assert.equal(delChain.reason, 'entry')
  assert.equal(delChain.confidence, 'medium')
  assert.ok(delChain.hops >= 2, 'delete → dialog submit → page module，至少两跳')
  assert.ok(delChain.entry, '链路应带 entry 信息')
  assert.equal(delChain.entry.file, 'src/views/bill/index.vue')

  assert.ok(graph.orphanInterfaces.some((o) => o.interfaceId === 'GET /never/called'), '孤儿接口进 orphan 清单')
})

test('codegraph: 截断必须显式标注，绝不静默截断', () => {
  const graph = buildCodeGraph(ROOT, { calls: [], interfaces: [], options: { maxNodes: 2 } })
  assert.equal(graph.truncated, true)
  assert.deepEqual(graph.truncatedReasons, ['node-budget'])
  assert.ok(graph.skippedFiles.some((f) => f.reason === 'node-budget'))
})

test('codegraph: 调用点超预算时以 call-site-limit 显式标注', () => {
  const graph = buildCodeGraph(ROOT, { calls: [], interfaces: [], totalCalls: 30 })
  assert.equal(graph.truncated, true)
  assert.deepEqual(graph.truncatedReasons, ['call-site-limit'])
})

test('codegraph: 摘要签名随扫描结果变化，用于「调用链待重建」判定', () => {
  const scanA = { root: '/tmp/a', scannedAt: 1, callCount: 1, calls: [{ id: 'x:1', matchedInterfaceId: 'i1' }] }
  const scanB = { root: '/tmp/b', scannedAt: 1, callCount: 1, calls: [{ id: 'x:2', matchedInterfaceId: 'i1' }] }
  assert.notEqual(graphSignature({ scan: scanA, interfaces: [{ id: 'i1' }] }), graphSignature({ scan: scanB, interfaces: [{ id: 'i1' }] }))
})

// ---------------------------------------------------------------- helpers

test('codegraph: walker.nameOf / paramNames 覆盖常见节点形态', () => {
  assert.equal(nameOf({ type: 'Identifier', name: 'a' }), 'a')
  assert.equal(nameOf({ type: 'StringLiteral', value: 'k' }), 'k')
  assert.equal(nameOf({ type: 'MemberExpression', computed: false, property: { type: 'Identifier', name: 'p' } }), 'p')
  assert.equal(nameOf({ type: 'ObjectMethod', key: { type: 'Identifier', name: 'm' } }), 'm')
  assert.equal(nameOf(null), '')

  assert.deepEqual(paramNames([{ type: 'Identifier', name: 'a' }]), ['a'])
  assert.deepEqual(paramNames([{ type: 'ObjectPattern' }]), ['{…}'])
  assert.deepEqual(paramNames([{ type: 'ArrayPattern' }]), ['[…]'])
  assert.deepEqual(paramNames([{ type: 'AssignmentPattern', left: { type: 'Identifier', name: 'b' } }]), ['b'])
  assert.deepEqual(paramNames([{ type: 'RestElement', argument: { type: 'Identifier', name: 'rest' } }]), ['rest'])
  assert.deepEqual(paramNames([]), [])
})

test('codegraph: classifyFile / callSiteConfidence / weakest', () => {
  assert.equal(classifyFile('src/components/PayerDialog.vue'), 'component')
  assert.equal(classifyFile('src/views/bill/index.vue'), 'page')
  assert.equal(classifyFile('src/router/index.js'), 'router')
  assert.equal(classifyFile('src/api/trsCheckBill.js'), 'api')
  assert.equal(classifyFile('src/store/index.js'), 'store')
  assert.equal(classifyFile('src/pages/Bill.vue'), 'page')
  assert.equal(classifyFile('src/App.vue'), 'component')

  assert.equal(callSiteConfidence({ matchSource: 'manual', score: 10 }), 'high')
  assert.equal(callSiteConfidence({ matchSource: 'auto', score: 95 }), 'high')
  assert.equal(callSiteConfidence({ matchSource: 'auto', score: 80 }), 'medium')
  assert.equal(callSiteConfidence({ matchSource: 'auto', score: 30, matchedInterfaceId: 'x' }), 'low')
  assert.equal(weakest('high', 'low'), 'low')
  assert.equal(weakest('medium', 'medium'), 'medium')
})

// ---------------------------------------------------------------- store

test('codegraph: 旁路存储 save/load/remove 往返与缺失语义', () => {
  process.env.HEIBAIHE_DATA_DIR = DATA_DIR
  const saved = saveGraph('cg-test-project', { version: 1, nodes: { functions: [] } })
  assert.ok(saved.file.endsWith('.json'))
  assert.ok(fs.existsSync(saved.file))
  assert.deepEqual(loadGraph('cg-test-project')?.nodes, { functions: [] })
  assert.equal(removeGraph('cg-test-project'), true)
  assert.equal(loadGraph('cg-test-project'), null)
})

test('codegraph: resolver 支持相对路径 / @ alias / 省略扩展名 / index', () => {
  const resolver = createResolver('/project', new Set(['src/api/order.js', 'src/api/index.js', 'src/views/home.vue', 'src/components/PayerDialog.vue']))
  assert.equal(resolver('src/api/trsCheckBill.js', './order.js'), 'src/api/order.js')
  assert.equal(resolver('src/api/trsCheckBill.js', '@/api/order.js'), 'src/api/order.js')
  assert.equal(resolver('src/api/trsCheckBill.js', '@/api'), 'src/api/index.js')
  assert.equal(resolver('src/components/PayerDialog.vue', '@/components/PayerDialog.vue'), 'src/components/PayerDialog.vue')
  assert.equal(resolver('src/api/order.js', 'vue-router'), null, 'node_modules 模块不进图')
})

test('codegraph: resolver 兼容「工程根就是源码根」与「以自己包名作别名」（输研 1.0 实测写法）', () => {
  const flat = createResolver('/project', new Set(['api/bill.js', 'views/bill/index.vue', 'components/PayerDialog.vue']))
  assert.equal(flat('views/bill/index.vue', '@/api/bill.js'), 'api/bill.js', '没有 src/ 时 @/ 回落到工程根')
  assert.equal(flat('views/bill/index.vue', '@/components/PayerDialog.vue'), 'components/PayerDialog.vue')
  assert.equal(flat('views/bill/index.vue', '@transfusion-research-web/api/bill.js'), 'api/bill.js', '自引用包名按「路径真实存在」解析')
  assert.equal(flat('views/bill/index.vue', '@commonlib/utils/tableHoverMixin.js'), null, '外部包不误判为工程内文件')
  assert.equal(flat('views/bill/index.vue', '@element-plus/icons-vue'), null)
})

// ---------------------------------------------------------------- 真实工程写法回归

/** 复刻输研 1.0 的三种坑：无 src/、自引用包名、回调 + 模板串前缀 */
function makeFlatFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-cg-flat-'))
  const write = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }
  write('api/bill.js', [
    "import request from '@/utils/request'",
    '',
    'const BASE_URL = CONSTANT.BSMART',
    '',
    'export function saveBill(data) {',
    '  return request({',
    '    url: `${BASE_URL}/bill/save`,',
    "    method: 'post',",
    '    data,',
    '  })',
    '}',
    '',
    'export function removeBill(id) {',
    '  return request.delete(`/bill/${id}`)',
    '}',
    '',
  ].join('\n'))
  write('utils/request.js', "import axios from 'axios'\nconst service = axios.create({ baseURL: '/prod-api' })\nexport default service\n")
  write('components/PayerDialog.vue', [
    '<template>',
    '  <el-dialog v-model="visible">',
    '    <el-button @click="submit">确定</el-button>',
    '  </el-dialog>',
    '</template>',
    '<script setup>',
    "import { ref } from 'vue'",
    "import { removeBill } from '@/api/bill.js'",
    'const visible = ref(false)',
    'async function submit() {',
    '  await removeBill(1)',
    '}',
    '</script>',
    '',
  ].join('\n'))
  write('views/bill/index.vue', [
    '<template>',
    '  <div class="app-container">',
    '    <el-button @click="save">保存</el-button>',
    '    <payer-dialog ref="dlg" />',
    '  </div>',
    '</template>',
    '<script setup>',
    "import { ref } from 'vue'",
    "import { saveBill } from '@transfusion-research-web/api/bill.js'",
    "import PayerDialog from '@/components/PayerDialog.vue'",
    'const ids = ref([])',
    'async function download(id) {',
    '  await saveBill({ id })',
    '}',
    'function save() {',
    '  ids.value.forEach((id) => {',
    '    download(id)',
    '  })',
    '}',
    '</script>',
    '',
  ].join('\n'))
  write('views/bill/dialog/EditDialog.vue', [
    '<template><el-dialog v-model="visible" /></template>',
    '<script setup>',
    "import { ref } from 'vue'",
    'const visible = ref(false)',
    '</script>',
    '',
  ].join('\n'))
  // 没有任何文件调用它：必须计为「无调用方」，不能摊进成功率
  write('api/dead.js', [
    "import request from '@/utils/request'",
    'export function neverCalled(id) {',
    '  return request.get(`/never/called/${id}`)',
    '}',
    '',
  ].join('\n'))
  return root
}

test('codegraph: 真实工程写法下链路可回溯，孤儿调用点单独计数（不摊薄成功率）', () => {
  const root = makeFlatFixture()
  const interfaces = [
    { id: 'POST /bill/save', name: '保存', method: 'POST', path: '/bill/save' },
    { id: 'DELETE /bill/{id}', name: '删除', method: 'DELETE', path: '/bill/{id}' },
    { id: 'GET /never/called/{id}', name: '孤儿', method: 'GET', path: '/never/called/{id}' },
  ]
  try {
    const scan = scanDirectory(root)
    const calls = matchCalls(scan.calls, interfaces)
    const graph = buildCodeGraph(root, { calls, interfaces })

    // 模板串 `${BASE}/bill/save` 的 AST 路径与 scanner 的 `/{}/bill/save` 不一致，
    // 仍要通过路径相似度连上触发点（否则整片调用点会被判成 not-in-ast）
    const saveTrigger = graph.edges.triggers.find((t) => t.interfaceId === 'POST /bill/save')
    assert.equal(saveTrigger.matchedBy, 'line')
    assert.ok(!saveTrigger.from.includes('<module>'), '触发点应落在真实函数上')

    const saveChains = chainsForEndpoint(graph, 'POST /bill/save')
    assert.ok(saveChains.length > 0)
    assert.equal(saveChains[0].entry.via, 'views-fallback', '无路由表时由 views 兜底入口')
    assert.equal(saveChains[0].entry.file, 'views/bill/index.vue')
    assert.ok(saveChains[0].nodes.some((n) => n.name === 'download'), '回调链路应经 closure 边回到外层函数')
    assert.ok(['low', 'medium', 'high'].includes(saveChains[0].confidence))

    // 弹窗组件经 component 边回到页面入口
    const delChains = chainsForEndpoint(graph, 'DELETE /bill/{id}')
    assert.ok(delChains[0].entry)
    assert.equal(delChains[0].entry.file, 'views/bill/index.vue')
    assert.ok(delChains[0].nodes.some((n) => n.file === 'components/PayerDialog.vue'))

    // 孤儿调用点：有调用点但工程内没有任何调用方
    assert.equal(graph.stats.callSitesWithCaller, 2)
    assert.equal(graph.stats.callChainRateAmongCallable, 100)
    assert.equal(graph.stats.callChainRate < 100, true, '全局成功率必须保留真实分母')
    const dead = graph.noEntryCalls.find((c) => c.interfaceId === 'GET /never/called/{id}')
    assert.ok(dead)
    assert.equal(dead.callerCount, 0)
    assert.equal(graph.stats.closureEdgeCount > 0, true)
    assert.equal(classifyFile('views/bill/dialog/EditDialog.vue'), 'component', 'views 下的 dialog 不是入口页面')
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
