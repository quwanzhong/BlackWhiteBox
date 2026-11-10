import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// config.js 在导入时固定数据目录，必须先设环境变量再动态导入 src 模块
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-analyzer-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'analyzer.db')
process.env.HEIBAIHE_TOKEN = 'analyzer-unit-token-0123456789abcdef'

const { CoverageAnalyzer, CoverageAnalysisError, analyzerConfigFrom, runJacococli } =
  await import('../src/coverage/analyzer.js')
const { parseJacocoXml } = await import('../src/coverage/jacoco-report.js')
const { store } = await import('../src/store.js')
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')

after(() => {
  closeDefaultDatabase()
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const XML = `<report><package name="com/demo">
  <sourcefile name="OrderService.java">
    <line nr="10" mi="1" ci="1"/>
    <line nr="12" mi="0" ci="2"/>
    <line nr="15" mi="3" ci="0"/>
  </sourcefile>
</package></report>`
const RESULT = parseJacocoXml(XML)

function workspace() {
  const dir = fs.mkdtempSync(path.join(DIR, 'clitest-'))
  const execFile = path.join(dir, 'node.exec')
  const xmlFile = path.join(dir, 'node.xml')
  const cliPath = path.join(dir, 'jacococli.jar')
  const classfiles = path.join(dir, 'classes')
  const sourcefiles = path.join(dir, 'src')
  fs.writeFileSync(execFile, Buffer.from([1, 2, 3]))
  fs.writeFileSync(cliPath, '')
  fs.mkdirSync(classfiles)
  fs.mkdirSync(sourcefiles)
  return { dir, execFile, xmlFile, cliPath, classfiles, sourcefiles }
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

test('analyzerConfigFrom：未配置/关闭返回 null，路径字段 trim，CLI 有默认值', () => {
  assert.equal(analyzerConfigFrom(undefined), null)
  assert.equal(analyzerConfigFrom({ coverage: { enabled: false } }), null)
  const config = analyzerConfigFrom({
    coverage: {
      classfiles: ' target/classes ',
      sourcefiles: ' src/main/java ',
      cliPath: ' tools/jacococli.jar ',
      javaBin: ' C:/jdk/bin/java.exe ',
    },
  })
  assert.equal(config.classfiles, 'target/classes')
  assert.equal(config.sourcefiles, 'src/main/java')
  assert.equal(config.cliPath, 'tools/jacococli.jar')
  assert.equal(config.javaBin, 'C:/jdk/bin/java.exe')
  assert.match(analyzerConfigFrom({ coverage: {} }).cliPath, /jacococli\.jar$/)
})

test('runJacococli：缺失 classfiles / CLI / sourcefiles 都返回稳定 code', async () => {
  const ws = workspace()
  await assert.rejects(
    runJacococli({ execFile: ws.execFile, xmlFile: ws.xmlFile, classfiles: null, cliPath: ws.cliPath }),
    (err) => err.code === 'COVERAGE_CLASSFILES_MISSING'
  )
  await assert.rejects(
    runJacococli({
      execFile: ws.execFile,
      xmlFile: ws.xmlFile,
      classfiles: path.join(ws.dir, 'missing-classes'),
      cliPath: ws.cliPath,
    }),
    (err) => err.code === 'COVERAGE_CLASSFILES_MISSING' && /classfiles/.test(err.message)
  )
  await assert.rejects(
    runJacococli({
      execFile: ws.execFile,
      xmlFile: ws.xmlFile,
      classfiles: ws.classfiles,
      cliPath: path.join(ws.dir, 'missing-cli.jar'),
    }),
    (err) => err.code === 'COVERAGE_CLI_MISSING'
  )
  await assert.rejects(
    runJacococli({
      execFile: ws.execFile,
      xmlFile: ws.xmlFile,
      classfiles: ws.classfiles,
      sourcefiles: path.join(ws.dir, 'missing-src'),
      cliPath: ws.cliPath,
    }),
    (err) => err.code === 'COVERAGE_ANALYZE_FAILED' && /sourcefiles/.test(err.message)
  )
})

test('runJacococli：成功时解析 XML；非零退出/启动异常/超时都收敛到 ANALYZE_FAILED', async () => {
  const ws = workspace()
  const ok = await runJacococli({
    ...ws,
    spawnImpl: (_bin, args) => {
      const child = fakeChild()
      setImmediate(() => {
        fs.writeFileSync(args[args.indexOf('--xml') + 1], XML)
        child.emit('close', 0, null)
      })
      return child
    },
  })
  assert.deepEqual(ok.result.totals, {
    files: 1,
    classes: 0,
    covered: 2,
    missed: 1,
    total: 3,
    lineRate: 66.67,
  })

  await assert.rejects(
    runJacococli({
      ...ws,
      spawnImpl: () => {
        const child = fakeChild()
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('bad bytecode'))
          child.emit('close', 2, null)
        })
        return child
      },
    }),
    (err) => err.code === 'COVERAGE_ANALYZE_FAILED' && /退出码 2.*bad bytecode/.test(err.message)
  )

  await assert.rejects(
    runJacococli({
      ...ws,
      spawnImpl: () => {
        const child = fakeChild()
        setImmediate(() => child.emit('error', Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' })))
        return child
      },
    }),
    (err) => err.code === 'COVERAGE_JAVA_MISSING'
  )

  await assert.rejects(
    runJacococli({
      ...ws,
      timeoutMs: 20,
      spawnImpl: () => fakeChild(),
    }),
    (err) => err.code === 'COVERAGE_ANALYZE_FAILED' && /超时/.test(err.message)
  )

  await assert.rejects(
    runJacococli({
      ...ws,
      spawnImpl: () => {
        throw new Error('spawn exploded')
      },
    }),
    (err) => err.code === 'COVERAGE_ANALYZE_FAILED' && /spawn exploded/.test(err.message)
  )
})

test('analyzer：逐节点分析，成功写 analyzed，失败保留证据并写稳定 error', async () => {
  const executionId = 'exec-analyze'
  const okRow = store.saveCoverage({
    executionId,
    nodeId: 'n1',
    execBlob: Buffer.from([1, 2, 3]),
  })
  const badRow = store.saveCoverage({
    executionId,
    nodeId: 'n2',
    execBlob: Buffer.from([9, 9]),
  })
  store.saveCoverage({
    executionId,
    nodeId: 'n3',
    status: 'unavailable',
    error: 'COVERAGE_AGENT_UNREACHABLE: x',
  })

  let event = null
  const analyzer = new CoverageAnalyzer({
    executionId,
    settings: { coverage: { classfiles: DIR } },
    onEvent: (summary) => {
      event = summary
    },
    runner: async ({ execFile }) => {
      const first = fs.readFileSync(execFile)[0]
      if (first === 9) throw new CoverageAnalysisError('COVERAGE_ANALYZE_FAILED', '类文件版本不匹配')
      return { result: RESULT }
    },
  })
  const summary = await analyzer.run()

  assert.equal(summary.analyzed, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.total, 2)
  assert.equal(summary.reason, null)
  assert.equal(event, summary)

  const rows = store.listExecutionCoverage(executionId)
  const analyzed = rows.find((row) => row.nodeId === 'n1')
  const failed = rows.find((row) => row.nodeId === 'n2')
  assert.equal(analyzed.status, 'analyzed')
  assert.equal(analyzed.error, null)
  assert.deepEqual(analyzed.result.totals, RESULT.totals)
  assert.ok(analyzed.analyzedAt > 0)

  assert.equal(failed.status, 'captured')
  assert.match(failed.error, /^COVERAGE_ANALYZE_FAILED: 类文件版本不匹配/)
  // 分析失败也写 analyzed_at，表示「已尝试过」，但投影按 error 计为 analysisFailed
  assert.ok(failed.analyzedAt > 0)
  assert.equal(store.getCoverage(okRow.id).execBlob.toString('hex'), '010203')
  assert.equal(store.getCoverage(badRow.id).execBlob.toString('hex'), '0909')

  // 第二次只重试「分析失败」行；已 analyzed / unavailable 不再进入
  const again = await analyzer.run()
  assert.equal(again.total, 1)
  assert.equal(again.analyzed, 0)
  assert.equal(again.failed, 1)
})

test('analyzer：未配置 classfiles 不分析，行保持 captured+pending；空 blob 记为 skipped', async () => {
  const noClass = new CoverageAnalyzer({
    executionId: 'exec-no-class',
    settings: { coverage: {} },
    runner: async () => {
      throw new Error('不该被调用')
    },
  })
  store.saveCoverage({ executionId: 'exec-no-class', nodeId: 'n1', execBlob: Buffer.from([1]) })
  const skippedSummary = await noClass.run()
  assert.equal(skippedSummary.reason, 'CLASSFILES_NOT_CONFIGURED')
  assert.equal(skippedSummary.total, 1)
  assert.equal(skippedSummary.skipped, 1)
  assert.equal(store.listExecutionCoverage('exec-no-class')[0].status, 'captured')
  assert.equal(store.listExecutionCoverage('exec-no-class')[0].error, null)

  store.saveCoverage({ executionId: 'exec-empty-blob', nodeId: 'n1', execBlob: null })
  const empty = await new CoverageAnalyzer({
    executionId: 'exec-empty-blob',
    settings: { coverage: { classfiles: DIR } },
  }).run()
  assert.equal(empty.skipped, 1)
  assert.equal(store.listExecutionCoverage('exec-empty-blob')[0].status, 'captured')
})

test('analyzer：未配置覆盖率直接返回 disabled，不查库不报错', async () => {
  const summary = await new CoverageAnalyzer({ executionId: 'exec-off' }).run()
  assert.equal(summary.reason, 'COVERAGE_DISABLED')
  assert.equal(summary.total, 0)
})
