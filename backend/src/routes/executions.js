import { Router } from 'express'
import { store } from '../store.js'
import { sessions } from '../engine/registry.js'

const router = Router()

// 执行记录列表
router.get('/', (req, res) => {
  let list = store.listExecutions()
  if (req.query.flowId) list = list.filter((e) => e.flowId === req.query.flowId)
  res.json(list)
})

// 执行详情（含步骤 / 校验结果 / 事件流）
router.get('/:id', (req, res) => {
  const detail = store.getExecutionDetail(req.params.id)
  if (!detail) return res.status(404).json({ error: '执行记录不存在' })
  res.json(detail)
})

// 暂停
router.post('/:id/pause', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(400).json({ error: '执行会话不存在（可能已结束或服务已重启）' })
  res.json({ ok: session.pause() })
})

// 继续
router.post('/:id/resume', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(400).json({ error: '执行会话不存在（可能已结束或服务已重启）' })
  res.json({ ok: session.resume() })
})

// 停止
router.post('/:id/stop', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(400).json({ error: '执行会话不存在（可能已结束或服务已重启）' })
  res.json({ ok: session.stop() })
})

// 人工确认（白盒 / 人工步骤）
router.post('/:id/manual', (req, res) => {
  const { nodeId, pass, note } = req.body || {}
  const session = sessions.get(req.params.id)
  if (!session) return res.status(400).json({ error: '执行会话不存在（可能已结束或服务已重启）' })
  if (!nodeId) return res.status(400).json({ error: '缺少 nodeId' })
  const ok = session.confirmManual(nodeId, !!pass, note)
  res.json({ ok, hint: ok ? '已提交人工确认' : '该节点当前不在等待确认状态' })
})

export default router
