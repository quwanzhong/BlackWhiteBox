/**
 * 回归：执行事件同步（回放 / 实时合流）。
 *
 * 复现的是现场故障：画布先回放 `GET /events?after=lastSeq`，回放完成后才 join 执行房间，
 * `manual_wait` 正好落在这条缝里 → 界面永久停在「执行中 已执行 91s」，用户只能手动关闭。
 * 这里直接对着 EventSync（无 Vue 依赖）断言时序不变式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventSync } from '../src/stores/event-sync.ts'

const evt = (seq, type, payload = {}) => ({ seq, type, payload })

function collector() {
  const seen = []
  return { seen, types: () => seen.map((e) => e.type), apply: (e) => seen.push(e) }
}

test('实时事件按 seq 应用，重复与倒序一律丢弃', () => {
  const sync = new EventSync()
  const c = collector()
  sync.receive(evt(1, 'flow_start'), c.apply)
  sync.receive(evt(2, 'step_start'), c.apply)
  sync.receive(evt(2, 'step_start'), c.apply) // 重复
  sync.receive(evt(1, 'flow_start'), c.apply) // 倒序
  assert.deepEqual(c.types(), ['flow_start', 'step_start'])
  assert.equal(sync.lastSeq, 2)
})

test('回放完成后才到达的 manual_wait 仍会应用（故障现场不再卡死）', () => {
  const sync = new EventSync()
  const c = collector()
  sync.beginReplay()
  // 回放拿到 1..4：manual_wait 此刻还没落库
  sync.replay([evt(1, 'flow_start'), evt(2, 'log'), evt(3, 'step_start'), evt(4, 'log')], c.apply)
  sync.endReplay(c.apply)
  // 回放结束、房间已 join：实时事件补齐
  sync.receive(evt(5, 'manual_wait', { nodeId: 'm1' }), c.apply)
  assert.deepEqual(c.types().slice(-1), ['manual_wait'])
  assert.equal(sync.lastSeq, 5)
})

test('回放期间到达的实时事件先缓冲，结束后按 seq 合并', () => {
  const sync = new EventSync()
  const c = collector()
  sync.beginReplay()
  // 回放请求还没回来，实时事件已抢跑到 seq 6
  sync.receive(evt(6, 'flow_end'), c.apply)
  assert.deepEqual(c.types(), [], '回放期间不就地应用，避免游标抢跑')
  sync.replay([evt(1, 'flow_start'), evt(2, 'step_start')], c.apply)
  sync.endReplay(c.apply)
  assert.deepEqual(c.types(), ['flow_start', 'step_start', 'flow_end'])
  assert.equal(sync.lastSeq, 6)
})

test('回放与缓冲重叠的事件只应用一次，游标不回退', () => {
  const sync = new EventSync()
  const c = collector()
  sync.beginReplay()
  sync.receive(evt(5, 'manual_wait'), c.apply)
  sync.replay([evt(3, 'step_start'), evt(4, 'log'), evt(5, 'manual_wait')], c.apply)
  sync.endReplay(c.apply)
  assert.deepEqual(c.types(), ['step_start', 'log', 'manual_wait'])
  assert.equal(sync.lastSeq, 5)
})

test('reset 后游标归零，可复用于下一次执行', () => {
  const sync = new EventSync()
  const c = collector()
  sync.receive(evt(9, 'flow_end'), c.apply)
  sync.reset()
  assert.equal(sync.lastSeq, 0)
  sync.receive(evt(1, 'flow_start'), c.apply)
  assert.deepEqual(c.types(), ['flow_end', 'flow_start'])
})
