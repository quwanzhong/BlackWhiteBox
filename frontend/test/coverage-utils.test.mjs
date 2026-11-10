/**
 * 回归：覆盖率视图模型（M3-3）。
 *
 * 重点是「不要把没有数字的状态伪装成 0%」：
 *   - agent 不可达 = 无证据；没配 classfiles = 待分析；分析失败 = error；
 *   - 只有 analyzed + totals.total > 0 才显示 covered/total；
 *   - coverage.dump 增量不能抹掉已解析的 result。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  coverageBadge,
  fileRows,
  firstUncovered,
  fmtPct,
  mergeCoverageEvent,
  parseCoverageTargets,
  rateTone,
  stepUncovered,
  summarizeCoverage,
} from '../src/utils/coverage.ts'

const analyzed = (nodeId, covered, missed, extra = {}) => ({
  nodeId,
  status: 'analyzed',
  result: {
    files: [{ path: 'com/demo/A.java', covered: Array.from({ length: covered }, (_, i) => i + 1), missed: Array.from({ length: missed }, (_, i) => covered + i + 1) }],
    totals: { covered, missed, total: covered + missed, lineRate: Math.round((covered / (covered + missed)) * 10000) / 100, files: 1 },
    ...extra,
  },
})

test('coverageBadge：四种无数字状态可区分，有数据才显示 covered/total', () => {
  assert.deepEqual([coverageBadge(null).text, coverageBadge(null).tone], ['', 'none'])
  assert.equal(coverageBadge({ nodeId: 'n', status: 'unavailable', error: 'COVERAGE_AGENT_UNREACHABLE: x' }).text, '无证据')
  assert.equal(coverageBadge({ nodeId: 'n', status: 'captured' }).text, '待分析')
  assert.equal(coverageBadge({ nodeId: 'n', status: 'captured', error: 'COVERAGE_ANALYZE_FAILED: x' }).text, '分析失败')
  assert.equal(coverageBadge({ nodeId: 'n', status: 'analyzed', result: null }).text, '已分析')
  assert.equal(coverageBadge({ nodeId: 'n', status: 'analyzed', result: { totals: { total: 0, covered: 0 } } }).text, '无行数据')

  const badge = coverageBadge(analyzed('n1', 12, 4))
  assert.equal(badge.text, '12/16')
  assert.equal(badge.tone, 'warn')
  assert.match(badge.title, /75%/)
  assert.equal(coverageBadge(analyzed('n2', 90, 10)).tone, 'ok')
  assert.equal(coverageBadge(analyzed('n3', 1, 9)).tone, 'bad')
})

test('fmtPct / rateTone：无数据不显示 0%', () => {
  assert.equal(fmtPct(null), '—')
  assert.equal(fmtPct(undefined), '—')
  assert.equal(fmtPct(80), '80%')
  assert.equal(fmtPct(66.67), '66.7%')
  assert.equal(rateTone(null), 'none')
  assert.equal(rateTone(80), 'ok')
  assert.equal(rateTone(79.9), 'warn')
  assert.equal(rateTone(49.9), 'bad')
})

test('summarizeCoverage：按证据状态分类，合计只算 analyzed', () => {
  const summary = summarizeCoverage([
    analyzed('n1', 30, 10),
    analyzed('n2', 10, 0),
    { nodeId: 'n3', status: 'captured' },
    { nodeId: 'n4', status: 'captured', error: 'COVERAGE_CLASSFILES_MISSING: x' },
    { nodeId: 'n5', status: 'unavailable', error: 'COVERAGE_AGENT_UNREACHABLE: x' },
  ])
  assert.equal(summary.total, 5)
  assert.equal(summary.analyzed, 2)
  assert.equal(summary.pending, 1)
  assert.equal(summary.analysisFailed, 1)
  assert.equal(summary.unavailable, 1)
  assert.equal(summary.covered, 40)
  assert.equal(summary.statLines, 50)
  assert.equal(summary.lineRate, 80)
  assert.equal(summarizeCoverage([]).lineRate, null)
})

test('fileRows：未覆盖行多的在前，同数量按路径稳定排序，并给出短名', () => {
  const rows = fileRows({
    files: [
      { path: 'com/demo/a/A.java', covered: [1], missed: [2] },
      { path: 'com/demo/b/B.java', covered: [1, 2, 3], missed: [4, 5] },
      { path: 'com/demo/c/C.java', covered: [], missed: [] },
      { path: 'com/demo/d/D.java', covered: [], missed: [2, 9] },
    ],
  })
  assert.deepEqual(
    rows.map((row) => row.path),
    ['com/demo/b/B.java', 'com/demo/d/D.java', 'com/demo/a/A.java', 'com/demo/c/C.java']
  )
  assert.equal(rows[0].short, 'b/B.java')
  assert.equal(rows[0].lineRate, 60)
  assert.deepEqual(rows[1].missedLines, [2, 9])
  assert.equal(rows[3].lineRate, null)
  assert.deepEqual(fileRows(null), [])
})

test('firstUncovered / stepUncovered：源码打开定位与未覆盖行前后跳转', () => {
  assert.equal(firstUncovered({ missed: [7, 9] }), 7)
  assert.equal(firstUncovered({ missed: [] }), 1)
  assert.equal(firstUncovered(null), 1)

  const missed = [3, 8, 12]
  assert.equal(stepUncovered(missed, 1, 1), 3)
  assert.equal(stepUncovered(missed, 3, 1), 8)
  assert.equal(stepUncovered(missed, 12, 1), 3)
  assert.equal(stepUncovered(missed, 12, -1), 8)
  assert.equal(stepUncovered(missed, 1, -1), 12)
  assert.equal(stepUncovered([], 5, 1), null)
})

test('parseCoverageTargets：多行目标去空行、去重、保序，非字符串返回空数组', () => {
  assert.deepEqual(
    parseCoverageTargets('com.demo.OrderService#create\r\n\r\n  com.demo.OrderRepository  \ncom.demo.OrderService#create\n'),
    ['com.demo.OrderService#create', 'com.demo.OrderRepository']
  )
  assert.deepEqual(parseCoverageTargets(''), [])
  assert.deepEqual(parseCoverageTargets(null), [])
  assert.deepEqual(parseCoverageTargets(['com.demo.A']), [])
})

test('mergeCoverageEvent：dump 更新状态但保留已解析 result，新节点追加', () => {
  const rows = [analyzed('n1', 3, 1)]
  const merged = mergeCoverageEvent(rows, {
    type: 'coverage.dump',
    ts: 123,
    payload: { nodeId: 'n1', coverageId: 'c1', status: 'captured', bytes: 42 },
  })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].bytes, 42)
  assert.equal(merged[0].result.totals.total, 4)
  assert.equal(merged[0].capturedAt, 123)

  const added = mergeCoverageEvent(merged, {
    type: 'coverage.dump',
    ts: 200,
    payload: { nodeId: 'n2', coverageId: 'c2', status: 'unavailable', error: 'COVERAGE_AGENT_UNREACHABLE: x', bytes: 0 },
  })
  assert.equal(added.length, 2)
  assert.equal(added[1].status, 'unavailable')
  assert.equal(added[1].result, null)

  // 其它事件不参与合并（analyzed 走重新拉取）
  assert.equal(mergeCoverageEvent(rows, { type: 'coverage.analyzed', payload: { nodeId: 'n1' } }), rows)
})
