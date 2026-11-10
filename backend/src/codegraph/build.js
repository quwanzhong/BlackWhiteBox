/**
 * 调用图构建（M3'-2 · W1）。
 *
 * 输入：工程根目录 + scanner 产物（`calls[]`，即 CallSite 的事实来源）。
 * 输出：`{ nodes, edges, entries, endpoints, stats }`，供 W1 反查与 W2 参数对比使用。
 *
 * 三条硬约束（docs/05 §2.2）：
 * 1) 回溯 6 层、单接口 ≤ 20 条链路、总节点 ≤ 20000，超限必须显式 `truncated`；
 * 2) 解析不到的边标 `low` 并进「人工关联」，绝不显示成「无调用方」；
 * 3) `.vue` 只喂 `<script>` 块，行号按块偏移还原，与 scanner 的 `文件:行` 一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { listSourceFiles, matchScore } from '../projects/scanner.js'
import { extractUnit } from './extract.js'
import { parseFile } from './parse.js'
import { createResolver, isInProjectSpecifier } from './resolve.js'
import { nameOf, walk } from './walker.js'

const DEFAULTS = {
  maxFiles: 5000,
  maxNodes: 20000,
  maxDepth: 6,
  maxChainsPerEndpoint: 20,
  maxUnresolved: 300,
}

const RANK = { high: 3, medium: 2, low: 1 }
const MIN_RANK = { 3: 'high', 2: 'medium', 1: 'low' }

/**
 * 合并构建参数：显式 `undefined / null` 不得覆盖默认值。
 *
 * `{ ...DEFAULTS, ...{ maxDepth: undefined } }` 会把上限变成 undefined，
 * 回溯循环条件 `results.length < undefined` 直接为假 —— 表现为
 * 「图构建成功但一条链路都没有」，是最难排查的一类静默失败。
 */
function resolveOptions(input = {}) {
  const out = { ...DEFAULTS }
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) out[key] = Math.floor(num)
  }
  return out
}

export function weakest(a, b) {
  const ra = RANK[a] || 0
  const rb = RANK[b] || 0
  if (!ra) return b
  if (!rb) return a
  return MIN_RANK[Math.min(ra, rb)]
}

/** 文件角色：页面 / 组件 / store / api / 路由 / 其他 */
export function classifyFile(relFile) {
  const p = String(relFile).toLowerCase()
  if (/(^|\/)(router|routes)\//.test(p)) return 'router'
  if (/(^|\/)(views|pages)\//.test(p)) {
    // views 下面的 dialog / components 子目录是「页面用到的组件」，不是入口页面；
    // 否则每个弹窗都会变成入口，接口链路会错误地「回溯到自己」。
    if (/(^|\/)(dialog|dialogs|components|modals?|popups?)\//.test(p)) return 'component'
    return 'page'
  }
  if (/(^|\/)(api|apis|service|services)\//.test(p)) return 'api'
  if (/(^|\/)(store|stores|pinia)\//.test(p)) return 'store'
  if (p.endsWith('.vue')) return 'component'
  return 'other'
}

/** scanner 匹配得分 → 调用点置信度（人工关联视为已确认） */
export function callSiteConfidence(call) {
  if (call.matchSource === 'manual') return 'high'
  if (call.confidence === 'high' || call.score >= 90) return 'high'
  if (call.confidence === 'medium' || call.score >= 70) return 'medium'
  return call.matchedInterfaceId ? 'low' : 'low'
}

function literalValue(node) {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions?.length === 0) {
    return node.quasis.map((q) => q.value?.cooked ?? '').join('')
  }
  return null
}

function propOf(objectNode, key) {
  for (const prop of objectNode?.properties || []) {
    if (prop.type === 'ObjectProperty' && nameOf(prop.key) === key) return prop.value
  }
  return null
}

/** 从 `component: () => import('...')` / `component: Layout` 里取目标文件 */
function componentTarget(compNode, file, resolver, bindingMap) {
  if (!compNode) return null
  if (compNode.type === 'Identifier') {
    const binding = bindingMap.get(`${file}|${compNode.name}`)
    return binding?.targetFile || null
  }
  let target = null
  walk(compNode, (node) => {
    if (target) return false
    if (node.type !== 'CallExpression') return undefined
    if (node.callee?.type !== 'Import') return undefined
    const spec = literalValue(node.arguments?.[0])
    if (spec) target = resolver(file, spec)
    return undefined
  })
  return target
}

/**
 * 构建调用图。
 * @param {string} root 前端工程根目录
 * @param {{calls?: object[], interfaces?: object[], options?: object}} input
 */
export function buildCodeGraph(root, input = {}) {
  const startedAt = Date.now()
  const options = resolveOptions(input.options)
  const scannerCalls = input.calls || []
  const interfaces = input.interfaces || []
  // scanner 把 calls 截断在 1200 条（控制项目文档体积）。图必须如实反映"只分析了这部分"，
  // 否则大工程会得到一个看起来完整、实则漏了尾部的调用链视图。
  const callSitesTotal = Math.max(Number(input.totalCalls) || 0, scannerCalls.length)
  const callSiteCapped = callSitesTotal > scannerCalls.length

  const { root: resolvedRoot, files: absFiles } = listSourceFiles(root, { maxFiles: options.maxFiles })
  const knownFiles = new Set(
    absFiles.map((abs) => path.relative(resolvedRoot, abs).split(path.sep).join('/'))
  )
  const resolve = createResolver(resolvedRoot, knownFiles)

  const records = []
  const parseErrors = []
  const skippedFiles = []
  let remainingNodes = options.maxNodes
  let truncated = false

  for (const abs of absFiles) {
    const relFile = path.relative(resolvedRoot, abs).split(path.sep).join('/')
    let source = ''
    try {
      source = fs.readFileSync(abs, 'utf8')
    } catch {
      skippedFiles.push({ file: relFile, reason: 'unreadable' })
      continue
    }
    const parsed = parseFile(relFile, source, abs)
    for (const err of parsed.errors) parseErrors.push(err)
    if (!parsed.units.length) {
      records.push({
        file: relFile,
        kind: classifyFile(relFile),
        functions: [],
        imports: [],
        calls: [],
        template: parsed.template,
        components: parsed.components || [],
        units: [],
        defaultExport: null,
        moduleFn: null,
        localFns: new Map(),
        errors: parsed.errors,
      })
      continue
    }
    const lines = source.split(/\r?\n/)
    const fns = []
    const imports = []
    const calls = []
    const exportPairs = []
    let defaultExport = null
    let moduleFn = null
    const localFns = new Map()

    for (const unit of parsed.units) {
      const extracted = extractUnit(unit, relFile, lines, { template: parsed.template })
      fns.push(...extracted.functions)
      imports.push(...extracted.imports)
      calls.push(...extracted.calls)
      exportPairs.push(...extracted.exportPairs)
      if (extracted.defaultExport) defaultExport = extracted.defaultExport
      if (!moduleFn) moduleFn = extracted.moduleFn
      for (const [name, id] of extracted.localFns) if (!localFns.has(name)) localFns.set(name, id)
    }

    // 节点预算：显式截断，并把跳过的文件列出来（绝不静默）
    const cost = 1 + fns.length + calls.length
    if (cost > remainingNodes) {
      truncated = true
      skippedFiles.push({ file: relFile, reason: 'node-budget' })
      continue
    }
    remainingNodes -= cost

    records.push({
      file: relFile,
      kind: classifyFile(relFile),
      functions: fns,
      imports,
      calls,
      template: parsed.template,
      components: parsed.components || [],
      units: parsed.units,
      defaultExport,
      moduleFn: moduleFn || { id: `${relFile}#<module>@1`, file: relFile, line: 1, name: '<module>', params: [], module: true },
      localFns,
      exportPairs,
      errors: parsed.errors,
    })
  }

  // ---------------------------------------------------------------- 节点
  const fnById = new Map()
  const fnNodes = []
  const fileNodes = []
  const bindingMap = new Map()
  const importEdges = []
  const exportMaps = new Map()
  // 本该指向工程内、却没解析到的 import（`@/api/x`、`./y`）。
  // 裸包名（vue / axios）属于 node_modules，不算断链，否则噪音会淹没真问题。
  const unresolvedImports = []

  for (const rec of records) {
    for (const fn of rec.functions) {
      fnById.set(fn.id, fn)
      fnNodes.push(fn)
    }
    if (rec.moduleFn) {
      fnById.set(rec.moduleFn.id, rec.moduleFn)
      fnNodes.push(rec.moduleFn)
    }
  }

  for (const rec of records) {
    // 导出表：导出名 → 函数 id
    const exp = new Map()
    for (const pair of rec.exportPairs || []) {
      const id = rec.localFns.get(pair.local)
      if (id) exp.set(pair.exported, id)
    }
    if (rec.defaultExport?.fnId) exp.set('default', rec.defaultExport.fnId)
    exportMaps.set(rec.file, exp)

    for (const imp of rec.imports) {
      const targetFile = resolve(rec.file, imp.source)
      if (!targetFile) {
        if (isInProjectSpecifier(imp.source) && unresolvedImports.length < options.maxUnresolved) {
          unresolvedImports.push({ file: rec.file, line: imp.line, source: imp.source, local: imp.local, reason: 'import-unresolved' })
        }
        continue
      }
      bindingMap.set(`${rec.file}|${imp.local}`, { targetFile, imported: imp.imported, kind: imp.kind })
      importEdges.push({
        type: 'imports',
        from: rec.file,
        to: targetFile,
        binding: imp.imported,
        localName: imp.local,
        kind: imp.kind,
        line: imp.line,
      })
    }

    fileNodes.push({
      id: rec.file,
      kind: rec.kind,
      type: 'File',
      exports: [...(exportMaps.get(rec.file)?.keys() || [])],
      parseError: rec.errors?.[0]?.message || '',
      functionCount: rec.functions.length,
      callCount: rec.calls.length,
    })
  }

  // ---------------------------------------------------------------- calls 边
  const callEdges = []
  const unresolved = []
  const edgeIndex = new Map()

  const pushEdge = (from, to, confidence, via, line, type = 'calls') => {
    if (!from || !to || from === to) return
    const key = `${type}|${from}|${to}`
    const existing = edgeIndex.get(key)
    if (existing) {
      existing.confidence = weakest(existing.confidence, confidence)
      if (line && !existing.lines.includes(line)) existing.lines.push(line)
      return
    }
    const edge = { type, from, to, confidence, via, lines: line ? [line] : [] }
    edgeIndex.set(key, edge)
    callEdges.push(edge)
  }

  const resolveCallee = (file, call) => {
    if (call.dynamic) return { confidence: 'low', reason: 'dynamic' }
    if (call.object) {
      if (call.object === 'this') {
        const id = recordOf(file)?.localFns.get(call.name)
        return id ? { fnId: id, confidence: 'high' } : { confidence: 'low', reason: 'this-unresolved' }
      }
      const binding = bindingMap.get(`${file}|${call.object}`)
      if (!binding) return null
      const exp = exportMaps.get(binding.targetFile)
      const id = exp?.get(call.name) || (binding.imported !== '*' ? exp?.get(binding.imported) : '')
      if (id) return { fnId: id, confidence: binding.kind === 'named' ? 'high' : 'medium' }
      return { confidence: 'low', reason: 'member-unresolved', targetFile: binding.targetFile }
    }
    const local = recordOf(file)?.localFns.get(call.name)
    if (local) return { fnId: local, confidence: 'high' }
    const binding = bindingMap.get(`${file}|${call.name}`)
    if (binding) {
      const exp = exportMaps.get(binding.targetFile)
      const id = exp?.get(binding.imported === 'default' ? 'default' : binding.imported)
      if (id) return { fnId: id, confidence: binding.kind === 'named' ? 'high' : 'medium' }
      return { confidence: 'low', reason: 'import-unresolved', targetFile: binding.targetFile }
    }
    return null
  }

  const recordByFile = new Map(records.map((r) => [r.file, r]))
  function recordOf(file) {
    return recordByFile.get(file)
  }

  for (const rec of records) {
    for (const call of rec.calls) {
      const resolved = resolveCallee(rec.file, call)
      if (resolved?.fnId) {
        pushEdge(call.fnId, resolved.fnId, resolved.confidence, 'ast', call.line)
      } else if (resolved && unresolved.length < options.maxUnresolved) {
        unresolved.push({
          file: rec.file,
          line: call.line,
          fnId: call.fnId,
          callee: call.callee,
          reason: resolved.reason,
          targetFile: resolved.targetFile || '',
        })
      }
    }
  }

  // ---------------------------------------------------------------- 模板绑定边
  const entryFnOfFile = (file) => {
    const rec = recordOf(file)
    return rec?.defaultExport?.fnId || rec?.moduleFn?.id || ''
  }

  for (const rec of records) {
    if (!rec.template?.length) continue
    const from = entryFnOfFile(rec.file)
    if (!from) continue
    for (const t of rec.template) {
      const target = rec.localFns.get(t.name)
      if (target) pushEdge(from, target, 'medium', 'template', t.line)
      else if (unresolved.length < options.maxUnresolved) {
        unresolved.push({ file: rec.file, line: t.line, fnId: from, callee: `${t.event}:${t.name}`, reason: 'template-unresolved' })
      }
    }
  }

  // ---------------------------------------------------------------- 入口
  const entries = []
  for (const rec of records) {
    if (!rec.units?.length) continue
    for (const unit of rec.units) {
      walk(unit.ast, (node) => {
        if (node.type !== 'ObjectExpression') return undefined
        const pathNode = propOf(node, 'path')
        const compNode = propOf(node, 'component')
        if (!pathNode || !compNode) return undefined
        const route = literalValue(pathNode)
        if (route === null) return undefined
        const target = componentTarget(compNode, rec.file, resolve, bindingMap)
        if (!target) return undefined
        const meta = propOf(node, 'meta')
        const title = meta?.type === 'ObjectExpression' ? literalValue(propOf(meta, 'title')) : null
        entries.push({
          route: String(route),
          file: target,
          fnId: entryFnOfFile(target),
          name: title || (propOf(node, 'name') ? literalValue(propOf(node, 'name')) : '') || String(route),
          line: (node.loc?.start.line || 1) + (unit.lineOffset || 0),
          via: 'router',
        })
        return undefined
      })
    }
  }

  const routedFiles = new Set(entries.map((e) => e.file))
  for (const rec of records) {
    if (rec.kind !== 'page') continue
    if (routedFiles.has(rec.file)) continue
    const fnId = entryFnOfFile(rec.file)
    if (!fnId) continue
    // 路由表拿不到时的兜底入口：`views/bill/index.vue` 用目录名当入口名，
    // 否则一屏全是 `index`，人工核对时分不清是哪个页面。
    const base = path.posix.basename(rec.file).replace(/\.\w+$/, '')
    const parent = path.posix.basename(path.posix.dirname(rec.file))
    entries.push({
      route: '',
      file: rec.file,
      fnId,
      name: /^index$/i.test(base) && parent ? parent : base,
      line: 1,
      via: 'views-fallback',
    })
  }

  // App.vue 是被 main.js 挂载的根组件：它是真正的入口，不该因为没有路由表就被当成孤儿。
  for (const rec of records) {
    if (!/(^|\/)App\.vue$/i.test(rec.file)) continue
    const fnId = entryFnOfFile(rec.file)
    if (!fnId) continue
    entries.push({ route: '', file: rec.file, fnId, name: 'App', line: 1, via: 'app-root' })
  }
  const entryByFn = new Map()
  for (const entry of entries) {
    if (entry.fnId) entryByFn.set(entry.fnId, entry)
    // 进入页面 = 该文件模块作用域先执行。`export default defineComponent({...})` 的页面，
    // 入口 fn 是合成 `<default>`，而回溯常常落在 `<module>` 上——两者必须等价，
    // 否则链路明明走到了页面，却被判成 no-entry（输研 1.0 实测 35 条如此）。
    const moduleId = recordOf(entry.file)?.moduleFn?.id
    if (moduleId) entryByFn.set(moduleId, entry)
  }

  // ------------------------------------------------- 组件使用边（父页面 → 子组件）
  // 模板里的 `<PayerDialog />` 不带任何调用语法，但它是 W1 链路唯一的「组件宿主」证据；
  // 没有这类边，弹窗/抽屉子组件里的接口调用永远回溯不到入口，只能显示"无入口链路"。
  const pascal = (name) =>
    name
      .split(/[-_/]/)
      .filter(Boolean)
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join('')

  for (const rec of records) {
    if (!rec.components?.length) continue
    const from = entryFnOfFile(rec.file)
    if (!from) continue
    for (const tag of rec.components) {
      for (const local of [tag.name, pascal(tag.name)]) {
        const binding = bindingMap.get(`${rec.file}|${local}`)
        if (!binding?.targetFile) continue
        const to = entryFnOfFile(binding.targetFile)
        if (!to) continue
        pushEdge(from, to, 'medium', tag.via === 'prop' ? 'component-prop' : 'component', tag.line, 'component')
        break
      }
    }
  }

  // ------------------------------------------------- 作用域边（父作用域 → 声明的函数）
  // `<script setup>` 的顶层函数由模板事件 / 生命周期使用，回调函数由调用方执行，
  // 源码里都没有对应调用语法。缺这类边，`loadList()` / `ids.forEach(() => api())`
  // 回溯到页面入口就断在 no-entry：输研 1.0 实测 161 个调用点全部命中。
  // 这是「可达性」证据而不是调用点，因此单独记为 scope 边（不进 callersOf 的调用方列表）。
  for (const rec of records) {
    for (const fn of rec.functions) {
      const from = fn.parentFnId || rec.moduleFn?.id
      if (!from || from === fn.id) continue
      pushEdge(from, fn.id, 'medium', fn.topLevel ? 'module-scope' : 'closure', fn.line, 'scope')
    }
  }

  // ---------------------------------------------------------------- 调用点触发器
  const astCallsByFile = new Map()
  for (const rec of records) {
    const list = rec.calls.filter((c) => c.path)
    astCallsByFile.set(rec.file, list)
  }

  const triggerByCallId = new Map()
  const triggerEdges = []
  // `/{}//bill/save` 这类是「域名/前缀占位符」被模板串打出来的痕迹，
  // 与 `/bill/save` 指的是同一个接口；比较前先去掉起始占位段。
  const trimPlaceholderPrefix = (p) => String(p || '').replace(/^(?:\/\{\})+/, '')
  for (const call of scannerCalls) {
    if (!call?.id) continue
    const list = astCallsByFile.get(call.file) || []
    let best = null
    for (const c of list) {
      // 同一行/相邻行 + 路径相同是最强证据；模板串前缀差异（`${BASE}/x` vs `/x`）
      // 用 scanner 的路径相似度兜底，避免「调用点明明在，却因为前缀不同断链」。
      const left = trimPlaceholderPrefix(call.path)
      const right = trimPlaceholderPrefix(c.path)
      const exact = Boolean(left) && left === right
      const score = exact ? 100 : left && right ? matchScore(left, right) : 0
      const diff = Math.abs((c.line || 0) - (call.line || 0))
      if (!exact && !(score >= 70 && diff <= 3)) continue
      if (!best || diff < best.diff || (diff === best.diff && score > best.score)) best = { c, diff, score }
    }
    const rec = recordOf(call.file)
    const fnId = best?.c?.fnId || rec?.moduleFn?.id || ''
    const confidence = best && best.diff <= 2 ? callSiteConfidence(call) : 'low'
    if (fnId) {
      // W2（M3'-3）的 A 侧输入：调用点实参的静态形状（业务参数键集 + 实参描述）
      const shape = { args: best?.c?.args || [], paramKeys: best?.c?.paramKeys || null }
      triggerByCallId.set(call.id, { fnId, confidence, ...shape })
      triggerEdges.push({
        type: 'triggers',
        from: fnId,
        callSite: call.id,
        interfaceId: call.matchedInterfaceId || '',
        confidence,
        matchedBy: best && best.diff <= 2 ? 'line' : 'file',
        line: call.line,
        ...shape,
      })
    }
  }

  // ---------------------------------------------------------------- 链路回溯
  const callers = new Map()
  for (const edge of callEdges) {
    if (!callers.has(edge.to)) callers.set(edge.to, [])
    callers.get(edge.to).push(edge)
  }

  const chainsTruncated = { value: false }

  function traceFrom(startFnId, triggerConfidence) {
    const results = []
    const seen = new Set()
    const stack = [{ fnId: startFnId, path: [startFnId], conf: triggerConfidence, reason: '' }]
    while (stack.length && results.length < options.maxChainsPerEndpoint) {
      const cur = stack.pop()
      const entry = entryByFn.get(cur.fnId)
      if (entry) {
        results.push({ ...cur, entry, reason: 'entry' })
        continue
      }
      if (cur.path.length - 1 >= options.maxDepth) {
        // 触到深度上限 = 没有证明到入口，按「断链」降级，不允许保留高置信度
        results.push({ ...cur, entry: null, conf: weakest(cur.conf, 'low'), reason: 'depth-limit' })
        continue
      }
      const ups = callers.get(cur.fnId) || []
      if (!ups.length) {
        results.push({ ...cur, entry: null, conf: weakest(cur.conf, 'low'), reason: 'no-entry' })
        continue
      }
      for (const up of ups) {
        if (cur.path.includes(up.from) || seen.has(`${up.from}|${cur.fnId}`)) continue
        seen.add(`${up.from}|${cur.fnId}`)
        stack.push({
          fnId: up.from,
          path: [...cur.path, up.from],
          conf: weakest(cur.conf, up.confidence),
          reason: '',
        })
      }
    }
    if (stack.length) chainsTruncated.value = true
    return results
  }

  const interfaceById = new Map(interfaces.map((it) => [it.id, it]))
  const callsByInterface = new Map()
  for (const call of scannerCalls) {
    if (!call.matchedInterfaceId) continue
    if (!callsByInterface.has(call.matchedInterfaceId)) callsByInterface.set(call.matchedInterfaceId, [])
    callsByInterface.get(call.matchedInterfaceId).push(call)
  }

  const endpointChains = new Map()
  const chains = []

  for (const [interfaceId, list] of callsByInterface) {
    const collected = []
    for (const call of list) {
      const trigger = triggerByCallId.get(call.id)
      if (!trigger) continue
      const traced = traceFrom(trigger.fnId, trigger.confidence)
      for (const t of traced) {
        if (collected.length >= options.maxChainsPerEndpoint) break
        const chain = {
          interfaceId,
          callSiteId: call.id,
          file: call.file,
          line: call.line,
          fnIds: t.path,
          confidence: t.conf,
          hops: t.path.length - 1,
          reason: t.reason,
          entry: t.entry ? { route: t.entry.route, file: t.entry.file, name: t.entry.name, via: t.entry.via } : null,
        }
        collected.push(chain)
        chains.push(chain)
      }
      if (collected.length >= options.maxChainsPerEndpoint) {
        chainsTruncated.value = true
        break
      }
    }
    endpointChains.set(interfaceId, collected)
  }

  // ---------------------------------------------------------------- 端点 + 统计
  const endpoints = []
  for (const [interfaceId, list] of callsByInterface) {
    const meta = interfaceById.get(interfaceId)
    const listChains = endpointChains.get(interfaceId) || []
    const withEntry = listChains.filter((c) => c.entry)
    const best = withEntry.slice().sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.hops - b.hops)[0]
    endpoints.push({
      interfaceId,
      name: meta?.name || list[0]?.matchedInterfaceName || '',
      method: meta?.method || list[0]?.method || '',
      path: meta?.path || list[0]?.path || '',
      callSiteCount: list.length,
      chainCount: listChains.length,
      hasEntry: withEntry.length > 0,
      confidence: best?.confidence || (listChains[0]?.confidence ?? 'low'),
      truncated: listChains.length >= options.maxChainsPerEndpoint,
    })
  }
  endpoints.sort((a, b) => Number(b.hasEntry) - Number(a.hasEntry) || b.callSiteCount - a.callSiteCount)

  const matchedIds = new Set(callsByInterface.keys())
  const orphanInterfaces = interfaces
    .filter((it) => !matchedIds.has(it.id))
    .map((it) => ({ interfaceId: it.id, name: it.name || '', method: it.method || '', path: it.path || '' }))
  const interfacesWithoutEntry = endpoints.filter((e) => !e.hasEntry).map((e) => e.interfaceId)

  const noEntryCalls = []
  let callsWithEntry = 0
  const callerCountOf = (call) => {
    const trigger = triggerByCallId.get(call.id)
    if (!trigger) return 0
    return (callers.get(trigger.fnId) || []).filter((e) => e.via !== 'module-scope' && e.via !== 'closure').length
  }
  for (const call of scannerCalls) {
    if (!call.matchedInterfaceId) continue
    const list = endpointChains.get(call.matchedInterfaceId) || []
    const hit = list.some((c) => c.callSiteId === call.id && c.entry)
    if (hit) {
      callsWithEntry += 1
      continue
    }
    const trigger = triggerByCallId.get(call.id)
    noEntryCalls.push({
      callId: call.id,
      file: call.file,
      line: call.line,
      interfaceId: call.matchedInterfaceId,
      confidence: trigger?.confidence || 'low',
      reason: trigger ? 'no-entry' : 'not-in-ast',
      callerCount: callerCountOf(call),
    })
  }

  // 「有调用方的调用点」= 触发函数在工程内确实被调用/本身是入口，或它自己就是页面入口。
  // 分母换成它才能回答「能证明的链路有多准」；无调用方的点属于孤儿/死代码，
  // 单独计数，绝不摊薄进成功率（也不伪装成失败）。
  const callSitesWithCaller = scannerCalls.filter((call) => {
    if (!call.matchedInterfaceId) return false
    const trigger = triggerByCallId.get(call.id)
    if (!trigger) return false
    if (entryByFn.has(trigger.fnId)) return true
    return callerCountOf(call) > 0
  }).length

  const endpointsWithEntry = endpoints.filter((e) => e.hasEntry).length
  const stats = {
    scannedFiles: absFiles.length,
    parsedFiles: records.filter((r) => r.units?.length).length,
    fileCount: fileNodes.length,
    functionCount: fnNodes.length,
    callEdgeCount: callEdges.filter((e) => e.type === 'calls').length,
    scopeEdgeCount: callEdges.filter((e) => e.type === 'scope' && e.via === 'module-scope').length,
    closureEdgeCount: callEdges.filter((e) => e.type === 'scope' && e.via === 'closure').length,
    componentEdgeCount: callEdges.filter((e) => e.type === 'component').length,
    callSiteCount: scannerCalls.length,
    callSitesTotal,
    matchCallCount: scannerCalls.filter((c) => c.matchedInterfaceId).length,
    callsWithEntry,
    callsWithoutEntry: noEntryCalls.length,
    callChainRate: scannerCalls.length ? Math.round((callsWithEntry / scannerCalls.length) * 100) : 0,
    callSitesWithCaller,
    callChainRateAmongCallable: callSitesWithCaller
      ? Math.round((callsWithEntry / callSitesWithCaller) * 100)
      : 0,
    endpointCount: endpoints.length,
    endpointsWithEntry,
    endpointChainRate: endpoints.length ? Math.round((endpointsWithEntry / endpoints.length) * 100) : 0,
    orphanInterfaceCount: orphanInterfaces.length,
    interfacesWithoutEntryCount: interfacesWithoutEntry.length,
    lowConfidenceChainCount: chains.filter((c) => c.confidence === 'low').length,
    unresolvedCount: unresolved.length,
    unresolvedImportCount: unresolvedImports.length,
    parseErrorCount: parseErrors.length,
  }

  return {
    version: 1,
    root: resolvedRoot,
    generatedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    truncated: truncated || chainsTruncated.value || callSiteCapped,
    truncatedReasons: [
      ...(truncated ? ['node-budget'] : []),
      ...(chainsTruncated.value ? ['chain-limit'] : []),
      ...(callSiteCapped ? ['call-site-limit'] : []),
    ],
    skippedFiles,
    parseErrors: parseErrors.slice(0, 50),
    nodes: {
      files: fileNodes,
      functions: fnNodes,
      callSites: scannerCalls.map((c) => ({
        id: c.id,
        file: c.file,
        line: c.line,
        method: c.method,
        path: c.path,
        interfaceId: c.matchedInterfaceId || '',
        matchSource: c.matchSource || 'auto',
        score: c.score || 0,
        snippet: c.snippet || '',
        paramKeys: triggerByCallId.get(c.id)?.paramKeys || null,
      })),
      endpoints: endpoints.map((e) => ({ id: `endpoint:${e.interfaceId}`, ...e })),
    },
    edges: {
      imports: importEdges.slice(0, options.maxNodes),
      calls: callEdges.filter((e) => e.type === 'calls'),
      scopes: callEdges.filter((e) => e.type === 'scope'),
      components: callEdges.filter((e) => e.type === 'component'),
      triggers: triggerEdges,
    },
    entries,
    chains,
    endpoints,
    orphanInterfaces: orphanInterfaces.slice(0, 500),
    interfacesWithoutEntry,
    noEntryCalls: noEntryCalls.slice(0, options.maxUnresolved),
    unresolved,
    unresolvedImports,
    stats,
    options: {
      maxFiles: options.maxFiles,
      maxNodes: options.maxNodes,
      maxDepth: options.maxDepth,
      maxChainsPerEndpoint: options.maxChainsPerEndpoint,
    },
  }
}
