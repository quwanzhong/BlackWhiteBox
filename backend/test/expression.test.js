import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate, evaluateCondition, ExpressionError } from '../src/security/expression.js'

/** 用响应体做 $.path 解析，模拟调度器里的 last.data */
function ctxFor(data, vars = {}) {
  return {
    vars,
    path: (tokens) => {
      let cur = data
      for (const tk of tokens) {
        if (cur == null) return undefined
        cur = cur[tk]
      }
      return cur
    },
  }
}

const RESP = { code: 0, data: { ok: true, list: [{ name: 'a' }, { name: 'b' }], count: 2 } }

test('表达式：路径取值与比较', () => {
  const ctx = ctxFor(RESP)
  assert.equal(evaluateCondition('$.code == 0', ctx), true)
  assert.equal(evaluateCondition('$.code === 0', ctx), true)
  assert.equal(evaluateCondition('$.code != 1', ctx), true)
  assert.equal(evaluateCondition('$.data.ok', ctx), true)
  assert.equal(evaluateCondition('$.data.list[1].name == "b"', ctx), true)
  assert.equal(evaluateCondition('$.data.missing == null', ctx), true)
  assert.equal(evaluateCondition('$.data.count > 1 && $.code === 0', ctx), true)
  assert.equal(evaluateCondition('$.data.count > 5 || $.code === 0', ctx), true)
})

test('表达式：与旧 new Function 实现的行为对齐', () => {
  const ctx = ctxFor(RESP)
  // 宽松相等：'1' == 1 为 true（旧实现是真 JS，行为一致）
  assert.equal(evaluateCondition('"1" == 1', ctx), true)
  assert.equal(evaluateCondition('1 == true', ctx), true)
  // 严格相等不做类型转换
  assert.equal(evaluateCondition('"1" === 1', ctx), false)
  // 关系运算：可转数字按数字比，否则按字符串比
  assert.equal(evaluate('$.data.count >= 2', ctx), true)
  assert.equal(evaluate('"2" > "10"', ctx), true)
  assert.equal(evaluate('10 > 2', ctx), true)
  // 真值判定与 !! 一致
  assert.equal(evaluateCondition('""', ctx), false)
  assert.equal(evaluateCondition('0', ctx), false)
  assert.equal(evaluateCondition('undefined', ctx), false)
  // 括号与取反
  assert.equal(evaluateCondition('!($.code == 1)', ctx), true)
  assert.equal(evaluateCondition('($.code == 0 || $.code == 500) && $.data.ok', ctx), true)
  // 取不到的路径不抛错，按 falsy 处理（旧实现同理）
  assert.equal(evaluateCondition('$.data.a.b.c', ctx), false)
})

test('表达式：变量与白名单函数', () => {
  const ctx = ctxFor(RESP, { tenantId: 'T-1', n: 7 })
  assert.equal(evaluateCondition('{{tenantId}} == "T-1"', ctx), true)
  assert.equal(evaluateCondition('{{n}} > 5', ctx), true)
  assert.equal(evaluateCondition('{{missing}} == undefined', ctx), true)
  assert.equal(evaluateCondition('Number("42") === 42', ctx), true)
  assert.equal(evaluateCondition('String(42) == "42"', ctx), true)
  assert.equal(evaluateCondition('Boolean(0) == false', ctx), true)
  assert.equal(evaluate('parseInt("10px")', ctx), 10)
  assert.equal(evaluate('parseFloat("1.5x")', ctx), 1.5)
})

test('表达式：字符串与转义', () => {
  assert.equal(evaluate("'a\\nb'", {}), 'a\nb')
  assert.equal(evaluate('"it\'s"', {}), "it's")
  assert.equal(evaluate("'a\\'b'", {}), "a'b")
  assert.throws(() => evaluate("'未闭合", {}), ExpressionError)
})

test('表达式：注入与危险语法一律拒绝', () => {
  const ctx = ctxFor(RESP)
  const dangerous = [
    'process.exit()',
    'process["exit"]() require("fs")',
    'this.constructor("return 1")()',
    '$.constructor',
    '$.data.__proto__',
    '$["prototype"]',
    'globalThis',
    '(() => 1)()',
    '1; 2',
    'alert(1)',
    '`tpl`',
    'x = 1',
    'await 1',
  ]
  for (const expr of dangerous) {
    assert.throws(() => evaluate(expr, ctx), ExpressionError, `应当拒绝：${expr}`)
  }
})

test('表达式：长度与嵌套上限', () => {
  assert.throws(() => evaluate(`"${'x'.repeat(2100)}"`, {}), ExpressionError)
  assert.throws(() => evaluate('('.repeat(40) + '1' + ')'.repeat(40), {}), ExpressionError)
  // 边界内正常
  assert.equal(evaluate('1 == 1', {}), true)
})

test('表达式：空表达式返回 undefined（调度器据此视为无限制）', () => {
  assert.equal(evaluate('', {}), undefined)
  assert.equal(evaluate('   ', {}), undefined)
  assert.equal(evaluateCondition('', {}), false)
})
