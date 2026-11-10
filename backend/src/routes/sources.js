/**
 * 接口来源 API（M3'-1）
 *
 *   GET  /api/sources                → 已注册来源的能力声明（前端表单据此渲染）
 *   GET  /api/sources/:kind          → 单个来源的 describe()
 *   POST /api/sources/:kind/fetch    → 拉取接口列表 { interfaces, meta, ...兼容字段 }
 *   POST /api/sources/:kind/test     → 连通性/文档结构自检
 *
 * 约定：这是「通用入口」，项目主流程仍走 /api/projects/:id/*；
 * 新增来源只注册适配器，本文件与项目路由都不需要改（SRC-2）。
 */
import { Router } from 'express'
import { SourceError } from '../sources/contract.js'
import { createSource, listSources } from '../sources/registry.js'

const router = Router()

function fail(res, err) {
  const message = err?.message || '接口来源操作失败'
  if (err instanceof SourceError) {
    // 来源自身不可用（远端挂了 / 认证失败）与「用户填错」必须区分，否则前端无法给出可操作提示
    const upstream = err.code === 'SOURCE_UPSTREAM' || err.code === 'SOURCE_AUTH'
    return res.status(upstream ? 502 : 400).json({ error: message, code: err.code, details: err.details })
  }
  // 适配器内部抛出的网络/令牌/解析错误：按「来源不可用」处理，不回退成空成功
  res.status(502).json({ error: message, code: 'SOURCE_UPSTREAM' })
}

function configFrom(body) {
  const input = body && typeof body === 'object' ? body : {}
  const config = input.config && typeof input.config === 'object' ? { ...input.config } : { ...input }
  delete config.config
  if (input.refresh !== undefined) config.refresh = input.refresh
  return config
}

router.get('/', (_req, res) => {
  res.json({ sources: listSources() })
})

router.get('/:kind', (req, res) => {
  try {
    res.json(createSource(req.params.kind).describe())
  } catch (err) {
    fail(res, err)
  }
})

router.post('/:kind/fetch', async (req, res) => {
  try {
    const source = createSource(req.params.kind)
    const config = configFrom(req.body)
    const result = await source.fetch(config, { refresh: req.body?.refresh })
    res.json(result)
  } catch (err) {
    fail(res, err)
  }
})

router.post('/:kind/test', async (req, res) => {
  try {
    const source = createSource(req.params.kind)
    if (typeof source.test !== 'function') {
      return res.status(400).json({ error: `接口来源 ${req.params.kind} 不支持连接测试`, code: 'SOURCE_UNSUPPORTED' })
    }
    res.json(await source.test(configFrom(req.body)))
  } catch (err) {
    fail(res, err)
  }
})

export default router
