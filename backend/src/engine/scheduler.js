import crypto from 'node:crypto'
import { store } from '../store.js'
import { executeNode } from './executor.js'
import { resolvePath } from './jsonpath.js'
import { runChecks } from './validators.js'
import { sessions } from './registry.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    this.vars = { ...(flow.variables || {}), ...(opts.variables || {}) }
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
  }

  room() {
    return `exec:${this.executionId}`
  }

  emit(type, payload = {}) {
    const evt = { executionId: this.executionId, type, payload, ts: Date.now() }
    this.events.push(evt)
    this.io.to(this.room()).emit('exec_event', evt)
    return evt
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
      summary: this.summary,
    }
  }

  detail() {
    return {
      ...this.meta(),
      nodes: this.flow.nodes || [],
      edges: this.flow.edges || [],
      steps: this.steps,
      events: this.events,
      vars: this.vars,
    }
  }

  persist() {
    store.saveExecutionDetail(this.detail())
    store.saveExecutionMeta(this.meta())
  }

  async start() {
    store.saveExecutionMeta(this.meta())
    this.persist()
    this.emit('flow_start', {
      flowId: this.flow.id,
      flowName: this.flow.name,
      nodes: (this.flow.nodes || []).map((n) => ({ id: n.id, name: n.name })),
    })
    this.log(
      `流程「${this.flow.name}」开始执行（${(this.flow.nodes || []).length} 个节点，${
        this.flow.type === 'whitebox' ? '白盒' : '黑盒'
      }流程）`
    )
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
    const indeg = new Map(nodes.map((n) => [n.id, 0]))
    for (const e of edges) if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1)
    let ready = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id)
    if (!ready.length) ready = [nodes[0].id]

    while (ready.length && !this.stopped) {
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
        this.steps.push({
          id: crypto.randomUUID(),
          nodeId: n.id,
          nodeName: n.name,
          status: 'skipped',
          startedAt: null,
          finishedAt: null,
          durationMs: 0,
        })
        this.emit('step_end', { nodeId: n.id, nodeName: n.name, status: 'skipped' })
      }
    }
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
    this.steps.push(step)
    this.emit('step_start', { nodeId, nodeName: node.name, stepId: step.id })
    this.log(`▶ 开始执行：${node.name}`)

    try {
      if ((node.action?.type || 'http') === 'manual') {
        // 白盒 / 人工步骤：暂停等待测试人员确认
        step.status = 'waiting'
        this.persist()
        this.emit('manual_wait', {
          nodeId,
          nodeName: node.name,
          hint: node.action?.hint || '请人工确认该步骤的执行结果',
        })
        this.log(`⏸ 等待人工确认：${node.name}`, 'warn')
        const { pass, note } = await this.waitManual(nodeId)
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
      } else {
        const result = await executeNode(node, { vars: this.vars, last: this.last })
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
      }
    } catch (err) {
      step.status = 'failed'
      step.error = err.message
      step.request = err.request || null
    }

    step.finishedAt = Date.now()
    step.durationMs = step.finishedAt - (step.startedAt || step.finishedAt)

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
    })
    this.log(
      step.status === 'passed'
        ? `✔ 通过：${node.name}`
        : `✘ 未通过：${node.name}${step.error ? `（${step.error}）` : ''}`,
      step.status === 'passed' ? 'success' : 'error'
    )
    this.persist()
    return step.status === 'passed'
  }

  /** 条件表达式求值：支持 $.code == 0 && $.data.ok 这类写法 */
  evalCondition(expr) {
    try {
      const jsExpr = String(expr)
        .replace(/\$\.([A-Za-z0-9_.\[\]'"-]+)/g, (_m, p) => `__p('$.${p}')`)
        .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => JSON.stringify(this.vars[k]))
      const fn = new Function('__p', `"use strict"; return (${jsExpr});`)
      return !!fn((p) => (this.last ? resolvePath(this.last.data, p) : undefined))
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
    this.persist()
    return true
  }

  resume() {
    if (this.status !== 'paused') return false
    this.paused = false
    this.status = 'running'
    this.emit('resumed', {})
    this.log('▶ 执行已恢复')
    this.persist()
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
    this.persist()
    this.emit('flow_end', { status: this.status, summary: this.summary })
    sessions.delete(this.executionId)
  }
}
