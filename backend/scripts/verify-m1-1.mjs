/**
 * M1-1 验收脚本（一次性/可重复执行）：SQLite 与旧 JSON 无损比对 + 性能复测。
 *
 *   node scripts/verify-m1-1.mjs
 *
 * 只读真实库，性能测试在临时副本上做，不会改动 backend/data/heibaihe.db。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, DB_FILE, FLOWS_FILE, PROJECTS_FILE, BUGS_FILE, EXEC_DIR, EXEC_INDEX_FILE } from '../src/config.js'
import { openDatabase } from '../src/infra/store/db.js'
import { createStore } from '../src/infra/store/index.js'

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)]
}

const bench = (times, fn) => {
  const samples = []
  for (let i = 0; i < times; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return { median: median(samples), min: Math.min(...samples), max: Math.max(...samples) }
}

const fmt = (n) => `${n.toFixed(2)} ms`
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/')

const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail })
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
  }
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`找不到数据库：${DB_FILE}\n请先启动一次后端，让 JSON 自动迁移。`)
  process.exit(1)
}

const db = openDatabase(DB_FILE)
const store = createStore(db)

// ---------- 1. 条数 ----------
const jsonFlows = readJson(FLOWS_FILE, [])
const jsonProjects = readJson(PROJECTS_FILE, [])
const jsonBugs = readJson(BUGS_FILE, [])
const jsonExecIndex = readJson(EXEC_INDEX_FILE, [])
const jsonExecDetails = fs.existsSync(EXEC_DIR)
  ? fs
      .readdirSync(EXEC_DIR)
      .filter((n) => n.endsWith('.json') && n !== 'index.json')
      .map((n) => readJson(path.join(EXEC_DIR, n), null))
      .filter(Boolean)
  : []

check('条数一致', () => {
  assert.equal(store.listFlows().length, jsonFlows.length)
  assert.equal(store.listProjects().length, jsonProjects.length)
  assert.equal(store.listBugs().length, jsonBugs.length)
  assert.equal(store.listExecutions().length, jsonExecIndex.length)
  return `flows=${jsonFlows.length} projects=${jsonProjects.length} bugs=${jsonBugs.length} executions=${jsonExecIndex.length}`
})

// ---------- 2. 逐条深比较 ----------
check('flows 无损（含节点/边/变量）', () => {
  const byId = new Map(store.listFlows().map((f) => [f.id, f]))
  for (const flow of jsonFlows) {
    assert.ok(byId.has(flow.id), `缺少流程 ${flow.id}`)
    assert.deepEqual(byId.get(flow.id), flow, `流程 ${flow.name || flow.id} 不一致`)
  }
  const nodes = jsonFlows.reduce((n, f) => n + (f.nodes?.length || 0), 0)
  const edges = jsonFlows.reduce((n, f) => n + (f.edges?.length || 0), 0)
  return `${jsonFlows.length} 条流程 · 节点 ${nodes} · 边 ${edges}`
})

check('projects 无损（1737 条接口 + 扫描结果）', () => {
  for (const project of jsonProjects) {
    const loaded = store.getProject(project.id)
    assert.ok(loaded, `缺少项目 ${project.id}`)
    assert.deepEqual(loaded, project, `项目 ${project.name} 不一致`)
  }
  const ifaces = jsonProjects.reduce((n, p) => n + (p.interfaces?.length || 0), 0)
  return `${jsonProjects.length} 个项目 · 接口 ${ifaces} 条`
})

check('executions 列表 meta 无损', () => {
  const byId = new Map(store.listExecutions().map((e) => [e.id, e]))
  for (const meta of jsonExecIndex) {
    const row = byId.get(meta.id)
    assert.ok(row, `缺少执行记录 ${meta.id}`)
    for (const key of ['flowId', 'flowName', 'flowType', 'projectId', 'business', 'status', 'startedAt', 'finishedAt']) {
      assert.deepEqual(row[key], meta[key] ?? null, `${meta.id}.${key} 不一致`)
    }
    assert.deepEqual(row.summary ?? null, meta.summary ?? null, `${meta.id}.summary 不一致`)
  }
  return `${jsonExecIndex.length} 条执行记录`
})

check('executions 详情无损（步骤/校验/事件）', () => {
  for (const detail of jsonExecDetails) {
    const loaded = store.getExecutionDetail(detail.id)
    assert.ok(loaded, `缺少执行详情 ${detail.id}`)
    // 旧明细里出现过的每个字段都必须逐字段无损（数组也做深比较）
    for (const [key, value] of Object.entries(detail)) {
      assert.deepEqual(loaded[key], value, `执行详情 ${detail.id}.${key} 不一致`)
    }
    // 组装层是旧形状的超集：早期记录没有 projectId/business 两个键，只允许以 null 补上
    for (const key of Object.keys(loaded).filter((k) => !(k in detail))) {
      assert.ok(['projectId', 'business'].includes(key), `执行详情 ${detail.id} 多出未知字段 ${key}`)
      assert.equal(loaded[key], null, `执行详情 ${detail.id}.${key} 应为 null`)
    }
  }
  const steps = jsonExecDetails.reduce((n, d) => n + (d.steps?.length || 0), 0)
  const events = jsonExecDetails.reduce((n, d) => n + (d.events?.length || 0), 0)
  return `${jsonExecDetails.length} 份详情 · 步骤 ${steps} · 事件 ${events}`
})

// ---------- 3. 性能复测（临时副本，不动真实库） ----------
const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-bench-')), 'bench.db')
fs.copyFileSync(DB_FILE, tmpFile)
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(DB_FILE + suffix)) fs.copyFileSync(DB_FILE + suffix, tmpFile + suffix)
}
const benchDb = openDatabase(tmpFile)
const benchStore = createStore(benchDb)
const projectId = benchStore.listProjectSummaries()[0]?.id
const sampleProject = benchStore.getProject(projectId)

const getProject = bench(20, () => {
  assert.ok(benchStore.getProject(projectId))
})
const saveProject = bench(20, () => {
  benchStore.saveProject({ ...sampleProject, updatedAt: Date.now() })
})
const listSummaries = bench(50, () => {
  assert.equal(benchStore.listProjectSummaries().length, 1)
})

// 旧 JSON 基线（2026-11-09 实测，见 docs/02 §11 M1-1）
const BASELINE = { getProject: 15.81, saveProject: 30.97, list: 15.38 }
const bytes = fs.statSync(DB_FILE).size
const jsonBytes = fs.statSync(PROJECTS_FILE).size + fs.statSync(FLOWS_FILE).size

benchDb.close()
fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true })
db.close()

// ---------- 4. 输出 ----------
console.log('\nM1-1 验收结果\n' + '='.repeat(64))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
}

console.log('\n性能（1737 条接口，中位数）\n' + '-'.repeat(64))
const perfRows = [
  ['getProject', '旧 JSON 读+解析', BASELINE.getProject, getProject],
  ['saveProject', '旧 JSON 读+解析+写 3.4 MB', BASELINE.saveProject, saveProject],
  ['listProjectSummaries', '旧 listProjects 全量解析', BASELINE.list, listSummaries],
]
for (const [name, oldDesc, oldMs, now] of perfRows) {
  const delta = ((now.median - oldMs) / oldMs) * 100
  console.log(
    `${name.padEnd(22)} ${fmt(oldMs).padStart(10)}  →  ${fmt(now.median).padStart(10)}  ` +
      `(${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%)   [旧：${oldDesc}]`
  )
}

console.log('\n体积\n' + '-'.repeat(64))
console.log(`SQLite ${rel(DB_FILE)}  ${(bytes / 1024).toFixed(1)} KB`)
console.log(`旧 JSON（projects+flows）  ${(jsonBytes / 1024).toFixed(1)} KB`)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? `结论：${failed.length} 项失败` : '结论：全部通过'))
process.exit(failed.length ? 1 : 0)
