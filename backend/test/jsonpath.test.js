import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToTokens, resolvePath, resolveTokens, substitute } from '../src/engine/jsonpath.js'

test('jsonpath：pathToTokens 解析常见写法', () => {
  assert.deepEqual(pathToTokens('$.a.b[0].c'), ['a', 'b', 0, 'c'])
  assert.deepEqual(pathToTokens('a.b'), ['a', 'b'])
  assert.deepEqual(pathToTokens('$[0]'), [0])
  assert.deepEqual(pathToTokens('$.list[2].name'), ['list', 2, 'name'])
  // 空与非法输入
  assert.deepEqual(pathToTokens('$'), [])
  assert.deepEqual(pathToTokens(''), [])
  assert.deepEqual(pathToTokens(null), [])
  assert.deepEqual(pathToTokens(123), [])
})

test('jsonpath：resolveTokens 逐层取值，遇到 null/undefined 提前返回', () => {
  const obj = { a: { b: [10, { c: 'x' }] } }
  assert.equal(resolveTokens(obj, ['a', 'b', 1, 'c']), 'x')
  assert.equal(resolveTokens(obj, ['a', 'missing', 'c']), undefined)
  assert.equal(resolveTokens(null, ['a']), undefined)
  // 空 token 数组返回原对象
  assert.equal(resolveTokens(obj, []), obj)
  assert.equal(resolveTokens(obj, null), obj)
})

test('jsonpath：resolvePath 组合解析', () => {
  const obj = { list: [{ name: 'a' }, { name: 'b' }], meta: { total: 2 } }
  assert.equal(resolvePath(obj, '$.list[1].name'), 'b')
  assert.equal(resolvePath(obj, '$.meta.total'), 2)
  assert.equal(resolvePath(obj, '$'), obj)
  assert.equal(resolvePath(obj, '$.missing.deep'), undefined)
  assert.equal(resolvePath(obj, ''), obj)
})

test('jsonpath：substitute 整串变量保留原类型', () => {
  const vars = { n: 5, obj: { id: 1 }, flag: false, nil: null, name: 'tom' }
  assert.equal(substitute('{{n}}', vars), 5)
  assert.equal(substitute('{{ n }}', vars), 5)
  assert.deepEqual(substitute('{{obj}}', vars), { id: 1 })
  assert.equal(substitute('{{flag}}', vars), false)
  assert.equal(substitute('{{nil}}', vars), null)
  assert.equal(substitute('{{name}}', vars), 'tom')
})

test('jsonpath：substitute 混合字符串转字符串，缺失变量保留占位符', () => {
  const vars = { n: 5, name: 'tom' }
  assert.equal(substitute('id-{{n}}', vars), 'id-5')
  assert.equal(substitute('{{name}}-{{n}}', vars), 'tom-5')
  assert.equal(substitute('{{missing}}', vars), '{{missing}}')
  assert.equal(substitute('x-{{missing}}-y', vars), 'x-{{missing}}-y')
  assert.equal(substitute('{{ a }}', {}), '{{ a }}')
})

test('jsonpath：substitute 递归处理数组与对象，其他类型原样返回', () => {
  const vars = { id: 7 }
  assert.deepEqual(
    substitute({ url: '/orders/{{id}}', list: ['{{id}}', 'x'], nested: { a: '{{id}}' } }, vars),
    { url: '/orders/7', list: [7, 'x'], nested: { a: 7 } }
  )
  assert.equal(substitute(42, vars), 42)
  assert.equal(substitute(true, vars), true)
  assert.equal(substitute(null, vars), null)
  assert.equal(substitute(undefined, vars), undefined)
})
