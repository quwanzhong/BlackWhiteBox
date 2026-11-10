<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { getSocket } from '../stores/execution'

/**
 * 套件（M2-2）：把「23 条流程只能一条条跑」变成一次有策略的批量执行。
 *  - 定义：有序流程列表 + 并发/重试/failFast + 默认环境；
 *  - 执行：后端进程内队列限流，WebSocket 推 suite_event，这里同时保留轮询兜底；
 *  - 证据：每条流程仍是独立 execution，套件执行只做关联与汇总。
 */
const suites = ref<any[]>([])
const flows = ref<any[]>([])
const projects = ref<any[]>([])
const environments = ref<any[]>([])
const loading = ref(false)
const projectFilter = ref('')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = reactive({ name: '', projectId: '', environmentId: '', description: '' })
const selectedFlowIds = ref<string[]>([])
const strategy = reactive({ concurrency: 3, retry: 0, retryDelayMs: 500, failFast: false })

const runVisible = ref(false)
const runLoading = ref(false)
const runId = ref('')
const currentRun = ref<any>(null)
const startingId = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let socketHandler: ((evt: any) => void) | null = null

const historyVisible = ref(false)
const historySuite = ref<any>(null)
const historyRuns = ref<any[]>([])

async function load() {
  loading.value = true
  try {
    suites.value = await api.listSuites(projectFilter.value || undefined)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '加载套件失败')
  } finally {
    loading.value = false
  }
}

async function loadMeta() {
  try {
    projects.value = await api.listProjects()
  } catch {
    projects.value = []
  }
  try {
    environments.value = await api.listEnvironments()
  } catch {
    environments.value = []
  }
}

onMounted(async () => {
  await Promise.all([load(), loadMeta()])
  try {
    flows.value = await api.listFlows()
  } catch {
    flows.value = []
  }
})

onUnmounted(() => {
  stopWatching()
  leaveRoom()
})

const projectName = (id?: string | null) =>
  id ? projects.value.find((p) => p.id === id)?.name || id.slice(0, 8) : '全局'

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')

const fmtDuration = (ms?: number) => {
  if (ms == null) return '-'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** 套件只允许「本项目流程 + 全局流程」，与后端校验同口径 */
const flowOptions = computed(() => {
  const pid = form.projectId
  return flows.value.filter((f) => !pid || !f.projectId || f.projectId === pid)
})

const envOptions = computed(() => {
  const pid = form.projectId
  return environments.value.filter((e) => !pid || !e.projectId || e.projectId === pid)
})

const orderedFlows = computed(() =>
  selectedFlowIds.value.map((id, index) => ({
    index: index + 1,
    id,
    name: flows.value.find((f) => f.id === id)?.name || id.slice(0, 8),
  }))
)

function statusType(status?: string) {
  return (
    {
      passed: 'success',
      failed: 'danger',
      stopped: 'info',
      running: 'primary',
      queued: 'warning',
      skipped: 'info',
      pending: 'info',
    } as Record<string, string>
  )[status || ''] || 'info'
}

function statusText(status?: string) {
  return (
    {
      passed: '通过',
      failed: '失败',
      stopped: '已停止',
      running: '执行中',
      queued: '排队中',
      skipped: '已跳过',
      pending: '待执行',
    } as Record<string, string>
  )[status || ''] || status || '-'
}

function openCreate() {
  editingId.value = null
  form.name = ''
  form.projectId = projectFilter.value || ''
  form.environmentId = ''
  form.description = ''
  selectedFlowIds.value = []
  Object.assign(strategy, { concurrency: 3, retry: 0, retryDelayMs: 500, failFast: false })
  dialogVisible.value = true
}

function openEdit(row: any) {
  editingId.value = row.id
  form.name = row.name
  form.projectId = row.projectId || ''
  form.environmentId = row.environmentId || ''
  form.description = row.description || ''
  selectedFlowIds.value = [...(row.flowIds || [])]
  Object.assign(strategy, {
    concurrency: row.strategy?.concurrency ?? 3,
    retry: row.strategy?.retry ?? 0,
    retryDelayMs: row.strategy?.retryDelayMs ?? 500,
    failFast: !!row.strategy?.failFast,
  })
  dialogVisible.value = true
}

async function save() {
  if (!form.name.trim()) return ElMessage.warning('请填写套件名称')
  if (!selectedFlowIds.value.length) return ElMessage.warning('至少选择一条流程')
  const payload = {
    name: form.name.trim(),
    projectId: form.projectId || null,
    environmentId: form.environmentId || null,
    description: form.description.trim(),
    flowIds: selectedFlowIds.value,
    strategy: { ...strategy },
  }
  saving.value = true
  try {
    if (editingId.value) await api.updateSuite(editingId.value, payload)
    else await api.createSuite(payload)
    dialogVisible.value = false
    ElMessage.success(editingId.value ? '套件已更新' : '套件已创建')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(row: any) {
  try {
    await ElMessageBox.confirm(
      `确认删除套件「${row.name}」？套件的执行历史会一并删除，但每条流程的 execution 记录会保留。`,
      '删除套件',
      { type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await api.deleteSuite(row.id)
    ElMessage.success('已删除')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

async function runSuite(row: any) {
  startingId.value = row.id
  try {
    const res = await api.runSuite(row.id)
    ElMessage.success('套件已开始执行')
    openRun(res.suiteRunId, res.suiteRun)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '启动失败')
  } finally {
    startingId.value = ''
  }
}

function stopWatching() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (socketHandler) {
    getSocket().off('suite_event', socketHandler)
    socketHandler = null
  }
}

function leaveRoom() {
  if (runId.value) getSocket().emit('leave', { room: `suite:${runId.value}` })
}

function isTerminal(run: any) {
  return ['passed', 'failed', 'stopped'].includes(run?.status)
}

async function refreshRun() {
  if (!runId.value) return
  try {
    currentRun.value = await api.getSuiteRun(runId.value)
    if (isTerminal(currentRun.value)) {
      stopWatching()
      leaveRoom()
      load()
    }
  } catch (err: any) {
    if (err?.response?.status === 404) stopWatching()
  }
}

/** 打开执行详情：先拉一次快照，再接套件房间的实时事件（轮询兜底） */
function openRun(id: string, initial?: any) {
  stopWatching()
  leaveRoom()
  runId.value = id
  currentRun.value = initial || null
  runVisible.value = true
  if (!initial) refreshRun()
  if (!isTerminal(initial)) {
    const socket = getSocket()
    socket.emit('join', { room: `suite:${id}` })
    socketHandler = (evt: any) => {
      if (evt?.suiteRunId !== id) return
      if (['suite_start', 'suite_progress', 'suite_flow_start', 'suite_flow_retry', 'suite_flow_end', 'suite_end'].includes(evt.type)) {
        refreshRun()
      }
    }
    socket.on('suite_event', socketHandler)
    pollTimer = setInterval(refreshRun, 1200)
  }
}

function closeRun() {
  runVisible.value = false
  stopWatching()
  leaveRoom()
}

async function stopRun() {
  if (!runId.value) return
  try {
    await api.stopSuiteRun(runId.value)
    ElMessage.success('已发送停止信号')
    await refreshRun()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '停止失败')
  }
}

async function openHistory(row: any) {
  historySuite.value = row
  historyVisible.value = true
  try {
    historyRuns.value = await api.listSuiteRuns({ suiteId: row.id, limit: 20 })
  } catch (err: any) {
    historyRuns.value = []
    ElMessage.error(err?.response?.data?.error || '加载执行历史失败')
  }
}

const runPercent = computed(() => {
  const s = currentRun.value?.summary
  if (s?.percent != null) return s.percent
  if (currentRun.value?.status === 'passed' || currentRun.value?.status === 'failed') return 100
  return 0
})

const runActive = computed(() => !!currentRun.value && !isTerminal(currentRun.value))

const runFlows = computed(() => currentRun.value?.summary?.flows || [])
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">套件执行</div>
        <div class="page-sub">
          套件 = 有序流程列表 + 执行策略。一次操作并发跑完一批流程，失败可重试、可 failFast、可随时停止。
        </div>
      </div>
      <div class="page-actions">
        <el-select v-model="projectFilter" class="filter-select" clearable placeholder="全部项目" @change="load">
          <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-button type="primary" @click="openCreate">+ 新建套件</el-button>
      </div>
    </div>

    <div class="panel tip-panel">
      <div>
        <b>并发</b>：同一时刻最多 N 条流程在跑（1~8），每个 RunSession 变量域完全隔离。
      </div>
      <div>
        <b>重试</b>：单条流程失败后按 <code>retryDelayMs × 第几次</code> 退避重试；重试后通过记为
        <el-tag size="small" type="warning" effect="plain">flaky</el-tag>，每次尝试都是独立执行证据。
      </div>
      <div>
        <b>failFast</b>：某条流程重试耗尽仍失败后，尚未开始的流程统一 skipped；已在跑的流程会跑完。
      </div>
    </div>

    <div class="panel mt12">
      <el-table v-loading="loading" :data="suites" empty-text="还没有套件，先新建一个">
        <el-table-column label="套件" min-width="200">
          <template #default="{ row }">
            <div class="suite-name">{{ row.name }}</div>
            <div class="muted">{{ row.description || '无描述' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="项目" min-width="120">
          <template #default="{ row }">{{ projectName(row.projectId) }}</template>
        </el-table-column>
        <el-table-column label="流程数" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.flowCount }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="策略" min-width="190">
          <template #default="{ row }">
            <span class="mono">
              并发 {{ row.strategy?.concurrency }} · 重试 {{ row.strategy?.retry }}
              <template v-if="row.strategy?.failFast"> · failFast</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="最近执行" min-width="190">
          <template #default="{ row }">
            <template v-if="row.lastRun">
              <el-tag size="small" :type="statusType(row.lastRun.status)">
                {{ statusText(row.lastRun.status) }}
              </el-tag>
              <span class="muted">
                {{ row.lastRun.summary?.passed || 0 }}/{{ row.lastRun.summary?.total || 0 }} 通过 ·
                {{ fmtDuration(row.lastRun.summary?.durationMs) }}
              </span>
            </template>
            <span v-else class="muted">从未执行</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button
              text
              size="small"
              type="primary"
              :loading="startingId === row.id"
              @click="runSuite(row)"
            >
              执行
            </el-button>
            <el-button text size="small" @click="openHistory(row)">历史</el-button>
            <el-button text size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑套件' : '新建套件'"
      width="820px"
      top="5vh"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="96px">
        <el-form-item label="套件名称" required>
          <el-input v-model="form.name" maxlength="60" placeholder="例如：登录 + 下单冒烟" />
        </el-form-item>
        <el-form-item label="所属项目">
          <el-select v-model="form.projectId" clearable placeholder="全局（可跨项目选流程）" class="full">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认环境">
          <el-select v-model="form.environmentId" clearable placeholder="不指定（流程节点写全地址）" class="full">
            <el-option v-for="e in envOptions" :key="e.id" :label="`${e.name}${e.baseUrl ? ' · ' + e.baseUrl : ''}`" :value="e.id" />
          </el-select>
          <div class="muted">执行时仍可临时覆盖；执行记录会快照环境版本号。</div>
        </el-form-item>
        <el-form-item label="流程列表" required>
          <el-select
            v-model="selectedFlowIds"
            multiple
            filterable
            class="full"
            placeholder="按选择顺序执行；可搜索流程名"
          >
            <el-option v-for="f in flowOptions" :key="f.id" :label="`${f.name}${f.type === 'whitebox' ? '（白盒）' : ''}`" :value="f.id" />
          </el-select>
          <div v-if="orderedFlows.length" class="flow-order">
            <el-tag v-for="item in orderedFlows" :key="item.id" size="small" effect="plain">
              {{ item.index }}. {{ item.name }}
            </el-tag>
          </div>
          <div class="muted">取消后重新选择会排到末尾；执行顺序以下方编号为准。</div>
        </el-form-item>
        <el-form-item label="执行策略">
          <div class="strategy-grid">
            <div>
              <div class="strategy-label">并发数</div>
              <el-input-number v-model="strategy.concurrency" :min="1" :max="8" controls-position="right" />
            </div>
            <div>
              <div class="strategy-label">失败重试次数</div>
              <el-input-number v-model="strategy.retry" :min="0" :max="5" controls-position="right" />
            </div>
            <div>
              <div class="strategy-label">重试间隔（ms）</div>
              <el-input-number v-model="strategy.retryDelayMs" :min="0" :max="60000" :step="100" controls-position="right" />
            </div>
            <div class="strategy-switch">
              <div class="strategy-label">失败即停（failFast）</div>
              <el-switch v-model="strategy.failFast" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" placeholder="这批流程解决什么问题？" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="runVisible"
      :title="currentRun?.suiteName ? `套件执行 · ${currentRun.suiteName}` : '套件执行'"
      width="900px"
      top="5vh"
      :close-on-click-modal="false"
      @close="closeRun"
    >
      <div v-if="currentRun" v-loading="runLoading">
        <div class="run-head">
          <el-tag :type="statusType(currentRun.status)" size="large">{{ statusText(currentRun.status) }}</el-tag>
          <span class="muted">run {{ currentRun.id?.slice(0, 8) }} · {{ fmt(currentRun.startedAt) }}</span>
          <span v-if="currentRun.envId" class="muted">环境 {{ currentRun.envId.slice(0, 8) }} v{{ currentRun.envVersion }}</span>
          <div class="run-head-spacer" />
          <el-button v-if="runActive" type="danger" plain size="small" @click="stopRun">停止</el-button>
        </div>

        <el-progress :percentage="runPercent" :status="currentRun.status === 'failed' ? 'exception' : undefined" />

        <div class="run-stats">
          <div class="run-stat"><b>{{ currentRun.summary?.total || 0 }}</b><span>总数</span></div>
          <div class="run-stat ok"><b>{{ currentRun.summary?.passed || 0 }}</b><span>通过</span></div>
          <div class="run-stat bad"><b>{{ currentRun.summary?.failed || 0 }}</b><span>失败</span></div>
          <div class="run-stat skip"><b>{{ currentRun.summary?.skipped || 0 }}</b><span>跳过</span></div>
          <div class="run-stat warn"><b>{{ currentRun.summary?.flaky || 0 }}</b><span>flaky</span></div>
          <div class="run-stat"><b>{{ currentRun.summary?.peakConcurrency || 0 }}</b><span>峰值并发</span></div>
          <div class="run-stat"><b>{{ fmtDuration(currentRun.summary?.durationMs) }}</b><span>耗时</span></div>
        </div>

        <el-table :data="runFlows" size="small" max-height="440">
          <el-table-column label="#" width="48" align="center">
            <template #default="{ row }">{{ row.index + 1 }}</template>
          </el-table-column>
          <el-table-column prop="flowName" label="流程" min-width="180" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
              <el-tag v-if="row.flaky" size="small" type="warning" effect="plain" class="ml4">flaky</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="尝试" width="90" align="center">
            <template #default="{ row }">{{ row.attempts || 0 }} 次</template>
          </el-table-column>
          <el-table-column label="耗时" width="100">
            <template #default="{ row }">{{ fmtDuration(row.durationMs) }}</template>
          </el-table-column>
          <el-table-column label="说明" min-width="190">
            <template #default="{ row }">
              <span v-if="row.error" class="run-error">{{ row.error }}</span>
              <span v-else-if="row.executionId" class="mono muted">{{ row.executionId.slice(0, 8) }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="证据" width="80" align="center">
            <template #default="{ row }">
              <router-link
                v-if="row.executionId"
                class="run-link"
                :to="`/reports/${row.executionId}`"
                target="_blank"
              >
                报告
              </router-link>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div v-else v-loading="true" class="run-loading" />
    </el-dialog>

    <el-drawer v-model="historyVisible" :title="historySuite ? `执行历史 · ${historySuite.name}` : '执行历史'" size="560px">
      <el-empty v-if="!historyRuns.length" description="还没有执行记录" />
      <div v-for="run in historyRuns" :key="run.id" class="history-row" @click="openRun(run.id)">
        <el-tag size="small" :type="statusType(run.status)">{{ statusText(run.status) }}</el-tag>
        <div class="history-main">
          <div>{{ fmt(run.startedAt) }}</div>
          <div class="muted">
            {{ run.summary?.passed || 0 }}/{{ run.summary?.total || 0 }} 通过
            <template v-if="run.summary?.failed"> · {{ run.summary.failed }} 失败</template>
            <template v-if="run.summary?.flaky"> · {{ run.summary.flaky }} flaky</template>
            · {{ fmtDuration(run.summary?.durationMs) }}
          </div>
        </div>
        <span class="mono muted">{{ run.id.slice(0, 8) }}</span>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.suite-name { font-weight: 600; margin-bottom: 3px; }
.flow-order { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.strategy-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
}
.strategy-label { font-size: 12px; color: #909399; margin-bottom: 4px; }
.strategy-switch { display: flex; flex-direction: column; }
.run-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.run-head-spacer { flex: 1; }
.run-stats { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
.run-stat {
  flex: 1;
  min-width: 82px;
  background: #f7f8fa;
  border-radius: 8px;
  padding: 9px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.run-stat b { font-size: 18px; }
.run-stat span { font-size: 11px; color: #909399; }
.run-stat.ok b { color: #67c23a; }
.run-stat.bad b { color: #f56c6c; }
.run-stat.skip b { color: #909399; }
.run-stat.warn b { color: #e6a23c; }
.run-error { color: #c45656; font-size: 12px; }
.run-link { color: #409eff; text-decoration: none; font-size: 12px; }
.run-loading { height: 240px; }
.history-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
}
.history-row:hover { background: #f5f7fa; }
.history-main { flex: 1; font-size: 13px; }
.ml4 { margin-left: 4px; }
</style>
