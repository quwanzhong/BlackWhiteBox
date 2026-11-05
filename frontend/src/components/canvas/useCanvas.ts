import { Graph } from '@antv/x6'
import { registerFlowNode } from './FlowNodeShape'
import type { FlowDsl } from '../../types/flow'

export function createGraph(container: HTMLElement, readonly = false): Graph {
  registerFlowNode()
  return new Graph({
    container,
    background: { color: '#f7f8fa' },
    grid: { visible: true, type: 'mesh', size: 20, args: { color: '#e4e7ed' } },
    panning: { enabled: true },
    mousewheel: { enabled: true, modifiers: null, minScale: 0.4, maxScale: 2 },
    interacting: readonly
      ? { nodeMovable: false, edgeMovable: false, nodeConnectable: false, edgeLabelMovable: false }
      : { nodeMovable: true, edgeMovable: false, nodeConnectable: false, edgeLabelMovable: false },
    connecting: {
      anchor: 'center',
      connectionPoint: 'anchor',
      allowBlank: false,
      allowLoop: false,
      allowMulti: false,
      highlight: true,
      connector: 'smooth',
      router: 'normal',
    },
  })
}

export function renderFlow(graph: Graph, flow: FlowDsl, statuses: Record<string, string> = {}) {
  graph.fromJSON({ cells: [] })
  for (const n of flow.nodes || []) {
    graph.addNode({
      shape: 'hbh-node',
      id: n.id,
      x: n.position?.x ?? 100,
      y: n.position?.y ?? 100,
      data: {
        name: n.name,
        method: n.action?.method,
        nodeType: n.action?.type,
        kind: n.kind,
        status: statuses[n.id] || 'pending',
      },
    })
  }
  for (const e of flow.edges || []) {
    graph.addEdge({
      shape: 'edge',
      id: e.id || `e_${e.from}_${e.to}`,
      source: { cell: e.from },
      target: { cell: e.to },
      attrs: {
        line: { stroke: '#c0c4cc', strokeWidth: 1.5, targetMarker: { name: 'block', size: 6 } },
      },
      labels: e.condition
        ? [{ attrs: { label: { text: e.condition, fill: '#909399', fontSize: 11 } } }]
        : [],
      zIndex: 0,
    })
  }
  if ((flow.nodes || []).length) graph.centerContent()
}

function findEdge(graph: Graph, from: string, to: string) {
  const cell = graph.getCellById(`e_${from}_${to}`)
  return cell && cell.isEdge() ? cell : null
}

/** 当前正在执行的边：蓝色流光（CSS stroke-dashoffset 动画） */
export function setEdgeActive(graph: Graph, from: string, to: string) {
  const edge = findEdge(graph, from, to)
  if (!edge) return
  edge.attr('line/style', {
    strokeDasharray: 6,
    animation: 'hbh-edge-flow 0.7s linear infinite',
  })
  edge.attr('line/stroke', '#409eff')
  edge.attr('line/strokeWidth', 2)
}

/** 边执行完成：通过绿色 / 失败红色 */
export function setEdgeResult(graph: Graph, from: string, to: string, status: 'passed' | 'failed') {
  const edge = findEdge(graph, from, to)
  if (!edge) return
  edge.attr('line/style', null)
  edge.attr('line/stroke', status === 'passed' ? '#67c23a' : '#f56c6c')
  edge.attr('line/strokeWidth', 2)
}

export function resetEdge(graph: Graph, from: string, to: string) {
  const edge = findEdge(graph, from, to)
  if (!edge) return
  edge.attr('line/style', null)
  edge.attr('line/stroke', '#c0c4cc')
  edge.attr('line/strokeWidth', 1.5)
}
