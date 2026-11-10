import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueue, TaskQueue } from '../src/engine/queue.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('队列：并发上限生效，峰值可观测，按完成时间收集结果', async () => {
  const queue = createQueue({ concurrency: 2 })
  const order = []
  // 0 号是长任务，1/2/3 短任务在它占位期间依次排空。
  // 长任务留足余量（400 ms vs 短任务合计 45 ms），避免 CI 上一次事件循环停顿就把顺序断言打成偶发失败。
  const tasks = [400, 10, 30, 5].map((ms, i) =>
    queue.add(async () => {
      await sleep(ms)
      order.push(i)
      return i
    })
  )
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3], '结果按提交顺序返回')
  assert.equal(queue.peak, 2, '峰值并发必须等于配置上限')
  assert.equal(order[0], 1, '最短任务先完成')
  assert.equal(order.at(-1), 0, '长任务最后完成')
  assert.ok(order.indexOf(2) < order.indexOf(3), '30 ms 任务早于 5 ms 任务启动完成')
  assert.equal(order.length, 4)
  assert.equal(queue.active, 0)
  assert.equal(queue.size, 0)
  assert.equal(queue.stats.pending, 0)
})

test('队列：任务抛错不影响后续任务，错误原样返回', async () => {
  const queue = createQueue({ concurrency: 1 })
  const results = await Promise.allSettled([
    queue.add(async () => {
      throw new Error('boom')
    }),
    queue.add(async () => 'ok'),
  ])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[0].reason.message, 'boom')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(results[1].value, 'ok')
})

test('队列：非法并发收敛为 1，非函数任务直接拒绝', async () => {
  assert.equal(new TaskQueue({ concurrency: 0 }).concurrency, 1)
  assert.equal(new TaskQueue({ concurrency: 'abc' }).concurrency, 1)
  await assert.rejects(createQueue().add('not-a-function'), TypeError)
})

test('队列：onIdle 在全部任务结束后才 resolve', async () => {
  const queue = createQueue({ concurrency: 2 })
  let done = 0
  queue.add(async () => {
    await sleep(20)
    done += 1
  })
  queue.add(async () => {
    await sleep(10)
    done += 1
  })
  await queue.onIdle()
  assert.equal(done, 2)
})
