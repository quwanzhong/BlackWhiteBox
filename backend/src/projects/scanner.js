/**
 * 前端源码接口调用扫描器。
 *
 * 目标：从「选定的前端工程目录」里找出所有 HTTP 调用点（axios / request / fetch / service.get ...），
 * 与项目已绑定的 Apifox 接口做路径匹配，得到：
 *   - 每个接口在代码中的调用位置（文件:行、函数名）
 *   - 完整调用顺序（按文件、行号）
 *   - 业务功能分组（优先用 Apifox 目录，其次用接口路径段 / 代码目录）
 *
 * 纯静态扫描，不执行项目代码，零第三方依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DEFAULT_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.mjs', '.cjs']
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', '.idea', '.vscode', 'unpackage', 'vendor', 'public', 'static', 'assets',
])
const CLIENT_NAMES = new Set([
  'axios', 'request', 'http', 'service', 'api', 'instance', 'client', 'req', 'ajax',
  'server', 'web', 'base', 'fetch',
])
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

function hash(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

function looksLikePath(raw) {
  if (!raw || raw.length > 500) return false
  if (/^(https?:)?\/\//i.test(raw)) return true
  if (!/^\s*(\/|\{\{|\$\{)/.test(raw)) return false
  return raw.includes('/') || raw.length > 1
}

/** 统一路径：去掉域名 / 查询串，占位符统一成 {} */
export function normalizeApiPath(raw) {
  let p = String(raw || '').trim()
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname
    } catch {
      p = p.replace(/^https?:\/\/[^/]+/i, '')
    }
  }
  p = p.split(/[?#]/)[0]
  p = p.replace(/\$\{[^}]*\}/g, '{}').replace(/\{\{[^}]*\}\}/g, '{}').replace(/\{[^}/]*\}/g, '{}')
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p
}

function segments(p) {
  return normalizeApiPath(p).split('/').filter(Boolean)
}

/** 路径相似度 0-100：从末尾逐段匹配，支持 {} 通配 */
export function matchScore(apiPath, codePath) {
  const a = segments(apiPath)
  const c = segments(codePath)
  if (!a.length || !c.length) return 0
  let i = a.length - 1
  let j = c.length - 1
  let matched = 0
  while (i >= 0 && j >= 0) {
    const av = a[i]
    const cv = c[j]
    if (av === '{}' || cv === '{}' || av === cv) {
      matched++
      i--
      j--
    } else break
  }
  if (!matched) return 0
  const lastA = a[a.length - 1]
  const lastC = c[c.length - 1]
  const lastOk = lastA === '{}' || lastC === '{}' || lastA === lastC
  if (!lastOk) return 0
  const maxLen = Math.max(a.length, c.length)
  if (maxLen > 1 && matched < 2) return 0
  return Math.round((matched / maxLen) * 100)
}

function functionNameAt(lines, index) {
  for (let i = index; i >= 0 && i > index - 60; i--) {
    const line = lines[i]
    let m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (m) return m[1]
    m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
    if (m) return m[1]
    m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/)
    if (m) return m[1]
    m = line.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/)
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) return m[1]
  }
  return ''
}

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function collectCallsInFile(content, relFile, root) {
  const lines = content.split(/\r?\n/)
  const calls = []
  const seen = new Set()

  const push = (index, method, rawPath, kind) => {
    if (!looksLikePath(rawPath)) return
    const line = lines[index]
    if (isComment(line)) return
    const m = (method || '').toLowerCase()
    if (m && !METHODS.includes(m)) return
    const normalized = normalizeApiPath(rawPath)
    const key = `${index}|${m}|${normalized}`
    if (seen.has(key)) return
    seen.add(key)
    calls.push({
      id: hash(root, relFile, index, m, normalized),
      method: m ? m.toUpperCase() : '',
      rawPath: String(rawPath).trim(),
      path: normalized,
      file: relFile,
      line: index + 1,
      functionName: functionNameAt(lines, index),
      kind,
      snippet: line.trim().slice(0, 240),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length > 2000) continue

    // 1) axios.get('/x') / service.post(`/x/${id}`) / request({...})
    const memberRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\n]+)\3/gi
    let m
    while ((m = memberRe.exec(line))) {
      if (!CLIENT_NAMES.has(m[1].toLowerCase())) continue
      push(i, m[2], m[4], 'member')
    }

    // 2) fetch('/x', { method: 'POST' })
    const fetchRe = /\bfetch\s*\(\s*(['"`])([^'"`\n]+)\1/gi
    while ((m = fetchRe.exec(line))) {
      const lookahead = lines.slice(i, i + 8).join(' ')
      const mm = lookahead.match(/\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/)
      push(i, mm ? mm[2] : 'GET', m[2], 'fetch')
    }

    // 3) axios({ url: '/x', method: 'post' }) / request({ url: ... })
    const urlRe = /\burl\s*:\s*(['"`])([^'"`\n]+)\1/gi
    while ((m = urlRe.exec(line))) {
      const windowText = lines.slice(Math.max(0, i - 8), i + 8).join(' ')
      if (!/\b(axios|request|http|service|api|instance|client|fetch)\s*\(/.test(windowText)) continue
      const sameLine = line.match(/\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/)
      const nearby = windowText.match(/\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/)
      push(i, (sameLine || nearby || [])[2] || '', m[2], 'object')
    }
  }
  return calls
}

function walk(root, options, state) {
  const stack = [root]
  while (stack.length) {
    if (state.files.length >= options.maxFiles) break
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (state.files.length >= options.maxFiles) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!options.extensions.includes(ext)) continue
      if (entry.name.endsWith('.min.js')) continue
      try {
        const stat = fs.statSync(full)
        if (stat.size > options.maxFileSize) continue
        state.files.push(full)
      } catch {
        /* 忽略不可读文件 */
      }
    }
  }
}

/** 扫描目录，返回调用点（不包含接口匹配） */
export function scanDirectory(root, options = {}) {
  const resolved = path.resolve(String(root || ''))
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error(`代码目录不存在或不是文件夹：${resolved}`)

  const opts = {
    extensions: DEFAULT_EXTENSIONS,
    maxFiles: 3000,
    maxFileSize: 2 * 1024 * 1024,
    ...options,
    extensions: (options.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS).map((e) =>
      e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`
    ),
  }
  const state = { files: [] }
  walk(resolved, opts, state)
  state.files.sort()

  const calls = []
  const files = []
  for (const file of state.files) {
    let content
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const relFile = path.relative(resolved, file).split(path.sep).join('/')
    const found = collectCallsInFile(content, relFile, resolved)
    if (found.length) {
      calls.push(...found)
      files.push({ path: relFile, calls: found.length })
    }
  }
  calls.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))

  return { root: resolved, scannedFiles: state.files.length, files, calls }
}

/** 把调用点匹配到项目已绑定的接口 */
export function matchCalls(calls, interfaces) {
  const pool = (interfaces || []).map((it) => ({
    ...it,
    normalized: normalizeApiPath(it.path),
    segs: segments(it.path),
  }))
  return calls.map((call) => {
    let best = null
    let bestScore = 0
    for (const it of pool) {
      if (call.method && it.method !== call.method) continue
      const score = matchScore(it.path, call.path)
      if (score > bestScore || (score === bestScore && best && it.path.length < best.path.length)) {
        best = it
        bestScore = score
      }
    }
    const confidence = bestScore >= 90 ? 'high' : bestScore >= 70 ? 'medium' : bestScore > 0 ? 'low' : ''
    return {
      ...call,
      matched: Boolean(best && bestScore >= 60),
      matchedInterfaceId: best && bestScore >= 60 ? best.id : '',
      matchedInterfaceName: best && bestScore >= 60 ? best.name : '',
      matchedFolder: best && bestScore >= 60 ? best.folder || '' : '',
      score: bestScore,
      confidence: best && bestScore >= 60 ? confidence : '',
      matchSource: 'auto',
    }
  })
}

function groupKeyFor(call, interfaceMap) {
  if (call.matchedInterfaceId) {
    const it = interfaceMap.get(call.matchedInterfaceId)
    const folder = it?.folder || ''
    if (folder) return { key: `folder:${folder}`, name: folder, source: 'apifox-folder' }
    const seg = (it?.path || call.path).split('/').filter(Boolean)[0] || 'root'
    return { key: `segment:${seg}`, name: `${seg} 接口组`, source: 'path-segment' }
  }
  const parts = call.file.split('/').filter(Boolean)
  const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0] || 'root'
  return { key: `code:${dir}`, name: `${dir}（未匹配）`, source: 'code-dir' }
}

/** 业务功能分组：优先 Apifox 目录，其次接口路径段 / 代码目录 */
export function buildGroups(calls, interfaces) {
  const interfaceMap = new Map((interfaces || []).map((it) => [it.id, it]))
  const groups = new Map()
  for (const call of calls) {
    const meta = groupKeyFor(call, interfaceMap)
    let group = groups.get(meta.key)
    if (!group) {
      group = {
        key: meta.key,
        name: meta.name,
        source: meta.source,
        callIds: [],
        interfaceIds: [],
        files: [],
        matchedCalls: 0,
        unmatchedCalls: 0,
      }
      groups.set(meta.key, group)
    }
    group.callIds.push(call.id)
    if (!group.files.includes(call.file)) group.files.push(call.file)
    if (call.matchedInterfaceId) {
      group.matchedCalls++
      if (!group.interfaceIds.includes(call.matchedInterfaceId)) group.interfaceIds.push(call.matchedInterfaceId)
    } else {
      group.unmatchedCalls++
    }
  }
  const list = [...groups.values()].map((g) => ({
    ...g,
    fileCount: g.files.length,
    callCount: g.callIds.length,
    nodeCount: g.interfaceIds.length,
    matched: g.interfaceIds.length > 0,
  }))
  list.sort((a, b) => Number(b.matched) - Number(a.matched) || b.callCount - a.callCount)
  return list
}

/** 扫描 + 匹配 + 分组一步到位 */
export function analyzeProject(root, interfaces, options = {}) {
  const scan = scanDirectory(root, options)
  const calls = matchCalls(scan.calls, interfaces)
  const groups = buildGroups(calls, interfaces)
  const matchedCalls = calls.filter((c) => c.matched).length
  const interfaceIds = [...new Set(calls.filter((c) => c.matched).map((c) => c.matchedInterfaceId))]
  return {
    root: scan.root,
    scannedAt: Date.now(),
    scannedFiles: scan.scannedFiles,
    filesWithCalls: scan.files.length,
    files: scan.files,
    callCount: calls.length,
    matchedCalls,
    unmatchedCalls: calls.length - matchedCalls,
    matchRate: calls.length ? Math.round((matchedCalls / calls.length) * 100) : 0,
    matchedInterfaces: interfaceIds.length,
    calls: calls.slice(0, 1200),
    groups,
  }
}
