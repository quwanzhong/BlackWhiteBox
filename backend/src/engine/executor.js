import axios from 'axios'
import { substitute } from './jsonpath.js'

/**
 * 执行单个节点。
 * 支持两种执行类型：
 *  - http   ：真实发起接口请求（黑盒流程 / 接口链路）
 *  - manual ：人工确认（白盒流程：按调用链逐步走查代码）
 *
 * @param {object} node 流程节点
 * @param {{ vars: Record<string, any>, last: any }} ctx 运行时上下文
 */
export async function executeNode(node, ctx) {
  const action = node.action || {}

  if (action.type === 'manual') {
    return { manual: true }
  }

  if (action.type !== 'http') {
    throw new Error(`不支持的节点执行类型：${action.type}`)
  }

  const method = (action.method || 'GET').toUpperCase()
  const url = substitute(action.url, ctx.vars)
  const headers = substitute(action.headers || {}, ctx.vars)
  const body = substitute(action.body ?? null, ctx.vars)
  const timeout = action.timeout || 15000

  if (!url) throw new Error('节点未配置请求地址（url）')

  const startedAt = Date.now()
  try {
    const resp = await axios.request({
      method,
      url,
      headers,
      data: body == null ? undefined : body,
      timeout,
      validateStatus: () => true, // 4xx/5xx 也作为正常响应，交给校验器判定
    })
    const durationMs = Date.now() - startedAt
    return {
      ok: true,
      status: resp.status,
      data: resp.data,
      headers: resp.headers,
      durationMs,
      request: { method, url, headers, body },
    }
  } catch (err) {
    const e = new Error(`请求失败：${err.message}（${method} ${url}）`)
    e.request = { method, url, headers, body }
    throw e
  }
}
