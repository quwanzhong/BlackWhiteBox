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
import CoveragePanel from '../components/CoveragePanel.vue'
import { fmtPct, summarizeCoverage } from '../utils/coverage'
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
/** 执行环境（M2-1）：同项目环境 + 全局环境；选择结果按流程记忆 */
const environments = ref<any[]>([])
const environmentId = ref('')

const ENV_STORAGE_PREFIX = 'heibaihe.env.'

let graph: any = null
let clockTimer: number | undefined
let reconcileTimer: number | undefined

const running = computed(() => exec.running && exec.flowId === flow.value?.id)

/** 当前画布是否正对应这次执行（用于状态条上的耗时/阶段，避免串场） */
const sameFlow = computed(() => !!exec.executionId && exec.flowId === flow.value?.id)

/** 500ms 心跳：只驱动耗时文本，不触发其它计算 */
const now = ref(Date.now())

/** 执行阶段：等待人工确认要单独成态，否则界面看起来像卡住 */
const execPhase = computed<'running' | 'paused' | 'waiting' | ''>(() => {
  if (!running.value) return ''
  if (exec.waitingNodeId) return 'waiting'
  if (exec.status === 'paused') return 'paused'
  return 'running'
})

const waitingNodeName = computed(() => {
  if (!exec.waitingNodeId) return ''
  return flow.value?.nodes.find((n) => n.id === exec.waitingNodeId)?.name || exec.waitingNodeId
})

const elapsedMs = computed(() => {
  if (!sameFlow.value) return 0
  // 结束后用服务端统计的总耗时，避免前端时钟误差
  if (!running.value && Number.isFinite(exec.summary?.durationMs)) return exec.summary.durationMs
  if (!exec.startedAt) return 0
  return Math.max(0, now.value - exec.startedAt)
})

const elapsedText = computed(() => {
  const total = elapsedMs.value / 1000
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${String(Math.floor(total % 60)).padStart(2, '0')}s`
})

const phaseText = computed(() => {
  if (execPhase.value === 'waiting') return '等待人工确认'
  if (execPhase.value === 'paused') return '已暂停'
  if (execPhase.value === 'running') return '执行中'
  if (!sameFlow.value || !exec.summary) return ''
  const finished: Record<string, string> = { passed: '已通过', failed: '未通过', stopped: '已停止' }
  return finished[exec.summary.status as string] || '已结束'
})

const phaseTone = computed(() => {
  if (execPhase.value) return execPhase.value
  if (exec.summary?.status === 'passed') return 'passed'
  if (exec.summary?.status === 'failed') return 'failed'
  return 'done'
})

// 进入人工确认时自动选中该节点，右侧直接出现「通过 / 不通过」按钮
watch(
  () => exec.waitingNodeId,
  (id) => {
    if (id && exec.flowId === flow.value?.id) selectedId.value = id
  }
)

async function loadEnvironments(target: FlowDsl) {
  try {
    const all = await api.listEnvironments()
    environments.value = all.filter((env) => !env.projectId || env.projectId === target.projectId)
    const saved = target.id ? localStorage.getItem(`${ENV_STORAGE_PREFIX}${target.id}`) : ''
    if (saved && environments.value.some((env) => env.id === saved)) environmentId.value = saved
  } catch {
    environments.value = []
  }
}

function selectEnvironment(id: string) {
  environmentId.value = id
  if (!flow.value?.id) return
  const key = `${ENV_STORAGE_PREFIX}${flow.value.id}`
  if (id) localStorage.setItem(key, id)
  else localStorage.removeItem(key)
}

onMounted(async () => {
  clockTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
  // 兜底对账：实时通道丢帧（断线/重连/竞态）时按 lastSeq 补齐，
  // 保证界面不会永久停在「执行中」，也不会漏掉「等待人工确认」这类关键状态
  reconcileTimer = window.setInterval(() => {
    if (running.value) exec.backfill().catch(() => undefined)
  }, 4000)
  try {
    flow.value = await api.getFlow(route.params.id as string)
  } catch {
    ElMessage.error('流程不存在')
    router.replace('/flows')
    return
  }
  // 若上次执行属于其它流程，清空执行视图，避免状态串场
  if (!exec.running && exec.flowId !== flow.value.id) exec.reset()
  // 刷新/重新进入画布时接上进行中的执行：否则用户以为「刚才那次执行丢了」，
  // 也看不到耗时和「等待人工确认」（本次故障的第二个诱因）
  if (!exec.running) await attachRunningExecution()

  await loadEnvironments(flow.value)
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
  if (clockTimer) window.clearInterval(clockTimer)
  if (reconcileTimer) window.clearInterval(reconcileTimer)
  try { graph?.dispose() } catch { /* ignore */ }
  graph = null
})

const selectedNode = computed(() => flow.value?.nodes.find((n) => n.id === selectedId.value) || null)
const selectedStep = computed(() => (selectedId.value ? exec.steps[selectedId.value] : null))

// ---------- M3-3 覆盖率面板：节点徽标 + 未覆盖行/源码 ----------
const coverageVisible = ref(false)
const coverageNodeId = ref('')
const coverageRow = computed(() => (coverageNodeId.value ? exec.coverageByNode[coverageNodeId.value] : null))
const coverageSummary = computed(() => summarizeCoverage(exec.coverage || []))
const coverageNodeName = computed(
  () => flow.value?.nodes.find((n) => n.id === coverageNodeId.value)?.name || coverageNodeId.value
)

/** 打开覆盖率面板：优先指定节点 → 当前选中节点 → 第一个有证据的节点 */
function openCoverage(nodeId?: string) {
  const candidates = [nodeId, selectedId.value, exec.coverage[0]?.nodeId]
  const id = candidates.find((value) => value && exec.coverageByNode[value])
  if (!id) {
    ElMessage.info('本次执行没有覆盖率证据（环境需开启 settings.coverage）')
    return
  }
  coverageNodeId.value = id
  coverageVisible.value = true
}

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
    const { executionId } = await api.runFlow(flow.value.id!, {
      environmentId: environmentId.value || undefined,
    })
    exec.connect(executionId, flow.value.name, flow.value.id!)
    summaryVisible.value = false
    selectedId.value = ''
    ElMessage.success('开始执行，注意画布上的发光节点')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '启动执行失败')
  }
}

/**
 * 接上进行中的执行：页面刷新 / 从别的页面回到画布时，把实时通道接回同一次执行，
 * 这样状态条上的耗时会接着走、等待人工确认也能继续操作。
 */
async function attachRunningExecution() {
  if (!flow.value?.id) return
  try {
    const list = await api.listExecutions({ flowId: flow.value.id })
    const live = (list || []).find((e: any) => e.status === 'running' || e.status === 'paused')
    if (!live) return
    await exec.connect(live.id, live.flowName || flow.value.name, flow.value.id)
    ElMessage.info(`已接上进行中的执行 ${String(live.id).slice(0, 8)}`)
  } catch {
    // 接不上不影响手动执行
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
        <el-select
          v-model="environmentId"
          class="env-select"
          clearable
          placeholder="不使用环境"
          @change="selectEnvironment"
        >
          <el-option
            v-for="env in environments"
            :key="env.id"
            :label="env.name"
            :value="env.id"
          >
            <span>{{ env.name }}</span>
            <span class="env-option-url">{{ env.baseUrl || '未设置 baseUrl' }}</span>
          </el-option>
        </el-select>
        <el-button text size="small" @click="router.push('/environments')">管理</el-button>
        <el-button type="success" :disabled="running" :loading="running" @click="runFlow">
          {{ running ? '执行中' : '▶ 执行流程' }}
        </el-button>
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
      <span v-if="sameFlow && phaseText" class="phase" :class="'phase-' + phaseTone">
        <i class="phase-dot" />{{ phaseText }}
      </span>
      <span v-if="sameFlow" class="elapsed" :class="{ live: running }">
        {{ running ? '已执行' : '总耗时' }} <b>{{ elapsedText }}</b>
      </span>
      <span v-if="exec.executionId && exec.flowId === flow.id" class="exec-id">
        本次执行：{{ exec.executionId.slice(0, 8) }}
      </span>
      <el-button
        v-if="sameFlow && coverageSummary.total"
        size="small"
        type="primary"
        link
        title="查看每个节点命中的行、未覆盖行与源码"
        @click="openCoverage()"
      >
        覆盖率 {{ fmtPct(coverageSummary.lineRate) }}
        <span class="muted" style="margin-left: 4px">
          {{ coverageSummary.covered }}/{{ coverageSummary.statLines }} 行 ·
          {{ coverageSummary.analyzed }}/{{ coverageSummary.total }} 节点已分析
        </span>
      </el-button>
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

    <div v-if="sameFlow && exec.waitingNodeId" class="fp-waiting-bar">
      <span class="waiting-icon">⏳</span>
      <span>正在等待人工确认：<b>{{ waitingNodeName }}</b></span>
      <span class="waiting-tip">请在右侧「步骤详情」点击「通过 / 不通过」，等待时间也计入总耗时</span>
      <el-button size="small" type="warning" plain @click="selectedId = exec.waitingNodeId">
        定位节点
      </el-button>
    </div>

    <div class="fp-body">
      <div ref="container" class="fp-canvas" />
      <aside class="fp-side">
        <StepDetailPanel
          :node="selectedNode"
          :step="selectedStep"
          :waiting="exec.waitingNodeId === selectedId"
          :coverage="selectedId ? exec.coverageByNode[selectedId] : null"
          @edit="openEditNode"
          @remove="removeNode"
          @confirm-manual="confirmManual"
          @coverage="openCoverage(selectedId)"
        />
        <ConsolePanel :logs="exec.logs" />
      </aside>
    </div>

    <NodeEditDrawer v-model="drawerVisible" :node="editingNode" @confirm="applyNode" />

    <CoveragePanel
      v-model="coverageVisible"
      :execution-id="exec.executionId"
      :row="coverageRow"
      :node-name="coverageNodeName"
    />

    <el-dialog v-model="summaryVisible" title="流程执行结果" width="820px" top="5vh">
      <ResultSummary :summary="exec.summary" :flow="flow" :steps="exec.steps" />
    </el-dialog>
  </div>
</template>
