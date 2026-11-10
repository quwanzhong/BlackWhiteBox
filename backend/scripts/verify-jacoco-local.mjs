/**
 * 本地真实 JaCoCo 验证（M3-1 · 不纳入 CI）
 *
 * 场景 12 用「协议级假 agent」保证 CI 无 JDK 也能验证契约；本脚本用仓库 PoC 里的
 * 真 jar + 真 JVM 复核同一套客户端代码：
 *
 *   1) 真 agent 握手 / reset / dumpAndReset 可用（probeAgent 自检）；
 *   2) per-node 隔离：订单节点只命中 OrderService，库存节点只命中 StockService；
 *   3) .exec 能被 jacococli 解析成 XML（即 M3-2 的输入是合法文件）。
 *
 * 前置：poc/jacoco/tools/*.jar 与 poc/jacoco/out/classes 已就绪
 * （见 poc/jacoco/README.md §3，jar 与产物都在 .gitignore 内，所以不能进 CI）。
 *
 * 用法：node scripts/verify-jacoco-local.mjs
 *   证据（.exec + XML）写到 poc/jacoco/out/m3-verify-<ts>/，方便人工复核。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JacocoClient, probeAgent } from '../src/coverage/jacoco-client.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const POC = path.resolve(HERE, '../../poc/jacoco')
const AGENT_JAR = path.join(POC, 'tools', 'jacocoagent.jar')
const CLI_JAR = path.join(POC, 'tools', 'jacococli.jar')
const CLASSES = path.join(POC, 'out', 'classes')
const SOURCES = path.join(POC, 'fixture', 'src')
const OUT_DIR = path.join(POC, 'out', `m3-verify-${Date.now()}`)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

function skip(reason) {
  console.log(`SKIP  本地真实 JaCoCo 验证未执行：${reason}`)
  console.log('      这是本地增强验证，不阻塞 CI；需要时按 poc/jacoco/README.md §3 准备环境。')
  process.exit(0)
}

if (spawnSync('java', ['-version'], { stdio: 'ignore' }).status !== 0) skip('未找到 java（需要 JDK 17+）')
for (const file of [AGENT_JAR, CLI_JAR]) {
  if (!fs.existsSync(file)) skip(`缺少 ${path.relative(POC, file)}（执行 scripts/00-fetch-jars.ps1）`)
}
if (!fs.existsSync(path.join(CLASSES, 'com'))) skip('缺少 out/classes（执行 scripts/01-build.ps1）')

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      .on('error', reject)
  })
}

/** 启动带 tcpserver agent 的 fixture 服务，等它打印 READY */
async function startFixture({ httpPort, agentPort }) {
  const opts = `port=${agentPort},address=127.0.0.1,output=tcpserver,includes=com.poc.*`
  const child = spawn(
    'java',
    [`-javaagent:${AGENT_JAR}=${opts}`, '-cp', CLASSES, 'com.poc.harness.DemoHttpServer', '--port', String(httpPort)],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const logs = []
  child.stdout.on('data', (buf) => logs.push(buf.toString('utf8')))
  child.stderr.on('data', (buf) => logs.push(buf.toString('utf8')))
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (/READY \d+/.test(logs.join(''))) return { child, logs }
    if (child.exitCode !== null) throw new Error(`fixture 提前退出（code=${child.exitCode}）：${logs.join('')}`)
    await sleep(80)
  }
  child.kill()
  throw new Error(`fixture 未在 20s 内就绪：${logs.join('')}`)
}

/** 用 jacococli 把 .exec 解析成 XML，并返回各 sourcefile 的命中行数 */
function analyzeXml(execFile, xmlFile) {
  const report = spawnSync(
    'java',
    ['-jar', CLI_JAR, 'report', execFile, '--classfiles', CLASSES, '--sourcefiles', SOURCES, '--xml', xmlFile],
    { encoding: 'utf8' }
  )
  if (report.status !== 0) throw new Error(`jacococli 失败：${report.stderr || report.stdout}`)
  const xml = fs.readFileSync(xmlFile, 'utf8')
  const hits = {}
  const re = /<sourcefile name="([^"]+)">([\s\S]*?)<\/sourcefile>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const lines = [...m[2].matchAll(/<line nr="\d+" mi="(\d+)" ci="(\d+)"/g)]
    hits[m[1]] = lines.filter((line) => Number(line[2]) > 0).length
  }
  return hits
}

const httpPort = await freePort()
const agentPort = await freePort()
fs.mkdirSync(OUT_DIR, { recursive: true })

let fixture = null
let client = null
try {
  fixture = await startFixture({ httpPort, agentPort })
  const base = `http://127.0.0.1:${httpPort}`
  const health = await fetchText(`${base}/health`)
  check('1. fixture 带 agent 启动（tcpserver 6300 语义）', health.status === 200, `http=${httpPort} agent=${agentPort}`)

  const probe = await probeAgent({ port: agentPort, timeoutMs: 3000 })
  check('2. probeAgent 自检可用（握手成功后立即关闭，不改动探针）', probe.ok === true, JSON.stringify(probe))

  client = await JacocoClient.connect({ port: agentPort, timeoutMs: 3000 })
  check('3. 真 agent 握手：5 字节 exec 头原样回写成功', client.header?.length === 5, client.header?.toString('hex'))

  // 节点 A：订单链
  await client.reset()
  const order = await fetchText(`${base}/order/create?userId=u1&sku=sku-1&count=2&amount=100`)
  const nodeA = await client.dumpAndReset()
  const xmlA = path.join(OUT_DIR, 'node-A-order.xml')
  fs.writeFileSync(path.join(OUT_DIR, 'node-A-order.exec'), nodeA.exec)
  const hitsA = analyzeXml(path.join(OUT_DIR, 'node-A-order.exec'), xmlA)
  check(
    '4. 节点 A（订单）：exec 合法可解析，OrderService 有命中、StockService 零命中',
    order.status === 200 && nodeA.bytes > 5 && hitsA['OrderService.java'] > 0 && hitsA['StockService.java'] === 0,
    `exec=${nodeA.bytes}B dump=${nodeA.ms}ms Order=${hitsA['OrderService.java']} Stock=${hitsA['StockService.java']}`
  )

  // 节点 B：库存链。reset 必须把 A 的命中清掉，B 的快照里不能出现订单行
  await client.reset()
  const stock = await fetchText(`${base}/stock/deduct?sku=sku-1&count=1`)
  const nodeB = await client.dumpAndReset()
  const xmlB = path.join(OUT_DIR, 'node-B-stock.xml')
  fs.writeFileSync(path.join(OUT_DIR, 'node-B-stock.exec'), nodeB.exec)
  const hitsB = analyzeXml(path.join(OUT_DIR, 'node-B-stock.exec'), xmlB)
  check(
    '5. 节点 B（库存）：StockService 有命中、OrderService 零命中（per-node 隔离成立）',
    stock.status === 200 && hitsB['StockService.java'] > 0 && hitsB['OrderService.java'] === 0,
    `exec=${nodeB.bytes}B Stock=${hitsB['StockService.java']} Order=${hitsB['OrderService.java']}`
  )

  check(
    '6. 两个节点证据互相独立（体积/命中不串）',
    nodeA.bytes !== nodeB.bytes && hitsA['OrderService.java'] !== hitsB['OrderService.java'],
    `A=${nodeA.bytes}B B=${nodeB.bytes}B`
  )
} finally {
  if (client) await client.close()
  if (fixture?.child && fixture.child.exitCode === null) {
    fixture.child.kill()
    await new Promise((resolve) => fixture.child.once('exit', resolve))
  }
}

const failed = results.filter((r) => !r.ok).length
console.log('-'.repeat(78))
console.log(`结论：${failed === 0 ? '全部通过' : `${failed} 项失败`}（${results.length} 项检查）`)
console.log(`证据目录：${OUT_DIR}`)
process.exit(failed === 0 ? 0 : 1)
