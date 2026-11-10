/**
 * OpenAPI 文档 → 接口投影（纯函数，零 IO）
 *
 * 从 apifox/service.js 抽出：Apifox 的文档本体就是 OpenAPI（MCP 拉回后内联 $ref），
 * 所以「文档 → 接口列表 / 快照」这段逻辑属于 OpenAPI 形态，而不是 Apifox 传输层。
 * 抽出的收益：openapi 适配器直接复用同一份投影，行为不可能与 Apifox 漂移。
 */
import { sampleBody } from '../../importers/openapi.js'

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

export function countInterfaces(spec) {
  let count = 0
  for (const item of Object.values(spec?.paths || {})) {
    if (!isPlainObject(item)) continue
    for (const method of METHODS) if (item[method]) count++
  }
  return count
}

/** 列表页投影：只保留勾选需要的字段，1737 条也能一次返回 */
export function extractInterfaces(spec) {
  const list = []
  for (const [apiPath, item] of Object.entries(spec?.paths || {})) {
    if (!isPlainObject(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (!isPlainObject(op)) continue
      list.push({
        id: `${method.toUpperCase()} ${apiPath}`,
        method: method.toUpperCase(),
        path: apiPath,
        name: op.summary || op.operationId || `${method.toUpperCase()} ${apiPath}`,
        operationId: op.operationId || '',
        folder: op['x-apifox-folder'] || item['x-apifox-folder'] || '',
        status: op['x-apifox-status'] || item['x-apifox-status'] || '',
        tags: Array.isArray(op.tags) ? op.tags : [],
        deprecated: Boolean(op.deprecated),
      })
    }
  }
  return list
}

function paramMeta(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && p.name)
    .map((p) => ({
      name: p.name,
      in: p.in,
      required: Boolean(p.required),
      type: p.schema?.type || '',
      example: p.example ?? p.schema?.example ?? p.schema?.default ?? '',
      description: p.description || '',
    }))
}

/**
 * 把选中的接口展开成「可脱离文档缓存使用」的完整元数据。
 * 项目绑定接口时存一份快照，后续扫描与生成流程都不再依赖来源缓存。
 */
export function describeInterfaces(spec, ids) {
  const wanted = new Set(ids)
  const serverUrl = spec?.servers?.[0]?.url || ''
  const result = []
  for (const [apiPath, item] of Object.entries(spec?.paths || {})) {
    if (!isPlainObject(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (!isPlainObject(op)) continue
      const id = `${method.toUpperCase()} ${apiPath}`
      if (!wanted.has(id)) continue
      const params = paramMeta([...(item.parameters || []), ...(op.parameters || [])])
      result.push({
        id,
        method: method.toUpperCase(),
        path: apiPath,
        name: op.summary || op.operationId || id,
        operationId: op.operationId || '',
        folder: op['x-apifox-folder'] || item['x-apifox-folder'] || '',
        status: op['x-apifox-status'] || item['x-apifox-status'] || '',
        tags: Array.isArray(op.tags) ? op.tags : [],
        deprecated: Boolean(op.deprecated),
        summary: op.summary || '',
        serverUrl,
        pathParams: params.filter((p) => p.in === 'path'),
        queryParams: params.filter((p) => p.in === 'query'),
        bodySample: sampleBody(op),
      })
    }
  }
  return result
}

export function filterSpec(spec, ids) {
  const selected = new Set(ids)
  const paths = {}
  for (const [apiPath, item] of Object.entries(spec?.paths || {})) {
    if (!isPlainObject(item)) continue
    for (const method of METHODS) {
      if (!item[method]) continue
      if (!selected.has(`${method.toUpperCase()} ${apiPath}`)) continue
      if (!paths[apiPath]) paths[apiPath] = {}
      paths[apiPath][method] = item[method]
    }
  }
  return { ...spec, paths }
}
