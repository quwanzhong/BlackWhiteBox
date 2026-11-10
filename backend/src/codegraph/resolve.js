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

/** 别名前缀 → 工程内候选目录（以 root 为基准，按顺序尝试） */
export function aliasBases(spec) {
  // `@/` 默认按 Vue CLI 约定指向 `src/`；但输研 1.0 这类工程根本没有 src/，
  // 代码就在根目录（views/ api/ components/）。只认 src/ 会让 116 条 import
  // 全部解析失败、调用链整片断开——所以 src/ 找不到时必须回落到工程根。
  if (spec.startsWith('@/')) return { bases: ['src/', ''], rest: spec.slice(2) }
  if (spec.startsWith('~~/')) return { bases: [''], rest: spec.slice(3) }
  if (spec.startsWith('~/')) return { bases: [''], rest: spec.slice(2) }
  return null
}

const IN_PROJECT_SOURCE = /^(\.{1,2}\/|@\/|~\/|~~\/)/

/** 这段 import 是否「本该解析到工程内文件」（用于断链统计，裸包名不算） */
export function isInProjectSpecifier(spec) {
  return IN_PROJECT_SOURCE.test(spec)
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

  /**
   * 单体仓库常见写法：工程用自己的包名当别名（输研 1.0 的 `@transfusion-research-web/api/x.js`）。
   * 只做「有证据」的解析——去掉 scope 后的路径必须真能在工程根下找到文件，
   * 所以 `@commonlib/...` / `@element-plus/icons-vue` 这类外部包不会被误认成工程内文件。
   */
  function scopedFallback(raw) {
    const m = /^@[^/]+\/(.+)$/.exec(raw)
    if (!m) return null
    const rest = m[1]
    if (!rest.includes('/') && !/\.\w{2,4}$/.test(rest)) return null
    return lookup(rest)
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
      const alias = aliasBases(raw)
      if (alias) {
        for (const base of alias.bases) {
          target = lookup(`${base}${alias.rest}`)
          if (target) break
        }
      } else if (raw.startsWith('/')) target = lookup(raw.slice(1))
      else target = scopedFallback(raw)
      // 裸模块（vue / axios / lodash）属于 node_modules，不是工程内文件
    }

    cache.set(key, target)
    return target
  }
}
