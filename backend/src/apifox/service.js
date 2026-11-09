/**
 * Apifox MCP 服务层：
 *  1. 拉起官方 apifox-mcp-server，读取项目 OpenAPI（read_project_oas / refresh_project_oas）
 *  2. 官方包会把 paths / components 拆成带 $ref 的多个文件，这里用
 *     read_project_oas_ref_resources 递归取回并内联，还原成完整 OpenAPI 文档
 *  3. 输出接口列表，供前端勾选后生成黑盒流程
 *
 * 说明：访问令牌只在进程内存中使用（或读取环境变量 APIFOX_ACCESS_TOKEN），
 * 不写入任何配置文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import { parseOpenApi, sampleBody } from '../importers/openapi.js'
import { ApifoxMcpClient, pickTool } from './mcpClient.js'

const APIFOX_DIR = path.join(DATA_DIR, 'apifox')
const CONFIG_FILE = path.join(DATA_DIR, 'apifox-config.json')
const CACHE_FILE = path.join(APIFOX_DIR, 'oas-cache.json')

let runtimeToken = process.env.APIFOX_ACCESS_TOKEN || ''

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// 连接配置（令牌不落盘）
// ---------------------------------------------------------------------------

export function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {})
  return {
    projectId: cfg.projectId || process.env.APIFOX_PROJECT_ID || '',
    siteId: cfg.siteId || '',
    branchId: cfg.branchId || '',
    baseUrl: cfg.baseUrl || '',
    updatedAt: cfg.updatedAt || 0,
  }
}

export function getConfigView() {
  const cfg = loadConfig()
  return {
    ...cfg,
    hasEnvToken: Boolean(process.env.APIFOX_ACCESS_TOKEN),
    hasRuntimeToken: Boolean(runtimeToken),
  }
}

export function saveConfig(input = {}) {
  const current = loadConfig()
  const next = {
    projectId: String(input.projectId ?? current.projectId ?? '').trim(),
    siteId: String(input.siteId ?? current.siteId ?? '').trim(),
    branchId: String(input.branchId ?? current.branchId ?? '').trim(),
    baseUrl: String(input.baseUrl ?? current.baseUrl ?? '').trim(),
    updatedAt: Date.now(),
  }
  writeJson(CONFIG_FILE, next)
  if (input.token !== undefined) runtimeToken = String(input.token || '').trim()
  return getConfigView()
}

export function clearRuntimeToken() {
  if (!process.env.APIFOX_ACCESS_TOKEN) runtimeToken = ''
  return getConfigView()
}

/** 请求参数 + 已保存配置 + 内存令牌 合并成一次连接参数 */
export function resolveConnection(input = {}) {
  const cfg = loadConfig()
  return {
    projectId: String(input.projectId ?? cfg.projectId ?? '').trim(),
    siteId: String(input.siteId ?? cfg.siteId ?? '').trim(),
    branchId: String(input.branchId ?? cfg.branchId ?? '').trim(),
    baseUrl: String(input.baseUrl ?? cfg.baseUrl ?? '').trim(),
    token: String(input.token ?? runtimeToken ?? '').trim(),
  }
}

// ---------------------------------------------------------------------------
// OpenAPI 还原（$ref 内联）
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** 收集指向 MCP 缓存文件的 $ref（形如 /paths/xxx.json） */
function collectFileRefs(node, loaded, out = new Set(), chain = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectFileRefs(item, loaded, out, chain)
    return out
  }
  if (!isPlainObject(node)) return out
  if (typeof node.$ref === 'string' && node.$ref.startsWith('/')) {
    if (!loaded.has(node.$ref) && !chain.has(node.$ref)) out.add(node.$ref)
  }
  for (const value of Object.values(node)) collectFileRefs(value, loaded, out, chain)
  return out
}

/** 用已取回的文件内容替换 $ref 节点（sibling 字段保留） */
function inlineFileRefs(node, files, chain = new Set()) {
  if (Array.isArray(node)) return node.map((item) => inlineFileRefs(item, files, chain))
  if (!isPlainObject(node)) return node
  if (typeof node.$ref === 'string' && node.$ref.startsWith('/')) {
    const ref = node.$ref
    const target = files.get(ref)
    if (isPlainObject(target) && !chain.has(ref)) {
      const { $ref: _ref, ...rest } = node
      const nextChain = new Set(chain).add(ref)
      // 官方包 index.json 中会附带 { get: { summary } } 这类摘要，
      // 必须以引用文件里的完整定义为准，避免摘要覆盖完整 operation。
      return {
        ...inlineFileRefs(rest, files, nextChain),
        ...inlineFileRefs(structuredClone(target), files, nextChain),
      }
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(node)) out[key] = inlineFileRefs(value, files, chain)
  return out
}

function pointerGet(root, ref) {
  const parts = ref
    .replace(/^#\//, '')
    .split('/')
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur = root
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** 解析 #/components/... 本地引用（循环引用保留 $ref，避免死循环） */
function resolveLocalRefs(node, root, stack = new Set()) {
  if (Array.isArray(node)) return node.map((item) => resolveLocalRefs(item, root, stack))
  if (!isPlainObject(node)) return node
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const ref = node.$ref
    if (!stack.has(ref)) {
      const target = pointerGet(root, ref)
      if (target !== undefined) {
        const nextStack = new Set(stack).add(ref)
        const resolved = resolveLocalRefs(structuredClone(target), root, nextStack)
        const { $ref: _ref, ...rest } = node
        const siblings = resolveLocalRefs(rest, root, nextStack)
        if (isPlainObject(resolved)) return { ...resolved, ...siblings }
        return resolved
      }
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(node)) out[key] = resolveLocalRefs(value, root, stack)
  return out
}

async function resolveSpecRefs(client, refTool, spec) {
  const files = new Map()
  let doc = spec
  // 官方包把 paths 与 components 拆成文件，逐轮取回并内联
  for (let round = 0; round < 8; round++) {
    const refs = [...collectFileRefs(doc, files)]
    if (!refs.length) break
    const text = await client.callTool(refTool, { path: refs }, 180000)
    let map
    try {
      map = JSON.parse(text)
    } catch {
      throw new Error(`读取接口文档引用文件失败：${String(text).slice(0, 300)}`)
    }
    for (const [ref, content] of Object.entries(map || {})) {
      try {
        files.set(ref, JSON.parse(content))
      } catch {
        files.set(ref, content)
      }
    }
    doc = inlineFileRefs(doc, files)
  }
  return resolveLocalRefs(doc, doc)
}

/** 兜底：官方 MCP 缓存目录里的 original.json 是未拆分的完整文档 */
function readOriginalFromCache(connection) {
  if (!connection.projectId) return null
  const dir = path.join(APIFOX_DIR, '.apifox-mcp-server', `project-${connection.projectId}`)
  const file = path.join(dir, 'original.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function countInterfaces(spec) {
  let count = 0
  for (const item of Object.values(spec.paths || {})) {
    if (!isPlainObject(item)) continue
    for (const method of METHODS) if (item[method]) count++
  }
  return count
}

/**
 * 通过 MCP 拉取 OpenAPI。
 * @param {object} connection resolveConnection() 的结果
 * @param {{ refresh?: boolean }} [options] refresh=true 时调用 refresh_project_oas 强制从 Apifox 重新下载
 */
export async function pullSpec(connection, { refresh = false } = {}) {
  if (!connection.projectId && !connection.siteId && !connection.specFile) {
    throw new Error('请先填写 Apifox 项目 ID（或在线文档 site-id）')
  }
  if (connection.projectId && !connection.token) {
    throw new Error('请填写 Apifox 访问令牌（APIFOX_ACCESS_TOKEN），或在后端环境变量中配置')
  }

  const client = new ApifoxMcpClient({
    projectId: connection.projectId,
    siteId: connection.siteId,
    token: connection.token,
    branchId: connection.branchId,
    baseUrl: connection.baseUrl,
    specFile: connection.specFile,
    dataLocation: APIFOX_DIR,
  })

  try {
    await client.start()
    const tools = await client.listTools()
    const readTool = pickTool(tools, 'read_project_oas')
    const refTool = pickTool(tools, 'read_project_oas_ref_resources')
    let refreshTool = ''
    try {
      refreshTool = pickTool(tools, 'refresh_project_oas')
    } catch {
      refreshTool = ''
    }

    const text =
      refresh && refreshTool
        ? await client.callTool(refreshTool, {}, 240000)
        : await client.callTool(readTool, {}, 240000)

    let spec
    try {
      spec = JSON.parse(text)
    } catch {
      throw new Error(`拉取接口文档失败：${String(text).slice(0, 300) || '返回内容为空'}`)
    }
    if (!isPlainObject(spec) || !spec.paths) {
      throw new Error('Apifox 返回的文档不是 OpenAPI 结构（缺少 paths），请确认项目 ID 与访问令牌')
    }

    let resolved = await resolveSpecRefs(client, refTool, spec)
    if (countInterfaces(resolved) === 0) {
      // 极端情况下引用文件缺失，退回官方缓存里的原始完整文档
      const original = readOriginalFromCache(connection)
      if (original?.paths) resolved = original
    }
    return { spec: resolved, tools: tools.map((t) => t.name) }
  } finally {
    client.close()
  }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

export function readCache() {
  const cache = readJson(CACHE_FILE, null)
  if (!cache?.spec) return null
  return cache
}

function saveCache(connection, spec) {
  const payload = {
    projectId: connection.projectId || '',
    siteId: connection.siteId || '',
    title: spec.info?.title || '',
    version: spec.info?.version || '',
    fetchedAt: Date.now(),
    spec,
  }
  writeJson(CACHE_FILE, payload)
  return payload
}

export function getCachedInterfaces() {
  const cache = readCache()
  if (!cache) return null
  return {
    title: cache.title,
    version: cache.version,
    baseUrl: cache.spec?.servers?.[0]?.url || '',
    fetchedAt: cache.fetchedAt,
    projectId: cache.projectId,
    interfaces: extractInterfaces(cache.spec),
  }
}

// ---------------------------------------------------------------------------
// 接口列表 / 流程生成
// ---------------------------------------------------------------------------

export function extractInterfaces(spec) {
  const list = []
  for (const [apiPath, item] of Object.entries(spec.paths || {})) {
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
 * 项目绑定接口时存一份快照，后续扫描与生成流程都不再依赖 Apifox 缓存。
 */
export function describeInterfaces(spec, ids) {
  const wanted = new Set(ids)
  const serverUrl = spec.servers?.[0]?.url || ''
  const result = []
  for (const [apiPath, item] of Object.entries(spec.paths || {})) {
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
  for (const [apiPath, item] of Object.entries(spec.paths || {})) {
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

/** 把选中的接口转换成黑盒流程 DSL（复用 OpenAPI 导入器） */
export function buildFlow(spec, ids, name, baseUrl) {
  const filtered = filterSpec(spec, ids)
  if (countInterfaces(filtered) === 0) {
    throw new Error('没有选中任何接口')
  }
  if (baseUrl) {
    filtered.servers = [{ url: String(baseUrl).replace(/\/$/, '') }]
  }
  const flow = parseOpenApi(filtered, name)
  if (baseUrl) flow.variables = { ...flow.variables, baseUrl: filtered.servers[0].url }
  return flow
}

/** 拉取并缓存，返回接口列表 */
export async function fetchInterfaces(connection, { refresh = true } = {}) {
  const { spec } = await pullSpec(connection, { refresh })
  const cache = saveCache(connection, spec)
  const interfaces = extractInterfaces(spec)
  if (!interfaces.length) {
    throw new Error('项目中没有解析到接口，请确认项目 ID / 站点选择是否正确')
  }
  return {
    title: cache.title,
    version: cache.version,
    baseUrl: spec.servers?.[0]?.url || '',
    fetchedAt: cache.fetchedAt,
    count: interfaces.length,
    interfaces,
  }
}

/** 测试连接：只做协议握手 + 读取文档概要，不落缓存 */
export async function testConnection(connection) {
  const { spec, tools } = await pullSpec(connection, { refresh: false })
  return {
    ok: true,
    title: spec.info?.title || '',
    version: spec.info?.version || '',
    baseUrl: spec.servers?.[0]?.url || '',
    interfaceCount: countInterfaces(spec),
    tools,
  }
}
