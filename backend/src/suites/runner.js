import crypto from 'node:crypto'
import { store } from '../store.js'
import { RunSession } from '../engine/scheduler.js'
import { createQueue } from '../engine/queue.js'
import { sessions } from '../engine/registry.js'
import { normalizeStrategy, prepareRun } from './service.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** suiteRunId -> SuiteRunRunner（进行中的套件执行） */
const activeRuns = new Map()

const now = () => Date.now()
const terminal = new Set(['passed', 'failed', 'skipped', 'stopped'])

/**
 * 一次套件执行：把 Suite.flowIds 作为任务喂给进程内队列。
 *
 * 关键语义（与 docs/02 ADR-2、01 FR-5.3 对齐）：
 *  - concurrency：同一时刻最多 N 条 Flow 的 RunSession 在跑，变量域天然隔离；
 *  - failFast：某条 Flow 重试耗尽仍失败后，尚未开始的 Flow 统一 skipped（已在跑的让它跑完）；
 *  - retry：单条 Flow 失败后按 retryDelayMs 线性退避重试；重试后才通过记为 flaky；
 *  - stop：停止所有在跑的 Flow，队列里剩余任务在轮到时直接 skipped。
 */
class SuiteRunRunner {
  constructor({ run, flows, environment, io, variables }) {
    this.run = run
    this.flows = flows // [{ flowId, index, flow }]
    this.environment = environment
    this.io = io
    this.variables = variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}
    this.strategy = normalizeStrategy(run.strategy)
    this.results = flows.map((item) => ({
      flowId: item.flowId,
      flowName: item.flow?.name || '（流程已删除）',
      index: item.index,
      status: 'pending',
      executionId: null,
      attempts: 0,
      attemptExecutions: [],
      durationMs: 0,
      flaky: false,
      error: null,
      // M2-3：失败归类（取最后一次尝试的执行级归类）
      failureClass: null,
      failureReason: null,
      settled: false,
    }))
    this.flowSessions = new Map() // index -> RunSession
    this.queue = createQueue({ concurrency: this.strategy.concurrency })
    this.stopped = false
    this.failFastTriggered = false
    this.startedAt = null
    this.finishedAt = null
  }

  room() {
    return `suite:${this.run.id}`
  }

  emit(type, payload = {}) {
    const evt = { suiteRunId: this.run.id, type, payload, ts: now() }
    this.io?.to?.(this.room())?.emit?.('suite_event', evt)
    return evt
  }

  progress() {
    const counts = { total: this.results.length, done: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, running: 0 }
    for (const item of this.results) {
      if (terminal.has(item.status)) {
        counts.done += 1
        if (item.status === 'passed') counts.passed += 1
        if (item.status === 'failed') counts.failed += 1
        if (item.status === 'skipped') counts.skipped += 1
        if (item.flaky) counts.flaky += 1
      } else if (item.status === 'running') counts.running += 1
    }
    counts.percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0
    return counts
  }

  snapshot() {
    return {
      ...this.progress(),
      peakConcurrency: this.queue.peak,
      stopped: this.stopped,
      failFastTriggered: this.failFastTriggered,
      flows: this.results.map(({ settled: _settled, ...rest }) => rest),
    }
  }

  persist() {
    this.run.summary = this.snapshot()
    this.run.status = this.run.status || 'running'
    store.saveSuiteRun(this.run)
  }

  async start() {
    this.run.status = 'running'
    this.run.startedAt = now()
    this.startedAt = this.run.startedAt
    this.persist()
    this.emit('suite_start', {
      suiteId: this.run.suiteId,
      suiteName: this.run.suiteName,
      total: this.flows.length,
      strategy: this.strategy,
      flows: this.results.map((r) => ({ flowId: r.flowId, flowName: r.flowName, index: r.index })),
    })

    try {
      const tasks = this.flows.map((item) => this.queue.add(() => this.runFlow(item)))
      await Promise.allSettled(tasks)
    } finally {
      this.finish()
    }
    return this.run
  }

  async runFlow({ flow, index }) {
    const result = this.results[index]
    if (!result || result.settled) return result

    if (this.stopped) return this.skip(index, '套件已手动停止')
    if (this.failFastTriggered) return this.skip(index, '前序流程失败（failFast）')

    if (!flow) {
      // 套件定义里的流程被删了：不能静默少跑一条，直接判失败
      result.status = 'failed'
      result.error = '流程已删除'
      result.settled = true
      this.afterFlow(result, { message: '流程已删除，无法执行' })
      return result
    }

    result.status = 'running'
    const flowStarted = now()
    this.persist()
    this.emit('suite_progress', { ...this.progress(), flowId: result.flowId, flowName: result.flowName })

    const maxAttempts = this.strategy.retry + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.stopped) break
      result.attempts = attempt
      this.emit('suite_flow_start', {
        flowId: flow.id,
        flowName: flow.name,
        index,
        attempt,
        maxAttempts,
      })

      const session = new RunSession(flow, this.io, {
        variables: this.variables,
        environment: this.environment,
        suiteRunId: this.run.id,
      })
      this.flowSessions.set(index, session)
      sessions.set(session.executionId, session)
      try {
        await session.start()
      } finally {
        this.flowSessions.delete(index)
      }

      result.executionId = session.executionId
      result.attemptExecutions.push({
        executionId: session.executionId,
        status: session.status,
        durationMs: session.summary?.durationMs ?? null,
        failureClass: session.summary?.failureClass ?? null,
      })
      // 归类随最后一次尝试更新；重试后通过则最终不保留失败归类（flaky 单独标记）
      result.failureClass = session.summary?.failureClass ?? null
      result.failureReason = session.summary?.failureReason ?? null

      if (session.status === 'passed') break
      if (this.stopped) break
      if (attempt < maxAttempts) {
        const delay = this.strategy.retryDelayMs * attempt
        this.emit('suite_flow_retry', {
          flowId: flow.id,
          flowName: flow.name,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: delay,
          status: session.status,
        })
        if (delay > 0) await sleep(delay)
      }
    }

    result.durationMs = now() - flowStarted
    if (this.stopped && result.status === 'running') result.status = 'stopped'
    const last = result.attemptExecutions.at(-1)
    if (last) result.status = last.status === 'passed' ? 'passed' : last.status === 'stopped' ? 'stopped' : 'failed'
    result.flaky = result.status === 'passed' && result.attempts > 1
    result.settled = true

    this.afterFlow(result, {
      message: result.flaky
        ? `重试 ${result.attempts - 1} 次后通过（flaky）`
        : result.status === 'passed'
          ? '通过'
          : result.status === 'stopped'
            ? '已停止'
            : '未通过',
    })
    return result
  }

  skip(index, reason) {
    const result = this.results[index]
    if (!result || result.settled) return result
    result.status = 'skipped'
    result.error = reason
    result.settled = true
    this.afterFlow(result, { message: reason })
    return result
  }

  afterFlow(result, { message }) {
    if (result.status === 'failed' && this.strategy.failFast) this.failFastTriggered = true
    this.persist()
    this.emit('suite_flow_end', {
      flowId: result.flowId,
      flowName: result.flowName,
      executionId: result.executionId,
      status: result.status,
      attempts: result.attempts,
      flaky: result.flaky,
      durationMs: result.durationMs,
      error: result.error,
      failureClass: result.failureClass,
      failureReason: result.failureReason,
      message,
    })
    this.emit('suite_progress', this.progress())
  }

  finish() {
    if (this.finishedAt) return
    // 停止/异常时仍未结算的任务统一记为 skipped，保证 total = 各类计数之和
    for (const item of this.results) {
      if (!item.settled) {
        item.status = 'skipped'
        item.error = this.stopped ? '套件已手动停止' : '执行提前结束'
        item.settled = true
      }
    }
    this.finishedAt = now()
    const summary = this.snapshot()
    this.run.status = this.stopped
      ? 'stopped'
      : summary.failed > 0
        ? 'failed'
        : 'passed'
    this.run.summary = { ...summary, durationMs: this.finishedAt - this.startedAt }
    this.run.finishedAt = this.finishedAt
    this.persist()
    this.emit('suite_end', { status: this.run.status, summary: this.run.summary })
    activeRuns.delete(this.run.id)
  }

  stop() {
    if (this.finishedAt) return false
    this.stopped = true
    for (const session of this.flowSessions.values()) session.stop()
    return true
  }
}

/**
 * 创建并启动一次套件执行。HTTP 层拿到 suiteRunId 即可离开页面，进度走 WS + 查询接口。
 */
export function startSuiteRun({ suiteId, io, variables, environmentId }) {
  const { suite, flows, environment } = prepareRun(suiteId, { environmentId })
  const strategy = normalizeStrategy(suite.strategy)
  const run = {
    id: crypto.randomUUID(),
    suiteId: suite.id,
    suiteName: suite.name,
    projectId: suite.projectId,
    status: 'queued',
    strategy,
    envId: environment?.id || null,
    envVersion: environment?.version ?? null,
    summary: null,
    startedAt: null,
    finishedAt: null,
  }
  store.saveSuiteRun(run)

  const runner = new SuiteRunRunner({ run, flows, environment, io, variables })
  activeRuns.set(run.id, runner)
  runner.start().catch((err) => {
    console.error('[suite] 未捕获异常：', err)
    runner.finish()
  })
  return run
}

export function getSuiteRunner(suiteRunId) {
  return activeRuns.get(suiteRunId) || null
}

export function stopSuiteRun(suiteRunId) {
  const runner = activeRuns.get(suiteRunId)
  return runner ? runner.stop() : false
}

export function activeSuiteRunIds() {
  return [...activeRuns.keys()]
}
