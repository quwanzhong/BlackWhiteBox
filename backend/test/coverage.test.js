import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在导入时固定数据目录，必须先设环境变量再动态导入 src 模块
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-coverage-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'coverage.db')
process.env.HEIBAIHE_TOKEN = 'coverage-unit-token-0123456789abcdef'

const { CoverageCollector, coverageConfigFrom } = await import('../src/coverage/collector.js')
const { store } = await import('../src/store.js')
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')

after(() => {
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeClient({ resetError, dumpError, exec = Buffer.from([0x01, 0xc0, 0xc0, 0x10, 0x07]) } = {}) {
  const calls = []
  const client = {
    async reset() {
      calls.push('reset')
      if (resetError) throw resetError
      return { ok: true }
    },
    async dumpAndReset() {
      calls.push('dump')
      if (dumpError) throw dumpError
      return { exec, bytes: exec.length, ms: 1 }
    },
    async close() {
      calls.push('close')
    },
  }
  return { calls, factory: async () => client }
}

const codeError = (code, message) => Object.assign(new Error(message), { code })

test('coverageConfigFrom：未配置 / 显式关闭 / 默认值', () => {
  assert.equal(coverageConfigFrom(undefined), null)
  assert.equal(coverageConfigFrom({}), null)
  assert.equal(coverageConfigFrom({ coverage: { enabled: false } }), null)
  assert.equal(coverageConfigFrom({ coverage: 'jacoco' }), null)
  assert.deepEqual(coverageConfigFrom({ coverage: {} }), {
    source: 'jacoco',
    host: '127.0.0.1',
    port: 6300,
    timeoutMs: 5000,
  })
  assert.deepEqual(coverageConfigFrom({ coverage: { host: '10.0.0.7', port: 7000, timeoutMs: 900 } }), {
    source: 'jacoco',
    host: '10.0.0.7',
    port: 7000,
    timeoutMs: 900,
  })
})

test('collector：未配置覆盖率时是空实现，不产生任何行', async () => {
  const collector = new CoverageCollector({ executionId: 'exec-off' })
  assert.equal(collector.enabled, false)
  assert.equal(await collector.begin('n1'), null)
  assert.equal(await collector.end('n1'), null)
  assert.deepEqual(store.listExecutionCoverage('exec-off'), [])
  await collector.close()
})

test('collector：节点前 reset、节点后 dump 并落库（captured + pending）', async () => {
  const fake = fakeClient({ exec: Buffer.from([1, 2, 3, 4, 5]) })
  const collector = new CoverageCollector({
    executionId: 'exec-ok',
    settings: { coverage: { port: 6300 } },
    clientFactory: fake.factory,
  })
  assert.equal(collector.enabled, true)
  assert.deepEqual(await collector.begin('n1'), { nodeId: 'n1', reset: true })
  const view = await collector.end('n1')
  assert.deepEqual(fake.calls, ['reset', 'dump'])
  assert.equal(view.status, 'captured')
  assert.equal(view.bytes, 5)
  assert.equal(view.pending, true)
  assert.equal(view.error, null)

  const rows = store.listExecutionCoverage('exec-ok')
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'analyzedAt',
    'bytes',
    'capturedAt',
    'error',
    'executionId',
    'id',
    'mode',
    'nodeId',
    'result',
    'source',
    'status',
  ])
  // 列表投影不能带原始证据
  assert.equal(rows[0].execBlob, undefined)
  assert.equal(store.getCoverage(view.id).execBlob.toString('hex'), '0102030405')
})

test('collector：每个节点一份快照，按 node_id 覆盖写而不是追加', async () => {
  const execs = [Buffer.from([0xaa]), Buffer.from([0xbb, 0xcc]), Buffer.from([0xdd, 0xee, 0xff])]
  let i = 0
  const calls = []
  const collector = new CoverageCollector({
    executionId: 'exec-nodes',
    settings: { coverage: {} },
    clientFactory: async () => ({
      async reset() {
        calls.push('reset')
      },
      async dumpAndReset() {
        calls.push('dump')
        return { exec: execs[i++] }
      },
      async close() {},
    }),
  })
  await collector.begin('n1')
  await collector.end('n1')
  await collector.begin('n2')
  await collector.end('n2')
  await collector.begin('n1')
  await collector.end('n1')

  const rows = store.listExecutionCoverage('exec-nodes')
  assert.deepEqual(rows.map((r) => r.nodeId), ['n1', 'n2'])
  // 同一节点重跑覆盖写：保留最后一次的证据
  assert.equal(rows.find((r) => r.nodeId === 'n1').bytes, 3)
  assert.equal(rows.find((r) => r.nodeId === 'n2').bytes, 2)
  assert.deepEqual(calls, ['reset', 'dump', 'reset', 'dump', 'reset', 'dump'])
})

test('collector：reset 失败 → 降级写 unavailable，后续节点不再重试连接', async () => {
  const fake = fakeClient({
    resetError: codeError('COVERAGE_AGENT_TIMEOUT', '读取超时：需要 5 字节，只收到 0 字节'),
  })
  const collector = new CoverageCollector({
    executionId: 'exec-degrade',
    settings: { coverage: {} },
    clientFactory: fake.factory,
  })
  assert.equal(await collector.begin('n1'), null)
  const n1 = await collector.end('n1')
  assert.equal(n1.status, 'unavailable')
  assert.equal(n1.pending, false)
  assert.match(n1.error, /^COVERAGE_AGENT_TIMEOUT: /)

  assert.equal(await collector.begin('n2'), null)
  const n2 = await collector.end('n2')
  assert.equal(n2.status, 'unavailable')
  // 只连过一次：失败后的会话期熔断，避免每个节点都等一次超时
  assert.deepEqual(fake.calls, ['reset', 'close'])

  const rows = store.listExecutionCoverage('exec-degrade')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.status === 'unavailable' && r.bytes === 0))
  await collector.close()
})

test('collector：dump 失败（请求本身可能已报错）也保留 unavailable 证据', async () => {
  const fake = fakeClient({
    dumpError: codeError('COVERAGE_AGENT_PROTOCOL', '未知响应块类型 0x7f'),
  })
  const collector = new CoverageCollector({
    executionId: 'exec-dump-fail',
    settings: { coverage: {} },
    clientFactory: fake.factory,
  })
  await collector.begin('n1')
  const view = await collector.end('n1')
  assert.equal(view.status, 'unavailable')
  assert.match(view.error, /^COVERAGE_AGENT_PROTOCOL: /)
  assert.equal(store.listExecutionCoverage('exec-dump-fail').length, 1)
  assert.ok(fake.calls.includes('close'))
})

test('collector：close 释放连接且幂等', async () => {
  const fake = fakeClient()
  const collector = new CoverageCollector({
    executionId: 'exec-close',
    settings: { coverage: {} },
    clientFactory: fake.factory,
  })
  await collector.begin('n1')
  await collector.close()
  await collector.close()
  assert.equal(fake.calls.filter((c) => c === 'close').length, 1)
})

test('collector：clientFactory 抛错同样只降级', async () => {
  const collector = new CoverageCollector({
    executionId: 'exec-connect-fail',
    settings: { coverage: {} },
    clientFactory: async () => {
      throw codeError('COVERAGE_AGENT_UNREACHABLE', '无法连接 JaCoCo agent 127.0.0.1:6300（连接被拒绝）')
    },
  })
  assert.equal(await collector.begin('n1'), null)
  const view = await collector.end('n1')
  assert.equal(view.status, 'unavailable')
  assert.match(view.error, /连接被拒绝/)
})
