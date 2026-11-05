<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'

const router = useRouter()
const stats = ref<any>(null)
const recent = ref<any[]>([])

onMounted(async () => {
  stats.value = await api.getStats()
  recent.value = stats.value.recent || []
})

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
const statusTag = (s: string) =>
  ({ passed: 'success', failed: 'danger', stopped: 'warning', running: 'primary', paused: 'warning' })[s] || 'info'
const statusText: Record<string, string> = {
  passed: '全部通过', failed: '存在未通过', stopped: '已停止', running: '执行中', paused: '已暂停',
}
</script>

<template>
  <div v-if="stats">
    <div class="page-header">
      <div>
        <div class="page-title">项目总览</div>
        <div class="page-sub">黑百盒 · 黑白盒流程化测试平台（本地单机版）</div>
      </div>
      <div class="page-actions">
        <el-button type="primary" @click="router.push('/flows')">进入流程管理</el-button>
        <el-button @click="router.push('/import')">导入 Apifox 接口</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card stat-blue">
        <div class="stat-label">流程总数</div>
        <div class="stat-value">{{ stats.flowTotal }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">⬛ 黑盒流程</div>
        <div class="stat-value">{{ stats.blackboxCount }}</div>
      </div>
      <div class="stat-card stat-purple">
        <div class="stat-label">⬜ 白盒流程</div>
        <div class="stat-value">{{ stats.whiteboxCount }}</div>
      </div>
      <div class="stat-card stat-green">
        <div class="stat-label">累计执行次数</div>
        <div class="stat-value">{{ stats.execTotal }}</div>
      </div>
      <div class="stat-card stat-orange">
        <div class="stat-label">最近通过率</div>
        <div class="stat-value">
          {{ stats.successRate === null ? '—' : stats.successRate }}<small v-if="stats.successRate !== null">%</small>
        </div>
      </div>
    </div>

    <div class="panel mt12">
      <h3 style="margin: 0 0 10px; font-size: 14px">快速上手</h3>
      <ol class="guide-list">
        <li><b>导入接口</b>：在「数据导入」上传 Apifox 导出的 OpenAPI JSON，一键生成黑盒流程节点；</li>
        <li><b>编排流程</b>：在流程画布上拖拽排列节点，配置请求、理想输出（期望值）、变量提取；</li>
        <li><b>执行流程</b>：点击执行，画布节点依次<b style="color: #409eff">呼吸发光</b>，当前执行到哪一步一目了然；</li>
        <li><b>查看结果</b>：流程跑完自动弹出结果汇总，逐项展示「实际输出 vs 理想输出」的匹对结论与差异明细；</li>
        <li><b>白盒走查</b>：导入 Java 分析器生成的调用链，逐步人工确认代码逻辑并给出通过 / 不通过结论。</li>
      </ol>
    </div>

    <div class="panel mt12">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px">
        <h3 style="margin: 0; font-size: 14px">最近执行</h3>
        <el-button size="small" link type="primary" @click="router.push('/reports')">全部报告 →</el-button>
      </div>
      <el-table :data="recent" size="small">
        <el-table-column prop="flowName" label="流程" min-width="200" />
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.flowType === 'blackbox' ? 'primary' : 'warning'" effect="plain">
              {{ row.flowType === 'blackbox' ? '黑盒' : '白盒' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">{{ statusText[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="通过 / 未通过" width="110" align="center">
          <template #default="{ row }">
            <span v-if="row.summary">{{ row.summary.passed }} / {{ row.summary.failed }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" width="170">
          <template #default="{ row }">{{ fmt(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="center">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="router.push(`/reports/${row.id}`)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty><span class="muted">还没有执行记录，去执行一次流程试试</span></template>
      </el-table>
    </div>
  </div>
</template>
