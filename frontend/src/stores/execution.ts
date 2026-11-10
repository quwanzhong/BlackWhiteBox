import { defineStore } from 'pinia'
import { io, type Socket } from 'socket.io-client'
import type { NodeStatus } from '../types/flow'
import { getToken } from '../security/token'

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
    },
    connect(executionId: string, flowName = '', flowId = '') {
      this.reset()
      this.executionId = executionId
      this.flowName = flowName
      this.flowId = flowId
      this.status = 'running'
      const s = getSocket()
      this.connected = s.connected
      s.emit('join', { room: 'exec:' + executionId })
      if (!bound) {
        bound = true
        s.on('connect', () => {
          useExecStore().connected = true
        })
        s.on('disconnect', () => {
          useExecStore().connected = false
        })
        s.on('exec_event', (evt: any) => {
          useExecStore().handleEvent(evt)
        })
      }
    },
    handleEvent(evt: any) {
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
