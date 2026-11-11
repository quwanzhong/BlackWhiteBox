/**
 * 回归：调用链视图模型（M3'-2 · W1）
 *
 * 重点不是格式化，而是「不撒谎」：
 *   - missing / not-built 必须给出提示，且不允许查询（不能显示成 0 条链路）；
 *   - 断链要说「待关联 / 不是无调用方」，callerCount=0 才允许说「工程内无调用方」；
 *   - 入口率同时给可归因分母与全局分母。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alertType,
  brokenReasonText,
  chainView,
  confidenceTone,
  endpointRows,
  gapSections,
  graphStateView,
  graphStatRows,
  noEntryRows,
  orphanRows,
  tagType,
  truncationReasons,
} from '../src/utils/codegraph.ts'

test('graphStateView：四种状态可区分，未构建不让查询也不显示 0 条', () => {
  assert.deepEqual(graphStateView(null), { text: '未加载', tone: 'none', notice: '', canQuery: false })

  const missing = graphStateView({ state: 'missing', reason: 'no-scan' })
  assert.equal(missing.text, '未扫描')
  assert.equal(missing.canQuery, false)
  assert.match(missing.notice, /先完成「② 扫描/)

  const notBuilt = graphStateView({ state: 'stale', reason: 'not-built' })
  assert.equal(notBuilt.text, '未构建')
  assert.equal(notBuilt.canQuery, false)
  assert.match(notBuilt.notice, /不显示「0 条链路」/)

  const changed = graphStateView({ state: 'stale', reason: 'scan-changed' })
  assert.equal(changed.text, '需重建')
  assert.equal(changed.canQuery, true, '旧图仍可查询，但必须提示需重建')

  assert.equal(graphStateView({ state: 'fresh' }).tone, 'ok')
  assert.equal(tagType('bad'), 'danger')
  assert.equal(alertType('bad'), 'error')
})

test('graphStatRows：入口率同时保留可归因与全局分母', () => {
  const rows = graphStatRows({
    durationMs: 479,
    stats: {
      fileCount: 250,
      functionCount: 6451,
      callSiteCount: 161,
      matchCallCount: 93,
      callsWithEntry: 70,
      callSitesWithCaller: 70,
      callChainRateAmongCallable: 100,
      callChainRate: 43,
      endpointCount: 88,
      endpointsWithEntry: 67,
      endpointChainRate: 76,
    },
  })
  const entry = rows.find((r) => r.label === '有入口调用点')
  assert.equal(entry.value, '70/70')
  assert.match(entry.hint, /可归因 100%/)
  assert.match(entry.hint, /全局 43%/)
  assert.equal(rows.find((r) => r.label === '构建耗时').value, '479 ms')
  assert.deepEqual(graphStatRows(null), [])
})

test('graphStatRows：没有可归因分母时显示 —，不伪装成 0%', () => {
  const rows = graphStatRows({ stats: { callsWithEntry: 0, callSiteCount: 3 } })
  const entry = rows.find((r) => r.label === '有入口调用点')
  assert.equal(entry.value, '0/0')
  assert.match(entry.hint, /可归因 —/)
})

test('endpointRows：搜索 / 有入口 / 断链筛选，排序有入口优先', () => {
  const payload = {
    endpoints: [
      { interfaceId: 'GET /a', method: 'GET', path: '/a', name: 'A', hasEntry: false, callSiteCount: 9 },
      { interfaceId: 'POST /b', method: 'POST', path: '/b', name: '账单', hasEntry: true, callSiteCount: 1 },
      { interfaceId: 'POST /c', method: 'POST', path: '/c', name: 'C', hasEntry: true, callSiteCount: 5 },
    ],
  }
  assert.deepEqual(endpointRows(payload).map((r) => r.interfaceId), ['POST /c', 'POST /b', 'GET /a'])
  assert.deepEqual(endpointRows(payload, { filter: 'broken' }).map((r) => r.interfaceId), ['GET /a'])
  assert.deepEqual(endpointRows(payload, { filter: 'entry' }).map((r) => r.interfaceId), ['POST /c', 'POST /b'])
  assert.deepEqual(endpointRows(payload, { keyword: '账单' }).map((r) => r.interfaceId), ['POST /b'])
})

test('chainView：断链说「待关联，不是无调用方」，low 用 warning 不用 danger', () => {
  const ok = chainView({
    confidence: 'high',
    hops: 3,
    entry: { route: '/bill', file: 'src/views/bill/index.vue', name: 'Bill' },
  })
  assert.equal(ok.broken, false)
  assert.match(ok.entryText, /\/bill/)
  assert.equal(ok.confidenceTone, 'success')

  const broken = chainView({ confidence: 'low', hops: 1, entry: null, reason: 'no-entry' })
  assert.equal(broken.broken, true)
  assert.match(broken.entryText, /断链/)
  assert.match(broken.reasonText, /不是「无调用方」/)
  assert.equal(broken.confidenceTone, 'warning')
  assert.equal(confidenceTone('medium'), 'primary')

  assert.match(brokenReasonText('depth-limit'), /不是「无调用方」/)
  assert.match(brokenReasonText('not-in-ast'), /人工关联/)
})

test('noEntryRows：callerCount=0 才是工程内无调用方', () => {
  const rows = noEntryRows({
    noEntryCalls: [
      { callId: 'a', file: 'src/api/x.js', line: 8, interfaceId: 'POST /x', callerCount: 0 },
      { callId: 'b', file: 'src/api/y.js', line: 9, interfaceId: 'POST /y', callerCount: 2 },
    ],
  })
  assert.equal(rows[0].callerText, '工程内无调用方（死代码 / 未被引用）')
  assert.equal(rows[0].tone, 'info')
  assert.match(rows[1].callerText, /有 2 个调用方/)
  assert.equal(rows[1].tone, 'warning')
  assert.equal(rows[0].where, 'src/api/x.js:8')
})

test('gapSections / orphanRows / truncationReasons：断链分组与截断原因可读', () => {
  const sections = gapSections({
    unresolved: [{ file: 'a.js', line: 1, callee: 'obj[name]()', reason: 'dynamic' }],
    unresolvedImports: [{ file: 'b.js', line: 2, source: '@commonlib/x' }],
    parseErrors: [{ file: 'broken.vue', message: 'Unexpected token' }],
    skippedFiles: [{ file: 'big.js', reason: 'node-budget' }],
  })
  assert.deepEqual(sections.map((s) => s.title), ['未解析调用', '未解析 import', '解析失败文件', '被跳过的文件'])
  assert.equal(sections[0].rows[0].detail, 'obj[name]() · dynamic')
  assert.equal(sections[2].rows[0].where, 'broken.vue')

  assert.deepEqual(orphanRows({ orphanInterfaces: [{ interfaceId: 'GET /x', name: '孤儿', method: 'GET', path: '/x' }] }), [
    { key: 'GET /x', name: '孤儿', detail: 'GET /x' },
  ])

  assert.deepEqual(truncationReasons({ truncatedReasons: ['chain-limit', 'weird'] }), [
    '单接口链路数触顶（chain-limit），只展示前 N 条',
    'weird',
  ])
})
