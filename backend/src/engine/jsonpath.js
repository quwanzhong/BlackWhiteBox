/**
 * 迷你 JSONPath：支持 $.a.b[0].c 形式的取值，够接口测试用了。
 */

/** "$.list[2].name" → ['list', 2, 'name']（沿用旧实现的宽松拆分） */
export function pathToTokens(path) {
  if (!path || typeof path !== 'string') return []
  const norm = path.replace(/^\$\.?/, '').trim()
  if (!norm) return []
  return norm
    .split('.')
    .flatMap((t) => t.split(/[\[\]]+/))
    .filter((t) => t !== '')
    .map((t) => (/^\d+$/.test(t) ? Number(t) : t))
}

/** 按 token 数组取值；任一层为 null/undefined 就返回 undefined */
export function resolveTokens(obj, tokens) {
  let cur = obj
  for (const tk of tokens || []) {
    if (cur == null) return undefined
    cur = cur[tk]
  }
  return cur
}

/**
 * @param {*} obj 根对象
 * @param {string} path 如 "$.data.token"、"$"、"$.list[2].name"
 */
export function resolvePath(obj, path) {
  return resolveTokens(obj, pathToTokens(path))
}

/**
 * 变量替换：把对象里所有字符串中的 {{varName}} 替换为变量表里的值。
 * 整串恰为一个变量时保留原类型（数字/对象等），否则替换为字符串。
 * @param {*} value 任意结构
 * @param {Record<string, *>} vars 变量表
 */
export function substitute(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*(\w+)\s*\}\}$/)
    if (whole) return vars[whole[1]] !== undefined ? vars[whole[1]] : value
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (s, k) =>
      vars[k] !== undefined ? String(vars[k]) : s
    )
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars)
    return out
  }
  return value
}
