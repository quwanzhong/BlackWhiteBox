import { Router } from 'express'
import {
  EnvironmentError,
  createEnvironment,
  deleteEnvironment,
  deleteSecret,
  getEnvironment,
  listEnvironments,
  previewEnvironment,
  setSecret,
  updateEnvironment,
} from '../environments/service.js'

const router = Router()

function fail(res, err) {
  if (err instanceof EnvironmentError) {
    return res.status(err.status).json({ error: err.message, code: err.code })
  }
  const message = err?.message || '环境操作失败'
  res.status(500).json({ error: message, code: 'INTERNAL' })
}

// 环境列表（可选 ?projectId= 过滤）
router.get('/', (req, res) => {
  res.json(listEnvironments(req.query.projectId))
})

// 新建环境
router.post('/', (req, res) => {
  try {
    res.json(createEnvironment(req.body || {}))
  } catch (err) {
    fail(res, err)
  }
})

// 环境详情（只含 secretKeys，不含明文）
router.get('/:id', (req, res) => {
  const env = getEnvironment(req.params.id)
  if (!env) return res.status(404).json({ error: '环境不存在', code: 'ENV_NOT_FOUND' })
  res.json(env)
})

// 预览：合并后的变量 / Header，secrets 打码
router.get('/:id/resolve', (req, res) => {
  try {
    res.json(previewEnvironment(req.params.id))
  } catch (err) {
    fail(res, err)
  }
})

// 更新环境（整体替换提供的字段；version +1）
router.put('/:id', (req, res) => {
  try {
    res.json(updateEnvironment(req.params.id, req.body || {}))
  } catch (err) {
    fail(res, err)
  }
})

// 删除环境（连同密钥行）
router.delete('/:id', (req, res) => {
  try {
    deleteEnvironment(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

// 设置 / 覆盖密钥（值只在请求体里出现一次，不落日志、不回显）
router.put('/:id/secrets/:key', (req, res) => {
  try {
    res.json(setSecret(req.params.id, req.params.key, req.body?.value))
  } catch (err) {
    fail(res, err)
  }
})

// 删除密钥
router.delete('/:id/secrets/:key', (req, res) => {
  try {
    res.json(deleteSecret(req.params.id, req.params.key))
  } catch (err) {
    fail(res, err)
  }
})

export default router
