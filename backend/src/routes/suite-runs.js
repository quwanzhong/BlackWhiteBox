import { Router } from 'express'
import { store } from '../store.js'
import { stopSuiteRun } from '../suites/runner.js'

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
