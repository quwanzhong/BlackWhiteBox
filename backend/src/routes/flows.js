import { Router } from 'express'
import crypto from 'node:crypto'
import { store } from '../store.js'
import { RunSession } from '../engine/scheduler.js'
import { sessions } from '../engine/registry.js'
import { EnvironmentError, resolveEnvironment } from '../environments/service.js'

const router = Router()

function normalizeFlow(input = {}) {
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).map((n, i) => ({
    id: n.id || `n_${i + 1}`,
    name: n.name || `步骤 ${i + 1}`,
    kind: n.kind || undefined,
    action: n.action || { type: 'http', method: 'GET', url: '' },
    input: n.input ?? null,
    expected: n.expected || { status: 200, checks: [] },
    extract: n.extract || {},
    position: n.position || { x: 80 + i * 280, y: 160 },
  }))
  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(input.edges) ? input.edges : [])
    .filter((e) => e && nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({
      id: e.id || `e_${e.from}_${e.to}`,
      from: e.from,
      to: e.to,
      condition: e.condition || '',
    }))

  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || '未命名流程',
    type: input.type === 'whitebox' ? 'whitebox' : 'blackbox',
    description: input.description || '',
    projectId: input.projectId || '',
    business: input.business || '',
    source: input.source || '',
    variables: input.variables || {},
    nodes,
    edges,
  }
}

// 流程列表
router.get('/', (req, res) => {
  let flows = store.listFlows()
  if (req.query.type) flows = flows.filter((f) => f.type === req.query.type)
  res.json(
    flows.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      description: f.description,
      projectId: f.projectId || '',
      business: f.business || '',
      source: f.source || '',
      nodeCount: f.nodes?.length || 0,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }))
  )
})

// 新建流程
router.post('/', (req, res) => {
  const flow = normalizeFlow(req.body)
  store.saveFlow(flow)
  res.json(flow)
})

// 流程详情
router.get('/:id', (req, res) => {
  const flow = store.getFlow(req.params.id)
  if (!flow) return res.status(404).json({ error: '流程不存在' })
  res.json(flow)
})

// 更新流程
router.put('/:id', (req, res) => {
  const existing = store.getFlow(req.params.id)
  if (!existing) return res.status(404).json({ error: '流程不存在' })
  const flow = normalizeFlow({
    ...req.body,
    id: existing.id,
    createdAt: existing.createdAt,
  })
  flow.createdAt = existing.createdAt
  store.saveFlow(flow)
  res.json(flow)
})

// 删除流程
router.delete('/:id', (req, res) => {
  const existing = store.getFlow(req.params.id)
  if (!existing) return res.status(404).json({ error: '流程不存在' })
  store.deleteFlow(req.params.id)
  res.json({ ok: true })
})

// 执行流程
router.post('/:id/run', (req, res) => {
  const flow = store.getFlow(req.params.id)
  if (!flow) return res.status(404).json({ error: '流程不存在' })
  if (!flow.nodes?.length) return res.status(400).json({ error: '流程没有节点，无法执行' })

  // 环境解析失败要 400/404（含错误码），不能 500：这是用户可选参数
  let environment = null
  const environmentId = req.body?.environmentId
  if (environmentId != null && environmentId !== '') {
    try {
      environment = resolveEnvironment(String(environmentId))
    } catch (err) {
      if (err instanceof EnvironmentError) {
        return res.status(err.status).json({ error: err.message, code: err.code })
      }
      throw err
    }
    if (environment.projectId && flow.projectId && environment.projectId !== flow.projectId) {
      return res.status(400).json({
        error: `环境「${environment.name}」属于其他项目，不能用于该流程`,
        code: 'ENV_PROJECT_MISMATCH',
      })
    }
  }

  const variables = req.body?.variables
  const session = new RunSession(flow, req.io, {
    variables: variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : undefined,
    environment,
  })
  sessions.set(session.executionId, session)
  session.start().catch((err) => {
    console.error('[execution] 未捕获异常：', err)
    sessions.delete(session.executionId)
  })
  res.json({ executionId: session.executionId })
})

export default router
