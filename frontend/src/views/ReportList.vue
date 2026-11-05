<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'

const router = useRouter()
const list = ref<any[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await api.listExecutions()
  } finally {
    loading.value = false
  }
}

onMounted(load)

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
const dur = (row: any) =>
  row.finishedAt && row.startedAt ? `${((row.finishedAt - row.startedAt) / 1000).toFixed(1)}s` : '—'
const statusTag = (s: string) =>
  ({ passed: 'success', failed: 'danger', stopped: 'warning', running: 'primary', paused: 'warning' })[s] || 'info'
const statusText: Record<string, string> = {
  passed: '全部通过', failed: '存在未通过', stopped: '已停止', running: '执行中', paused: '已暂停',
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">执行报告</div>
        <div class="page-sub">每次流程执行的最终结果与输入输出匹对记录</div>
      </div>
      <el-button @click="load">刷新</el-button>
    </div>

    <div class="panel">
      <el-table :data="list" v-loading="loading" style="width: 100%">
        <el-table-column prop="flowName" label="流程" min-width="200" />
        <el-table-column label="类型" width="76">
          <template #default="{ row }">
            <el-tag size="small" :type="row.flowType === 'blackbox' ? 'primary' : 'warning'" effect="plain">
              {{ row.flowType === 'blackbox' ? '黑盒' : '白盒' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">{{ statusText[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="通过/未通过/跳过" width="140" align="center">
          <template #default="{ row }">
            <span v-if="row.summary">{{ row.summary.passed }} / {{ row.summary.failed }} / {{ row.summary.skipped }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="80" align="center">
          <template #default="{ row }">{{ dur(row) }}</template>
        </el-table-column>
        <el-table-column label="开始时间" width="170">
          <template #default="{ row }">{{ fmt(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="center">
          <template #default="{ row }">
            <el-button size="small" type="primary" plain @click="router.push(`/reports/${row.id}`)">查看详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无执行记录" />
        </template>
      </el-table>
    </div>
  </div>
</template>
