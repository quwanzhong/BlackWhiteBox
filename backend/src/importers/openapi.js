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
 * @returns {{ name: string, type: 'blackbox', description: string, variables: object, nodes: any[], edges: any[] }}
 */
export function parseOpenApi(spec, name) {
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

  const nodes = entries.map(({ path, method, op }, i) => ({
    id: `n${i + 1}`,
    name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
    action: {
      type: 'http',
      method: method.toUpperCase(),
      url: base ? `${base.replace(/\/$/, '')}${path}` : `{{baseUrl}}${path}`,
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
  }))

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
    variables: base ? { baseUrl: base } : {},
    nodes,
    edges,
  }
}
