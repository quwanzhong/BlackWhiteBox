import { Router } from 'express'
import crypto from 'node:crypto'
import { store } from '../store.js'
import { parseOpenApi } from '../importers/openapi.js'

const router = Router()

/** S6：导入上限，避免一次导入把内存/画布打爆 */
const MAX_OPENAPI_PATHS = 5000
const MAX_WHITEBOX_FLOWS = 100
const MAX_WHITEBOX_NODES = 2000

// 解析 OpenAPI（Apifox 导出）→ 黑盒流程草稿（不直接保存，前端预览确认后再保存）
router.post('/openapi', (req, res) => {
  const spec = req.body?.spec
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return res.status(400).json({ error: '请提供 OpenAPI JSON（spec 字段）', code: 'IMPORT_BAD_SPEC' })
  }
  if (!spec.paths || typeof spec.paths !== 'object' || Array.isArray(spec.paths)) {
    return res.status(400).json({
      error: 'OpenAPI 数据缺少 paths 字段，请确认导出格式是否为 OpenAPI/Swagger JSON',
      code: 'IMPORT_BAD_SPEC',
    })
  }
  const pathCount = Object.keys(spec.paths).length
  if (pathCount > MAX_OPENAPI_PATHS) {
    return res.status(413).json({
      error: `paths 数量 ${pathCount} 超过上限 ${MAX_OPENAPI_PATHS}，请先在 Apifox 里分批导出`,
      code: 'IMPORT_TOO_MANY_PATHS',
    })
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 200) : undefined
  const flow = parseOpenApi(spec, name)
  res.json({ flow })
})

// 白盒分析结果导入（java-analyzer 输出的调用链 JSON）
router.post('/whitebox', (req, res) => {
  const body = req.body || {}
  const list = Array.isArray(body) ? body : Array.isArray(body.flows) ? body.flows : [body]
  if (list.length > MAX_WHITEBOX_FLOWS) {
    return res.status(413).json({
      error: `一次最多导入 ${MAX_WHITEBOX_FLOWS} 条调用链`,
      code: 'IMPORT_TOO_MANY_FLOWS',
    })
  }
  for (const raw of list) {
    if (raw && Array.isArray(raw.nodes) && raw.nodes.length > MAX_WHITEBOX_NODES) {
      return res.status(413).json({
        error: `单条调用链节点数 ${raw.nodes.length} 超过上限 ${MAX_WHITEBOX_NODES}`,
        code: 'IMPORT_TOO_MANY_NODES',
      })
    }
  }
  const saved = list.map((raw) => toWhiteboxFlow(raw)).filter(Boolean).map((f) => store.saveFlow(f))
  if (!saved.length) {
    return res.status(400).json({ error: '未识别到白盒调用链数据（需要 nodes / edges 字段）', code: 'IMPORT_BAD_SPEC' })
  }
  res.json({ flows: saved })
})

function toWhiteboxFlow(raw = {}) {
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) return null
  const depthCounter = {}
  const nodes = raw.nodes.map((n, i) => {
    const depth = Number.isFinite(n.depth) ? n.depth : 0
    const idxInDepth = (depthCounter[depth] = (depthCounter[depth] ?? -1) + 1)
    return {
      id: n.id || `m${i + 1}`,
      name: n.name || `${n.class || ''}#${n.method || 'method'}`,
      kind: n.kind || 'method',
      action: {
        type: 'manual',
        hint:
          n.hint ||
          `请在代码中检查 ${n.class || ''}#${n.method || ''} 的实现${
            n.file ? `（${n.file}${n.line ? ':' + n.line : ''}）` : ''
          }`,
      },
      input: { file: n.file || '', line: n.line || null, signature: n.signature || '' },
      expected: { manualNote: '人工确认代码逻辑符合预期' },
      extract: {},
      position: { x: 80 + depth * 300, y: 90 + idxInDepth * 110 },
    }
  })

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((e) => e && nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to)
    .map((e) => ({
      id: `e_${e.from}_${e.to}`,
      from: e.from,
      to: e.to,
      condition: e.condition || '',
    }))

  return {
    id: crypto.randomUUID(),
    name: raw.name || `${raw.entry || '白盒'} 调用链`,
    type: 'whitebox',
    description: `白盒分析导入：入口 ${raw.entry || '未指定'}，共 ${nodes.length} 个方法节点`,
    variables: {},
    nodes,
    edges,
  }
}

export default router
