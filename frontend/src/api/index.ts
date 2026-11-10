import axios from 'axios'
import type { FlowDsl } from '../types/flow'
import { getToken, resetToken } from '../security/token'

const http = axios.create({ baseURL: '/api', timeout: 30000 })

// S3：每个请求带令牌（后端由 index.html 注入，无需用户输入）
http.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let lastReload = 0
http.interceptors.response.use(
  (r) => r,
  (err) => {
    // 令牌失效（通常是后端重启换了令牌）：重新加载页面拿最新注入值，5 秒内只重载一次
    if (err?.response?.status === 401) {
      const now = Date.now()
      if (now - lastReload > 5000) {
        lastReload = now
        resetToken()
        window.location.reload()
      }
    }
    return Promise.reject(err)
  }
)

export const api = {
  // 流程
  listFlows: (type?: string): Promise<any[]> => http.get('/flows', { params: { type } }).then((r) => r.data),
  getFlow: (id: string): Promise<FlowDsl> => http.get(`/flows/${id}`).then((r) => r.data),
  createFlow: (dsl: Partial<FlowDsl>): Promise<FlowDsl> => http.post('/flows', dsl).then((r) => r.data),
  updateFlow: (id: string, dsl: FlowDsl): Promise<FlowDsl> => http.put(`/flows/${id}`, dsl).then((r) => r.data),
  deleteFlow: (id: string) => http.delete(`/flows/${id}`),

  // 执行（M2-1：可选环境；变量优先级 flow < 环境 < 这里的 variables < extract）
  runFlow: (
    id: string,
    payload: { variables?: Record<string, any>; environmentId?: string } = {}
  ): Promise<{ executionId: string }> => http.post(`/flows/${id}/run`, payload).then((r) => r.data),
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

  // 项目（前端工程 → Apifox 接口 → 源码扫描 → 业务功能 → 流程）
  listProjects: (): Promise<any[]> => http.get('/projects').then((r) => r.data),
  getProject: (id: string): Promise<any> => http.get(`/projects/${id}`).then((r) => r.data),
  createProject: (data: any): Promise<any> => http.post('/projects', data).then((r) => r.data),
  updateProject: (id: string, data: any): Promise<any> => http.put(`/projects/${id}`, data).then((r) => r.data),
  deleteProject: (id: string) => http.delete(`/projects/${id}`),
  fsRoots: (): Promise<any> => http.get('/fs/roots').then((r) => r.data),
  fsAddRoot: (path: string): Promise<any> => http.post('/fs/roots', { path }).then((r) => r.data),
  fsList: (path = ''): Promise<any> => http.get('/fs/list', { params: { path } }).then((r) => r.data),
  fsCheck: (path: string): Promise<any> => http.get('/fs/check', { params: { path } }).then((r) => r.data),
  projectPull: (id: string, data?: any): Promise<any> =>
    http.post(`/projects/${id}/pull`, data, { timeout: 600000 }).then((r) => r.data),
  projectAvailable: (id: string): Promise<any> => http.get(`/projects/${id}/available`).then((r) => r.data),
  projectBind: (id: string, ids: string[]): Promise<any> =>
    http.put(`/projects/${id}/interfaces`, { ids }).then((r) => r.data),
  projectScan: (id: string, data?: any): Promise<any> =>
    http.post(`/projects/${id}/scan`, data, { timeout: 300000 }).then((r) => r.data),
  projectMap: (id: string, data: any): Promise<any> =>
    http.post(`/projects/${id}/mapping`, data).then((r) => r.data),
  projectGenerate: (id: string, data?: any): Promise<{ flows: any[] }> =>
    http.post(`/projects/${id}/flows`, data).then((r) => r.data),
  projectFlows: (id: string): Promise<any[]> => http.get(`/projects/${id}/flows`).then((r) => r.data),

  // 环境（M2-1）：baseUrl + 普通变量 + 全局请求头 + 加密密钥（secrets 只回键名）
  listEnvironments: (projectId?: string): Promise<any[]> =>
    http.get('/environments', { params: { projectId } }).then((r) => r.data),
  getEnvironment: (id: string): Promise<any> => http.get(`/environments/${id}`).then((r) => r.data),
  createEnvironment: (data: any): Promise<any> => http.post('/environments', data).then((r) => r.data),
  updateEnvironment: (id: string, data: any): Promise<any> =>
    http.put(`/environments/${id}`, data).then((r) => r.data),
  deleteEnvironment: (id: string) => http.delete(`/environments/${id}`),
  resolveEnvironment: (id: string): Promise<any> => http.get(`/environments/${id}/resolve`).then((r) => r.data),
  setEnvironmentSecret: (id: string, key: string, value: string): Promise<any> =>
    http.put(`/environments/${id}/secrets/${encodeURIComponent(key)}`, { value }).then((r) => r.data),
  deleteEnvironmentSecret: (id: string, key: string): Promise<any> =>
    http.delete(`/environments/${id}/secrets/${encodeURIComponent(key)}`).then((r) => r.data),

  // 缺陷
  listBugs: (params?: any): Promise<any[]> => http.get('/bugs', { params }).then((r) => r.data),
  createBug: (data: any): Promise<any> => http.post('/bugs', data).then((r) => r.data),
  updateBug: (id: string, data: any): Promise<any> => http.put(`/bugs/${id}`, data).then((r) => r.data),
  deleteBug: (id: string) => http.delete(`/bugs/${id}`),

  // 总览
  getStats: (): Promise<any> => http.get('/stats').then((r) => r.data),
}
