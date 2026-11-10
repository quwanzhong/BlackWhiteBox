import { Router } from 'express'
import { store } from '../store.js'
import {
  SuiteError,
  createSuite,
  deleteSuite,
  getSuiteDetail,
  listSuites,
  publicSuite,
  updateSuite,
} from '../suites/service.js'
import { startSuiteRun } from '../suites/runner.js'

const router = Router()

function fail(res, err) {
  if (err instanceof SuiteError) {
    return res.status(err.status).json({ error: err.message, code: err.code })
  }
  throw err
}

/** 列表：附带最近一次执行，前端不用为每一行再发一次请求 */
router.get('/', (req, res) => {
  const projectId = req.query.projectId ? String(req.query.projectId) : ''
  const list = listSuites(projectId)
  const latest = new Map()
  for (const run of store.listSuiteRuns({ limit: 200 })) {
    if (!latest.has(run.suiteId)) latest.set(run.suiteId, run)
  }
  res.json(
    list.map((suite) => ({
      ...publicSuite(suite),
      lastRun: latest.get(suite.id) || null,
    }))
  )
})

router.post('/', (req, res) => {
  try {
    res.json(createSuite(req.body || {}))
  } catch (err) {
    fail(res, err)
  }
})

router.get('/:id', (req, res) => {
  const detail = getSuiteDetail(req.params.id)
  if (!detail) return res.status(404).json({ error: '套件不存在', code: 'SUITE_NOT_FOUND' })
  res.json(detail)
})

router.put('/:id', (req, res) => {
  try {
    res.json(updateSuite(req.params.id, req.body || {}))
  } catch (err) {
    fail(res, err)
  }
})

router.delete('/:id', (req, res) => {
  try {
    deleteSuite(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/** 执行套件：立即返回 suiteRunId，进度走 WS（suite:<id>）或 GET /api/suite-runs/:id */
router.post('/:id/run', (req, res) => {
  try {
    const run = startSuiteRun({
      suiteId: req.params.id,
      io: req.io,
      variables: req.body?.variables,
      environmentId: req.body?.environmentId,
    })
    res.json({ suiteRunId: run.id, suiteRun: run })
  } catch (err) {
    fail(res, err)
  }
})

router.get('/:id/runs', (req, res) => {
  if (!store.getSuite(req.params.id)) {
    return res.status(404).json({ error: '套件不存在', code: 'SUITE_NOT_FOUND' })
  }
  res.json(store.listSuiteRuns({ suiteId: req.params.id, limit: req.query.limit || 20 }))
})

export default router
