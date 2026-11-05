<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

const bugs = ref<any[]>([])
const projects = ref<any[]>([])
const loading = ref(false)
const filter = reactive({ projectId: '', status: '', severity: '' })
const createVisible = ref(false)
const saving = ref(false)
const form = reactive({
  projectId: '',
  title: '',
  description: '',
  severity: 'major',
  reporter: '',
})

const SEVERITIES: Record<string, { text: string; type: string }> = {
  blocker: { text: '致命', type: 'danger' },
  critical: { text: '严重', type: 'danger' },
  major: { text: '主要', type: 'warning' },
  minor: { text: '次要', type: 'info' },
  trivial: { text: '轻微', type: 'info' },
}
const STATUSES: Record<string, { text: string; type: string }> = {
  open: { text: '待确认', type: 'danger' },
  confirmed: { text: '已确认', type: 'warning' },
  fixing: { text: '修复中', type: 'warning' },
  fixed: { text: '待验证', type: 'primary' },
  verified: { text: '已验证', type: 'success' },
  closed: { text: '已关闭', type: 'info' },
  rejected: { text: '已驳回', type: 'info' },
}

const stats = computed(() => {
  const total = bugs.value.length
  const open = bugs.value.filter((b) => !['closed', 'verified', 'rejected'].includes(b.status)).length
  const fixed = bugs.value.filter((b) => b.status === 'fixed').length
  return { total, open, fixed, closed: total - open }
})
const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name || '-'

async function load() {
  loading.value = true
  try {
    const params: any = {}
    if (filter.projectId) params.projectId = filter.projectId
    if (filter.status) params.status = filter.status
    if (filter.severity) params.severity = filter.severity
    bugs.value = await api.listBugs(params)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '加载缺陷失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  projects.value = await api.listProjects()
  await load()
})

function openCreate() {
  form.projectId = filter.projectId || projects.value[0]?.id || ''
  form.title = ''
  form.description = ''
  form.severity = 'major'
  form.reporter = ''
  createVisible.value = true
}

async function create() {
  if (!form.title.trim()) return ElMessage.warning('请填写缺陷标题')
  saving.value = true
  try {
    await api.createBug({ ...form })
    createVisible.value = false
    ElMessage.success('缺陷已提交')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '提交失败')
  } finally {
    saving.value = false
  }
}

async function changeStatus(bug: any, status: string) {
  try {
    const updated = await api.updateBug(bug.id, { status })
    Object.assign(bug, updated)
    ElMessage.success('状态已更新')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '更新失败')
  }
}

async function remove(bug: any) {
  try {
    await ElMessageBox.confirm(`确认删除缺陷「${bug.title}」？`, '删除缺陷', { type: 'warning' })
  } catch {
    return
  }
  await api.deleteBug(bug.id)
  await load()
}

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">缺陷反馈</div>
        <div class="page-sub">执行报告中的失败步骤可直接提单，也可以在这里手工登记和跟踪状态</div>
      </div>
      <div class="page-actions">
        <el-button type="primary" @click="openCreate">+ 登记缺陷</el-button>
      </div>
    </div>

    <div class="bug-stats">
      <div class="bs-card"><b>{{ stats.open }}</b><span>待处理</span></div>
      <div class="bs-card"><b class="c-blue">{{ stats.fixed }}</b><span>待验证</span></div>
      <div class="bs-card"><b class="c-green">{{ stats.closed }}</b><span>已关闭 / 已验证</span></div>
      <div class="bs-card"><b>{{ stats.total }}</b><span>累计缺陷</span></div>
    </div>

    <div class="panel mt12">
      <div class="bug-toolbar">
        <el-select v-model="filter.projectId" clearable placeholder="全部项目" style="width: 200px" @change="load">
          <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-select v-model="filter.status" clearable placeholder="全部状态" style="width: 150px" @change="load">
          <el-option v-for="(v, k) in STATUSES" :key="k" :label="v.text" :value="k" />
        </el-select>
        <el-select v-model="filter.severity" clearable placeholder="全部级别" style="width: 150px" @change="load">
          <el-option v-for="(v, k) in SEVERITIES" :key="k" :label="v.text" :value="k" />
        </el-select>
        <span class="muted">共 {{ bugs.length }} 条</span>
      </div>

      <el-table v-loading="loading" :data="bugs" size="small" class="mt12" border>
        <el-table-column label="缺陷" min-width="280">
          <template #default="{ row }">
            <div class="bug-title">{{ row.title }}</div>
            <div v-if="row.description" class="muted bug-desc">{{ row.description }}</div>
          </template>
        </el-table-column>
        <el-table-column label="项目 / 流程" min-width="200">
          <template #default="{ row }">
            <div>{{ row.projectName || projectName(row.projectId) }}</div>
            <div class="muted">{{ row.flowName || (row.flowId ? row.flowId.slice(0, 8) : '手工登记') }}<template v-if="row.stepName"> · {{ row.stepName }}</template></div>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="(SEVERITIES[row.severity]?.type as any) || 'info'">
              {{ SEVERITIES[row.severity]?.text || row.severity }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-select :model-value="row.status" size="small" @change="changeStatus(row, $event)">
              <el-option v-for="(v, k) in STATUSES" :key="k" :label="v.text" :value="k" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="提交人" width="100">
          <template #default="{ row }">{{ row.reporter || '-' }}</template>
        </el-table-column>
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="changeStatus(row, 'fixed')">标记修复</el-button>
            <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="createVisible" title="登记缺陷" width="600px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="所属项目">
          <el-select v-model="form.projectId" clearable placeholder="选择项目" style="width: 100%">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="缺陷标题" required>
          <el-input v-model="form.title" placeholder="一句话描述问题" />
        </el-form-item>
        <el-form-item label="详细描述">
          <el-input v-model="form.description" type="textarea" :rows="4" placeholder="复现步骤、期望结果、实际结果" />
        </el-form-item>
        <el-form-item label="严重级别">
          <el-select v-model="form.severity" style="width: 100%">
            <el-option v-for="(v, k) in SEVERITIES" :key="k" :label="v.text" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="提交人">
          <el-input v-model="form.reporter" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.bug-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.bs-card { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04); }
.bs-card b { font-size: 24px; display: block; }
.bs-card b.c-blue { color: #409eff; }
.bs-card b.c-green { color: #67c23a; }
.bs-card span { font-size: 12px; color: #909399; }
.bug-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.bug-title { font-weight: 600; font-size: 13px; }
.bug-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
</style>
