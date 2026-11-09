/**
 * M1-2 验收脚本：执行明细按行写入的性能证据。
 *
 *   node scripts/verify-m1-2.mjs
 *
 * 对比「空库」与「500 次历史 × 40 步 = 20 000 行」两种库上的单节点写入成本，
 * 证明写入耗时与历史长度无关。全部在临时目录里跑，不碰 backend/data。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/infra/store/db.js'
import { createStore } from '../src/infra/store/index.js'

const HISTORY_RUNS = 500
const STEPS_PER_RUN = 40
const SAMPLES = 120

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)]
}
const p95 = (arr) => {
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]
}
const fmt = (n) => `${n.toFixed(3)} ms`

function prepare(label, withHistory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `heibaihe-m1-2-${label}-`))
  const db = openDatabase(path.join(dir, 'bench.db'))
  const store = createStore(db)

  if (withHistory) {
    const started = performance.now()
    db.transaction(() => {
      for (let i = 0; i < HISTORY_RUNS; i++) {
        store.saveExecutionMeta({ id: `h${i}`, flowId: 'f1', flowName: '历史', status: 'passed', startedAt: i })
        for (let seq = 1; seq <= STEPS_PER_RUN; seq++) {
          store.saveExecutionStep(`h${i}`, { nodeId: `n${seq}`, status: 'passed', seq })
        }
      }
    })()
    const rows = db.prepare('SELECT COUNT(*) AS n FROM execution_steps').get().n
    assert.equal(rows, HISTORY_RUNS * STEPS_PER_RUN)
    console.log(`  预置历史：${HISTORY_RUNS} 次执行 / ${rows} 行，耗时 ${(performance.now() - started).toFixed(0)} ms`)
  }

  store.saveExecutionMeta({ id: 'live', flowId: 'f1', flowName: '当前', status: 'running', startedAt: 1 })
  return { dir, db, store, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } }
}

function bench(fn) {
  const stepSamples = []
  const eventSamples = []
  for (let i = 0; i < SAMPLES; i++) {
    let t0 = performance.now()
    fn.step(i)
    stepSamples.push(performance.now() - t0)

    t0 = performance.now()
    fn.events(i)
    eventSamples.push(performance.now() - t0)
  }
  return {
    step: { median: median(stepSamples), p95: p95(stepSamples) },
    events: { median: median(eventSamples), p95: p95(eventSamples) },
  }
}

console.log('M1-2 验收：执行明细按行写入\n' + '='.repeat(64))

const empty = prepare('empty', false)
const history = prepare('history', true)

const run = (store) =>
  bench({
    // 同一节点的状态更新：执行热路径最常见的写
    step: (i) => store.saveExecutionStep('live', { nodeId: 'n1', status: i % 2 ? 'running' : 'passed', seq: 1, durationMs: i }),
    // 事件按 20 条/批提交（调度器的攒批上限）
    events: (i) =>
      store.appendExecutionEvents(
        'live',
        Array.from({ length: 20 }, (_, k) => ({ type: 'log', ts: i * 20 + k, payload: { message: `第 ${i}-${k} 条` } }))
      ),
  })

run(empty.store) // 预热
run(history.store)

const a = run(empty.store)
const b = run(history.store)

const row = (name, x, y) =>
  `  ${name.padEnd(16)} 空库 ${fmt(x.median).padStart(9)} (p95 ${fmt(x.p95).padStart(9)})` +
  `  |  ${HISTORY_RUNS * STEPS_PER_RUN} 行历史 ${fmt(y.median).padStart(9)} (p95 ${fmt(y.p95).padStart(9)})`

console.log('\n写入耗时（中位数，每项 ' + SAMPLES + ' 次采样）\n' + '-'.repeat(64))
console.log(row('单节点 UPSERT', a.step, b.step))
console.log(row('事件批 20 条', a.events, b.events))

const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail })
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
  }
}

check('单节点写入 < 5 ms（两种库）', () => {
  assert.ok(a.step.median < 5, `空库 ${fmt(a.step.median)}`)
  assert.ok(b.step.median < 5, `历史库 ${fmt(b.step.median)}`)
  return `空库 ${fmt(a.step.median)} / 历史 ${fmt(b.step.median)}`
})

check('写入成本不随历史增长（≤ 3 倍 + 1 ms）', () => {
  assert.ok(
    b.step.median <= a.step.median * 3 + 1,
    `空库 ${fmt(a.step.median)} → 历史 ${fmt(b.step.median)}`
  )
  return `放大 ${(b.step.median / Math.max(a.step.median, 0.001)).toFixed(1)}×`
})

check('20 条事件批量提交 < 5 ms', () => {
  assert.ok(a.events.median < 5, `空库 ${fmt(a.events.median)}`)
  assert.ok(b.events.median < 5, `历史库 ${fmt(b.events.median)}`)
  return `空库 ${fmt(a.events.median)} / 历史 ${fmt(b.events.median)}`
})

// 事件 seq 连续性（攒批也不能断号）
check('事件 seq 连续无缺口', () => {
  const seqs = history.db
    .prepare('SELECT seq FROM execution_events WHERE execution_id = ? ORDER BY seq')
    .all('live')
    .map((r) => r.seq)
  assert.equal(seqs.length, SAMPLES * 2 * 20, `事件条数 ${seqs.length}`)
  for (let i = 0; i < seqs.length; i++) assert.equal(seqs[i], i + 1, `第 ${i} 条 seq=${seqs[i]}`)
  return `${seqs.length} 条，1..${seqs.length}`
})

empty.close()
history.close()

console.log('\n结论\n' + '-'.repeat(64))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  —  ${r.detail}`)
const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? `结论：${failed.length} 项失败` : '结论：全部通过'))
process.exit(failed.length ? 1 : 0)
