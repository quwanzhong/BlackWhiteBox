/**
 * M2-5 · 会话恢复（D4 / FR-4.8 / ADR-2 #1）
 *
 * 进程启动时扫描「非终态」执行，按节点边界重建 RunSession 续跑：
 *  - 恢复点 = 节点边界。HTTP 节点是原子的，进行中的请求无法跨进程续传：
 *    该次尝试记为 skipped（error 注明「服务重启」），节点本身重跑一次，证据完整保留；
 *  - 已执行节点 / 待执行队列 / 变量 / 事件游标来自 executions.resume_json（节点边界写入）；
 *    快照缺失（老版本执行）时按「已执行步骤 + 图前沿」兜底；
 *  - 环境按 envId 重新解密（secret 仍可用），环境被删则退回落库快照（无明文 secret）；
 *  - 套件运行不自动续跑：suite_runs 收敛为 stopped，在跑的子执行按普通会话恢复。
 *
 * 取舍（docs/02 §9.3）：恢复不还原「extract 恰好取到环境 secret 明文」的变量（落库即 ***），
 * 也不做请求级幂等保证——重跑节点可能让被测服务收到重复请求。
 */
import { store } from '../store.js'
import { sessions } from './registry.js'
import { RunSession } from './scheduler.js'
import { resolveEnvironment } from '../environments/service.js'

/** 步骤终态集合（其余状态都视为「中断的尝试」） */
const TERMINAL_STEP = new Set(['passed', 'failed', 'skipped'])
const ORPHAN_NOTE = '服务重启：该次尝试被中断，节点已重跑'
const SUITE_INTERRUPT_MESSAGE = '服务重启，套件中断；在跑的子执行已按断点恢复，未开始的流程需重跑'
const UNRECOVERABLE_NOTE = '服务重启：会话无法恢复（缺少流程快照）'

const silentIo = { to: () => ({ emit() {} }) }

/**
 * 扫描并恢复所有未完成会话。同步返回统计，会话在后台异步续跑。
 * @param {{ io?: import('socket.io').Server }} [opts]
 */
export function restoreSessions({ io = null } = {}) {
  const result = { restored: [], unrecoverable: [], suiteRuns: 0, errors: [] }

  // 1) 套件运行：不自动续跑，收敛为 stopped（子执行仍是独立证据）
  for (const run of store.listUnfinishedSuiteRuns()) {
    store.saveSuiteRun({
      ...run,
      status: 'stopped',
      summary: { ...(run.summary || {}), message: SUITE_INTERRUPT_MESSAGE },
      finishedAt: run.finishedAt || Date.now(),
    })
    result.suiteRuns += 1
  }

  // 2) 执行会话：在节点边界重建
  for (const row of store.listUnfinishedExecutions()) {
    try {
      const session = rebuildSession(row, io || silentIo)
      if (!session) {
        markUnrecoverable(row)
        result.unrecoverable.push(row.id)
        continue
      }
      sessions.set(row.id, session)
      result.restored.push(row.id)
      session.start().catch((err) => {
        console.error(`[recovery] 会话 ${row.id} 恢复失败：`, err)
      })
    } catch (err) {
      markUnrecoverable(row)
      result.errors.push({ id: row.id, message: err.message })
    }
  }

  if (result.restored.length || result.unrecoverable.length || result.suiteRuns) {
    console.log(
      `[recovery] 会话恢复：${result.restored.length} 个续跑 / ${result.unrecoverable.length} 个不可恢复 / ` +
        `${result.suiteRuns} 个套件运行收敛为 stopped`
    )
  }
  return result
}

/** 从落库记录重建会话；缺少流程快照时返回 null（由调用方标记不可恢复） */
export function rebuildSession(row, io) {
  const detail = store.getExecutionDetail(row.id)
  if (!detail || !Array.isArray(detail.nodes) || !detail.nodes.length) return null

  const steps = (detail.steps || []).map((step, i) => ({ ...step, seq: step.seq ?? i + 1 }))
  const snapshot = store.getExecutionResume(row.id) || { resume: null, lastSeq: 0 }
  const resume = snapshot.resume || {}

  // 中断的尝试：非终态步骤 → skipped 留证，节点重跑（不改历史行，只更新自己的 seq）
  const patched = steps.map((step) =>
    TERMINAL_STEP.has(step.status)
      ? step
      : {
          ...step,
          status: 'skipped',
          finishedAt: step.finishedAt || Date.now(),
          durationMs: step.durationMs ?? 0,
          error: step.error || ORPHAN_NOTE,
          failureClass: null,
          failureReason: null,
        }
  )
  for (const step of patched) {
    if (step.status === 'skipped' && step.error === ORPHAN_NOTE) store.saveExecutionStep(row.id, step)
  }

  // 已进入过执行的节点（含被打断的尝试）：用于「末尾未执行节点补 skipped」的判定，不代表完成
  const executed = new Set(Array.isArray(resume.executed) ? resume.executed : [])
  for (const step of patched) if (step.nodeId) executed.add(step.nodeId)

  // 真正有结论的节点：passed/failed + 条件跳过（无 error）。被打断的尝试不算完成，必须重跑
  const done = new Set(Array.isArray(resume.done) ? resume.done : [])
  for (const step of patched) {
    if (step.status === 'passed' || step.status === 'failed') done.add(step.nodeId)
    else if (step.status === 'skipped' && !step.error) done.add(step.nodeId)
  }

  // 待执行队列：快照里的 ready，剔除已完成节点（避免重复执行）
  const ready = (Array.isArray(resume.ready) ? resume.ready : []).filter(
    (id) => !done.has(id) && detail.nodes.some((n) => n.id === id)
  )

  const environment = resolveEnvOrSnapshot(row, detail)

  // 条件表达式依赖上一个响应：取最后一个有实际响应的步骤（已掩码，敏感值判断可能失真）
  const lastStep = [...patched].reverse().find((s) => s.actual && !s.actual.manual)
  const last = lastStep
    ? {
        status: lastStep.actual.status,
        data: lastStep.actual.data,
        headers: lastStep.actual.headers,
        durationMs: lastStep.actual.durationMs,
      }
    : null

  const maxStepSeq = patched.reduce((max, s) => Math.max(max, s.seq || 0), 0)
  const flow = {
    id: row.flowId,
    name: row.flowName || '（流程已删除）',
    type: row.flowType || 'blackbox',
    projectId: row.projectId || '',
    business: row.business || '',
    nodes: detail.nodes,
    edges: detail.edges,
    // 变量全部由快照还原（已含 flow + 环境 + extract 前缀），不重新合并环境变量
    variables: {},
  }

  return new RunSession(flow, io, {
    executionId: row.id,
    suiteRunId: row.suiteRunId || null,
    environment,
    startedAt: row.startedAt || undefined,
    resume: {
      eventSeq: Math.max(snapshot.lastSeq || 0, resume.eventSeq || 0),
      stepSeq: maxStepSeq,
      executed: [...executed],
      done: [...done],
      ready,
      vars: resume.vars || detail.vars || {},
      last,
      paused: resume.paused ?? row.status === 'paused',
      steps: patched,
    },
  })
}

/** 环境按 id 重新解密（secret 可用）；环境已删除时退回落库的公开快照 */
function resolveEnvOrSnapshot(row, detail) {
  if (row.envId) {
    try {
      return resolveEnvironment(row.envId)
    } catch (err) {
      console.warn(`[recovery] 环境 ${row.envId} 解析失败，使用执行时快照：${err.message}`)
    }
  }
  const snapshot = detail.environment
  return snapshot
    ? {
        id: snapshot.id,
        name: snapshot.name,
        version: snapshot.version,
        projectId: snapshot.projectId || null,
        baseUrl: snapshot.baseUrl || '',
        headers: snapshot.headers || {},
        variables: snapshot.variables || {},
        secretValues: [],
      }
    : null
}

/** 无法重建会话：把执行收敛为 stopped，未完成步骤记 skipped，保证计数自洽 */
function markUnrecoverable(row) {
  const detail = store.getExecutionDetail(row.id)
  const steps = (detail?.steps || []).map((step, i) => ({ ...step, seq: step.seq ?? i + 1 }))
  const patched = steps.map((step) =>
    TERMINAL_STEP.has(step.status)
      ? step
      : {
          ...step,
          status: 'skipped',
          finishedAt: step.finishedAt || Date.now(),
          durationMs: step.durationMs ?? 0,
          error: step.error || UNRECOVERABLE_NOTE,
          failureClass: null,
          failureReason: null,
        }
  )
  for (const step of patched) {
    if (step.status === 'skipped' && step.error === UNRECOVERABLE_NOTE) store.saveExecutionStep(row.id, step)
  }
  const finishedAt = Date.now()
  const passed = patched.filter((s) => s.status === 'passed').length
  const failed = patched.filter((s) => s.status === 'failed').length
  const skipped = patched.filter((s) => s.status === 'skipped').length
  store.saveExecutionMeta({
    id: row.id,
    status: 'stopped',
    finishedAt,
    summary: {
      status: 'stopped',
      total: patched.length,
      passed,
      failed,
      skipped,
      matchedAll: false,
      durationMs: finishedAt - (row.startedAt || finishedAt),
      message: UNRECOVERABLE_NOTE,
    },
  })
}
