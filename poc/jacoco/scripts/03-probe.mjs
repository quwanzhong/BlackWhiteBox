#!/usr/bin/env node
/**
 * 03-probe.mjs — JaCoCo agent 远程控制客户端（PoC 核心）
 *
 * 协议依据：反编译 org.jacoco.agent.rt 0.8.12 的 TcpConnection / RemoteControlWriter
 *   1) 连接建立后，agent 立即写入 exec 头 5 字节：01 C0 C0 <version hi> <version lo>
 *   2) 命令帧只有 3 字节：0x40 + dump(bool) + reset(bool)
 *   3) 回包是原始 exec 数据块（0x10 / 0x11 ...），最后以单字节 0x20（CMDOK）结束
 *
 * 用法：
 *   node 03-probe.mjs --agent-port 6300 --base http://127.0.0.1:8089 --out ../out
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const CMD = 0x40
const BLOCK_HEADER = 0x01
const BLOCK_SESSION = 0x10
const BLOCK_EXEC = 0x11
const CMD_OK = 0x20

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const agentPort = Number(arg('agent-port', '6300'))
const base = arg('base', 'http://127.0.0.1:8089').replace(/\/$/, '')
const outDir = path.resolve(arg('out', path.join(import.meta.dirname, '..', 'out')))
fs.mkdirSync(outDir, { recursive: true })

/** 顺序读字节的流式读取器：按需 readExact(n)，不依赖分帧。 */
class ByteReader {
  constructor(socket) {
    this.buf = Buffer.alloc(0)
    this.error = null
    this.waiter = null
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.wake()
    })
    socket.on('error', (err) => { this.error = err; this.wake() })
    socket.on('close', () => {
      this.error = this.error || new Error('agent 连接已关闭')
      this.wake()
    })
  }

  wake() {
    if (this.waiter && (this.buf.length > 0 || this.error)) {
      const w = this.waiter
      this.waiter = null
      w()
    }
  }

  async readExact(n, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    while (this.buf.length < n) {
      if (this.error) throw this.error
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`读取超时：需要 ${n} 字节，当前 ${this.buf.length}`)
      await new Promise((resolve) => {
        this.waiter = resolve
        setTimeout(() => { if (this.waiter === resolve) { this.waiter = null; resolve() } }, left)
      })
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return Buffer.from(out)
  }
}

const u8 = (b) => b.readUInt8(0)
const u16 = (b) => b.readUInt16BE(0)
const u32 = (b) => b.readInt32BE(0)

/** 发送 3 字节命令帧 */
function command(socket, dump, reset) {
  socket.write(Buffer.from([CMD, dump ? 1 : 0, reset ? 1 : 0]))
}

async function reset(reader, socket) {
  command(socket, false, true)
  const ack = u8(await reader.readExact(1))
  if (ack !== CMD_OK) throw new Error(`reset 未收到 CMDOK，收到 0x${ack.toString(16)}`)
}

/** dump：把 exec 头 + 所有数据块拼成一个完整 .exec 文件
 *  块格式（ExecutionDataWriter）：
 *    0x10 SESSIONINFO  = UTF id(2字节长度+内容) + long start + long dump
 *    0x11 EXECUTIONDATA= long id(8字节) + UTF 类名 + varint 探针数 + 打包位图
 *    0x20 CMDOK        = 结束
 */
async function dump(reader, socket) {
  const t0 = performance.now()
  command(socket, true, false)
  const parts = []

  for (;;) {
    const type = u8(await reader.readExact(1))
    if (type === CMD_OK) break

    if (type === BLOCK_EXEC) {
      const id = await reader.readExact(8)
      const nameLenBuf = await reader.readExact(2)
      const name = await reader.readExact(nameLenBuf.readUInt16BE(0))
      // varint：低位在前，每字节最高位表示是否还有后续
      const varBytes = []
      let probeCount = 0
      let shift = 0
      for (;;) {
        const b = await reader.readExact(1)
        varBytes.push(b)
        probeCount |= (b[0] & 0x7f) << shift
        if ((b[0] & 0x80) === 0) break
        shift += 7
      }
      const probes = await reader.readExact(Math.ceil(probeCount / 8))
      parts.push(Buffer.concat([Buffer.from([type]), id, nameLenBuf, name, ...varBytes, probes]))
    } else if (type === BLOCK_SESSION) {
      const idLenBuf = await reader.readExact(2)
      const id = await reader.readExact(idLenBuf.readUInt16BE(0))
      const timestamps = await reader.readExact(16)
      parts.push(Buffer.concat([Buffer.from([type]), idLenBuf, id, timestamps]))
    } else {
      throw new Error(`未知块类型 0x${type.toString(16)}，协议解析失败`)
    }
  }

  return {
    data: Buffer.concat([header, ...parts]),
    ms: Math.round(performance.now() - t0),
  }
}

/** 连接后先收 agent 主动发来的 exec 头 */
async function handshake(reader) {
  const h = await reader.readExact(5)
  if (h[0] !== BLOCK_HEADER || h[1] !== 0xc0 || h[2] !== 0xc0) {
    throw new Error('exec 头不匹配：' + h.toString('hex'))
  }
  return h
}

async function hit(url) {
  const t0 = performance.now()
  const res = await fetch(url)
  const body = await res.text()
  return { status: res.status, body, ms: Math.round(performance.now() - t0) }
}

const socket = await new Promise((resolve, reject) => {
  const s = net.createConnection({ host: '127.0.0.1', port: agentPort }, () => resolve(s))
  s.once('error', reject)
})
const reader = new ByteReader(socket)
let header
const result = { agentPort, base, nodes: [], startedAt: new Date().toISOString() }

try {
  header = await handshake(reader)
  result.execFormat = header.subarray(3).toString('hex')
  // 关键：agent 的 reader 也要求"首个块必须是 exec 头"，否则抛 Invalid execution data file
  socket.write(header)

  // 0) 清掉类初始化噪声（harness 启动时构造了 Service 实例）
  await reset(reader, socket)
  const calibration = await dump(reader, socket)
  fs.writeFileSync(path.join(outDir, 'node-0-calibration.exec'), calibration.data)
  result.calibration = { bytes: calibration.data.length, ms: calibration.ms }

  // A) 只打订单链路
  await reset(reader, socket)
  const reqA = await hit(`${base}/order/create?userId=u1&sku=sku-1&count=2&amount=100`)
  const a = await dump(reader, socket)
  fs.writeFileSync(path.join(outDir, 'node-A.exec'), a.data)
  result.nodes.push({ id: 'node-A', ...reqA, execBytes: a.data.length, dumpMs: a.ms })

  // B) 只打库存链路（与 A 不相交）
  await reset(reader, socket)
  const reqB = await hit(`${base}/stock/deduct?sku=sku-1&count=1`)
  const b = await dump(reader, socket)
  fs.writeFileSync(path.join(outDir, 'node-B.exec'), b.data)
  result.nodes.push({ id: 'node-B', ...reqB, execBytes: b.data.length, dumpMs: b.ms })

  // C) 库存不足分支（用于展示未覆盖行）
  await reset(reader, socket)
  const reqC = await hit(`${base}/stock/deduct?sku=sku-1&count=999`)
  const c = await dump(reader, socket)
  fs.writeFileSync(path.join(outDir, 'node-C.exec'), c.data)
  result.nodes.push({ id: 'node-C', ...reqC, execBytes: c.data.length, dumpMs: c.ms })

  result.ok = true
} catch (err) {
  result.ok = false
  result.error = String(err && err.message ? err.message : err)
} finally {
  socket.end()
}

fs.writeFileSync(path.join(outDir, 'probe-result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
