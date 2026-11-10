import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJacocoXml } from '../src/coverage/jacoco-report.js'

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<report name="demo">
  <package name="com/demo/order">
    <class name="com/demo/order/OrderService" sourcefilename="OrderService.java">
      <method name="&lt;init&gt;" desc="()V" line="9">
        <counter type="LINE" missed="2" covered="0"/>
      </method>
      <method name="create" desc="()V" line="12">
        <counter type="LINE" missed="1" covered="2"/>
      </method>
      <counter type="LINE" missed="3" covered="2"/>
    </class>
    <sourcefile name="OrderService.java">
      <line nr="9" mi="3" ci="0" mb="0" cb="0"/>
      <line nr="10" mi="1" ci="1" mb="0" cb="0"/>
      <line nr="12" mi="0" ci="4" mb="0" cb="0"/>
      <line nr="13" mi="0" ci="2" mb="0" cb="0"/>
      <counter type="LINE" missed="1" covered="3"/>
    </sourcefile>
  </package>
  <package name="">
    <sourcefile name="Root.java">
      <line nr="1" mi="0" ci="1"/>
    </sourcefile>
  </package>
</report>`

test('JaCoCo XML：按 package/sourcefile 聚合行号，ci>0 才算命中', () => {
  const report = parseJacocoXml(XML)
  assert.deepEqual(report.files, [
    {
      path: 'com/demo/order/OrderService.java',
      covered: [10, 12, 13],
      missed: [9],
      total: 4,
    },
    { path: 'Root.java', covered: [1], missed: [], total: 1 },
  ])
  assert.deepEqual(report.totals, {
    files: 2,
    classes: 1,
    covered: 4,
    missed: 1,
    total: 5,
    lineRate: 80,
  })
})

test('JaCoCo XML：类/方法使用 LINE 计数，实体与包路径正确解码', () => {
  const report = parseJacocoXml(XML)
  assert.equal(report.classes.length, 1)
  const order = report.classes[0]
  assert.equal(order.name, 'com.demo.order.OrderService')
  assert.equal(order.source, 'com/demo/order/OrderService.java')
  assert.deepEqual(
    { covered: order.covered, missed: order.missed, total: order.total },
    { covered: 2, missed: 3, total: 5 }
  )
  assert.deepEqual(
    order.methods.map((m) => `${m.name}:${m.covered}/${m.total}@${m.line}`),
    ['<init>:0/2@9', 'create:2/3@12']
  )
})

test('JaCoCo XML：类级 counter 缺失时退回方法聚合，不产生 total=0', () => {
  const report = parseJacocoXml(`<report><package name="p">
    <class name="p/A" sourcefilename="A.java">
      <method name="run" desc="()V" line="3">
        <counter type="LINE" missed="0" covered="3"/>
      </method>
    </class>
    <sourcefile name="A.java"><line nr="3" mi="0" ci="1"/></sourcefile>
  </package></report>`)
  assert.equal(report.classes[0].covered, 3)
  assert.equal(report.classes[0].total, 3)
  assert.equal(report.totals.lineRate, 100)
})

test('JaCoCo XML：非法输入抛稳定 COVERAGE_ANALYZE_FAILED，不静默返回 0%', () => {
  for (const bad of ['', '<html></html>', null, 42]) {
    assert.throws(
      () => parseJacocoXml(bad),
      (err) => err.code === 'COVERAGE_ANALYZE_FAILED' && /JaCoCo XML/.test(err.message)
    )
  }
})

test('JaCoCo XML：空报告返回零值而不是报错', () => {
  assert.deepEqual(parseJacocoXml('<report name="empty"></report>'), {
    files: [],
    classes: [],
    totals: { files: 0, classes: 0, covered: 0, missed: 0, total: 0, lineRate: 0 },
  })
})
