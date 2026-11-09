/**
 * M1-3 验收脚本：用「真实库的副本」起服务，验证 S1~S6 在完整中间件链上真的生效。
 *
 * 为什么用副本：验证会登记目录、写 app_meta，不能污染 backend/data。
 * 为什么用备份 API：真实库是 WAL 模式，直接复制主文件可能丢最近事务。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL_DB = path.resolve(HERE, '..', 'data', 'heibaihe.db')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-m1-3-'))
const DB_FILE = path.join(DIR, 'heibaihe.db')
const TOKEN = 'verify-m1-3-token-0123456789abcdef'

if (fs.existsSync(REAL_DB)) {
  const src = new Database(REAL_DB, { readonly: true })
  await src.backup(DB_FILE)
  src.close()
  console.log(`已备份真实库 → ${DB_FILE}`)
} else {
  console.log('未找到真实库，使用空库验证')
}

process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = DB_FILE
process.env.HEIBAIHE_TOKEN = TOKEN

const { createApp } = await import('../src/app.js')
const { HOST } = await import('../src/config.js')
const { getDefaultDatabase, closeDefaultDatabase } = await import('../src/infra/store/db.js')

const { server, io } = createApp({
  token: TOKEN,
  originPort: 3310,
  log: { error() {}, warn() {} },
})

await new Promise((resolve) => server.listen(0, HOST, resolve))
const base = `http://${HOST}:${server.address().port}`
const auth = { authorization: `Bearer ${TOKEN}` }

const db = getDefaultDatabase()
const expected = {
  flows: db.prepare('SELECT COUNT(*) AS n FROM flows').get().n,
  executions: db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,
  steps: db.prepare('SELECT COUNT(*) AS n FROM execution_steps').get().n,
  events: db.prepare('SELECT COUNT(*) AS n FROM execution_events').get().n,
  projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
}
const firstProjectId = db.prepare('SELECT id FROM projects ORDER BY rowid DESC LIMIT 1').get()?.id
const expectedInterfaces = firstProjectId
  ? JSON.parse(db.prepare('SELECT data_json FROM projects WHERE id = ?').get(firstProjectId).data_json).interfaces
      ?.length || 0
  : 0

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

const get = (p, headers = {}) => fetch(`${base}${p}`, { headers })
const post = (p, body, headers = {}) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

// S1：默认只监听回环
check('S1 默认监听 127.0.0.1', HOST === '127.0.0.1', `HOST=${HOST}`)

// S3：公开探活 + 默认拒绝
const health = await get('/api/health')
check('S3 /api/health 公开', health.status === 200)

const noToken = await get('/api/flows')
const noTokenBody = await noToken.text()
check(
  'S3 无令牌访问 /api/flows → 401',
  noToken.status === 401 && !noTokenBody.includes(TOKEN),
  `status=${noToken.status}`
)

const wrongToken = await get('/api/flows', { authorization: 'Bearer wrong-token-0123456789' })
check('S3 错误令牌 → 401', wrongToken.status === 401, `status=${wrongToken.status}`)

const viaQuery = await get(`/api/flows?token=${encodeURIComponent(TOKEN)}`)
check('S3 ?token= 首屏跳转可用', viaQuery.status === 200, `status=${viaQuery.status}`)

// 带令牌读取核心数据：flows / stats / executions / 详情 / projects
const flowsRes = await get('/api/flows', auth)
const flows = await flowsRes.json()
check(
  'S3 带令牌读取 flows',
  flowsRes.status === 200 && Array.isArray(flows) && flows.length === expected.flows,
  `${flows?.length}/${expected.flows}`
)

const statsRes = await get('/api/stats', auth)
const stats = await statsRes.json()
check(
  '数据一致：stats.flowTotal = flows',
  statsRes.status === 200 && stats.flowTotal === expected.flows && stats.execTotal === expected.executions,
  `flows=${stats?.flowTotal} exec=${stats?.execTotal}`
)

const execsRes = await get('/api/executions', auth)
const execs = await execsRes.json()
check(
  '数据一致：执行列表条数 + 不含 steps',
  execsRes.status === 200 && execs.length === expected.executions && execs.every((e) => e.steps === undefined),
  `${execs?.length}/${expected.executions}`
)

let stepSum = 0
let eventSum = 0
for (const item of execs) {
  const detail = await (await get(`/api/executions/${item.id}`, auth)).json()
  stepSum += detail.steps?.length || 0
  eventSum += detail.events?.length || 0
}
check(
  '数据一致：详情 steps/events 合计 = 行表',
  stepSum === expected.steps && eventSum === expected.events,
  `steps=${stepSum}/${expected.steps} events=${eventSum}/${expected.events}`
)

if (firstProjectId) {
  const project = await (await get(`/api/projects/${firstProjectId}`, auth)).json()
  check(
    '数据一致：项目接口数无损',
    (project.interfaces?.length || 0) === expectedInterfaces,
    `${project.interfaces?.length || 0}/${expectedInterfaces}`
  )
}

// S2：来源白名单在服务端生效
const evil = await get('/api/health', { origin: 'http://evil.example' })
check('S2 非白名单 Origin → 403', evil.status === 403, `status=${evil.status}`)
const localOrigin = await get('/api/health', { origin: 'http://127.0.0.1:5173' })
check('S2 白名单 Origin → 200', localOrigin.status === 200, `status=${localOrigin.status}`)

// S4：目录沙箱
const rootsRes = await get('/api/fs/roots', auth)
const roots = await rootsRes.json()
check(
  'S4 根目录列表可读且不含系统目录',
  rootsRes.status === 200 && Array.isArray(roots.roots) && roots.roots.length > 0,
  `${roots?.roots?.length || 0} 个根目录`
)
const sysDir = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
const sysList = await get(`/api/fs/list?path=${encodeURIComponent(sysDir)}`, auth)
const sysBody = await sysList.text()
check('S4 系统目录拒绝浏览 → 403', sysList.status === 403 && sysBody.includes('FS_DENIED'), `status=${sysList.status}`)
const driveRoot = path.parse(DIR).root
const driveReg = await post('/api/fs/roots', { path: driveRoot }, auth)
check('S4 磁盘根目录拒绝登记 → 403', driveReg.status === 403, `status=${driveReg.status}`)

const workspace = path.join(DIR, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
const reg = await post('/api/fs/roots', { path: workspace }, auth)
const regBody = await reg.json()
check('S4 普通目录登记成功', reg.status === 200 && regBody.ok === true, `status=${reg.status}`)
const listed = await get(`/api/fs/list?path=${encodeURIComponent(workspace)}`, auth)
check('S4 登记后可浏览', listed.status === 200, `status=${listed.status}`)

// S6：体积与解析上限
const huge = JSON.stringify({ spec: { paths: {}, pad: 'x'.repeat(6 * 1024 * 1024) } })
const tooLarge = await post('/api/import/openapi', huge, auth)
check('S6 >5 MB 请求体 → 413', tooLarge.status === 413, `status=${tooLarge.status}`)
const badJson = await post('/api/import/openapi', '{bad', auth)
check('S6 非法 JSON → 400', badJson.status === 400, `status=${badJson.status}`)

console.log('\n结论')
console.log('-'.repeat(72))
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
}
console.log('-'.repeat(72))
console.log(
  `结论：${failed === 0 ? '全部通过' : `${failed} 项失败`}  ` +
    `（flows=${expected.flows} executions=${expected.executions} steps=${expected.steps} events=${expected.events}）`
)

await new Promise((resolve) => io.close(resolve))
closeDefaultDatabase()
fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
process.exit(failed === 0 ? 0 : 1)
