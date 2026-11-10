/**
 * 白盒覆盖率断言（M3-4 / docs/01 FR-3.2.5、AC-3.2.5；docs/02 §6.6）
 *
 * 纯函数边界：输入节点 `expected.coverage` 与单节点覆盖率分析结果，
 * 输出与 `engine/validators.js#makeCheck` 同形状的 check 列表。
 * 不碰文件系统、数据库、子进程，判定规则可以单测、可以离线重算。
 *
 * DSL：
 *   { "coverage": { "mustHit": ["com.demo.OrderService#create"],
 *                   "mustMiss": ["com.demo.PaymentClient#refund"] } }
 *
 * 目标写法：
 *   pkg.Class           —— 类级：该类命中的行数 > 0
 *   pkg.Class#method    —— 方法级：同名重载聚合（任一重载命中即算命中）
 *   构造器写 pkg.Class#<init>
 *
 * 语义（关键：绝不静默通过）：
 *   mustHit  —— 目标必须在报告里且 covered > 0；不在报告里 = 失败（写错目标或本节点没执行到）
 *   mustMiss —— 目标不在报告里，或 covered === 0，都算「未命中」→ 通过
 *   证据不可用（未采集 / 未配置 classfiles / 分析失败）—— 断言判为失败，
 *   `type='coverage_evidence'` 由 reporting/classify.js 归到 script（配置问题，不是断言不符）
 */

/** Java 类名（点分）与可选方法名；允许内部类 `$`、构造器 `<init>` */
const CLASS_PART_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/
const METHOD_PART_RE = /^[A-Za-z_$<][\w$<>]*$/

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析一个断言目标。
 * @param {unknown} raw
 * @returns {{className: string, methodName: string|null, kind: 'class'|'method'}|null} 非法目标返回 null
 */
export function parseCoverageTarget(raw) {
  const text = typeof raw === 'string' ? raw.trim().replaceAll('/', '.') : ''
  if (!text) return null
  const hash = text.indexOf('#')
  const className = hash >= 0 ? text.slice(0, hash) : text
  const methodName = hash >= 0 ? text.slice(hash + 1) : ''
  if (!CLASS_PART_RE.test(className)) return null
  if (hash >= 0 && !METHOD_PART_RE.test(methodName)) return null
  return {
    className,
    methodName: methodName || null,
    kind: methodName ? 'method' : 'class',
  }
}

function targetList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const value of raw) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * 读取并归一化 `expected.coverage`（去空行、去重、保序）。
 * @param {any} expected 节点 expected
 * @returns {{mustHit: string[], mustMiss: string[]}}
 */
export function coverageSpecOf(expected) {
  const raw = expected && typeof expected === 'object' ? expected.coverage : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mustHit: [], mustMiss: [] }
  return { mustHit: targetList(raw.mustHit), mustMiss: targetList(raw.mustMiss) }
}

/** 节点是否声明了覆盖率断言（决定是否要在节点内同步分析、是否参与判定） */
export function hasCoverageAssertions(expected) {
  const spec = coverageSpecOf(expected)
  return spec.mustHit.length > 0 || spec.mustMiss.length > 0
}

function makeCheck({ type, label, path = '', op = 'eq', value, actual, passed, message }) {
  return { type, label, path, op, value, actual, passed, message }
}

function classIndex(result) {
  const map = new Map()
  for (const cls of result?.classes || []) {
    if (cls && typeof cls.name === 'string' && !map.has(cls.name)) map.set(cls.name, cls)
  }
  return map
}

/** 在报告里查目标：类级看类计数，方法级按方法名聚合所有重载 */
function lookupTarget(index, { className, methodName }) {
  const cls = index.get(className)
  if (!cls) return { present: false, covered: 0, total: 0, overloads: 0 }
  if (!methodName) {
    return { present: true, covered: toNumber(cls.covered), total: toNumber(cls.total), overloads: 0 }
  }
  const methods = (Array.isArray(cls.methods) ? cls.methods : []).filter(
    (method) => method && method.name === methodName
  )
  if (!methods.length) return { present: false, covered: 0, total: 0, overloads: 0 }
  return {
    present: true,
    covered: methods.reduce((sum, method) => sum + toNumber(method.covered), 0),
    total: methods.reduce((sum, method) => sum + toNumber(method.total), 0),
    overloads: methods.length,
  }
}

/** 证据不可用的可读原因；可用时返回 null */
function evidenceProblem(analysis) {
  const status = analysis?.status || 'unavailable'
  if (status === 'analyzed' && analysis?.result) return null
  if (status === 'disabled') return '未配置覆盖率采集（环境 settings.coverage）'
  if (status === 'pending') return '已采集到 .exec，但未配置 settings.coverage.classfiles，无法映射到源码行'
  if (status === 'analysis_failed') return `覆盖率分析失败：${analysis?.error || '未知原因'}`
  if (status === 'skipped') return '本节点覆盖率证据为空，无法分析'
  if (status === 'unavailable') {
    return analysis?.error ? `覆盖率证据不可用：${analysis.error}` : '本节点没有覆盖率证据（未采集或取证失败）'
  }
  return `覆盖率证据不可用（status=${status}）`
}

/**
 * 判定一个节点的覆盖率断言。
 * @param {any} expected 节点 expected（含 coverage）
 * @param {{status: string, result?: any, error?: string|null}|null} analysis
 *        `CoverageAnalyzer.analyzeOne()` 的返回值；null = 本节点没有任何证据
 * @returns {Array<object>} 与 makeCheck 同形状的 check 列表（没有任何断言时为空数组）
 */
export function evaluateCoverageAssertions(expected, analysis) {
  const spec = coverageSpecOf(expected)
  if (!spec.mustHit.length && !spec.mustMiss.length) return []

  const results = []
  const targets = []
  for (const [key, list] of [
    ['mustHit', spec.mustHit],
    ['mustMiss', spec.mustMiss],
  ]) {
    for (const text of list) {
      const parsed = parseCoverageTarget(text)
      if (parsed) {
        targets.push({ kind: key, text, parsed })
        continue
      }
      results.push(
        makeCheck({
          type: 'coverage_evidence',
          label: '覆盖率断言配置',
          path: text,
          op: 'exists',
          value: true,
          actual: '目标格式不合法',
          passed: false,
          message: `覆盖率断言目标不合法：「${text}」，应写成 pkg.Class 或 pkg.Class#method`,
        })
      )
    }
  }

  // 全是非法目标：只报配置问题，不再叠加「证据不可用」
  if (!targets.length) return results

  const problem = evidenceProblem(analysis)
  if (problem) {
    results.push(
      makeCheck({
        type: 'coverage_evidence',
        label: '覆盖率证据',
        op: 'exists',
        value: true,
        actual: problem,
        passed: false,
        message: `覆盖率断言未判定：${problem}`,
      })
    )
    return results
  }

  const index = classIndex(analysis.result)
  for (const { kind, text, parsed } of targets) {
    const hit = lookupTarget(index, parsed)
    const noun = parsed.kind === 'method' ? '方法' : '类'
    const overloadNote = hit.overloads > 1 ? `，${hit.overloads} 个重载合计` : ''

    if (kind === 'mustHit') {
      const passed = hit.present && hit.covered > 0
      const message = !hit.present
        ? `期望命中 ${text}，但覆盖率报告里没有该${noun}（目标可能写错，或本节点未执行到）`
        : passed
          ? `已命中 ${text}（covered ${hit.covered}/${hit.total} 行${overloadNote}）`
          : `期望命中 ${text}，实际 covered 0/${hit.total} 行`
      results.push(
        makeCheck({
          type: 'coverage',
          label: `应命中 ${text}`,
          path: text,
          op: 'gt',
          value: 0,
          actual: hit.present ? `covered ${hit.covered}/${hit.total}` : '报告中未出现',
          passed,
          message,
        })
      )
      continue
    }

    const passed = !hit.present || hit.covered === 0
    const message = !hit.present
      ? `未命中 ${text}（不在本节点覆盖率报告中）`
      : passed
        ? `未命中 ${text}（covered 0/${hit.total} 行）`
        : `期望不命中 ${text}，实际命中 covered ${hit.covered}/${hit.total} 行${overloadNote}`
    results.push(
      makeCheck({
        type: 'coverage',
        label: `应未命中 ${text}`,
        path: text,
        op: 'eq',
        value: 0,
        actual: hit.present ? `covered ${hit.covered}/${hit.total}` : '报告中未出现',
        passed,
        message,
      })
    )
  }
  return results
}
