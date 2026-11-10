/**
 * 接口来源契约（M3'-1）
 *
 * 目标：把「接口从哪来」收敛成一个可插拔的适配器，项目/快照/匹配/生成都不感知来源。
 * 唯一的落库形态仍然是 InterfaceSnapshot（见 docs/05 §5）。
 *
 * 术语：
 *   Summary   列表页用的轻量接口投影（id/method/path/name/folder/status/tags/deprecated）
 *   Snapshot  绑定到项目时保存的完整元数据（额外含 pathParams/queryParams/bodySample/serverUrl）
 *   两者都是「快照」的不同投影，字段向后兼容，新增字段只增不改。
 */
import crypto from 'node:crypto'

/** 已知来源类型；postman / har 仅占位，注册后即可用。 */
export const SOURCE_KINDS = ['apifox', 'openapi', 'postman', 'har']

/** 带稳定错误码的来源异常：调用方据此映射 HTTP 状态，不靠字符串匹配。 */
export class SourceError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function sourceError(code, message, details) {
  return new SourceError(code, message, details)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 适配器契约校验。宁可启动/注册时炸，也不要运行时才发现某个来源少实现一个方法。
 * 必选：kind / label / describe() / fetch()
 * 可选：snapshot() / test() / cached()
 */
export function assertSource(adapter) {
  if (!isPlainObject(adapter)) throw new TypeError('接口来源适配器必须是对象')
  if (!adapter.kind || typeof adapter.kind !== 'string') throw new TypeError('接口来源缺少 kind')
  if (!adapter.label || typeof adapter.label !== 'string') throw new TypeError(`接口来源 ${adapter.kind} 缺少 label`)
  if (typeof adapter.describe !== 'function') throw new TypeError(`接口来源 ${adapter.kind} 缺少 describe()`)
  if (typeof adapter.fetch !== 'function') throw new TypeError(`接口来源 ${adapter.kind} 缺少 fetch()`)

  const desc = adapter.describe()
  if (!isPlainObject(desc) || desc.kind !== adapter.kind) {
    throw new TypeError(`接口来源 ${adapter.kind} 的 describe() 必须返回 { kind: '${adapter.kind}' }`)
  }
  if (!Array.isArray(desc.configFields)) {
    throw new TypeError(`接口来源 ${adapter.kind} 的 describe() 必须声明 configFields[]`)
  }
  for (const field of desc.configFields) {
    if (!isPlainObject(field) || !field.key) {
      throw new TypeError(`接口来源 ${adapter.kind} 的 configFields 项必须含 key`)
    }
  }
  return adapter
}

/**
 * 项目 → { kind, config }，兼容旧数据。
 *
 * 旧模型：project.apifox { projectId, siteId, branchId, apiBaseUrl }
 * 新模型：project.source { kind, config }
 * 两者并存期间：读时优先 source，缺失则由 apifox 归一化；写入时双写（见 projects/service.js）。
 */
export function normalizeSourceConfig(project = {}) {
  const source = isPlainObject(project.source) ? project.source : null
  const legacy = isPlainObject(project.apifox) ? project.apifox : {}

  if (source?.kind) {
    return { kind: String(source.kind), config: isPlainObject(source.config) ? { ...source.config } : {} }
  }

  return {
    kind: 'apifox',
    config: {
      projectId: String(legacy.projectId ?? '').trim(),
      siteId: String(legacy.siteId ?? '').trim(),
      branchId: String(legacy.branchId ?? '').trim(),
      apiBaseUrl: String(legacy.apiBaseUrl ?? '').trim(),
    },
  }
}

/** 稳定序列化：键序不同但内容相同必须得到同一指纹（文档漂移对比依赖这个性质） */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** 轻量内容指纹：用于「文档漂移」对比，不参与鉴权。 */
export function sourceHashOf(value) {
  try {
    return crypto.createHash('sha1').update(stableStringify(value ?? null)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/**
 * 统一 meta：所有适配器都返回同一形状，前端/审计只认这里。
 * sourceHash 缺省按接口投影计算，避免适配器各自实现一套。
 */
export function buildSourceMeta({ kind, fetchedAt, interfaces = [], fromCache = false, warnings = [], hashSource } = {}) {
  return {
    kind: String(kind || ''),
    fetchedAt: fetchedAt || Date.now(),
    interfaceCount: Array.isArray(interfaces) ? interfaces.length : 0,
    sourceHash: sourceHashOf(hashSource === undefined ? interfaces : hashSource),
    fromCache: Boolean(fromCache),
    warnings: Array.isArray(warnings) ? warnings : [],
  }
}

/**
 * Snapshot 形状校验：缺 id/method/path 的快照一律拒绝，
 * 防止「拉到一半的文档」被当成有效接口写进项目。
 */
export function validateSnapshots(list, kind = '') {
  if (!Array.isArray(list)) {
    throw sourceError('SOURCE_BAD_SNAPSHOT', '接口快照必须是数组', { kind })
  }
  const seen = new Set()
  for (const item of list) {
    if (!isPlainObject(item) || !item.id || !item.method || !item.path) {
      throw sourceError('SOURCE_BAD_SNAPSHOT', '接口快照缺少 id / method / path', { kind, item })
    }
    if (seen.has(item.id)) {
      throw sourceError('SOURCE_DUPLICATE_INTERFACE', `接口 ID 重复：${item.id}`, { kind, id: item.id })
    }
    seen.add(item.id)
  }
  return list
}
