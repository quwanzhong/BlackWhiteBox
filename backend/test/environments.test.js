import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// 必须在 import 任何 src 模块之前设置：config.js 加载时就固定数据目录 / 库路径 / 主密钥来源。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-env-'))
const DB_FILE = path.join(DIR, 'env.db')
const TOKEN = 'env-unit-token-0123456789abcdef'
const MASTER_HEX = 'ab'.repeat(32)
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = DB_FILE
process.env.HEIBAIHE_TOKEN = TOKEN
process.env.HEIBAIHE_MASTER_KEY = MASTER_HEX

const SECRET = 'super-secret-key-123'

after(async () => {
  const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function expectEnvError(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}（${err.message}）`)
    return true
  })
}

function readDbBytes() {
  return [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]
    .filter((file) => fs.existsSync(file))
    .reduce((acc, file) => Buffer.concat([acc, fs.readFileSync(file)]), Buffer.alloc(0))
}

test('keystore：AES-256-GCM 往返、随机 IV、AAD 绑定与密钥轮换失败', async () => {
  const { createKeystore, KeystoreError, parseMasterKey } = await import('../src/security/keystore.js')
  const key = parseMasterKey(MASTER_HEX)
  assert.equal(key.length, 32)

  const ks = createKeystore(key)
  const blob1 = ks.encrypt(SECRET, 'env-1|apiKey')
  const blob2 = ks.encrypt(SECRET, 'env-1|apiKey')

  assert.equal(blob1[0], 1, 'BLOB 首字节必须是版本号')
  assert.notDeepEqual(blob1, blob2, '每次加密必须使用随机 IV')
  assert.equal(ks.decrypt(blob1, 'env-1|apiKey'), SECRET)
  assert.ok(!blob1.includes(Buffer.from(SECRET)), '密文 BLOB 不得包含明文')

  assert.throws(
    () => ks.decrypt(blob1, 'env-2|apiKey'),
    (err) => err instanceof KeystoreError && err.code === 'SECRET_DECRYPT_FAILED'
  )

  const rotated = createKeystore(parseMasterKey('cd'.repeat(32)))
  assert.throws(() => rotated.decrypt(blob1, 'env-1|apiKey'), /密钥不匹配或密文已损坏/)

  assert.throws(() => parseMasterKey('not-a-key'), (err) => err.code === 'MASTER_KEY_INVALID')
  assert.equal(parseMasterKey(Buffer.alloc(32, 7).toString('base64')).length, 32, '支持 32 字节 base64')
  assert.equal(parseMasterKey(''), null)
})

test('keystore：主密钥文件首次自动生成且后续复用', async () => {
  const { loadMasterKey, parseMasterKey } = await import('../src/security/keystore.js')
  const file = path.join(DIR, 'nested', '.master.key')

  const created = loadMasterKey({ raw: '', file })
  assert.equal(created.length, 32)
  assert.ok(fs.existsSync(file), '首次使用应生成主密钥文件')
  assert.equal(fs.readFileSync(file, 'utf8').trim().length, 64)

  const reused = loadMasterKey({ raw: '', file })
  assert.deepEqual(reused, created)
  assert.deepEqual(parseMasterKey(fs.readFileSync(file, 'utf8')), created)
})

test('环境服务：字段校验与稳定错误码', async () => {
  const { store } = await import('../src/store.js')
  const service = await import('../src/environments/service.js')
  const project = store.saveProject({ name: '环境校验项目' })

  expectEnvError(() => service.createEnvironment({}), 'ENV_BAD_NAME')
  expectEnvError(
    () => service.createEnvironment({ name: 'x', projectId: 'ghost-project' }),
    'ENV_PROJECT_NOT_FOUND'
  )
  expectEnvError(() => service.createEnvironment({ name: 'x', baseUrl: 'ftp://a.b' }), 'ENV_BAD_BASE_URL')
  expectEnvError(
    () => service.createEnvironment({ name: 'x', baseUrl: 'http://u:p@a.b' }),
    'ENV_BAD_BASE_URL'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', variables: { 'bad-key': 1 } }),
    'ENV_BAD_KEY'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', headers: { 'X-Test': 'a\r\nInjected: 1' } }),
    'ENV_BAD_HEADER_VALUE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', variables: { token: 'a' }, secrets: { token: 'b' } }),
    'ENV_KEY_CONFLICT'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', secrets: { token: 'x'.repeat(4097) } }),
    'ENV_SECRET_TOO_LARGE'
  )

  const env = service.createEnvironment({
    name: '  开发环境  ',
    projectId: project.id,
    baseUrl: 'http://127.0.0.1:9999/',
    variables: { region: 'cn' },
    headers: { 'X-Trace': 'dev' },
  })
  assert.equal(env.name, '开发环境', '名称首尾空白应被裁剪')
  assert.equal(env.baseUrl, 'http://127.0.0.1:9999', 'baseUrl 末尾斜杠归一化')
  assert.equal(env.version, 1)
  assert.deepEqual(env.secretKeys, [])

  expectEnvError(() => service.createEnvironment({ name: '开发环境', projectId: project.id }), 'ENV_NAME_CONFLICT')
  expectEnvError(() => service.updateEnvironment(env.id, { name: '  ' }), 'ENV_BAD_NAME')
  expectEnvError(() => service.resolveEnvironment('ghost'), 'ENV_NOT_FOUND')
})

test('环境服务：settings.coverage 校验与执行期下发', async () => {
  const service = await import('../src/environments/service.js')

  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: 'jacoco' } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { source: 'v8' } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { host: 'a b' } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { port: 0 } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { port: 65536 } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { timeoutMs: 99 } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { timeoutMs: 30001 } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(
    () => service.createEnvironment({ name: 'x', settings: { coverage: { enabled: 'yes' } } }),
    'ENV_BAD_COVERAGE'
  )
  expectEnvError(() => service.createEnvironment({ name: 'x', settings: 'coverage' }), 'ENV_BAD_SETTINGS')

  const env = service.createEnvironment({
    name: '覆盖率环境',
    settings: {
      coverage: { host: '127.0.0.1', port: 6301, timeoutMs: 800 },
      retention: { days: 7 },
    },
  })
  assert.deepEqual(env.settings, {
    coverage: { source: 'jacoco', host: '127.0.0.1', port: 6301, timeoutMs: 800, enabled: true },
    retention: { days: 7 },
  })
  const resolved = service.resolveEnvironment(env.id)
  assert.equal(resolved.settings.coverage.port, 6301, '执行链路必须拿到 settings')

  const cleared = service.updateEnvironment(env.id, { settings: { coverage: null } })
  assert.deepEqual(cleared.settings, {}, 'coverage:null 表示关闭取证')
})

test('环境服务：secrets 只回键名，密文落库不含明文', async () => {
  const { store } = await import('../src/store.js')
  const service = await import('../src/environments/service.js')

  const env = service.createEnvironment({
    name: '预发',
    variables: { basePath: '/api' },
    secrets: { apiKey: SECRET },
  })
  assert.deepEqual(env.secretKeys, ['apiKey'])
  assert.ok(!JSON.stringify(env).includes(SECRET), '环境视图不得出现 secret 明文')

  const updated = service.setSecret(env.id, 'dbPassword', 'p@ssw0rd-db')
  assert.deepEqual(updated.secretKeys, ['apiKey', 'dbPassword'])
  assert.equal(updated.version, env.version + 1, '密钥变更应 bump 环境版本')

  // 库文件（含 WAL/SHM）里不应出现任何 secret 明文
  const bytes = readDbBytes().toString('utf8')
  assert.ok(!bytes.includes(SECRET), 'SQLite 文件不得包含 secret 明文')
  assert.ok(!bytes.includes('p@ssw0rd-db'), '第二个 secret 也不得明文落库')

  // 执行链路解析得到明文（仅在内存）
  const resolved = service.resolveEnvironment(env.id)
  assert.equal(resolved.variables.apiKey, SECRET)
  assert.deepEqual(resolved.secretValues.sort(), [SECRET, 'p@ssw0rd-db'].sort())

  // 预览 API 只给键名 + 打码值
  const preview = service.previewEnvironment(env.id)
  assert.equal(preview.resolved.variables.apiKey, '***')
  assert.equal(preview.resolved.variables.basePath, '/api')
  assert.ok(!JSON.stringify(preview).includes(SECRET))

  // variables 与 secrets 键冲突（更新变量时按已有 secretKeys 检查）
  expectEnvError(() => service.updateEnvironment(env.id, { variables: { apiKey: 'x' } }), 'ENV_KEY_CONFLICT')
  expectEnvError(() => service.setSecret(env.id, 'basePath', 'x'), 'ENV_KEY_CONFLICT')

  const removed = service.deleteSecret(env.id, 'dbPassword')
  assert.deepEqual(removed.secretKeys, ['apiKey'])
  expectEnvError(() => service.deleteSecret(env.id, 'dbPassword'), 'ENV_SECRET_NOT_FOUND')

  service.deleteEnvironment(env.id)
  assert.equal(service.getEnvironment(env.id), null)
  assert.equal(store.listSecretRows(env.id).length, 0, '删除环境必须级联清理密钥行')
})

test('调度器：环境变量优先级、baseUrl / 默认 Header、secret 掩码与版本记录', async () => {
  const { RunSession } = await import('../src/engine/scheduler.js')
  const { store } = await import('../src/store.js')
  const service = await import('../src/environments/service.js')

  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          nextToken: 'extracted-token-789',
        },
      })
    )
  })
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const stubBase = `http://127.0.0.1:${stub.address().port}`

  try {
    const project = store.saveProject({ name: '调度器环境项目' })
    const env = service.createEnvironment({
      name: '集成环境',
      projectId: project.id,
      baseUrl: stubBase,
      variables: { token: 'env-token-123', region: 'cn' },
      headers: { 'X-Env': 'env-header', Authorization: 'Bearer {{apiKey}}' },
      secrets: { apiKey: SECRET },
    })
    const resolved = service.resolveEnvironment(env.id)

    const flow = {
      id: 'f-env-priority',
      name: '环境优先级流程',
      type: 'blackbox',
      projectId: project.id,
      variables: { token: 'flow-token-000', region: 'flow-region' },
      nodes: [
        {
          id: 'n1',
          name: '首个请求',
          action: {
            type: 'http',
            method: 'GET',
            url: '/api/echo?token={{token}}&region={{region}}&key={{apiKey}}',
            headers: { 'X-Node': 'node-value' },
          },
          expected: { status: 200, checks: [] },
          extract: { token: '$.data.nextToken' },
        },
        {
          id: 'n2',
          name: '提取后请求',
          action: { type: 'http', method: 'GET', url: '/api/echo?token={{token}}' },
          expected: { status: 200, checks: [] },
        },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    }

    const session = new RunSession(flow, { to: () => ({ emit() {} }) }, {
      variables: { token: 'runtime-token-456' },
      environment: resolved,
    })
    await session.start()

    assert.equal(session.status, 'passed')
    const [first, second] = session.steps
    // 优先级：flow < env < 执行时传入；提取值最高（覆盖前两者）
    assert.equal(first.actual.data.data.query.region, 'cn', 'Environment 变量应覆盖 flow.variables')
    assert.equal(first.actual.data.data.query.token, 'runtime-token-456', '执行时传入变量应覆盖 Environment')
    assert.equal(second.actual.data.data.query.token, 'extracted-token-789', 'extract 必须覆盖执行时传入变量')
    // 相对路径拼环境 baseUrl
    assert.equal(first.actual.data.data.query.key, SECRET)
    // 环境默认 Header + 节点头合并，环境头里的 {{var}} 也会替换
    assert.equal(first.actual.data.data.headers['x-env'], 'env-header')
    assert.equal(first.actual.data.data.headers['x-node'], 'node-value')
    assert.equal(first.actual.data.data.headers.authorization, `Bearer ${SECRET}`)

    // 落库/事件/详情统一掩码
    const detail = store.getExecutionDetail(session.executionId)
    const persisted = JSON.stringify(detail)
    assert.ok(!persisted.includes(SECRET), '执行详情不得包含 secret 明文')
    assert.ok(persisted.includes('***'), 'secret 位置应替换为 ***')
    assert.equal(detail.envId, env.id)
    assert.equal(detail.envVersion, env.version)
    assert.equal(detail.environment.name, '集成环境')
    assert.equal(detail.environment.variables.apiKey, '***')
    assert.equal(detail.vars.apiKey, '***')
    assert.ok(!JSON.stringify(detail.events).includes(SECRET), '事件流不得包含 secret 明文')

    const listed = store.listExecutions().find((row) => row.id === session.executionId)
    assert.equal(listed.envId, env.id)
    assert.equal(listed.envVersion, env.version)

    // 内存里仍保留明文，供前端实时展示（仅本进程）
    assert.equal(first.request.headers.authorization, `Bearer ${SECRET}`)
    assert.ok(!JSON.stringify(session.detail()).includes(SECRET), 'session.detail() 也必须掩码')
  } finally {
    await new Promise((resolve) => stub.close(resolve))
  }
})

test('环境 HTTP API：CRUD / secrets / 预览 / 执行入口错误码', async () => {
  const { createApp } = await import('../src/app.js')
  const { store } = await import('../src/store.js')
  const appCtx = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
  await new Promise((resolve) => appCtx.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${appCtx.server.address().port}`
  const auth = { authorization: `Bearer ${TOKEN}` }
  const json = async (res) => ({ status: res.status, body: await res.json() })
  const post = (p, body) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    }).then(json)
  const put = (p, body) =>
    fetch(`${base}${p}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    }).then(json)
  const get = (p) => fetch(`${base}${p}`, { headers: auth }).then(json)
  const del = (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: auth }).then(json)

  try {
    const project = store.saveProject({ name: 'HTTP 环境项目' })
    const created = await post('/api/environments', {
      name: '测试环境',
      projectId: project.id,
      baseUrl: 'https://api.example.com',
      variables: { region: 'test' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.version, 1)
    const id = created.body.id

    assert.equal((await post('/api/environments', {})).body.code, 'ENV_BAD_NAME')
    assert.equal((await get('/api/environments/ghost')).body.code, 'ENV_NOT_FOUND')
    assert.equal((await get(`/api/environments?projectId=${project.id}`)).body.length, 1)

    const withSecret = await put(`/api/environments/${id}/secrets/apiKey`, { value: SECRET })
    assert.equal(withSecret.status, 200)
    assert.deepEqual(withSecret.body.secretKeys, ['apiKey'])
    assert.ok(!JSON.stringify(withSecret.body).includes(SECRET), '响应不得回显 secret 明文')

    const preview = await get(`/api/environments/${id}/resolve`)
    assert.equal(preview.body.resolved.variables.apiKey, '***')
    assert.equal(preview.body.resolved.variables.region, 'test')
    assert.ok(!JSON.stringify(preview.body).includes(SECRET))

    const patched = await put(`/api/environments/${id}`, { name: '测试环境v2' })
    assert.equal(patched.body.version, withSecret.body.version + 1, '更新环境也应 bump 版本')

    // 执行入口：环境不存在 → 404 + 稳定错误码（不能变成 500）
    const flow = store.saveFlow({
      name: '入口校验流程',
      projectId: project.id,
      nodes: [{ id: 'n1', name: '节点', action: { type: 'http', url: 'https://api.example.com/ping' } }],
      edges: [],
    })
    const runMissing = await post(`/api/flows/${flow.id}/run`, { environmentId: 'ghost-env' })
    assert.equal(runMissing.status, 404)
    assert.equal(runMissing.body.code, 'ENV_NOT_FOUND')

    // 跨项目环境不可用 → 400
    const other = store.saveProject({ name: '另一个项目' })
    const otherEnv = await post('/api/environments', { name: '别的环境', projectId: other.id })
    const mismatch = await post(`/api/flows/${flow.id}/run`, { environmentId: otherEnv.body.id })
    assert.equal(mismatch.status, 400)
    assert.equal(mismatch.body.code, 'ENV_PROJECT_MISMATCH')

    assert.equal((await del(`/api/environments/${id}/secrets/apiKey`)).status, 200)
    assert.equal((await del(`/api/environments/${id}/secrets/apiKey`)).body.code, 'ENV_SECRET_NOT_FOUND')
    assert.equal((await del(`/api/environments/${id}`)).status, 200)
    assert.equal((await get(`/api/environments/${id}`)).status, 404)
  } finally {
    await new Promise((resolve) => appCtx.io.close(resolve))
    await new Promise((resolve) => appCtx.server.close(resolve))
  }
})
