import { defineStore } from 'pinia'
import { io, type Socket } from 'socket.io-client'
import type { NodeStatus } from '../types/flow'
import { getToken } from '../security/token'
import { api } from '../api'

let socket: Socket | null = null
let bound = false

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
    // M2-5：已应用到画布的最大事件 seq，用于去重与断线补洞
    lastSeq: 0,
    replaying: false,
  }),
  getters: {
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
      this.lastSeq = 0
    },
    async connect(executionId: string, flowName = '', flowId = '') {
      this.reset()
      this.executionId = executionId
      this.flowName = flowName
      this.flowId = flowId
      this.status = 'running'
      const s = getSocket()
      this.connected = s.connected
      if (!bound) {
        bound = true
        s.on('connect', () => {
          const store = useExecStore()
          // M2-5：断线重连 —— 先把缺口补齐（after=lastSeq），再重新进房间继续收实时事件
          const reconnected = store.lastSeq > 0 || store.connected
          store.connected = true
          if (store.executionId && reconnected) {
            store
              .backfill()
              .catch(() => undefined)
              .then(() => s.emit('join', { room: 'exec:' + store.executionId }))
          }
        })
        s.on('disconnect', () => {
          useExecStore().connected = false
        })
        s.on('exec_event', (evt: any) => {
          useExecStore().handleEvent(evt)
        })
      }
      // M2-5：先回放历史（打开页面也能重建进行中的执行），后进房间 ——
      // 房间内只可能收到「回放最后一条之后」的新事件，与回放重叠的部分由 seq 去重兜底
      await this.backfill().catch(() => undefined)
      s.emit('join', { room: 'exec:' + executionId })
    },
    /** M2-5：按 lastSeq 向后端补齐事件（全量回放用 after=0） */
    async backfill() {
      if (!this.executionId) return
      this.replaying = true
      try {
        const data = await api.getExecutionEvents(this.executionId, this.lastSeq)
        for (const evt of data.events || []) this.handleEvent(evt)
      } finally {
        this.replaying = false
      }
    },
    handleEvent(evt: any) {
      // M2-5：seq 去重 —— WS 与回放可能重叠，seq <= lastSeq 的一律丢弃
      if (typeof evt?.seq === 'number') {
        if (evt.seq <= this.lastSeq) return
        this.lastSeq = evt.seq
      }
      this.lastEvent = evt
      const p = evt.payload || {}
      switch (evt.type) {
        case 'flow_start':
          this.flowId = p.flowId || this.flowId
          this.flowName = p.flowName || this.flowName
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
          break
        case 'stopped':
          this.status = 'stopped'
          break
        case 'flow_end':
          this.status = p.status
          this.summary = p.summary
          this.waitingNodeId = ''
          break
      }
    },
    leaveRoom() {
      if (socket && this.executionId) socket.emit('leave', { room: 'exec:' + this.executionId })
    },
  },
})
