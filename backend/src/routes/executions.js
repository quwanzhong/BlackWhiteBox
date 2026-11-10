import { Router } from 'express'
import { store } from '../store.js'
import { sessions } from '../engine/registry.js'
import { FAILURE_CLASSES, enrichExecutionDetail } from '../reporting/classify.js'
import { EXPORT_FORMATS, normalizeFormat, renderExport } from '../reporting/export.js'
import {
  CoverageSourceError,
  buildSourceView,
  readSourceFile,
  resolveSourcePath,
} from '../coverage/source.js'

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

/**
 * M2-5 断线重放：返回 after 之后的事件（含 lastSeq）。
 * 前端重连后先按 lastSeq 补齐，再订阅 WS，最后按 seq 去重（docs/02 §5.3）。
 */
router.get('/:id/events', (req, res) => {
  const after = Number.parseInt(req.query.after, 10)
  const limit = Number.parseInt(req.query.limit, 10)
  const result = store.listExecutionEvents(req.params.id, {
    after: Number.isFinite(after) && after > 0 ? after : 0,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  })
  if (!result) {
    return res.status(404).json({ error: '执行记录不存在', code: 'EXECUTION_NOT_FOUND' })
  }
  res.json(result)
})

/**
 * M3-1：按节点归因的覆盖率快照（投影，不含原始 exec blob）。
 * 未配置覆盖率的环境不会产生行，返回空数组；配置了但 agent 不可用会有
 * `status='unavailable'` 行，前端据此显示「无运行时证据」而不是 0%。
 */
router.get('/:id/coverage', (req, res) => {
  const id = req.params.id
  if (!store.hasExecution(id)) {
    return res.status(404).json({ error: '执行记录不存在', code: 'EXECUTION_NOT_FOUND' })
  }
  const coverage = store.listExecutionCoverage(id)
  const pending = coverage.filter((item) => item.status === 'captured' && !item.error)
  const analysisFailed = coverage.filter((item) => item.status === 'captured' && item.error)
  res.json({
    executionId: id,
    count: coverage.length,
    analyzed: coverage.filter((item) => item.status === 'analyzed').length,
    unavailable: coverage.filter((item) => item.status === 'unavailable').length,
    // pending 只算「采到了、还在等分析」；分析失败是另一种可见状态，不能一直 pending
    pending: pending.length,
    analysisFailed: analysisFailed.length,
    coverage,
  })
})

/**
 * M3-3：覆盖率面板的源码视图。
 *
 * `?path=` 只能是本节点 result.files 里出现过的相对路径（不让接口变成任意文件读取），
 * 源码根目录取执行时的环境快照 `settings.coverage.sourcefiles`；
 * 返回带 `hit` 标记的逐行内容，前端据此标未覆盖行并跳转。
 */
router.get('/:id/coverage/:nodeId/source', (req, res) => {
  const id = req.params.id
  if (!store.hasExecution(id)) {
    return res.status(404).json({ error: '执行记录不存在', code: 'EXECUTION_NOT_FOUND' })
  }
  const row = store.listExecutionCoverage(id).find((item) => item.nodeId === req.params.nodeId)
  if (!row) {
    return res.status(404).json({ error: '该节点没有覆盖率记录', code: 'COVERAGE_NOT_FOUND' })
  }
  if (!row.result) {
    return res.status(409).json({
      error: row.error || '该节点的覆盖率证据尚未分析完成',
      code: row.error ? 'COVERAGE_ANALYSIS_FAILED' : 'COVERAGE_NOT_ANALYZED',
    })
  }
  const files = Array.isArray(row.result.files) ? row.result.files : []
  // 不带 path 时给「未覆盖行最多」的文件，前端打开面板即可看到最需要看的那份
  const fallback = [...files].sort((a, b) => (b.missed?.length || 0) - (a.missed?.length || 0))[0]
  const requested = req.query.path === undefined ? fallback?.path : String(req.query.path)
  if (!requested) {
    return res.status(404).json({ error: '该节点没有可查看的源码文件', code: 'COVERAGE_SOURCE_NOT_FOUND' })
  }
  const file = files.find((item) => item.path === requested)
  if (!file) {
    return res.status(400).json({
      error: '源码路径不在该节点的分析结果内',
      code: 'COVERAGE_SOURCE_NOT_IN_RESULT',
    })
  }
  const environment = store.getExecutionEnvironment(id)
  const root = environment?.settings?.coverage?.sourcefiles
  try {
    const resolved = resolveSourcePath(root, file.path)
    const raw = readSourceFile(resolved.absolute)
    const view = buildSourceView({
      path: resolved.path,
      text: raw.text,
      covered: file.covered,
      missed: file.missed,
      bytes: raw.bytes,
      truncated: raw.truncated,
    })
    res.json({
      executionId: id,
      nodeId: row.nodeId,
      sourcefiles: root,
      file: { covered: file.covered?.length || 0, missed: file.missed?.length || 0 },
      ...view,
    })
  } catch (err) {
    if (!(err instanceof CoverageSourceError)) throw err
    const status = err.code === 'COVERAGE_SOURCE_NOT_FOUND' ? 404 : 400
    res.status(status).json({ error: err.message, code: err.code })
  }
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
