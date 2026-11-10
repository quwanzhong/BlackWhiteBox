/**
 * codegraph 公共小工具。
 *
 * 路径归一化直接复用 scanner 的实现：CallSite 的 `path` 与接口匹配口径必须完全一致，
 * 否则图里的调用点和流程生成用的调用点会指向两个不同的接口。
 */
export { looksLikePath, normalizeApiPath } from '../projects/scanner.js'

export const METHOD_NAMES = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
