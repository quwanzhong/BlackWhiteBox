<script setup lang="ts">
import { computed } from 'vue'
import type { FlowDsl } from '../types/flow'

const props = defineProps<{
  summary: any
  flow?: FlowDsl | null
  steps?: Record<string, any>
}>()

const stepList = computed(() => {
  if (!props.summary) return []
  return (props.flow?.nodes || []).map((n) => {
    const s = props.steps?.[n.id]
    return { id: n.id, name: n.name, status: s?.status || 'skipped', step: s }
  })
})

const statusText: Record<string, string> = {
  passed: '全部通过',
  failed: '存在未通过步骤',
  stopped: '执行已停止',
}

const failedOf = (step: any) =>
  (step?.checks?.results || []).filter((c: any) => !c.passed)
</script>

<template>
  <div v-if="summary" class="result-summary">
    <div class="rs-hero" :class="'rs-' + summary.status">
      <div class="rs-icon">{{ summary.status === 'passed' ? '✔' : summary.status === 'failed' ? '✘' : '■' }}</div>
      <div>
        <div class="rs-title">{{ statusText[summary.status] || summary.status }}</div>
        <div class="rs-msg">{{ summary.message }}</div>
        <div class="rs-verdict" :class="summary.matchedAll ? 'ok' : 'bad'">
          {{ summary.matchedAll ? '✅ 实际输出符合流程的理想输出' : '❌ 存在不符合理想输出的步骤，请查看下方差异' }}
        </div>
      </div>
    </div>

    <div class="rs-stats">
      <div class="rs-stat"><b>{{ summary.total }}</b><span>总步骤</span></div>
      <div class="rs-stat ok"><b>{{ summary.passed }}</b><span>通过</span></div>
      <div class="rs-stat bad"><b>{{ summary.failed }}</b><span>未通过</span></div>
      <div class="rs-stat skip"><b>{{ summary.skipped }}</b><span>跳过</span></div>
      <div class="rs-stat"><b>{{ (summary.durationMs / 1000).toFixed(2) }}s</b><span>总耗时</span></div>
    </div>

    <el-table :data="stepList" size="small" border class="rs-table">
      <el-table-column prop="name" label="步骤" min-width="170" />
      <el-table-column label="状态" width="88">
        <template #default="{ row }">
          <el-tag
            size="small"
            :type="row.status === 'passed' ? 'success' : row.status === 'failed' ? 'danger' : 'info'"
          >
            {{ { passed: '通过', failed: '未通过', skipped: '跳过', waiting: '等待' }[row.status] || row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="输出匹对" width="96">
        <template #default="{ row }">
          <span v-if="row.step?.checks" :class="row.step.checks.matched ? 'diff-ok' : 'diff-bad'">
            {{ row.step.checks.matched ? '✔ 符合' : '✘ 不匹配' }}
          </span>
          <span v-else class="diff-na">—</span>
        </template>
      </el-table-column>
      <el-table-column label="差异 / 说明" min-width="230">
        <template #default="{ row }">
          <div v-if="failedOf(row.step).length" class="diff-list">
            <div v-for="(c, i) in failedOf(row.step)" :key="i" class="diff-item">
              {{ c.path || c.label || c.type }}：{{ c.message }}
            </div>
          </div>
          <span v-else-if="row.step?.error" class="diff-bad">{{ row.step.error }}</span>
          <span v-else class="diff-na">{{ row.step ? '符合' : '未执行' }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="rs-final">
      流程理想输出匹配结论：{{ summary.matchedAll ? '符合' : '不符合' }}
      <span class="muted" style="font-weight: 400; margin-left: 8px">
        （黑盒：实际响应 vs 期望响应；白盒：人工确认结果 vs 期望逻辑）
      </span>
    </div>
  </div>
</template>
