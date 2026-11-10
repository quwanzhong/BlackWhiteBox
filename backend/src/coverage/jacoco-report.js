/**
 * JaCoCo XML 报告解析（M3-2 / docs/02 §6.2、§6.5）
 *
 * 纯函数边界：输入 jacococli 生成的 XML 字符串，输出统一 Coverage 结构，
 * 不碰文件系统、数据库、网络。这样解析规则可以单测，也可以在未来离线重算
 * `coverage.result_json`（原始 `.exec` 永不改写）。
 *
 * 结构约定：
 *   files[]   —— 按源文件聚合的行号清单，`covered`/`missed` 是行号数组；
 *   classes[] —— 按类聚合的行计数 + 方法清单；
 *   totals    —— 全量行计数，供面板直接显示总覆盖率。
 *
 * 行命中判定：JaCoCo 的 `<line ci>` 是本行被覆盖的指令数，`ci > 0` 即命中。
 * 不能把 `mi > 0` 当成未命中（部分覆盖的行两者都 > 0）。
 */

const COUNTER_RE = /<counter\s+([^>]*?)\/?>/g
const LINE_RE = /<line\s+([^>]*?)\/?>/g
const ATTR_RE = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g

/** XML 实体解码：类名里的 `<init>` 在 XML 里是 `&lt;init&gt;` */
export function decodeXml(value) {
  if (!value || !value.includes('&')) return value || ''
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (raw, body) => {
    if (body === 'amp') return '&'
    if (body === 'lt') return '<'
    if (body === 'gt') return '>'
    if (body === 'quot') return '"'
    if (body === 'apos') return "'"
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : raw
  })
}

function attrsOf(text) {
  const out = {}
  for (const match of text.matchAll(ATTR_RE)) out[match[1]] = decodeXml(match[2])
  return out
}

function intAttr(attrs, key, fallback = 0) {
  const value = Number.parseInt(attrs[key], 10)
  return Number.isFinite(value) ? value : fallback
}

/** 读取块内指定类型的 counter；不存在时返回 null（0 与「没有」语义不同） */
function counterOf(block, type) {
  for (const match of block.matchAll(COUNTER_RE)) {
    const attrs = attrsOf(match[1])
    if (attrs.type === type) {
      return { missed: intAttr(attrs, 'missed'), covered: intAttr(attrs, 'covered') }
    }
  }
  return null
}

function lineCounterOf(block) {
  return counterOf(block, 'LINE') || { missed: 0, covered: 0 }
}

function parseMethods(classBody) {
  const methods = []
  for (const match of classBody.matchAll(/<method\s+([^>]*)>([\s\S]*?)<\/method>/g)) {
    const attrs = attrsOf(match[1])
    const counter = lineCounterOf(match[2])
    methods.push({
      name: attrs.name || '',
      desc: attrs.desc || '',
      line: intAttr(attrs, 'line', 0),
      covered: counter.covered,
      missed: counter.missed,
      total: counter.covered + counter.missed,
    })
  }
  return methods
}

function parseClasses(packageBody, packageName) {
  const classes = []
  for (const match of packageBody.matchAll(/<class\s+([^>]*)>([\s\S]*?)<\/class>/g)) {
    const attrs = attrsOf(match[1])
    const methods = parseMethods(match[2])
    // 类级 counter 必须是 <class> 的直接子元素；先剥掉 <method> 块，避免误读方法内的 LINE
    const classOnly = match[2].replace(/<method\s+[^>]*>[\s\S]*?<\/method>/g, '')
    const classCounter = counterOf(classOnly, 'LINE')
    // 类级 counter 缺失时（极少数无行号类）退回方法聚合，避免出现「有方法但 total=0」
    const covered = classCounter ? classCounter.covered : methods.reduce((sum, m) => sum + m.covered, 0)
    const missed = classCounter ? classCounter.missed : methods.reduce((sum, m) => sum + m.missed, 0)
    const sourcefile = attrs.sourcefilename || ''
    classes.push({
      name: (attrs.name || '').replaceAll('/', '.'),
      source: sourcefile ? (packageName ? `${packageName}/${sourcefile}` : sourcefile) : null,
      covered,
      missed,
      total: covered + missed,
      methods,
    })
  }
  return classes
}

function parseFiles(packageBody, packageName) {
  const files = []
  for (const match of packageBody.matchAll(/<sourcefile\s+([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
    const attrs = attrsOf(match[1])
    const covered = []
    const missed = []
    for (const lineMatch of match[2].matchAll(LINE_RE)) {
      const line = attrsOf(lineMatch[1])
      const nr = intAttr(line, 'nr', 0)
      if (nr <= 0) continue
      if (intAttr(line, 'ci') > 0) covered.push(nr)
      else missed.push(nr)
    }
    covered.sort((a, b) => a - b)
    missed.sort((a, b) => a - b)
    const name = attrs.name || ''
    files.push({
      path: packageName ? `${packageName}/${name}` : name,
      covered,
      missed,
      total: covered.length + missed.length,
    })
  }
  return files
}

/**
 * 解析 JaCoCo XML 报告。
 * @param {string} xml
 * @returns {{files: Array<object>, classes: Array<object>, totals: object}}
 */
export function parseJacocoXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('<report')) {
    throw Object.assign(new Error('不是合法的 JaCoCo XML 报告：缺少 <report> 根节点'), {
      code: 'COVERAGE_ANALYZE_FAILED',
    })
  }

  const files = []
  const classes = []
  for (const match of xml.matchAll(/<package\s+([^>]*)>([\s\S]*?)<\/package>/g)) {
    const packageName = attrsOf(match[1]).name || ''
    const body = match[2]
    files.push(...parseFiles(body, packageName))
    classes.push(...parseClasses(body, packageName))
  }

  const covered = files.reduce((sum, file) => sum + file.covered.length, 0)
  const missed = files.reduce((sum, file) => sum + file.missed.length, 0)
  const total = covered + missed
  const totals = {
    files: files.length,
    classes: classes.length,
    covered,
    missed,
    total,
    lineRate: total ? Number(((covered / total) * 100).toFixed(2)) : 0,
  }
  return { files, classes, totals }
}
