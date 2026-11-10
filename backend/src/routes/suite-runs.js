import { Router } from 'express'
import { store } from '../store.js'
import { stopSuiteRun } from '../suites/runner.js'
import { enrichExecutionDetail } from '../reporting/classify.js'
import { EXPORT_FORMATS, normalizeFormat, renderExport } from '../reporting/export.js'

const router = Router()

/** 套件执行历史（默认最近 20 条；可按 suiteId 过滤） */
router.get('/', (req, res) => {
  res.json(
    store.listSuiteRuns({
      suiteId: req.query.suiteId ? String(req.query.suiteId) : '',
      limit: req.query.limit || 20,
    })
  )
})

/** 执行详情：套件汇总 + 每条流程对应的 executions（含重试产生的多次执行） */
router.get('/:id', (req, res) => {
  const run = store.getSuiteRun(req.params.id)
  if (!run) return res.status(404).json({ error: '套件执行不存在', code: 'SUITE_RUN_NOT_FOUND' })
  res.json({ ...run, executions: store.listExecutionsBySuiteRun(run.id) })
})

/**
 * 导出（M2-4）：一次套件执行 = 一份报告。
 * 同一 Flow 因重试产生多条 execution 时只取最后一次尝试（与页面「最终结果」一致），
 * 重试次数/flaky 通过 <properties> 与 JSON 的 suiteRun.summary 保留。
 */
router.get('/:id/export', (req, res) => {
  const format = normalizeFormat(req.query.format)
  if (!format) {
    return res.status(400).json({
      error: `不支持的导出格式：${req.query.format}`,
      code: 'EXPORT_BAD_FORMAT',
      formats: EXPORT_FORMATS,
    })
  }
  const run = store.getSuiteRun(req.params.id)
  if (!run) return res.status(404).json({ error: '套件执行不存在', code: 'SUITE_RUN_NOT_FOUND' })

  // listExecutionsBySuiteRun 按 started_at 升序，同一 flowId 后者覆盖前者 = 最后一次尝试
  const finalByFlow = new Map()
  for (const row of store.listExecutionsBySuiteRun(run.id)) finalByFlow.set(row.flowId, row)
  const executions = [...finalByFlow.values()]
    .map((row) => {
      const detail = store.getExecutionDetail(row.id)
      return detail ? enrichExecutionDetail(detail) : null
    })
    .filter(Boolean)

  const out = renderExport({
    format,
    kind: 'suite-run',
    name: run.suiteName || run.suiteId,
    id: run.id,
    suiteRun: run,
    executions,
  })
  res.setHeader('Content-Type', out.contentType)
  res.setHeader('Content-Disposition', out.contentDisposition)
  res.send(out.body)
})

/** 停止仍在跑的套件执行；未开始的流程会被记为 skipped */
router.post('/:id/stop', (req, res) => {
  const run = store.getSuiteRun(req.params.id)
  if (!run) return res.status(404).json({ error: '套件执行不存在', code: 'SUITE_RUN_NOT_FOUND' })
  const ok = stopSuiteRun(run.id)
  if (!ok) {
    return res.status(409).json({ error: '该执行已结束或不在当前进程中', code: 'SUITE_RUN_NOT_ACTIVE' })
  }
  res.json({ ok: true })
})

export default router
