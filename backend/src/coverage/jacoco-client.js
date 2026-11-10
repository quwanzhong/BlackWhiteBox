/**
 * JaCoCo agent TCP 远程控制客户端（M3-1 / docs/02 §6.2）
 *
 * 协议依据：反编译 org.jacoco.agent.rt 0.8.12 的 TcpConnection / RemoteControlWriter /
 * RemoteControlReader / ExecutionDataWriter（PoC 已实测，见 poc/jacoco/README.md §2）：
 *
 *   1) 连接建立后 agent 主动发 5 字节 exec 头：01 C0 C0 <version hi> <version lo>；
 *   2) 客户端必须原样回写这 5 字节，否则 agent 直接断连；
 *   3) 命令帧固定 3 字节：0x40 + dump(0|1) + reset(0|1)；
 *   4) 回包是 exec 数据块（0x10 SESSIONINFO / 0x11 EXECUTIONDATA），以 0x20 CMDOK 结束。
 *
 * 只在单个节点上做 reset / dump：节点前 reset 清空，节点后 dumpAndReset 取数并清零，
 * 因此每个节点的 exec 快照互相独立，不需要做探针差集。
 *
 * 本模块只负责「把字节拿回来」，不做分析、不落库：产物是一个合法的 .exec Buffer，
 * 交给 M3-2 的 jacococli 批量分析（PoC 实测约 200 ms/节点）。
 */
import net from 'node:net'

const BLOCK_HEADER = 0x01
const BLOCK_SESSION = 0x10
const BLOCK_EXEC = 0x11
const BLOCK_CMD_OK = 0x20
const CMD = 0x40

const DEFAULT_PORT = 6300
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CONNECT_TIMEOUT_MS = 3000

/** 带稳定 code 的错误：路由/采集器据此决定降级，而不是把 500 抛给前端 */
export class JacocoError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'JacocoError'
    this.code = code
    this.cause = cause
  }
}

/** 顺序读字节：按需 readExact(n)，不依赖分帧（TCP 可能把响应拆成任意块） */
class SocketReader {
  constructor(socket, wrapError = (err) => err) {
    this.buffer = Buffer.alloc(0)
    this.error = null
    this.waiter = null
    this.wrapError = wrapError
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake()
    })
    socket.on('error', (err) => {
      this.error = this.wrapError(err)
      this.wake()
    })
    socket.on('close', () => {
      this.error = this.error || new JacocoError('COVERAGE_AGENT_CLOSED', 'agent 连接已关闭')
      this.wake()
    })
  }

  wake() {
    if (this.waiter && (this.buffer.length > 0 || this.error)) {
      const resolve = this.waiter
      this.waiter = null
      resolve()
    }
  }

  async readExact(count, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length < count) {
      if (this.error) throw this.error
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new JacocoError(
          'COVERAGE_AGENT_TIMEOUT',
          `读取超时：需要 ${count} 字节，只收到 ${this.buffer.length} 字节`
        )
      }
      await new Promise((resolve) => {
        this.waiter = resolve
        const timer = setTimeout(() => {
          if (this.waiter === resolve) {
            this.waiter = null
            resolve()
          }
        }, left)
        timer.unref?.()
      })
    }
    const out = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return Buffer.from(out)
  }
}

function normalizePort(port) {
  const value = Number(port ?? DEFAULT_PORT)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new JacocoError('COVERAGE_BAD_CONFIG', `JaCoCo agent 端口非法：${port}`)
  }
  return value
}

function wrapSocketError(err, host, port) {
  if (err instanceof JacocoError) return err
  const reason = err?.code === 'ECONNREFUSED' ? '连接被拒绝' : err?.message || String(err)
  return new JacocoError(
    'COVERAGE_AGENT_UNREACHABLE',
    `无法连接 JaCoCo agent ${host}:${port}（${reason}）`,
    err
  )
}

export class JacocoClient {
  /**
   * @param {{host?: string, port?: number, timeoutMs?: number, connectTimeoutMs?: number}} opts
   */
  constructor({ host = '127.0.0.1', port, timeoutMs = DEFAULT_TIMEOUT_MS, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    this.host = host
    this.port = normalizePort(port)
    this.timeoutMs = timeoutMs
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = null
    this.reader = null
    this.header = null
    this.closed = false
  }

  /** 连接 + 握手（收 agent 的 exec 头并原样回写）。失败抛 JacocoError。 */
  static async connect(opts = {}) {
    const client = new JacocoClient(opts)
    await client.open()
    return client
  }

  async open() {
    if (this.socket) return this
    const socket = net.createConnection({ host: this.host, port: this.port })
    socket.setNoDelay(true)
    this.socket = socket
    this.reader = new SocketReader(socket, (err) => wrapSocketError(err, this.host, this.port))

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(
          new JacocoError(
            'COVERAGE_AGENT_TIMEOUT',
            `连接 JaCoCo agent ${this.host}:${this.port} 超时（${this.connectTimeoutMs} ms）`
          )
        )
      }, this.connectTimeoutMs)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(wrapSocketError(err, this.host, this.port))
      })
    })

    try {
      // agent 的 reader 要求首个块必须是 exec 头，客户端也要回写同样的 5 字节
      const header = await this.reader.readExact(5, this.timeoutMs)
      if (header[0] !== BLOCK_HEADER || header[1] !== 0xc0 || header[2] !== 0xc0) {
        throw new JacocoError(
          'COVERAGE_AGENT_PROTOCOL',
          `exec 头不匹配：${header.toString('hex')}（期望 01 C0 C0 ...）`
        )
      }
      socket.write(header)
      this.header = header
      return this
    } catch (err) {
      await this.close()
      throw err instanceof JacocoError ? err : wrapSocketError(err, this.host, this.port)
    }
  }

  assertOpen() {
    if (!this.socket || this.closed) {
      throw new JacocoError('COVERAGE_AGENT_CLOSED', 'JaCoCo agent 连接未建立或已关闭')
    }
  }

  /** 发送一帧命令：40 <dump> <reset> */
  sendCommand({ dump, reset }) {
    this.assertOpen()
    this.socket.write(Buffer.from([CMD, dump ? 1 : 0, reset ? 1 : 0]))
  }

  /** 简单命令（reset）只回一个 CMDOK */
  async expectCmdOk() {
    const ack = await this.reader.readExact(1, this.timeoutMs)
    if (ack[0] === BLOCK_CMD_OK) return
    throw new JacocoError(
      'COVERAGE_AGENT_PROTOCOL',
      `命令未收到 CMDOK，收到 0x${ack[0].toString(16)}`
    )
  }

  /** 节点开始前清零：不取数，只重置探针 */
  async reset() {
    this.sendCommand({ dump: false, reset: true })
    await this.expectCmdOk()
    return { ok: true }
  }

  /** 只取数不清零（保留累计语义，供调试/校准使用） */
  async dump() {
    return this.readExecData({ dump: true, reset: false })
  }

  /** 推荐：取数 + 清零原子完成，消除 dump 与 reset 之间的漏计窗口 */
  async dumpAndReset() {
    return this.readExecData({ dump: true, reset: true })
  }

  /**
   * 读取 dump 响应，拼成合法 .exec 文件：
   *   exec 头 + SESSIONINFO / EXECUTIONDATA 块 + 不写 CMDOK（它不是 exec 格式的一部分）
   */
  async readExecData({ dump, reset }) {
    const startedAt = performance.now()
    this.sendCommand({ dump, reset })
    const parts = []
    for (;;) {
      const type = (await this.reader.readExact(1, this.timeoutMs))[0]
      if (type === BLOCK_CMD_OK) break

      if (type === BLOCK_EXEC) {
        const classId = await this.reader.readExact(8, this.timeoutMs)
        const nameLen = (await this.reader.readExact(2, this.timeoutMs)).readUInt16BE(0)
        const name = await this.reader.readExact(nameLen, this.timeoutMs)
        const { bytes: countParts, value: probeCount } = await this.readVarInt()
        const probes = await this.reader.readExact(Math.ceil(probeCount / 8), this.timeoutMs)
        // varint 原样回写，保证 .exec 与 agent 输出逐字节兼容
        parts.push(
          Buffer.concat([Buffer.from([type]), classId, nameLenBuf(nameLen), name, ...countParts, probes])
        )
      } else if (type === BLOCK_SESSION) {
        const idLenBuf = await this.reader.readExact(2, this.timeoutMs)
        const idLen = idLenBuf.readUInt16BE(0)
        const id = await this.reader.readExact(idLen, this.timeoutMs)
        const timestamps = await this.reader.readExact(16, this.timeoutMs)
        parts.push(Buffer.concat([Buffer.from([type]), idLenBuf, id, timestamps]))
      } else {
        throw new JacocoError(
          'COVERAGE_AGENT_PROTOCOL',
          `未知响应块类型 0x${type.toString(16)}，协议解析失败`
        )
      }
    }
    const exec = Buffer.concat([this.header, ...parts])
    return { exec, bytes: exec.length, ms: Math.round(performance.now() - startedAt) }
  }

  /** varint：低位在前，每字节最高位表示是否还有后续 */
  async readVarInt() {
    const bytes = []
    let value = 0
    let shift = 0
    for (;;) {
      const b = await this.reader.readExact(1, this.timeoutMs)
      bytes.push(b)
      value |= (b[0] & 0x7f) << shift
      if ((b[0] & 0x80) === 0) break
      shift += 7
      if (shift > 35) {
        throw new JacocoError('COVERAGE_AGENT_PROTOCOL', '探针数 varint 超长，协议解析失败')
      }
    }
    return { bytes, value }
  }

  async close() {
    if (!this.socket) return
    this.closed = true
    const socket = this.socket
    this.socket = null
    socket.destroy()
  }
}

/** 长度字段工具（避免在循环里反复分配乱序） */
function nameLenBuf(len) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(len)
  return buf
}

/**
 * 探测 agent 是否可用：连接握手成功后立即关闭，不改动探针状态。
 * 仅供「执行前自检 / 场景验证」使用，执行链路不依赖它。
 */
export async function probeAgent(opts = {}) {
  try {
    const client = await JacocoClient.connect(opts)
    await client.close()
    return { ok: true }
  } catch (err) {
    return { ok: false, code: err?.code || 'COVERAGE_AGENT_UNREACHABLE', error: err?.message || String(err) }
  }
}

export const JACOCO_PROTOCOL = {
  BLOCK_HEADER,
  BLOCK_SESSION,
  BLOCK_EXEC,
  BLOCK_CMD_OK,
  CMD,
}
