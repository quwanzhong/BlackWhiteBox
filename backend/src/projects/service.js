/**
 * 项目管理服务：
 *   项目 = 一个前端工程 + 它需要的 Apifox 接口集合 + 代码扫描/业务功能分析结果
 *
 * 全流程：
 *   绑定接口 → 扫描源码调用点 → 自动匹配接口 → 业务功能分组 → 一键生成黑盒流程
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { store } from '../store.js'
import {
  describeInterfaces,
  extractInterfaces,
  fetchInterfaces,
  getCachedInterfaces,
  loadConfig,
  readCache,
  resolveConnection,
} from '../apifox/service.js'
import { analyzeProject, buildGroups, matchCalls } from './scanner.js'

function clean(value) {
  return String(value ?? '').trim()
}

function emptyProject(input = {}) {
  return {
    id: input.id || crypto.randomUUID(),
    name: clean(input.name) || '未命名项目',
    description: clean(input.description),
    codePath: clean(input.codePath),
    serviceBaseUrl: clean(input.serviceBaseUrl).replace(/\/$/, ''),
    apifox: {
      projectId: clean(input.apifox?.projectId),
      siteId: clean(input.apifox?.siteId),
      branchId: clean(input.apifox?.branchId),
      apiBaseUrl: clean(input.apifox?.apiBaseUrl),
    },
    interfaceIds: [],
    interfaces: [],
    scan: null,
  }
}

function normalizeProject(input, existing) {
  const base = existing ? structuredClone(existing) : emptyProject()
  if (input.name !== undefined) base.name = clean(input.name) || base.name
  if (input.description !== undefined) base.description = clean(input.description)
  if (input.codePath !== undefined) base.codePath = clean(input.codePath)
  if (input.serviceBaseUrl !== undefined) base.serviceBaseUrl = clean(input.serviceBaseUrl).replace(/\/$/, '')
  if (input.apifox) {
    base.apifox = {
      projectId: clean(input.apifox.projectId ?? base.apifox?.projectId),
      siteId: clean(input.apifox.siteId ?? base.apifox?.siteId),
      branchId: clean(input.apifox.branchId ?? base.apifox?.branchId),
      apiBaseUrl: clean(input.apifox.apiBaseUrl ?? base.apifox?.apiBaseUrl),
    }
  }
  return base
}

/** 列表页用的轻量摘要 */
export function summarize(project) {
  const scan = project.scan || null
  const folders = [...new Set((project.interfaces || []).map((it) => it.folder).filter(Boolean))]
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    codePath: project.codePath,
    serviceBaseUrl: project.serviceBaseUrl,
    apifoxProjectId: project.apifox?.projectId || '',
    interfaceCount: project.interfaceIds?.length || 0,
    folders,
    scan: scan
      ? {
          scannedAt: scan.scannedAt,
          scannedFiles: scan.scannedFiles,
          callCount: scan.callCount,
          matchedCalls: scan.matchedCalls,
          matchRate: scan.matchRate,
          matchedInterfaces: scan.matchedInterfaces,
          groupCount: scan.groups?.length || 0,
        }
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export function listProjects() {
  return store.listProjects().map(summarize)
}

export function getProject(id) {
  return store.getProject(id)
}

export function createProject(input) {
  const project = normalizeProject(input)
  return store.saveProject(project)
}

export function updateProject(id, input) {
  const existing = store.getProject(id)
  if (!existing) throw new Error('项目不存在')
  return store.saveProject(normalizeProject(input, existing))
}

export function deleteProject(id) {
  store.deleteProject(id)
}

// ---------------------------------------------------------------------------
// Apifox 接口绑定
// ---------------------------------------------------------------------------

/** 合并「项目配置 → 全局配置 → 请求参数」得到连接参数 */
function connectionFor(project, input = {}) {
  const cfg = loadConfig()
  return resolveConnection({
    projectId: input.projectId || project.apifox?.projectId || undefined,
    siteId: input.siteId || project.apifox?.siteId || undefined,
    branchId: input.branchId || project.apifox?.branchId || undefined,
    baseUrl: input.apiBaseUrl || project.apifox?.apiBaseUrl || undefined,
    token: input.token || undefined,
  })
}

/**
 * 拉取项目可用接口。
 * 同一份 Apifox 文档可被多个项目复用：未配置项目 ID / 未刷新时优先使用本机缓存。
 */
export async function pullProjectInterfaces(id, input = {}) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  const connection = connectionFor(project, input)

  if (!connection.projectId && !connection.siteId) {
    const cached = getCachedInterfaces()
    if (cached) return { ...cached, fromCache: true }
    throw new Error('请先在「数据导入」页连接 Apifox，或在项目里填写项目 ID 与访问令牌')
  }

  if (!connection.token) {
    const cached = readCache()
    const sameProject = cached && (!connection.projectId || cached.projectId === connection.projectId)
    if (sameProject && input.refresh !== true) {
      return { ...getCachedInterfaces(), fromCache: true }
    }
  }

  const result = await fetchInterfaces(connection, { refresh: input.refresh !== false })
  // 只记录连接标识，不保存令牌
  project.apifox = {
    projectId: connection.projectId || project.apifox?.projectId || '',
    siteId: connection.siteId || project.apifox?.siteId || '',
    branchId: connection.branchId || project.apifox?.branchId || '',
    apiBaseUrl: connection.baseUrl || project.apifox?.apiBaseUrl || '',
  }
  store.saveProject(project)
  return { ...result, fromCache: false }
}

/** 读取当前可用接口：优先本机缓存（项目 ID 一致时），其次项目已绑定快照 */
export function availableInterfaces(id) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  const cached = getCachedInterfaces()
  const sameDoc = !project.apifox?.projectId || !cached?.projectId || cached.projectId === project.apifox.projectId
  if (cached && sameDoc) return { ...cached, source: 'cache' }
  if (project.interfaces?.length) {
    return {
      title: project.name,
      version: '',
      baseUrl: project.interfaces[0]?.serverUrl || '',
      fetchedAt: project.updatedAt,
      interfaces: project.interfaces,
      source: 'project',
    }
  }
  return null
}

function recalcScan(scan, interfaces) {
  if (!scan?.calls) return scan
  const calls = scan.calls
  const groups = buildGroups(calls, interfaces)
  const matchedCalls = calls.filter((c) => c.matched).length
  const matchedInterfaceIds = [...new Set(calls.filter((c) => c.matched).map((c) => c.matchedInterfaceId))]
  return {
    ...scan,
    groups,
    matchedCalls,
    unmatchedCalls: calls.length - matchedCalls,
    matchRate: calls.length ? Math.round((matchedCalls / calls.length) * 100) : 0,
    matchedInterfaces: matchedInterfaceIds.length,
  }
}

/** 保存项目需要的接口（记录 ID + 完整元数据快照） */
export function bindInterfaces(id, ids = []) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  const uniqueIds = [...new Set((ids || []).map(clean).filter(Boolean))]
  const known = new Map((project.interfaces || []).map((it) => [it.id, it]))
  const cache = readCache()

  let described = []
  if (cache?.spec && uniqueIds.length) described = describeInterfaces(cache.spec, uniqueIds)
  const describedMap = new Map(described.map((it) => [it.id, it]))

  const interfaces = []
  const missing = []
  for (const iid of uniqueIds) {
    const meta = describedMap.get(iid) || known.get(iid)
    if (meta) interfaces.push(meta)
    else missing.push(iid)
  }
  if (missing.length) {
    throw new Error(`以下接口不在当前 Apifox 缓存中，请先重新拉取接口：${missing.slice(0, 5).join('、')}`)
  }

  project.interfaceIds = interfaces.map((it) => it.id)
  project.interfaces = interfaces
  if (project.scan) project.scan = recalcScan(project.scan, interfaces)
  return store.saveProject(project)
}

// ---------------------------------------------------------------------------
// 源码扫描 / 业务功能分组
// ---------------------------------------------------------------------------

export function scanProject(id, input = {}) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  if (!project.interfaces?.length) throw new Error('请先绑定该项目的 Apifox 接口')

  const root = clean(input.codePath) || project.codePath
  if (!root) throw new Error('请填写前端工程目录（绝对路径）')
  const maxFiles = Math.max(1, Math.min(Number(input.maxFiles) || 3000, 20000))

  const scan = analyzeProject(root, project.interfaces, {
    maxFiles,
    extensions: Array.isArray(input.extensions) ? input.extensions : undefined,
  })

  project.codePath = scan.root
  if (input.serviceBaseUrl !== undefined) {
    project.serviceBaseUrl = clean(input.serviceBaseUrl).replace(/\/$/, '')
  }
  if (!project.serviceBaseUrl) {
    project.serviceBaseUrl = clean(project.interfaces[0]?.serverUrl).replace(/\/$/, '')
  }
  project.scan = scan
  return store.saveProject(project)
}

/** 手动把某个调用点关联到接口（传空 interfaceId 表示取消关联） */
export function mapCall(id, input = {}) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  if (!project.scan?.calls) throw new Error('请先扫描代码')
  const call = project.scan.calls.find((c) => c.id === input.callId)
  if (!call) throw new Error('调用点不存在，请重新扫描')

  if (!input.interfaceId) {
    Object.assign(call, {
      matched: false,
      matchedInterfaceId: '',
      matchedInterfaceName: '',
      matchedFolder: '',
      score: 0,
      confidence: '',
      matchSource: 'manual',
    })
  } else {
    const meta = (project.interfaces || []).find((it) => it.id === input.interfaceId)
    if (!meta) throw new Error('接口不在项目已绑定列表中')
    Object.assign(call, {
      matched: true,
      matchedInterfaceId: meta.id,
      matchedInterfaceName: meta.name,
      matchedFolder: meta.folder || '',
      score: 100,
      confidence: 'manual',
      matchSource: 'manual',
    })
  }
  project.scan = recalcScan(project.scan, project.interfaces)
  return store.saveProject(project)
}

// ---------------------------------------------------------------------------
// 生成黑盒流程
// ---------------------------------------------------------------------------

function safeVarName(name) {
  return String(name || 'param').replace(/[^\w]/g, '_')
}

function interfaceNode(meta, calls, index, base, total) {
  const vars = {}
  let apiPath = meta.path
  for (const p of meta.pathParams || []) {
    const name = safeVarName(p.name)
    vars[name] = p.example ?? ''
    apiPath = apiPath.replace(new RegExp(`\\{${p.name}\\}`, 'g'), `{{${name}}}`)
  }
  const requiredQuery = (meta.queryParams || []).filter((p) => p.required)
  for (const p of requiredQuery) vars[safeVarName(p.name)] = p.example ?? ''

  let url
  if (base) url = `${base.replace(/\/$/, '')}${apiPath}`
  else url = `{{baseUrl}}${apiPath}`
  if (requiredQuery.length) {
    url += `?${requiredQuery.map((p) => `${p.name}={{${safeVarName(p.name)}}}`).join('&')}`
  }

  const perRow = 6
  return {
    id: `n${index + 1}`,
    name: meta.name || meta.id,
    action: {
      type: 'http',
      method: meta.method,
      url,
      headers: { 'Content-Type': 'application/json' },
      body: ['GET', 'DELETE', 'HEAD'].includes(meta.method) ? null : meta.bodySample ?? null,
      timeout: 15000,
    },
    input: {
      api: meta.id,
      folder: meta.folder || '',
      calls: calls.map((c) => ({ file: c.file, line: c.line, functionName: c.functionName })),
    },
    expected: {
      status: meta.method === 'POST' ? 201 : 200,
      checks: [],
    },
    extract: {},
    position: { x: 80 + (index % perRow) * 300, y: 120 + Math.floor(index / perRow) * 150 },
    _vars: vars,
    _total: total,
  }
}

function buildFlowFromCalls(project, calls, name, base, metaById, business) {
  const orderedIds = []
  const callsById = new Map()
  for (const call of calls) {
    if (!call.matchedInterfaceId) continue
    if (!callsById.has(call.matchedInterfaceId)) {
      callsById.set(call.matchedInterfaceId, [])
      orderedIds.push(call.matchedInterfaceId)
    }
    callsById.get(call.matchedInterfaceId).push(call)
  }
  const nodes = []
  const variables = { baseUrl: base || '' }
  orderedIds.forEach((iid, i) => {
    const meta = metaById.get(iid)
    if (!meta) return
    const node = interfaceNode(meta, callsById.get(iid) || [], i, base, orderedIds.length)
    Object.assign(variables, node._vars)
    delete node._vars
    delete node._total
    nodes.push(node)
  })
  if (!nodes.length) return null

  return {
    name,
    type: 'blackbox',
    description: `由项目源码调用分析生成：${calls.length} 个调用点 → ${nodes.length} 个接口节点`,
    projectId: project.id,
    business: business || name,
    source: 'project-scan',
    variables,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({
      id: `e_${nodes[i].id}_${n.id}`,
      from: nodes[i].id,
      to: n.id,
      condition: '',
    })),
  }
}

/**
 * 按业务功能生成流程。
 * @param {string} id 项目 ID
 * @param {{ groupKeys?: string[], all?: boolean, name?: string, serviceBaseUrl?: string }} input
 */
export function generateProjectFlows(id, input = {}) {
  const project = store.getProject(id)
  if (!project) throw new Error('项目不存在')
  const scan = project.scan
  if (!scan?.calls?.length) throw new Error('请先扫描项目源码')
  const metaById = new Map((project.interfaces || []).map((it) => [it.id, it]))
  const base = clean(input.serviceBaseUrl || project.serviceBaseUrl || project.interfaces[0]?.serverUrl).replace(/\/$/, '')
  if (!base) {
    // 允许生成，但地址会是 {{baseUrl}}，需在项目里补被测服务地址
  }

  const flows = []
  if (input.all) {
    const callIds = new Set(scan.calls.map((c) => c.id))
    const calls = scan.calls.filter((c) => callIds.has(c.id))
    const flow = buildFlowFromCalls(project, calls, input.name || `${project.name} · 全量接口调用流程`, base, metaById, '全量接口')
    if (flow) flows.push(store.saveFlow(flow))
  } else {
    const keys = Array.isArray(input.groupKeys) ? input.groupKeys : []
    if (!keys.length) throw new Error('请至少选择一个业务功能')
    for (const key of keys) {
      const group = (scan.groups || []).find((g) => g.key === key)
      if (!group) continue
      const calls = scan.calls.filter((c) => group.callIds.includes(c.id))
      const flow = buildFlowFromCalls(
        project,
        calls,
        input.name && keys.length === 1 ? input.name : `${project.name} · ${group.name}`,
        base,
        metaById,
        group.name
      )
      if (flow) {
        flow.description = `业务功能「${group.name}」：${calls.filter((c) => c.matched).length} 个调用点 → ${flow.nodes.length} 个接口节点`
        flows.push(store.saveFlow(flow))
      }
    }
  }
  if (!flows.length) throw new Error('选中的业务功能没有匹配到接口，无法生成流程')
  return flows
}

/** 项目目录是否可读（前端提前校验） */
export function checkCodePath(input) {
  const root = clean(input)
  if (!root) return { ok: false, error: '请填写代码目录' }
  try {
    const stat = fs.statSync(path.resolve(root))
    if (!stat.isDirectory()) return { ok: false, error: '路径不是文件夹' }
    return { ok: true, root: path.resolve(root) }
  } catch {
    return { ok: false, error: '目录不存在或无权访问' }
  }
}
