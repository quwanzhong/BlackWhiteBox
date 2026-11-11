/**
 * 调用链视图模型（M3'-2 · W1，纯函数，供项目页面板与组件共用）
 *
 * 这里只做「后端字段 → 人话 + 颜色」，不碰 DOM，`frontend/test/codegraph-utils.test.mjs` 直接回归。
 *
 * 三条硬规则（docs/05 §2.2/§2.4）：
 *   1) 没构建 / 扫描变化 → 显式状态 + 提示，绝不把「还没分析」渲染成「0 条链路」；
 *   2) 断链是「低置信度待关联」，不是「无调用方」；callerCount=0 才叫工程内无调用方；
 *   3) 入口率同时给「可归因分母」与「全局分母」，不挑好看的数。
 */

export type CgTone = 'ok' | 'warn' | 'bad' | 'none'

export interface GraphStateView {
  text: string
  tone: CgTone
  notice: string
  canQuery: boolean
}

/** Element Plus `<el-tag :type>` / `<el-alert :type>` 映射 */
export function tagType(tone: CgTone): 'success' | 'warning' | 'danger' | 'info' {
  if (tone === 'ok') return 'success'
  if (tone === 'warn') return 'warning'
  if (tone === 'bad') return 'danger'
  return 'info'
}

export function alertType(tone: CgTone): 'success' | 'warning' | 'error' | 'info' {
  if (tone === 'ok') return 'success'
  if (tone === 'warn') return 'warning'
  if (tone === 'bad') return 'error'
  return 'info'
}

export function graphStateView(status: any): GraphStateView {
  if (!status) return { text: '未加载', tone: 'none', notice: '', canQuery: false }
  if (status.state === 'missing') {
    return {
      text: '未扫描',
      tone: 'bad',
      notice: '还没有代码扫描结果。调用链以扫描出的调用点为输入，请先完成「② 扫描代码调用流程」。',
      canQuery: false,
    }
  }
  if (status.state === 'stale') {
    if (status.reason === 'not-built') {
      return {
        text: '未构建',
        tone: 'warn',
        notice: '调用链尚未生成。点「构建调用链」才会产出入口链路；在此之前不显示「0 条链路」。',
        canQuery: false,
      }
    }
    return {
      text: '需重建',
      tone: 'warn',
      notice: '扫描结果或接口绑定已变化，下面显示的是上一次的图。重建后才能作为证据。',
      canQuery: true,
    }
  }
  return { text: '可用', tone: 'ok', notice: '', canQuery: true }
}

export interface GraphStatRow {
  label: string
  value: string
  hint?: string
  tone?: CgTone
}

const pct = (value: any): string => (typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '—')

/** 摘要 → 统计卡片；入口率必须同时呈现两个分母 */
export function graphStatRows(summary: any): GraphStatRow[] {
  const s = summary?.stats
  if (!s) return []
  const among = typeof s.callChainRateAmongCallable === 'number' ? s.callChainRateAmongCallable : null
  return [
    { label: '扫描文件', value: String(s.fileCount ?? '—') },
    { label: '函数节点', value: String(s.functionCount ?? '—') },
    {
      label: '调用点',
      value: String(s.callSiteCount ?? 0),
      hint: `已匹配 ${s.matchCallCount ?? 0}`,
    },
    {
      label: '有入口调用点',
      value: `${s.callsWithEntry ?? 0}/${s.callSitesWithCaller ?? 0}`,
      hint: `可归因 ${pct(among)} · 全局 ${pct(s.callChainRate)}`,
      tone: among === null ? 'warn' : among >= 90 ? 'ok' : 'warn',
    },
    {
      label: '接口入口率',
      value: pct(s.endpointChainRate),
      hint: `${s.endpointsWithEntry ?? 0}/${s.endpointCount ?? 0} 个接口`,
      tone: (s.endpointChainRate ?? 0) >= 90 ? 'ok' : 'warn',
    },
    { label: '构建耗时', value: `${summary?.durationMs ?? 0} ms` },
  ]
}

/** 截断原因 → 人话（绝不静默截断） */
export function truncationReasons(summary: any): string[] {
  const map: Record<string, string> = {
    'node-budget': '节点数超过上限（node-budget），部分文件未入图',
    'chain-limit': '单接口链路数触顶（chain-limit），只展示前 N 条',
    'call-site-limit': '扫描调用点被截断（call-site-limit），图只覆盖前 1200 个',
  }
  return (summary?.truncatedReasons || []).map((r: string) => map[r] || r)
}

export type EndpointFilter = 'all' | 'entry' | 'broken'

/** 端点清单：搜索 + 有入口/断链筛选；排序保持「有入口优先 → 调用点多优先」 */
export function endpointRows(payload: any, options: { keyword?: string; filter?: EndpointFilter } = {}): any[] {
  const rows = Array.isArray(payload?.endpoints) ? payload.endpoints.slice() : []
  const kw = String(options.keyword || '').trim().toLowerCase()
  const filter = options.filter || 'all'
  return rows
    .filter((row: any) => {
      if (filter === 'entry' && !row.hasEntry) return false
      if (filter === 'broken' && row.hasEntry) return false
      if (!kw) return true
      return `${row.method || ''} ${row.path || ''} ${row.name || ''} ${row.interfaceId || ''}`
        .toLowerCase()
        .includes(kw)
    })
    .sort(
      (a: any, b: any) =>
        Number(Boolean(b.hasEntry)) - Number(Boolean(a.hasEntry)) || (b.callSiteCount || 0) - (a.callSiteCount || 0)
    )
}

/** 置信度：low 不是失败，是「待人工确认」，所以用 warning 而不是 danger */
export function confidenceTone(confidence?: string): 'success' | 'primary' | 'warning' {
  if (confidence === 'high') return 'success'
  if (confidence === 'medium') return 'primary'
  return 'warning'
}

export function brokenReasonText(reason?: string): string {
  if (reason === 'depth-limit') return '超过回溯深度上限（已截断），不是「无调用方」'
  if (reason === 'not-in-ast') return '扫描到了调用，但 AST 里找不到对应函数，需人工关联'
  return '有调用点但回溯不到入口，不是「无调用方」'
}

export interface ChainView {
  title: string
  confidence: string
  confidenceTone: string
  hops: number
  entryText: string
  reasonText: string
  broken: boolean
}

export function chainView(chain: any): ChainView {
  const entry = chain?.entry
  const broken = !entry
  const reason = chain?.reason || (broken ? 'no-entry' : 'entry')
  return {
    title: entry ? entry.name || entry.file || '页面入口' : '未回溯到入口',
    confidence: chain?.confidence || 'low',
    confidenceTone: confidenceTone(chain?.confidence),
    hops: chain?.hops || 0,
    entryText: entry
      ? `入口：${entry.route ? `${entry.route} · ` : ''}${entry.file || ''}`
      : '断链 · 低置信度待关联',
    reasonText: broken ? brokenReasonText(reason) : `入口页面：${entry.file || entry.route || '—'}`,
    broken,
  }
}

export interface NoEntryRow {
  key: string
  where: string
  interfaceId: string
  callerText: string
  tone: 'warning' | 'info'
  reason: string
  confidence: string
}

/** 无入口调用点：「工程内无调用方」与「有调用方但回溯不到入口」必须分开说 */
export function noEntryRows(gaps: any): NoEntryRow[] {
  return (gaps?.noEntryCalls || []).map((call: any) => {
    const callerCount = Number(call.callerCount) || 0
    return {
      key: call.callId || `${call.file}:${call.line}`,
      where: `${call.file || ''}:${call.line || 0}`,
      interfaceId: call.interfaceId || '',
      callerText:
        callerCount === 0
          ? '工程内无调用方（死代码 / 未被引用）'
          : `有 ${callerCount} 个调用方，但回溯不到入口`,
      tone: callerCount === 0 ? 'info' : 'warning',
      reason: call.reason || 'no-entry',
      confidence: call.confidence || 'low',
    }
  })
}

export interface GapSection {
  key: string
  title: string
  hint: string
  rows: Array<{ key: string; where: string; detail: string }>
}

/** 其余断链清单：未解析调用 / 未解析 import / 解析失败 / 跳过文件 */
export function gapSections(gaps: any): GapSection[] {
  const unresolved = (gaps?.unresolved || []).map((item: any, i: number) => ({
    key: `${item.file}:${item.line}:${item.callee || i}`,
    where: `${item.file || ''}:${item.line || 0}`,
    detail: `${item.callee || item.name || '?'} · ${item.reason || 'unresolved'}`,
  }))
  const imports = (gaps?.unresolvedImports || []).map((item: any, i: number) => ({
    key: `${item.file}:${item.line}:${item.source || i}`,
    where: `${item.file || ''}:${item.line || 0}`,
    detail: `${item.source || '?'}${item.local ? ` → ${item.local}` : ''}`,
  }))
  const parseErrors = (gaps?.parseErrors || []).map((item: any, i: number) => ({
    key: `${item.file}:${i}`,
    where: item.file || '',
    detail: item.message || '解析失败',
  }))
  const skipped = (gaps?.skippedFiles || []).map((item: any, i: number) => ({
    key: `${item.file}:${i}`,
    where: item.file || '',
    detail: item.reason || 'skipped',
  }))
  return [
    { key: 'unresolved', title: '未解析调用', hint: '动态写法（obj[name](…) / 变量 import），需人工关联', rows: unresolved },
    { key: 'unresolvedImports', title: '未解析 import', hint: '工程内路径找不到；裸包名（node_modules）不计入', rows: imports },
    { key: 'parseErrors', title: '解析失败文件', hint: '单个坏文件不会拖垮整张图，但必须让人看见', rows: parseErrors },
    { key: 'skippedFiles', title: '被跳过的文件', hint: '节点预算/文件上限导致未入图', rows: skipped },
  ]
}

/** 孤儿接口：文档里有、代码里没有任何调用点（与「无入口调用点」不是一回事） */
export function orphanRows(payload: any): Array<{ key: string; name: string; detail: string }> {
  return (payload?.orphanInterfaces || []).map((item: any) => ({
    key: item.interfaceId,
    name: item.name || item.interfaceId,
    detail: `${item.method || ''} ${item.path || ''}`.trim(),
  }))
}
