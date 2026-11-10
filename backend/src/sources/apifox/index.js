/**
 * Apifox 接口来源适配器（M3'-1）
 *
 * 原则：**只做形状转换，不改传输语义**。
 *   - 拉取/缓存/降级逻辑原样复用 `apifox/service.js`（MCP + 缓存文件）；
 *   - 本文件负责把结果包装成统一契约 `{ interfaces, meta, ...兼容字段 }`。
 *
 * 因此 SRC-1 的「响应字段零变化」是靠复用而不是靠重写实现的。
 * 依赖以参数注入，便于单测在不联网、不落盘的情况下覆盖全部分支。
 */
import {
  fetchInterfaces as defaultFetchInterfaces,
  getCachedInterfaces as defaultGetCachedInterfaces,
  readCache as defaultReadCache,
  resolveConnection as defaultResolveConnection,
  saveConfig as defaultSaveConfig,
  testConnection as defaultTestConnection,
} from '../../apifox/service.js'
import { assertSource, buildSourceMeta, sourceError, validateSnapshots } from '../contract.js'
import { describeInterfaces } from '../openapi/projector.js'

export const KIND = 'apifox'

const CONFIG_FIELDS = [
  { key: 'projectId', label: '项目 ID', required: false },
  { key: 'siteId', label: '在线文档 Site ID', required: false },
  { key: 'branchId', label: '分支 ID', required: false },
  { key: 'apiBaseUrl', label: '接口基础地址', required: false },
  { key: 'token', label: '访问令牌', required: false, secret: true },
]

export function createApifoxSource(overrides = {}) {
  const deps = {
    fetchInterfaces: defaultFetchInterfaces,
    getCachedInterfaces: defaultGetCachedInterfaces,
    readCache: defaultReadCache,
    resolveConnection: defaultResolveConnection,
    saveConfig: defaultSaveConfig,
    testConnection: defaultTestConnection,
    ...overrides,
  }

  const adapter = {
    kind: KIND,
    label: 'Apifox',

    describe() {
      return {
        kind: KIND,
        label: 'Apifox',
        capabilities: {
          folders: true,
          examples: true,
          auth: true,
          incremental: false,
          recordedValues: false,
        },
        configFields: CONFIG_FIELDS.map((f) => ({ ...f })),
      }
    },

    /**
     * 拉取接口列表。
     *
     * 与旧 `pullProjectInterfaces()` 逐分支对齐：
     *   1. 没填项目 ID / siteId → 只用本机缓存（有就返回，没有就报「请先配置」）
     *   2. 有项目 ID 但没令牌 → 同项目缓存且非强制刷新时用缓存（令牌只留在进程内存）
     *   3. 其余情况走 MCP 拉取，成功后把连接标识回写全局配置
     */
    async fetch(config = {}, ctx = {}) {
      const refresh = ctx.refresh !== undefined ? ctx.refresh : config.refresh
      const connection = deps.resolveConnection(config)

      if (!connection.projectId && !connection.siteId) {
        const cached = deps.getCachedInterfaces()
        if (cached) return cachedResult(cached)
        throw sourceError(
          'SOURCE_NOT_CONFIGURED',
          '请先在「数据导入」页完成全局 Apifox 连接（项目 ID + 访问令牌）',
          { kind: KIND }
        )
      }

      if (!connection.token) {
        const cache = deps.readCache()
        const sameProject = cache && (!connection.projectId || cache.projectId === connection.projectId)
        if (sameProject && refresh !== true) {
          return cachedResult(deps.getCachedInterfaces())
        }
      }

      const result = await deps.fetchInterfaces(connection, { refresh: refresh !== false })
      // 连接标识回写全局配置，保持全站单例；令牌仍然只留在进程内存
      deps.saveConfig({
        projectId: connection.projectId,
        siteId: connection.siteId,
        branchId: connection.branchId,
        baseUrl: connection.baseUrl,
        token: config.token !== undefined ? connection.token : undefined,
      })

      return {
        ...result,
        fromCache: false,
        meta: buildSourceMeta({
          kind: KIND,
          fetchedAt: result.fetchedAt,
          interfaces: result.interfaces,
          fromCache: false,
        }),
      }
    },

    /** 把勾选的接口展开成可脱离缓存使用的快照（绑定项目时调用） */
    async snapshot(ids = [], _config = {}) {
      const cache = deps.readCache()
      if (!cache?.spec || !ids.length) return []
      return validateSnapshots(describeInterfaces(cache.spec, ids), KIND)
    },

    /** 本机缓存投影（available 接口优先读它） */
    cached() {
      return deps.getCachedInterfaces()
    },

    /** 只做协议握手 + 读取文档概要，不落缓存 */
    async test(config = {}) {
      return deps.testConnection(deps.resolveConnection(config))
    },
  }

  return assertSource(adapter)
}

function cachedResult(cached) {
  return {
    ...cached,
    fromCache: true,
    meta: buildSourceMeta({
      kind: KIND,
      fetchedAt: cached?.fetchedAt,
      interfaces: cached?.interfaces || [],
      fromCache: true,
      warnings: ['使用了本机缓存，可能不是最新文档；需要最新数据请强制刷新'],
    }),
  }
}

export default createApifoxSource()
