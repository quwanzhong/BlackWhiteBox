export type FlowType = 'blackbox' | 'whitebox'
export type NodeStatus = 'pending' | 'running' | 'waiting' | 'passed' | 'failed' | 'skipped'

export interface FlowCheck {
  type?: 'json_path' | 'body_contains'
  label?: string
  path?: string
  op?: string
  value?: any
}

export interface FlowAction {
  type: 'http' | 'manual'
  method?: string
  url?: string
  headers?: Record<string, any>
  body?: any
  timeout?: number
  hint?: string
}

export interface FlowNode {
  id: string
  name: string
  kind?: string
  action: FlowAction
  input?: any
  expected?: {
    status?: number
    checks?: FlowCheck[]
    maxDurationMs?: number
    manualNote?: string
  }
  extract?: Record<string, string>
  position?: { x: number; y: number }
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  condition?: string
}

export interface FlowDsl {
  id?: string
  name: string
  type: FlowType
  description?: string
  /** 所属项目（可选）：环境只能用于同项目或全局环境 */
  projectId?: string
  business?: string
  variables?: Record<string, any>
  nodes: FlowNode[]
  edges: FlowEdge[]
  createdAt?: number
  updatedAt?: number
}

export interface CheckResult {
  type: string
  label?: string
  path?: string
  op?: string
  value?: any
  actual?: any
  passed: boolean
  message: string
}

export interface StepResult {
  id: string
  nodeId: string
  nodeName: string
  status: NodeStatus
  durationMs?: number
  request?: any
  actual?: any
  expected?: any
  checks?: { matched: boolean; results: CheckResult[] }
  extracted?: Record<string, any>
  error?: string
}

export interface FlowSummary {
  status: 'passed' | 'failed' | 'stopped'
  total: number
  passed: number
  failed: number
  skipped: number
  matchedAll: boolean
  durationMs: number
  message: string
}
