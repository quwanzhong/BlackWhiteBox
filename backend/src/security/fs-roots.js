/**
 * 目录浏览沙箱（S4）。
 *
 * 旧实现：`GET /api/fs/list?path=<任意绝对路径>` 直接 `readdir`，等于把整台机器的目录结构
 * 暴露给任何能访问 3310 端口的进程/网页（配合 SSRF 或 DNS rebinding 后果更严重）。
 *
 * 新规则：
 *   1) 只有「显式登记过」的根目录及其子目录可浏览（默认 主目录 + 数据目录 + 项目 codePath）；
 *   2) 路径先 `realpath` 再判前缀，符号链接/junction 跳不出去；
 *   3) Windows 系统目录（Windows / Program Files / ProgramData…）与 POSIX 系统目录一律拒绝，
 *      即便有人把 C:\ 登记成根目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

const IS_WIN = process.platform === 'win32'

/** 只匹配「盘符后第一层」/「POSIX 第一层」，避免误伤 work/dev 这种同名工程目录 */
const WIN_DENY_TOP = new Set([
  'windows',
  'windows.old',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
  '$recycle.bin',
  'recovery',
  'boot',
  'perflogs',
])
const POSIX_DENY_TOP = new Set([
  'etc',
  'proc',
  'sys',
  'dev',
  'boot',
  'bin',
  'sbin',
  'usr',
  'var',
  'private',
  'system',
  'library',
])

const norm = (p) => (IS_WIN ? p.toLowerCase() : p)

function stripTrailingSep(p) {
  if (p.length <= 1) return p
  if (IS_WIN && /^[A-Za-z]:[\\/]$/.test(p)) return p
  return p.replace(/[\\/]+$/, '') || p
}

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/** 系统目录判定：只看绝对路径的前两层 */
export function isSystemPath(p) {
  const segs = String(p).split(/[\\/]+/).filter(Boolean)
  if (IS_WIN) {
    const top = segs[1]?.toLowerCase()
    return Boolean(top && WIN_DENY_TOP.has(top))
  }
  const top = segs[0]?.toLowerCase()
  return Boolean(top && POSIX_DENY_TOP.has(top))
}

function isInside(child, root) {
  const c = norm(stripTrailingSep(child))
  const r = norm(stripTrailingSep(root))
  if (c === r) return true
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * @param {object} opts
 * @param {string[]} [opts.roots] 初始根目录
 * @param {() => string[]} [opts.extraRoots] 每次调用时追加的根目录（如所有项目的 codePath）
 * @param {boolean} [opts.includeHome] 是否默认允许主目录（测试里关掉便于验证越界）
 * @param {boolean} [opts.includeDataDir] 是否默认允许数据目录
 */
export function createFsSandbox({
  roots = [],
  extraRoots = () => [],
  includeHome = true,
  includeDataDir = true,
} = {}) {
  const registered = []

  function addRoot(p) {
    const real = realOrSelf(stripTrailingSep(path.resolve(String(p))))
    if (!registered.some((r) => norm(r) === norm(real))) registered.push(real)
    return real
  }

  // 默认：主目录 + 数据目录 + 显式传入的 roots + 环境变量里登记的
  const defaults = [...roots]
  if (includeHome) defaults.push(os.homedir())
  if (includeDataDir) defaults.push(DATA_DIR)
  const fromEnv = String(process.env.HEIBAIHE_FS_ROOTS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const p of [...defaults, ...fromEnv]) addRoot(p)

  function allRoots() {
    const extra = []
    try {
      for (const p of extraRoots() || []) {
        const raw = String(p || '').trim()
        if (!raw) continue
        if (isSystemPath(raw)) continue
        extra.push(realOrSelf(stripTrailingSep(path.resolve(raw))))
      }
    } catch {
      /* 项目表不可读时不影响浏览 */
    }
    const all = [...registered]
    for (const p of extra) if (!all.some((r) => norm(r) === norm(p))) all.push(p)
    return all
  }

  function isAllowed(p) {
    const real = realOrSelf(p)
    if (isSystemPath(real)) return false
    return allRoots().some((root) => isInside(real, root))
  }

  return {
    roots: allRoots,
    /** 仅用户显式登记的根目录（用于持久化，不含默认主目录/数据目录/项目目录） */
    registered: () => [...registered],
    isAllowed,
    isRegistered(p) {
      const real = realOrSelf(stripTrailingSep(path.resolve(String(p))))
      return registered.some((r) => norm(r) === norm(real))
    },
    /** 登记新根目录（需已存在、非系统目录） */
    register(raw) {
      const input = String(raw || '').trim()
      if (!input) return { ok: false, status: 400, code: 'FS_EMPTY', error: '请提供目录 path' }
      let abs
      try {
        abs = path.resolve(input)
      } catch {
        return { ok: false, status: 400, code: 'FS_INVALID', error: '路径格式不正确' }
      }
      let real
      try {
        real = fs.realpathSync.native(abs)
      } catch {
        return { ok: false, status: 404, code: 'FS_NOT_FOUND', error: `目录不存在或无权访问：${abs}` }
      }
      let stat
      try {
        stat = fs.statSync(real)
      } catch {
        return { ok: false, status: 404, code: 'FS_NOT_FOUND', error: `目录不存在或无权访问：${abs}` }
      }
      if (!stat.isDirectory()) return { ok: false, status: 400, code: 'FS_NOT_DIR', error: '路径不是文件夹' }
      // 磁盘根目录（C:\ 或 /）登记等于放行整块盘，一律拒绝
      if (path.parse(abs).root === abs) {
        return { ok: false, status: 403, code: 'FS_DENIED', error: '不允许把磁盘根目录登记为代码目录' }
      }
      if (isSystemPath(real)) {
        return { ok: false, status: 403, code: 'FS_DENIED', error: '系统目录不允许登记为代码目录' }
      }
      addRoot(real)
      return { ok: true, path: real, roots: allRoots() }
    },
    /** 校验并规范化一个待浏览路径 */
    resolve(raw) {
      const input = String(raw || '').trim()
      if (!input) return { ok: false, status: 400, code: 'FS_EMPTY', error: '缺少 path 参数' }
      let abs
      try {
        abs = path.resolve(input)
      } catch {
        return { ok: false, status: 400, code: 'FS_INVALID', error: '路径格式不正确' }
      }
      let real
      try {
        real = fs.realpathSync.native(abs)
      } catch {
        return { ok: false, status: 404, code: 'FS_NOT_FOUND', error: `目录不存在或无权访问：${abs}` }
      }
      let stat
      try {
        stat = fs.statSync(real)
      } catch {
        return { ok: false, status: 404, code: 'FS_NOT_FOUND', error: `目录不存在或无权访问：${abs}` }
      }
      if (!stat.isDirectory()) return { ok: false, status: 400, code: 'FS_NOT_DIR', error: '路径不是文件夹' }
      if (isSystemPath(real)) {
        return { ok: false, status: 403, code: 'FS_DENIED', error: '系统目录禁止浏览' }
      }
      if (!isAllowed(real)) {
        return {
          ok: false,
          status: 403,
          code: 'FS_OUT_OF_SCOPE',
          canRegister: true,
          error: `目录不在允许范围内：${real}`,
        }
      }
      return { ok: true, path: real }
    },
    /** 上一级；越界就返回 null，让前端「↑ 上一级」自然停在根目录 */
    parentOf(real) {
      const parent = path.dirname(real)
      if (parent === real) return null
      return isAllowed(parent) ? parent : null
    },
    /** 根目录列表（给选择器首屏用） */
    list() {
      return allRoots()
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory()
          } catch {
            return false
          }
        })
        .map((p) => ({
          name: p === os.homedir() ? '主目录' : path.basename(p) || p,
          path: p,
          type: p === os.homedir() ? 'home' : 'root',
        }))
    },
  }
}
