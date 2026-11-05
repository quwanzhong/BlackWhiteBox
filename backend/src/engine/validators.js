import { resolvePath } from './jsonpath.js'

/**
 * 校验算子表：actual = 实际值, expectedValue = 理想值
 */
const OPS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  ge: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  le: (a, b) => Number(a) <= Number(b),
  exists: (a) => a !== undefined && a !== null,
  regex: (a, b) => {
    try {
      return new RegExp(b).test(String(a))
    } catch {
      return false
    }
  },
  contains: (a, b) =>
    Array.isArray(a)
      ? a.some((x) => JSON.stringify(x) === JSON.stringify(b))
      : String(a ?? '').includes(String(b)),
  type: (a, b) => (b === 'array' ? Array.isArray(a) : b === 'null' ? a === null : typeof a === b),
}

const OP_LABEL = {
  eq: '等于', ne: '不等于', gt: '大于', ge: '大于等于', lt: '小于', le: '小于等于',
  exists: '存在', regex: '匹配正则', contains: '包含', type: '类型为',
}

function describe(v) {
  if (v === undefined) return '未取到'
  if (typeof v === 'string') return JSON.stringify(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

function makeCheck({ type, label, path, op, value, actual, passed }) {
  return {
    type, label: label || '', path: path || '', op, value,
    actual, passed,
    message: passed
      ? '符合理想输出'
      : `期望 ${OP_LABEL[op] || op} ${describe(value)}，实际 ${describe(actual)}`,
  }
}

/**
 * 执行一个节点的输出校验：实际响应 vs 理想输出（expected）。
 * @param {*} expected 节点的 expected 定义 { status, checks:[{type,path,op,value}] }
 * @param {*} result   执行结果 { status, data, durationMs }
 */
export function runChecks(expected, result) {
  const results = []

  // 1) HTTP 状态码校验（未配置时默认期望 200）
  results.push(
    makeCheck({
      type: 'status', label: 'HTTP 状态码', op: 'eq',
      value: expected?.status ?? 200, actual: result.status,
      passed: result.status === (expected?.status ?? 200),
    })
  )

  // 2) 自定义断言列表
  for (const c of expected?.checks || []) {
    if (c.type === 'body_contains') {
      const actual = safeStringify(result.data)
      const value = String(c.value ?? '')
      results.push(makeCheck({
        type: 'body_contains', label: c.label, path: '$(响应体)',
        op: 'contains', value, actual, passed: actual.includes(value),
      }))
    } else {
      // 默认 json_path 断言
      const actual = resolvePath(result.data, c.path)
      const fn = OPS[c.op] || OPS.eq
      const passed = (() => {
        try { return !!fn(actual, c.value) } catch { return false }
      })()
      results.push(makeCheck({
        type: 'json_path', label: c.label, path: c.path,
        op: c.op || 'eq', value: c.value, actual, passed,
      }))
    }
  }

  // 3) 耗时上限（可选）
  if (expected?.maxDurationMs) {
    results.push(makeCheck({
      type: 'duration', label: '响应耗时上限', op: 'le',
      value: expected.maxDurationMs, actual: result.durationMs,
      passed: result.durationMs <= expected.maxDurationMs,
    }))
  }

  const matched = results.every((r) => r.passed)
  return { matched, results }
}

function safeStringify(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}
