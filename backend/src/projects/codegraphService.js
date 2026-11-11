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
import fs from 'node:fs'
import path from 'node:path'
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

const SOURCE_RADIUS = 12
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

function sourceError(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

/**
 * 源码定位（W1-3「点击跳到 文件:行」的服务端部分）。
 *
 * 安全边界：**只允许读本次图里的文件**（`graph.nodes.files` 白名单），
 * 再做一次真实路径校验，确保拼接后的路径仍落在工程目录内。
 * 不提供任意路径读取能力，避免把「看源码」变成文件系统浏览器。
 *
 * 返回行窗口而不是整个文件：几 MB 的 SFC 没必要一次塞给前端。
 */
export function readSource(id, input = {}) {
  const project = requireProject(id)
  const status = graphStatus(id)
  const file = String(input.file || '').replace(/\\/g, '/').replace(/^\.\//, '')
  const requestedLine = Math.floor(Number(input.line) || 1)
  const radius = Math.max(0, Math.min(Number(input.radius) || SOURCE_RADIUS, 80))
  const graph = graphOrNull(id)
  if (!graph) {
    return {
      state: status.state,
      reason: status.reason,
      file,
      line: requestedLine,
      lines: [],
      notice: '调用链尚未生成，无法定位源码',
    }
  }
  const known = new Set((graph.nodes?.files || []).map((f) => f.id))
  if (!file || !known.has(file)) throw sourceError('文件不在本次调用链图内，请重新扫描后再定位')

  const root = path.resolve(project.codePath || '')
  const abs = path.resolve(root, file)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw sourceError('文件路径越界')
  if (!fs.existsSync(abs)) throw sourceError('源文件已不存在，请重新扫描')
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw sourceError('目标不是文件')
  if (stat.size > MAX_SOURCE_BYTES) throw sourceError('源文件超过 2 MB，请直接在编辑器中打开')

  const all = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
  const totalLines = all.length
  const line = Math.max(1, Math.min(requestedLine, totalLines))
  const startLine = Math.max(1, line - radius)
  const endLine = Math.min(totalLines, line + radius)
  return {
    state: status.state,
    reason: status.reason,
    file,
    absolutePath: abs,
    line,
    startLine,
    endLine,
    totalLines,
    truncated: startLine > 1 || endLine < totalLines,
    lines: all.slice(startLine - 1, endLine).map((text, i) => ({ nr: startLine + i, text })),
  }
}

export { removeGraph }
