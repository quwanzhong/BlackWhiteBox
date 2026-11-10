/**
 * JUnit XML 导出（M2-4 / docs/02 §9.2）。
 *
 * 约定：
 *   根 <testsuites>；每个 Flow = 一个 <testsuite>；每个 Node = 一个 <testcase>。
 *   failed → <failure type="<failureClass>">（正文是请求/响应/断言证据）；
 *   skipped / waiting / pending → <skipped message>，不计入 failures；
 *   套件导出额外写 <properties>（runId / 环境 / flaky / attempts）与 <system-out> 摘要。
 */
import { FAILURE_CLASS_LABELS } from '../classify.js'

const SKIPPED_STATUS = new Set(['skipped', 'waiting', 'pending', 'running'])

/** XML 1.0 非法控制字符 + 五个预定义实体 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const seconds = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(3)

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function attr(name, value) {
  return value === undefined || value === null || value === '' ? '' : ` ${name}="${escapeXml(value)}"`
}

function stepStats(steps) {
  const total = steps.length
  const failures = steps.filter((s) => s.status === 'failed').length
  const skipped = steps.filter((s) => SKIPPED_STATUS.has(s.status)).length
  const time = steps.reduce((sum, s) => sum + (Number(s.durationMs) || 0), 0)
  return { total, failures, skipped, time }
}

function failureBody(step) {
  const lines = []
  if (step.request) {
    lines.push(`请求：${step.request.method || 'GET'} ${step.request.url || ''}`)
  }
  if (step.actual) {
    lines.push(`响应：${step.actual.status ?? '—'}（${step.actual.durationMs ?? step.durationMs ?? 0} ms）`)
  }
  const diffs = (step.checks?.results || []).filter((c) => c && c.passed === false)
  if (diffs.length) {
    lines.push('失败断言：')
    for (const c of diffs) lines.push(`- ${c.path || c.label || c.type}：${c.message || ''}`)
  }
  if (step.actual?.manual === true) {
    lines.push(`人工确认：${step.actual.confirmed ? '通过' : '不通过'}${step.actual.note ? `（${step.actual.note}）` : ''}`)
  }
  if (step.error) lines.push(`错误：${step.error}`)
  if (step.failureClass) {
    lines.push(`归类：${FAILURE_CLASS_LABELS[step.failureClass] || step.failureClass}（${step.failureClass}）`)
  }
  if (step.actual?.data !== undefined) {
    lines.push(`响应体：${truncate(safeJson(step.actual.data), 2000)}`)
  }
  return lines.join('\n')
}

function skippedMessage(step) {
  if (step.status === 'waiting') return '等待人工确认（导出时仍未确认）'
  if (step.status === 'running') return '导出时仍在执行'
  if (step.status === 'pending') return '未执行'
  return step.error || step.failureReason || '前置节点失败或分支条件未命中，本步骤未执行'
}

function testcaseXml(step, flowName) {
  const head =
    `    <testcase${attr('classname', flowName)}${attr('name', step.nodeName || step.nodeId)}` +
    `${attr('time', seconds(step.durationMs))}>`
  if (step.status === 'failed') {
    const body = escapeXml(failureBody(step))
    return [
      head,
      `      <failure${attr('type', step.failureClass || 'script')}${attr('message', step.failureReason || step.error || '执行结果不符合预期')}>${body}</failure>`,
      '    </testcase>',
    ].join('\n')
  }
  if (SKIPPED_STATUS.has(step.status)) {
    return [`${head}`, `      <skipped${attr('message', skippedMessage(step))}/>`, '    </testcase>'].join('\n')
  }
  return `${head.slice(0, -1)}/>`
}

function propertiesXml(pairs) {
  const valid = pairs.filter(([, value]) => value !== undefined && value !== null && value !== '')
  if (!valid.length) return []
  return [
    '    <properties>',
    ...valid.map(([name, value]) => `      <property${attr('name', name)}${attr('value', value)}/>`),
    '    </properties>',
  ]
}

function flowMeta(execution, suiteRun) {
  const flow = suiteRun?.summary?.flows?.find((item) => item.flowId === execution.flowId)
  return {
    flaky: flow?.flaky ? 'true' : '',
    attempts: flow?.attempts && flow.attempts > 1 ? String(flow.attempts) : '',
    environment: execution.envId || suiteRun?.envId || '',
  }
}

function suiteXml(execution, { suiteRun = null } = {}) {
  const steps = Array.isArray(execution.steps) ? execution.steps : []
  const stats = stepStats(steps)
  const flowName = execution.flowName || execution.flowId
  const meta = flowMeta(execution, suiteRun)
  const startedAt = execution.startedAt ? new Date(execution.startedAt).toISOString() : undefined

  const props = propertiesXml([
    ['flow.id', execution.flowId],
    ['execution.id', execution.id],
    ['environment', meta.environment],
    ['flaky', meta.flaky],
    ['attempts', meta.attempts],
  ])

  const systemOut = [
    `状态：${execution.status}`,
    execution.summary?.message || '',
    `步骤：${stats.total}，失败：${stats.failures}，跳过：${stats.skipped}`,
    meta.flaky ? '重试后通过（flaky）' : '',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    `  <testsuite${attr('name', flowName)}${attr('tests', String(stats.total))}${attr('failures', String(stats.failures))}` +
      `${attr('errors', '0')}${attr('skipped', String(stats.skipped))}${attr('time', seconds(stats.time))}` +
      `${attr('timestamp', startedAt)}>`,
    ...props,
    ...steps.map((step) => testcaseXml(step, flowName)),
    `    <system-out>${escapeXml(systemOut)}</system-out>`,
    '  </testsuite>',
  ].join('\n')
}

/** 单条执行 → JUnit XML */
export function executionToJUnit(execution) {
  const steps = Array.isArray(execution.steps) ? execution.steps : []
  const stats = stepStats(steps)
  const name = execution.flowName || execution.flowId || 'execution'
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attr('name', name)}${attr('tests', String(stats.total))}${attr('failures', String(stats.failures))}` +
      `${attr('errors', '0')}${attr('skipped', String(stats.skipped))}${attr('time', seconds(stats.time))}>`,
    suiteXml(execution),
    '</testsuites>',
    '',
  ].join('\n')
}

/** 一次套件执行（N 条流程）→ JUnit XML */
export function suiteRunToJUnit({ suiteRun, executions = [] }) {
  const allSteps = executions.flatMap((execution) => execution.steps || [])
  const stats = stepStats(allSteps)
  const name = suiteRun.suiteName || suiteRun.suiteId || 'suite-run'
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attr('name', name)}${attr('tests', String(stats.total))}${attr('failures', String(stats.failures))}` +
      `${attr('errors', '0')}${attr('skipped', String(stats.skipped))}${attr('time', seconds(stats.time))}>`,
  ]
  const props = propertiesXml([
    ['suite.runId', suiteRun.id],
    ['suite.name', name],
    ['suite.status', suiteRun.status],
    ['environment', suiteRun.envId],
    ['flows', String(executions.length)],
  ])
  const suites = executions.map((execution) => suiteXml(execution, { suiteRun }))
  const summary = [
    `套件：${name}`,
    `状态：${suiteRun.status}`,
    suiteRun.summary?.message || '',
    `流程：${executions.length}，步骤：${stats.total}，失败：${stats.failures}，跳过：${stats.skipped}`,
  ]
    .filter(Boolean)
    .join('\n')

  return [
    ...head,
    '  <properties>',
    ...props.map((line) => `  ${line}`),
    '  </properties>',
    ...suites,
    `  <system-out>${escapeXml(summary)}</system-out>`,
    '</testsuites>',
    '',
  ].join('\n')
}
