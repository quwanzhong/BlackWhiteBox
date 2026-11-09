#!/usr/bin/env node
/**
 * 05-assert.mjs — 校验 PoC 的三个假设（H1/H2/H3），输出 result.json
 *
 * H1 能挂上、连得通、dump 有数据
 * H2 per-node 隔离：node-B 的覆盖率里不得出现订单链路的任何命中
 * H3 行号映射：XML 里的行号能在源码中找到对应代码，且能组装出 Coverage 结构
 */
import fs from 'node:fs'
import path from 'node:path'

const outDir = path.resolve(process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(import.meta.dirname, '..', 'out'))
const fixtureSrc = path.resolve(import.meta.dirname, '..', 'fixture', 'src')

function parseReport(file) {
  const xml = fs.readFileSync(file, 'utf8')
  const files = []
  const pkgRe = /<package name="([^"]+)">([\s\S]*?)<\/package>/g
  let pkg
  while ((pkg = pkgRe.exec(xml))) {
    const pkgName = pkg[1]
    const body = pkg[2]
    const sfRe = /<sourcefile name="([^"]+)">([\s\S]*?)<\/sourcefile>/g
    let sf
    while ((sf = sfRe.exec(body))) {
      const covered = []
      const missed = []
      let line
      const lineRe = /<line nr="(\d+)" mi="(\d+)" ci="(\d+)" mb="(\d+)" cb="(\d+)"\/>/g
      while ((line = lineRe.exec(sf[2]))) {
        const nr = Number(line[1])
        const mi = Number(line[2]), ci = Number(line[3])
        const mb = Number(line[4]), cb = Number(line[5])
        if (ci + cb > 0) covered.push(nr)
        if (mi + mb > 0) missed.push(nr)
      }
      files.push({ pkg: pkgName, file: sf[1], covered, missed })
    }
  }
  return files
}

const files = {
  A: parseReport(path.join(outDir, 'node-A.xml')),
  B: parseReport(path.join(outDir, 'node-B.xml')),
  C: parseReport(path.join(outDir, 'node-C.xml')),
}
const probe = JSON.parse(fs.readFileSync(path.join(outDir, 'probe-result.json'), 'utf8'))

const coveredSet = (list) => new Set(list.flatMap((f) => f.covered.map((n) => `${f.pkg}/${f.file}:${n}`)))
const setA = coveredSet(files.A)
const setB = coveredSet(files.B)
const setC = coveredSet(files.C)

const orderPrefix = 'com/poc/order'
const stockPrefix = 'com/poc/stock'
const inPkg = (pkg, prefix) => pkg === prefix || pkg.startsWith(prefix + '/')

const bOrderCovered = files.B.filter((f) => inPkg(f.pkg, orderPrefix)).flatMap((f) => f.covered)
const bStockCovered = files.B.filter((f) => inPkg(f.pkg, stockPrefix)).flatMap((f) => f.covered)
const aOrderCovered = files.A.filter((f) => inPkg(f.pkg, orderPrefix)).flatMap((f) => f.covered)
const cStockCovered = files.C.filter((f) => inPkg(f.pkg, stockPrefix)).flatMap((f) => f.covered)

// H3：XML 行号必须能在源码里找到非空行
function sourceLine(pkg, file, nr) {
  const p = path.join(fixtureSrc, pkg, file)
  if (!fs.existsSync(p)) return null
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
  return lines[nr - 1] ?? null
}

const h3Samples = []
for (const f of files.A) {
  for (const nr of f.covered.slice(0, 3)) {
    h3Samples.push({ pkg: f.pkg, file: f.file, line: nr, code: (sourceLine(f.pkg, f.file, nr) || '').trim() })
  }
}
const h3Bad = h3Samples.filter((s) => !s.code)

const checks = [
  {
    id: 'H1',
    name: 'agent 可连接、dump 有数据',
    pass: probe.ok === true && probe.nodes.every((n) => n.execBytes > 0) && probe.calibration.bytes >= 0,
    detail: {
      calibrationBytes: probe.calibration?.bytes,
      nodes: probe.nodes.map((n) => ({ id: n.id, status: n.status, execBytes: n.execBytes, dumpMs: n.dumpMs })),
    },
  },
  {
    id: 'H2',
    name: 'per-node 隔离：node-B 不含订单链路的命中',
    pass: bOrderCovered.length === 0 && bStockCovered.length > 0 && aOrderCovered.length > 0,
    detail: {
      'node-A 订单命中行数': aOrderCovered.length,
      'node-B 订单命中行数': bOrderCovered.length,
      'node-B 库存命中行数': bStockCovered.length,
      'A∩B 命中交集': [...setA].filter((k) => setB.has(k)),
    },
  },
  {
    id: 'H3',
    name: '行号可映射回源码',
    pass: h3Bad.length === 0 && h3Samples.length > 0,
    detail: {
      samples: h3Samples.slice(0, 6),
    },
  },
]

// 组装一个正式的 Coverage 结构示例（02 §6.5）
const sample = files.A.map((f) => ({
  path: `${f.pkg}/${f.file}`,
  covered: f.covered,
  missed: f.missed,
  total: new Set([...f.covered, ...f.missed]).size,
}))
const uncoveredInA = files.A.flatMap((f) => f.missed.map((nr) => ({
  path: `${f.pkg}/${f.file}:${nr}`,
  code: (sourceLine(f.pkg, f.file, nr) || '').trim(),
})))

const result = {
  generatedAt: new Date().toISOString(),
  passed: checks.every((c) => c.pass),
  checks,
  coverageSample: { source: 'jacoco', mode: 'per-node', nodeId: 'node-A', files: sample },
  uncoveredInNodeA: uncoveredInA,
  nodeC: {
    stockCoveredLines: cStockCovered.length,
    note: '应包含库存不足分支（AlertClient.lowStock / throw）',
  },
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))

for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.name}`)
}
console.log('\n' + JSON.stringify(result.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })), null, 2))
if (uncoveredInA.length) {
  console.log('\nnode-A 未覆盖行（示例，最多 8 条）：')
  for (const u of uncoveredInA.slice(0, 8)) console.log(`  ${u.path}  ${u.code}`)
}
process.exit(result.passed ? 0 : 1)
