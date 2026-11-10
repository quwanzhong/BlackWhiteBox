/**
 * codegraph 对外入口（M3'-2 · W1 调用链还原）。
 */
import crypto from 'node:crypto'
import { buildCodeGraph } from './build.js'

export { buildCodeGraph, callSiteConfidence, classifyFile, weakest } from './build.js'
export { extractTemplateBindings, extractVueScripts, parseFile, pluginsFor } from './parse.js'
export { createResolver } from './resolve.js'
export { loadGraph, removeGraph, saveGraph } from './store.js'
export { nameOf, paramNames, walk } from './walker.js'

/** 图与扫描的一致性指纹：重新扫描后签名变化，UI 才能提示「调用链需重建」 */
export function graphSignature({ scan = null, interfaces = [] } = {}) {
  const parts = [
    scan?.root || '',
    scan?.scannedAt || 0,
    scan?.callCount || 0,
    (scan?.calls || []).map((c) => `${c.id}:${c.matchedInterfaceId || ''}:${c.matchSource || ''}`).join(','),
    interfaces.map((it) => it.id).join(','),
  ]
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
}

function indexNodes(graph) {
  const fns = new Map()
  for (const fn of graph?.nodes?.functions || []) fns.set(fn.id, fn)
  const files = new Map()
  for (const file of graph?.nodes?.files || []) files.set(file.id, file)
  const callSites = new Map()
  for (const call of graph?.nodes?.callSites || []) callSites.set(call.id, call)
  return { fns, files, callSites }
}

/** 链路节点展开成可直接渲染的 `文件:行 函数名` */
export function decorateChain(graph, chain, indexes = null) {
  const idx = indexes || indexNodes(graph)
  const nodes = (chain?.fnIds || []).map((id) => {
    const fn = idx.fns.get(id)
    return {
      id,
      name: fn?.name || id.split('#')[1]?.split('@')[0] || id,
      file: fn?.file || '',
      line: fn?.line || 0,
      params: fn?.params || [],
      async: Boolean(fn?.async),
      module: Boolean(fn?.module),
      synthetic: Boolean(fn?.synthetic),
      kind: idx.files.get(fn?.file)?.kind || 'other',
    }
  })
  const callSite = idx.callSites.get(chain?.callSiteId)
  return {
    ...chain,
    nodes,
    callSite: callSite
      ? { id: callSite.id, file: callSite.file, line: callSite.line, method: callSite.method, path: callSite.path, snippet: callSite.snippet }
      : null,
  }
}

/** 按接口取链路（W1-3：从接口反查所有触发它的页面/组件） */
export function chainsForEndpoint(graph, interfaceId, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100))
  if (!graph?.chains?.length) return []
  const idx = indexNodes(graph)
  return graph.chains.filter((c) => c.interfaceId === interfaceId).slice(0, limit).map((c) => decorateChain(graph, c, idx))
}

/** 按调用点取链路（画布节点/调用点列表下钻） */
export function chainsForCallSite(graph, callId, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100))
  if (!graph?.chains?.length) return []
  const idx = indexNodes(graph)
  return graph.chains.filter((c) => c.callSiteId === callId).slice(0, limit).map((c) => decorateChain(graph, c, idx))
}

/** 某个函数的调用方（W3/功能分析用；带文件行号，可跳转） */
export function callersOf(graph, fnId, limit = 50) {
  if (!graph?.edges?.calls?.length) return []
  const idx = indexNodes(graph)
  return graph.edges.calls
    .filter((e) => e.to === fnId)
    .slice(0, limit)
    .map((e) => {
      const fn = idx.fns.get(e.from)
      return { from: e.from, name: fn?.name || e.from, file: fn?.file || '', line: fn?.line || 0, confidence: e.confidence, via: e.via }
    })
}

/** 接口涉及的代码文件（AC-3.2.13 功能分析里「涉及代码」的来源） */
export function filesForEndpoint(graph, interfaceId) {
  const files = new Map()
  for (const chain of chainsForEndpoint(graph, interfaceId, { limit: 100 })) {
    for (const node of chain.nodes) {
      if (!node.file) continue
      if (!files.has(node.file)) files.set(node.file, { file: node.file, kind: node.kind, functions: [], hits: 0 })
      const entry = files.get(node.file)
      entry.hits += 1
      if (node.name && !node.module && !entry.functions.includes(node.name)) entry.functions.push(node.name)
    }
    if (chain.callSite?.file && !files.has(chain.callSite.file)) {
      files.set(chain.callSite.file, { file: chain.callSite.file, kind: 'api', functions: [], hits: 1 })
    }
  }
  return [...files.values()].sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file))
}

/** 摘要：只放小字段，供项目列表/详情页展示与「是否过期」判定 */
export function summarizeGraph(graph, signature) {
  if (!graph) return null
  return {
    generatedAt: graph.generatedAt,
    durationMs: graph.durationMs,
    root: graph.root,
    signature,
    truncated: Boolean(graph.truncated),
    truncatedReasons: graph.truncatedReasons || [],
    stats: graph.stats || {},
    entryCount: (graph.entries || []).length,
    endpointCount: (graph.endpoints || []).length,
    chainCount: (graph.chains || []).length,
    skippedFileCount: (graph.skippedFiles || []).length,
    parseErrorCount: (graph.parseErrors || []).length,
    limits: graph.options || {},
  }
}

/** 从工程目录 + scanner 调用点 + 接口快照一步构建 */
export function buildFromProject(project, input = {}) {
  const scan = project?.scan
  const calls = Array.isArray(input.calls) ? input.calls : scan?.calls || []
  const interfaces = Array.isArray(input.interfaces) ? input.interfaces : project?.interfaces || []
  const graph = buildCodeGraph(input.root || project?.codePath, {
    calls,
    interfaces,
    totalCalls: scan?.callCount || calls.length,
    options: {
      maxFiles: input.maxFiles,
      maxNodes: input.maxNodes,
      maxDepth: input.maxDepth,
      maxChainsPerEndpoint: input.maxChainsPerEndpoint,
    },
  })
  const signature = graphSignature({ scan, interfaces })
  return { graph, signature, summary: summarizeGraph(graph, signature) }
}
