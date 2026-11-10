/**
 * 失败归类展示口径（M2-3，后端 src/reporting/classify.js 是唯一事实源）。
 * 后端返回 failureClass 枚举，前端只负责标签/颜色/顺序，不参与判定。
 */

export const FAILURE_CLASSES = [
  'network',
  'timeout',
  'status',
  'schema',
  'assertion',
  'dependency',
  'script',
  'manual_reject',
] as const

export type FailureClass = (typeof FAILURE_CLASSES)[number]

export const FAILURE_CLASS_LABELS: Record<FailureClass, string> = {
  network: '网络不可达',
  timeout: '超时',
  status: '状态码不符',
  schema: '结构不符',
  assertion: '断言不符',
  dependency: '前置依赖',
  script: '脚本/配置',
  manual_reject: '人工驳回',
}

type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info'

export const FAILURE_CLASS_TAGS: Record<FailureClass, TagType> = {
  network: 'danger',
  timeout: 'warning',
  status: 'danger',
  schema: 'warning',
  assertion: 'danger',
  dependency: 'info',
  script: 'warning',
  manual_reject: 'info',
}

export function failureLabel(cls?: string | null): string {
  if (!cls) return ''
  return FAILURE_CLASS_LABELS[cls as FailureClass] || cls
}

export function failureTag(cls?: string | null): TagType {
  return FAILURE_CLASS_TAGS[cls as FailureClass] || 'info'
}
