import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// 必须在 import 任何 src 模块之前设置（config.js 加载时固定数据目录与库路径）
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-export-'))
const TOKEN = 'export-unit-token-0123456789abcdef'
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'export.db')
process.env.HEIBAIHE_TOKEN = TOKEN

const auth = { authorization: `Bearer ${TOKEN}` }
const ioStub = { to: () => ({ emit() {} }) }

after(async () => {
  try {
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
  } catch {
    /* 未初始化则忽略 */
  }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------------------------------------------------------------- 样本文档

const sampleExecution = () => ({
  id: 'exec-1234abcd',
  flowId: 'flow-1',
  flowName: '登录 & 下单 <核心>',
  flowType: 'blackbox',
  projectId: 'p1',
  status: 'failed',
  startedAt: Date.parse('2026-11-10T02:00:00Z'),
  finishedAt: Date.parse('2026-11-10T02:00:01Z'),
  envId: 'env-1',
  envVersion: 3,
  steps: [
    {
      id: 's1',
      nodeId: 'n1',
      nodeName: '登录 "主" & <校验>',
      status: 'failed',
      durationMs: 120,
      failureClass: 'status',
      failureReason: '期望 等于 200，实际 500',
      request: {
        method: 'POST',
        url: 'http://api.local/login?access_token=query-secret&ms=10',
        headers: { authorization: 'Bearer header-secret', 'x-trace': 'keep-me' },
        body: { user: 'alice', password: 'body-secret', nested: { apiKey: 'nested-secret' } },
      },
      actual: {
        status: 500,
        durationMs: 120,
        headers: { 'set-cookie': 'sid=server-secret-cookie', 'content-type': 'application/json' },
        data: { code: 500, data: { token: 'server-body-token' } },
      },
      checks: {
        matched: false,
        results: [
          { type: 'status', path: '', op: 'eq', value: 200, actual: 500, passed: false, message: '期望 等于 200，实际 500' },
        ],
      },
      error: null,
    },
    { id: 's2', nodeId: 'n2', nodeName: '依赖', status: 'skipped', durationMs: 0, failureClass: 'dependency', failureReason: '前置节点失败', error: '前置节点失败' },
    { id: 's3', nodeId: 'n3', nodeName: '通过', status: 'passed', durationMs: 30, checks: { matched: true, results: [] } },
    { id: 's4', nodeId: 'n4', nodeName: '等待确认', status: 'waiting' },
  ],
  summary: {
    status: 'failed',
    total: 4,
    passed: 1,
    failed: 1,
    skipped: 2,
    durationMs: 150,
    message: '存在 1 个未通过步骤',
    failureClass: 'status',
    failureReason: '期望 等于 200，实际 500',
    failureClasses: { network: 0, timeout: 0, status: 1, schema: 0, assertion: 0, dependency: 1, script: 0, manual_reject: 0 },
  },
  events: [
    {
      type: 'step_end',
      payload: {
        nodeId: 'n1',
        request: { method: 'POST', url: 'http://api.local/login?access_token=event-secret', headers: { cookie: 'sid=event-secret' } },
        status: 'failed',
      },
      ts: 1,
    },
  ],
  vars: { token: 'extracted-token-stays' },
})

const sampleSuiteRun = () => ({
  id: 'suite-run-1',
  suiteId: 'suite-1',
  suiteName: '冒烟 <套件>',
  projectId: 'p1',
  status: 'failed',
  startedAt: Date.parse('2026-11-10T02:00:00Z'),
  finishedAt: Date.parse('2026-11-10T02:00:02Z'),
  envId: 'env-1',
  strategy: { concurrency: 2, retry: 1 },
  summary: {
    status: 'failed',
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    flaky: 0,
    durationMs: 2000,
    message: '存在失败流程',
    flows: [
      {
        flowId: 'flow-1',
        flowName: '登录 & 下单 <核心>',
        index: 0,
        status: 'failed',
        flaky: false,
        attempts: 2,
        attemptExecutions: [{ id: 'exec-1234abcd' }],
        failureClass: 'status',
        failureReason: '期望 等于 200，实际 500',
        durationMs: 150,
      },
    ],
  },
})

// ---------------------------------------------------------------- 1. 脱敏（S8）

test('脱敏：敏感键判定覆盖精确名与后缀变体，不误伤业务字段', async () => {
  const { isSensitiveKey } = await import('../src/reporting/scrub.js')
  for (const key of [
    'authorization',
    'Authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'password',
    'passwd',
    'pwd',
    'secret',
    'clientSecret',
    'client-secret',
    'access_token',
    'refreshToken',
    'id-token',
    'api_key',
    'x-api-key',
    'session',
    'credential',
    'private-key',
    'userPassword',
    'accessToken',
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} 应判定为敏感键`)
  }
  for (const key of ['user', 'orderId', 'requestId', 'ms', 'pageSize', 'tokenCount', 'author', 'ok']) {
    assert.equal(isSensitiveKey(key), false, `${key} 不应被误伤`)
  }
})

test('脱敏：请求头 / URL query / 请求体 / 响应头打码，响应体与提取变量保留', async () => {
  const { scrubExecution, scrubHeaders, scrubUrl, scrubBody } = await import('../src/reporting/scrub.js')

  assert.deepEqual(scrubHeaders({ authorization: 'Bearer x', 'x-trace': 'keep' }), {
    authorization: '***',
    'x-trace': 'keep',
  })
  assert.equal(scrubHeaders(undefined), undefined)
  assert.deepEqual(scrubHeaders([{ cookie: 'a' }, { ok: 'b' }]), [{ cookie: '***' }, { ok: 'b' }])

  assert.equal(
    scrubUrl('http://api.local/login?access_token=secret&ms=10&utf8=%E4%B8%AD#frag'),
    'http://api.local/login?access_token=***&ms=10&utf8=%E4%B8%AD#frag'
  )
  assert.equal(scrubUrl('http://api.local/login?token'), 'http://api.local/login?token', '无值参数保持原样')
  assert.equal(scrubUrl('/relative?password=x'), '/relative?password=***')
  assert.equal(scrubUrl('http://api.local/login'), 'http://api.local/login')
  assert.equal(scrubUrl(null), null)

  assert.deepEqual(scrubBody({ a: 1, password: 'p', nested: { apiKey: 'k', ok: 'v' } }), {
    a: 1,
    password: '***',
    nested: { apiKey: '***', ok: 'v' },
  })
  assert.equal(scrubBody('{"user":"a","password":"p"}'), '{"user":"a","password":"***"}')
  assert.equal(scrubBody('user=a&password=p&ms=10'), 'user=a&password=***&ms=10')
  assert.equal(scrubBody('{"user":"a","password":"p"'), '{"user":"a","password":"***"', '不完整 JSON 也要打码')
  assert.equal(scrubBody(null), null)
  assert.equal(scrubBody(42), 42)

  const detail = sampleExecution()
  const snapshot = JSON.parse(JSON.stringify(detail))
  const safe = scrubExecution(detail)

  assert.deepEqual(detail, snapshot, '脱敏不得修改原对象')
  assert.equal(safe.steps[0].request.headers.authorization, '***')
  assert.equal(safe.steps[0].request.headers['x-trace'], 'keep-me')
  assert.match(safe.steps[0].request.url, /access_token=\*\*\*&ms=10/)
  assert.equal(safe.steps[0].request.body.password, '***')
  assert.equal(safe.steps[0].request.body.nested.apiKey, '***')
  assert.equal(safe.steps[0].request.body.user, 'alice')
  assert.equal(safe.steps[0].actual.headers['set-cookie'], '***', '响应头也要剥离')
  assert.equal(safe.steps[0].actual.headers['content-type'], 'application/json')
  assert.equal(safe.steps[0].actual.data.data.token, 'server-body-token', '响应体保留证据')
  assert.equal(safe.vars.token, 'extracted-token-stays', '提取变量不按键名剥离')
  assert.match(safe.events[0].payload.request.url, /access_token=\*\*\*/)
  assert.equal(safe.events[0].payload.request.headers.cookie, '***')

  const text = JSON.stringify(safe)
  for (const secret of ['header-secret', 'query-secret', 'body-secret', 'nested-secret', 'server-secret-cookie', 'event-secret']) {
    assert.equal(text.includes(secret), false, `${secret} 不得出现在导出数据里`)
  }
  assert.equal(scrubExecution(null), null)
})

// ---------------------------------------------------------------- 2. 三种格式

test('JUnit：testcase 与计数同步骤对齐，失败带归类与证据，非法字符被清理', async () => {
  const { executionToJUnit, escapeXml } = await import('../src/reporting/exporters/junit.js')
  const { scrubExecution } = await import('../src/reporting/scrub.js')
  const execution = sampleExecution()
  execution.steps[0].nodeName = '登录\u0001 "主" & <校验>'
  // 渲染器是纯格式化器；脱敏的唯一出口在 renderExport（这里显式走一遍，模拟真实链路）
  const xml = executionToJUnit(scrubExecution(execution))

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<testsuites[^>]*tests="4"[^>]*failures="1"[^>]*skipped="2"/)
  assert.match(xml, /<testsuite[^>]*name="登录 &amp; 下单 &lt;核心&gt;"/)
  assert.equal((xml.match(/<testcase/g) || []).length, 4)
  assert.match(xml, /<failure type="status" message="期望 等于 200，实际 500">/)
  assert.match(xml, /请求：POST http:\/\/api\.local\/login\?access_token=\*\*\*&amp;ms=10/)
  assert.match(xml, /响应：500（120 ms）/)
  assert.match(xml, /- status：期望 等于 200，实际 500/)
  assert.match(xml, /归类：状态码不符（status）/)
  assert.match(xml, /响应体：\{&quot;code&quot;:500/)
  assert.match(xml, /<skipped message="前置节点失败"\/>/)
  assert.match(xml, /<skipped message="等待人工确认（导出时仍未确认）"\/>/)
  assert.ok(!xml.includes('\u0001'), 'XML 1.0 非法控制字符必须剔除')
  assert.match(xml, /name="登录 &quot;主&quot; &amp; &lt;校验&gt;"/)
  assert.equal(escapeXml(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;')
  assert.equal(escapeXml(undefined), '')
})

test('JUnit：套件导出写 runId / flaky / attempts，且每个执行一个 testsuite', async () => {
  const { suiteRunToJUnit } = await import('../src/reporting/exporters/junit.js')
  const execution = sampleExecution()
  const xml = suiteRunToJUnit({ suiteRun: sampleSuiteRun(), executions: [execution, { ...execution, id: 'exec-2', flowId: 'flow-2', flowName: '第二条' }] })

  assert.match(xml, /<testsuites[^>]*name="冒烟 &lt;套件&gt;"/)
  assert.equal((xml.match(/<testsuite /g) || []).length, 2)
  assert.match(xml, /<property name="suite.runId" value="suite-run-1"\/>/)
  assert.match(xml, /<property name="environment" value="env-1"\/>/)
  assert.match(xml, /<property name="attempts" value="2"\/>/)
  assert.match(xml, /套件：冒烟 &lt;套件&gt;/)
})

test('HTML：单文件内联样式、零外链，文本全部转义，汇总与失败清单一致', async () => {
  const { executionToHtml, escapeHtml } = await import('../src/reporting/exporters/html.js')
  const { scrubExecution } = await import('../src/reporting/scrub.js')
  const execution = sampleExecution()
  execution.steps[0].nodeName = '</script><b>x</b>'
  const html = executionToHtml(scrubExecution(execution), { generatedAt: Date.parse('2026-11-10T03:00:00Z') })

  assert.match(html, /^<!DOCTYPE html>/)
  assert.match(html, /<style>/)
  assert.ok(!/<link/i.test(html), '不得引用外部样式')
  assert.ok(!/<script/i.test(html), '不得带脚本（含未转义内容）')
  assert.ok(!/\b(?:src|href)=/i.test(html), '不得有任何外链资源')
  assert.match(html, /&lt;\/script&gt;&lt;b&gt;x&lt;\/b&gt;/)
  assert.match(html, /登录 &amp; 下单 &lt;核心&gt;/)
  assert.match(html, /<div class="v">4<\/div>/, '步骤总数')
  assert.match(html, /<div class="v">1<\/div>/, '失败数')
  assert.match(html, /状态码不符/)
  assert.match(html, /期望 等于 200，实际 500/)
  assert.match(html, /access_token=\*\*\*/)
  assert.ok(!html.includes('header-secret'), 'HTML 也不能泄漏凭证')
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;')
})

test('HTML：套件报告含流程结果表与每流程步骤', async () => {
  const { suiteRunToHtml } = await import('../src/reporting/exporters/html.js')
  const html = suiteRunToHtml(
    { suiteRun: sampleSuiteRun(), executions: [sampleExecution()] },
    { generatedAt: Date.parse('2026-11-10T03:00:00Z') }
  )
  assert.match(html, /冒烟 &lt;套件&gt;/)
  assert.match(html, /流程结果/)
  assert.match(html, /<div class="v">1<\/div>/)
  assert.match(html, /失败归类计数/)
  assert.match(html, /执行 ID：/)
  assert.match(html, /<h2>登录 &amp; 下单 &lt;核心&gt; /)
  assert.ok(!/\b(?:src|href)=/i.test(html))
})

test('JSON：固定信封字段 + 套件结构，正文是脱敏后的完整执行', async () => {
  const { executionToJson, suiteRunToJson, EXPORT_VERSION } = await import('../src/reporting/exporters/json.js')
  const { scrubExecution } = await import('../src/reporting/scrub.js')

  const body = JSON.parse(executionToJson(scrubExecution(sampleExecution()), { generatedAt: 1762743600000 }))
  assert.equal(body.version, EXPORT_VERSION)
  assert.equal(body.kind, 'execution')
  assert.equal(body.generatedAt, new Date(1762743600000).toISOString())
  assert.equal(body.scrubbed.requestBody, true)
  assert.equal(body.scrubbed.responseBody, false)
  assert.equal(body.execution.id, 'exec-1234abcd')
  assert.equal(body.execution.steps.length, 4)
  assert.equal(body.execution.steps[0].failureClass, 'status')
  assert.equal(body.execution.steps[0].request.headers.authorization, '***')

  const suiteBody = JSON.parse(
    suiteRunToJson({ suiteRun: sampleSuiteRun(), executions: [sampleExecution()] }, { generatedAt: 1762743600000 })
  )
  assert.equal(suiteBody.kind, 'suite-run')
  assert.equal(suiteBody.suiteRun.id, 'suite-run-1')
  assert.equal(suiteBody.executions.length, 1)
  assert.equal(suiteBody.suiteRun.summary.flows[0].attempts, 2)
})

test('导出门面：format 归一化、文件名（ASCII 兜底 + 中文原名）、Content-Disposition', async () => {
  const { normalizeFormat, exportFilename, contentDisposition, renderExport, ExportError, EXPORT_FORMATS, DEFAULT_FORMAT } =
    await import('../src/reporting/export.js')

  assert.deepEqual(EXPORT_FORMATS, ['junit', 'html', 'json'])
  assert.equal(DEFAULT_FORMAT, 'json')
  assert.equal(normalizeFormat(undefined), 'json')
  assert.equal(normalizeFormat(''), 'json')
  assert.equal(normalizeFormat(' HTML '), 'html')
  assert.equal(normalizeFormat('junit'), 'junit')
  assert.equal(normalizeFormat('xml'), null)

  const files = exportFilename('execution', '登录 & 下单', 'abcdef123456', 'junit')
  assert.equal(files.ascii, 'heibaihe-execution-abcdef12.junit.xml')
  assert.equal(files.display, 'heibaihe-登录 & 下单-abcdef12.junit.xml')
  const disposition = contentDisposition(files)
  assert.match(disposition, /^attachment; filename="heibaihe-execution-abcdef12\.junit\.xml"/)
  assert.match(disposition, /filename\*=UTF-8''heibaihe-%E7%99%BB%E5%BD%95/)
  assert.equal(exportFilename('suite-run', '', '', 'json').ascii, 'heibaihe-suite-run-unknown.json')

  const out = renderExport({ format: 'json', kind: 'execution', name: 'x', id: 'id-1', execution: sampleExecution() })
  assert.equal(out.contentType, 'application/json; charset=utf-8')
  assert.equal(out.extension, 'json')
  assert.equal(out.filename, 'heibaihe-x-id-1.json')
  assert.ok(JSON.parse(out.body).execution)

  for (const [format, type] of [
    ['junit', 'application/xml'],
    ['html', 'text/html'],
  ]) {
    const rendered = renderExport({ format, kind: 'suite-run', name: 's', id: 'sr-1', suiteRun: sampleSuiteRun(), executions: [sampleExecution()] })
    assert.ok(rendered.contentType.startsWith(type))
  }

  assert.throws(
    () => renderExport({ format: 'yaml', kind: 'execution', execution: sampleExecution() }),
    (err) => err instanceof ExportError && err.code === 'EXPORT_BAD_FORMAT' && err.status === 400
  )
  assert.throws(
    () => renderExport({ format: 'json', kind: 'mystery' }),
    (err) => err instanceof ExportError && err.code === 'EXPORT_BAD_KIND'
  )
})

// ---------------------------------------------------------------- 3. API 端到端

test('API：三种格式可下载、S8 无明文泄漏、404/400 语义正确、套件导出可用', async () => {
  // 桩：POST /api/echo 回 201 + set-cookie；响应体故意保留 token（导出要保留证据）。
  // 注意：只回显非敏感字段 —— 若把 password 原样回显，它就变成「响应体」，
  // 按 S8 契约（响应体不按键名剥离）不该被打码，会让「请求体已脱敏」的断言失效。
  const stub = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw ? JSON.parse(raw) : null
    res.writeHead(201, {
      'content-type': 'application/json',
      'set-cookie': 'sid=server-secret-cookie',
    })
    res.end(
      JSON.stringify({
        code: 0,
        echo: { user: parsed?.user ?? null, hasPassword: Boolean(parsed?.password) },
        data: { token: 'server-body-token' },
      })
    )
  })
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const stubBase = `http://127.0.0.1:${stub.address().port}`

  try {
    const { RunSession } = await import('../src/engine/scheduler.js')
    const { store } = await import('../src/store.js')

    const flow = store.saveFlow({
      name: '导出主链路',
      type: 'blackbox',
      nodes: [
        {
          id: 'n1',
          name: '回显接口',
          action: {
            type: 'http',
            method: 'POST',
            url: `${stubBase}/api/echo?access_token=query-secret&ms=10`,
            headers: { authorization: 'Bearer header-secret', 'x-trace': 'keep-me' },
            body: { user: 'alice', password: 'body-secret' },
          },
          expected: { status: 200, checks: [] },
        },
      ],
      edges: [],
    })

    const session = new RunSession(flow, ioStub, { suiteRunId: 'suite-run-api' })
    await session.start()
    assert.equal(session.status, 'failed', '期望 200 实际 201，用于生成失败证据')

    store.saveSuiteRun({
      ...sampleSuiteRun(),
      id: 'suite-run-api',
      suiteName: '导出套件',
      summary: {
        ...sampleSuiteRun().summary,
        flows: [{ ...sampleSuiteRun().summary.flows[0], flowId: flow.id, flowName: flow.name, attemptExecutions: [{ id: session.executionId }] }],
      },
    })

    const { createApp } = await import('../src/app.js')
    const appCtx = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
    await new Promise((resolve) => appCtx.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${appCtx.server.address().port}`
    const fetchExport = (p) => fetch(`${base}${p}`, { headers: auth })

    try {
      const id = session.executionId

      // —— JUnit ——
      const junit = await fetchExport(`/api/executions/${id}/export?format=junit`)
      assert.equal(junit.status, 200)
      assert.match(junit.headers.get('content-type'), /^application\/xml/)
      assert.match(junit.headers.get('content-disposition'), /attachment; filename="heibaihe-.*\.junit\.xml"/)
      const junitText = await junit.text()
      assert.match(junitText, /<testsuite[^>]*tests="1"[^>]*failures="1"/)
      assert.match(junitText, /<failure type="status"/)
      assert.match(junitText, /access_token=\*\*\*&amp;ms=10/)
      assert.equal(junitText.includes('header-secret'), false)
      assert.equal(junitText.includes('query-secret'), false)
      assert.equal(junitText.includes('body-secret'), false)
      assert.equal(junitText.includes('server-secret-cookie'), false)
      assert.equal(junitText.includes('server-body-token'), true, '响应体保留作为证据')

      // —— HTML ——
      const html = await fetchExport(`/api/executions/${id}/export?format=HTML`)
      assert.equal(html.status, 200)
      assert.match(html.headers.get('content-type'), /^text\/html/)
      const htmlText = await html.text()
      assert.match(htmlText, /^<!DOCTYPE html>/)
      assert.ok(!/\b(?:src|href)=/i.test(htmlText))
      assert.equal(htmlText.includes('header-secret'), false)
      assert.equal(htmlText.includes('body-secret'), false, 'HTML 里的请求体也要脱敏')

      // —— JSON（缺省格式）——
      const json = await fetchExport(`/api/executions/${id}/export`)
      assert.equal(json.status, 200)
      assert.match(json.headers.get('content-type'), /^application\/json/)
      const parsed = await json.json()
      assert.equal(parsed.kind, 'execution')
      assert.equal(parsed.execution.id, id)
      assert.equal(parsed.execution.steps[0].request.headers.authorization, '***')
      assert.match(parsed.execution.steps[0].request.url, /access_token=\*\*\*/)
      assert.equal(parsed.execution.steps[0].actual.headers['set-cookie'], '***')
      assert.equal(parsed.execution.steps[0].actual.data.data.token, 'server-body-token')
      assert.equal(parsed.execution.failureClass, 'status')
      assert.equal(parsed.execution.steps[0].request.body.password, '***', '请求体敏感键打码')
      assert.equal(parsed.execution.steps[0].request.headers['x-trace'], 'keep-me', '非敏感头保留')

      // 口径一致：导出前后的步骤数与通过/失败计数必须等于详情页
      const detailRes = await (await fetchExport(`/api/executions/${id}`)).json()
      assert.equal(parsed.execution.steps.length, detailRes.steps.length)
      assert.equal(parsed.execution.summary.failed, detailRes.summary.failed)
      assert.equal(parsed.execution.summary.passed, detailRes.summary.passed)

      // —— 套件导出 ——
      const suite = await fetchExport('/api/suite-runs/suite-run-api/export?format=junit')
      assert.equal(suite.status, 200)
      const suiteText = await suite.text()
      assert.match(suiteText, /<property name="suite.runId" value="suite-run-api"\/>/)
      assert.equal(suiteText.includes('header-secret'), false)

      const suiteJson = await (await fetchExport('/api/suite-runs/suite-run-api/export?format=json')).json()
      assert.equal(suiteJson.kind, 'suite-run')
      assert.equal(suiteJson.executions.length, 1)

      // —— 错误码 ——
      const badFormat = await fetchExport(`/api/executions/${id}/export?format=yaml`)
      assert.equal(badFormat.status, 400)
      assert.equal((await badFormat.json()).code, 'EXPORT_BAD_FORMAT')

      const missing = await fetchExport('/api/executions/nope/export?format=json')
      assert.equal(missing.status, 404)
      assert.equal((await missing.json()).code, 'EXECUTION_NOT_FOUND')

      const missingSuite = await fetchExport('/api/suite-runs/nope/export?format=json')
      assert.equal(missingSuite.status, 404)
      assert.equal((await missingSuite.json()).code, 'SUITE_RUN_NOT_FOUND')

      const badSuiteFormat = await fetchExport('/api/suite-runs/suite-run-api/export?format=xml')
      assert.equal(badSuiteFormat.status, 400)
    } finally {
      await new Promise((resolve) => appCtx.io.close(resolve))
      if (appCtx.server.listening) await new Promise((resolve) => appCtx.server.close(resolve))
    }
  } finally {
    await new Promise((resolve) => stub.close(resolve))
  }
})
