/**
 * HTML 导出（M2-4 / docs/02 §9.2）。
 *
 * 单文件、内联 CSS、零外链：不引 CSS/JS/字体/图片，双击即可离线打开或作为附件发给别人。
 * 所有动态文本都经 escapeHtml，避免报告内容把页面结构撑破（也顺带防注入）。
 */
import { FAILURE_CLASS_LABELS } from '../classify.js'

const STATUS_LABEL = {
  passed: '通过',
  failed: '未通过',
  skipped: '跳过',
  waiting: '等待确认',
  running: '执行中',
  pending: '待执行',
  stopped: '已停止',
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px; background: #f5f7fa; color: #1f2937;
  font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; }
.page { max-width: 1080px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 0 0 12px; font-size: 16px; }
.muted { color: #6b7280; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: #4b5563; margin-top: 6px; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
.card { flex: 1 1 130px; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; }
.card .k { font-size: 12px; color: #6b7280; }
.card .v { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.card.ok .v { color: #15803d; } .card.bad .v { color: #b91c1c; } .card.skip .v { color: #6b7280; }
.block { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
.badge { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 20px; border: 1px solid transparent; }
.badge.passed { color: #15803d; background: #dcfce7; border-color: #bbf7d0; }
.badge.failed { color: #b91c1c; background: #fee2e2; border-color: #fecaca; }
.badge.skipped, .badge.pending { color: #4b5563; background: #f3f4f6; border-color: #e5e7eb; }
.badge.waiting, .badge.running { color: #b45309; background: #fef3c7; border-color: #fde68a; }
.badge.stopped { color: #6b7280; background: #f3f4f6; border-color: #e5e7eb; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
th { color: #6b7280; font-weight: 500; background: #fafbfc; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.fail-list { margin: 0; padding-left: 18px; }
.fail-list li { margin: 2px 0; }
details.step { border: 1px solid #eef0f3; border-radius: 8px; padding: 8px 12px; margin: 8px 0; background: #fcfcfd; }
details.step > summary { cursor: pointer; color: #374151; }
pre { margin: 6px 0 10px; padding: 10px; background: #0f172a; color: #e2e8f0; border-radius: 8px;
  overflow: auto; max-height: 360px; font-size: 12px; line-height: 1.5; }
.kv { margin: 6px 0; }
.kv b { color: #374151; }
.err { color: #b91c1c; white-space: pre-wrap; }
footer { margin-top: 24px; font-size: 12px; color: #9ca3af; }
@media print { body { background: #fff; padding: 0; } .block, .card { break-inside: avoid; } pre { max-height: none; } }
`

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function pretty(value) {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
}

function fmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`
}

function badge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] || status || '—')}</span>`
}

function stepStats(steps) {
  const count = (status) => steps.filter((s) => s.status === status).length
  return {
    total: steps.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: steps.filter((s) => ['skipped', 'waiting', 'pending', 'running'].includes(s.status)).length,
    durationMs: steps.reduce((sum, s) => sum + (Number(s.durationMs) || 0), 0),
  }
}

function cards(stats, extra = []) {
  const items = [
    ['步骤总数', stats.total, ''],
    ['通过', stats.passed, 'ok'],
    ['未通过', stats.failed, stats.failed ? 'bad' : ''],
    ['跳过', stats.skipped, 'skip'],
    ['耗时', fmtDuration(stats.durationMs), ''],
    ...extra,
  ]
  return `<div class="cards">${items
    .map(([k, v, cls]) => `<div class="card ${cls}"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`)
    .join('')}</div>`
}

function classCounts(counts) {
  const rows = Object.entries(counts || {}).filter(([, n]) => n > 0)
  if (!rows.length) return '<p class="muted">无失败步骤。</p>'
  return `<table><thead><tr><th>失败归类</th><th>标识</th><th>步骤数</th></tr></thead><tbody>${rows
    .map(
      ([cls, n]) =>
        `<tr><td>${escapeHtml(FAILURE_CLASS_LABELS[cls] || cls)}</td><td class="muted">${escapeHtml(cls)}</td><td class="num">${escapeHtml(n)}</td></tr>`
    )
    .join('')}</tbody></table>`
}

function failureList(steps) {
  const failed = steps.filter((s) => s.status === 'failed')
  if (!failed.length) return '<p class="muted">全部通过。</p>'
  return `<ul class="fail-list">${failed
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.nodeName || s.nodeId)}</b>` +
        `${s.failureClass ? ` · ${escapeHtml(FAILURE_CLASS_LABELS[s.failureClass] || s.failureClass)}` : ''}` +
        `${s.failureReason ? `：${escapeHtml(s.failureReason)}` : ''}</li>`
    )
    .join('')}</ul>`
}

function stepDetails(step) {
  const parts = []
  if (step.request) {
    parts.push(
      `<div class="kv"><b>请求：</b>${escapeHtml(step.request.method || 'GET')} ${escapeHtml(step.request.url || '')}</div>`
    )
    if (step.request.body !== undefined && step.request.body !== null) {
      parts.push(`<pre>${escapeHtml(pretty(step.request.body))}</pre>`)
    }
  }
  if (step.actual) {
    parts.push(
      `<div class="kv"><b>响应：</b>${escapeHtml(step.actual.status ?? '—')} · ${escapeHtml(fmtDuration(step.actual.durationMs ?? step.durationMs))}</div>`
    )
    parts.push(`<pre>${escapeHtml(pretty(step.actual.data ?? step.actual))}</pre>`)
  }
  if (step.expected) parts.push(`<div class="kv"><b>理想输出：</b></div><pre>${escapeHtml(pretty(step.expected))}</pre>`)
  const checks = step.checks?.results || []
  if (checks.length) {
    parts.push(
      `<table><thead><tr><th>断言</th><th>期望</th><th>实际</th><th>结果</th></tr></thead><tbody>${checks
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.path || c.label || c.type)}</td><td>${escapeHtml(pretty(c.value))}</td>` +
            `<td>${escapeHtml(pretty(c.actual))}</td><td>${c.passed ? '✔' : '✘'}</td></tr>`
        )
        .join('')}</tbody></table>`
    )
  }
  if (step.error) parts.push(`<div class="kv err">${escapeHtml(step.error)}</div>`)
  const label = `${escapeHtml(step.nodeName || step.nodeId)} ${badge(step.status)}` +
    (step.failureClass ? ` <span class="muted">${escapeHtml(FAILURE_CLASS_LABELS[step.failureClass] || step.failureClass)}</span>` : '') +
    ` <span class="muted">${escapeHtml(fmtDuration(step.durationMs))}</span>`
  return `<details class="step"><summary>${label}</summary>${parts.join('')}</details>`
}

function stepsTable(steps) {
  if (!steps.length) return '<p class="muted">没有步骤记录。</p>'
  return `<table><thead><tr><th>#</th><th>步骤</th><th>状态</th><th>失败归类</th><th>耗时</th><th>输出匹对</th></tr></thead><tbody>${steps
    .map(
      (s, i) =>
        `<tr><td class="num">${i + 1}</td><td>${escapeHtml(s.nodeName || s.nodeId)}</td><td>${badge(s.status)}</td>` +
        `<td>${s.failureClass ? escapeHtml(FAILURE_CLASS_LABELS[s.failureClass] || s.failureClass) : '—'}</td>` +
        `<td class="num">${escapeHtml(fmtDuration(s.durationMs))}</td>` +
        `<td>${s.checks ? (s.checks.matched ? '✔ 符合' : '✘ 不匹配') : '—'}</td></tr>`
    )
    .join('')}</tbody></table>`
}

function shell({ title, subtitle, body, generatedAt }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>黑百盒报告 · ${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<h1>${escapeHtml(title)}</h1>
<div class="meta">${subtitle}</div>
${body}
<footer>由黑百盒导出 · ${escapeHtml(fmtTime(generatedAt))} · 请求头/URL 敏感参数/请求体敏感键与响应头已脱敏（响应体保留原样，供复盘证据）</footer>
</div>
</body>
</html>
`
}

function executionBody(execution) {
  const steps = Array.isArray(execution.steps) ? execution.steps : []
  const stats = stepStats(steps)
  const counts = execution.summary?.failureClasses || {}
  const extra = execution.failureClass
    ? [['主归类', FAILURE_CLASS_LABELS[execution.failureClass] || execution.failureClass, 'bad']]
    : []
  return [
    cards(stats, extra),
    `<div class="block"><h2>结论</h2><p>${escapeHtml(execution.summary?.message || '—')}</p>${failureList(steps)}</div>`,
    `<div class="block"><h2>失败归类计数</h2>${classCounts(counts)}</div>`,
    `<div class="block"><h2>步骤明细</h2>${stepsTable(steps)}${steps.map(stepDetails).join('')}</div>`,
  ].join('\n')
}

/** 单条执行 → 单文件 HTML */
export function executionToHtml(execution, { generatedAt = Date.now() } = {}) {
  const title = execution.flowName || execution.flowId || '执行报告'
  const subtitle = [
    `执行 ID：${escapeHtml(execution.id)}`,
    `状态：${badge(execution.status)}`,
    `开始：${escapeHtml(fmtTime(execution.startedAt))}`,
    execution.envId ? `环境：${escapeHtml(execution.envId)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return shell({ title, subtitle, body: executionBody(execution), generatedAt })
}

/** 一次套件执行 → 单文件 HTML */
export function suiteRunToHtml({ suiteRun, executions = [] }, { generatedAt = Date.now() } = {}) {
  const allSteps = executions.flatMap((execution) => execution.steps || [])
  const stats = stepStats(allSteps)
  const title = suiteRun.suiteName || suiteRun.suiteId || '套件执行报告'
  const subtitle = [
    `套件运行 ID：${escapeHtml(suiteRun.id)}`,
    `状态：${badge(suiteRun.status)}`,
    `开始：${escapeHtml(fmtTime(suiteRun.startedAt))}`,
    `流程数：${executions.length}`,
    suiteRun.envId ? `环境：${escapeHtml(suiteRun.envId)}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const flows = suiteRun.summary?.flows || []
  const flowTable = flows.length
    ? `<table><thead><tr><th>#</th><th>流程</th><th>状态</th><th>主归类</th><th>重试</th><th>耗时</th></tr></thead><tbody>${flows
        .map(
          (f, i) =>
            `<tr><td class="num">${i + 1}</td><td>${escapeHtml(f.flowName || f.flowId)}</td><td>${badge(f.status)}</td>` +
            `<td>${f.failureClass ? escapeHtml(FAILURE_CLASS_LABELS[f.failureClass] || f.failureClass) : '—'}</td>` +
            `<td>${f.flaky ? `flaky（${escapeHtml(f.attempts)} 次）` : escapeHtml(f.attempts || 1)}</td>` +
            `<td class="num">${escapeHtml(fmtDuration(f.durationMs))}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="muted">没有流程记录。</p>'

  const perFlow = executions
    .map((execution) => {
      const steps = Array.isArray(execution.steps) ? execution.steps : []
      return `<div class="block"><h2>${escapeHtml(execution.flowName || execution.flowId)} ${badge(execution.status)}</h2>` +
        `<p class="muted">执行 ID：${escapeHtml(execution.id)} · ${escapeHtml(fmtTime(execution.startedAt))}</p>` +
        `${stepsTable(steps)}${steps.map(stepDetails).join('')}</div>`
    })
    .join('\n')

  const body = [
    cards(stats),
    `<div class="block"><h2>流程结果</h2>${flowTable}</div>`,
    `<div class="block"><h2>失败归类计数</h2>${classCounts(suiteRun.summary?.failureClasses || {})}</div>`,
    perFlow,
  ].join('\n')

  return shell({ title, subtitle, body, generatedAt })
}
