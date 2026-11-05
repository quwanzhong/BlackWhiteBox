import { Router } from 'express'
import crypto from 'node:crypto'
import { store } from '../store.js'

const router = Router()

const SEVERITIES = ['blocker', 'critical', 'major', 'minor', 'trivial']
const STATUSES = ['open', 'confirmed', 'fixing', 'fixed', 'verified', 'closed', 'rejected']

function normalizeBug(input, existing) {
  const base = existing ? structuredClone(existing) : { id: crypto.randomUUID(), createdAt: Date.now() }
  return {
    ...base,
    projectId: String(input.projectId ?? base.projectId ?? ''),
    flowId: String(input.flowId ?? base.flowId ?? ''),
    executionId: String(input.executionId ?? base.executionId ?? ''),
    nodeId: String(input.nodeId ?? base.nodeId ?? ''),
    stepName: String(input.stepName ?? base.stepName ?? ''),
    title: String(input.title ?? base.title ?? '未命名缺陷').trim() || '未命名缺陷',
    description: String(input.description ?? base.description ?? ''),
    severity: SEVERITIES.includes(input.severity) ? input.severity : base.severity || 'major',
    status: STATUSES.includes(input.status) ? input.status : base.status || 'open',
    reporter: String(input.reporter ?? base.reporter ?? ''),
    assignee: String(input.assignee ?? base.assignee ?? ''),
    actual: input.actual ?? base.actual ?? null,
    expected: input.expected ?? base.expected ?? null,
  }
}

function enrich(bug) {
  const project = bug.projectId ? store.getProject(bug.projectId) : null
  const flow = bug.flowId ? store.getFlow(bug.flowId) : null
  return {
    ...bug,
    projectName: project?.name || '',
    flowName: flow?.name || '',
  }
}

// 缺陷列表
router.get('/', (req, res) => {
  let bugs = store.listBugs()
  const { projectId, status, flowId, severity } = req.query
  if (projectId) bugs = bugs.filter((b) => b.projectId === projectId)
  if (status) bugs = bugs.filter((b) => b.status === status)
  if (flowId) bugs = bugs.filter((b) => b.flowId === flowId)
  if (severity) bugs = bugs.filter((b) => b.severity === severity)
  res.json(bugs.map(enrich))
})

// 缺陷统计
router.get('/stats', (_req, res) => {
  const bugs = store.listBugs()
  const byStatus = {}
  const bySeverity = {}
  for (const b of bugs) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1
    bySeverity[b.severity] = (bySeverity[b.severity] || 0) + 1
  }
  res.json({
    total: bugs.length,
    open: bugs.filter((b) => !['closed', 'verified', 'rejected'].includes(b.status)).length,
    closed: bugs.filter((b) => ['closed', 'verified'].includes(b.status)).length,
    byStatus,
    bySeverity,
  })
})

// 提交缺陷（可从执行报告某一步直接提交）
router.post('/', (req, res) => {
  const bug = normalizeBug(req.body || {})
  if (!bug.title.trim()) return res.status(400).json({ error: '请填写缺陷标题' })
  store.saveBug(bug)
  res.json(enrich(bug))
})

// 更新缺陷状态 / 内容
router.put('/:id', (req, res) => {
  const existing = store.listBugs().find((b) => b.id === req.params.id)
  if (!existing) return res.status(404).json({ error: '缺陷不存在' })
  const bug = normalizeBug(req.body || {}, existing)
  store.saveBug(bug)
  res.json(enrich(bug))
})

router.delete('/:id', (req, res) => {
  const existing = store.listBugs().find((b) => b.id === req.params.id)
  if (!existing) return res.status(404).json({ error: '缺陷不存在' })
  store.deleteBug(req.params.id)
  res.json({ ok: true })
})

export default router
