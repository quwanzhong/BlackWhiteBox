<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { useExecStore } from '../stores/execution'
import { createGraph, renderFlow } from '../components/canvas/useCanvas'
import ResultSummary from '../components/ResultSummary.vue'
import type { FlowDsl } from '../types/flow'

const route = useRoute()
const router = useRouter()
const exec = useExecStore()

const detail = ref<any>(null)
const flow = ref<FlowDsl | null>(null)
const container = ref<HTMLElement>()
let graph: any = null

onMounted(async () => {
  detail.value = await api.getExecution(route.params.id as string)
  if (!detail.value) return
  flow.value = {
    id: detail.value.flowId,
    name: detail.value.flowName,
    type: detail.value.flowType,
    nodes: detail.value.nodes || [],
    edges: detail.value.edges || [],
  } as FlowDsl

  // 报告页为静态回放：清空实时执行状态，把每个节点的最终状态写进节点 data
  exec.reset()
  const states: Record<string, string> = {}
  for (const s of detail.value.steps || []) states[s.nodeId] = s.status

  await nextTick()
  graph = createGraph(container.value!, true)
  renderFlow(graph, flow.value, states)
})

onBeforeUnmount(() => {
  try { graph?.dispose() } catch { /* ignore */ }
  graph = null
})

const stepsById = computed(() => {
  const map: Record<string, any> = {}
  for (const s of detail.value?.steps || []) map[s.nodeId] = s
  return map
})

const expandRows = computed(() => (detail.value?.steps || []).map((s: any) => s.id))

const pretty = (v: any) => {
  if (v === undefined || v === null) return '—'
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

const statusTag = (s: string) =>
  ({ passed: 'success', failed: 'danger', skipped: 'info', waiting: 'warning' })[s] || 'info'
const statusText: Record<string, string> = {
  passed: '通过', failed: '未通过', skipped: '跳过', waiting: '等待', running: '执行中', pending: '待执行',
}
</script>

<template>
  <div v-if="detail && flow">
    <div class="page-header">
      <div>
        <div class="page-title">
          {{ detail.flowName }}
          <el-tag :type="detail.flowType === 'blackbox' ? 'primary' : 'warning'" size="small" effect="dark" style="margin-left: 8px">
            {{ detail.flowType === 'blackbox' ? '⬛ 黑盒' : '⬜ 白盒' }}
          </el-tag>
        </div>
        <div class="report-meta">
          <span>执行 ID：{{ detail.id }}</span>
          <span>开始：{{ new Date(detail.startedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          <span v-if="detail.summary">耗时：{{ (detail.summary.durationMs / 1000).toFixed(2) }}s</span>
        </div>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/reports')">返回列表</el-button>
        <el-button type="primary" plain @click="router.push(`/flows/${detail.flowId}`)">打开流程画布</el-button>
      </div>
    </div>

    <div class="report-block">
      <ResultSummary :summary="detail.summary" :flow="flow" :steps="stepsById" />
    </div>

    <div class="report-canvas mt12" ref="container" />

    <div class="report-block mt12">
      <h3>步骤明细（输入 / 实际输出 / 校验）</h3>
      <el-table :data="detail.steps || []" size="small" border :row-key="'id'" :expand-row-keys="expandRows">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 8px 16px">
              <div v-if="row.request" class="sp-kv"><b>实际请求：</b>{{ row.request.method }} {{ row.request.url }}</div>
              <pre v-if="row.request?.body" class="json-block">{{ pretty(row.request.body) }}</pre>
              <div v-if="row.expected" class="sp-kv"><b>理想输出：</b></div>
              <pre v-if="row.expected" class="json-block">{{ pretty(row.expected) }}</pre>
              <div v-if="row.actual" class="sp-kv"><b>实际输出：</b></div>
              <pre v-if="row.actual" class="json-block">{{ pretty(row.actual) }}</pre>
              <div v-if="row.error" class="sp-tip" style="background: #fef0f0; border-color: #fde2e2; color: #c45656">
                {{ row.error }}
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="nodeName" label="步骤" min-width="160" />
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">{{ statusText[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="输出匹对" width="96">
          <template #default="{ row }">
            <span v-if="row.checks" :class="row.checks.matched ? 'diff-ok' : 'diff-bad'">
              {{ row.checks.matched ? '✔ 符合' : '✘ 不匹配' }}
            </span>
            <span v-else class="diff-na">—</span>
          </template>
        </el-table-column>
        <el-table-column label="差异明细" min-width="280">
          <template #default="{ row }">
            <div v-if="row.checks && !row.checks.matched" class="diff-list">
              <div v-for="(c, i) in row.checks.results.filter((x: any) => !x.passed)" :key="i" class="diff-item">
                {{ c.path || c.label || c.type }}：{{ c.message }}
              </div>
            </div>
            <span v-else-if="row.error" class="diff-bad">{{ row.error }}</span>
            <span v-else class="diff-na">{{ row.status === 'skipped' ? '前置失败，已跳过' : '符合' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
