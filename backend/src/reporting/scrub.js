/**
 * 导出脱敏（M2-4 / docs/02 §9.2 / S8）。
 *
 * 只做「字段级」剥离，不做整包随机串黑名单 —— 后者会误伤 orderId / requestId / 哈希摘要，
 * 让报告失去证据价值。边界：
 *   - 请求头、响应头：敏感键整值替换为 ***
 *   - 请求 URL query：敏感参数名替换值，其余参数保留（报告仍可复现）
 *   - 请求体（JSON / form / 原始字符串）：递归敏感键
 *   - 事件流：与步骤同一套规则（step_end.request 不能绕过）
 *   - 响应体 / 提取变量：不按键名剥离，只保留写入时已做的 env secrets 隐码
 */

export const REDACTED = '***'

/** 精确命中的敏感键（先归一化：小写 + 去掉 - _ 空格） */
const EXACT_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'xapikey',
  'session',
  'sessionid',
  'credential',
  'credentials',
  'privatekey',
])

/** 后缀规则：覆盖 userPassword / accessToken / clientSecret / x-api-key 等变体 */
const SUFFIX_RE = /(password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey)$/

/** 对外声明的脱敏范围（JSON 导出里的 `scrubbed` 字段，消费者据此判断证据完整度） */
export const SCRUB_POLICY = {
  requestHeaders: true,
  requestUrlQuery: true,
  requestBody: true,
  responseHeaders: true,
  responseBody: false,
  events: true,
}

export function isSensitiveKey(key) {
  if (key === null || key === undefined) return false
  const normalized = String(key)
    .toLowerCase()
    .replace(/[-_\s]/g, '')
  return EXACT_KEYS.has(normalized) || SUFFIX_RE.test(normalized)
}

/** 请求头 / 响应头：敏感键整值打码，其余原样 */
export function scrubHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers
  if (Array.isArray(headers)) return headers.map((item) => scrubHeaders(item))
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveKey(key) ? REDACTED : value
  }
  return out
}

/**
 * URL 里的敏感 query 参数打码。保持原始编码与参数顺序，不做 URL 归一化
 * （报告里要能看出"当初到底请求了哪一串"）。
 */
export function scrubUrl(raw) {
  if (typeof raw !== 'string' || !raw) return raw
  const hashAt = raw.indexOf('#')
  const hash = hashAt >= 0 ? raw.slice(hashAt) : ''
  const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const queryAt = noHash.indexOf('?')
  if (queryAt < 0) return raw

  const head = noHash.slice(0, queryAt)
  const query = noHash.slice(queryAt + 1)
  const parts = query.split('&').map((pair) => {
    if (!pair) return pair
    const eq = pair.indexOf('=')
    if (eq < 0) return pair
    const rawKey = pair.slice(0, eq)
    let key = rawKey
    try {
      key = decodeURIComponent(rawKey)
    } catch {
      /* 非法编码保持原样参与判定 */
    }
    return isSensitiveKey(key) ? `${rawKey}=${REDACTED}` : pair
  })
  return `${head}?${parts.join('&')}${hash}`
}

/** 请求体：对象递归打码；字符串先试 JSON，再退化为 k=v 与 "k":"v" 两种形态 */
export function scrubBody(body) {
  if (body === null || body === undefined) return body
  if (typeof body === 'object') return deepScrub(body)
  if (typeof body !== 'string') return body
  return scrubRawString(body)
}

function scrubRawString(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(deepScrub(JSON.parse(trimmed)))
    } catch {
      /* 不是完整 JSON：继续按文本处理 */
    }
  }

  let out = text
  // form-urlencoded / query 片段：token=xxx&foo=1
  out = out.replace(/(^|[?&\s,])([A-Za-z0-9_.[\]-]+)=([^&\s,}]*)/g, (match, prefix, key) =>
    isSensitiveKey(key) ? `${prefix}${key}=${REDACTED}` : match
  )
  // 不完整 JSON 或内嵌文本："password":"xxx"
  out = out.replace(/("([A-Za-z0-9_.-]+)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (match, prefix, key) =>
    isSensitiveKey(key) ? `${prefix}"${REDACTED}"` : match
  )
  return out
}

/** 对任意对象做「按键打码」的深拷贝（只用于请求体这类明确以键值表达的数据） */
export function deepScrub(value) {
  if (Array.isArray(value)) return value.map((item) => deepScrub(item))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : deepScrub(item)
  }
  return out
}

export function scrubRequest(request) {
  if (!request || typeof request !== 'object') return request
  return {
    ...request,
    url: scrubUrl(request.url),
    headers: scrubHeaders(request.headers),
    body: scrubBody(request.body),
  }
}

/**
 * 按字段语义遍历：`request` / `headers` / `url` / `body` 走脱敏，其余原样递归。
 * 这样响应体 `actual.data.token` 不会被误伤，而 `actual.headers` 里的 set-cookie 会被剥离。
 */
function walk(node) {
  if (Array.isArray(node)) return node.map((item) => walk(item))
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase()
    if (lower === 'request') out[key] = scrubRequest(value)
    else if (lower === 'headers' || lower === 'header') out[key] = scrubHeaders(value)
    else if (lower === 'url') out[key] = scrubUrl(value)
    else if (lower === 'body') out[key] = scrubBody(value)
    else out[key] = walk(value)
  }
  return out
}

/** 导出前的唯一入口：返回脱敏后的深拷贝，绝不修改原对象 */
export function scrubExecution(detail) {
  if (!detail || typeof detail !== 'object') return detail
  return walk(detail)
}
