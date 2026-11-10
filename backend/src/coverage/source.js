/**
 * 覆盖率源码视图（M3-3 / docs/02 §6.2）
 *
 * 覆盖率面板要回答两个问题：「这个节点命中了哪些行」和「没命中的行长什么样」。
 * 行号来自 M3-2 的 `coverage.result_json`，源码本身不在库里，只能按执行时
 * 记录的环境快照 `settings.coverage.sourcefiles` 去本机读。
 *
 * 安全边界（S8 之外的第二类风险：任意文件读取）：
 *   1) 只允许读取「本次节点 result.files 里声明过的路径」，不接受任意 `?path=`；
 *   2) 路径必须是相对路径，拒绝绝对路径 / 盘符 / `..` / 控制字符；
 *   3) resolve 之后再 realpath 一次并校验仍在 sourcefiles 根目录内，挡住软链接逃逸；
 *   4) 读取有上限（默认 512 KB），超出部分截断并显式告知，不静默丢内容。
 *
 * 纯函数与 IO 分开：`normalizeSourcePath` / `buildSourceView` 可单测，
 * `resolveSourcePath` / `readSourceFile` 只碰文件系统。
 */
import fs from 'node:fs'
import path from 'node:path'

export const MAX_SOURCE_PATH = 1024
export const MAX_SOURCE_BYTES = 512 * 1024

export class CoverageSourceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CoverageSourceError'
    this.code = code
  }
}

/** 归一化 result_json 里的源码路径：只接受相对、无 `..`、无控制字符 */
export function normalizeSourcePath(input) {
  if (typeof input !== 'string') {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径必须是字符串')
  }
  const raw = input.trim()
  if (!raw) throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径为空')
  if (raw.length > MAX_SOURCE_PATH) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', `源码路径过长（上限 ${MAX_SOURCE_PATH} 字符）`)
  }
  // 控制字符（含 \0）一律拒绝：既挡注入，也避免文件系统报错不可读
  if (/[\u0000-\u001f]/.test(raw)) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径包含控制字符')
  }
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径必须相对 sourcefiles 根目录')
  }
  const segments = unified.split('/').filter((seg) => seg && seg !== '.')
  if (!segments.length) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径为空')
  }
  if (segments.includes('..')) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径不允许包含 ..')
  }
  return segments.join('/')
}

/** 目标是否仍在根目录内（用 path.relative 判断，Windows 大小写与盘符都能正确处理） */
function isInside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 把 result_json 的相对路径解析成可读的绝对路径，并挡住软链接逃逸 */
export function resolveSourcePath(root, relative) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new CoverageSourceError('COVERAGE_SOURCEFILES_MISSING', '环境未配置 settings.coverage.sourcefiles')
  }
  const rel = normalizeSourcePath(relative)
  let realRoot
  try {
    realRoot = fs.realpathSync.native(path.resolve(root.trim()))
  } catch (err) {
    throw new CoverageSourceError(
      'COVERAGE_SOURCEFILES_MISSING',
      `sourcefiles 目录不存在或不可读：${root.trim()}（${err.code || err.message}）`
    )
  }
  let stat
  try {
    stat = fs.statSync(realRoot)
  } catch (err) {
    throw new CoverageSourceError(
      'COVERAGE_SOURCEFILES_MISSING',
      `sourcefiles 目录不存在或不可读：${root.trim()}（${err.code || err.message}）`
    )
  }
  if (!stat.isDirectory()) {
    throw new CoverageSourceError('COVERAGE_SOURCEFILES_MISSING', `sourcefiles 不是目录：${root.trim()}`)
  }

  const candidate = path.resolve(realRoot, rel)
  if (!isInside(realRoot, candidate)) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径越出 sourcefiles 根目录')
  }
  let realTarget
  try {
    realTarget = fs.realpathSync.native(candidate)
  } catch (err) {
    throw new CoverageSourceError(
      'COVERAGE_SOURCE_NOT_FOUND',
      `源码文件不存在：${rel}（${err.code || err.message}）`
    )
  }
  if (!isInside(realRoot, realTarget)) {
    throw new CoverageSourceError('COVERAGE_SOURCE_PATH_INVALID', '源码路径经软链接越出 sourcefiles 根目录')
  }
  const targetStat = fs.statSync(realTarget)
  if (!targetStat.isFile()) {
    throw new CoverageSourceError('COVERAGE_SOURCE_NOT_FOUND', `不是可读文件：${rel}`)
  }
  return { root: realRoot, absolute: realTarget, path: rel }
}

/**
 * 读源码文件（有上限）。截断时退回最后一个换行，避免把半行/半个 UTF-8 字符展示给用户。
 * @returns {{text:string, bytes:number, truncated:boolean}}
 */
export function readSourceFile(absolute, { maxBytes = MAX_SOURCE_BYTES } = {}) {
  let fd
  try {
    fd = fs.openSync(absolute, 'r')
    const size = fs.fstatSync(fd).size
    const readBytes = Math.min(size, maxBytes + 1)
    const buffer = Buffer.alloc(readBytes)
    const read = readBytes ? fs.readSync(fd, buffer, 0, readBytes, 0) : 0
    let text = buffer.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '')
    const truncated = size > maxBytes
    if (truncated) {
      const cut = text.lastIndexOf('\n')
      text = cut >= 0 ? text.slice(0, cut) : ''
    }
    return { text, bytes: size, truncated }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** 把源码文本 + 行号数组拼成 UI 直接可渲染的行状态（1 命中 / 0 未命中 / null 不参与统计） */
export function buildSourceView({ path: rel, text, covered = [], missed = [], bytes = 0, truncated = false }) {
  const lines = String(text || '').split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const coveredSet = new Set(
    (Array.isArray(covered) ? covered : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  )
  const missedSet = new Set(
    (Array.isArray(missed) ? missed : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  )
  const coveredLines = []
  const missedLines = []
  const view = lines.map((line, index) => {
    const nr = index + 1
    let hit = null
    if (missedSet.has(nr)) {
      hit = 0
      missedLines.push(nr)
    } else if (coveredSet.has(nr)) {
      hit = 1
      coveredLines.push(nr)
    }
    return { nr, text: line, hit }
  })
  const statLines = coveredLines.length + missedLines.length
  return {
    path: rel,
    bytes,
    truncated,
    totalLines: lines.length,
    covered: coveredLines,
    missed: missedLines,
    statLines,
    lineRate: statLines ? Math.round((coveredLines.length / statLines) * 10000) / 100 : null,
    lines: view,
  }
}
