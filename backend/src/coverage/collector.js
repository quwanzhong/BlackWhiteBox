/**
 * 覆盖率采集器（M3-1 / docs/02 §6.2）
 *
 * 职责边界：
 *   - 只做「每节点取证 + 落库」，不做分析。原始 `.exec` 存 `coverage.exec_blob`，
 *     M3-2 再批量跑 jacococli 写 `result_json`；
 *   - 永远不把采集失败抛给执行引擎：agent 不可达/超时/协议错误时写一行
 *     `status='unavailable'` + error，UI 显示「无运行时证据」，
 *     绝不把「没采到」伪装成「0% 覆盖」或「通过」（FR-3.2.7 / AC-3.2.7）。
 *
 * 生命周期（每个 HTTP 节点）：
 *   begin(nodeId)  → reset()            清空探针，保证快照只含本节点
 *   （节点执行）
 *   end(nodeId)    → dumpAndReset()     取数并原子清零，落库
 *
 * 连接是懒建立的：第一次 begin 才连 agent。若首次连接失败，本会话不再重试
 * （避免每个节点都付一次连接超时），后续节点仍逐条写 unavailable，归因清晰。
 */
import { store } from '../store.js'
import { JacocoClient } from './jacoco-client.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 6300
const DEFAULT_TIMEOUT_MS = 5000

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从环境 `settings.coverage` 提取采集配置；未配置或显式关闭时返回 null。
 * 校验以 environments/service.js 为准，这里只做执行期兜底。
 */
export function coverageConfigFrom(settings) {
  if (!isPlainObject(settings)) return null
  const raw = settings.coverage
  if (!isPlainObject(raw)) return null
  if (raw.enabled === false) return null
  return {
    source: raw.source || 'jacoco',
    host: raw.host || DEFAULT_HOST,
    port: Number.isInteger(raw.port) ? raw.port : DEFAULT_PORT,
    timeoutMs: Number.isInteger(raw.timeoutMs) ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

/** 降级原因统一成「稳定 code + 中文消息」，落库与 UI 共用一份口径 */
function describeError(err) {
  const code = err?.code || 'COVERAGE_AGENT_ERROR'
  const message = err?.message || String(err)
  return `${code}: ${message}`
}

export class CoverageCollector {
  /**
   * @param {{executionId: string, settings?: object,
   *          clientFactory?: (opts: object) => Promise<JacocoClient>}} opts
   */
  constructor({ executionId, settings, clientFactory } = {}) {
    this.executionId = executionId
    this.config = coverageConfigFrom(settings)
    this.clientFactory = clientFactory || ((opts) => JacocoClient.connect(opts))
    this.client = null
    this.failure = null
  }

  /** 是否配置了覆盖率取证（未配置时执行结果中白盒字段保持 null） */
  get enabled() {
    return Boolean(this.config)
  }

  async openClient() {
    if (this.client) return this.client
    this.client = await this.clientFactory({
      host: this.config.host,
      port: this.config.port,
      timeoutMs: this.config.timeoutMs,
    })
    return this.client
  }

  /** 记录失败并释放连接；本会话不再尝试连接 */
  async degrade(err) {
    this.failure = describeError(err)
    const client = this.client
    this.client = null
    if (client) await client.close().catch(() => {})
    return this.failure
  }

  /** 节点开始：清零探针。任何异常都只降级，不抛出。 */
  async begin(nodeId) {
    if (!this.config || this.failure) return null
    try {
      const client = await this.openClient()
      await client.reset()
      return { nodeId, reset: true }
    } catch (err) {
      await this.degrade(err)
      return null
    }
  }

  /**
   * 节点结束：取数 + 清零并落库。
   * @returns {Promise<null|{id:string,nodeId:string,source:string,mode:string,
   *          status:string,bytes:number,error:string|null,pending:boolean}>}
   */
  async end(nodeId) {
    if (!this.config) return null

    let saved
    if (this.failure) {
      saved = store.saveCoverage({
        executionId: this.executionId,
        nodeId,
        source: this.config.source,
        mode: 'per-node',
        status: 'unavailable',
        error: this.failure,
      })
    } else {
      try {
        const client = await this.openClient()
        const { exec } = await client.dumpAndReset()
        saved = store.saveCoverage({
          executionId: this.executionId,
          nodeId,
          source: this.config.source,
          mode: 'per-node',
          status: 'captured',
          execBlob: exec,
        })
      } catch (err) {
        await this.degrade(err)
        saved = store.saveCoverage({
          executionId: this.executionId,
          nodeId,
          source: this.config.source,
          mode: 'per-node',
          status: 'unavailable',
          error: this.failure,
        })
      }
    }

    return {
      id: saved.id,
      nodeId: saved.nodeId,
      source: saved.source,
      mode: saved.mode,
      status: saved.status,
      bytes: saved.bytes,
      error: saved.error,
      capturedAt: saved.capturedAt,
      // M3-2 才会解析出 files/classes；在此之前明确标「待分析」，前端不显示百分比
      pending: saved.status === 'captured',
    }
  }

  async close() {
    const client = this.client
    this.client = null
    if (client) await client.close().catch(() => {})
  }
}

/** 执行会话无条件持有一个采集器（未配置时是空实现），调用方无需判空 */
export function createCoverageCollector(opts) {
  return new CoverageCollector(opts)
}
