/**
 * 受限表达式求值器（S5）。
 *
 * 原来的实现是 `new Function(...)`：流程 JSON / 导入文件里的条件表达式可以执行任意代码
 * （`process.exit()`、读文件、发请求），而流程数据恰恰是「可被导入、可被同步、可被他人生成」的。
 *
 * 这里用递归下降解析器只支持条件判断需要的最小语法：
 *
 *   字面量    数字 / 单双引号字符串 / true / false / null / undefined
 *   取值      $.a.b[0]（JSONPath 风格）、{{varName}}
 *   比较      == != === !== > >= < <=
 *   逻辑      && || ! 与括号
 *   函数      String / Number / Boolean / parseInt / parseFloat（白名单）
 *
 * 没有属性赋值、没有函数定义、不能调用用户提供的函数，因此注入 `process.exit()` 只会
 * 得到一个「不支持的标识符」错误。
 */

const MAX_LENGTH = 2000
const MAX_DEPTH = 32
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const FUNCTIONS = {
  String: (v) => String(v ?? ''),
  Number: (v) => Number(v),
  Boolean: (v) => Boolean(v),
  parseInt: (v) => parseInt(String(v), 10),
  parseFloat: (v) => parseFloat(String(v)),
}

export class ExpressionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExpressionError'
  }
}

/** JS 宽松相等的最小子集：够条件判断用，避免 `1 == '1'` 这类惊喜 */
function looseEquals(a, b) {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  if (typeof a === 'boolean') return looseEquals(Number(a), b)
  if (typeof b === 'boolean') return looseEquals(a, Number(b))
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b)
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b
  return false
}

function relational(a, b, op) {
  let x
  let y
  if (typeof a === 'string' && typeof b === 'string') {
    // 与 JS 一致：两边都是字符串时按字典序比较
    x = a
    y = b
  } else {
    x = Number(a)
    y = Number(b)
    // 任一侧转不成数字时，JS 的关系运算一律 false
    if (Number.isNaN(x) || Number.isNaN(y)) return false
  }
  if (op === '>') return x > y
  if (op === '>=') return x >= y
  if (op === '<') return x < y
  return x <= y
}

class Parser {
  constructor(source, ctx) {
    this.src = source
    this.i = 0
    this.ctx = ctx
    this.depth = 0
  }

  error(message) {
    throw new ExpressionError(`${message}（位置 ${this.i}）`)
  }

  ws() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i += 1
  }

  /** 吃掉一个运算符（长的优先），成功返回 true */
  eat(op) {
    this.ws()
    if (this.src.startsWith(op, this.i)) {
      this.i += op.length
      return true
    }
    return false
  }

  peek(str) {
    this.ws()
    return this.src.startsWith(str, this.i)
  }

  parse() {
    const value = this.parseOr()
    this.ws()
    if (this.i < this.src.length) this.error(`无法识别的字符「${this.src.slice(this.i, this.i + 8)}」`)
    return value
  }

  parseOr() {
    let left = this.parseAnd()
    while (this.eat('||')) {
      const right = this.parseAnd()
      left = Boolean(left) || Boolean(right)
    }
    return left
  }

  parseAnd() {
    let left = this.parseEquality()
    while (this.eat('&&')) {
      const right = this.parseEquality()
      left = Boolean(left) && Boolean(right)
    }
    return left
  }

  parseEquality() {
    let left = this.parseRelational()
    for (;;) {
      if (this.eat('===')) left = left === this.parseRelational()
      else if (this.eat('!==')) left = left !== this.parseRelational()
      else if (this.eat('==')) left = looseEquals(left, this.parseRelational())
      else if (this.eat('!=')) left = !looseEquals(left, this.parseRelational())
      else return left
    }
  }

  parseRelational() {
    let left = this.parseUnary()
    for (;;) {
      if (this.eat('>=')) left = relational(left, this.parseUnary(), '>=')
      else if (this.eat('<=')) left = relational(left, this.parseUnary(), '<=')
      else if (this.eat('>')) left = relational(left, this.parseUnary(), '>')
      else if (this.eat('<')) left = relational(left, this.parseUnary(), '<')
      else return left
    }
  }

  parseUnary() {
    if (this.eat('!')) return !this.parseUnary()
    if (this.eat('-')) return -Number(this.parseUnary())
    return this.parsePrimary()
  }

  parsePrimary() {
    this.ws()
    if (this.i >= this.src.length) this.error('表达式意外结束')

    const ch = this.src[this.i]

    if (ch === '(') {
      this.i += 1
      this.depth += 1
      if (this.depth > MAX_DEPTH) this.error('括号嵌套过深')
      const value = this.parseOr()
      this.ws()
      if (this.src[this.i] !== ')') this.error('缺少右括号')
      this.i += 1
      this.depth -= 1
      return value
    }

    if (ch === '$') return this.parsePath()
    if (ch === '"' || ch === "'") return this.parseString()
    if (ch === '{' && this.src.startsWith('{{', this.i)) return this.parseVariable()

    if (/\d/.test(ch)) return this.parseNumber()

    if (/[A-Za-z_]/.test(ch)) return this.parseIdentifier()

    return this.error(`不支持的字符「${ch}」`)
  }

  parseNumber() {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.i))
    if (!match) this.error('数字格式不正确')
    this.i += match[0].length
    return Number(match[0])
  }

  parseString() {
    const quote = this.src[this.i]
    this.i += 1
    let out = ''
    while (this.i < this.src.length) {
      const ch = this.src[this.i]
      if (ch === quote) {
        this.i += 1
        return out
      }
      if (ch === '\\') {
        const next = this.src[this.i + 1]
        const map = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' }
        if (!(next in map)) this.error(`不支持的转义 \\${next}`)
        out += map[next]
        this.i += 2
        continue
      }
      out += ch
      this.i += 1
    }
    return this.error('字符串没有闭合')
  }

  /** {{varName}} → vars[varName]（缺失为 undefined，与旧实现一致） */
  parseVariable() {
    const match = /^\{\{\s*(\w+)\s*\}\}/.exec(this.src.slice(this.i))
    if (!match) this.error('变量写法应为 {{name}}')
    this.i += match[0].length
    return this.ctx.vars ? this.ctx.vars[match[1]] : undefined
  }

  /** $.a.b[0]["c-d"] → token 数组交给调用方解析 */
  parsePath() {
    this.i += 1 // $
    const tokens = []
    for (;;) {
      const ch = this.src[this.i]
      if (ch === '.') {
        this.i += 1
        const match = /^[A-Za-z_$][\w$-]*/.exec(this.src.slice(this.i))
        if (!match) this.error('路径缺少属性名')
        tokens.push(this.checkKey(match[0]))
        this.i += match[0].length
        continue
      }
      if (ch === '[') {
        this.i += 1
        this.ws()
        let key
        if (this.src[this.i] === '"' || this.src[this.i] === "'") {
          key = this.parseString()
        } else {
          const match = /^\d+/.exec(this.src.slice(this.i))
          if (!match) this.error('方括号里只能是数字或字符串')
          key = Number(match[0])
          this.i += match[0].length
        }
        this.ws()
        if (this.src[this.i] !== ']') this.error('缺少右方括号')
        this.i += 1
        tokens.push(typeof key === 'string' ? this.checkKey(key) : key)
        continue
      }
      break
    }
    if (!tokens.length) this.error('$ 后面要跟字段名，如 $.code')
    return this.ctx.path ? this.ctx.path(tokens) : undefined
  }

  checkKey(key) {
    if (FORBIDDEN_KEYS.has(key)) this.error(`不允许访问 ${key}`)
    return key
  }

  parseIdentifier() {
    const match = /^[A-Za-z_]\w*/.exec(this.src.slice(this.i))
    const name = match[0]
    this.i += name.length

    if (name === 'true') return true
    if (name === 'false') return false
    if (name === 'null') return null
    if (name === 'undefined') return undefined

    const fn = FUNCTIONS[name]
    if (!fn) this.error(`不支持的标识符「${name}」`)

    this.ws()
    if (this.src[this.i] !== '(') this.error(`函数 ${name} 需要参数，如 ${name}(x)`)
    this.i += 1
    const arg = this.parseOr()
    this.ws()
    if (this.src[this.i] !== ')') this.error('缺少右括号')
    this.i += 1
    return fn(arg)
  }
}

/**
 * 求值。
 * @param {string} expression 条件表达式
 * @param {{vars?: Record<string, any>, path?: (tokens: (string|number)[]) => any}} ctx
 */
export function evaluate(expression, ctx = {}) {
  const source = String(expression ?? '').trim()
  if (!source) return undefined
  if (source.length > MAX_LENGTH) throw new ExpressionError(`表达式过长（最多 ${MAX_LENGTH} 字符）`)
  return new Parser(source, ctx).parse()
}

/** 条件表达式专用：任何非布尔真值按真假处理 */
export function evaluateCondition(expression, ctx = {}) {
  return Boolean(evaluate(expression, ctx))
}
