/**
 * JSON 导出（M2-4 / docs/02 §9.2）。
 *
 * 面向机器与回归 diff：结构稳定（version/kind/generatedAt/scrubbed 固定在最外层），
 * 正文是脱敏后的完整执行详情，消费者不需要再拼接口。
 */
import { SCRUB_POLICY } from '../scrub.js'

export const EXPORT_VERSION = 1

const iso = (ts) => new Date(Number(ts) || Date.now()).toISOString()

/** 单条执行 → JSON 文本（2 空格缩进，便于人工看和 git diff） */
export function executionToJson(execution, { generatedAt = Date.now() } = {}) {
  return JSON.stringify(
    {
      version: EXPORT_VERSION,
      kind: 'execution',
      generatedAt: iso(generatedAt),
      scrubbed: SCRUB_POLICY,
      execution,
    },
    null,
    2
  )
}

/** 一次套件执行 → JSON 文本 */
export function suiteRunToJson({ suiteRun, executions = [] }, { generatedAt = Date.now() } = {}) {
  return JSON.stringify(
    {
      version: EXPORT_VERSION,
      kind: 'suite-run',
      generatedAt: iso(generatedAt),
      scrubbed: SCRUB_POLICY,
      suiteRun,
      executions,
    },
    null,
    2
  )
}
