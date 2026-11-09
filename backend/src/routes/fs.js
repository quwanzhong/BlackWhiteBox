/**
 * 本机目录浏览：给「项目关联代码目录」提供可视化选择。
 *
 * M1-3 起走沙箱（见 security/fs-roots.js）：
 *   只有显式登记的根目录可浏览；系统目录一律拒绝；realpath 后判前缀，软链接无法逃逸。
 * 首次使用时根目录 = 主目录 + 数据目录 + 所有项目已保存的 codePath；
 * 需要浏览别处时由用户在界面上「登记此目录」（POST /api/fs/roots）。
 */
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { store } from '../store.js'
import { createFsSandbox } from '../security/fs-roots.js'

const router = Router()
const META_KEY = 'fs_roots'

const IGNORE = new Set(['node_modules', '.git', '.svn', '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'ProgramData'])

function loadRoots() {
  try {
    const raw = store.getAppMeta(META_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p.trim()) : []
  } catch {
    return []
  }
}

const sandbox = createFsSandbox({
  roots: loadRoots(),
  // 已保存的项目目录自动可浏览：升级到 M1-3 后老项目不会突然打不开
  extraRoots: () =>
    store
      .listProjectSummaries()
      .map((p) => p.codePath)
      .filter(Boolean),
})

function persistRoots() {
  try {
    // 只持久化显式登记的根目录：主目录/数据目录/项目 codePath 每次启动自动推导
    store.setAppMeta(META_KEY, JSON.stringify(sandbox.registered()))
  } catch {
    /* 元数据写失败不影响本次浏览 */
  }
}

function detectProject(dir) {
  const hints = []
  const has = (name) => {
    try {
      return fs.existsSync(path.join(dir, name))
    } catch {
      return false
    }
  }
  if (has('package.json')) hints.push('package.json')
  if (has('src')) hints.push('src')
  if (has('vite.config.ts') || has('vite.config.js')) hints.push('vite')
  if (has('vue.config.js')) hints.push('vue-cli')
  if (has('next.config.js') || has('next.config.mjs')) hints.push('next')
  if (has('angular.json')) hints.push('angular')
  return { isProject: hints.includes('package.json') || hints.includes('src'), hints }
}

function fail(res, result) {
  const body = { error: result.error, code: result.code }
  if (result.canRegister) body.canRegister = true
  return res.status(result.status || 400).json(body)
}

router.get('/roots', (_req, res) => {
  res.json({ roots: sandbox.list(), platform: process.platform })
})

// 显式登记一个可浏览的根目录
router.post('/roots', (req, res) => {
  const result = sandbox.register(req.body?.path)
  if (!result.ok) return fail(res, result)
  persistRoots()
  res.json({ ok: true, path: result.path, roots: sandbox.list() })
})

// GET /api/fs/list?path=C:\work\demo
router.get('/list', (req, res) => {
  const raw = String(req.query.path || '').trim()
  if (!raw) {
    return res.json({ path: '', parent: null, dirs: sandbox.list(), roots: sandbox.list() })
  }

  const resolved = sandbox.resolve(raw)
  if (!resolved.ok) return fail(res, resolved)
  const dir = resolved.path

  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return res.status(403).json({ error: `无法读取目录：${err.message}`, code: 'FS_READ_FAILED' })
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
    .filter((e) => {
      // 软链接/junction 可能指向沙箱外，逐个校验
      if (!e.isSymbolicLink()) return true
      return sandbox.isAllowed(path.join(dir, e.name))
    })
    .map((e) => {
      const full = path.join(dir, e.name)
      return { name: e.name, path: full, type: 'dir', ...detectProject(full) }
    })
    .sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 800)

  res.json({
    path: dir,
    parent: sandbox.parentOf(dir),
    current: detectProject(dir),
    dirs,
    root: sandbox.roots().find((r) => dir.toLowerCase().startsWith(r.toLowerCase())),
  })
})

// 校验单个目录
router.get('/check', (req, res) => {
  const result = sandbox.resolve(String(req.query.path || '').trim())
  if (!result.ok) return res.json({ ok: false, code: result.code, error: result.error, canRegister: result.canRegister })
  res.json({ ok: true, path: result.path, ...detectProject(result.path) })
})

export default router
