/**
 * OpenAPI 接口来源适配器（M3'-1 收编 importers/openapi 的投影能力）
 *
 * 输入：OpenAPI 文档（JSON 对象或 JSON 字符串），由请求直接携带。
 * 投影：与 Apifox 适配器共用 `openapi/projector.js`，保证两边的接口列表
 *       / 快照结构不可能漂移。
 *
 * 与 Apifox 的差别：没有磁盘缓存。fetch 到的 spec 保留在适配器实例内存里，
 * 供紧随其后的 snapshot()（绑定勾选接口）使用；进程重启后需重新 fetch。
 */
import { assertSource, buildSourceMeta, sourceError, validateSnapshots } from '../contract.js'
import { countInterfaces, describeInterfaces, extractInterfaces, isPlainObject } from './projector.js'

export const KIND = 'openapi'

const CONFIG_FIELDS = [
  { key: 'spec', label: 'OpenAPI 文档（JSON 字符串或对象）', required: true },
  { key: 'baseUrl', label: '接口基础地址（覆盖文档 servers）', required: false },
]

export function createOpenApiSource(overrides = {}) {
  // 内存级「最近一次 fetch」：让 fetch → snapshot → available 的既有链路对 openapi 也能走通
  const state = overrides.state || { spec: null, fetchedAt: 0 }

  function parseSpec(config = {}) {
    const raw = config.spec ?? config.document ?? config.raw
    if (raw === undefined || raw === null || raw === '') {
      throw sourceError('SOURCE_NOT_CONFIGURED', '请提供 OpenAPI 文档内容（spec 字段，JSON 对象或字符串）', { kind: KIND })
    }
    let spec = raw
    if (typeof raw === 'string') {
      try {
        spec = JSON.parse(raw)
      } catch (err) {
        throw sourceError('SOURCE_BAD_DOCUMENT', `OpenAPI 文档不是合法 JSON：${err.message}`, { kind: KIND })
      }
    }
    if (!isPlainObject(spec) || !spec.paths) {
      throw sourceError('SOURCE_BAD_DOCUMENT', '文档不是 OpenAPI 结构（缺少 paths）', { kind: KIND })
    }
    return spec
  }

  function baseUrlOf(spec, config = {}) {
    if (config.baseUrl) return String(config.baseUrl).replace(/\/$/, '')
    return spec.servers?.[0]?.url || ''
  }

  const adapter = {
    kind: KIND,
    label: 'OpenAPI 文档',

    describe() {
      return {
        kind: KIND,
        label: 'OpenAPI 文档',
        capabilities: {
          folders: false,
          examples: true,
          auth: false,
          incremental: false,
          recordedValues: false,
        },
        configFields: CONFIG_FIELDS.map((f) => ({ ...f })),
      }
    },

    /** 拉取 = 解析请求里的文档；0 条接口必须报错，绝不回退成「空成功」（SRC-3） */
    async fetch(config = {}) {
      const spec = parseSpec(config)
      const interfaces = validateSnapshots(extractInterfaces(spec), KIND)
      if (!interfaces.length) {
        throw sourceError('SOURCE_EMPTY', '文档中没有解析到任何接口，请确认导出内容包含 paths', { kind: KIND })
      }

      const fetchedAt = Date.now()
      state.spec = spec
      state.fetchedAt = fetchedAt

      const baseUrl = baseUrlOf(spec, config)
      return {
        title: spec.info?.title || '',
        version: spec.info?.version || '',
        baseUrl,
        fetchedAt,
        count: interfaces.length,
        interfaces,
        fromCache: false,
        meta: buildSourceMeta({ kind: KIND, fetchedAt, interfaces, fromCache: false }),
      }
    },

    /** 展开勾选接口的完整快照：优先请求携带的 spec，其次本实例最近一次 fetch */
    async snapshot(ids = [], config = {}) {
      const spec = config.spec !== undefined ? parseSpec(config) : state.spec
      if (!spec || !ids.length) return []
      return validateSnapshots(describeInterfaces(spec, ids), KIND)
    },

    /**
     * 无磁盘缓存：
     *   1. 项目自带 spec（project.source.config.spec）→ 只投影该项目自己的文档；
     *   2. 否则回退到本进程最近一次 fetch（全局入口 /api/sources/openapi/fetch）。
     * 优先项目配置，避免「A 项目刚 fetch 的文档被 B 项目 available 读到」。
     */
    cached(config = {}) {
      const spec = config.spec !== undefined ? parseSpec(config) : state.spec
      if (!spec) return null
      return {
        title: spec.info?.title || '',
        version: spec.info?.version || '',
        baseUrl: baseUrlOf(spec, config),
        fetchedAt: config.spec !== undefined ? 0 : state.fetchedAt,
        interfaces: extractInterfaces(spec),
      }
    },

    /** 校验文档结构与规模，不落任何状态 */
    async test(config = {}) {
      const spec = parseSpec(config)
      return {
        ok: true,
        title: spec.info?.title || '',
        version: spec.info?.version || '',
        baseUrl: baseUrlOf(spec, config),
        interfaceCount: countInterfaces(spec),
      }
    },
  }

  return assertSource(adapter)
}

/** 供后续「OpenAPI → 流程」复用：与 Apifox 侧同源的过滤投影（不在此处展开实现） */
export default createOpenApiSource()
