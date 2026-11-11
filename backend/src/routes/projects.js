import { Router } from 'express'
import { store } from '../store.js'
import {
  availableInterfaces,
  bindInterfaces,
  checkCodePath,
  createProject,
  deleteProject,
  generateProjectFlows,
  getProject,
  listProjects,
  mapCall,
  pullProjectInterfaces,
  scanProject,
  summarize,
  updateProject,
} from '../projects/service.js'
import {
  buildProjectGraph,
  graphStatus,
  listGaps,
  queryChains,
  readSource,
} from '../projects/codegraphService.js'

const router = Router()

function fail(res, err) {
  const message = err?.message || '项目操作失败'
  const userFixable = /请先|请填写|不存在|不在|没有|无法|至少|目录|不支持/.test(message)
  res.status(Number(err?.status) || (userFixable ? 400 : 500)).json({ error: message })
}

function projectFlows(id) {
  return store
    .listFlows()
    .filter((f) => f.projectId === id)
    .map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      business: f.business || '',
      nodeCount: f.nodes?.length || 0,
      updatedAt: f.updatedAt,
    }))
}

// 项目列表
router.get('/', (_req, res) => {
  const flows = store.listFlows()
  const bugs = store.listBugs()
  res.json(
    listProjects().map((p) => ({
      ...p,
      flowCount: flows.filter((f) => f.projectId === p.id).length,
      openBugs: bugs.filter((b) => b.projectId === p.id && !['closed', 'verified', 'rejected'].includes(b.status)).length,
    }))
  )
})

// 新建项目
router.post('/', (req, res) => {
  try {
    const project = createProject(req.body || {})
    res.json(project)
  } catch (err) {
    fail(res, err)
  }
})

// 项目详情
router.get('/:id', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: '项目不存在' })
  res.json({ ...project, flows: projectFlows(project.id) })
})

// 更新项目
router.put('/:id', (req, res) => {
  try {
    const project = updateProject(req.params.id, req.body || {})
    res.json({ ...project, flows: projectFlows(project.id) })
  } catch (err) {
    fail(res, err)
  }
})

// 删除项目（保留已生成的流程与缺陷记录）
router.delete('/:id', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: '项目不存在' })
  deleteProject(req.params.id)
  res.json({ ok: true })
})

// 校验代码目录
router.post('/:id/check-path', (req, res) => {
  res.json(checkCodePath(req.body?.codePath || getProject(req.params.id)?.codePath))
})

// 当前可用接口（优先本机 Apifox 缓存）
router.get('/:id/available', (req, res) => {
  try {
    const data = availableInterfaces(req.params.id)
    if (!data) return res.status(404).json({ error: '暂无可用接口，请先拉取 Apifox 接口列表' })
    res.json(data)
  } catch (err) {
    fail(res, err)
  }
})

// 拉取接口（可按项目覆盖项目 ID / 令牌）
router.post('/:id/pull', async (req, res) => {
  try {
    const data = await pullProjectInterfaces(req.params.id, req.body || {})
    res.json(data)
  } catch (err) {
    fail(res, err)
  }
})

// 保存项目需要的接口
router.put('/:id/interfaces', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    const project = await bindInterfaces(req.params.id, ids)
    res.json({ ...project, summary: summarize(project) })
  } catch (err) {
    fail(res, err)
  }
})

// 扫描前端工程源码
router.post('/:id/scan', (req, res) => {
  try {
    const project = scanProject(req.params.id, req.body || {})
    res.json({ ...project, summary: summarize(project) })
  } catch (err) {
    fail(res, err)
  }
})

// 手动关联调用点 ↔ 接口
router.post('/:id/mapping', (req, res) => {
  try {
    const project = mapCall(req.params.id, req.body || {})
    res.json({ ...project, summary: summarize(project) })
  } catch (err) {
    fail(res, err)
  }
})

// 按业务功能生成流程
router.post('/:id/flows', (req, res) => {
  try {
    const flows = generateProjectFlows(req.params.id, req.body || {})
    res.json({ flows, projectFlows: projectFlows(req.params.id) })
  } catch (err) {
    fail(res, err)
  }
})

// 项目下的流程
router.get('/:id/flows', (req, res) => {
  res.json(projectFlows(req.params.id))
})

// ---------------------------------------------------------------------------
// 调用图 / W1 调用链（M3'-2）
// ---------------------------------------------------------------------------

// 构建（或重建）调用链图：静态分析整个前端工程，不执行代码
router.post('/:id/codegraph', (req, res) => {
  try {
    res.json(buildProjectGraph(req.params.id, req.body || {}))
  } catch (err) {
    fail(res, err)
  }
})

// 图状态：fresh / stale / missing —— 前端据此区分「无调用方」与「还没分析」
router.get('/:id/codegraph', (req, res) => {
  try {
    res.json(graphStatus(req.params.id))
  } catch (err) {
    fail(res, err)
  }
})

// 链路查询：?interfaceId= 按接口反查入口，?callId= 按调用点下钻
router.get('/:id/codegraph/chains', (req, res) => {
  try {
    res.json(queryChains(req.params.id, req.query || {}))
  } catch (err) {
    fail(res, err)
  }
})

// 断链与解析问题清单（人工关联入口）
router.get('/:id/codegraph/gaps', (req, res) => {
  try {
    res.json(listGaps(req.params.id, req.query || {}))
  } catch (err) {
    fail(res, err)
  }
})

// 源码定位：只允许读图内文件，返回目标行附近的行窗口（W1-3 点击跳转）
router.get('/:id/codegraph/source', (req, res) => {
  try {
    res.json(readSource(req.params.id, req.query || {}))
  } catch (err) {
    fail(res, err)
  }
})

export default router
