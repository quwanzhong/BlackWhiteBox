/**
 * import 说明符 → 工程内文件（M3'-2）。
 *
 * 只解析「文件到文件」这一层：不做 package.json exports / tsconfig paths 的完整实现，
 * 但覆盖前端工程最常见写法（相对路径、`@/`、`~/`、省略扩展名、目录 index）。
 * 解析不到的一律返回 null，由上层记为 low 置信度断链，绝不猜。
 */
import path from 'node:path'

const CANDIDATE_EXTS = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.mjs', '.cjs']

export function stripQuery(spec) {
  return String(spec || '').split(/[?#]/)[0]
}

export function isRelative(spec) {
  return /^\.{1,2}\//.test(spec)
}

/** 别名前缀 → 工程内相对目录（以 root 为基准） */
export function aliasBase(spec) {
  if (spec.startsWith('@/')) return { base: 'src/', rest: spec.slice(2) }
  if (spec.startsWith('~/')) return { base: '', rest: spec.slice(2) }
  if (spec.startsWith('~~/')) return { base: '', rest: spec.slice(3) }
  return null
}

/**
 * @param {string} root 工程根目录（绝对）
 * @param {Set<string>} knownFiles 已收集到的相对路径（posix 分隔）
 */
export function createResolver(root, knownFiles) {
  const cache = new Map()

  function exists(rel) {
    return knownFiles.has(rel)
  }

  function candidates(rel) {
    const out = []
    const ext = path.posix.extname(rel)
    const push = (p) => {
      const clean = p.replace(/^\/+/, '').replace(/\/{2,}/g, '/')
      if (clean && !out.includes(clean)) out.push(clean)
    }
    if (ext) push(rel)
    else {
      for (const e of CANDIDATE_EXTS) push(`${rel}${e}`)
      for (const e of CANDIDATE_EXTS) push(`${rel}/index${e}`)
    }
    return out
  }

  function lookup(rel) {
    for (const c of candidates(rel)) if (exists(c)) return c
    return null
  }

  return function resolve(fromFile, specifier) {
    const raw = stripQuery(specifier)
    if (!raw) return null
    const key = `${fromFile}|${raw}`
    if (cache.has(key)) return cache.get(key)

    let target = null
    if (isRelative(raw)) {
      const dir = path.posix.dirname(fromFile)
      const joined = path.posix.normalize(path.posix.join(dir, raw))
      if (!joined.startsWith('..')) target = lookup(joined)
    } else {
      const alias = aliasBase(raw)
      if (alias) target = lookup(`${alias.base}${alias.rest}`)
      else if (raw.startsWith('/')) target = lookup(raw.slice(1))
      // 裸模块（vue / axios / lodash）属于 node_modules，不是工程内文件
    }

    cache.set(key, target)
    return target
  }
}
