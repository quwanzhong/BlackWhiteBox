/**
 * OpenAPI / Swagger 解析器：把接口定义转换成黑盒流程草稿。
 * 数据来源可以是 Apifox 导出的 OpenAPI JSON。
 */

function exampleFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (schema.example !== undefined) return schema.example
  if (schema.$ref) return {}
  switch (schema.type) {
    case 'object': {
      const out = {}
      for (const [k, v] of Object.entries(schema.properties || {})) {
        out[k] = exampleFromSchema(v)
      }
      return out
    }
    case 'array':
      return schema.items ? [exampleFromSchema(schema.items)] : []
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      return schema.enum ? schema.enum[0] : ''
    default:
      return {}
  }
}

function sampleBody(op) {
  const content = op.requestBody?.content
  if (!content) return null
  const json = content['application/json'] || content['*/*'] || Object.values(content)[0]
  return json?.schema ? exampleFromSchema(json.schema) : null
}

function paramSummary(op) {
  const params = (op.parameters || []).map((p) => `${p.in || 'query'}:${p.name}${p.required ? '(必填)' : ''}`)
  return params
}

/**
 * 解析文档内部的 #/ 引用（手工导入的 OpenAPI 也可能带 $ref）。
 * 循环引用保留 $ref，避免死循环。
 */
function resolveLocalRefs(node, root, stack = new Set()) {
  if (Array.isArray(node)) return node.map((item) => resolveLocalRefs(item, root, stack))
  if (!node || typeof node !== 'object') return node
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const ref = node.$ref
    if (!stack.has(ref)) {
      const parts = ref.replace(/^#\//, '').split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
      let target = root
      for (const part of parts) {
        if (target === null || typeof target !== 'object') { target = undefined; break }
        target = target[part]
      }
      if (target !== undefined) {
        const nextStack = new Set(stack).add(ref)
        const resolved = resolveLocalRefs(structuredClone(target), root, nextStack)
        const { $ref, ...rest } = node
        const siblings = resolveLocalRefs(rest, root, nextStack)
        if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
          return { ...resolved, ...siblings }
        }
        return resolved
      }
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(node)) out[key] = resolveLocalRefs(value, root, stack)
  return out
}

function normalizeVarName(name) {
  return String(name).replace(/[^\w]/g, '_')
}

function paramInfo(op) {
  const vars = {}
  const requiredQuery = []
  for (const p of op.parameters || []) {
    if (!p?.name) continue
    const name = normalizeVarName(p.name)
    const value = p.example ?? p.schema?.example ?? p.schema?.default ?? ''
    if (p.in === 'path') vars[name] = value
    else if (p.in === 'query' && p.required) {
      vars[name] = value
      requiredQuery.push(name)
    }
  }
  return { vars, requiredQuery }
}

function buildUrl(base, apiPath, requiredQuery) {
  const path = apiPath.replace(/\{([^}]+)\}/g, (_, name) => `{{${normalizeVarName(name)}}}`)
  let url = base ? `${base.replace(/\/$/, '')}${path}` : `{{baseUrl}}${path}`
  if (requiredQuery.length) {
    url += `?${requiredQuery.map((n) => `${n}={{${n}}}`).join('&')}`
  }
  return url
}

/**
 * @returns {{ name: string, type: 'blackbox', description: string, variables: object, nodes: any[], edges: any[] }}
 */
export function parseOpenApi(rawSpec, name) {
  const spec = resolveLocalRefs(rawSpec, rawSpec)
  const base = spec.servers?.[0]?.url || ''
  const entries = []
  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method]
      if (!op) continue
      entries.push({ path, method, op })
    }
  }

  const flowVars = base ? { baseUrl: base } : {}
  const nodes = entries.map(({ path, method, op }, i) => {
    const { vars, requiredQuery } = paramInfo(op)
    Object.assign(flowVars, vars)
    return {
      id: `n${i + 1}`,
      name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
      action: {
        type: 'http',
        method: method.toUpperCase(),
        url: buildUrl(base, path, requiredQuery),
        headers: { 'Content-Type': 'application/json' },
        body: method === 'get' || method === 'delete' ? null : sampleBody(op),
        timeout: 15000,
      },
      input: { params: paramSummary(op) },
      expected: {
        status: method === 'post' ? 201 : 200,
        checks: [],
      },
      extract: {},
      position: { x: 80 + i * 280, y: 160 },
    }
  })

  // 默认按文档顺序连成一条线，导入后可在画布上重新编排
  const edges = nodes.slice(1).map((n, i) => ({
    id: `e_${nodes[i].id}_${n.id}`,
    from: nodes[i].id,
    to: n.id,
    condition: '',
  }))

  return {
    name: name || spec.info?.title || 'OpenAPI 导入流程',
    type: 'blackbox',
    description: `从 OpenAPI 导入，共 ${nodes.length} 个接口节点${base ? `（baseUrl: ${base}）` : '（未配置 baseUrl）'}`,
    variables: flowVars,
    nodes,
    edges,
  }
}
