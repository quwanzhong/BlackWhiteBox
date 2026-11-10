import { defineStore } from 'pinia'
import { io, type Socket } from 'socket.io-client'
import type { NodeStatus } from '../types/flow'
import { getToken } from '../security/token'
import { api } from '../api'
import { EventSync } from './event-sync'
import { mergeCoverageEvent } from '../utils/coverage'

let socket: Socket | null = null
let bound = false
/** 补洞/去重的内核（纯 TS，已在 frontend/test/event-sync.test.mjs 覆盖时序缺陷） */
const sync = new EventSync()
/** 回放请求进行中：并发 backfill 只跑一次，避免游标被两条路径交替推进 */
let syncing = false

export function getSocket(): Socket {
  if (!socket) {
    // S3：WebSocket 握手同样要令牌，否则任何页面都能订阅执行事件
    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token: getToken() },
    })
    socket.on('connect_error', (err) => {
      if (String(err?.message || '').includes('unauthorized')) {
        console.error('[ws] 未授权：令牌缺失或已失效，请刷新页面')
      }
    })
  }
  return socket
}

/**
 * 执行状态仓库：接收 WebSocket 推送，驱动画布发光动画与结果面板。
 */
export const useExecStore = defineStore('execution', {
  state: () => ({
    executionId: '',
    flowId: '',
    flowName: '',
    status: 'idle' as string, // idle | running | paused | passed | failed | stopped
    nodeStates: {} as Record<string, NodeStatus>,
    steps: {} as Record<string, any>,
    logs: [] as { time: number; level: string; message: string }[],
    summary: null as any,
    lastEvent: null as any,
    waitingNodeId: '',
    connected: false,
    // 本次执行的开始时间（服务端毫秒），用于画布上的实时耗时；回放/续跑时以事件里的 startedAt 为准
    startedAt: 0,
    // M3-3：按节点的覆盖率证据（投影，不含 exec_blob），画布徽标与面板共用
    coverage: [] as any[],
    coverageLoading: false,
  }),
  getters: {
    /** M3-3：节点 id → 覆盖率行（徽标直接查这里，没采到就是 undefined） */
    coverageByNode(state): Record<string, any> {
      const map: Record<string, any> = {}
      for (const row of state.coverage) map[row.nodeId] = row
      return map
    },
    /** M2-5：已应用到界面的最大事件 seq（回放游标），仅用于诊断/调试 */
    lastSeq: (): number => sync.lastSeq,
    replaying: (): boolean => sync.isReplaying,
    running(state): boolean {
      return ['running', 'paused'].includes(state.status)
    },
  },
  actions: {
    reset() {
      this.executionId = ''
      this.flowId = ''
      this.flowName = ''
      this.status = 'idle'
      this.nodeStates = {}
      this.steps = {}
      this.logs = []
      this.summary = null
      this.lastEvent = null
      this.waitingNodeId = ''
      this.startedAt = 0
      this.coverage = []
      this.coverageLoading = false
      sync.reset()
      syncing = false
    },
    async connect(executionId: string, flowName = '', flowId = '') {
      this.reset()
      this.executionId = executionId
      this.flowName = flowName
      this.flowId = flowId
      this.status = 'running'
      // 先用本地时间兜底，flow_start / flow_resume 到达后以服务端 startedAt 覆盖
      this.startedAt = Date.now()
      const s = getSocket()
      this.connected = s.connected
      if (!bound) {
        bound = true
        s.on('connect', () => {
          const store = useExecStore()
          const reconnected = store.lastSeq > 0 || store.connected
          store.connected = true
          if (store.executionId && reconnected) {
            // 重连同样「先进房间再补齐」：先 join 才不漏实时事件，缺口用回放补
            s.emit('join', { room: 'exec:' + store.executionId })
            store.backfill().catch(() => undefined)
          }
        })
        s.on('disconnect', () => {
          useExecStore().connected = false
        })
        s.on('exec_event', (evt: any) => {
          useExecStore().handleEvent(evt)
        })
      }
      // M2-5：先进房间，再回放历史（打开页面也能重建进行中的执行）。
      // 顺序很关键 —— 反过来会在「回放完成 → join 成功」之间丢事件，界面永久停在旧状态
      // （现场故障：等待人工确认的 manual_wait 落在这条缝里，界面一直显示执行中）。
      s.emit('join', { room: 'exec:' + executionId })
      await this.backfill().catch(() => undefined)
      // M3-3：画布徽标/覆盖率面板需要历史投影（刷新后也能看到上次分析结果）
      this.loadCoverage()
    },
    /** M3-3：直接注入覆盖率投影（报告页静态回放用，不依赖实时通道） */
    setCoverage(data: any) {
      this.coverage = Array.isArray(data?.coverage) ? data.coverage : []
    },
    /** M3-3：拉取本次执行的覆盖率投影；覆盖率是旁路信息，失败不影响执行视图 */
    async loadCoverage() {
      const id = this.executionId
      if (!id) return
      this.coverageLoading = true
      try {
        const data = await api.getExecutionCoverage(id)
        // 等待期间可能已切到另一次执行：旧响应不能盖上来
        if (this.executionId === id) this.setCoverage(data)
      } catch {
        // 忽略：徽标保持现状，面板里仍可重试
      } finally {
        if (this.executionId === id) this.coverageLoading = false
      }
    },
    /** M2-5：按 lastSeq 向后端补齐事件（全量回放用 after=0）；并发调用只跑一次 */
    async backfill() {
      if (!this.executionId || syncing) return
      syncing = true
      sync.beginReplay()
      try {
        const data = await api.getExecutionEvents(this.executionId, sync.lastSeq)
        sync.replay(data.events || [], (evt) => this.applyEvent(evt))
      } finally {
        // 回放期间缓冲的实时事件在这里合并（排序 + seq 去重），不会丢帧
        sync.endReplay((evt) => this.applyEvent(evt))
        syncing = false
      }
    },
    handleEvent(evt: any) {
      // 回放中先缓冲，避免实时事件与回放互相推进游标导致丢帧
      sync.receive(evt, (e) => this.applyEvent(e))
    },
    /** 落库事件 → 界面状态（游标与去重已由 EventSync 处理） */
    applyEvent(evt: any) {
      this.lastEvent = evt
      const p = evt.payload || {}
      switch (evt.type) {
        case 'flow_start':
          this.flowId = p.flowId || this.flowId
          this.flowName = p.flowName || this.flowName
          if (Number.isFinite(p.startedAt)) this.startedAt = p.startedAt
          for (const n of p.nodes || []) this.nodeStates[n.id] = 'pending'
          this.status = 'running'
          break
        case 'step_start':
          this.nodeStates[p.nodeId] = 'running'
          break
        case 'manual_wait':
          this.nodeStates[p.nodeId] = 'waiting'
          this.waitingNodeId = p.nodeId
          break
        case 'step_end':
          this.nodeStates[p.nodeId] = p.status
          if (this.waitingNodeId === p.nodeId) this.waitingNodeId = ''
          this.steps[p.nodeId] = p
          break
        case 'log':
          this.logs.push({ time: evt.ts, level: p.level || 'info', message: p.message })
          if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600)
          break
        case 'paused':
          this.status = 'paused'
          break
        case 'resumed':
          this.status = 'running'
          break
        case 'flow_resume':
          // M2-5：会话换进程续跑（历史事件已在回放里重建画布，只同步状态）
          if (!p.paused) this.status = 'running'
          // 续跑要接着原来的总耗时算，不能从 0 重新计时
          if (Number.isFinite(p.startedAt)) this.startedAt = p.startedAt
          break
        case 'stopped':
          this.status = 'stopped'
          break
        case 'flow_end':
          this.status = p.status
          this.summary = p.summary
          this.waitingNodeId = ''
          break
        // M3-3：取证完成先亮「待分析」，分析完成后重拉一次投影拿到行数据
        case 'coverage.dump':
          this.coverage = mergeCoverageEvent(this.coverage, evt)
          break
        case 'coverage.analyzed':
          this.loadCoverage()
          break
      }
    },
    leaveRoom() {
      if (socket && this.executionId) socket.emit('leave', { room: 'exec:' + this.executionId })
    },
  },
})
