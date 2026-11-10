/**
 * 进程内并发队列（M2-2）。
 *
 * 需求只到「同一进程最多 N 条流程并行」这一层，刻意不引入 p-queue / BullMQ：
 * 单机产品 + 桌面端打包，外部依赖只会把安装包和排查成本一起放大。
 *
 * 设计边界：
 *  - 只负责「限流 + 等待」，不负责重试/失败策略（由 suites/runner.js 决定）；
 *  - 任务抛错不会中断队列，错误原样抛给调用方的 Promise；
 *  - 记录 peak 便于测试与运行时可观测，不参与调度。
 */
export class TaskQueue {
  constructor({ concurrency = 3 } = {}) {
    const n = Math.floor(Number(concurrency))
    this.concurrency = Number.isFinite(n) && n > 0 ? n : 1
    this.active = 0
    this.peak = 0
    this.pending = []
    this.idleWaiters = []
  }

  get size() {
    return this.pending.length
  }

  get stats() {
    return { concurrency: this.concurrency, active: this.active, pending: this.pending.length, peak: this.peak }
  }

  /**
   * 提交一个任务。任务开始时才会占用并发额度。
   * @param {() => Promise<any>} task
   * @returns {Promise<any>}
   */
  add(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('TaskQueue.add 需要函数'))
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject })
      this.drain()
    })
  }

  /** 所有已提交任务结束后 resolve（用于测试/优雅退出） */
  onIdle() {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const item = this.pending.shift()
      this.active += 1
      this.peak = Math.max(this.peak, this.active)
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1
          this.drain()
          if (this.active === 0 && this.pending.length === 0) {
            const waiters = this.idleWaiters.splice(0)
            for (const resolve of waiters) resolve()
          }
        })
    }
  }
}

export function createQueue(options) {
  return new TaskQueue(options)
}
