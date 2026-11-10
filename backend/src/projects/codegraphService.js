/**
 * 项目级调用图服务（M3'-2 · W1）。
 *
 * 职责边界：
 * - `projects/service.js` 管项目文档本身（接口快照 / 扫描结果），不掺图数据；
 * - 本模块负责「构建 / 查询 / 失效判定」，全量图落 `data/codegraph/<id>.json`，
 *   库里只留摘要（`project.codegraph`），避免项目详情接口被几 MB 图拖慢。
 *
 * 诚实性约定（docs/05 §2.2）：
 * - 图缺失或签名与当前扫描不一致 → `stale`，接口层必须显式返回状态，
 *   不能把「还没分析」渲染成「0 条调用链」。
 */
import { store } from '../store.js'
import {
  buildFromProject,
  callersOf,
  chainsForCallSite,
  chainsForEndpoint,
  filesForEndpoint,
  graphSignature,
  loadGraph,
  removeGraph,
  saveGraph,
} from '../codegraph/index.js'

function requireProject(id) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  return project
}

/** 当前扫描/接口快照对应的签名（不构建图，用于判断摘要是否过期） */
export function currentSignature(project) {
  return graphSignature({ scan: project.scan, interfaces: project.interfaces })
}

/**
 * 构建（或重建）调用图。
 * 复用 `project.scan.calls`：CallSite 的匹配口径与流程生成完全一致，
 * 两套扫描会让「画布上的接口」和「链路里的接口」指向不同快照。
 */
export function buildProjectGraph(id, input = {}) {
  const project = requireProject(id)
  if (!project.codePath) throw new Error('请先填写前端工程目录并执行扫描')
  if (!project.scan?.calls?.length) throw new Error('该项目还没有调用点，请先执行代码扫描')

  const { graph, summary } = buildFromProject(project, input)
  const saved = saveGraph(id, graph)
  project.codegraph = { ...summary, bytes: saved.bytes }
  store.saveProject(project)
  return { ...project.codegraph, stale: false }
}

/**
 * 图的可用状态：`available / stale / missing`。
 * stale 时前端仍显示上一次的统计，但必须打上「需重建」标记。
 */
export function graphStatus(id) {
  const project = requireProject(id)
  const summary = project.codegraph || null
  if (!summary) {
    return {
      state: project.scan?.calls?.length ? 'stale' : 'missing',
      reason: project.scan?.calls?.length ? 'not-built' : 'no-scan',
      summary: null,
      hasCalls: Boolean(project.scan?.calls?.length),
      signature: currentSignature(project),
    }
  }
  const signature = currentSignature(project)
  const stale = summary.signature !== signature
  return {
    state: stale ? 'stale' : 'fresh',
    reason: stale ? 'scan-changed' : '',
    summary,
    hasCalls: Boolean(project.scan?.calls?.length),
    signature,
  }
}

/** 读图；缺失时返回 null（由调用方决定如何表达「没有证据」） */
function graphOrNull(id) {
  if (graphStatus(id).state === 'missing') return null
  return loadGraph(id)
}

/**
 * 链路查询：按接口或按调用点，二者都空时返回摘要 + 端点列表。
 * `state` 字段让前端能区分「无调用链」与「尚未分析」。
 */
export function queryChains(id, input = {}) {
  const status = graphStatus(id)
  const base = {
    projectId: id,
    state: status.state,
    reason: status.reason,
    summary: status.summary,
    stale: status.state === 'stale',
  }
  const graph = graphOrNull(id)
  if (!graph) return { ...base, chains: [], notice: '调用链尚未生成，请先构建代码图' }

  const limit = Math.max(1, Math.min(Number(input.limit) || 20, 100))
  if (input.callId) {
    return { ...base, callId: input.callId, chains: chainsForCallSite(graph, input.callId, { limit }) }
  }
  if (input.interfaceId) {
    return {
      ...base,
      interfaceId: input.interfaceId,
      endpoint: (graph.endpoints || []).find((e) => e.interfaceId === input.interfaceId) || null,
      chains: chainsForEndpoint(graph, input.interfaceId, { limit }),
      files: filesForEndpoint(graph, input.interfaceId),
    }
  }
  return { ...base, endpoints: graph.endpoints || [], orphanInterfaces: graph.orphanInterfaces || [] }
}

/** 某个函数的调用方（W3 / 功能分析下钻） */
export function queryCallers(id, fnId, limit = 50) {
  const graph = graphOrNull(id)
  if (!graph) return { state: 'missing', callers: [] }
  return { state: graphStatus(id).state, callers: callersOf(graph, fnId, limit) }
}

/** 断链清单：交人工关联的调用点（绝不显示成「无调用方」） */
export function listGaps(id, input = {}) {
  const status = graphStatus(id)
  const graph = graphOrNull(id)
  if (!graph) {
    return { state: status.state, reason: status.reason, noEntryCalls: [], unresolved: [], unresolvedImports: [], parseErrors: [] }
  }
  const limit = Math.max(1, Math.min(Number(input.limit) || 200, 2000))
  return {
    state: status.state,
    truncated: Boolean(graph.truncated),
    truncatedReasons: graph.truncatedReasons || [],
    noEntryCalls: (graph.noEntryCalls || []).slice(0, limit),
    unresolved: (graph.unresolved || []).slice(0, limit),
    unresolvedImports: (graph.unresolvedImports || []).slice(0, limit),
    parseErrors: (graph.parseErrors || []).slice(0, limit),
    skippedFiles: (graph.skippedFiles || []).slice(0, limit),
  }
}

/** 原始图（导出 / 调试用），带状态标记 */
export function readGraph(id) {
  const status = graphStatus(id)
  const graph = graphOrNull(id)
  return { state: status.state, reason: status.reason, graph }
}

export { removeGraph }
