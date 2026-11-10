/**
 * 导出门面（M2-4 / docs/02 §9.2）。
 *
 * 路由只负责取数、判存在；格式映射、脱敏、文件名与 Content-Type 都收敛在这里，
 * 保证「任何导出」都先过 scrubExecution（S8 只有一个出口）。
 */
import { scrubExecution } from './scrub.js'
import { executionToJUnit, suiteRunToJUnit } from './exporters/junit.js'
import { executionToHtml, suiteRunToHtml } from './exporters/html.js'
import { executionToJson, suiteRunToJson } from './exporters/json.js'

export const EXPORT_FORMATS = ['junit', 'html', 'json']
export const DEFAULT_FORMAT = 'json'

export const CONTENT_TYPES = {
  junit: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
}

export const EXTENSIONS = {
  junit: 'junit.xml',
  html: 'html',
  json: 'json',
}

const KIND_LABEL = {
  execution: 'execution',
  'suite-run': 'suite-run',
}

export class ExportError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ExportError'
    this.code = code
    this.status = status
  }
}

/** 缺省 json；大小写不敏感；非法值返回 null（路由据此回 400） */
export function normalizeFormat(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_FORMAT
  const format = String(raw).trim().toLowerCase()
  return EXPORT_FORMATS.includes(format) ? format : null
}

/** ASCII 兜底名：非 ASCII 一律压成 -，用于老客户端只认 filename= 的场景 */
function asciiSlug(name, fallback) {
  const slug = String(name ?? '')
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || fallback
}

/** 展示名：保留中文，只去掉会破坏 header 的字符 */
function displayName(name, fallback) {
  const clean = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
  return clean || fallback
}

/**
 * @returns {{ ascii: string, display: string }} ascii 用于 filename=，display 用于 filename*=UTF-8''
 */
export function exportFilename(kind, name, id, format) {
  const ext = EXTENSIONS[format]
  if (!ext) throw new ExportError('EXPORT_BAD_FORMAT', `不支持的导出格式：${format}`)
  const fallback = KIND_LABEL[kind] || 'report'
  const shortId = String(id || '').slice(0, 8) || 'unknown'
  return {
    ascii: `heibaihe-${asciiSlug(name, fallback)}-${shortId}.${ext}`,
    display: `heibaihe-${displayName(name, fallback)}-${shortId}.${ext}`,
  }
}

export function contentDisposition(filename) {
  return `attachment; filename="${filename.ascii}"; filename*=UTF-8''${encodeURIComponent(filename.display)}`
}

/**
 * 渲染导出内容。
 * @param {{
 *   format?: string, kind: 'execution'|'suite-run', name?: string, id: string,
 *   execution?: object|null, suiteRun?: object|null, executions?: object[], generatedAt?: number
 * }} input
 */
export function renderExport(input) {
  const format = normalizeFormat(input.format)
  if (!format) {
    throw new ExportError('EXPORT_BAD_FORMAT', `不支持的导出格式：${input.format}`, 400)
  }
  if (!KIND_LABEL[input.kind]) {
    throw new ExportError('EXPORT_BAD_KIND', `不支持的导出类型：${input.kind}`, 400)
  }

  const generatedAt = input.generatedAt ?? Date.now()
  const files = exportFilename(input.kind, input.name, input.id, format)
  // S8 唯一出口：先脱敏，再交给各格式渲染器
  const execution = input.execution ? scrubExecution(input.execution) : null
  const suiteRun = input.suiteRun ? scrubExecution(input.suiteRun) : null
  const executions = (input.executions || []).map((item) => scrubExecution(item))

  let body
  if (format === 'junit') {
    body = input.kind === 'suite-run' ? suiteRunToJUnit({ suiteRun, executions }) : executionToJUnit(execution)
  } else if (format === 'html') {
    body =
      input.kind === 'suite-run'
        ? suiteRunToHtml({ suiteRun, executions }, { generatedAt })
        : executionToHtml(execution, { generatedAt })
  } else {
    body =
      input.kind === 'suite-run'
        ? suiteRunToJson({ suiteRun, executions }, { generatedAt })
        : executionToJson(execution, { generatedAt })
  }

  return {
    format,
    body,
    contentType: CONTENT_TYPES[format],
    extension: EXTENSIONS[format],
    filename: files.display,
    contentDisposition: contentDisposition(files),
  }
}
