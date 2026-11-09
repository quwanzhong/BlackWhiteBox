import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  analyzeProject,
  buildGroups,
  matchCalls,
  matchScore,
  normalizeApiPath,
  scanDirectory,
} from '../src/projects/scanner.js'

/** 建一个临时前端工程，覆盖扫描器要处理的各种写法与忽略规则 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-scan-'))
  const write = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }

  write(
    'src/api/order.ts',
    [
      "import axios from 'axios'",
      '',
      'const service = axios.create()',
      '',
      "// axios.get('/api/commented-out')",
      '/*',
      " * axios.get('/api/block-comment')",
      ' */',
      'export function getOrder(id: string) {',
      '  return service.get(`/api/orders/${id}`)',
      '}',
      '',
      'export const ping = async () => {',
      "  return fetch('/api/ping', { method: 'POST' })",
      '}',
      '',
      'export function createOrder() {',
      '  return axios({',
      "    url: '/api/orders',",
      "    method: 'post',",
      '    data: {},',
      '  })',
      '}',
      '',
      'export function absolute() {',
      "  return axios.get('https://api.example.com/v1/users?page=1')",
      '}',
      '',
    ].join('\n')
  )

  write(
    'src/util/helper.js',
    [
      'export function listUsers() {',
      "  return fetch('/api/users')",
      '}',
      '',
      'const arrowGet = async (id) => axios.get(`/api/arrow/${id}`)',
      '',
      'const namedGet = async function () {',
      "  return axios.get('/api/named')",
      '}',
      '',
      'class ApiClient {',
      '  detail() {',
      "    return axios.get('/api/method')",
      '  }',
      '}',
      '',
    ].join('\n')
  )

  write(
    'src/util/config.js',
    [
      'export const config = {',
      "  url: '/api/orphan-call',",
      '}',
      '',
      "const relative = 'relative/path'",
      '',
    ].join('\n')
  )

  // 超过 2000 字符的行整体跳过；同文件里的正常行仍要扫到
  // 非法 HTTP 方法：即便抓到 method 也应丢弃
  write('src/util/trace.js', ["export function trace() {", "  return fetch('/api/trace', { method: 'TRACE' })", '}', ''].join('\n'))

  write(
    'src/long.js',
    [`const big = '${'a'.repeat(2100)}' axios.get('/api/too-long')`, "axios.get('/api/keep')", ''].join('\n')
  )

  write('node_modules/pkg/index.js', "axios.get('/api/from-node-modules')\n")
  write('src/bundle.min.js', "axios.get('/api/from-min')\n")
  write('src/readme.txt', "axios.get('/api/from-txt')\n")
  write('dist/app.js', "axios.get('/api/from-dist')\n")

  return root
}

const ROOT = makeFixture()

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('扫描器：normalizeApiPath 去域名/查询串并统一占位符', () => {
  assert.equal(normalizeApiPath('https://api.example.com/v1/users?page=1#x'), '/v1/users')
  assert.equal(normalizeApiPath('/a//b/'), '/a/b')
  assert.equal(normalizeApiPath('/orders/${id}/{{orderId}}/{type}'), '/orders/{}/{}/{}')
  assert.equal(normalizeApiPath('orders/1'), '/orders/1')
  assert.equal(normalizeApiPath('  /x  '), '/x')
  assert.equal(normalizeApiPath(''), '/')
  // 非法 URL 走正则兜底
  assert.equal(normalizeApiPath('https://exa mple.com/x'), '/x')
})

test('扫描器：matchScore 从末尾逐段匹配并支持通配', () => {
  assert.equal(matchScore('/api/orders/{id}', '/api/orders/42'), 100)
  assert.equal(matchScore('/api/orders', '/api/orders'), 100)
  assert.equal(matchScore('/api', '/api'), 100)
  assert.equal(matchScore('/api/orders', '/api/users'), 0)
  assert.equal(matchScore('/api/x', '/x'), 0, '末段匹配但总分不足两段时不算')
  assert.equal(matchScore('/v1/api/users', '/api/users'), 67)
  assert.equal(matchScore('', '/x'), 0)
  assert.equal(matchScore('/x', ''), 0)
})

test('扫描器：scanDirectory 识别 axios/fetch/对象写法，跳过注释、min.js、依赖目录与超长行', () => {
  const result = scanDirectory(ROOT)
  const byPath = new Map(result.calls.map((c) => [`${c.method} ${c.path}`, c]))

  // 5 个有效源码文件（order.ts + 4 个 js）；node_modules/dist/min.js/txt 均不计入
  assert.equal(result.scannedFiles, 5)
  // files 只记录真正有调用点的文件
  assert.deepEqual(result.files.map((f) => f.path).sort(), [
    'src/api/order.ts',
    'src/long.js',
    'src/util/helper.js',
  ])

  assert.ok(byPath.has('GET /api/orders/{}'), '模板字符串成员调用')
  assert.equal(byPath.get('GET /api/orders/{}').functionName, 'getOrder')
  assert.ok(byPath.has('POST /api/ping'), 'fetch 的 method 前瞻')
  assert.equal(byPath.get('POST /api/ping').kind, 'fetch')
  assert.ok(byPath.has('POST /api/orders'), 'axios({ url, method }) 对象写法')
  assert.equal(byPath.get('POST /api/orders').kind, 'object')
  assert.ok(byPath.has('GET /v1/users'), '绝对地址取 pathname')
  assert.ok(byPath.has('GET /api/users'))
  assert.equal(byPath.get('GET /api/users').functionName, 'listUsers')
  assert.ok(byPath.has('GET /api/arrow/{}'), '箭头函数归属')
  assert.equal(byPath.get('GET /api/arrow/{}').functionName, 'arrowGet')
  assert.ok(byPath.has('GET /api/named'), '函数表达式归属')
  assert.equal(byPath.get('GET /api/named').functionName, 'namedGet')
  assert.ok(byPath.has('GET /api/method'), '类方法归属')
  assert.equal(byPath.get('GET /api/method').functionName, 'detail')
  assert.ok(byPath.has('GET /api/keep'), '超长行跳过但正常行保留')

  // 应被忽略的写法
  for (const p of [
    '/api/commented-out',
    '/api/block-comment',
    '/api/trace',
    '/api/too-long',
    '/api/orphan-call',
    '/api/from-node-modules',
    '/api/from-min',
    '/api/from-txt',
    '/api/from-dist',
  ]) {
    assert.ok(!result.calls.some((c) => c.path === p), `不应出现 ${p}`)
  }

  // 调用点按文件、行号排序；id 稳定
  const again = scanDirectory(ROOT)
  assert.deepEqual(
    again.calls.map((c) => c.id),
    result.calls.map((c) => c.id)
  )
  const sorted = result.calls.every(
    (c, i, arr) =>
      i === 0 ||
      arr[i - 1].file < c.file ||
      (arr[i - 1].file === c.file && arr[i - 1].line <= c.line)
  )
  assert.equal(sorted, true)
})

test('扫描器：extensions 与 maxFiles 选项生效', () => {
  const jsOnly = scanDirectory(ROOT, { extensions: ['JS'] })
  assert.equal(jsOnly.scannedFiles, 4)
  assert.ok(jsOnly.calls.every((c) => c.file.endsWith('.js')))

  const limited = scanDirectory(ROOT, { maxFiles: 1 })
  assert.equal(limited.scannedFiles, 1)
})

test('扫描器：目录不存在或不是文件夹时抛错', () => {
  assert.throws(() => scanDirectory(path.join(ROOT, 'missing-dir')), /ENOENT|不存在/)
  assert.throws(() => scanDirectory(path.join(ROOT, 'src/readme.txt')), /代码目录不存在或不是文件夹/)
})

test('扫描器：matchCalls 按方法过滤、阈值匹配与置信度', () => {
  const interfaces = [
    { id: 'i1', name: '订单详情', method: 'GET', path: '/api/orders/{id}', folder: '订单' },
    { id: 'i2', name: '创建订单', method: 'POST', path: '/api/orders', folder: '订单' },
    { id: 'i3', name: '未知资源', method: 'GET', path: '/api/unknown/{id}', folder: '' },
    { id: 'i4', name: '深路径', method: 'GET', path: '/a/b/c/d', folder: '' },
    { id: 'i5', name: '版本前缀', method: 'GET', path: '/v1/api/users', folder: '' },
  ]
  const calls = [
    { id: 'c1', method: 'GET', path: '/api/orders/42', file: 'a.ts' },
    { id: 'c2', method: 'POST', path: '/api/orders', file: 'a.ts' },
    { id: 'c3', method: 'DELETE', path: '/api/orders/42', file: 'b.ts' },
    { id: 'c4', method: 'GET', path: '/api/unknown/thing', file: 'b.ts' },
    { id: 'c5', method: 'GET', path: '/totally/different', file: 'c.ts' },
    { id: 'c6', method: 'GET', path: '/b/c/d', file: 'c.ts' },
    { id: 'c7', method: 'GET', path: '/api/users', file: 'd.ts' },
  ]
  const out = new Map(matchCalls(calls, interfaces).map((c) => [c.id, c]))

  assert.equal(out.get('c1').matched, true)
  assert.equal(out.get('c1').matchedInterfaceId, 'i1')
  assert.equal(out.get('c1').matchedFolder, '订单')
  assert.equal(out.get('c1').confidence, 'high')
  assert.equal(out.get('c2').matchedInterfaceId, 'i2')
  assert.equal(out.get('c3').matched, false, '方法不同不匹配')
  assert.equal(out.get('c4').matchedInterfaceId, 'i3')
  assert.equal(out.get('c5').matched, false)
  assert.equal(out.get('c5').confidence, '')
  assert.equal(out.get('c6').score, 75)
  assert.equal(out.get('c6').confidence, 'medium')
  assert.equal(out.get('c7').score, 67)
  assert.equal(out.get('c7').confidence, 'low')
  assert.ok([...out.values()].every((c) => c.matchSource === 'auto'))

  // 同分时选更短的接口路径
  const tie = matchCalls(
    [{ id: 't', method: 'GET', path: '/api/orders/42', file: 'a.ts' }],
    [
      { id: 'long', name: '长', method: 'GET', path: '/api/orders/{id}', folder: '' },
      { id: 'short', name: '短', method: 'GET', path: '/api/{x}/42', folder: '' },
    ]
  )[0]
  assert.equal(tie.matchedInterfaceId, 'short')
})

test('扫描器：buildGroups 优先 Apifox 目录，其次路径段，未匹配按代码目录', () => {
  const interfaces = [
    { id: 'i1', name: '订单详情', path: '/api/orders/{id}', folder: '订单' },
    { id: 'i2', name: '库存', path: '/api/stock', folder: '' },
  ]
  const calls = [
    { id: 'c1', file: 'src/api/order.ts', path: '/api/orders/1', matchedInterfaceId: 'i1' },
    { id: 'c2', file: 'src/api/order.ts', path: '/api/orders/2', matchedInterfaceId: 'i1' },
    { id: 'c3', file: 'src/api/stock.ts', path: '/api/stock', matchedInterfaceId: 'i2' },
    { id: 'c4', file: 'src/deep/nested/file.ts', path: '/x', matchedInterfaceId: '' },
    { id: 'c5', file: 'top.ts', path: '/y', matchedInterfaceId: '' },
  ]
  const groups = buildGroups(calls, interfaces)
  const byKey = new Map(groups.map((g) => [g.key, g]))

  const folder = byKey.get('folder:订单')
  assert.equal(folder.name, '订单')
  assert.equal(folder.source, 'apifox-folder')
  assert.equal(folder.callCount, 2)
  assert.equal(folder.nodeCount, 1)
  assert.equal(folder.matched, true)
  assert.deepEqual(folder.files, ['src/api/order.ts'])
  assert.equal(folder.fileCount, 1)
  assert.equal(folder.matchedCalls, 2)

  const segment = byKey.get('segment:api')
  assert.equal(segment.name, 'api 接口组')
  assert.equal(segment.source, 'path-segment')

  const deep = byKey.get('code:src/deep')
  assert.equal(deep.name, 'src/deep（未匹配）')
  assert.equal(deep.unmatchedCalls, 1)
  assert.equal(deep.matched, false)

  assert.ok(byKey.has('code:top.ts'))

  // 已匹配组排前，其次按调用数降序
  assert.deepEqual(groups.map((g) => g.key), [
    'folder:订单',
    'segment:api',
    'code:src/deep',
    'code:top.ts',
  ])
})

test('扫描器：analyzeProject 串起扫描、匹配、分组与统计', () => {
  const interfaces = [
    { id: 'i1', name: '订单详情', method: 'GET', path: '/api/orders/{id}', folder: '订单' },
    { id: 'i2', name: '创建订单', method: 'POST', path: '/api/orders', folder: '订单' },
    { id: 'i3', name: '健康检查', method: 'POST', path: '/api/ping', folder: '' },
    { id: 'i4', name: '用户列表', method: 'GET', path: '/api/users', folder: '' },
    { id: 'i5', name: '平台用户', method: 'GET', path: '/v1/users', folder: '' },
    { id: 'i6', name: '箭头', method: 'GET', path: '/api/arrow/{id}', folder: '' },
    { id: 'i7', name: '命名', method: 'GET', path: '/api/named', folder: '' },
    { id: 'i8', name: '方法', method: 'GET', path: '/api/method', folder: '' },
    { id: 'i9', name: '保留', method: 'GET', path: '/api/keep', folder: '' },
  ]
  const report = analyzeProject(ROOT, interfaces)
  assert.equal(report.root, path.resolve(ROOT))
  assert.equal(report.scannedFiles, 5)
  assert.equal(report.callCount, 9)
  assert.equal(report.matchedCalls + report.unmatchedCalls, report.callCount)
  assert.equal(report.matchRate, Math.round((report.matchedCalls / report.callCount) * 100))
  assert.ok(report.matchedInterfaces > 0)
  assert.ok(report.groups.length > 0)
  assert.ok(report.calls.length <= 1200)
  assert.ok(report.scannedAt > 0)

  const empty = analyzeProject(ROOT, [])
  assert.equal(empty.matchedCalls, 0)
  assert.equal(empty.matchRate, 0)
})
