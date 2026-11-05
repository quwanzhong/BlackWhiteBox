<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { useExecStore } from '../stores/execution'
import {
  createGraph,
  renderFlow,
  resetEdge,
  setEdgeActive,
  setEdgeResult,
} from '../components/canvas/useCanvas'
import StepDetailPanel from '../components/StepDetailPanel.vue'
import ConsolePanel from '../components/ConsolePanel.vue'
import NodeEditDrawer from '../components/NodeEditDrawer.vue'
import ResultSummary from '../components/ResultSummary.vue'
import type { FlowDsl, FlowNode } from '../types/flow'

const route = useRoute()
const router = useRouter()
const exec = useExecStore()

const flow = ref<FlowDsl | null>(null)
const selectedId = ref('')
const container = ref<HTMLElement>()
const drawerVisible = ref(false)
const editingNode = ref<any>(null)
const summaryVisible = ref(false)

let graph: any = null
let disposed = false

const running = computed(() => exec.running && exec.flowId === flow.value?.id)

onMounted(async () => {
  try {
    flow.value = await api.getFlow(route.params.id as string)
  } catch {
    ElMessage.error('流程不存在')
    router.replace('/flows')
    return
  }
  // 若上次执行属于其它流程，清空执行视图，避免状态串场
  if (!exec.running && exec.flowId !== flow.value.id) exec.reset()

  await nextTick()
  graph = createGraph(container.value!)
  renderFlow(graph, flow.value)
  graph.on('node:click', ({ node }: any) => {
    selectedId.value = node.id
  })
  graph.on('blank:click', () => {
    selectedId.value = ''
  })
  graph.on('edge:click', ({ edge }: any) => editCondition(edge))

  // 从列表页点「执行」进来时自动开始执行
  if (route.query.run === '1') {
    router.replace({ path: `/flows/${route.params.id}` })
    setTimeout(() => runFlow(), 300)
  }
})

onBeforeUnmount(() => {
  disposed = true
  try { graph?.dispose() } catch { /* ignore */ }
  graph = null
})

const selectedNode = computed(() => flow.value?.nodes.find((n) => n.id === selectedId.value) || null)
const selectedStep = computed(() => (selectedId.value ? exec.steps[selectedId.value] : null))

function syncPositions() {
  if (!graph || !flow.value) return
  for (const n of flow.value.nodes) {
    const cell = graph.getCellById(n.id)
    if (cell) {
      const p = cell.getPosition()
      n.position = { x: Math.round(p.x), y: Math.round(p.y) }
    }
  }
}

async function save(silent = false) {
  if (!flow.value) return
  syncPositions()
  await api.updateFlow(flow.value.id!, flow.value)
  if (!silent) ElMessage.success('已保存')
}

async function runFlow() {
  if (!flow.value?.nodes?.length) {
    ElMessage.warning('流程没有节点，请先添加节点')
    return
  }
  await save(true)
  try {
    const { executionId } = await api.runFlow(flow.value.id!)
    exec.connect(executionId, flow.value.name, flow.value.id!)
    summaryVisible.value = false
    selectedId.value = ''
    ElMessage.success('开始执行，注意画布上的发光节点')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '启动执行失败')
  }
}

async function togglePause() {
  try {
    if (exec.status === 'paused') await api.resumeExecution(exec.executionId)
    else await api.pauseExecution(exec.executionId)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '操作失败')
  }
}

async function stopRun() {
  try {
    await api.stopExecution(exec.executionId)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '操作失败')
  }
}

async function confirmManual(pass: boolean, note: string) {
  try {
    await api.confirmManual(exec.executionId, exec.waitingNodeId, pass, note)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '提交失败')
  }
}

function findIncomingEdge(nodeId: string) {
  return flow.value?.edges.find((e) => e.to === nodeId)
}

// 执行事件 → 画布动画
watch(
  () => exec.lastEvent,
  (evt: any) => {
    if (!evt || !graph || !flow.value) return
    const p = evt.payload || {}
    if (evt.type === 'step_start') {
      const e = findIncomingEdge(p.nodeId)
      if (e) setEdgeActive(graph, e.from, e.to)
    }
    if (evt.type === 'step_end') {
      const e = findIncomingEdge(p.nodeId)
      if (e) {
        if (p.status === 'passed' || p.status === 'failed') setEdgeResult(graph, e.from, e.to, p.status)
        else resetEdge(graph, e.from, e.to)
      }
    }
    if (evt.type === 'flow_end') summaryVisible.value = true
  }
)

async function editCondition(edge: any) {
  const e = flow.value?.edges.find((x) => x.id === edge.id)
  if (!e) return
  try {
    const { value } = await ElMessageBox.prompt(
      '流转条件，留空表示无条件流转；支持 $.code == 0 这类表达式（$ 代表上一个节点的响应数据）',
      '编辑流转条件',
      { inputValue: e.condition || '', confirmButtonText: '保存', cancelButtonText: '取消' }
    )
    e.condition = value || ''
    renderFlow(graph, flow.value!)
    ElMessage.success('条件已更新（记得点击保存）')
  } catch { /* 取消 */ }
}

function openAddNode() {
  const nodes = flow.value?.nodes || []
  const last = nodes[nodes.length - 1]
  editingNode.value = {
    id: `n_${Date.now()}`,
    name: '',
    action: {
      type: 'http',
      method: 'GET',
      url: '',
      headers: { 'Content-Type': 'application/json' },
      body: null,
      timeout: 15000,
    },
    expected: { status: 200, checks: [] },
    extract: {},
    position: last
      ? { x: (last.position?.x || 80) + 300, y: last.position?.y || 160 }
      : { x: 80, y: 160 },
  }
  drawerVisible.value = true
}

function openEditNode() {
  if (!selectedNode.value) return
  editingNode.value = JSON.parse(JSON.stringify(selectedNode.value))
  drawerVisible.value = true
}

function applyNode(node: FlowNode) {
  if (!flow.value) return
  const idx = flow.value.nodes.findIndex((n) => n.id === node.id)
  if (idx >= 0) flow.value.nodes[idx] = node
  else flow.value.nodes.push(node)
  selectedId.value = node.id
  renderFlow(graph, flow.value)
  drawerVisible.value = false
  ElMessage.success('节点已更新（记得点击保存）')
}

async function removeNode() {
  if (!selectedNode.value) return
  flow.value!.nodes = flow.value!.nodes.filter((n) => n.id !== selectedId.value)
  flow.value!.edges = flow.value!.edges.filter(
    (e) => e.from !== selectedId.value && e.to !== selectedId.value
  )
  selectedId.value = ''
  renderFlow(graph, flow.value!)
  ElMessage.success('节点已删除（记得点击保存）')
}
</script>

<template>
  <div v-if="flow" class="flow-page">
    <div class="fp-header">
      <div class="fp-title">
        <el-tag :type="flow.type === 'blackbox' ? 'primary' : 'warning'" effect="dark" size="small">
          {{ flow.type === 'blackbox' ? '⬛ 黑盒' : '⬜ 白盒' }}
        </el-tag>
        <el-input v-model="flow.name" class="flow-name-input" />
      </div>
      <div class="fp-actions">
        <el-button @click="router.push('/flows')">返回列表</el-button>
        <el-button @click="openAddNode">＋ 添加节点</el-button>
        <el-button type="primary" plain @click="save()">保存</el-button>
        <el-divider direction="vertical" />
        <el-button type="success" :disabled="running" @click="runFlow">▶ 执行流程</el-button>
        <el-button v-if="exec.status === 'paused'" type="warning" @click="togglePause">继续</el-button>
        <el-button v-else :disabled="!running" @click="togglePause">暂停</el-button>
        <el-button type="danger" :disabled="!running" @click="stopRun">停止</el-button>
      </div>
    </div>

    <div class="fp-statusbar">
      <span class="legend"><i class="lg lg-running" />执行中</span>
      <span class="legend"><i class="lg lg-passed" />通过</span>
      <span class="legend"><i class="lg lg-failed" />失败</span>
      <span class="legend"><i class="lg lg-waiting" />等待人工确认</span>
      <span class="legend"><i class="lg lg-skipped" />跳过</span>
      <span v-if="exec.executionId && exec.flowId === flow.id" class="exec-id">
        本次执行：{{ exec.executionId.slice(0, 8) }}
      </span>
      <span v-if="exec.connected && running" class="conn on">● 实时通道已连接</span>
      <span v-else-if="running" class="conn">○ 实时通道连接中…</span>
      <el-button
        v-if="exec.summary && exec.flowId === flow.id"
        size="small"
        type="primary"
        link
        @click="summaryVisible = true"
      >
        查看结果汇总
      </el-button>
      <span class="muted" style="margin-left: auto">拖拽节点调整位置；点击连线编辑流转条件；改动后记得保存</span>
    </div>

    <div class="fp-body">
      <div ref="container" class="fp-canvas" />
      <aside class="fp-side">
        <StepDetailPanel
          :node="selectedNode"
          :step="selectedStep"
          :waiting="exec.waitingNodeId === selectedId"
          @edit="openEditNode"
          @remove="removeNode"
          @confirm-manual="confirmManual"
        />
        <ConsolePanel :logs="exec.logs" />
      </aside>
    </div>

    <NodeEditDrawer v-model="drawerVisible" :node="editingNode" @confirm="applyNode" />

    <el-dialog v-model="summaryVisible" title="流程执行结果" width="820px" top="5vh">
      <ResultSummary :summary="exec.summary" :flow="flow" :steps="exec.steps" />
    </el-dialog>
  </div>
</template>
