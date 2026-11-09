import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 必须在 import 任何 src 模块之前设置：config.js 在加载时就固定数据目录与库路径。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-sec-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'security.db')
process.env.HEIBAIHE_TOKEN = 'unit-test-token-0123456789abcdef'

const TOKEN = process.env.HEIBAIHE_TOKEN
const DIST_INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'frontend',
  'dist',
  'index.html'
)
const IS_WIN = process.platform === 'win32'
const SYSTEM_DIR = IS_WIN ? 'C:\\Windows' : '/etc'

const auth = { authorization: `Bearer ${TOKEN}` }

function startServer() {
  return import('../src/app.js').then(({ createApp }) => {
    const { server, io } = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, io, base: `http://127.0.0.1:${server.address().port}` })
      })
    })
  })
}

test('M1-3 安全基线：S1~S6 端到端', async (t) => {
  const { server, io, base } = await startServer()
  const get = (p, headers = {}, opt = {}) => fetch(`${base}${p}`, { headers, ...opt })
  const postJson = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  t.after(async () => {
    await new Promise((resolve) => io.close(resolve))
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    // 先关库再删目录：Windows 上库文件/ WAL 被占用会 EBUSY
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  await t.test('S3：/api/health 公开，其余 /api 未授权一律 401', async () => {
    const health = await get('/api/health')
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)

    for (const headers of [{}, { authorization: 'Bearer wrong-token-0123456789' }, { 'x-heibaihe-token': '1' }]) {
      const res = await get('/api/flows', headers)
      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.code, 'UNAUTHORIZED')
      assert.ok(!JSON.stringify(body).includes(TOKEN), '401 响应不能回显令牌')
    }

    // 三种携带方式都支持：Bearer / 自定义头 / query（仅首屏跳转用）
    for (const headers of [auth, { 'x-heibaihe-token': TOKEN }]) {
      const res = await get('/api/flows', headers)
      assert.equal(res.status, 200)
      assert.ok(Array.isArray(await res.json()))
    }
    const viaQuery = await get(`/api/flows?token=${encodeURIComponent(TOKEN)}`)
    assert.equal(viaQuery.status, 200)

    // 静态资源与页面不参与鉴权（页面本身要能打开，令牌由后端注入）
    const notFound = await get('/api/not-exist', auth)
    assert.equal(notFound.status, 404)
    assert.equal((await notFound.json()).code, 'NOT_FOUND')
  })

  await t.test('S2：跨域来源在服务端直接 403（不只依赖 CORS）', async () => {
    const denied = await get('/api/health', { origin: 'http://evil.example' })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).code, 'ORIGIN_DENIED')

    const allowed = await get('/api/health', { origin: 'http://127.0.0.1:5173' })
    assert.equal(allowed.status, 200)

    // 预检也要能通过白名单
    const preflight = await fetch(`${base}/api/flows`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  })

  await t.test('S6：请求体 5 MB 上限 + 非法 JSON + 导入条数上限', async () => {
    const huge = JSON.stringify({ spec: { paths: {}, pad: 'x'.repeat(6 * 1024 * 1024) } })
    const tooLarge = await postJson('/api/import/openapi', huge, auth)
    assert.equal(tooLarge.status, 413)
    assert.equal((await tooLarge.json()).code, 'BODY_TOO_LARGE')

    const badJson = await postJson('/api/import/openapi', '{not-json', auth)
    assert.equal(badJson.status, 400)
    assert.equal((await badJson.json()).code, 'BODY_PARSE_ERROR')

    const paths = {}
    for (let i = 0; i < 5001; i += 1) paths[`/api/p${i}`] = { get: {} }
    const tooMany = await postJson('/api/import/openapi', { spec: { paths } }, auth)
    assert.equal(tooMany.status, 413)
    assert.equal((await tooMany.json()).code, 'IMPORT_TOO_MANY_PATHS')

    const badSpec = await postJson('/api/import/openapi', { spec: { paths: [] } }, auth)
    assert.equal(badSpec.status, 400)
    assert.equal((await badSpec.json()).code, 'IMPORT_BAD_SPEC')
  })

  await t.test('S4：目录浏览只允许登记范围内的目录', async () => {
    const roots = await get('/api/fs/roots', auth)
    assert.equal(roots.status, 200)
    assert.ok(Array.isArray((await roots.json()).roots))

    const systemList = await get(`/api/fs/list?path=${encodeURIComponent(SYSTEM_DIR)}`, auth)
    assert.equal(systemList.status, 403)
    assert.equal((await systemList.json()).code, 'FS_DENIED')

    const systemRegister = await postJson('/api/fs/roots', { path: SYSTEM_DIR }, auth)
    assert.equal(systemRegister.status, 403)
    assert.equal((await systemRegister.json()).code, 'FS_DENIED')

    const driveRegister = await postJson('/api/fs/roots', { path: path.parse(DIR).root }, auth)
    assert.equal(driveRegister.status, 403)
    assert.equal((await driveRegister.json()).code, 'FS_DENIED')

    const missing = await postJson('/api/fs/roots', { path: path.join(DIR, 'no-such-dir') }, auth)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).code, 'FS_NOT_FOUND')

    const file = path.join(DIR, 'a-file.txt')
    fs.writeFileSync(file, 'x')
    const notDir = await postJson('/api/fs/roots', { path: file }, auth)
    assert.equal(notDir.status, 400)
    assert.equal((await notDir.json()).code, 'FS_NOT_DIR')

    const workspace = path.join(DIR, 'workspaces', 'demo')
    fs.mkdirSync(workspace, { recursive: true })
    const registered = await postJson('/api/fs/roots', { path: workspace }, auth)
    assert.equal(registered.status, 200)
    const registeredBody = await registered.json()
    assert.equal(registeredBody.path, fs.realpathSync.native(workspace))
    assert.ok(registeredBody.roots.some((r) => r.path === registeredBody.path))

    const listed = await get(`/api/fs/list?path=${encodeURIComponent(workspace)}`, auth)
    assert.equal(listed.status, 200)
    assert.equal((await listed.json()).path, registeredBody.path)

    // 根目录列表不含系统路径
    const rootList = await get('/api/fs/roots', auth)
    const rootPaths = (await rootList.json()).roots.map((r) => r.path)
    assert.ok(!rootPaths.some((p) => p.toLowerCase() === SYSTEM_DIR.toLowerCase()))
  })

  await t.test('S3：生产模式向 index.html 注入令牌', async () => {
    if (!fs.existsSync(DIST_INDEX)) return // 未构建前端时跳过（CI 只跑 API 测试）
    for (const p of ['/', '/index.html']) {
      const html = await (await get(p)).text()
      assert.ok(html.includes('window.__HEIBAIHE_TOKEN__='), `${p} 应注入令牌`)
      assert.ok(html.includes(TOKEN), `${p} 应包含本次令牌`)
    }
  })
})

test('S4 单元：沙箱外路径拒绝、软链接无法逃逸、登记后放行', async () => {
  const { createFsSandbox, isSystemPath } = await import('../src/security/fs-roots.js')
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-sbx-'))
  const allowed = path.join(rootDir, 'allowed')
  const outside = path.join(rootDir, 'outside')
  fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })

  try {
    const sandbox = createFsSandbox({
      roots: [allowed],
      includeHome: false,
      includeDataDir: false,
      extraRoots: () => [],
    })

    assert.equal(sandbox.resolve(allowed).ok, true)
    assert.equal(sandbox.resolve(path.join(allowed, 'sub')).ok, true)

    const escaped = sandbox.resolve(path.join(allowed, '..', 'outside'))
    assert.equal(escaped.ok, false)
    assert.equal(escaped.status, 403)
    assert.equal(escaped.code, 'FS_OUT_OF_SCOPE')
    assert.equal(escaped.canRegister, true)

    // 未登记目录不允许 → 登记后允许
    assert.equal(sandbox.isAllowed(outside), false)
    const registered = sandbox.register(outside)
    assert.equal(registered.ok, true)
    assert.equal(sandbox.isAllowed(outside), true)

    // 磁盘根目录、系统目录一律不给登记
    assert.equal(sandbox.register(path.parse(rootDir).root).code, 'FS_DENIED')
    assert.equal(sandbox.register(SYSTEM_DIR).code, 'FS_DENIED')

    // 系统目录识别只看前两层，同名工程目录不误伤
    assert.equal(isSystemPath(SYSTEM_DIR), true)
    if (IS_WIN) {
      assert.equal(isSystemPath('C:\\work\\Windows'), false)
      assert.equal(isSystemPath('D:\\projects\\program files'), false)
    } else {
      assert.equal(isSystemPath('/home/user/etc'), false)
    }

    // 父目录：只有仍在上次允许范围内才返回，越界返回 null（前端「上一级」自然停在根）
    assert.equal(sandbox.parentOf(path.join(allowed, 'sub')), allowed)
    assert.equal(sandbox.parentOf(outside), null) // outside 的父目录 rootDir 未登记
    assert.equal(sandbox.parentOf(path.parse(rootDir).root), null)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('令牌工具：解析三种来源、定长比较、WS 握手取 token', async () => {
  const { readToken, safeEqual, socketToken } = await import('../src/security/token.js')

  assert.equal(readToken({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN)
  assert.equal(readToken({ headers: { 'x-heibaihe-token': TOKEN } }), TOKEN)
  assert.equal(readToken({ headers: {}, query: { token: TOKEN } }), TOKEN)
  assert.equal(readToken({ headers: {} }), '')

  assert.equal(safeEqual(TOKEN, TOKEN), true)
  assert.equal(safeEqual(TOKEN, `${TOKEN}x`), false)
  assert.equal(safeEqual(TOKEN, ''), false)
  assert.equal(safeEqual('', ''), false)

  assert.equal(socketToken({ handshake: { auth: { token: TOKEN } } }), TOKEN)
  assert.equal(socketToken({ handshake: { query: { token: TOKEN } } }), TOKEN)
  assert.equal(socketToken({ handshake: { headers: { 'x-heibaihe-token': TOKEN } } }), TOKEN)
  assert.equal(socketToken({ handshake: {} }), '')
})
