import crypto from 'node:crypto'
import { store } from './store.js'

/**
 * 演示数据：首次启动时自动写入两条流程，方便直接看到「执行发光动画 + 输出匹对校验」效果。
 * 黑盒示例使用 jsonplaceholder.typicode.com（公开测试接口，需要联网）。
 */
function demoBlackboxFlow() {
  const nodes = [
    {
      id: 'n1',
      name: '获取文章列表',
      action: {
        type: 'http',
        method: 'GET',
        url: 'https://jsonplaceholder.typicode.com/posts?_limit=5',
        headers: {},
        body: null,
        timeout: 15000,
      },
      input: { desc: '查询前 5 篇文章，无需参数' },
      expected: {
        status: 200,
        checks: [
          { type: 'json_path', label: '返回列表非空', path: '$', op: 'exists', value: null },
          { type: 'json_path', label: '列表包含 id 字段', path: '$[0].id', op: 'exists', value: null },
        ],
      },
      extract: {},
      position: { x: 80, y: 170 },
    },
    {
      id: 'n2',
      name: '创建一篇文章',
      action: {
        type: 'http',
        method: 'POST',
        url: 'https://jsonplaceholder.typicode.com/posts',
        headers: { 'Content-Type': 'application/json' },
        body: { title: '黑百盒测试', body: '自动化演示流程', userId: 1 },
        timeout: 15000,
      },
      input: { title: '黑百盒测试', body: '自动化演示流程', userId: 1 },
      expected: {
        status: 201,
        checks: [
          { type: 'json_path', label: '返回文章 id', path: '$.id', op: 'exists', value: null },
          { type: 'json_path', label: '标题回显一致', path: '$.title', op: 'eq', value: '黑百盒测试' },
        ],
      },
      extract: { articleId: '$.id' },
      position: { x: 380, y: 170 },
    },
    {
      id: 'n3',
      name: '查询单篇文章',
      action: {
        type: 'http',
        method: 'GET',
        url: 'https://jsonplaceholder.typicode.com/posts/1',
        headers: {},
        body: null,
        timeout: 15000,
      },
      input: { desc: '查询 id=1 的文章详情' },
      expected: {
        status: 200,
        checks: [{ type: 'json_path', label: 'id 匹配', path: '$.id', op: 'eq', value: 1 }],
      },
      extract: {},
      position: { x: 680, y: 170 },
    },
    {
      id: 'n4',
      name: '删除文章',
      action: {
        type: 'http',
        method: 'DELETE',
        url: 'https://jsonplaceholder.typicode.com/posts/1',
        headers: {},
        body: null,
        timeout: 15000,
      },
      input: { desc: '删除 id=1 的文章' },
      expected: { status: 200, checks: [] },
      extract: {},
      position: { x: 980, y: 170 },
    },
  ]

  return {
    id: crypto.randomUUID(),
    name: '演示 · 文章接口链路（黑盒）',
    type: 'blackbox',
    description: '演示用接口流程：列表 → 创建 → 查询 → 删除，包含输出校验与变量提取',
    variables: {},
    nodes,
    edges: [
      { id: 'e_n1_n2', from: 'n1', to: 'n2', condition: '' },
      { id: 'e_n2_n3', from: 'n2', to: 'n3', condition: '' },
      { id: 'e_n3_n4', from: 'n3', to: 'n4', condition: '' },
    ],
  }
}

function demoWhiteboxFlow() {
  const raw = [
    { id: 'm1', name: 'OrderController#createOrder', kind: 'controller', depth: 0, file: 'src/main/java/com/demo/order/OrderController.java', line: 42 },
    { id: 'm2', name: 'OrderService#createOrder', kind: 'service', depth: 1, file: 'src/main/java/com/demo/order/OrderService.java', line: 88 },
    { id: 'm3', name: 'StockService#deduct', kind: 'service', depth: 2, file: 'src/main/java/com/demo/stock/StockService.java', line: 30 },
    { id: 'm4', name: 'PayService#createPayment', kind: 'service', depth: 2, file: 'src/main/java/com/demo/pay/PayService.java', line: 66 },
    { id: 'm5', name: 'OrderMapper#insert', kind: 'mapper', depth: 2, file: 'src/main/java/com/demo/order/OrderMapper.java', line: 18 },
    { id: 'm6', name: 'InventoryMapper#updateStock', kind: 'mapper', depth: 3, file: 'src/main/java/com/demo/stock/InventoryMapper.java', line: 25 },
  ]
  const counter = {}
  const nodes = raw.map((n) => {
    const idx = (counter[n.depth] = (counter[n.depth] ?? -1) + 1)
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      action: {
        type: 'manual',
        hint: `请在代码中检查 ${n.name} 的实现（${n.file}:${n.line}）`,
      },
      input: { file: n.file, line: n.line },
      expected: { manualNote: '人工确认代码逻辑符合预期' },
      extract: {},
      position: { x: 80 + n.depth * 300, y: 90 + idx * 110 },
    }
  })
  const edges = [
    { id: 'e_m1_m2', from: 'm1', to: 'm2', condition: '' },
    { id: 'e_m2_m3', from: 'm2', to: 'm3', condition: '' },
    { id: 'e_m2_m4', from: 'm2', to: 'm4', condition: '' },
    { id: 'e_m2_m5', from: 'm2', to: 'm5', condition: '' },
    { id: 'e_m3_m6', from: 'm3', to: 'm6', condition: '' },
  ]
  return {
    id: crypto.randomUUID(),
    name: '演示 · 下单调用链（白盒）',
    type: 'whitebox',
    description: '演示用白盒流程：Controller → Service → Mapper 调用链，逐步人工确认',
    variables: {},
    nodes,
    edges,
  }
}

export function seedIfEmpty(force = false) {
  const exists = store.listFlows()
  if (exists.length && !force) return
  if (force) {
    // 追加演示流程（不删除已有）
    const hasDemo = exists.some((f) => f.name.startsWith('演示 ·'))
    if (hasDemo) return
  }
  store.saveFlow(demoBlackboxFlow())
  store.saveFlow(demoWhiteboxFlow())
  console.log('[seed] 已写入演示流程（黑盒 + 白盒）')
}

// 支持 `node src/seed.js --force` 手动执行
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedIfEmpty(process.argv.includes('--force'))
  console.log('[seed] 完成')
}
