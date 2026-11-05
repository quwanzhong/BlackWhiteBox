<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

const router = useRouter()
const activeType = ref<'blackbox' | 'whitebox'>('blackbox')
const flows = ref<any[]>([])
const loading = ref(false)
const createVisible = ref(false)
const createForm = reactive({ name: '', type: 'blackbox', description: '' })

async function load() {
  loading.value = true
  try {
    flows.value = await api.listFlows(activeType.value)
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function create() {
  if (!createForm.name.trim()) return ElMessage.warning('请填写流程名称')
  const flow = await api.createFlow({
    name: createForm.name.trim(),
    type: createForm.type as any,
    description: createForm.description,
    nodes: [],
    edges: [],
    variables: {},
  })
  createVisible.value = false
  createForm.name = ''
  createForm.description = ''
  router.push(`/flows/${flow.id}`)
}

const open = (row: any) => router.push(`/flows/${row.id}`)
const run = (row: any) => router.push(`/flows/${row.id}?run=1`)

async function remove(row: any) {
  await ElMessageBox.confirm(`确定删除流程「${row.name}」吗？`, '删除确认', { type: 'warning' })
  await api.deleteFlow(row.id)
  ElMessage.success('已删除')
  load()
}

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">流程管理</div>
        <div class="page-sub">黑盒流程（业务接口视角）与白盒流程（代码调用链视角）分开管理，互不干扰</div>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/import')">导入数据</el-button>
        <el-button type="primary" @click="createVisible = true">＋ 新建流程</el-button>
      </div>
    </div>

    <div class="panel">
      <el-tabs v-model="activeType" @tab-change="load">
        <el-tab-pane label="⬛ 黑盒流程" name="blackbox" />
        <el-tab-pane label="⬜ 白盒流程" name="whitebox" />
      </el-tabs>

      <el-table :data="flows" v-loading="loading" style="width: 100%">
        <el-table-column prop="name" label="流程名称" min-width="220">
          <template #default="{ row }">
            <el-link type="primary" @click="open(row)">{{ row.name }}</el-link>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
        <el-table-column prop="nodeCount" label="节点数" width="80" align="center" />
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ fmt(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" align="center">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="open(row)">打开画布</el-button>
            <el-button size="small" type="success" plain @click="run(row)">执行</el-button>
            <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无流程，点击右上角「新建流程」或「导入数据」开始">
            <el-button type="primary" size="small" @click="router.push('/import')">去导入 Apifox 接口</el-button>
          </el-empty>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="createVisible" title="新建流程" width="460px">
      <el-form label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="createForm.name" placeholder="例如：下单流程（黑盒）" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="createForm.type">
            <el-radio-button value="blackbox">⬛ 黑盒（接口调用）</el-radio-button>
            <el-radio-button value="whitebox">⬜ 白盒（代码走查）</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="create">创建并打开画布</el-button>
      </template>
    </el-dialog>
  </div>
</template>
