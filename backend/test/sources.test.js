/**
 * M3'-1 接口来源抽象层单测。
 *
 * 覆盖五块：
 *   1. contract：错误码、适配器契约、旧数据归一化、快照校验
 *   2. registry：注册/工厂/未知来源/项目归一化
 *   3. projector：OpenAPI → 列表/快照/过滤（Apifox 与 OpenAPI 共用）
 *   4. apifox 适配器：缓存/降级/回写配置的逐分支（依赖注入，不联网）
 *   5. openapi 适配器 + 项目 source/apifox 双写兼容
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在 import 时就固定数据目录，因此必须在 import 任何 src 模块之前设置
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-sources-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'sources.db')
process.env.HEIBAIHE_TOKEN = 'sources-unit-token-0123456789abcdef'

after(async () => {
  try {
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
  } catch {
    /* 未初始化则忽略 */
  }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const SPEC = {
  openapi: '3.0.0',
  info: { title: '示例文档', version: '2.1.0' },
  servers: [{ url: 'http://api.example.com' }],
  paths: {
    '/api/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: '订单详情',
        tags: ['order'],
        'x-apifox-folder': '订单',
        'x-apifox-status': 'released',
        parameters: [{ name: 'withItems', in: 'query', schema: { type: 'boolean', default: false } }],
      },
    },
    '/api/orders': {
      post: { operationId: 'createOrder', deprecated: true },
    },
    '/ignored': 'not-an-object',
  },
}

const SPEC_INTERFACES = [
  { id: 'GET /api/orders/{id}', method: 'GET', path: '/api/orders/{id}' },
  { id: 'POST /api/orders', method: 'POST', path: '/api/orders' },
]

function makeApifoxDeps(overrides = {}) {
  const calls = []
  const deps = {
    resolveConnection: (input = {}) => ({
      projectId: String(input.projectId || ''),
      siteId: String(input.siteId || ''),
      branchId: String(input.branchId || ''),
      baseUrl: String(input.baseUrl || ''),
      token: String(input.token || ''),
    }),
    getCachedInterfaces: () => ({
      title: '示例文档',
      version: '2.1.0',
      baseUrl: 'http://api.example.com',
      fetchedAt: 1000,
      projectId: 'p1',
      interfaces: SPEC_INTERFACES,
    }),
    readCache: () => ({ projectId: 'p1', fetchedAt: 1000, spec: SPEC }),
    fetchInterfaces: async (connection, options) => {
      calls.push({ kind: 'fetchInterfaces', connection, options })
      return {
        title: '示例文档',
        version: '2.1.0',
        baseUrl: 'http://api.example.com',
        fetchedAt: 2000,
        count: 2,
        interfaces: SPEC_INTERFACES,
      }
    },
    saveConfig: (value) => calls.push({ kind: 'saveConfig', value }),
    testConnection: async (connection) => {
      calls.push({ kind: 'testConnection', connection })
      return { ok: true, title: '示例文档', interfaceCount: 2, tools: ['read_project_oas'] }
    },
    ...overrides,
  }
  return { calls, deps }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}: ${err.message}`)
    return true
  })
}

// ---------------------------------------------------------------------------
// 1. contract
// ---------------------------------------------------------------------------

test('contract：来源枚举与稳定错误码', async () => {
  const { SOURCE_KINDS, SourceError, sourceError } = await import('../src/sources/contract.js')
  assert.deepEqual(SOURCE_KINDS, ['apifox', 'openapi', 'postman', 'har'])

  const err = sourceError('SOURCE_EMPTY', '没接口')
  assert.ok(err instanceof SourceError)
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'SOURCE_EMPTY')
  assert.equal(err.name, 'SourceError')
  assert.equal(err.message, '没接口')
  assert.deepEqual(err.details, undefined)

  assert.deepEqual(sourceError('SOURCE_X', 'x', { a: 1 }).details, { a: 1 })
})

test('contract：适配器契约在注册时就校验，缺方法立刻失败', async () => {
  const { assertSource } = await import('../src/sources/contract.js')

  assert.throws(() => assertSource(null), /适配器必须是对象/)
  assert.throws(() => assertSource({}), /缺少 kind/)
  assert.throws(() => assertSource({ kind: 'x' }), /缺少 label/)
  assert.throws(() => assertSource({ kind: 'x', label: 'X' }), /缺少 describe/)
  assert.throws(
    () => assertSource({ kind: 'x', label: 'X', describe: () => ({ kind: 'x', configFields: [] }) }),
    /缺少 fetch/
  )
  assert.throws(
    () => assertSource({ kind: 'x', label: 'X', describe: () => ({}), fetch: () => {} }),
    /describe\(\) 必须返回/
  )
  assert.throws(
    () => assertSource({ kind: 'x', label: 'X', describe: () => ({ kind: 'x' }), fetch: () => {} }),
    /必须声明 configFields/
  )
  assert.throws(
    () =>
      assertSource({ kind: 'x', label: 'X', describe: () => ({ kind: 'x', configFields: [{}] }), fetch: () => {} }),
    /必须含 key/
  )

  const ok = { kind: 'x', label: 'X', describe: () => ({ kind: 'x', configFields: [{ key: 'a' }] }), fetch: () => {} }
  assert.equal(assertSource(ok), ok)
})

test('contract：旧模型 project.apifox 归一化为 source', async () => {
  const { normalizeSourceConfig } = await import('../src/sources/contract.js')

  // 空项目 → apifox 默认来源，字段是空串而不是 undefined
  assert.deepEqual(normalizeSourceConfig({}), {
    kind: 'apifox',
    config: { projectId: '', siteId: '', branchId: '', apiBaseUrl: '' },
  })

  // 旧数据：没有 source 字段
  assert.deepEqual(normalizeSourceConfig({ apifox: { projectId: ' p1 ', siteId: 's1' } }), {
    kind: 'apifox',
    config: { projectId: 'p1', siteId: 's1', branchId: '', apiBaseUrl: '' },
  })

  // 新数据优先
  assert.deepEqual(
    normalizeSourceConfig({ source: { kind: 'openapi', config: { spec: 'x' } }, apifox: { projectId: 'old' } }),
    { kind: 'openapi', config: { spec: 'x' } }
  )
})

test('contract：内容指纹与统一 meta', async () => {
  const { buildSourceMeta, sourceHashOf } = await import('../src/sources/contract.js')

  const a = sourceHashOf({ b: 2, a: 1 })
  const b = sourceHashOf({ a: 1, b: 2 })
  assert.equal(a, b, '同一对象不同键序应得到相同指纹')
  assert.notEqual(a, sourceHashOf({ a: 2, b: 1 }))
  assert.equal(sourceHashOf(undefined).length, 16)
  assert.equal(sourceHashOf(BigInt(1)), '', '不可序列化的值降级为空串而不是抛错')

  const meta = buildSourceMeta({ kind: 'openapi', interfaces: SPEC_INTERFACES, fromCache: true, warnings: ['w'] })
  assert.equal(meta.kind, 'openapi')
  assert.equal(meta.interfaceCount, 2)
  assert.equal(meta.fromCache, true)
  assert.deepEqual(meta.warnings, ['w'])
  assert.equal(meta.sourceHash, sourceHashOf(SPEC_INTERFACES))
  assert.ok(meta.fetchedAt > 0, '缺省 fetchedAt 应自动补齐')

  // hashSource 允许对「整份文档」取指纹，而不是对投影取
  assert.equal(buildSourceMeta({ hashSource: SPEC }).sourceHash, sourceHashOf(SPEC))
  assert.equal(buildSourceMeta().interfaceCount, 0)
  assert.deepEqual(buildSourceMeta().warnings, [])
})

test('contract：快照校验拒绝残缺与重复 ID', async () => {
  const { validateSnapshots } = await import('../src/sources/contract.js')

  assert.deepEqual(validateSnapshots(SPEC_INTERFACES), SPEC_INTERFACES)
  assert.deepEqual(validateSnapshots([], 'openapi'), [])

  await expectCode(
    (async () => validateSnapshots('nope'))(),
    'SOURCE_BAD_SNAPSHOT'
  )
  await expectCode(
    (async () => validateSnapshots([{ id: 'GET /x', method: 'GET' }]))(),
    'SOURCE_BAD_SNAPSHOT'
  )
  await expectCode(
    (async () => validateSnapshots([{ id: 'GET /x', method: 'GET', path: '/x' }, { id: 'GET /x', method: 'GET', path: '/x' }]))(),
    'SOURCE_DUPLICATE_INTERFACE'
  )
})

// ---------------------------------------------------------------------------
// 2. registry
// ---------------------------------------------------------------------------

test('registry：默认注册 apifox 与 openapi，能力声明可直接渲染表单', async () => {
  const { listSources, sourceKinds, createSource } = await import('../src/sources/registry.js')

  assert.deepEqual(sourceKinds(), ['apifox', 'openapi'])
  const list = listSources()
  assert.equal(list.length, 2)
  for (const desc of list) {
    assert.ok(desc.kind)
    assert.ok(desc.label)
    assert.ok(Array.isArray(desc.configFields) && desc.configFields.length > 0)
    assert.ok(desc.configFields.every((f) => f.key && f.label))
    assert.equal(typeof desc.capabilities, 'object')
  }

  const apifox = createSource('apifox')
  assert.equal(apifox.kind, 'apifox')
  assert.equal(typeof apifox.fetch, 'function')
  assert.equal(typeof apifox.snapshot, 'function')
  assert.equal(typeof apifox.cached, 'function')
  assert.equal(typeof apifox.test, 'function')
  // 令牌字段必须标 secret，前端才不会回显
  assert.equal(apifox.describe().configFields.find((f) => f.key === 'token').secret, true)
})

test('registry：未知来源 / 空 kind / 重复注册都显式报错', async () => {
  const { createRegistry, createSource } = await import('../src/sources/registry.js')

  await expectCode((async () => createSource('nope'))(), 'SOURCE_UNKNOWN')
  await expectCode((async () => createSource(''))(), 'SOURCE_UNKNOWN')

  const registry = createRegistry()
  const fake = { kind: 'fake', label: 'Fake', describe: () => ({ kind: 'fake', configFields: [] }), fetch: () => {} }
  registry.register(fake)
  assert.equal(registry.has('fake'), true)
  assert.equal(registry.get('fake'), fake)
  assert.equal(registry.get('missing'), null)
  assert.deepEqual(registry.kinds(), ['fake'])
  assert.deepEqual(registry.list(), [{ kind: 'fake', configFields: [] }])

  await expectCode((async () => registry.register(fake))(), 'SOURCE_DUPLICATE')
})

test('registry：project → 适配器 + 归一化配置（兼容旧 apifox 字段）', async () => {
  const { registry } = await import('../src/sources/registry.js')

  const legacy = registry.forProject({ apifox: { projectId: 'p1', apiBaseUrl: 'http://x/' } })
  assert.equal(legacy.kind, 'apifox')
  assert.equal(legacy.source.kind, 'apifox')
  assert.deepEqual(legacy.config, {
    projectId: 'p1',
    siteId: '',
    branchId: '',
    apiBaseUrl: 'http://x/',
  })

  const modern = registry.forProject({ source: { kind: 'openapi', config: { spec: '{}' } } })
  assert.equal(modern.kind, 'openapi')
  assert.deepEqual(modern.config, { spec: '{}' })

  await expectCode((async () => registry.forProject({ source: { kind: 'postman' } }))(), 'SOURCE_UNKNOWN')
})

// ---------------------------------------------------------------------------
// 3. projector（Apifox 与 OpenAPI 共用的纯函数）
// ---------------------------------------------------------------------------

test('projector：列表投影字段与顺序稳定', async () => {
  const { countInterfaces, extractInterfaces } = await import('../src/sources/openapi/projector.js')

  assert.equal(countInterfaces(SPEC), 2)
  assert.equal(countInterfaces({}), 0)

  const list = extractInterfaces(SPEC)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], {
    id: 'GET /api/orders/{id}',
    method: 'GET',
    path: '/api/orders/{id}',
    name: '订单详情',
    operationId: '',
    folder: '订单',
    status: 'released',
    tags: ['order'],
    deprecated: false,
  })
  // 没有 summary 时回退到 operationId，再回退到「METHOD path」
  assert.equal(list[1].name, 'createOrder')
  assert.equal(list[1].deprecated, true)
  assert.deepEqual(extractInterfaces({ paths: { '/x': null } }), [])
})

test('projector：快照展开 path/query 参数与 body 示例', async () => {
  const { describeInterfaces } = await import('../src/sources/openapi/projector.js')

  const [getOrder] = describeInterfaces(SPEC, ['GET /api/orders/{id}'])
  assert.equal(getOrder.id, 'GET /api/orders/{id}')
  assert.equal(getOrder.serverUrl, 'http://api.example.com')
  assert.deepEqual(getOrder.pathParams, [
    { name: 'id', in: 'path', required: true, type: 'string', example: '', description: '' },
  ])
  assert.deepEqual(getOrder.queryParams, [
    { name: 'withItems', in: 'query', required: false, type: 'boolean', example: false, description: '' },
  ])
  assert.equal(getOrder.bodySample, null, 'GET 没有请求体')

  assert.deepEqual(describeInterfaces(SPEC, ['DELETE /missing']), [])
  assert.deepEqual(describeInterfaces({}, ['GET /x']), [])
})

test('projector：filterSpec 只保留选中接口且不改原文档', async () => {
  const { countInterfaces, filterSpec } = await import('../src/sources/openapi/projector.js')

  const filtered = filterSpec(SPEC, ['POST /api/orders'])
  assert.equal(countInterfaces(filtered), 1)
  assert.deepEqual(Object.keys(filtered.paths), ['/api/orders'])
  assert.equal(filtered.info.title, '示例文档')
  assert.equal(countInterfaces(SPEC), 2, '原文档不能被修改')

  // 参数可省略：不传 ids 等价于空选择
  assert.equal(countInterfaces(filterSpec(SPEC)), 0)
})

// ---------------------------------------------------------------------------
// 4. apifox 适配器
// ---------------------------------------------------------------------------

test('apifox：未配置且无缓存 → SOURCE_NOT_CONFIGURED，不回退成空成功', async () => {
  const { createApifoxSource } = await import('../src/sources/apifox/index.js')
  const { deps } = makeApifoxDeps({ getCachedInterfaces: () => null })
  const source = createApifoxSource(deps)
  await expectCode(source.fetch({}), 'SOURCE_NOT_CONFIGURED')
})

test('apifox：未配置但有缓存 → 返回缓存并显式标注 fromCache + 警告', async () => {
  const { createApifoxSource } = await import('../src/sources/apifox/index.js')
  const { deps } = makeApifoxDeps()
  const result = await createApifoxSource(deps).fetch({})

  assert.equal(result.fromCache, true)
  assert.equal(result.count, undefined, '兼容字段保持原样，不凭空造 count')
  assert.equal(result.interfaces.length, 2)
  assert.equal(result.meta.fromCache, true)
  assert.equal(result.meta.kind, 'apifox')
  assert.equal(result.meta.warnings.length, 1)
})

test('apifox：有项目无令牌 → 同项目缓存走缓存，强制刷新才拉取', async () => {
  const { createApifoxSource } = await import('../src/sources/apifox/index.js')
  const cachedRun = makeApifoxDeps()
  const cached = await createApifoxSource(cachedRun.deps).fetch({ projectId: 'p1' })
  assert.equal(cached.fromCache, true)
  assert.equal(cachedRun.calls.length, 0, '命中缓存时不应触发 MCP')

  const fetchRun = makeApifoxDeps()
  const fresh = await createApifoxSource(fetchRun.deps).fetch({ projectId: 'p1', refresh: true })
  assert.equal(fresh.fromCache, false)
  assert.equal(fetchRun.calls.filter((c) => c.kind === 'fetchInterfaces').length, 1)
  const call = fetchRun.calls.find((c) => c.kind === 'fetchInterfaces')
  assert.equal(call.options.refresh, true)

  // 不同项目 + 无令牌 + 不强制刷新 → 仍然走拉取（缓存不可复用）
  const otherRun = makeApifoxDeps()
  await createApifoxSource(otherRun.deps).fetch({ projectId: 'p2' })
  assert.equal(otherRun.calls.filter((c) => c.kind === 'fetchInterfaces').length, 1)
})

test('apifox：正常拉取 → 回写连接标识且令牌只在显式传入时回写', async () => {
  const { createApifoxSource } = await import('../src/sources/apifox/index.js')

  const run = makeApifoxDeps()
  const result = await createApifoxSource(run.deps).fetch({ projectId: 'p1', token: 'tkn', branchId: 'b1' })

  assert.equal(result.fromCache, false)
  assert.equal(result.meta.kind, 'apifox')
  assert.equal(result.meta.interfaceCount, 2)
  assert.equal(result.meta.fromCache, false)

  const fetchCall = run.calls.find((c) => c.kind === 'fetchInterfaces')
  assert.equal(fetchCall.connection.token, 'tkn')
  assert.equal(fetchCall.options.refresh, true, 'refresh 缺省等价于 true（与旧实现一致）')

  const saved = run.calls.find((c) => c.kind === 'saveConfig').value
  assert.equal(saved.projectId, 'p1')
  assert.equal(saved.branchId, 'b1')
  assert.equal(saved.token, 'tkn')

  // refresh=false 透传
  const noRefresh = makeApifoxDeps()
  await createApifoxSource(noRefresh.deps).fetch({ projectId: 'p1', token: 'tkn', refresh: false })
  assert.equal(noRefresh.calls.find((c) => c.kind === 'fetchInterfaces').options.refresh, false)

  // 请求未显式带令牌：saveConfig 收到 undefined，避免把内存令牌写进配置文件
  const keepToken = makeApifoxDeps({
    resolveConnection: (input = {}) => ({
      projectId: 'p1',
      siteId: '',
      branchId: '',
      baseUrl: '',
      token: input.token ?? 'memory-token',
    }),
  })
  await createApifoxSource(keepToken.deps).fetch({ projectId: 'p1' })
  assert.equal(keepToken.calls.find((c) => c.kind === 'saveConfig').value.token, undefined)
})

test('apifox：snapshot / cached / test 三个可选能力', async () => {
  const { createApifoxSource } = await import('../src/sources/apifox/index.js')
  const run = makeApifoxDeps()
  const source = createApifoxSource(run.deps)

  const snaps = await source.snapshot(['GET /api/orders/{id}'], {})
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].serverUrl, 'http://api.example.com')
  assert.deepEqual(await source.snapshot([], {}), [])

  const emptyCache = makeApifoxDeps({ readCache: () => null })
  assert.deepEqual(await createApifoxSource(emptyCache.deps).snapshot(['GET /api/orders/{id}']), [])

  assert.equal(source.cached().interfaces.length, 2)

  const tested = await source.test({ projectId: 'p1', token: 'tkn' })
  assert.equal(tested.ok, true)
  assert.equal(tested.interfaceCount, 2)
})

// ---------------------------------------------------------------------------
// 5. openapi 适配器 + 项目双写
// ---------------------------------------------------------------------------

test('openapi：对象与 JSON 字符串都能拉取，0 条接口必须报错', async () => {
  const { createOpenApiSource } = await import('../src/sources/openapi/index.js')

  const fromObject = await createOpenApiSource().fetch({ spec: SPEC })
  assert.equal(fromObject.count, 2)
  assert.equal(fromObject.title, '示例文档')
  assert.equal(fromObject.baseUrl, 'http://api.example.com')
  assert.equal(fromObject.meta.kind, 'openapi')
  assert.equal(fromObject.fromCache, false)

  const fromString = await createOpenApiSource().fetch({ spec: JSON.stringify(SPEC), baseUrl: 'http://override/' })
  assert.equal(fromString.count, 2)
  assert.equal(fromString.baseUrl, 'http://override', 'baseUrl 覆盖时去掉末尾斜杠')

  await expectCode(createOpenApiSource().fetch({}), 'SOURCE_NOT_CONFIGURED')
  await expectCode(createOpenApiSource().fetch({ spec: '{bad json' }), 'SOURCE_BAD_DOCUMENT')
  await expectCode(createOpenApiSource().fetch({ spec: { paths: null } }), 'SOURCE_BAD_DOCUMENT')
  await expectCode(createOpenApiSource().fetch({ spec: { paths: {} } }), 'SOURCE_EMPTY')
})

test('openapi：fetch → snapshot → cached 的内存链路可用', async () => {
  const { createOpenApiSource } = await import('../src/sources/openapi/index.js')
  const source = createOpenApiSource()

  assert.equal(source.cached(), null)
  assert.deepEqual(await source.snapshot(['GET /api/orders/{id}'], {}), [])

  await source.fetch({ spec: SPEC })
  assert.equal(source.cached().interfaces.length, 2)

  // cached(config)：项目自带 spec 时只投影该项目文档，不被上一次全局 fetch 串味
  const scoped = source.cached({ spec: { paths: { '/only': { get: { summary: '仅本文档' } } } } })
  assert.deepEqual(scoped.interfaces.map((it) => it.id), ['GET /only'])
  assert.equal(scoped.fetchedAt, 0, '配置内文档没有抓取时间，显示未知而不是伪造时间')

  const snaps = await source.snapshot(['GET /api/orders/{id}'])
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].folder, '订单')

  // 显式带 spec 时不依赖内存
  const fresh = createOpenApiSource()
  assert.equal((await fresh.snapshot(['POST /api/orders'], { spec: SPEC })).length, 1)

  const tested = await source.test({ spec: SPEC })
  assert.deepEqual(tested, {
    ok: true,
    title: '示例文档',
    version: '2.1.0',
    baseUrl: 'http://api.example.com',
    interfaceCount: 2,
  })
})

test('projects：source 与 apifox 镜像双写，旧前端字段继续可用', async () => {
  const { createProject, summarize, updateProject } = await import('../src/projects/service.js')

  // 旧前端只传 apifox → 自动补 source，读路径统一
  const legacy = createProject({ name: '旧前端项目', apifox: { projectId: 'p1', siteId: 's1' } })
  assert.equal(legacy.source.kind, 'apifox')
  assert.deepEqual(legacy.source.config, {
    projectId: 'p1',
    siteId: 's1',
    branchId: '',
    apiBaseUrl: '',
  })
  assert.deepEqual(legacy.apifox, legacy.source.config)
  assert.equal(summarize(legacy).sourceKind, 'apifox')

  // 新前端传 source=openapi → 不污染 apifox 镜像
  const modern = updateProject(legacy.id, { source: { kind: 'openapi', config: { spec: '{}' } } })
  assert.equal(modern.source.kind, 'openapi')
  assert.equal(summarize(modern).sourceKind, 'openapi')
  assert.equal(modern.apifox.projectId, '', 'openapi 项目不再保留 Apifox 标识')

  // 再把来源切回 apifox（只传 apifox 字段）→ 镜像与 source 同步
  const back = updateProject(modern.id, { apifox: { projectId: 'p9' } })
  assert.equal(back.source.kind, 'openapi', '非 apifox 来源不被旧字段隐式切换')
  assert.equal(back.apifox.projectId, 'p9')

  // 显式切回 apifox
  const explicit = updateProject(back.id, { source: { kind: 'apifox', config: { projectId: 'p9', siteId: 's9' } } })
  assert.deepEqual(explicit.apifox, {
    projectId: 'p9',
    siteId: 's9',
    branchId: '',
    apiBaseUrl: '',
  })
})
