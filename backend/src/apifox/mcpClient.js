/**
 * Apifox MCP 客户端：通过 STDIO 以 JSON-RPC 2.0 协议拉起官方 apifox-mcp-server，
 * 免导出直接读取 Apifox 项目内的接口文档（OpenAPI 数据）。
 *
 * 官方包：apifox-mcp-server（npm），协议要点：
 *  - initialize → notifications/initialized → tools/list → tools/call
 *  - 工具：read_project_oas / read_project_oas_ref_resources / refresh_project_oas
 *  - --tool-suffix 参数可固定工具名（默认会追加随机后缀）
 *  - 项目模式需要 APIFOX_ACCESS_TOKEN；--oas=<file|url> 模式免 token
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 官方 MCP Server 入口（backend 依赖安装后即存在） */
export function resolveServerEntry() {
  try {
    return require.resolve('apifox-mcp-server/lib/index.js')
  } catch {
    return null
  }
}

export class ApifoxMcpClient {
  /**
   * @param {object} options
   * @param {string} [options.projectId]  Apifox 项目 ID（与 siteId / specFile 三选一）
   * @param {string} [options.token]      Apifox 个人访问令牌
   * @param {string} [options.siteId]     在线文档站点 ID（免 token，仅公开文档）
   * @param {string} [options.branchId]   迭代分支 ID
   * @param {string} [options.baseUrl]    私有化部署的 API 地址
   * @param {string} [options.specFile]   本地/远程 OpenAPI 文件（备用联调模式，免 token）
   * @param {string} [options.dataLocation] MCP 缓存目录根（默认 backend/data/apifox）
   * @param {number} [options.timeoutMs]  单次请求超时
   */
  constructor(options = {}) {
    this.projectId = options.projectId || ''
    this.token = options.token || ''
    this.siteId = options.siteId || ''
    this.branchId = options.branchId || ''
    this.baseUrl = options.baseUrl || ''
    this.specFile = options.specFile || ''
    this.dataLocation = options.dataLocation || ''
    this.timeoutMs = options.timeoutMs || 120000
    this.child = null
    this.stderrBuf = ''
    this.exitError = null
    this.pending = new Map()
    this.nextId = 1
  }

  #buildArgs() {
    const args = []
    if (this.specFile) args.push(`--oas=${this.specFile}`)
    else if (this.siteId) args.push(`--site-id=${this.siteId}`)
    else args.push(`--project=${this.projectId}`)
    if (this.branchId) args.push(`--branch-id=${this.branchId}`)
    if (this.baseUrl) args.push(`--apifox-api-base-url=${this.baseUrl}`)
    // 固定工具名，去掉官方包默认追加的随机后缀（minimist 需显式空值）
    args.push('--tool-suffix=')
    return args
  }

  async start() {
    const entry = resolveServerEntry()
    if (!entry) {
      throw new Error('未找到 apifox-mcp-server，请在 backend 目录执行 npm install')
    }
    const env = { ...process.env }
    if (this.dataLocation) env.APIFOX_DATA_LOCATION = this.dataLocation
    if (this.token) env.APIFOX_ACCESS_TOKEN = this.token
    else delete env.APIFOX_ACCESS_TOKEN

    this.child = spawn(process.execPath, [entry, ...this.#buildArgs()], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.#handleLine(line))
    this.child.stderr.on('data', (chunk) => {
      this.stderrBuf = (this.stderrBuf + String(chunk)).slice(-4000)
    })
    this.child.on('exit', (code) => {
      this.exitError = new Error(this.#exitMessage(code))
      for (const reject of this.pending.values()) reject(this.exitError)
      this.pending.clear()
    })

    const init = await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'heibaihe', version: '0.1.0' },
    })
    if (!init?.result) throw new Error(`MCP 初始化失败：${JSON.stringify(init).slice(0, 300)}`)
    await this.#notify('notifications/initialized')
    return init.result
  }

  #exitMessage(code) {
    const detail = this.stderrBuf.trim().split('\n').filter(Boolean).pop() || ''
    if (/provide a token/i.test(detail)) return '缺少 Apifox 访问令牌（APIFOX_ACCESS_TOKEN）'
    if (/provide a project id/i.test(detail)) return '缺少 Apifox 项目 ID'
    return `Apifox MCP 进程退出（code ${code}）${detail ? `：${detail.slice(0, 300)}` : ''}`
  }

  #handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return // 忽略非 JSON 输出（官方包偶发的日志）
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      resolve(msg)
    }
    // 其余为通知，暂不处理
  }

  #request(method, params, timeoutMs) {
    if (!this.child) throw new Error('MCP 客户端尚未启动')
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 请求超时（${Math.round((timeoutMs || this.timeoutMs) / 1000)}s）`))
      }, timeoutMs || this.timeoutMs)
      const wrapped = (msg) => {
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error).slice(0, 300)))
        else resolve(msg)
      }
      this.pending.set(id, wrapped)
      try {
        this.child.stdin.write(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`MCP 进程通信失败：${err.message}`))
      }
    })
  }

  #notify(method) {
    if (!this.child) return Promise.resolve()
    return new Promise((resolve) => {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n', () => resolve())
    })
  }

  async listTools() {
    const res = await this.#request('tools/list', {})
    return res.result?.tools || []
  }

  /** 调用工具并返回首个 text 内容 */
  async callTool(name, args = {}, timeoutMs) {
    const res = await this.#request('tools/call', { name, arguments: args }, timeoutMs)
    const result = res.result
    if (!result) throw new Error(`工具 ${name} 调用失败：${JSON.stringify(res).slice(0, 300)}`)
    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    if (result.isError) throw new Error(text || `工具 ${name} 执行失败`)
    return text
  }

  close() {
    if (!this.child) return
    try {
      this.child.kill()
    } catch {
      /* 忽略 */
    }
    this.child = null
    this.pending.clear()
  }
}

/** 从工具列表中按前缀挑选（兼容带随机后缀的命名） */
export function pickTool(tools, prefix) {
  const exact = tools.find((t) => t.name === prefix)
  if (exact) return exact.name
  const matched = tools.find((t) => t.name.startsWith(prefix))
  if (!matched) throw new Error(`Apifox MCP 未提供工具 ${prefix}（可用：${tools.map((t) => t.name).join(', ')}）`)
  return matched.name
}
