import axios from 'axios'
import type { FlowDsl } from '../types/flow'

const http = axios.create({ baseURL: '/api', timeout: 30000 })

export const api = {
  // 流程
  listFlows: (type?: string): Promise<any[]> => http.get('/flows', { params: { type } }).then((r) => r.data),
  getFlow: (id: string): Promise<FlowDsl> => http.get(`/flows/${id}`).then((r) => r.data),
  createFlow: (dsl: Partial<FlowDsl>): Promise<FlowDsl> => http.post('/flows', dsl).then((r) => r.data),
  updateFlow: (id: string, dsl: FlowDsl): Promise<FlowDsl> => http.put(`/flows/${id}`, dsl).then((r) => r.data),
  deleteFlow: (id: string) => http.delete(`/flows/${id}`),

  // 执行
  runFlow: (id: string, variables?: Record<string, any>): Promise<{ executionId: string }> =>
    http.post(`/flows/${id}/run`, { variables }).then((r) => r.data),
  listExecutions: (flowId?: string): Promise<any[]> => http.get('/executions', { params: { flowId } }).then((r) => r.data),
  getExecution: (id: string): Promise<any> => http.get(`/executions/${id}`).then((r) => r.data),
  pauseExecution: (id: string) => http.post(`/executions/${id}/pause`),
  resumeExecution: (id: string) => http.post(`/executions/${id}/resume`),
  stopExecution: (id: string) => http.post(`/executions/${id}/stop`),
  confirmManual: (id: string, nodeId: string, pass: boolean, note: string) =>
    http.post(`/executions/${id}/manual`, { nodeId, pass, note }),

  // 导入
  importOpenApi: (spec: any, name?: string): Promise<{ flow: FlowDsl }> =>
    http.post('/import/openapi', { spec, name }).then((r) => r.data),
  importWhitebox: (data: any): Promise<{ flows: FlowDsl[] }> => http.post('/import/whitebox', data).then((r) => r.data),

  // Apifox MCP（直连拉取接口）
  apifoxGetConfig: (): Promise<any> => http.get('/apifox/config').then((r) => r.data),
  apifoxSaveConfig: (data: any): Promise<any> => http.post('/apifox/config', data).then((r) => r.data),
  apifoxTest: (data: any): Promise<any> =>
    http.post('/apifox/test', data, { timeout: 300000 }).then((r) => r.data),
  apifoxInterfaces: (data: any): Promise<any> =>
    http.post('/apifox/interfaces', data, { timeout: 600000 }).then((r) => r.data),
  apifoxCachedInterfaces: (): Promise<any> => http.get('/apifox/interfaces').then((r) => r.data),
  apifoxImport: (data: any): Promise<{ flows: FlowDsl[] }> =>
    http.post('/apifox/import', data, { timeout: 600000 }).then((r) => r.data),

  // 总览
  getStats: (): Promise<any> => http.get('/stats').then((r) => r.data),
}
