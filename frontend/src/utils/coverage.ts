/**
 * 覆盖率视图模型（M3-3，纯函数，供 Pinia store 与组件共用）
 *
 * 后端给的是「证据状态 + result_json」，前端要把它翻译成三种不同的东西：
 *   1) 节点徽标：一行字 + 颜色，必须能区分「没采到 / 待分析 / 分析失败 / 有数据」；
 *   2) 文件列表：按未覆盖行数排序，先看最该补的文件；
 *   3) 事件增量：`coverage.dump` 只带状态不带行数据，不能把已有 result 覆盖掉。
 * 这些规则放在纯函数里，`frontend/test/coverage-utils.test.mjs` 直接回归。
 */

export type CoverageTone = 'ok' | 'warn' | 'bad' | 'pending' | 'error' | 'none'

export interface CoverageRow {
  id?: string
  nodeId: string
  status: string
  error?: string | null
  bytes?: number
  capturedAt?: number
  analyzedAt?: number | null
  result?: any
}

export interface CoverageBadge {
  text: string
  tone: CoverageTone
  title: string
}

export interface CoverageFileRow {
  path: string
  short: string
  covered: number
  missed: number
  total: number
  lineRate: number | null
  missedLines: number[]
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 百分比：整数不带小数点，其余保留 1 位；无数据用 —，绝不显示 0% */
export function fmtPct(rate: unknown): string {
  const n = num(rate)
  if (n === null) return '—'
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`
}

/** 行率 → 颜色档位（≥80 绿、≥50 橙、其余红；没有行数据用灰） */
export function rateTone(rate: unknown): CoverageTone {
  const n = num(rate)
  if (n === null) return 'none'
  if (n >= 80) return 'ok'
  if (n >= 50) return 'warn'
  return 'bad'
}

/**
 * 节点徽标。四种「没有数字」的状态必须各自可辨：
 * 无证据（agent 不可达）/ 待分析（没配 classfiles）/ 分析失败 / 无行数据。
 */
export function coverageBadge(row?: CoverageRow | null): CoverageBadge {
  if (!row) return { text: '', tone: 'none', title: '本次执行没有该节点的覆盖率证据' }
  if (row.status === 'unavailable') {
    return { text: '无证据', tone: 'none', title: row.error || 'JaCoCo agent 不可用，未采集到运行时证据' }
  }
  if (row.status === 'captured' && row.error) {
    return { text: '分析失败', tone: 'error', title: row.error }
  }
  if (row.status === 'captured') {
    return {
      text: '待分析',
      tone: 'pending',
      title: '已取证，等待 jacococli 分析（环境需配置 settings.coverage.classfiles）',
    }
  }
  const totals = row.result?.totals
  const total = num(totals?.total)
  if (!totals || total === null) {
    return { text: '已分析', tone: 'pending', title: '分析完成，但没有返回行级数据' }
  }
  if (total <= 0) {
    return { text: '无行数据', tone: 'none', title: '分析完成，但类文件与源码没有匹配到可统计的行' }
  }
  const covered = num(totals.covered) ?? 0
  return {
    text: `${covered}/${total}`,
    tone: rateTone(totals.lineRate),
    title: `行覆盖 ${fmtPct(totals.lineRate)} · ${covered}/${total} 行 · ${num(totals.files) ?? 0} 个文件`,
  }
}

/** 命中行数汇总（画布状态条 / 报告页用），只统计真正分析完成的节点 */
export function summarizeCoverage(list: CoverageRow[] = []) {
  const out = {
    total: list.length,
    analyzed: 0,
    pending: 0,
    analysisFailed: 0,
    unavailable: 0,
    covered: 0,
    statLines: 0,
    lineRate: null as number | null,
  }
  for (const row of list) {
    if (row.status === 'analyzed') {
      out.analyzed += 1
      const covered = num(row.result?.totals?.covered) ?? 0
      const total = num(row.result?.totals?.total) ?? 0
      out.covered += covered
      out.statLines += total
    } else if (row.status === 'unavailable') {
      out.unavailable += 1
    } else if (row.error) {
      out.analysisFailed += 1
    } else {
      out.pending += 1
    }
  }
  out.lineRate = out.statLines ? Math.round((out.covered / out.statLines) * 10000) / 100 : null
  return out
}

/** result.files → 文件列表（未覆盖行多的在前；同数量按路径稳定排序） */
export function fileRows(result: any): CoverageFileRow[] {
  const files = Array.isArray(result?.files) ? result.files : []
  return files
    .map((file: any) => {
      const covered: number[] = Array.isArray(file?.covered) ? file.covered : []
      const missed: number[] = Array.isArray(file?.missed) ? file.missed : []
      const total = covered.length + missed.length
      const path = String(file?.path || '')
      const parts = path.split('/')
      return {
        path,
        short: parts.slice(-2).join('/') || path,
        covered: covered.length,
        missed: missed.length,
        total,
        lineRate: total ? Math.round((covered.length / total) * 10000) / 100 : null,
        missedLines: [...missed].sort((a, b) => a - b),
      }
    })
    .sort((a, b) => b.missed - a.missed || a.path.localeCompare(b.path))
}

/** 第一个未覆盖行（打开源码时自动定位；没有未覆盖行则回到第 1 行） */
export function firstUncovered(view: { missed?: number[] } | null | undefined): number {
  const missed = Array.isArray(view?.missed) ? view!.missed : []
  return missed.length ? Number(missed[0]) : 1
}

/** 在未覆盖行之间前后跳转（环形）；没有未覆盖行返回 null */
export function stepUncovered(missed: number[] = [], current: number, direction: 1 | -1): number | null {
  const list = [...missed].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!list.length) return null
  if (direction > 0) return list.find((nr) => nr > current) ?? list[0]
  const prev = [...list].reverse().find((nr) => nr < current)
  return prev ?? list[list.length - 1]
}

/**
 * M3-4：把节点编辑框里的多行覆盖率断言目标归一化。
 * 去空行/首尾空白、去重、保序；目标合法性由后端判定（前端不做第二套规则）。
 */
export function parseCoverageTargets(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * `coverage.dump` 增量：只更新证据状态，保留已解析的 result。
 * 同节点覆盖写（M3-1 契约：一次执行每节点一份快照）。
 */
export function mergeCoverageEvent(rows: CoverageRow[] = [], evt: any): CoverageRow[] {
  if (evt?.type !== 'coverage.dump') return rows
  const payload = evt.payload || {}
  if (!payload.nodeId) return rows
  const next: CoverageRow = {
    id: payload.coverageId || payload.id,
    nodeId: payload.nodeId,
    status: payload.status || 'captured',
    error: payload.error || null,
    bytes: num(payload.bytes) ?? 0,
    capturedAt: num(evt.ts) ?? Date.now(),
    analyzedAt: null,
    result: null,
  }
  const index = rows.findIndex((row) => row.nodeId === next.nodeId)
  if (index < 0) return [...rows, next]
  const merged = [...rows]
  merged[index] = {
    ...rows[index],
    ...next,
    // dump 事件不带行数据：已分析的结果不能被状态更新打回 null
    result: rows[index].result ?? null,
  }
  return merged
}
