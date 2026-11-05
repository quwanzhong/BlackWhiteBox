/**
 * 本机目录浏览：给「项目关联代码目录」提供可视化选择。
 * 仅用于本地单机版，只返回目录结构，不读取文件内容。
 */
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'

const router = Router()

const IGNORE = new Set(['node_modules', '.git', '.svn', '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'ProgramData'])

function listRoots() {
  if (process.platform === 'win32') {
    const roots = []
    for (let i = 65; i <= 90; i++) {
      const drive = `${String.fromCharCode(i)}:\\`
      try {
        if (fs.existsSync(drive)) roots.push({ name: drive, path: drive, type: 'drive' })
      } catch {
        /* 忽略无权限盘符 */
      }
    }
    return roots
  }
  const home = process.env.HOME || '/'
  return [
    { name: '主目录', path: home, type: 'home' },
    { name: '根目录', path: '/', type: 'root' },
  ]
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

router.get('/roots', (_req, res) => {
  res.json({ roots: listRoots(), platform: process.platform })
})

// GET /api/fs/list?path=C:\work\demo
router.get('/list', (req, res) => {
  const raw = String(req.query.path || '').trim()
  if (!raw) return res.json({ path: '', parent: null, dirs: listRoots() })

  const dir = path.resolve(raw)
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    return res.status(404).json({ error: `目录不存在或无权访问：${dir}` })
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: '路径不是文件夹' })

  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return res.status(403).json({ error: `无法读取目录：${err.message}` })
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(dir, e.name)
      return { name: e.name, path: full, type: 'dir', ...detectProject(full) }
    })
    .sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 800)

  const parent = path.dirname(dir)
  res.json({
    path: dir,
    parent: parent === dir ? null : parent,
    current: detectProject(dir),
    dirs,
  })
})

// 校验单个目录
router.get('/check', (req, res) => {
  const dir = path.resolve(String(req.query.path || '').trim())
  try {
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) return res.json({ ok: false, error: '路径不是文件夹' })
    res.json({ ok: true, path: dir, ...detectProject(dir) })
  } catch {
    res.json({ ok: false, error: '目录不存在或无权访问' })
  }
})

export default router
