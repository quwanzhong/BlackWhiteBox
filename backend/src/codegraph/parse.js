/**
 * 源码解析（M3'-2 · W1）。
 *
 * 只做三件事：定位 `<script>` 块、调用 `@babel/parser`、把解析失败收敛成可展示的错误。
 * 不引入 `@babel/traverse`（scope 生成对「找调用/找 import」是负债），
 * 也不引入 `@vue/compiler-sfc`（会把整套前端工具链拖进后端与桌面 sidecar）。
 */
import { parse as babelParse } from '@babel/parser'

const BASE_PLUGINS = [
  'decorators-legacy',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'dynamicImport',
  'optionalChaining',
  'nullishCoalescingOperator',
  'objectRestSpread',
  'exportDefaultFrom',
  'topLevelAwait',
]

const SCRIPT_LANGS = new Set(['js', 'jsx', 'ts', 'tsx'])

/** 文件扩展名 → parser 插件组合 */
export function pluginsFor(file, lang = '') {
  const ext = String(file).toLowerCase().split('.').pop()
  const kind = (lang || ext || '').toLowerCase()
  const plugins = [...BASE_PLUGINS]
  if (kind === 'ts' || kind === 'tsx' || ext === 'ts' || ext === 'tsx') plugins.push('typescript')
  if (kind === 'jsx' || kind === 'tsx' || ext === 'jsx' || ext === 'tsx') plugins.push('jsx')
  // .vue 的纯 js 块也可能写 JSX（render 函数），加上不冲突
  if (!plugins.includes('jsx')) plugins.push('jsx')
  return plugins
}

/**
 * 提取 `.vue` 里的 `<script>` / `<script setup>` 块，并保留原始行号偏移。
 * 行号口径与 scanner 一致：从 1 开始，`lineOffset` 是块内容之前已存在的换行数。
 */
export function extractVueScripts(source) {
  const blocks = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(source))) {
    const attrs = m[1] || ''
    const code = m[2] || ''
    const bodyStart = m.index + m[0].indexOf('>') + 1
    const lineOffset = source.slice(0, bodyStart).split('\n').length - 1
    const langMatch = attrs.match(/\blang\s*=\s*['"]?([\w-]+)/i)
    const lang = (langMatch?.[1] || '').toLowerCase()
    blocks.push({
      code,
      lineOffset,
      lang: SCRIPT_LANGS.has(lang) ? lang : '',
      setup: /\bsetup\b/i.test(attrs),
    })
  }
  return blocks
}

/**
 * 提取 `template` 里的全部元素标签名（`<PayerDialog>` / `<payer-dialog>` / `<div>`）。
 *
 * 组件之间的「父子使用」是 W1 链路里唯一不带调用语法的一环：
 * 没有它，弹窗子组件里的接口调用永远回溯不到入口页面。
 * 这里不做内置标签黑名单——是否算组件由 build 阶段用「该文件有没有对应 import」判定，
 * 这样 `<el-button>`（element-plus，工程外）自动被排除，也不会漏掉 kebab-case 自定义组件。
 */
export function extractTemplateComponents(source) {
  const templateMatch = source.match(/<template\b[^>]*>([\s\S]*)<\/template>/i)
  if (!templateMatch) return []
  const body = templateMatch[1]
  const bodyStart = templateMatch.index + templateMatch[0].indexOf('>') + 1
  const out = []
  const seen = new Set()
  const re = /<([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)(?=[\s/>])/g
  let m
  while ((m = re.exec(body))) {
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, line: source.slice(0, bodyStart + m.index).split('\n').length })
  }
  return out
}

/**
 * 提取 `template` 里的 `@click` / `v-on:change` 绑定名。
 *
 * 只作为 calls 边的补充来源（docs/05 §2.2：置信度 medium），
 * 用轻量正则而不是模板编译，避免引入前端编译器。
 */
export function extractTemplateBindings(source) {
  const templateMatch = source.match(/<template\b[^>]*>([\s\S]*)<\/template>/i)
  if (!templateMatch) return []
  const body = templateMatch[1]
  const bodyStart = templateMatch.index + templateMatch[0].indexOf('>') + 1
  const out = []
  const seen = new Set()
  const re = /(?:@|v-on:)([A-Za-z][\w-]*)(?:\.[\w-]+)*\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(body))) {
    const event = m[1]
    const expression = m[2] || ''
    for (const name of expression.match(/[A-Za-z_$][\w$]*/g) || []) {
      if (name.startsWith('$') || name === 'true' || name === 'false' || name === 'null') continue
      if (name === 'event' || name === 'arguments') continue
      const key = `${event}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name,
        event,
        line: source.slice(0, bodyStart + m.index).split('\n').length,
        snippet: m[0].slice(0, 160),
      })
    }
  }
  return out
}

/** 解析一段代码；失败时返回 error 而不是抛（单个坏文件不能拖垮整张图） */
export function parseCode(code, plugins) {
  try {
    return {
      ast: babelParse(code, {
        sourceType: 'unambiguous',
        plugins,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        errorRecovery: true,
      }),
      error: '',
    }
  } catch (err) {
    return { ast: null, error: String(err?.message || err).split('\n')[0].slice(0, 300) }
  }
}

/**
 * 解析一个文件，返回可供图构建使用的「解析单元」。
 * - 普通源码：一个单元（lineOffset=0）
 * - `.vue`：每个 `<script>` 块一个单元，行号按块偏移还原
 */
export function parseFile(relFile, source, absolutePath) {
  const isVue = String(relFile).toLowerCase().endsWith('.vue')
  const units = []
  const errors = []

  if (isVue) {
    const blocks = extractVueScripts(source)
    if (!blocks.length) {
      // template-only 组件：没有 JS 可分析，不算解析失败
      return {
        file: relFile,
        path: absolutePath,
        units: [],
        errors,
        template: extractTemplateBindings(source),
        components: extractTemplateComponents(source),
      }
    }
    for (const block of blocks) {
      const { ast, error } = parseCode(block.code, pluginsFor(relFile, block.lang))
      if (error) errors.push({ file: relFile, message: error, lineOffset: block.lineOffset })
      else units.push({ ast, lineOffset: block.lineOffset, setup: block.setup })
    }
    return {
      file: relFile,
      path: absolutePath,
      units,
      errors,
      template: extractTemplateBindings(source),
      components: extractTemplateComponents(source),
    }
  }

  const { ast, error } = parseCode(source, pluginsFor(relFile))
  if (error) errors.push({ file: relFile, message: error, lineOffset: 0 })
  else units.push({ ast, lineOffset: 0, setup: false })
  return { file: relFile, path: absolutePath, units, errors, template: [], components: [] }
}
