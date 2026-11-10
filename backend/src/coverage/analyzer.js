/**
 * 覆盖率分析器（M3-2 / docs/02 §6.2）
 *
 * 输入是 M3-1 落在 `coverage.exec_blob` 的 per-node `.exec` 快照，输出是
 * `coverage.result_json`（files / classes / totals）。分析在 `flow_end` 之后异步执行，
 * 不阻塞执行结论；每节点单独跑一次 jacococli，保证「本节点命中」而不是全局并集。
 *
 * 失败语义（绝不伪装成 0% 覆盖）：
 *   - 没有配置 `classfiles`：不分析，行保持 `status='captured'` + `pending=true`；
 *   - 配置了但 CLI/类目录不存在、或 jacococli 非零退出：
 *     行仍是 `status='captured'`（原始证据保留），`error` 写稳定 code，
 *     投影接口把这种行计为 `analysisFailed`，而不是 `pending`。
 *
 * 所有异常都收敛到稳定 code，调用方（scheduler）只负责发事件，不参与判定。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store } from '../store.js'
import { parseJacocoXml } from './jacoco-report.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库内 PoC 的默认 CLI 路径；桌面端/生产环境用 settings.coverage.cliPath 或 JACOCO_CLI 覆盖 */
export const DEFAULT_CLI_PATH = path.resolve(HERE, '../../../poc/jacoco/tools/jacococli.jar')
const DEFAULT_CLI_TIMEOUT_MS = 60000
const MAX_OUTPUT_TAIL = 64 * 1024

export class CoverageAnalysisError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'CoverageAnalysisError'
    this.code = code
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function textValue(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

/**
 * 从环境 `settings.coverage` 提取分析配置；未配置或显式关闭时返回 null。
 * `classfiles` 缺失时仍返回配置（采集会继续，只是不分析），以便调用方区分
 * 「未配置覆盖率」和「已采集但未配置类目录」。
 */
export function analyzerConfigFrom(settings) {
  if (!isPlainObject(settings)) return null
  const raw = settings.coverage
  if (!isPlainObject(raw)) return null
  if (raw.enabled === false) return null
  return {
    source: raw.source || 'jacoco',
    classfiles: textValue(raw.classfiles),
    sourcefiles: textValue(raw.sourcefiles),
    cliPath: textValue(raw.cliPath) || textValue(process.env.JACOCO_CLI) || DEFAULT_CLI_PATH,
    javaBin: textValue(raw.javaBin) || textValue(process.env.JAVA_BIN) || 'java',
  }
}

function tail(value) {
  const text = String(value || '').trim()
  return text.length > MAX_OUTPUT_TAIL ? text.slice(-MAX_OUTPUT_TAIL) : text
}

function stableError(err) {
  const code = typeof err?.code === 'string' && err.code.startsWith('COVERAGE_')
    ? err.code
    : 'COVERAGE_ANALYZE_FAILED'
  return `${code}: ${err?.message || String(err)}`
}

function assertReadablePath(target, code, label) {
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`${label}不是文件或目录：${target}`)
    }
  } catch (err) {
    throw new CoverageAnalysisError(code, `${label}不存在或不可读：${target}（${err.message}）`, err)
  }
}

/**
 * 调用 jacococli 把单个 `.exec` 解析成 XML，再走纯函数解析。
 * 可注入 `spawnImpl`，单测无需真实 JDK；生产默认 `child_process.spawn`。
 */
export function runJacococli(options = {}) {
  const {
    execFile,
    classfiles,
    sourcefiles,
    xmlFile,
    cliPath = DEFAULT_CLI_PATH,
    javaBin = 'java',
    timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
    spawnImpl = spawn,
  } = options

  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(value)
    }

    try {
      assertReadablePath(execFile, 'COVERAGE_ANALYZE_FAILED', '.exec 证据文件')
      if (!classfiles) {
        throw new CoverageAnalysisError(
          'COVERAGE_CLASSFILES_MISSING',
          '未配置 settings.coverage.classfiles，无法把 .exec 映射到源码行'
        )
      }
      assertReadablePath(classfiles, 'COVERAGE_CLASSFILES_MISSING', 'classfiles 目录 ')
      if (sourcefiles) {
        assertReadablePath(sourcefiles, 'COVERAGE_ANALYZE_FAILED', 'sourcefiles 目录 ')
      }
      assertReadablePath(cliPath, 'COVERAGE_CLI_MISSING', 'jacococli.jar ')
    } catch (err) {
      finish(reject, err)
      return
    }

    const args = ['-jar', cliPath, 'report', execFile, '--classfiles', classfiles]
    if (sourcefiles) args.push('--sourcefiles', sourcefiles)
    args.push('--xml', xmlFile)

    let child
    try {
      child = spawnImpl(javaBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      finish(
        reject,
        new CoverageAnalysisError('COVERAGE_ANALYZE_FAILED', `无法启动 java：${err.message}`, err)
      )
      return
    }

    const append = (which, chunk) => {
      if (which === 'out') stdout = tail(stdout + chunk.toString('utf8'))
      else stderr = tail(stderr + chunk.toString('utf8'))
    }
    child.stdout?.on('data', (chunk) => append('out', chunk))
    child.stderr?.on('data', (chunk) => append('err', chunk))

    child.once('error', (err) => {
      const code = err?.code === 'ENOENT' ? 'COVERAGE_JAVA_MISSING' : 'COVERAGE_ANALYZE_FAILED'
      finish(reject, new CoverageAnalysisError(code, `java 启动失败：${err.message}`, err))
    })

    child.once('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        const detail = stderr || stdout || `signal=${signal || 'none'}`
        finish(
          reject,
          new CoverageAnalysisError(
            'COVERAGE_ANALYZE_FAILED',
            `jacococli 退出码 ${code}：${detail}`
          )
        )
        return
      }
      try {
        const xml = fs.readFileSync(xmlFile, 'utf8')
        finish(resolve, { result: parseJacocoXml(xml), stdout, stderr })
      } catch (err) {
        finish(
          reject,
          new CoverageAnalysisError('COVERAGE_ANALYZE_FAILED', `读取 XML 报告失败：${err.message}`, err)
        )
      }
    })

    timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
      finish(
        reject,
        new CoverageAnalysisError(
          'COVERAGE_ANALYZE_FAILED',
          `jacococli 分析超时（>${timeoutMs}ms），已终止`
        )
      )
    }, timeoutMs)
  })
}

export class CoverageAnalyzer {
  /**
   * @param {{executionId: string, settings?: object, runner?: Function, spawnImpl?: Function,
   *          tmpRoot?: string, timeoutMs?: number, onEvent?: (summary: object) => void}} opts
   */
  constructor({ executionId, settings, runner, spawnImpl, tmpRoot, timeoutMs, onEvent } = {}) {
    this.executionId = executionId
    this.config = analyzerConfigFrom(settings)
    this.runner = runner || ((opts) => runJacococli({ ...opts, spawnImpl: spawnImpl || spawn }))
    this.tmpRoot = tmpRoot
    this.timeoutMs = timeoutMs || DEFAULT_CLI_TIMEOUT_MS
    this.onEvent = onEvent
  }

  /** 是否配置了覆盖率采集（与「是否可分析」分开，classfiles 缺失时仍是 true） */
  get enabled() {
    return Boolean(this.config)
  }

  /** 是否有足够的配置把 `.exec` 变成行级结果 */
  get analyzable() {
    return Boolean(this.config?.classfiles)
  }

  /**
   * 分析单条覆盖率证据（M3-4：白盒断言需要在节点内同步拿到结果）。
   *
   * 永不抛出，返回调用方可以直接用来判定的状态：
   *   analyzed        —— result 可用
   *   pending         —— 有证据但未配置 classfiles（保持 captured，等待以后重跑）
   *   analysis_failed —— jacococli 失败（保留证据 + 稳定 error）
   *   skipped         —— 空 blob 或行状态不是 captured
   *   unavailable     —— 本节点没有证据行
   *   disabled        —— 本次执行未启用覆盖率采集
   *
   * `workDir` 由 `run()` 复用；不传时自己建临时目录并在结束时清理。
   * @param {string|{id?: string}} rowOrId coverage 行或 id
   * @param {{workDir?: string}} [opts]
   */
  async analyzeRow(rowOrId, { workDir } = {}) {
    if (!this.config || this.config.source !== 'jacoco') {
      return { status: 'disabled', reason: 'COVERAGE_DISABLED', error: null, result: null }
    }
    const id = typeof rowOrId === 'string' ? rowOrId : rowOrId?.id
    const full = id ? store.getCoverage(id) : null
    if (!full) {
      return { status: 'unavailable', reason: 'NO_EVIDENCE', error: 'COVERAGE_NOT_FOUND', result: null }
    }
    // 已分析过的行直接复用结果：白盒断言重复判定时不重复跑 jacococli
    if (full.status === 'analyzed' && full.result) {
      return { status: 'analyzed', reason: 'ALREADY_ANALYZED', error: full.error || null, result: full.result }
    }
    if (full.status === 'unavailable') {
      return { status: 'unavailable', reason: 'NO_EVIDENCE', error: full.error || null, result: null }
    }
    if (full.status !== 'captured') {
      return { status: 'skipped', reason: 'NOT_CAPTURED', error: full.error || null, result: null }
    }
    if (!this.config.classfiles) {
      return { status: 'pending', reason: 'CLASSFILES_NOT_CONFIGURED', error: null, result: null }
    }
    if (!full.execBlob?.length) {
      return { status: 'skipped', reason: 'EMPTY_EVIDENCE', error: full.error || null, result: null }
    }

    const ownWorkDir = !workDir
    const dir = workDir || fs.mkdtempSync(path.join(this.tmpRoot || os.tmpdir(), 'hbh-coverage-'))
    try {
      const execFile = path.join(dir, `${full.id}.exec`)
      const xmlFile = path.join(dir, `${full.id}.xml`)
      fs.writeFileSync(execFile, full.execBlob)
      try {
        const { result } = await this.runner({
          execFile,
          xmlFile,
          classfiles: this.config.classfiles,
          sourcefiles: this.config.sourcefiles,
          cliPath: this.config.cliPath,
          javaBin: this.config.javaBin,
          timeoutMs: this.timeoutMs,
        })
        store.updateCoverageResult(full.id, { status: 'analyzed', result, error: null })
        return { status: 'analyzed', reason: null, error: null, result }
      } catch (err) {
        const error = stableError(err)
        store.updateCoverageResult(full.id, { status: 'captured', result: null, error })
        return { status: 'analysis_failed', reason: 'ANALYZE_FAILED', error, result: null }
      }
    } finally {
      if (ownWorkDir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  /** M3-4：节点内同步分析一条证据，供白盒断言立即判定 */
  analyzeOne(coverageId) {
    return this.analyzeRow(coverageId)
  }

  /**
   * 分析本次执行的所有 `status='captured'` 快照。
   * 永不抛出：单节点失败只写该行 error，继续下一个节点；返回汇总供事件使用。
   * @param {{skipIds?: Set<string>|string[]}} [opts] M3-4：已在节点内同步分析过的行不再重跑
   */
  async run({ skipIds } = {}) {
    const startedAt = Date.now()
    if (!this.config || this.config.source !== 'jacoco') {
      return this.summary({ reason: 'COVERAGE_DISABLED', startedAt })
    }

    const skip = skipIds instanceof Set ? skipIds : new Set(skipIds || [])
    const rows = store.listExecutionCoverage(this.executionId)
    const candidates = rows.filter(
      (row) => row.status === 'captured' && row.source === 'jacoco' && !skip.has(row.id)
    )
    if (!candidates.length) return this.summary({ reason: 'NO_PENDING_EVIDENCE', startedAt })
    if (!this.config.classfiles) {
      return this.summary({ reason: 'CLASSFILES_NOT_CONFIGURED', total: candidates.length, skipped: candidates.length, startedAt })
    }

    const results = []
    let analyzed = 0
    let failed = 0
    let skipped = 0
    const workDir = fs.mkdtempSync(path.join(this.tmpRoot || os.tmpdir(), 'hbh-coverage-'))

    try {
      for (const row of candidates) {
        const outcome = await this.analyzeRow(row, { workDir })
        if (outcome.status === 'analyzed') {
          analyzed += 1
          const totals = outcome.result.totals
          results.push({
            coverageId: row.id,
            nodeId: row.nodeId,
            status: 'analyzed',
            covered: totals.covered,
            missed: totals.missed,
            total: totals.total,
            lineRate: totals.lineRate,
            files: totals.files,
            classes: totals.classes,
            error: null,
          })
        } else if (outcome.status === 'analysis_failed') {
          failed += 1
          results.push({
            coverageId: row.id,
            nodeId: row.nodeId,
            status: 'analysis_failed',
            error: outcome.error,
          })
        } else {
          skipped += 1
          results.push({
            coverageId: row.id,
            nodeId: row.nodeId,
            status: outcome.status === 'pending' ? 'skipped' : outcome.status,
            error: outcome.error || null,
          })
        }
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }

    const summary = this.summary({
      analyzed,
      failed,
      skipped,
      total: candidates.length,
      results,
      startedAt,
    })
    try {
      this.onEvent?.(summary)
    } catch {
      /* 事件失败不能反噬分析结果 */
    }
    return summary
  }

  summary({ analyzed = 0, failed = 0, skipped = 0, total = 0, results = [], reason = null, startedAt } = {}) {
    return {
      executionId: this.executionId,
      analyzed,
      failed,
      skipped,
      total,
      reason,
      results,
      durationMs: Date.now() - (startedAt || Date.now()),
    }
  }
}

/** 执行会话无条件持有一个分析器（未配置时 run 直接返回空汇总） */
export function createCoverageAnalyzer(opts) {
  return new CoverageAnalyzer(opts)
}
