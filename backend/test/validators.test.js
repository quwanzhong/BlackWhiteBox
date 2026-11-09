import assert from 'node:assert/strict'
import test from 'node:test'
import { runChecks } from '../src/engine/validators.js'

/** 便捷构造一次校验结果 */
function check(expected, result) {
  return runChecks(expected, result)
}

test('校验器：状态码默认 200，可显式覆盖', () => {
  const ok = check(undefined, { status: 200, data: {} })
  assert.equal(ok.matched, true)
  assert.equal(ok.results[0].type, 'status')
  assert.equal(ok.results[0].value, 200)

  const fail = check({}, { status: 500, data: {} })
  assert.equal(fail.matched, false)
  assert.equal(fail.results[0].passed, false)
  assert.match(fail.results[0].message, /HTTP 状态码|期望 等于 200/)

  const custom = check({ status: 201 }, { status: 201, data: {} })
  assert.equal(custom.matched, true)
  assert.equal(custom.results[0].value, 201)
})

test('校验器：eq / ne 使用严格相等', () => {
  assert.equal(check({ checks: [{ path: '$.code', op: 'eq', value: 0 }] }, { status: 200, data: { code: 0 } }).matched, true)
  assert.equal(check({ checks: [{ path: '$.code', op: 'eq', value: 0 }] }, { status: 200, data: { code: '0' } }).matched, false)
  assert.equal(check({ checks: [{ path: '$.code', op: 'ne', value: 1 }] }, { status: 200, data: { code: 0 } }).matched, true)
  assert.equal(check({ checks: [{ path: '$.code', op: 'ne', value: 0 }] }, { status: 200, data: { code: 0 } }).matched, false)
})

test('校验器：数值比较会做 Number 转换', () => {
  const data = { n: '10' }
  const cases = [
    ['gt', 9, true], ['gt', 10, false],
    ['ge', 10, true], ['ge', 11, false],
    ['lt', 11, true], ['lt', 10, false],
    ['le', 10, true], ['le', 9, false],
  ]
  for (const [op, value, expected] of cases) {
    const r = check({ checks: [{ path: '$.n', op, value }] }, { status: 200, data })
    assert.equal(r.matched, expected, `${op} ${value}`)
  }
})

test('校验器：exists 对 undefined / null 为假', () => {
  const data = { a: 0, b: false, c: null }
  const exists = (path) => check({ checks: [{ path, op: 'exists' }] }, { status: 200, data }).matched
  assert.equal(exists('$.a'), true)
  assert.equal(exists('$.b'), true)
  assert.equal(exists('$.c'), false)
  assert.equal(exists('$.missing'), false)
})

test('校验器：regex 正常匹配，非法正则返回 false 而不抛错', () => {
  const data = { id: 'ORD-2026-0001' }
  assert.equal(check({ checks: [{ path: '$.id', op: 'regex', value: '^ORD-\\d{4}-\\d+$' }] }, { status: 200, data }).matched, true)
  assert.equal(check({ checks: [{ path: '$.id', op: 'regex', value: '^PAY' }] }, { status: 200, data }).matched, false)
  // 非法正则走 catch 分支
  assert.equal(check({ checks: [{ path: '$.id', op: 'regex', value: '[' }] }, { status: 200, data }).matched, false)
})

test('校验器：contains 支持数组元素与字符串子串', () => {
  const data = { list: [{ id: 1 }, { id: 2 }], text: 'hello world' }
  assert.equal(check({ checks: [{ path: '$.list', op: 'contains', value: { id: 2 } }] }, { status: 200, data }).matched, true)
  assert.equal(check({ checks: [{ path: '$.list', op: 'contains', value: { id: 3 } }] }, { status: 200, data }).matched, false)
  assert.equal(check({ checks: [{ path: '$.text', op: 'contains', value: 'world' }] }, { status: 200, data }).matched, true)
  assert.equal(check({ checks: [{ path: '$.text', op: 'contains', value: 'WORLD' }] }, { status: 200, data }).matched, false)
  // 取不到的字符串按空串处理
  assert.equal(check({ checks: [{ path: '$.missing', op: 'contains', value: '' }] }, { status: 200, data }).matched, true)
})

test('校验器：type 支持 array / null / typeof', () => {
  const data = { arr: [], nil: null, str: 'x', num: 1, obj: {}, bool: true }
  const type = (path, value) => check({ checks: [{ path, op: 'type', value }] }, { status: 200, data }).matched
  assert.equal(type('$.arr', 'array'), true)
  assert.equal(type('$.obj', 'array'), false)
  assert.equal(type('$.nil', 'null'), true)
  assert.equal(type('$.str', 'null'), false)
  assert.equal(type('$.str', 'string'), true)
  assert.equal(type('$.num', 'number'), true)
  assert.equal(type('$.obj', 'object'), true)
  assert.equal(type('$.bool', 'boolean'), true)
})

test('校验器：未知算子回退为 eq', () => {
  const r = check({ checks: [{ path: '$.code', op: 'unknown_op', value: 0 }] }, { status: 200, data: { code: 0 } })
  assert.equal(r.matched, true)
  // 失败时用原始算子名兜底展示
  const f = check({ checks: [{ path: '$.code', op: 'unknown_op', value: 1 }] }, { status: 200, data: { code: 0 } })
  assert.equal(f.matched, false)
  assert.match(f.results[1].message, /期望 unknown_op/)
})

test('校验器：body_contains 对整个响应体做子串匹配', () => {
  const data = { code: 0, message: '下单成功', data: { id: 42 } }
  assert.equal(check({ checks: [{ type: 'body_contains', value: '下单成功' }] }, { status: 200, data }).matched, true)
  assert.equal(check({ checks: [{ type: 'body_contains', value: '"id":42' }] }, { status: 200, data }).matched, true)
  assert.equal(check({ checks: [{ type: 'body_contains', value: '失败' }] }, { status: 200, data }).matched, false)

  // 响应体无法 JSON 序列化（循环引用）时降级为 String()
  const circular = { name: 'root' }
  circular.self = circular
  assert.equal(check({ checks: [{ type: 'body_contains', value: 'object Object' }] }, { status: 200, data: circular }).matched, true)
})

test('校验器：耗时上限', () => {
  const expected = { maxDurationMs: 100, checks: [] }
  assert.equal(check(expected, { status: 200, data: {}, durationMs: 100 }).matched, true)
  const over = check(expected, { status: 200, data: {}, durationMs: 101 })
  assert.equal(over.matched, false)
  assert.equal(over.results.at(-1).type, 'duration')
  assert.match(over.results.at(-1).message, /期望 小于等于 100，实际 101/)
})

test('校验器：失败文案包含期望值与实际值', () => {
  const r = check(
    { checks: [{ path: '$.code', op: 'eq', value: 0 }] },
    { status: 200, data: { code: 'bad' } }
  )
  const msg = r.results[1].message
  assert.match(msg, /期望 等于 0/)
  assert.match(msg, /实际 "bad"/)

  // 未取到的路径有专门文案
  const missing = check({ checks: [{ path: '$.nope', op: 'eq', value: 1 }] }, { status: 200, data: {} })
  assert.match(missing.results[1].message, /实际 未取到/)

  // 循环引用对象无法 JSON 化时走 String() 兜底
  const circular = {}
  circular.self = circular
  const circularRes = check({ checks: [{ path: '$.self', op: 'eq', value: 1 }] }, { status: 200, data: circular })
  assert.match(circularRes.results[1].message, /object Object/)
})

test('校验器：全部通过才算 matched，任一失败即整体失败', () => {
  const expected = {
    status: 200,
    maxDurationMs: 500,
    checks: [
      { path: '$.code', op: 'eq', value: 0 },
      { type: 'body_contains', value: 'ok' },
    ],
  }
  assert.equal(check(expected, { status: 200, data: { code: 0, msg: 'ok' }, durationMs: 10 }).matched, true)
  assert.equal(check(expected, { status: 200, data: { code: 1, msg: 'ok' }, durationMs: 10 }).matched, false)
  assert.equal(check(expected, { status: 200, data: { code: 0, msg: 'ok' }, durationMs: 501 }).matched, false)
})
