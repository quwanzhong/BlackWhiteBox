import { Router } from 'express'
import crypto from 'node:crypto'
import { store } from '../store.js'
import {
  buildFlow,
  clearRuntimeToken,
  fetchInterfaces,
  getCachedInterfaces,
  getConfigView,
  pullSpec,
  readCache,
  resolveConnection,
  saveConfig,
  testConnection,
} from '../apifox/service.js'

const router = Router()

function fail(res, err) {
  const message = err?.message || 'Apifox 操作失败'
  const userFixable = /请填写|请先填写|缺少|没有选中|没有解析到/.test(message)
  const status = userFixable ? 400 : 502
  res.status(status).json({ error: message })
}

// 连接配置（令牌不返回、不落盘）
router.get('/config', (_req, res) => {
  res.json(getConfigView())
})

router.post('/config', (req, res) => {
  res.json(saveConfig(req.body || {}))
})

router.delete('/token', (_req, res) => {
  res.json(clearRuntimeToken())
})

// 测试连接：握手 + 读取文档概要
router.post('/test', async (req, res) => {
  try {
    const connection = resolveConnection(req.body || {})
    const result = await testConnection(connection)
    if (connection.token) saveConfig({ ...req.body, token: connection.token })
    res.json(result)
  } catch (err) {
    fail(res, err)
  }
})

// 拉取接口列表（默认强制刷新 Apifox 最新文档）
router.post('/interfaces', async (req, res) => {
  try {
    const body = req.body || {}
    const connection = resolveConnection(body)
    const result = await fetchInterfaces(connection, { refresh: body.refresh !== false })
    if (connection.token) saveConfig({ ...body, token: connection.token })
    res.json(result)
  } catch (err) {
    fail(res, err)
  }
})

// 读取本机缓存的接口列表（刷新页面后可直接展示）
router.get('/interfaces', (_req, res) => {
  const cached = getCachedInterfaces()
  if (!cached) return res.status(404).json({ error: '本机暂无 Apifox 接口缓存，请先拉取' })
  res.json(cached)
})

// 选中接口 → 生成并保存黑盒流程
router.post('/import', async (req, res) => {
  try {
    const body = req.body || {}
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : []
    if (!ids.length) return res.status(400).json({ error: '请至少选择一个接口' })

    const connection = resolveConnection(body)
    let spec = null
    const cached = getCachedInterfaces()
    const cacheProjectMatches = cached && (!connection.projectId || cached.projectId === connection.projectId)
    if (body.refresh === true || !cacheProjectMatches) {
      spec = (await pullSpec(connection, { refresh: body.refresh === true })).spec
    } else {
      spec = readCache()?.spec || null
    }
    if (!spec) spec = (await pullSpec(connection, { refresh: false })).spec

    const draft = buildFlow(spec, ids, body.name || undefined, body.baseUrl || undefined)
    const flow = store.saveFlow({ ...draft, id: crypto.randomUUID() })
    res.json({ flows: [flow] })
  } catch (err) {
    fail(res, err)
  }
})

export default router
