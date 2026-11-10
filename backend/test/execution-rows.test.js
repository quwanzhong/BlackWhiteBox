import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openDatabase } from '../src/infra/store/db.js'
import { createStore } from '../src/infra/store/index.js'

const MIGRATIONS = fileURLToPath(new URL('../src/migrations', import.meta.url))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-rows-'))
}

test('execution_steps：同一 seq UPSERT 覆盖，不追加；seq 不进入 step 本体', () => {
  const db = openDatabase(':memory:')
  try {
    const store = createStore(db)
    store.saveExecutionMeta({ id: 'e1', flowId: 'f1', status: 'running', startedAt: 1 })

    // 节点开始 → 结束：同一个 seq 两次写入，只保留一行
    store.saveExecutionStep('e1', { nodeId: 'n1', status: 'running', seq: 1 })
    store.saveExecutionStep('e1', { nodeId: 'n1', status: 'passed', seq: 1, durationMs: 5 })

    let steps = store.getExecutionDetail('e1').steps
    assert.equal(steps.length, 1)
    assert.equal(steps[0].status, 'passed')
    assert.equal(steps[0].durationMs, 5)
    assert.equal('seq' in steps[0], false, 'seq 是行内投影列，不应出现在 step 对象里')

    // 新节点用新 seq 追加，顺序按 seq
    store.saveExecutionStep('e1', { nodeId: 'n2', status: 'passed', seq: 2 })
    steps = store.getExecutionDetail('e1').steps
    assert.deepEqual(
      steps.map((s) => s.nodeId),
      ['n1', 'n2']
    )

    // 非法 seq 直接拒绝，避免写出一批无序号的行
    assert.throws(() => store.saveExecutionStep('e1', { nodeId: 'n3' }), /正整数/)
    assert.throws(() => store.saveExecutionStep('e1', { nodeId: 'n3', seq: 0 }), /正整数/)
    assert.equal(store.getExecutionDetail('e1').steps.length, 2)
  } finally {
    db.close()
  }
})

test('execution_events：多次批量提交后 seq 严格自增，可在已有的基础上继续追加', () => {
  const db = openDatabase(':memory:')
  try {
    const store = createStore(db)
    store.saveExecutionMeta({ id: 'e2', flowId: 'f1', status: 'running', startedAt: 1 })

    store.appendExecutionEvents('e2', [
      { type: 'flow_start', ts: 1, payload: { nodes: 2 } },
      { type: 'log', ts: 2, payload: { level: 'info', message: '开始' } },
    ])
    store.appendExecutionEvents('e2', [{ type: 'step_start', ts: 3, payload: { nodeId: 'n1' } }])
    store.appendExecutionEvents('e2', [{ type: 'flow_end', ts: 4, payload: { status: 'passed' } }])

    const seqs = db
      .prepare('SELECT seq FROM execution_events WHERE execution_id = ? ORDER BY seq')
      .all('e2')
      .map((r) => r.seq)
    assert.deepEqual(seqs, [1, 2, 3, 4], 'seq 必须连续，不能因分批而断开或覆盖')

    const detail = store.getExecutionDetail('e2')
    assert.deepEqual(
      detail.events.map((e) => e.type),
      ['flow_start', 'log', 'step_start', 'flow_end']
    )
    assert.deepEqual(detail.events[0], { executionId: 'e2', type: 'flow_start', payload: { nodes: 2 }, ts: 1 })

    // 空批次不改变计数
    assert.equal(store.appendExecutionEvents('e2', []), 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = ?').get('e2').n, 4)
  } finally {
    db.close()
  }
})

test('老库升级：M1-1 的 detail_json 自动展开为 context + 行，幂等', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'legacy.db')

  // 1) 只跑 001，手工造一条 M1-1 形状的执行记录（detail_json 整份存）
  const raw = new Database(file)
  raw.pragma('journal_mode = WAL')
  raw.exec(fs.readFileSync(path.join(MIGRATIONS, '001_init.sql'), 'utf8'))
  const legacyDetail = {
    id: 'e-old',
    flowId: 'f1',
    flowName: '订单流程',
    flowType: 'blackbox',
    projectId: 'p1',
    business: '订单',
    status: 'failed',
    startedAt: 100,
    finishedAt: 200,
    summary: { total: 2, passed: 1, failed: 1 },
    nodes: [{ id: 'n1', name: '创建订单' }, { id: 'n2', name: '取消订单' }],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    steps: [
      { id: 's1', nodeId: 'n1', nodeName: '创建订单', status: 'passed', durationMs: 12 },
      { id: 's2', nodeId: 'n2', nodeName: '取消订单', status: 'failed', durationMs: 8, error: '409' },
    ],
    events: [
      { executionId: 'e-old', type: 'flow_start', payload: { flowId: 'f1' }, ts: 100 },
      { executionId: 'e-old', type: 'step_end', payload: { nodeId: 'n1' }, ts: 120 },
      { executionId: 'e-old', type: 'flow_end', payload: { status: 'failed' }, ts: 200 },
    ],
    vars: { baseUrl: 'http://127.0.0.1:8080' },
  }
  raw
    .prepare(`
      INSERT INTO executions (id, flow_id, flow_name, flow_type, project_id, business,
                              status, started_at, finished_at, summary_json, detail_json,
                              created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'e-old',
      'f1',
      '订单流程',
      'blackbox',
      'p1',
      '订单',
      'failed',
      100,
      200,
      JSON.stringify(legacyDetail.summary),
      JSON.stringify(legacyDetail),
      100,
      200
    )
  raw.close()

  // 2) 正常打开：应当自动跑 002 并把 detail_json 展开成行
  const db = openDatabase(file)
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3)
    const store = createStore(db)
    const detail = store.getExecutionDetail('e-old')

    assert.deepEqual(detail.nodes, legacyDetail.nodes, 'nodes 必须是 JSON 数组而不是字符串')
    assert.deepEqual(detail.edges, legacyDetail.edges)
    assert.deepEqual(detail.vars, legacyDetail.vars)
    assert.deepEqual(detail.steps, legacyDetail.steps)
    assert.deepEqual(detail.events, legacyDetail.events, '事件顺序与 payload 必须无损')
    assert.deepEqual(detail.summary, legacyDetail.summary)
    assert.equal(detail.status, 'failed')

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_steps WHERE execution_id = ?').get('e-old').n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = ?').get('e-old').n, 3)
    assert.equal(db.prepare('SELECT event_seq FROM executions WHERE id = ?').get('e-old').event_seq, 3)
  } finally {
    db.close()
  }

  // 3) 再打开一次：不重复插入（回填判据是 context_json 仍为空）
  const again = openDatabase(file)
  try {
    assert.equal(createStore(again).getExecutionDetail('e-old').steps.length, 2)
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = ?').get('e-old').n, 3)
  } finally {
    again.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('单节点写入 < 5 ms，且不随历史长度增长', (t) => {
  const dir = tmpDir()
  const small = openDatabase(path.join(dir, 'small.db'))
  const big = openDatabase(path.join(dir, 'big.db'))
  try {
    const smallStore = createStore(small)
    const bigStore = createStore(big)

    // 历史：500 次执行 × 40 步 = 20 000 行，远超当前真实数据量
    const HISTORY_RUNS = 500
    const STEPS_PER_RUN = 40
    big.transaction(() => {
      for (let i = 0; i < HISTORY_RUNS; i++) {
        bigStore.saveExecutionMeta({ id: `h${i}`, flowId: 'f1', status: 'passed', startedAt: i, finishedAt: i + 1 })
        for (let seq = 1; seq <= STEPS_PER_RUN; seq++) {
          bigStore.saveExecutionStep(`h${i}`, { nodeId: `n${seq}`, status: 'passed', seq })
        }
      }
    })()
    assert.equal(big.prepare('SELECT COUNT(*) AS n FROM execution_steps').get().n, HISTORY_RUNS * STEPS_PER_RUN)

    smallStore.saveExecutionMeta({ id: 'live', flowId: 'f1', status: 'running', startedAt: 1 })
    bigStore.saveExecutionMeta({ id: 'live', flowId: 'f1', status: 'running', startedAt: 1 })

    const bench = (store) => {
      const samples = []
      for (let i = 0; i < 80; i++) {
        const t0 = performance.now()
        // 模拟同一节点的状态更新（执行热路径最常见的写）
        store.saveExecutionStep('live', { nodeId: 'n1', status: i % 2 ? 'running' : 'passed', seq: 1, durationMs: i })
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return { median: samples[Math.floor(samples.length / 2)], p95: samples[Math.floor(samples.length * 0.95)] }
    }

    // 预热，避免 JIT / 页缓存把第一份数据算进中位数
    bench(smallStore)
    bench(bigStore)

    const empty = bench(smallStore)
    const history = bench(bigStore)
    t.diagnostic(
      `空库 median=${empty.median.toFixed(3)} ms p95=${empty.p95.toFixed(3)} ms；` +
        `${HISTORY_RUNS * STEPS_PER_RUN} 行历史 median=${history.median.toFixed(3)} ms p95=${history.p95.toFixed(3)} ms`
    )

    assert.ok(empty.median < 5, `空库单节点写入中位数 ${empty.median.toFixed(2)} ms，超过 5 ms`)
    assert.ok(history.median < 5, `2 万行历史下单节点写入中位数 ${history.median.toFixed(2)} ms，超过 5 ms`)
    // UPSERT 走 (execution_id, seq) 唯一索引，理论上与历史长度无关；留 3 倍 + 1 ms 余量吸收 Windows 抖动
    assert.ok(
      history.median <= empty.median * 3 + 1,
      `写入成本随历史增长：空库 ${empty.median.toFixed(3)} ms → 有历史 ${history.median.toFixed(3)} ms`
    )
  } finally {
    small.close()
    big.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
