import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在导入时固定数据目录，必须先设环境变量再动态导入 src 模块
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-coverage-source-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'source.db')
process.env.HEIBAIHE_TOKEN = 'coverage-source-token-0123456789abcdef'

const TOKEN = process.env.HEIBAIHE_TOKEN
const auth = { authorization: `Bearer ${TOKEN}` }

const {
  CoverageSourceError,
  MAX_SOURCE_BYTES,
  buildSourceView,
  normalizeSourcePath,
  readSourceFile,
  resolveSourcePath,
} = await import('../src/coverage/source.js')
const { store } = await import('../src/store.js')
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')

const SRC_ROOT = path.join(DIR, 'src')
fs.mkdirSync(path.join(SRC_ROOT, 'com', 'demo'), { recursive: true })
const ORDER_FILE = path.join(SRC_ROOT, 'com', 'demo', 'OrderService.java')
const ORDER_TEXT = ['package com.demo;', '', 'class OrderService {', '  int create() {', '    return 1;', '  }', '}', ''].join(
  '\n'
)
fs.writeFileSync(ORDER_FILE, ORDER_TEXT)
const OTHER_FILE = path.join(SRC_ROOT, 'com', 'demo', 'Unused.java')
fs.writeFileSync(OTHER_FILE, 'class Unused {}\n')
// 根目录外的敏感文件：任何路径解析都不允许读到它
const SECRET_FILE = path.join(DIR, 'secret.txt')
fs.writeFileSync(SECRET_FILE, 'TOP-SECRET\n')

after(() => {
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const codeOf = (fn) => {
  try {
    fn()
    return null
  } catch (err) {
    assert.ok(err instanceof CoverageSourceError, `应为 CoverageSourceError，实际 ${err}`)
    return err.code
  }
}

test('normalizeSourcePath：只放行相对路径，挡绝对路径/盘符/.. /控制字符', () => {
  assert.equal(normalizeSourcePath('com/demo/OrderService.java'), 'com/demo/OrderService.java')
  assert.equal(normalizeSourcePath('./com/demo/OrderService.java'), 'com/demo/OrderService.java')
  assert.equal(normalizeSourcePath('com\\demo\\OrderService.java'), 'com/demo/OrderService.java')
  assert.equal(normalizeSourcePath('  com/demo/OrderService.java  '), 'com/demo/OrderService.java')

  assert.equal(codeOf(() => normalizeSourcePath('')), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath('   ')), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath(null)), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath('/etc/passwd')), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath('C:\\Windows\\win.ini')), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath('com/../../etc/passwd')), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath('com/demo\u0000.java')), 'COVERAGE_SOURCE_PATH_INVALID')
  assert.equal(codeOf(() => normalizeSourcePath('a'.repeat(1025))), 'COVERAGE_SOURCE_PATH_INVALID')
})

test('buildSourceView：命中/未命中/中性行标记 + 行率，越界行号忽略', () => {
  const view = buildSourceView({
    path: 'com/demo/OrderService.java',
    text: 'a\r\nb\r\nc\r\n',
    covered: [1, 2, 2, 0, 99],
    missed: [3, -1, 42],
  })
  assert.equal(view.totalLines, 3)
  assert.deepEqual(view.lines.map((line) => line.hit), [1, 1, 0])
  assert.equal(view.lines[0].text, 'a')
  assert.deepEqual(view.covered, [1, 2])
  assert.deepEqual(view.missed, [3])
  assert.equal(view.statLines, 3)
  assert.equal(view.lineRate, 66.67)
  // 没有任何统计行时不能算出 0%，而是「无数据」
  const empty = buildSourceView({ path: 'x.java', text: '', covered: [], missed: [] })
  assert.equal(empty.totalLines, 0)
  assert.equal(empty.lineRate, null)
})

test('读取与解析：路径必须落在 sourcefiles 内，软链接不能逃逸', (t) => {
  const resolved = resolveSourcePath(SRC_ROOT, 'com/demo/OrderService.java')
  assert.equal(fs.realpathSync.native(resolved.absolute), fs.realpathSync.native(ORDER_FILE))
  const raw = readSourceFile(resolved.absolute)
  assert.equal(raw.truncated, false)
  assert.equal(raw.bytes, Buffer.byteLength(ORDER_TEXT))

  assert.equal(
    codeOf(() => resolveSourcePath(SRC_ROOT, '../secret.txt')),
    'COVERAGE_SOURCE_PATH_INVALID'
  )
  assert.equal(
    codeOf(() => resolveSourcePath(SRC_ROOT, 'com/demo/Nope.java')),
    'COVERAGE_SOURCE_NOT_FOUND'
  )
  assert.equal(
    codeOf(() => resolveSourcePath(path.join(DIR, 'no-such-root'), 'a.java')),
    'COVERAGE_SOURCEFILES_MISSING'
  )
  assert.equal(
    codeOf(() => resolveSourcePath(SECRET_FILE, 'a.java')),
    'COVERAGE_SOURCEFILES_MISSING'
  )

  // 软链接逃逸：root 内放一个指向 root 外的链接，realpath 校验必须拒绝
  const link = path.join(SRC_ROOT, 'escape.java')
  try {
    fs.symlinkSync(SECRET_FILE, link)
  } catch {
    t.diagnostic('当前环境不允许创建软链接，跳过逃逸用例')
    return
  }
  assert.equal(codeOf(() => resolveSourcePath(SRC_ROOT, 'escape.java')), 'COVERAGE_SOURCE_PATH_INVALID')
})

test('大文件截断：只读上限内的完整行，并显式标记 truncated', () => {
  const bigFile = path.join(SRC_ROOT, 'com', 'demo', 'Big.java')
  const line = `${'x'.repeat(99)}\n`
  const lines = Math.ceil(MAX_SOURCE_BYTES / line.length) + 10
  fs.writeFileSync(bigFile, line.repeat(lines))
  const raw = readSourceFile(bigFile)
  assert.equal(raw.truncated, true)
  assert.ok(raw.text.length > 0)
  assert.ok(!raw.text.endsWith('\n'))
  assert.ok(raw.text.split('\n').every((item) => item.length === 99))
  const view = buildSourceView({ path: 'com/demo/Big.java', text: raw.text, truncated: raw.truncated })
  assert.equal(view.truncated, true)
  assert.ok(view.totalLines > 0)
})

// ------------------------------------------------------------------ HTTP 接口
test('GET /coverage/:nodeId/source：命中标记 / 默认取未覆盖最多的文件 / 各类降级', async (t) => {
  const { createApp } = await import('../src/app.js')
  const { server, io } = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((resolve) => io.close(resolve))
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  })

  const get = (url) => fetch(`${base}${url}`, { headers: auth })

  const withSource = 'exec-with-source'
  store.saveExecutionMeta({
    id: withSource,
    flowId: 'flow-1',
    flowName: '源码查看',
    status: 'passed',
    startedAt: Date.now() - 100,
    finishedAt: Date.now(),
  })
  store.saveExecutionContext(withSource, {
    environment: { id: 'env-1', settings: { coverage: { sourcefiles: SRC_ROOT } } },
  })
  store.saveCoverage({
    executionId: withSource,
    nodeId: 'n1',
    status: 'analyzed',
    result: {
      files: [
        { path: 'com/demo/Unused.java', covered: [], missed: [], total: 0 },
        { path: 'com/demo/OrderService.java', covered: [1, 2, 4], missed: [3, 5], total: 5 },
      ],
      totals: { files: 2, covered: 3, missed: 2, total: 5, lineRate: 60 },
    },
  })
  store.saveCoverage({
    executionId: withSource,
    nodeId: 'n2',
    status: 'analyzed',
    result: {
      // 恶意/脏数据：结果里的路径试图越过 sourcefiles 根目录
      files: [{ path: '../secret.txt', covered: [], missed: [1], total: 1 }],
    },
  })
  store.saveCoverage({ executionId: withSource, nodeId: 'n3', status: 'captured', execBlob: Buffer.from([1]) })
  store.saveCoverage({
    executionId: withSource,
    nodeId: 'n4',
    status: 'analyzed',
    result: { files: [{ path: 'com/demo/Gone.java', covered: [], missed: [1], total: 1 }] },
  })

  // 默认：未覆盖最多（OrderService 2 行 > Unused 0 行）
  let res = await get(`/api/executions/${withSource}/coverage/n1/source`)
  assert.equal(res.status, 200)
  let body = await res.json()
  assert.equal(body.path, 'com/demo/OrderService.java')
  assert.equal(body.totalLines, 7)
  assert.equal(body.truncated, false)
  assert.deepEqual(body.covered, [1, 2, 4])
  assert.deepEqual(body.missed, [3, 5])
  assert.deepEqual(
    body.lines.filter((line) => line.hit !== null).map((line) => [line.nr, line.hit]),
    [[1, 1], [2, 1], [3, 0], [4, 1], [5, 0]]
  )
  assert.equal(body.lineRate, 60)
  assert.equal(body.file.covered, 3)

  // 显式 path
  res = await get(`/api/executions/${withSource}/coverage/n1/source?path=com%2Fdemo%2FUnused.java`)
  assert.equal(res.status, 200)
  body = await res.json()
  assert.equal(body.path, 'com/demo/Unused.java')
  assert.deepEqual(body.missed, [])

  // 路径不在该节点结果内 → 400（连遍历都到不了文件系统）
  res = await get(`/api/executions/${withSource}/coverage/n1/source?path=..%2F..%2Fsecret.txt`)
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'COVERAGE_SOURCE_NOT_IN_RESULT')

  // 结果里本身带 ../ → 解析层拒绝
  res = await get(`/api/executions/${withSource}/coverage/n2/source`)
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'COVERAGE_SOURCE_PATH_INVALID')

  // 已取证未分析 → 409；节点不存在 → 404
  res = await get(`/api/executions/${withSource}/coverage/n3/source`)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'COVERAGE_NOT_ANALYZED')
  res = await get(`/api/executions/${withSource}/coverage/nope/source`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'COVERAGE_NOT_FOUND')

  // 分析结果在、但磁盘文件没了 → 404
  res = await get(`/api/executions/${withSource}/coverage/n4/source`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'COVERAGE_SOURCE_NOT_FOUND')

  // 未配置 sourcefiles → 400，消息要点明配置项
  const noSource = 'exec-no-source'
  store.saveExecutionMeta({ id: noSource, flowId: 'flow-1', flowName: '无源码', status: 'passed' })
  store.saveExecutionContext(noSource, { environment: { id: 'env-2', settings: {} } })
  store.saveCoverage({
    executionId: noSource,
    nodeId: 'n1',
    status: 'analyzed',
    result: { files: [{ path: 'com/demo/OrderService.java', covered: [1], missed: [], total: 1 }] },
  })
  res = await get(`/api/executions/${noSource}/coverage/n1/source`)
  assert.equal(res.status, 400)
  body = await res.json()
  assert.equal(body.code, 'COVERAGE_SOURCEFILES_MISSING')
  assert.match(body.error, /sourcefiles/)

  // 执行不存在 → 404
  res = await get('/api/executions/nope/coverage/n1/source')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'EXECUTION_NOT_FOUND')
})
