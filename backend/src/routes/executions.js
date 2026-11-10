import { Router } from 'express'
import { store } from '../store.js'
import { sessions } from '../engine/registry.js'
import { FAILURE_CLASSES, enrichExecutionDetail } from '../reporting/classify.js'
import { EXPORT_FORMATS, normalizeFormat, renderExport } from '../reporting/export.js'

const router = Router()

/**
 * 列表：支持 ?flowId= 与 ?failureClass=（M2-3）。
 * 老执行记录没有归类投影列，先用详情里的 steps 现算一遍再筛选；
 * 只对「需要按归类筛选」的请求做补齐，普通列表不做额外 IO。
 */
router.get('/', (req, res) => {
  const failureClass = req.query.failureClass ? String(req.query.failureClass) : ''
  const flowId = req.query.flowId ? String(req.query.flowId) : ''

  let list
  if (failureClass && FAILURE_CLASSES.includes(failureClass)) {
    list = store.listExecutions().map((row) => {
      if (row.failureClass) return row
      const detail = store.getExecutionDetail(row.id)
      if (!detail) return row
      enrichExecutionDetail(detail)
      return { ...row, failureClass: detail.failureClass, failureReason: detail.failureReason }
    })
    list = list.filter((row) => row.failureClass === failureClass)
  } else {
    list = store.listExecutions()
  }

  if (flowId) list = list.filter((e) => e.flowId === flowId)
  res.json(list)
})

// 导出（M2-4）：JUnit XML / 单文件 HTML / JSON，统一先归类补齐再脱敏
router.get('/:id/export', (req, res) => {
  const format = normalizeFormat(req.query.format)
  if (!format) {
    return res.status(400).json({
      error: `不支持的导出格式：${req.query.format}`,
      code: 'EXPORT_BAD_FORMAT',
      formats: EXPORT_FORMATS,
    })
  }
  const detail = store.getExecutionDetail(req.params.id)
  if (!detail) return res.status(404).json({ error: '执行记录不存在', code: 'EXECUTION_NOT_FOUND' })

  // 与详情页同一份口径：老执行的归类读取时补齐后再导出
  enrichExecutionDetail(detail)
  const out = renderExport({
    format,
    kind: 'execution',
    name: detail.flowName,
    id: detail.id,
    execution: detail,
  })
  res.setHeader('Content-Type', out.contentType)
  res.setHeader('Content-Disposition', out.contentDisposition)
  res.send(out.body)
})

// 执行详情（含步骤 / 校验结果 / 事件流）
router.get('/:id', (req, res) => {
  const detail = store.getExecutionDetail(req.params.id)
  if (!detail) return res.status(404).json({ error: '执行记录不存在' })
  // 老数据：步骤/执行级归类读取时现算补齐（幂等，不写库）
  res.json(enrichExecutionDetail(detail))
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
