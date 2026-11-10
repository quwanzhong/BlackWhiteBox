/**
 * 单文件事实提取（M3'-2 · W1）：imports / functions / call sites / exports / 模板绑定。
 *
 * 只产出「事实」，不做跨文件解析；跨文件绑定解析在 build.js。
 * 行号统一加上 `.vue` script 块的 lineOffset，保证与 scanner 的 `文件:行` 口径一致。
 */
import { nameOf, paramNames, walk } from './walker.js'
import { looksLikePath, normalizeApiPath, METHOD_NAMES } from './util.js'

const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
])

const GLOBAL_CALLEES = new Set([
  'console', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise',
  'Set', 'Map', 'WeakMap', 'WeakSet', 'Reflect', 'Symbol', 'RegExp', 'Error', 'parseInt',
  'parseFloat', 'isNaN', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone',
  'require', 'defineComponent', 'defineProps', 'defineEmits', 'defineExpose', 'defineOptions',
  'withDefaults', 'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'nextTick', 'onMounted',
  'onUnmounted', 'onBeforeUnmount', 'inject', 'provide', 'useRouter', 'useRoute', 'useStore',
  'createApp', 'h', 'toRefs', 'toRef', 'unref', 'markRaw', 'shallowRef', 'effectScope',
])

function snippetOf(lines, line) {
  const text = lines[line - 1] || ''
  return text.trim().slice(0, 240)
}

/** 从变量声明 / 属性 / 赋值里推函数名 */
function fnNameFromParent(node, parent) {
  if (node.key) return nameOf(node.key) || ''
  if (node.id?.name) return node.id.name
  if (!parent) return ''
  switch (parent.type) {
    case 'VariableDeclarator':
      return nameOf(parent.id) || ''
    case 'ObjectProperty':
    case 'ObjectMethod':
    case 'ClassProperty':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
      return nameOf(parent.key) || ''
    case 'AssignmentExpression':
      return nameOf(parent.left) || ''
    case 'ExportDefaultDeclaration':
      return 'default'
    default:
      return ''
  }
}

function literalValue(node) {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') {
    // `${BASE_URL}/trs/x` 这类模板串：整体是 '{}'+'/trs/x'，不是合法路径，
    // 但后半段字面量就是真实接口路径（scanner 也是这么取的）。
    const parts = node.quasis.map((q) => q.value?.cooked ?? '')
    const joined = parts.join('{}')
    const hit = [joined, ...parts].find((v) => looksLikePath(v))
    return hit !== undefined ? hit : joined
  }
  return null
}

/** 对象字面量的静态键集（W2 会用它和契约做对比） */
function objectKeys(node) {
  if (!node || node.type !== 'ObjectExpression') return []
  const keys = []
  for (const prop of node.properties || []) {
    if (prop.type === 'SpreadElement') {
      keys.push('…')
      continue
    }
    const key = nameOf(prop.key)
    if (key) keys.push(key)
  }
  return keys
}

function describeArg(node) {
  const value = literalValue(node)
  if (value !== null) return { type: 'literal', value }
  if (!node) return { type: 'empty' }
  if (node.type === 'ObjectExpression') return { type: 'object', keys: objectKeys(node) }
  if (node.type === 'ArrayExpression') return { type: 'array', size: node.elements.length }
  if (node.type === 'Identifier') return { type: 'ref', name: node.name }
  if (node.type === 'CallExpression') return { type: 'call', name: nameOf(node.callee) || 'dynamic' }
  return { type: 'other', kind: node.type }
}

function methodFromObject(node) {
  if (!node || node.type !== 'ObjectExpression') return ''
  for (const prop of node.properties || []) {
    if (prop.type !== 'ObjectProperty') continue
    if (nameOf(prop.key) !== 'method') continue
    const value = literalValue(prop.value)
    if (value) return String(value).toUpperCase()
  }
  return ''
}

/** 从对象实参里找 url / path 字段（只认字面量） */
function urlFromObject(node) {
  if (!node || node.type !== 'ObjectExpression') return ''
  for (const prop of node.properties || []) {
    if (prop.type !== 'ObjectProperty') continue
    const key = nameOf(prop.key)
    if (key !== 'url' && key !== 'path' && key !== 'api') continue
    const value = literalValue(prop.value)
    if (value && looksLikePath(value)) return value
  }
  return ''
}

/**
 * 取「业务参数键集」（W2 的 A 侧输入）。
 *
 * `request({ url, method, params: {...}, data: {...} })` 里 url/method 是传输配置，
 * 真正参与契约对比的是 params/data；直接传业务对象的 `getPageList({ billCode })`
 * 则整个对象就是参数。混在一起会让 W2 把 'url' 当成业务漏传。
 */
function extractParamKeys(node) {
  const query = []
  const body = []
  const payload = []
  if (!node || node.type !== 'ObjectExpression') return { query, body, payload }
  const transport = new Set([
    'url', 'path', 'method', 'headers', 'timeout', 'responseType', 'baseURL', 'data', 'body', 'query', 'params',
  ])
  for (const prop of node.properties || []) {
    if (prop.type === 'SpreadElement') {
      payload.push('…')
      continue
    }
    const key = nameOf(prop.key)
    if (!key) continue
    if (key === 'params' || key === 'query') {
      for (const k of objectKeys(prop.value)) query.push(k)
      continue
    }
    if (key === 'data' || key === 'body') {
      for (const k of objectKeys(prop.value)) body.push(k)
      continue
    }
    if (!transport.has(key)) payload.push(key)
  }
  return { query, body, payload }
}

/**
 * 提取一个解析单元。
 * @returns {{functions: object[], imports: object[], calls: object[], exportPairs: object[], defaultExport: object|null, moduleFn: object}}
 */
export function extractUnit(unit, relFile, lines, options = {}) {
  const { ast, lineOffset = 0 } = unit
  const functions = []
  const imports = []
  const calls = []
  const exportPairs = []
  const seenFnIds = new Set()
  const fnStack = []
  const localFns = new Map()
  const callIds = new Set()

  const moduleFn = {
    id: `${relFile}#<module>@1`,
    file: relFile,
    line: 1,
    name: '<module>',
    params: [],
    async: false,
    module: true,
    exported: false,
  }
  let defaultDeclaration = null
  let syntheticDefault = null
  let callIndex = 0

  const createFn = (node, parent) => {
    const line = (node.loc?.start.line || 1) + lineOffset
    const name = fnNameFromParent(node, parent) || 'anonymous'
    let id = `${relFile}#${name}@${line}`
    let n = 2
    while (seenFnIds.has(id)) id = `${relFile}#${name}@${line}~${n++}`
    seenFnIds.add(id)
    const fn = {
      id,
      file: relFile,
      line,
      endLine: (node.loc?.end.line || node.loc?.start.line || 1) + lineOffset,
      name,
      params: paramNames(node.params),
      async: Boolean(node.async),
      module: false,
      // 直接声明在模块作用域（含 `<script setup>` 顶层）：入口模块可达它，无需调用边证明
      topLevel: fnStack.length === 0,
      // 词法父函数：回调（`ids.forEach((id) => ...)`）没有任何调用边，
      // 只能靠「声明在谁里面」证明可达，否则链路断在匿名函数上。
      parentFnId: fnStack.length ? fnStack[fnStack.length - 1].id : moduleFn.id,
      exported: false,
    }
    functions.push(fn)
    if (!localFns.has(name)) localFns.set(name, id)
    return fn
  }

  walk(
    ast,
    (node, parent) => {
      switch (node.type) {
        case 'ImportDeclaration': {
          const source = node.source?.value || ''
          for (const spec of node.specifiers || []) {
            const kind =
              spec.type === 'ImportDefaultSpecifier'
                ? 'default'
                : spec.type === 'ImportNamespaceSpecifier'
                  ? 'namespace'
                  : 'named'
            imports.push({
              file: relFile,
              source,
              local: spec.local?.name || '',
              imported: kind === 'default' ? 'default' : kind === 'namespace' ? '*' : nameOf(spec.imported),
              kind,
              line: (node.loc?.start.line || 1) + lineOffset,
            })
          }
          return false
        }
        case 'ExportNamedDeclaration': {
          if (node.declaration) {
            const decl = node.declaration
            if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
              exportPairs.push({ local: decl.id.name, exported: decl.id.name })
            } else if (decl.type === 'VariableDeclaration') {
              for (const d of decl.declarations || []) {
                const local = nameOf(d.id)
                if (local && d.init && /Function|Arrow/.test(d.init.type)) {
                  exportPairs.push({ local, exported: local })
                }
              }
            }
          }
          for (const spec of node.specifiers || []) {
            exportPairs.push({ local: nameOf(spec.local), exported: nameOf(spec.exported) })
          }
          return undefined
        }
        case 'ExportDefaultDeclaration': {
          const decl = node.declaration
          defaultDeclaration = {
            line: (node.loc?.start.line || 1) + lineOffset,
            local:
              decl.type === 'FunctionDeclaration'
                ? decl.id?.name || 'default'
                : decl.type === 'Identifier'
                  ? decl.name
                  : decl.type === 'CallExpression'
                    ? ''
                    : 'default',
          }
          return undefined
        }
        default:
          break
      }

      if (FN_TYPES.has(node.type)) {
        const fn = createFn(node, parent)
        fnStack.push(fn)
        return undefined
      }

      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        const callee = node.callee || {}
        let name = ''
        let object = ''
        let dynamic = false
        if (callee.type === 'Identifier') {
          name = callee.name
        } else if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
          object = nameOf(callee.object)
          name = callee.computed ? '' : nameOf(callee.property)
          dynamic = callee.computed
          if (!name) dynamic = true
        } else {
          dynamic = true
        }
        if (!dynamic && (GLOBAL_CALLEES.has(name) || GLOBAL_CALLEES.has(object))) return undefined

        const line = (node.loc?.start.line || 1) + lineOffset
        const args = (node.arguments || []).map(describeArg)
        const literalArgs = (node.arguments || []).map(literalValue)
        let rawPath = literalArgs.find((v) => v && looksLikePath(v)) || ''
        let method = ''
        if (!rawPath && args[0]?.type === 'object') rawPath = urlFromObject(node.arguments[0])
        if (object && METHOD_NAMES.includes(name.toLowerCase())) method = name.toUpperCase()
        if (!method && args[0]?.type === 'object') method = methodFromObject(node.arguments[0])

        let id = `${relFile}@${line}#${callIndex++}`
        while (callIds.has(id)) id = `${relFile}@${line}#${callIndex++}`
        callIds.add(id)

        calls.push({
          id,
          file: relFile,
          line,
          fnId: fnStack.length ? fnStack[fnStack.length - 1].id : moduleFn.id,
          callee: object ? `${object}.${name}` : name,
          name: name || '',
          object,
          dynamic,
          method,
          rawPath,
          path: rawPath ? normalizeApiPath(rawPath) : '',
          paramKeys: extractParamKeys(node.arguments?.[0]),
          args,
          snippet: snippetOf(lines, line),
        })
        return undefined
      }

      return undefined
    },
    (node) => {
      if (FN_TYPES.has(node.type) && fnStack.length) fnStack.pop()
    }
  )

  // 默认导出：函数声明/表达式直接复用；其余（defineComponent(...) / 对象）造一个合成入口
  let defaultExport = null
  if (defaultDeclaration) {
    const { local, line } = defaultDeclaration
    if (local && local !== 'default') {
      const fnId = localFns.get(local)
      if (fnId) defaultExport = { fnId, name: local, line }
    }
    if (!defaultExport) {
      const id = `${relFile}#<default>@${defaultDeclaration.line}`
      syntheticDefault = {
        id,
        file: relFile,
        line,
        name: 'default',
        params: [],
        async: false,
        module: false,
        exported: true,
        synthetic: true,
      }
      functions.push(syntheticDefault)
      localFns.set('default', id)
      defaultExport = { fnId: id, name: 'default', line }
    }
  }

  // 标记导出函数，便于 UI 直接看出「这个函数是对外出口」
  const exportedNames = new Set(exportPairs.map((p) => p.local))
  for (const fn of functions) {
    if (exportedNames.has(fn.name) || fn.synthetic) fn.exported = true
  }

  return {
    functions,
    imports,
    calls,
    exportPairs,
    defaultExport,
    moduleFn,
    localFns,
    template: options.template || [],
  }
}
