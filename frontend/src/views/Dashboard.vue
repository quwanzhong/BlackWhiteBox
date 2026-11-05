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
        <el-button type="primary" @click="router.push('/projects')">进入项目管理</el-button>
        <el-button @click="router.push('/flows')">流程管理</el-button>
        <el-button @click="router.push('/import')">导入 Apifox 接口</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card stat-blue">
        <div class="stat-label">项目数</div>
        <div class="stat-value">{{ stats.projectCount || 0 }}</div>
      </div>
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
      <div class="stat-card" style="cursor: pointer" @click="router.push('/bugs')">
        <div class="stat-label">未关闭缺陷</div>
        <div class="stat-value" :style="{ color: stats.openBugCount ? '#f56c6c' : undefined }">
          {{ stats.openBugCount || 0 }}<small> / {{ stats.bugTotal || 0 }}</small>
        </div>
      </div>
    </div>

    <div class="panel mt12">
      <h3 style="margin: 0 0 10px; font-size: 14px">推荐链路：项目 → 接口 → 代码 → 业务闭环</h3>
      <ol class="guide-list">
        <li><b>建项目</b>：在「项目管理」新建项目，选择本机前端工程目录（不上传代码）；</li>
        <li><b>勾接口</b>：从同一份 Apifox 文档里勾选该项目实际用到的接口，保存为项目接口快照；</li>
        <li><b>扫代码</b>：静态扫描项目目录里的 axios / request / fetch 调用点，自动匹配接口与调用顺序；</li>
        <li><b>分业务</b>：按 Apifox 目录 / 接口路径 / 代码目录划分业务功能，一键生成可执行黑盒流程；</li>
        <li><b>跑闭环</b>：执行流程，节点依次<b style="color: #409eff">呼吸发光</b>，逐项校验「实际输出 vs 理想输出」；</li>
        <li><b>提缺陷</b>：失败步骤直接提缺陷，在「缺陷反馈」跟踪修复状态。</li>
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
