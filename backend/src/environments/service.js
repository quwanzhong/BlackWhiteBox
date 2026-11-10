/**
 * M2-1 · Environment（环境）领域服务。
 *
 * 一个环境 = `baseUrl` + 普通变量 + 全局请求头 + 加密密钥（secrets），可挂在项目下。
 * 本模块负责：校验/归一化、CRUD、密钥加解密、执行期解析（resolve）与展示期掩码。
 *
 * 关键契约（docs/02 §7/§8、docs/DSL.md §4）：
 *  - 变量优先级（低 → 高）：flow.variables < Environment（variables + secrets）
 *    < 执行时传入 variables < 运行中 extract；
 *  - `variables` 与 `secrets` 键名冲突直接 400，避免「到底取哪个值」的歧义；
 *  - secrets 明文只在 `resolveEnvironment()` 的内存结果里出现；对 API/落库/事件，
 *    一律只暴露 `secretKeys`，执行期按明文值掩码为 `***`。
 */

import crypto from 'node:crypto'
import { store } from '../store.js'
import { getKeystore } from '../security/keystore.js'

/** `{{var}}` 插值只认 `\w+`，所以键名必须落在这个字符集内（见 engine/jsonpath.js） */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** RFC 7230 token，用于 Header 名 */
const HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/
const CRLF_RE = /[\r\n]/

const MAX_NAME = 60
const MAX_BASE_URL = 2048
const MAX_SECRET_BYTES = 4096
const MAX_VARIABLES_JSON = 64 * 1024
const MAX_SETTINGS_JSON = 8 * 1024
const MAX_KEYS = 200
/** M3-1：覆盖率取证的合法来源（V8 / lcov 留给 M3-3） */
const COVERAGE_SOURCES = ['jacoco']
const MIN_COVERAGE_TIMEOUT_MS = 100
const MAX_COVERAGE_TIMEOUT_MS = 30000
/** M3-2：路径/命令字段上限，防止把整个 settings 塞进一列异常文本 */
const MAX_COVERAGE_PATH = 1024
export const SECRET_MASK = '***'
/** 文本掩码最短明文长度：过短的值做全局替换会大面积误伤正常文本 */
const MIN_MASK_LEN = 3

export class EnvironmentError extends Error {
  /**
   * @param {string} code 稳定错误码（ENV_*），前端/脚本据此分支
   * @param {string} message 中文提示
   * @param {number} [status] HTTP 状态码
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'EnvironmentError'
    this.code = code
    this.status = status
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertObject(value, field, code) {
  if (value == null) return {}
  if (!isPlainObject(value)) throw new EnvironmentError(code, `${field} 必须是对象`)
  const count = Object.keys(value).length
  if (count > MAX_KEYS) throw new EnvironmentError(code, `${field} 键数量超过上限 ${MAX_KEYS}`)
  return value
}

function validateKey(field, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new EnvironmentError(
      'ENV_BAD_KEY',
      `${field} 的键名「${String(key)}」不合法：须以字母/下划线开头，仅含字母、数字、下划线，最长 64 字符`
    )
  }
}

function normalizeName(input) {
  const name = typeof input === 'string' ? input.trim() : ''
  if (!name) throw new EnvironmentError('ENV_BAD_NAME', '环境名称不能为空')
  if (name.length > MAX_NAME) throw new EnvironmentError('ENV_BAD_NAME', `环境名称最长 ${MAX_NAME} 字符`)
  if (CRLF_RE.test(name)) throw new EnvironmentError('ENV_BAD_NAME', '环境名称不允许包含换行')
  return name
}

function normalizeProjectId(projectId) {
  if (projectId == null || projectId === '') return null
  const id = String(projectId).trim()
  if (!id) return null
  if (!store.getProject(id)) {
    throw new EnvironmentError('ENV_PROJECT_NOT_FOUND', `关联的项目不存在：${id}`)
  }
  return id
}

function normalizeBaseUrl(input) {
  const raw = input == null ? '' : String(input).trim()
  if (!raw) return ''
  if (raw.length > MAX_BASE_URL) {
    throw new EnvironmentError('ENV_BAD_BASE_URL', `baseUrl 超过 ${MAX_BASE_URL} 字符`)
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new EnvironmentError('ENV_BAD_BASE_URL', `baseUrl「${raw}」不是合法 URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new EnvironmentError('ENV_BAD_BASE_URL', 'baseUrl 只允许 http/https')
  }
  if (url.username || url.password) {
    throw new EnvironmentError('ENV_BAD_BASE_URL', 'baseUrl 不允许内嵌账号密码，请改用 variables/secrets')
  }
  // 去掉末尾斜杠，拼接相对路径时由 resolveUrl 统一补一个
  return url.href.replace(/\/+$/, '')
}

function normalizeVariables(input, field = 'variables') {
  const obj = assertObject(input, field, 'ENV_BAD_VARIABLES')
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    validateKey(field, key)
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new EnvironmentError('ENV_BAD_VARIABLES', `${field}.${key} 的值不是合法 JSON 值`)
    }
    out[key] = value
  }
  if (JSON.stringify(out).length > MAX_VARIABLES_JSON) {
    throw new EnvironmentError('ENV_VARIABLES_TOO_LARGE', `${field} 序列化后超过 ${MAX_VARIABLES_JSON} 字节`)
  }
  return out
}

function normalizeHeaders(input) {
  const obj = assertObject(input, 'headers', 'ENV_BAD_HEADERS')
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!HEADER_KEY_RE.test(key)) {
      throw new EnvironmentError('ENV_BAD_HEADER_KEY', `Header 名「${key}」不合法`)
    }
    if (value == null) continue
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new EnvironmentError('ENV_BAD_HEADER_VALUE', `Header「${key}」的值只能是字符串/数字/布尔`)
    }
    const text = String(value)
    if (CRLF_RE.test(text)) {
      throw new EnvironmentError('ENV_BAD_HEADER_VALUE', `Header「${key}」的值不允许包含换行（防头注入）`)
    }
    out[key] = text
  }
  return out
}

/**
 * M3-1/M3-2：`settings.coverage` 的路径/命令字段。
 * 只做「非空 + 长度 + 无控制字符」校验；存在性在分析时检查（环境可先配置、后拷 jar）。
 * 空字符串等价于未配置，便于前端表单清空。
 */
function normalizeCoverageText(input, key) {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string') {
    throw new EnvironmentError('ENV_BAD_COVERAGE', `settings.coverage.${key} 必须是字符串`)
  }
  const value = input.trim()
  if (!value) return null
  if (value.length > MAX_COVERAGE_PATH || /[\u0000-\u001f]/.test(value)) {
    throw new EnvironmentError(
      'ENV_BAD_COVERAGE',
      `settings.coverage.${key} 不合法：最长 ${MAX_COVERAGE_PATH} 字符且不能含控制字符`
    )
  }
  return value
}

/**
 * M3-1：`settings.coverage` 校验。只允许 jacoco；端口/超时做范围限制，
 * 避免环境配置把执行链路带进「连 0 端口」或「等 10 分钟」的坑。
 *
 * M3-2 新增分析配置：
 *   classfiles  —— 被测项目编译产物目录（jacococli `--classfiles`，缺失则不分析）
 *   sourcefiles —— 源码目录（`--sourcefiles`，可选，只影响报告里的源码定位）
 *   cliPath     —— jacococli.jar 路径（默认仓库 PoC 或 JACOCO_CLI）
 *   javaBin     —— java 可执行文件（默认 PATH 中的 java，或 JAVA_BIN）
 */
function normalizeCoverageSettings(input) {
  // 显式传 null 表示关闭覆盖率取证
  if (input === null) return null
  if (!isPlainObject(input)) {
    throw new EnvironmentError('ENV_BAD_COVERAGE', 'settings.coverage 必须是对象或 null')
  }
  const source = input.source === undefined ? 'jacoco' : String(input.source)
  if (!COVERAGE_SOURCES.includes(source)) {
    throw new EnvironmentError(
      'ENV_BAD_COVERAGE',
      `settings.coverage.source 仅支持 ${COVERAGE_SOURCES.join('/')}，收到「${source}」`
    )
  }

  let host = '127.0.0.1'
  if (input.host !== undefined) {
    host = String(input.host).trim()
    if (!host) throw new EnvironmentError('ENV_BAD_COVERAGE', 'settings.coverage.host 不能为空')
    if (host.length > 255 || /[\s\r\n]/.test(host)) {
      throw new EnvironmentError(
        'ENV_BAD_COVERAGE',
        'settings.coverage.host 不合法：只能是主机名/IP，最长 255 字符且不能含空白'
      )
    }
  }

  let port = 6300
  if (input.port !== undefined) {
    port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new EnvironmentError('ENV_BAD_COVERAGE', 'settings.coverage.port 必须是 1..65535 的整数')
    }
  }

  let timeoutMs = 5000
  if (input.timeoutMs !== undefined) {
    timeoutMs = Number(input.timeoutMs)
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_COVERAGE_TIMEOUT_MS ||
      timeoutMs > MAX_COVERAGE_TIMEOUT_MS
    ) {
      throw new EnvironmentError(
        'ENV_BAD_COVERAGE',
        `settings.coverage.timeoutMs 必须是 ${MIN_COVERAGE_TIMEOUT_MS}..${MAX_COVERAGE_TIMEOUT_MS} 的整数`
      )
    }
  }

  let enabled = true
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      throw new EnvironmentError('ENV_BAD_COVERAGE', 'settings.coverage.enabled 必须是布尔值')
    }
    enabled = input.enabled
  }

  const out = { source, host, port, timeoutMs, enabled }
  for (const key of ['classfiles', 'sourcefiles', 'cliPath', 'javaBin']) {
    const value = normalizeCoverageText(input[key], key)
    if (value) out[key] = value
  }
  return out
}

/** `settings` 是预留扩展位：未知键原样保留，已知键严格校验 */
function normalizeSettings(input) {
  const obj = assertObject(input, 'settings', 'ENV_BAD_SETTINGS')
  const out = { ...obj }
  if (Object.hasOwn(obj, 'coverage')) {
    const coverage = normalizeCoverageSettings(obj.coverage)
    if (coverage) out.coverage = coverage
    else delete out.coverage
  }
  if (JSON.stringify(out).length > MAX_SETTINGS_JSON) {
    throw new EnvironmentError(
      'ENV_SETTINGS_TOO_LARGE',
      `settings 序列化后超过 ${MAX_SETTINGS_JSON} 字节`
    )
  }
  return out
}

function normalizeSecrets(input) {
  const obj = assertObject(input, 'secrets', 'ENV_BAD_SECRETS')
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    validateKey('secrets', key)
    validateSecretValue(key, value)
    out[key] = value
  }
  return out
}

function validateSecretValue(key, value) {
  if (value == null || value === '') {
    throw new EnvironmentError('ENV_BAD_SECRET', `密钥「${key}」的值不能为空`)
  }
  if (typeof value !== 'string') {
    throw new EnvironmentError('ENV_BAD_SECRET', `密钥「${key}」的值必须是字符串`)
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new EnvironmentError('ENV_SECRET_TOO_LARGE', `密钥「${key}」超过 ${MAX_SECRET_BYTES} 字节`)
  }
}

function assertNoKeyConflict(variables, secretKeys) {
  const clash = Object.keys(variables).filter((key) => secretKeys.includes(key))
  if (clash.length) {
    throw new EnvironmentError(
      'ENV_KEY_CONFLICT',
      `同一环境内 variables 与 secrets 的键名冲突：${clash.join('、')}（请改名或删除其中一个）`
    )
  }
}

function requireEnvironment(id) {
  const row = store.getEnvironmentRow(id)
  if (!row) throw new EnvironmentError('ENV_NOT_FOUND', `环境不存在：${id}`, 404)
  return row
}

const aadOf = (environmentId, key) => `${environmentId}|${key}`

function writeSecret(environmentId, key, value) {
  store.saveSecretRow(environmentId, key, getKeystore().encrypt(value, aadOf(environmentId, key)))
}

/** 只在内存里解密（执行链路专用），调用方不得把结果直接落库/下发 */
function readSecrets(environmentId) {
  const out = {}
  for (const row of store.listSecretRows(environmentId)) {
    out[row.key] = getKeystore().decrypt(row.valueBlob, aadOf(environmentId, row.key))
  }
  return out
}

/** 对外视图：永远不含 secrets 明文，只给键名 */
function publicView(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    baseUrl: row.baseUrl,
    variables: row.variables,
    headers: row.headers,
    secretKeys: store.listSecretKeys(row.id),
    settings: row.settings,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 唯一索引冲突（同项目重名）转成稳定错误码，而不是 500 */
function saveWithNameGuard(env) {
  try {
    store.saveEnvironment(env)
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw new EnvironmentError('ENV_NAME_CONFLICT', `同一项目下已存在同名环境：${env.name}`)
    }
    throw err
  }
  return env
}

export function listEnvironments(projectId) {
  const pid = projectId == null || projectId === '' ? null : String(projectId)
  return store
    .listEnvironmentRows()
    .filter((row) => !pid || row.projectId === pid)
    .map(publicView)
}

export function getEnvironment(id) {
  const row = store.getEnvironmentRow(id)
  return row ? publicView(row) : null
}

export function createEnvironment(input = {}) {
  const name = normalizeName(input.name)
  const projectId = normalizeProjectId(input.projectId)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const variables = normalizeVariables(input.variables)
  const headers = normalizeHeaders(input.headers)
  const settings = normalizeSettings(input.settings)
  const secrets = normalizeSecrets(input.secrets)
  assertNoKeyConflict(variables, Object.keys(secrets))

  const now = Date.now()
  const env = {
    id: crypto.randomUUID(),
    projectId,
    name,
    baseUrl,
    variables,
    headers,
    settings,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  saveWithNameGuard(env)
  for (const [key, value] of Object.entries(secrets)) writeSecret(env.id, key, value)
  return getEnvironment(env.id)
}

export function updateEnvironment(id, input = {}) {
  const row = requireEnvironment(id)
  const name = input.name === undefined ? row.name : normalizeName(input.name)
  const projectId = input.projectId === undefined ? row.projectId : normalizeProjectId(input.projectId)
  const baseUrl = input.baseUrl === undefined ? row.baseUrl : normalizeBaseUrl(input.baseUrl)
  const variables = input.variables === undefined ? row.variables : normalizeVariables(input.variables)
  const headers = input.headers === undefined ? row.headers : normalizeHeaders(input.headers)
  const settings = input.settings === undefined ? row.settings : normalizeSettings(input.settings)

  assertNoKeyConflict(variables, store.listSecretKeys(id))
  saveWithNameGuard({
    ...row,
    name,
    projectId,
    baseUrl,
    variables,
    headers,
    settings,
    version: row.version + 1,
    updatedAt: Date.now(),
  })
  return getEnvironment(id)
}

export function deleteEnvironment(id) {
  requireEnvironment(id)
  store.deleteEnvironment(id)
}

/**
 * 新增/覆盖单个密钥。密钥变更会 bump 环境版本：同一次执行记录能精确对齐到版本。
 * @returns {object} 不含明文的环境视图
 */
export function setSecret(id, key, value) {
  const row = requireEnvironment(id)
  validateKey('secrets', key)
  validateSecretValue(key, value)
  if (Object.hasOwn(row.variables, key)) {
    throw new EnvironmentError('ENV_KEY_CONFLICT', `variables 中已存在同名键「${key}」，不能再设为密钥`)
  }
  writeSecret(id, key, value)
  saveWithNameGuard({ ...row, version: row.version + 1, updatedAt: Date.now() })
  return getEnvironment(id)
}

export function deleteSecret(id, key) {
  const row = requireEnvironment(id)
  validateKey('secrets', key)
  if (!store.deleteSecretRow(id, key)) {
    throw new EnvironmentError('ENV_SECRET_NOT_FOUND', `密钥不存在：${key}`, 404)
  }
  saveWithNameGuard({ ...row, version: row.version + 1, updatedAt: Date.now() })
  return getEnvironment(id)
}

/**
 * 执行链路专用解析：返回 `variables`（普通变量 + secrets 明文合并）、`baseUrl`、
 * 全局 `headers`，以及供掩码使用的 `secretValues`。**不得直接返回给 HTTP 客户端。**
 */
export function resolveEnvironment(id) {
  const row = requireEnvironment(id)
  const secrets = readSecrets(id)
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    version: row.version,
    baseUrl: row.baseUrl,
    headers: { ...row.headers },
    variables: { ...row.variables, ...secrets },
    settings: { ...row.settings },
    secretValues: Object.values(secrets),
  }
}

/** 环境预览：secrets 只展示键名，合并后的变量值统一打码 */
export function previewEnvironment(id) {
  const view = getEnvironment(id)
  if (!view) throw new EnvironmentError('ENV_NOT_FOUND', `环境不存在：${id}`, 404)
  const resolved = resolveEnvironment(id)
  const secretKeys = new Set(view.secretKeys)
  return {
    ...view,
    resolved: {
      baseUrl: resolved.baseUrl,
      variables: Object.fromEntries(
        Object.entries(resolved.variables).map(([key, value]) => [
          key,
          secretKeys.has(key) ? SECRET_MASK : value,
        ])
      ),
      headers: resolved.headers,
    },
  }
}

/**
 * 把文本里的 secret 明文替换为 `***`（长度 < 3 的值跳过，避免误伤正常文本）。
 * @param {string} text
 * @param {Array<string|number|boolean>} secretValues
 */
export function maskText(text, secretValues) {
  let out = String(text)
  for (const value of secretValues || []) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue
    const plain = String(value)
    if (plain.length < MIN_MASK_LEN) continue
    out = out.split(plain).join(SECRET_MASK)
  }
  return out
}

/**
 * 递归掩码任意 JSON 结构（对象键名保持不变，只替换字符串值）。
 * @param {*} value
 * @param {Array<string|number|boolean>} secretValues
 */
export function maskDeep(value, secretValues) {
  const secrets = (secretValues || []).filter(
    (item) => ['string', 'number', 'boolean'].includes(typeof item) && String(item).length >= MIN_MASK_LEN
  )
  if (!secrets.length) return value

  const walk = (node) => {
    if (typeof node === 'string') return maskText(node, secrets)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, child] of Object.entries(node)) out[key] = walk(child)
      return out
    }
    return node
  }
  return walk(value)
}
