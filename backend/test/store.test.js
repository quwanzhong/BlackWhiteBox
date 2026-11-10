import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../src/infra/store/db.js'
import { createStore } from '../src/infra/store/index.js'
import { migrateLegacyJson } from '../src/infra/store/migrate-json.js'

function freshStore() {
  const db = openDatabase(':memory:')
  return { db, store: createStore(db), close: () => db.close() }
}

test('flows：增删改查 + 列表顺序 + 时间戳语义', () => {
  const { store, close } = freshStore()
  try {
    const a = store.saveFlow({ name: 'A', type: 'blackbox', nodes: [{ id: 'n1' }], edges: [] })
    const b = store.saveFlow({ name: 'B', type: 'whitebox', nodes: [], edges: [], variables: { x: 1 } })
    assert.ok(a.id && b.id)
    assert.equal(a.createdAt, a.updatedAt)

    assert.deepEqual(
      store.listFlows().map((f) => f.name),
      ['B', 'A'] // 与旧 JSON 实现一致：新插入的在最前
    )

    const before = store.getFlow(a.id)
    const updated = store.saveFlow({ ...before, name: 'A2' })
    assert.equal(updated.createdAt, before.createdAt)
    assert.ok(updated.updatedAt >= before.updatedAt)
    assert.deepEqual(
      store.listFlows().map((f) => f.name),
      ['B', 'A2'] // 更新不改变位置
    )

    store.deleteFlow(b.id)
    assert.deepEqual(
      store.listFlows().map((f) => f.name),
      ['A2']
    )
    assert.equal(store.getFlow('missing'), null)
  } finally {
    close()
  }
})

test('projects：1737 条接口保存 < 50 ms，读取无损，列表只返回投影', () => {
  const { store, close } = freshStore()
  try {
    const interfaces = Array.from({ length: 1737 }, (_, i) => ({
      id: `api-${i}`,
      name: `接口 ${i}`,
      method: i % 2 ? 'GET' : 'POST',
      path: `/api/v1/resource/${i}`,
      folder: `模块${i % 12}`,
      schema: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } },
    }))
    const project = {
      id: 'p1',
      name: '输研1.0',
      description: '压测项目',
      codePath: 'C:/work/web',
      serviceBaseUrl: 'http://127.0.0.1:8080',
      apifox: { projectId: '6683140', siteId: 's1' },
      interfaceIds: interfaces.map((it) => it.id),
      interfaces,
      scan: {
        scannedAt: 1762500000000,
        scannedFiles: 1200,
        callCount: 300,
        matchedCalls: 240,
        matchRate: 80,
        matchedInterfaces: 210,
        groups: [{ key: 'g1' }, { key: 'g2' }],
      },
    }

    const times = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      store.saveProject({ ...project, description: `压测项目-${i}` })
      times.push(performance.now() - t0)
    }
    times.sort((x, y) => x - y)
    const median = times[Math.floor(times.length / 2)]
    assert.ok(median < 50, `saveProject 中位数 ${median.toFixed(2)} ms，超过 50 ms`)

    const loaded = store.getProject('p1')
    assert.equal(loaded.interfaces.length, 1737)
    assert.deepEqual(loaded.interfaces[1736], interfaces[1736])
    assert.equal(loaded.description, '压测项目-4')

    const [summary] = store.listProjectSummaries()
    assert.equal(summary.interfaceCount, 1737)
    assert.equal(summary.folders.length, 12)
    assert.equal(summary.scan.groupCount, 2)
    assert.equal(summary.scan.matchRate, 80)
    assert.equal(summary.interfaces, undefined) // 列表不返回 3.4 MB 接口快照
    assert.equal(summary.apifoxProjectId, '6683140')
  } finally {
    close()
  }
})

test('executions：列表只读 meta，详情完整；后到的 meta 覆盖状态', () => {
  const { store, close } = freshStore()
  try {
    const meta = {
      id: 'e1',
      flowId: 'f1',
      flowName: '订单流程',
      flowType: 'blackbox',
      projectId: 'p1',
      business: '订单',
      status: 'running',
      startedAt: 1762500000000,
      finishedAt: null,
      summary: null,
    }
    store.saveExecutionMeta(meta)
    // M1-2 起：只要有 meta 行就返回完整骨架（不再是 null），便于前端安全渲染
    const skeleton = store.getExecutionDetail('e1')
    assert.deepEqual(
      { steps: skeleton.steps, events: skeleton.events, nodes: skeleton.nodes, edges: skeleton.edges, vars: skeleton.vars },
      { steps: [], events: [], nodes: [], edges: [], vars: {} }
    )
    assert.equal(skeleton.status, 'running')

    const detail = {
      ...meta,
      envId: null,
      envVersion: null,
      suiteRunId: null,
      failureClass: null,
      failureReason: null,
      environment: null,
      nodes: [{ id: 'n1', name: '创建订单' }],
      edges: [],
      steps: [{ nodeId: 'n1', status: 'passed' }],
      events: [{ executionId: 'e1', type: 'flow_start', payload: {}, ts: 1 }],
      vars: { baseUrl: 'http://127.0.0.1' },
    }
    store.saveExecutionDetail(detail)
    // 行表往返无损：step 的 seq 只在库里，事件按 (execution_id, seq) 还原
    assert.deepEqual(store.getExecutionDetail('e1'), detail)

    store.saveExecutionMeta({ ...meta, status: 'passed', finishedAt: 1762500009999, summary: { passed: 1 } })
    const [row] = store.listExecutions()
    assert.equal(row.status, 'passed')
    assert.equal(row.summary.passed, 1)
    assert.equal(row.steps, undefined) // 列表不读 detail_json

    // 详情不被 meta 覆盖
    assert.equal(store.getExecutionDetail('e1').steps.length, 1)
  } finally {
    close()
  }
})

test('bugs：保存、列表、删除', () => {
  const { store, close } = freshStore()
  try {
    const bug = store.saveBug({ title: '金额少 1 分', projectId: 'p1', flowId: 'f1', status: 'open' })
    const second = store.saveBug({ title: '重复下单', projectId: 'p1', status: 'closed' })
    assert.deepEqual(
      store.listBugs().map((b) => b.title),
      ['重复下单', '金额少 1 分']
    )
    store.deleteBug(bug.id)
    assert.deepEqual(
      store.listBugs().map((b) => b.id),
      [second.id]
    )
  } finally {
    close()
  }
})

test('迁移：JSON 一次性导入 SQLite，顺序一致且可重复调用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-migrate-'))
  const execDir = path.join(dir, 'executions')
  fs.mkdirSync(execDir)
  const flowsFile = path.join(dir, 'flows.json')
  const projectsFile = path.join(dir, 'projects.json')
  const bugsFile = path.join(dir, 'bugs.json')
  const execIndexFile = path.join(execDir, 'index.json')

  // 旧数组：新在前
  fs.writeFileSync(
    flowsFile,
    JSON.stringify([
      { id: 'f-new', name: '新流程', type: 'blackbox', createdAt: 2, updatedAt: 2, nodes: [], edges: [] },
      { id: 'f-old', name: '旧流程', type: 'whitebox', createdAt: 1, updatedAt: 1, nodes: [], edges: [] },
    ])
  )
  fs.writeFileSync(
    projectsFile,
    JSON.stringify([
      {
        id: 'p1',
        name: '项目',
        interfaceIds: ['a', 'b'],
        interfaces: [{ id: 'a', folder: 'F1' }, { id: 'b', folder: 'F1' }],
        scan: { callCount: 2, groups: [] },
        createdAt: 1,
        updatedAt: 1,
      },
    ])
  )
  fs.writeFileSync(bugsFile, JSON.stringify([{ id: 'b1', status: 'open', createdAt: 1, updatedAt: 1 }]))
  fs.writeFileSync(
    execIndexFile,
    JSON.stringify([
      { id: 'e-new', flowId: 'f-new', status: 'passed', startedAt: 2, finishedAt: 2, summary: { passed: 1 } },
      { id: 'e-old', flowId: 'f-old', status: 'failed', startedAt: 1, finishedAt: 1 },
    ])
  )
  fs.writeFileSync(
    path.join(execDir, 'e-old.json'),
    JSON.stringify({ id: 'e-old', flowId: 'f-old', status: 'failed', startedAt: 1, steps: [{ nodeId: 'n1' }] })
  )
  fs.writeFileSync(
    path.join(execDir, 'e-orphan.json'),
    JSON.stringify({ id: 'e-orphan', flowId: 'f-old', status: 'passed', startedAt: 3, steps: [] })
  )

  const db = openDatabase(':memory:')
  try {
    const silent = { info() {}, warn() {} }
    const counts = migrateLegacyJson(db, { flowsFile, projectsFile, bugsFile, execIndexFile, execDir }, silent)
    assert.equal(counts.flows, 2)
    assert.equal(counts.projects, 1)
    assert.equal(counts.bugs, 1)
    assert.equal(counts.executions, 3)

    const store = createStore(db)
    assert.deepEqual(
      store.listFlows().map((f) => f.id),
      ['f-new', 'f-old'] // rowid DESC 还原"新在前"
    )
    assert.deepEqual(
      store.listExecutions().map((e) => e.id),
      ['e-orphan', 'e-new', 'e-old']
    )
    assert.deepEqual(store.getExecutionDetail('e-old').steps, [{ nodeId: 'n1' }])
    assert.equal(store.getProject('p1').interfaces.length, 2)
    assert.equal(store.listProjectSummaries()[0].folders[0], 'F1')

    // 第二次调用：标记已迁移，不重复插入
    const again = migrateLegacyJson(db, { flowsFile, projectsFile, bugsFile, execIndexFile, execDir }, silent)
    assert.equal(again.skipped, true)
    assert.equal(store.listFlows().length, 2)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
