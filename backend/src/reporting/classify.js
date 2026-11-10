/**
 * 失败归类器（M2-3，docs/01 FR-4.5 / docs/02 §9.1）。
 *
 * 8 类失败是**规则可解释**的枚举，不是猜测：
 *   network       连接层失败（拒绝/DNS/重置/证书）
 *   timeout       连接超时（ECONNABORTED / ETIMEDOUT）或耗时超过节点上限
 *   status        HTTP 状态码不在期望集合
 *   schema        响应结构校验失败（check.type = schema，M3-4 白盒断言复用）
 *   assertion     JSONPath / 包含 / 正则等断言不匹配
 *   dependency    前置节点失败或分支条件未命中，本节点未执行（skipped）
 *   script        执行期配置/变量问题（不支持的节点类型、变量未解析、URL 缺失）
 *   manual_reject 人工确认判「不通过」
 *
 * 归类在两个时机发生：
 *   1) 写入时：scheduler 每步结束、执行收尾时分类并随 step/execution 一起落库（事实为准）；
 *   2) 读取时：老执行记录没有归类字段，详情接口用 enrichExecutionDetail 现算补齐（幂等）。
 */

export const FAILURE_CLASSES = [
  'network',
  'timeout',
  'status',
  'schema',
  'assertion',
  'dependency',
  'script',
  'manual_reject',
]

export const FAILURE_CLASS_LABELS = {
  network: '网络不可达',
  timeout: '超时',
  status: '状态码不符',
  schema: '结构不符',
  assertion: '断言不符',
  dependency: '前置依赖',
  script: '脚本/配置',
  manual_reject: '人工驳回',
}

/** node:net/axios 连接层错误特征（按 code/errno/message 出现） */
const NETWORK_RE =
  /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPROTO|EPIPE|getaddrinfo|socket hang up|CERT_|self[- ]signed|ERR_TLS/i
/** axios 超时 / Node 层超时特征（先于 network 判定：ECONNABORTED 属超时） */
const TIMEOUT_RE = /ECONNABORTED|ETIMEDOUT|timeout of \d+ ?ms|request timed out/i

const CHECK_CLASS = {
  status: 'status',
  duration: 'timeout',
  schema: 'schema',
  json_schema: 'schema',
  body_schema: 'schema',
  manual: 'manual_reject',
  // M3-4：覆盖率断言不符是「断言」问题；证据不可用/配置错误是「脚本/环境」问题
  coverage: 'assertion',
  coverage_evidence: 'script',
}

/**
 * 归类单个步骤。
 * @param {{ status?: string, error?: string|null, checks?: {results?: Array<object>}|null, actual?: any }} step
 * @returns {{ failureClass: string, failureReason: string } | null} 通过/等待中的步骤返回 null
 */
export function classifyStep(step) {
  if (!step || !['failed', 'skipped'].includes(step.status)) return null

  // skipped：前置失败或条件未命中（依赖问题，不是本节点的问题）
  if (step.status === 'skipped') {
    return {
      failureClass: 'dependency',
      failureReason: step.error || '前置节点失败或分支条件未命中，本步骤未执行',
    }
  }

  const checks = step.checks?.results || []
  const firstBad = checks.find((c) => c && c.passed === false)

  // 白盒人工驳回（优先于断言与错误文本：确认不通过时也会写一条 manual check）
  if (step.actual?.manual === true && step.actual?.confirmed === false) {
    return { failureClass: 'manual_reject', failureReason: step.actual?.note || '人工确认为不通过' }
  }
  if (firstBad?.type === 'manual') {
    return { failureClass: 'manual_reject', failureReason: firstBad.message || '人工确认为不通过' }
  }

  // 请求层异常：先超时（ECONNABORTED 也可能带 CONN 字样），再网络，再脚本
  if (step.error) {
    const msg = String(step.error)
    if (TIMEOUT_RE.test(msg)) return { failureClass: 'timeout', failureReason: msg }
    if (NETWORK_RE.test(msg)) return { failureClass: 'network', failureReason: msg }
    return { failureClass: 'script', failureReason: msg }
  }

  // 校验层失败：按 check 类型映射，未识别的断言统一归 assertion
  if (firstBad) {
    return {
      failureClass: CHECK_CLASS[firstBad.type] || 'assertion',
      failureReason: firstBad.message || describeCheck(firstBad),
    }
  }

  // 兜底：引擎标记失败但没有任何证据（理论不可达，保持可解释）
  return { failureClass: 'script', failureReason: '执行失败但未产生错误信息或校验结果' }
}

function describeCheck(c) {
  const v = typeof c.value === 'string' ? c.value : JSON.stringify(c.value)
  const a = typeof c.actual === 'string' ? c.actual : JSON.stringify(c.actual)
  return `期望 ${c.op || 'eq'} ${v}，实际 ${a}`
}

/**
 * 汇总整次执行的失败归类。
 * @param {Array<object>} steps
 * @param {{ status?: string }} [exec] 整次执行状态：passed/stopped 的 skipped 不计入 dependency
 * @returns {{ failureClass: string|null, failureReason: string|null, counts: Record<string, number> }}
 */
export function classifyExecution(steps, exec = {}) {
  const counts = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0]))
  let primary = null
  const skipAsDependency = !['passed', 'stopped'].includes(exec.status || '')
  for (const step of steps || []) {
    const r = classifyStep(step)
    if (!r) continue
    if (r.failureClass === 'dependency' && !skipAsDependency) continue
    counts[r.failureClass] += 1
    if (!primary) primary = { failureClass: r.failureClass, failureReason: r.failureReason }
  }
  return {
    failureClass: primary?.failureClass || null,
    failureReason: primary?.failureReason || null,
    counts,
  }
}

/**
 * 给执行详情补归类：步骤级缺失时现算，执行级投影列与计数缺失时按步骤汇总。
 * 幂等、不写库（老数据每次读取结果一致）。
 * @param {object|null} detail
 */
export function enrichExecutionDetail(detail) {
  if (!detail || !Array.isArray(detail.steps)) return detail
  for (const step of detail.steps) {
    if (step.failureClass) continue
    const r = classifyStep(step)
    if (r) {
      step.failureClass = r.failureClass
      step.failureReason = r.failureReason
    }
  }
  const rollup = classifyExecution(detail.steps, { status: detail.status })
  if (!detail.failureClass) {
    detail.failureClass = rollup.failureClass
    detail.failureReason = rollup.failureReason
  }
  // 计数与投影列分开维护：新数据只有投影列，计数在读时补齐
  if (!detail.failureClasses) detail.failureClasses = rollup.counts
  return detail
}
