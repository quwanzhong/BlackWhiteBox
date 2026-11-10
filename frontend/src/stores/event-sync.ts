/**
 * 执行事件同步器（M2-5 的补洞/去重内核）。
 *
 * 为什么单独抽出来：前端有两条事件来源——WebSocket 实时推送、`GET /events?after=` 回放补洞。
 * 两者会重叠，也可能互相「抢跑」。曾经的实现是「先回放、后 join 房间」，回放完成到 join
 * 成功之间产生的事件两边都收不到（现场故障：manual_wait 落在这条缝里，画布一直显示
 * 「执行中」直到用户手动关闭）。
 *
 * 现在的不变式：
 * 1. 订阅方先进房间，再回放；回放期间（beginReplay → endReplay）到达的实时事件先缓冲，不推进游标；
 * 2. 回放落地后按 seq 排序合并缓冲区，`seq <= lastSeq` 的一律丢弃（天然幂等）；
 * 3. 纯 TS、不依赖 Vue/Pinia，便于用 node:test 直接回归这类时序缺陷。
 */
export type ExecEvent = { seq?: number; type?: string; payload?: any }

export type ApplyFn = (evt: ExecEvent) => void

export class EventSync {
  /** 已应用到界面的最大事件 seq，回放时作为 after 游标 */
  lastSeq = 0
  private replaying = false
  private buffered: ExecEvent[] = []

  reset() {
    this.lastSeq = 0
    this.replaying = false
    this.buffered = []
  }

  get isReplaying() {
    return this.replaying
  }

  /** 开始一次回放（通常紧接着发 `?after=lastSeq` 请求） */
  beginReplay() {
    this.replaying = true
  }

  /** 实时事件入口：回放中先缓冲，回放结束后统一合并 */
  receive(evt: ExecEvent, apply: ApplyFn) {
    if (this.replaying) {
      this.buffered.push(evt)
      return
    }
    this.applyOne(evt, apply)
  }

  /** 应用回放拿到的事件（按服务端 seq 升序） */
  replay(events: ExecEvent[], apply: ApplyFn) {
    for (const evt of events) this.applyOne(evt, apply)
  }

  /** 结束回放：合并缓冲的实时事件，游标不回退 */
  endReplay(apply: ApplyFn) {
    this.replaying = false
    if (!this.buffered.length) return
    const list = this.buffered
    this.buffered = []
    // 缓冲里可能乱序（多条 socket 事件 + 回放并发），排序后再按游标过滤
    list.sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
    for (const evt of list) this.applyOne(evt, apply)
  }

  private applyOne(evt: ExecEvent, apply: ApplyFn) {
    if (typeof evt?.seq === 'number') {
      if (evt.seq <= this.lastSeq) return
      this.lastSeq = evt.seq
    }
    apply(evt)
  }
}
