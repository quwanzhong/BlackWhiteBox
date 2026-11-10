import { store } from '../store.js'
import { resolveEnvironment } from '../environments/service.js'

/**
 * 套件（Suite）= 有序 Flow 列表 + 执行策略（M2-2）。
 *
 * 这里只负责"定义与校验"；真正并发执行在 suites/runner.js。
 * 保持与 environments/service.js 同一风格：稳定错误码 + 中文可读消息 + 服务端二次校验。
 */

export const DEFAULT_STRATEGY = Object.freeze({
  concurrency: 3,
  retry: 0,
  retryDelayMs: 500,
  failFast: false,
})

export const MAX_FLOWS = 200

export class SuiteError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SuiteError'
    this.code = code
    this.status = status
  }
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/**
 * 策略归一化：非法值收敛到安全区间，而不是让整个套件保存失败。
 * 上限刻意保守（并发 8 / 重试 5），避免一次误配置把本机打满。
 */
export function normalizeStrategy(input, base = DEFAULT_STRATEGY) {
  const raw = { ...base, ...(input && typeof input === 'object' ? input : {}) }
  return {
    concurrency: clamp(toInt(raw.concurrency, DEFAULT_STRATEGY.concurrency), 1, 8),
    retry: clamp(toInt(raw.retry, DEFAULT_STRATEGY.retry), 0, 5),
    retryDelayMs: clamp(toInt(raw.retryDelayMs, DEFAULT_STRATEGY.retryDelayMs), 0, 60000),
    failFast: raw.failFast === true,
  }
}

function normalizeName(value) {
  const name = String(value ?? '').trim()
  if (!name) throw new SuiteError('SUITE_BAD_NAME', '套件名称不能为空')
  if (name.length > 60) throw new SuiteError('SUITE_BAD_NAME', '套件名称不能超过 60 个字符')
  return name
}

function normalizeDescription(value) {
  const text = String(value ?? '').trim()
  if (text.length > 500) throw new SuiteError('SUITE_BAD_DESCRIPTION', '套件描述不能超过 500 个字符')
  return text
}

function normalizeProject(value, { required = false } = {}) {
  const projectId = String(value ?? '').trim()
  if (!projectId) {
    if (required) throw new SuiteError('SUITE_PROJECT_REQUIRED', '请先选择所属项目')
    return null
  }
  if (!store.getProject(projectId)) {
    throw new SuiteError('SUITE_PROJECT_NOT_FOUND', '所属项目不存在', 404)
  }
  return projectId
}

function validateEnvironment(environmentId, projectId) {
  if (!environmentId) return null
  const env = store.getEnvironmentRow(String(environmentId))
  if (!env) throw new SuiteError('SUITE_ENV_NOT_FOUND', '所选环境不存在', 404)
  if (env.projectId && env.projectId !== (projectId || '')) {
    throw new SuiteError(
      'SUITE_ENV_PROJECT_MISMATCH',
      projectId ? '所选环境属于其他项目' : '套件未指定项目时只能使用全局环境'
    )
  }
  return env
}

/**
 * Flow 列表：保留顺序 + 去重；引用不存在的流程直接拒绝，
 * 避免"看起来跑完了，其实少跑一条"。
 */
function normalizeFlowIds(input, projectId) {
  const list = Array.isArray(input) ? input : []
  const ids = []
  const seen = new Set()
  for (const item of list) {
    const id = String(item ?? '').trim()
    if (!id || seen.has(id)) continue
    const flow = store.getFlow(id)
    if (!flow) throw new SuiteError('SUITE_FLOW_NOT_FOUND', `流程不存在：${id}`, 404)
    if (projectId && flow.projectId && flow.projectId !== projectId) {
      throw new SuiteError('SUITE_FLOW_PROJECT_MISMATCH', `流程「${flow.name}」属于其他项目`)
    }
    seen.add(id)
    ids.push(id)
  }
  if (!ids.length) throw new SuiteError('SUITE_EMPTY', '套件至少需要一条流程')
  if (ids.length > MAX_FLOWS) {
    throw new SuiteError('SUITE_TOO_MANY_FLOWS', `一个套件最多 ${MAX_FLOWS} 条流程`)
  }
  return ids
}

function ensureNameUnique(name, projectId, excludeId) {
  const clash = store
    .listSuites()
    .some((s) => s.id !== excludeId && (s.projectId || '') === (projectId || '') && s.name === name)
  if (clash) throw new SuiteError('SUITE_NAME_CONFLICT', '同一项目下已存在同名套件')
}

export function listSuites(projectId) {
  const list = store.listSuites()
  return projectId ? list.filter((s) => s.projectId === projectId) : list
}

export function getSuite(id) {
  return store.getSuite(id)
}

/** 套件详情：把 flowIds 解析成可展示的流程摘要（含已删除流程的占位） */
export function getSuiteDetail(id) {
  const suite = store.getSuite(id)
  if (!suite) return null
  const flows = suite.flowIds.map((flowId) => {
    const flow = store.getFlow(flowId)
    return flow
      ? { id: flow.id, name: flow.name, type: flow.type, projectId: flow.projectId || null, exists: true }
      : { id: flowId, name: '（流程已删除）', type: null, projectId: null, exists: false }
  })
  const runs = store.listSuiteRuns({ suiteId: id, limit: 10 })
  return { ...suite, flows, missingFlowIds: flows.filter((f) => !f.exists).map((f) => f.id), runs }
}

export function createSuite(input = {}) {
  const projectId = normalizeProject(input.projectId)
  const name = normalizeName(input.name)
  ensureNameUnique(name, projectId, null)
  const flowIds = normalizeFlowIds(input.flowIds, projectId)
  const environmentId = input.environmentId ? String(input.environmentId) : null
  validateEnvironment(environmentId, projectId)

  const suite = store.saveSuite({
    projectId,
    name,
    description: normalizeDescription(input.description),
    flowIds,
    strategy: normalizeStrategy(input.strategy),
    environmentId,
  })
  return publicSuite(suite)
}

export function updateSuite(id, input = {}) {
  const existing = store.getSuite(id)
  if (!existing) throw new SuiteError('SUITE_NOT_FOUND', '套件不存在', 404)

  const projectId = normalizeProject(input.projectId !== undefined ? input.projectId : existing.projectId)
  const name = normalizeName(input.name !== undefined ? input.name : existing.name)
  ensureNameUnique(name, projectId, id)
  const flowIds = normalizeFlowIds(input.flowIds !== undefined ? input.flowIds : existing.flowIds, projectId)
  const environmentId =
    input.environmentId !== undefined
      ? input.environmentId
        ? String(input.environmentId)
        : null
      : existing.environmentId
  validateEnvironment(environmentId, projectId)

  const suite = store.saveSuite({
    ...existing,
    projectId,
    name,
    description:
      input.description !== undefined ? normalizeDescription(input.description) : existing.description,
    flowIds,
    strategy:
      input.strategy !== undefined ? normalizeStrategy(input.strategy, existing.strategy) : existing.strategy,
    environmentId,
  })
  return publicSuite(suite)
}

export function deleteSuite(id) {
  const existing = store.getSuite(id)
  if (!existing) throw new SuiteError('SUITE_NOT_FOUND', '套件不存在', 404)
  store.deleteSuite(id)
  return true
}

/**
 * 执行所需的最小上下文：套件 + 按顺序解析后的流程 + 环境明文（仅内存）。
 * 缺失的流程在执行阶段记 skipped，不阻断整个套件（更像 CI 的行为）。
 */
export function prepareRun(id, { environmentId } = {}) {
  const suite = store.getSuite(id)
  if (!suite) throw new SuiteError('SUITE_NOT_FOUND', '套件不存在', 404)

  const effectiveEnvId = environmentId ? String(environmentId) : suite.environmentId
  if (effectiveEnvId && !suite.projectId) {
    // 全局套件 + 指定环境：允许，但环境必须是全局的，否则无法判断适用项目
    const env = store.getEnvironmentRow(effectiveEnvId)
    if (!env) throw new SuiteError('SUITE_ENV_NOT_FOUND', '所选环境不存在', 404)
    if (env.projectId) {
      throw new SuiteError('SUITE_ENV_PROJECT_MISMATCH', '全局套件只能使用全局环境')
    }
  }

  let environment = null
  if (effectiveEnvId) {
    try {
      environment = resolveEnvironment(effectiveEnvId)
    } catch (err) {
      throw new SuiteError(err.code || 'SUITE_ENV_NOT_FOUND', err.message, err.status || 404)
    }
    if (environment.projectId && environment.projectId !== (suite.projectId || '')) {
      throw new SuiteError('SUITE_ENV_PROJECT_MISMATCH', '所选环境属于其他项目')
    }
    for (const flowId of suite.flowIds) {
      const flow = store.getFlow(flowId)
      if (flow && environment.projectId && flow.projectId && flow.projectId !== environment.projectId) {
        throw new SuiteError(
          'SUITE_FLOW_PROJECT_MISMATCH',
          `流程「${flow.name}」与环境不属于同一项目`
        )
      }
    }
  }

  const flows = suite.flowIds.map((flowId, index) => {
    const flow = store.getFlow(flowId)
    return { flowId, index, flow }
  })

  return { suite, flows, environment }
}

export function publicSuite(suite) {
  if (!suite) return null
  return {
    ...suite,
    strategy: normalizeStrategy(suite.strategy),
    flowCount: suite.flowIds?.length || 0,
  }
}
