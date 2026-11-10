import crypto from 'node:crypto'
import { store } from '../store.js'
import { executeNode } from './executor.js'
import { resolvePath, resolveTokens } from './jsonpath.js'
import { runChecks } from './validators.js'
import { sessions } from './registry.js'
import { evaluateCondition } from '../security/expression.js'
import { maskDeep } from '../environments/service.js'
import { classifyStep, classifyExecution } from '../reporting/classify.js'
import { createCoverageCollector } from '../coverage/collector.js'
import { createCoverageAnalyzer } from '../coverage/analyzer.js'
import {
  hasCoverageAssertions,
  evaluateCoverageAssertions,
} from '../coverage/assertions.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 一次流程执行会话：
 *  - 按流程图的边逐节点调度（支持条件分支、跳过、暂停/继续/停止）
 *  - 每个节点执行后做「实际输出 vs 理想输出」校验
 *  - 通过 WebSocket 实时推送事件，驱动前端发光动画
 */
export class RunSession {
  constructor(flow, io, opts = {}) {
    this.flow = flow
    this.io = io
    this.executionId = opts.executionId || crypto.randomUUID()
    // M2-2：套件执行时同时把事件广播到 suite:<suiteRunId>，套件页无需逐条订阅
    this.suiteRunId = opts.suiteRunId || null
    // 环境快照只保留可公开字段；secrets 明文由 resolveEnvironment() 合并进 variables
    this.environment = opts.environment
      ? {
          id: opts.environment.id,
          name: opts.environment.name,
          version: opts.environment.version,
          projectId: opts.environment.projectId || null,
          baseUrl: opts.environment.baseUrl || '',
          headers: opts.environment.headers || {},
          variables: opts.environment.variables || {},
          // 环境设置（M3-1：settings.coverage 决定本会话是否做覆盖率取证）。
          // 只含 host/port/timeout 等非敏感配置，可随执行上下文落库。
          settings: opts.environment.settings || {},
        }
      : null
    // 变量优先级（低 → 高）：flow.variables < Environment（含 secrets）
    //   < 执行时传入 variables < 运行中 extract（见 jsonpath/DSL §4）
    this.vars = {
      ...(flow.variables || {}),
      ...(this.environment?.variables || {}),
      ...(isPlainObject(opts.variables) ? opts.variables : {}),
    }
    this.defaultHeaders = this.environment?.headers || {}
    this.baseUrl = this.environment?.baseUrl || ''
    // 掩码用的明文值：只在内存，落库/事件/详情统一替换为 ***（S7）
    this.secretValues = (opts.environment?.secretValues || []).filter(
      (value) => typeof value === 'string' || typeof value === 'number'
    )
    this.steps = []
    this.events = []
    this.last = null // 上一个节点的响应（供条件表达式使用）
    this.status = 'running' // running | paused | passed | failed | stopped
    this.paused = false
    this.stopped = false
    this.startedAt = Date.now()
    this.finishedAt = null
    this.summary = null
    this.manualWaiters = new Map()
    this.nodeMap = new Map((flow.nodes || []).map((n) => [n.id, n]))
    this.executed = new Set()
    // M2-5：真正「跑完出结论」的节点（passed/failed/条件跳过）。恢复时待执行队列按它过滤，
    // 与 executed（已进入执行的节点，含进行中的人工确认）语义不同。
    this.done = new Set()
    // M1-2：步骤按行落库、事件攒批提交（20 条或 200 ms）
    this.stepSeq = 0
    this.pendingEvents = []
    this.flushTimer = null
    // M2-5：事件 seq 在会话内同步分配（WebSocket 与落库必须同号），也决定断线重放游标
    this.eventSeq = Number.isInteger(opts.resume?.eventSeq)
      ? opts.resume.eventSeq
      : store.getEventSeq(this.executionId) || 0
    this.currentReady = null
    this.resumed = Boolean(opts.resume)
    // M3-1：覆盖率采集器（未配置 settings.coverage 时为空实现，begin/end 均返回 null）。
    // 场景/单测可注入 collector，避免依赖真实 TCP agent。
    this.coverage =
      opts.coverageCollector ||
      createCoverageCollector({
        executionId: this.executionId,
        settings: opts.environment?.settings,
      })
    // M3-2：执行结束后异步把 .exec 解析成行级结果；场景/单测可注入 analyzer。
    // 默认分析器只在配置了 settings.coverage.classfiles 时才真正跑 jacococli。
    this.coverageAnalyzer =
      opts.coverageAnalyzer ||
      createCoverageAnalyzer({
        executionId: this.executionId,
        settings: opts.environment?.settings,
      })
    // M3-4：节点内已同步分析过的证据行。异步 run() 跳过它们，避免
    // 「步骤已判失败、徽标却被异步重试刷成已分析」这种结论不一致。
    this.syncedCoverage = new Set()
    if (Number.isInteger(opts.startedAt)) this.startedAt = opts.startedAt
    if (opts.resume) this.applyResume(opts.resume)
  }

  /**
   * M2-5：把落库的恢复快照灌回会话。
   * 只覆盖「进度」类状态（已执行节点 / 待执行队列 / 变量 / 步骤 / 事件游标），
   * 流程定义与环境仍以本次解析结果为准（环境按 envId 重新解密，保证 secret 可用）。
   */
  applyResume(resume) {
    if (Array.isArray(resume.steps)) this.steps = resume.steps
    if (Number.isInteger(resume.stepSeq)) this.stepSeq = resume.stepSeq
    if (Array.isArray(resume.executed)) this.executed = new Set(resume.executed)
    if (Array.isArray(resume.done)) {
      this.done = new Set(resume.done)
    } else if (Array.isArray(resume.steps)) {
      // 快照没有 done（老版本执行）时按步骤结论推导；被打断的尝试不算完成
      this.done = new Set(
        resume.steps
          .filter((s) => ['passed', 'failed'].includes(s.status) || (s.status === 'skipped' && !s.error))
          .map((s) => s.nodeId)
          .filter(Boolean)
      )
    }
    if (resume.vars && typeof resume.vars === 'object' && !Array.isArray(resume.vars)) {
      this.vars = { ...resume.vars }
      // 环境 secret 快照里是 ***：用本次重新解密的环境值补回，保证恢复后请求仍可用。
      // 其它变量（含 extract 恰好取到的 secret 明文）以快照为准，仍是 ***（S7 取舍）。
      const secrets = new Set((this.secretValues || []).map(String))
      const envVars = this.environment?.variables || {}
      for (const [key, value] of Object.entries(envVars)) {
        if (secrets.has(String(value)) && this.vars[key] === '***') this.vars[key] = value
      }
    }
    if (resume.last && typeof resume.last === 'object') this.last = resume.last
    if (Array.isArray(resume.ready)) this.currentReady = resume.ready
    if (resume.paused) {
      this.paused = true
      this.status = 'paused'
    }
  }

  room() {
    return `exec:${this.executionId}`
  }

  emit(type, payload = {}) {
    // 事件会进 WebSocket、落库、报告：统一先掩码，避免 secret 明文外泄。
    // M2-5：seq 在会话内同步分配，WS 与 execution_events 同号，前端据此去重与补洞。
    const evt = {
      v: 2,
      executionId: this.executionId,
      seq: ++this.eventSeq,
      type,
      payload: this.mask(payload),
      ts: Date.now(),
    }
    this.events.push(evt)
    this.pendingEvents.push(evt)
    this.scheduleFlush()
    this.io.to(this.room()).emit('exec_event', evt)
    if (this.suiteRunId) this.io.to(`suite:${this.suiteRunId}`).emit('exec_event', evt)
    return evt
  }

  /** secret 明文值掩码（递归，只替换字符串值） */
  mask(value) {
    return maskDeep(value, this.secretValues)
  }

  /** 环境快照（落库/展示用，永不含 secrets 明文） */
  envSnapshot() {
    if (!this.environment) return null
    return {
      ...this.environment,
      variables: this.mask(this.environment.variables),
      headers: this.mask(this.environment.headers),
    }
  }

  scheduleFlush() {
    if (this.pendingEvents.length >= 20) return this.flushEvents()
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushEvents()
    }, 200)
    this.flushTimer.unref?.()
  }

  /** 把待写事件一次性写入（seq 由 store 统一分配，保证严格自增） */
  flushEvents() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.pendingEvents.length) return
    const batch = this.pendingEvents.splice(0)
    try {
      store.appendExecutionEvents(this.executionId, batch)
    } catch (err) {
      console.error('[execution] 事件写入失败：', err)
    }
  }

  log(message, level = 'info') {
    this.emit('log', { level, message })
  }

  meta() {
    return {
      id: this.executionId,
      flowId: this.flow.id,
      flowName: this.flow.name,
      flowType: this.flow.type,
      projectId: this.flow.projectId || '',
      business: this.flow.business || '',
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      envId: this.environment?.id || null,
      envVersion: this.environment?.version ?? null,
      suiteRunId: this.suiteRunId,
      // M2-3：执行级失败归类投影列（写入时落库；老数据由读取端现算补齐）
      failureClass: this.summary?.failureClass ?? null,
      failureReason: this.summary?.failureReason ?? null,
      summary: this.summary,
    }
  }

  detail() {
    return {
      ...this.meta(),
      nodes: this.flow.nodes || [],
      edges: this.flow.edges || [],
      // seq 只服务于"同一节点覆盖同一行"，对外契约与落库后的 step 保持一致
      steps: this.steps.map(({ seq: _seq, ...step }) => this.mask(step)),
      events: this.events,
      vars: this.mask(this.vars),
      environment: this.envSnapshot(),
    }
  }

  /** 上下文（nodes/edges/vars/环境快照）只在开始/结束/停止时写，执行热路径不碰 */
  saveContext() {
    store.saveExecutionContext(this.executionId, {
      nodes: this.flow.nodes || [],
      edges: this.flow.edges || [],
      vars: this.mask(this.vars),
      environment: this.envSnapshot(),
    })
  }

  /** 步骤写库：创建与每次状态变化都调用，同一 seq 覆盖同一行（成本与历史长度无关） */
  saveStep(step) {
    if (!step.seq) step.seq = ++this.stepSeq
    // M2-3：归类基于掩码后的步骤（error 里可能带 URL 参数），原因与证据口径一致
    const classified = classifyStep(this.mask(step))
    if (classified) {
      step.failureClass = classified.failureClass
      step.failureReason = this.mask(classified.failureReason)
    } else {
      // 状态回退（如人工确认由 failed 改判通过）时不保留旧归类
      delete step.failureClass
      delete step.failureReason
    }
    store.saveExecutionStep(this.executionId, this.mask(step))
    return step
  }

  pushStep(step) {
    this.steps.push(step)
    this.saveStep(step)
    return step
  }

  saveMeta() {
    store.saveExecutionMeta(this.meta())
  }

  persist() {
    this.flushEvents()
  }

  /**
   * M2-5：会话恢复快照（节点边界覆盖写，体积只与节点数/变量数相关）。
   * vars 掩码落库：若 extract 恰好取到环境 secret 明文，恢复后为 ***，
   * 这是「明文不落盘」的一贯取舍（docs/02 §9.3）；普通业务变量完整还原。
   */
  saveResume() {
    store.saveExecutionResume(this.executionId, {
      eventSeq: this.eventSeq,
      stepSeq: this.stepSeq,
      executed: [...this.executed],
      done: [...this.done],
      ready: this.currentReady || [],
      vars: this.mask(this.vars),
      paused: this.status === 'paused',
      savedAt: Date.now(),
    })
  }

  async start() {
    store.saveExecutionMeta(this.meta())
    this.saveContext()
    if (this.resumed) {
      // 恢复不重放开场事件：flow_start 等历史已落库，前端回放即可重建画布；
      // 这里只补一条 flow_resume 让实时端知道会话换进程续跑了。
      this.emit('flow_resume', {
        flowId: this.flow.id,
        flowName: this.flow.name,
        nodes: (this.flow.nodes || []).map((n) => ({ id: n.id, name: n.name })),
        restoredNodes: this.executed.size,
        paused: this.status === 'paused',
        // 前端据此接续总耗时（续跑不是从 0 重新计时）
        startedAt: this.startedAt,
      })
      this.log(`检测到未完成会话，已从断点恢复（已完成 ${this.executed.size} 个节点）`, 'warn')
    } else {
      this.emit('flow_start', {
        flowId: this.flow.id,
        flowName: this.flow.name,
        nodes: (this.flow.nodes || []).map((n) => ({ id: n.id, name: n.name })),
        // 前端据此显示「已执行 N s」，断线回放时也能还原真实起点
        startedAt: this.startedAt,
      })
      this.log(
        `流程「${this.flow.name}」开始执行（${(this.flow.nodes || []).length} 个节点，${
          this.flow.type === 'whitebox' ? '白盒' : '黑盒'
        }流程）`
      )
    }
    try {
      await this.runLoop()
    } catch (e) {
      this.log(`执行异常：${e.message}`, 'error')
    }
    this.finish()
  }

  async waitIfPaused() {
    while (this.paused && !this.stopped) await sleep(200)
  }

  async runLoop() {
    const nodes = this.flow.nodes || []
    const edges = this.flow.edges || []
    if (!nodes.length) {
      this.log('流程没有节点，无法执行', 'error')
      this.stopped = true
      return
    }

    // 计算入口节点（无入边的节点）
    let ready
    if (this.resumed) {
      // M2-5：按落库的「待执行队列」续跑；快照缺失时退回「已执行节点之后的前沿」
      const saved = (this.currentReady || []).filter((id) => this.nodeMap.has(id) && !this.done.has(id))
      ready = saved.length ? saved : this.frontier(nodes, edges)
    } else {
      const indeg = new Map(nodes.map((n) => [n.id, 0]))
      for (const e of edges) if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1)
      ready = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id)
      if (!ready.length) ready = [nodes[0].id]
    }

    while (ready.length && !this.stopped) {
      // 每轮开始快照：此刻的 ready 就是「断点」——进程挂掉后从这里续跑
      this.currentReady = [...ready]
      this.saveResume()
      const next = new Set()
      for (const nodeId of ready) {
        if (this.stopped) break
        await this.waitIfPaused()
        if (this.stopped) break

        const passed = await this.runNode(nodeId)
        if (!passed) continue

        for (const e of edges.filter((e) => e.from === nodeId)) {
          const ok = !e.condition || this.evalCondition(e.condition)
          if (ok) next.add(e.to)
          else {
            this.log(
              `分支条件不满足，跳过「${this.nodeMap.get(e.to)?.name || e.to}」：${e.condition}`,
              'warn'
            )
          }
        }
      }
      ready = [...next].filter((id) => !this.executed.has(id))
    }

    // 未执行到的节点统一标记为跳过
    for (const n of nodes) {
      if (!this.executed.has(n.id)) {
        const step = this.pushStep({
          id: crypto.randomUUID(),
          nodeId: n.id,
          nodeName: n.name,
          status: 'skipped',
          startedAt: null,
          finishedAt: null,
          durationMs: 0,
        })
        this.emit('step_end', {
          nodeId: n.id,
          nodeName: n.name,
          status: 'skipped',
          failureClass: step.failureClass || null,
          failureReason: step.failureReason || null,
        })
        this.done.add(n.id)
      }
    }
  }

  /**
   * M2-5：快照缺失时的恢复前沿 —— 未执行、且「入口」或「已有前驱执行过」的节点。
   * 只用于老版本执行（无 resume_json）或极窄的写入窗口，正常路径走 currentReady。
   */
  frontier(nodes, edges) {
    const preds = new Map(nodes.map((n) => [n.id, []]))
    for (const e of edges) if (preds.has(e.to)) preds.get(e.to).push(e.from)
    const candidates = nodes
      .filter((n) => !this.done.has(n.id))
      .filter((n) => {
        const incoming = preds.get(n.id) || []
        return incoming.length === 0 || incoming.some((from) => this.done.has(from))
      })
      .map((n) => n.id)
    return candidates.length ? candidates : nodes.filter((n) => !this.done.has(n.id)).map((n) => n.id)
  }

  async runNode(nodeId) {
    const node = this.nodeMap.get(nodeId)
    if (!node) return false
    this.executed.add(nodeId)

    const step = {
      id: crypto.randomUUID(),
      nodeId,
      nodeName: node.name,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      request: null,
      actual: null,
      expected: node.expected || null,
      checks: null,
      extracted: null,
      error: null,
    }
    this.pushStep(step)
    this.emit('step_start', { nodeId, nodeName: node.name, stepId: step.id })
    this.log(`▶ 开始执行：${node.name}`)

    try {
      if ((node.action?.type || 'http') === 'manual') {
        // 白盒 / 人工步骤：暂停等待测试人员确认
        step.status = 'waiting'
        // 先注册 waiter 再落库/广播：客户端一旦看到 waiting 或收到 manual_wait，
        // 立刻点「确认」也必须能命中（否则确认丢失、会话悬停）
        const confirmed = this.waitManual(nodeId)
        this.saveStep(step)
        this.persist()
        this.emit('manual_wait', {
          nodeId,
          nodeName: node.name,
          hint: node.action?.hint || '请人工确认该步骤的执行结果',
        })
        this.log(`⏸ 等待人工确认：${node.name}`, 'warn')
        const { pass, note } = await confirmed
        step.actual = { manual: true, confirmed: !!pass, note: note || '' }
        step.checks = {
          matched: !!pass,
          results: [
            {
              type: 'manual',
              label: '人工确认',
              path: '',
              op: 'eq',
              value: true,
              actual: !!pass,
              passed: !!pass,
              message: pass ? '人工确认通过' : `人工确认不通过：${note || '无备注'}`,
            },
          ],
        }
        step.status = pass ? 'passed' : 'failed'
        this.rejectManualCoverageAssertions(node, step)
      } else {
        // M3-1：节点前 reset、节点后 dumpAndReset；采集失败只降级，不影响节点结论。
        // collector 本身已吞异常，这里再兜一层：观测能力绝不能把执行带崩。
        try {
          await this.coverage.begin(nodeId)
        } catch (err) {
          this.log(`覆盖率采集开始失败：${err.message}`, 'warn')
        }
        try {
          const result = await executeNode(node, {
            vars: this.vars,
            last: this.last,
            baseUrl: this.baseUrl,
            defaultHeaders: this.defaultHeaders,
          })
          step.request = result.request
          step.actual = {
            status: result.status,
            data: result.data,
            headers: result.headers,
            durationMs: result.durationMs,
          }
          step.checks = runChecks(node.expected, result)

          // 变量提取：把响应里的值存进变量表，供后续节点 {{var}} 使用
          const extracted = {}
          for (const [name, path] of Object.entries(node.extract || {})) {
            extracted[name] = resolvePath(result.data, path)
            if (extracted[name] !== undefined) this.vars[name] = extracted[name]
          }
          step.extracted = extracted
          if (Object.keys(extracted).length) {
            this.log(
              `提取变量：${Object.entries(extracted)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join('，')}`
            )
          }
          this.last = result
          step.status = step.checks.matched ? 'passed' : 'failed'
        } finally {
          // 请求抛错也要取数：失败请求本身可能已走到部分源码行，是排障证据
          let coverage = null
          try {
            coverage = await this.coverage.end(nodeId)
          } catch (err) {
            this.log(`覆盖率取证失败：${err.message}`, 'warn')
          }
          if (coverage) {
            step.coverageId = coverage.id
            step.coverage = coverage
            // pending=true 表示原始 .exec 已拿到、M3-2 才解析成行覆盖
            this.emit('coverage.dump', {
              nodeId,
              nodeName: node.name,
              coverageId: coverage.id,
              source: coverage.source,
              mode: coverage.mode,
              status: coverage.status,
              bytes: coverage.bytes,
              error: coverage.error,
              pending: coverage.pending,
            })
          }
          // M3-4：声明了白盒断言的节点在此同步分析 + 判定（未声明则保持异步分析）
          await this.applyCoverageAssertions(node, step)
        }
      }
    } catch (err) {
      step.status = 'failed'
      step.error = err.message
      step.request = err.request || null
    }

    step.finishedAt = Date.now()
    step.durationMs = step.finishedAt - (step.startedAt || step.finishedAt)
    step.failureClass = null
    step.failureReason = null
    const classified = classifyStep(this.mask(step))
    if (classified) {
      step.failureClass = classified.failureClass
      step.failureReason = this.mask(classified.failureReason)
    }

    this.emit('step_end', {
      nodeId,
      nodeName: node.name,
      status: step.status,
      durationMs: step.durationMs,
      checks: step.checks,
      actual: step.actual,
      request: step.request,
      error: step.error,
      extracted: step.extracted,
      // M3-1：覆盖率取证结果（status=captured 时 pending=true，等待 M3-2 解析）
      coverage: step.coverage || null,
      // M2-3：实时通道直接带归类，前端不必再拉详情
      failureClass: step.failureClass,
      failureReason: step.failureReason,
    })
    this.log(
      step.status === 'passed'
        ? `✔ 通过：${node.name}`
        : `✘ 未通过：${node.name}${step.error ? `（${step.error}）` : ''}`,
      step.status === 'passed' ? 'success' : 'error'
    )
    this.saveStep(step)
    this.persist()
    // 完成判定：passed/failed 都算「有结论」，恢复时不再重跑；skipped/中断的尝试另算
    if (step.status === 'passed' || step.status === 'failed') this.done.add(nodeId)
    // M2-5：节点边界 = 恢复点。此时「已执行」已含当前节点、ready 由下一轮循环刷新
    this.saveResume()
    return step.status === 'passed'
  }

  /**
   * M3-4：把覆盖率断言结果并进节点的 checks。
   * 失败只能把节点从 passed 拉到 failed，不能反向「洗白」已失败的节点。
   */
  mergeCoverageChecks(step, checks) {
    if (!checks.length) return
    const results = [...(step.checks?.results || []), ...checks]
    const allPassed = results.every((c) => c.passed)
    // 只有原本就通过、且断言全绿才算 matched；请求抛错等「无 checks」的失败不会被洗白
    step.checks = { matched: allPassed && step.status === 'passed', results }
    if (!allPassed) step.status = 'failed'
  }

  /**
   * M3-4：节点内白盒判定。
   * 只有声明了 `expected.coverage` 才同步分析——未声明断言的节点保持原来的异步分析，
   * 不增加正常黑盒执行的延迟。
   *
   * 证据不可用也判失败（`coverage_evidence`），绝不静默通过：
   * 用户既然声明了「应命中 X」，就不能在没跑分析时把结论当通过。
   */
  async applyCoverageAssertions(node, step) {
    if (!hasCoverageAssertions(node.expected)) return null
    const startedAt = Date.now()
    let analysis
    if (step.coverageId) {
      try {
        analysis = await this.coverageAnalyzer.analyzeOne(step.coverageId)
      } catch (err) {
        // analyzeOne 自身已收敛异常；这里兜底，观测能力不能带崩执行
        analysis = {
          status: 'unavailable',
          reason: 'ANALYZE_ERROR',
          error: err?.message || String(err),
          result: null,
        }
      }
      if (analysis.status === 'analyzed' || analysis.status === 'analysis_failed') {
        // 同步判定过的行不再交给 finish() 的异步重试
        this.syncedCoverage.add(step.coverageId)
        step.coverage = {
          ...(step.coverage || {}),
          status: analysis.status === 'analyzed' ? 'analyzed' : 'captured',
          error: analysis.error || null,
          pending: false,
        }
        this.emitCoverageAnalyzed({
          executionId: this.executionId,
          analyzed: analysis.status === 'analyzed' ? 1 : 0,
          failed: analysis.status === 'analysis_failed' ? 1 : 0,
          skipped: 0,
          total: 1,
          durationMs: Date.now() - startedAt,
          results: [
            {
              coverageId: step.coverageId,
              nodeId: step.nodeId,
              status: analysis.status,
              covered: analysis.result?.totals?.covered,
              missed: analysis.result?.totals?.missed,
              total: analysis.result?.totals?.total,
              lineRate: analysis.result?.totals?.lineRate,
              files: analysis.result?.totals?.files,
              classes: analysis.result?.totals?.classes,
              error: analysis.error || null,
            },
          ],
        })
      }
    } else {
      // 没有证据行：要么没配采集，要么采集器在 begin 阶段就没拿到配置
      analysis = {
        status: 'disabled',
        reason: 'NO_EVIDENCE_ROW',
        error: step.coverage?.error || null,
        result: null,
      }
    }
    this.mergeCoverageChecks(step, evaluateCoverageAssertions(node.expected, analysis))
    return analysis
  }

  /**
   * M3-4：人工节点不采集覆盖率——声明了断言就必须判失败，
   * 不能因为「人工点了通过」就把未验证的白盒断言当成通过。
   */
  rejectManualCoverageAssertions(node, step) {
    if (!hasCoverageAssertions(node.expected)) return
    this.mergeCoverageChecks(step, [
      {
        type: 'coverage_evidence',
        label: '覆盖率断言',
        path: '',
        op: 'exists',
        value: true,
        actual: '人工节点',
        passed: false,
        message: '人工节点不支持覆盖率断言：覆盖率证据只在 HTTP 节点按 reset/dump 采集',
      },
    ])
  }

  /**
   * 条件表达式求值：支持 $.code == 0 && $.data.ok 这类写法。
   * M1-3 起走受限求值器（security/expression.js），不再使用 new Function：
   * 流程数据里写 process.exit() 只会得到一个解析错误，不会执行。
   */
  evalCondition(expr) {
    try {
      return evaluateCondition(expr, {
        vars: this.vars,
        path: (tokens) => resolveTokens(this.last?.data, tokens),
      })
    } catch (e) {
      this.log(`条件表达式解析失败：${expr}（${e.message}）`, 'warn')
      return false
    }
  }

  waitManual(nodeId) {
    return new Promise((resolve) => this.manualWaiters.set(nodeId, resolve))
  }

  confirmManual(nodeId, pass, note) {
    const resolver = this.manualWaiters.get(nodeId)
    if (!resolver) return false
    this.manualWaiters.delete(nodeId)
    resolver({ pass: !!pass, note: note || '' })
    return true
  }

  pause() {
    if (this.status !== 'running') return false
    this.paused = true
    this.status = 'paused'
    this.emit('paused', {})
    this.log('⏸ 执行已暂停', 'warn')
    this.saveMeta()
    this.persist()
    this.saveResume()
    return true
  }

  resume() {
    if (this.status !== 'paused') return false
    this.paused = false
    this.status = 'running'
    this.emit('resumed', {})
    this.log('▶ 执行已恢复')
    this.saveMeta()
    this.persist()
    this.saveResume()
    return true
  }

  stop() {
    if (!['running', 'paused'].includes(this.status)) return false
    this.stopped = true
    this.paused = false
    this.status = 'stopped'
    this.emit('stopped', {})
    this.log('⏹ 执行已停止', 'warn')
    for (const [, resolver] of this.manualWaiters) {
      resolver({ pass: false, note: '执行已手动停止' })
    }
    this.manualWaiters.clear()
    this.saveContext()
    this.saveMeta()
    this.persist()
    this.saveResume()
    return true
  }

  finish() {
    const steps = this.steps
    const passed = steps.filter((s) => s.status === 'passed').length
    const failed = steps.filter((s) => s.status === 'failed').length
    const skipped = steps.filter((s) => s.status === 'skipped').length
    const executed = steps.filter((s) => s.status === 'passed' || s.status === 'failed')
    const matchedAll = failed === 0 && executed.every((s) => s.checks?.matched !== false)

    this.status = this.stopped && this.status === 'stopped' ? 'stopped' : failed > 0 ? 'failed' : 'passed'
    this.finishedAt = Date.now()
    this.summary = {
      status: this.status,
      total: steps.length,
      passed,
      failed,
      skipped,
      matchedAll,
      durationMs: this.finishedAt - this.startedAt,
      message:
        this.status === 'stopped'
          ? '执行被手动停止'
          : failed > 0
            ? `存在 ${failed} 个未通过步骤，实际输出与理想输出不一致`
            : matchedAll
              ? '所有实际输出均符合流程理想输出'
              : '步骤执行通过，但存在输出不匹配项',
    }
    // M2-3：执行级归类 = 失败步骤里第一条的类别 + 全量计数（供报告列表/详情/导出直接用）
    const rollup = classifyExecution(steps, { status: this.status })
    this.summary.failureClass = rollup.failureClass
    this.summary.failureReason = this.mask(rollup.failureReason)
    this.summary.failureClasses = rollup.counts
    this.saveContext() // 响应提取出的变量在结束时一并落库（与旧 JSON 行为一致）
    this.saveMeta()
    this.emit('flow_end', { status: this.status, summary: this.summary })
    this.persist()
    // M3-1：会话结束释放 agent 连接（collector 内部已吞掉关闭异常）
    this.coverage.close().catch(() => {})
    // M3-2：分析必须在 flow_end 之后异步执行，不能拖住执行结论；
    // `this.analysis` 暴露给场景/单测等待，生产代码不 await。
    this.analysis = this.analyzeCoverage()
    sessions.delete(this.executionId)
  }

  /**
   * 把本次执行的 captured 快照批量解析成行级覆盖率。
   * 分析结果通过 `coverage.analyzed` 补发一条事件（此时 flow_end 已落库），
   * 前端收到后重拉 `/coverage` 即可，不要求事件里带完整 files[]。
   */
  analyzeCoverage() {
    if (!this.coverageAnalyzer?.run) return Promise.resolve(null)
    return Promise.resolve()
      .then(() => this.coverageAnalyzer.run({ skipIds: this.syncedCoverage }))
      .then((summary) => {
        // classfiles 未配置 / 没有待分析证据时不发事件：行继续显示 pending=true
        if (summary && summary.total > 0 && !summary.reason) {
          this.emitCoverageAnalyzed(summary)
        }
        return summary
      })
      .catch((err) => {
        this.log(`覆盖率分析失败：${err?.message || err}`, 'warn')
        this.persist()
        return null
      })
  }

  emitCoverageAnalyzed(summary) {
    this.emit('coverage.analyzed', {
      executionId: summary.executionId,
      analyzed: summary.analyzed,
      failed: summary.failed,
      skipped: summary.skipped,
      total: summary.total,
      durationMs: summary.durationMs,
      coverage: summary.results,
    })
    this.flushEvents()
  }
}
