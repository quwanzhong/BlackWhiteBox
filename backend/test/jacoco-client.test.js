import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { JacocoClient, JACOCO_PROTOCOL, probeAgent } from '../src/coverage/jacoco-client.js'

const HEADER = Buffer.from([0x01, 0xc0, 0xc0, 0x10, 0x07])

function varint(value) {
  const out = []
  let left = value
  do {
    let byte = left & 0x7f
    left >>>= 7
    if (left) byte |= 0x80
    out.push(byte)
  } while (left)
  return Buffer.from(out)
}

/** 一个合法的 SESSIONINFO 块（0x10 + 长度 + id + 16 字节时间戳） */
function sessionBlock(id = 'scene12') {
  const idBuf = Buffer.from(id)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(idBuf.length)
  return Buffer.concat([Buffer.from([0x10]), len, idBuf, Buffer.alloc(16)])
}

/** 一个合法的 EXECUTIONDATA 块（0x11 + classId + 名称 + varint 探针数 + 位图） */
function execBlock({ name = 'com/poc/OrderService', probes = 10, bits = Buffer.alloc(Math.ceil(probes / 8), 0b10000001) } = {}) {
  const nameBuf = Buffer.from(name)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(nameBuf.length)
  return Buffer.concat([
    Buffer.from([0x11]),
    Buffer.alloc(8, 0xab),
    len,
    nameBuf,
    varint(probes),
    bits,
  ])
}

/**
 * 协议级假 agent：只实现 PoC 反编译确认的字节语义，不依赖 JDK。
 * @param {{header?: Buffer, blocks?: Buffer[], cmdOk?: number, silence?: boolean,
 *          splitBytes?: boolean, unknownBlock?: boolean, closeAfterHandshake?: boolean}} opts
 */
async function startAgent(opts = {}) {
  const header = opts.header || HEADER
  const blocks = opts.blocks || [sessionBlock(), execBlock()]
  const cmdOk = opts.cmdOk ?? JACOCO_PROTOCOL.BLOCK_CMD_OK
  const connections = []
  const commands = []

  const server = net.createServer((socket) => {
    const state = { handshake: false, buffer: Buffer.alloc(0) }
    connections.push(state)
    if (opts.silence) return
    if (opts.closeAfterHandshake) {
      // 接受连接但一个字节都不发就断开：模拟 agent 崩溃/被防火墙重置
      socket.destroy()
      return
    }
    socket.write(header)

    const send = (buf) => {
      if (!opts.splitBytes) {
        socket.write(buf)
        return
      }
      let i = 0
      const tick = () => {
        if (i >= buf.length || socket.destroyed) return
        socket.write(buf.subarray(i, i + 1))
        i += 1
        setTimeout(tick, 1)
      }
      tick()
    }

    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk])
      if (!state.handshake) {
        if (state.buffer.length < 5) return
        state.handshake = true
        state.echo = state.buffer.subarray(0, 5)
        state.buffer = state.buffer.subarray(5)
      }
      while (state.buffer.length >= 3) {
        const frame = state.buffer.subarray(0, 3)
        state.buffer = state.buffer.subarray(3)
        commands.push({ dump: frame[1], reset: frame[2] })
        if (opts.unknownBlock) {
          send(Buffer.from([0x7f, 0x20]))
          continue
        }
        if (frame[1] === 1) send(Buffer.concat([...blocks, Buffer.from([cmdOk])]))
        else send(Buffer.from([cmdOk]))
      }
    })
    socket.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    commands,
    connections,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 先占一个端口再释放，得到一个稳定「没人监听」的端口 */
async function deadPort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('jacoco-client：握手收 5 字节 exec 头并原样回写', async () => {
  const agent = await startAgent()
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 1000 })
    assert.deepEqual(client.header, HEADER)
    // 回写是同一次 connect 内完成的，agent 侧必须收到一模一样的 5 字节
    const state = agent.connections[0]
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(state.echo, HEADER)
    await client.close()
  } finally {
    await agent.close()
  }
})

test('jacoco-client：reset 只发 40 00 01 并等 CMDOK', async () => {
  const agent = await startAgent()
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 1000 })
    const out = await client.reset()
    assert.deepEqual(out, { ok: true })
    assert.deepEqual(agent.commands, [{ dump: 0, reset: 1 }])
    await client.close()
  } finally {
    await agent.close()
  }
})

test('jacoco-client：dumpAndReset 返回逐字节可用的 .exec（含多字节 varint）', async () => {
  const blocks = [sessionBlock('scene-12'), execBlock({ probes: 300, bits: Buffer.alloc(38, 0xff) })]
  const agent = await startAgent({ blocks })
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 1000 })
    const out = await client.dumpAndReset()
    assert.deepEqual(agent.commands, [{ dump: 1, reset: 1 }])
    // .exec = exec 头 + 原始块（CMDOK 不属于 exec 格式）
    assert.deepEqual(out.exec, Buffer.concat([HEADER, ...blocks]))
    assert.equal(out.bytes, HEADER.length + blocks[0].length + blocks[1].length)
    assert.ok(Number.isFinite(out.ms))
    await client.close()
  } finally {
    await agent.close()
  }
})

test('jacoco-client：dump 不清零（40 01 00），且能跨 TCP 分片重组', async () => {
  const agent = await startAgent({ splitBytes: true })
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 1000 })
    const out = await client.dump()
    assert.deepEqual(agent.commands, [{ dump: 1, reset: 0 }])
    assert.ok(out.bytes > 5)
    await client.close()
  } finally {
    await agent.close()
  }
})

test('jacoco-client：exec 头不正确直接判协议错误', async () => {
  const bad = await startAgent({ header: Buffer.from([0x00, 0xc0, 0xc0, 0x10, 0x07]) })
  try {
    await assert.rejects(
      JacocoClient.connect({ port: bad.port, timeoutMs: 500 }),
      (err) => err.code === 'COVERAGE_AGENT_PROTOCOL' && /exec 头不匹配/.test(err.message)
    )
  } finally {
    await bad.close()
  }
})

test('jacoco-client：agent 不响应 → COVERAGE_AGENT_TIMEOUT', async () => {
  const agent = await startAgent({ silence: true })
  try {
    await assert.rejects(
      JacocoClient.connect({ port: agent.port, timeoutMs: 60 }),
      (err) => err.code === 'COVERAGE_AGENT_TIMEOUT'
    )
  } finally {
    await agent.close()
  }
})

test('jacoco-client：连接被拒绝 → COVERAGE_AGENT_UNREACHABLE', async () => {
  const port = await deadPort()
  await assert.rejects(
    JacocoClient.connect({ port, timeoutMs: 500, connectTimeoutMs: 500 }),
    (err) => err.code === 'COVERAGE_AGENT_UNREACHABLE' && /连接被拒绝/.test(err.message)
  )
})

test('jacoco-client：握手后立刻断开 → COVERAGE_AGENT_CLOSED', async () => {
  const agent = await startAgent({ closeAfterHandshake: true })
  try {
    await assert.rejects(
      JacocoClient.connect({ port: agent.port, timeoutMs: 500 }),
      (err) => err.code === 'COVERAGE_AGENT_CLOSED' || err.code === 'COVERAGE_AGENT_PROTOCOL'
    )
  } finally {
    await agent.close()
  }
})

test('jacoco-client：未知响应块 → COVERAGE_AGENT_PROTOCOL', async () => {
  const agent = await startAgent({ unknownBlock: true })
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 500 })
    await assert.rejects(
      client.dumpAndReset(),
      (err) => err.code === 'COVERAGE_AGENT_PROTOCOL' && /未知响应块/.test(err.message)
    )
    await client.close()
  } finally {
    await agent.close()
  }
})

test('jacoco-client：非 CMDOK 应答 → COVERAGE_AGENT_PROTOCOL', async () => {
  const agent = await startAgent({ cmdOk: 0x21 })
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 500 })
    await assert.rejects(
      client.reset(),
      (err) => err.code === 'COVERAGE_AGENT_PROTOCOL' && /CMDOK/.test(err.message)
    )
    await client.close()
  } finally {
    await agent.close()
  }
})

test('jacoco-client：关闭后继续发命令 → COVERAGE_AGENT_CLOSED', async () => {
  const agent = await startAgent()
  try {
    const client = await JacocoClient.connect({ port: agent.port, timeoutMs: 500 })
    await client.close()
    await assert.rejects(
      client.reset(),
      (err) => err.code === 'COVERAGE_AGENT_CLOSED'
    )
  } finally {
    await agent.close()
  }
})

test('jacoco-client：非法端口在构造时就报 COVERAGE_BAD_CONFIG', () => {
  for (const port of [0, 65536, 1.5, 'abc']) {
    assert.throws(
      () => new JacocoClient({ port }),
      (err) => err.code === 'COVERAGE_BAD_CONFIG'
    )
  }
})

test('probeAgent：可用返回 ok，不可用返回 code 而不抛错', async () => {
  const agent = await startAgent()
  try {
    assert.deepEqual(await probeAgent({ port: agent.port, timeoutMs: 500 }), { ok: true })
  } finally {
    await agent.close()
  }
  const port = await deadPort()
  const bad = await probeAgent({ port, timeoutMs: 300, connectTimeoutMs: 300 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'COVERAGE_AGENT_UNREACHABLE')
  assert.match(bad.error, /无法连接/)
})
