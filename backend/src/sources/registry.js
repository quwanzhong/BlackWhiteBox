/**
 * 接口来源注册表 + 工厂（M3'-1）
 *
 * 设计目标（docs/05 §5）：
 *   - 变化维度只有「来源」一个，因此用工厂而不是桥接层；
 *   - 上层只认 InterfaceSnapshot 与 describe() 的能力声明；
 *   - 新增来源 = 注册一个适配器，不改 projects/routes/前端项目页（SRC-2）。
 *
 * 错误约定：未知来源一律抛 SourceError('SOURCE_UNKNOWN')，
 * 调用方按 code 映射状态码，不靠匹配错误文案。
 */
import { assertSource, normalizeSourceConfig, sourceError, SOURCE_KINDS } from './contract.js'
import { createApifoxSource } from './apifox/index.js'
import { createOpenApiSource } from './openapi/index.js'

export function createRegistry(adapters = []) {
  const sources = new Map()

  const registry = {
    /** 注册适配器；kind 重复视为编程错误，直接抛（避免静默覆盖） */
    register(adapter) {
      assertSource(adapter)
      if (sources.has(adapter.kind)) {
        throw sourceError('SOURCE_DUPLICATE', `接口来源 ${adapter.kind} 已注册`)
      }
      sources.set(adapter.kind, adapter)
      return adapter
    },

    has(kind) {
      return sources.has(String(kind ?? '').trim())
    },

    /** 取适配器实例（可能为 null），用于「可选方法是否存在」的判断 */
    get(kind) {
      return sources.get(String(kind ?? '').trim()) || null
    },

    /** 工厂：未知/空 kind 抛 SOURCE_UNKNOWN */
    create(kind) {
      const key = String(kind ?? '').trim()
      const available = [...sources.keys()].join(' / ')
      if (!key) {
        throw sourceError('SOURCE_UNKNOWN', `缺少接口来源类型，可选：${available}`, { kind: key })
      }
      const adapter = sources.get(key)
      if (!adapter) {
        throw sourceError('SOURCE_UNKNOWN', `不支持的接口来源：${key}，可选：${available}`, { kind: key })
      }
      return adapter
    },

    /** 前端配置表单的唯一来源：describe() 里已声明 configFields */
    list() {
      return [...sources.values()].map((adapter) => adapter.describe())
    },

    kinds() {
      return [...sources.keys()]
    },

    /**
     * project → { source, kind, config }。
     * 兼容旧数据（project.apifox）与新模型（project.source），读时归一化。
     */
    forProject(project) {
      const { kind, config } = normalizeSourceConfig(project)
      return { source: registry.create(kind), kind, config }
    },
  }

  for (const adapter of adapters) registry.register(adapter)
  return registry
}

/** 默认单例：Apifox（首个实现）+ OpenAPI（收编既有 importer 的投影能力） */
export const registry = createRegistry([createApifoxSource(), createOpenApiSource()])

export const registerSource = (adapter) => registry.register(adapter)
export const getSource = (kind) => registry.get(kind)
export const createSource = (kind) => registry.create(kind)
export const listSources = () => registry.list()
export const sourceKinds = () => registry.kinds()

export { SOURCE_KINDS }
