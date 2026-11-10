/**
 * 自写 AST walker（M3'-2）。
 *
 * 只做「深度优先遍历 + 进出回调」，不带 scope 绑定分析：
 * 我们需要的绑定解析（import 到文件、同文件函数）用文件级映射就够，
 * 引入 `@babel/traverse` 会为了用不到的 scope 付出体积和复杂度。
 */
const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'errors',
])

function isNode(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.type === 'string'
}

/**
 * @param {object} node 起始节点
 * @param {(node, parent) => false|void} enter 返回 false 跳过子节点
 * @param {(node, parent) => void} [exit] 离开节点（不论是否跳过子节点都会调用）
 */
export function walk(node, enter, exit = null, parent = null) {
  if (!isNode(node)) return
  const descended = enter ? enter(node, parent) : undefined
  if (descended !== false) {
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) walk(child, enter, exit, node)
      } else if (isNode(value)) {
        walk(value, enter, exit, node)
      }
    }
  }
  if (exit) exit(node, parent)
}

/** 从任意表达式里拿出「名字」：Identifier / StringLiteral / MemberExpression 的属性名 */
export function nameOf(node) {
  if (!node) return ''
  switch (node.type) {
    case 'Identifier':
    case 'PrivateName':
      return node.name || node.id?.name || ''
    case 'StringLiteral':
    case 'NumericLiteral':
      return String(node.value)
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (!node.computed) return nameOf(node.property)
      return nameOf(node.property)
    case 'JSXIdentifier':
      return node.name || ''
    case 'ObjectProperty':
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassProperty':
      return nameOf(node.key)
    default:
      return ''
  }
}

/** 参数名列表（解构参数回退成类型名，便于展示而不是丢空） */
export function paramNames(params = []) {
  return params
    .map((p) => {
      if (!p) return ''
      if (p.type === 'AssignmentPattern') return nameOf(p.left) || paramNames([p.left])[0] || ''
      if (p.type === 'RestElement') return nameOf(p.argument)
      if (p.type === 'Identifier') return p.name
      if (p.type === 'ObjectPattern') return '{…}'
      if (p.type === 'ArrayPattern') return '[…]'
      return nameOf(p) || p.type
    })
    .filter(Boolean)
}
