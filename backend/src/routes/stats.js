import { Router } from 'express'
import { store } from '../store.js'

const router = Router()

router.get('/', (_req, res) => {
  const flows = store.listFlows()
  const execs = store.listExecutions()
  const finished = execs.filter((e) => ['passed', 'failed', 'stopped'].includes(e.status))
  const success = finished.filter((e) => e.status === 'passed').length

  res.json({
    flowTotal: flows.length,
    blackboxCount: flows.filter((f) => f.type === 'blackbox').length,
    whiteboxCount: flows.filter((f) => f.type === 'whitebox').length,
    projectCount: store.listProjects().length,
    bugTotal: store.listBugs().length,
    openBugCount: store.listBugs().filter((b) => !['closed', 'verified', 'rejected'].includes(b.status)).length,
    execTotal: execs.length,
    runningCount: execs.filter((e) => ['running', 'paused'].includes(e.status)).length,
    successRate: finished.length ? Math.round((success / finished.length) * 100) : null,
    recent: execs.slice(0, 8),
  })
})

export default router
