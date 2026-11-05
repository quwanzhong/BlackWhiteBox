<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import FolderPicker from '../components/FolderPicker.vue'

const router = useRouter()
const projects = ref<any[]>([])
const loading = ref(false)
const createVisible = ref(false)
const pickerVisible = ref(false)
const saving = ref(false)

const form = reactive({
  name: '',
  description: '',
  codePath: '',
  serviceBaseUrl: '',
  apifoxProjectId: '',
  token: '',
})

const steps = [
  { t: '关联代码目录', d: '填写本机前端工程绝对路径（不上传代码）' },
  { t: '勾选 Apifox 接口', d: '从同一份文档里挑选本项目实际用到的接口' },
  { t: '扫描调用流程', d: '静态分析源码调用顺序并匹配接口' },
  { t: '生成闭环流程', d: '按业务功能生成可执行黑盒流程' },
]

async function load() {
  loading.value = true
  try {
    projects.value = await api.listProjects()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '加载项目失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  form.name = ''
  form.description = ''
  form.codePath = ''
  form.serviceBaseUrl = ''
  form.apifoxProjectId = ''
  form.token = ''
  createVisible.value = true
}

async function create() {
  if (!form.name.trim()) return ElMessage.warning('请填写项目名称')
  saving.value = true
  try {
    const project = await api.createProject({
      name: form.name.trim(),
      description: form.description,
      codePath: form.codePath,
      serviceBaseUrl: form.serviceBaseUrl,
      apifox: { projectId: form.apifoxProjectId },
    })
    createVisible.value = false
    ElMessage.success('项目已创建，接下来勾选接口')
    router.push(`/projects/${project.id}`)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '创建失败')
  } finally {
    saving.value = false
  }
}

async function remove(project: any) {
  try {
    await ElMessageBox.confirm(`确认删除项目「${project.name}」？已生成的流程与缺陷会保留。`, '删除项目', {
      type: 'warning',
    })
  } catch {
    return
  }
  await api.deleteProject(project.id)
  ElMessage.success('已删除')
  load()
}

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
const matchTag = (rate?: number) => (rate >= 90 ? 'success' : rate >= 60 ? 'warning' : 'danger')
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">项目管理</div>
        <div class="page-sub">关联本机前端工程 → 勾选 Apifox 接口 → 扫描调用流程 → 生成业务闭环测试流程</div>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/import')">Apifox 连接设置</el-button>
        <el-button type="primary" @click="openCreate">+ 新建项目</el-button>
      </div>
    </div>

    <div class="panel guide-panel">
      <div v-for="(s, i) in steps" :key="s.t" class="guide-step">
        <span class="gs-no">{{ i + 1 }}</span>
        <div>
          <div class="gs-title">{{ s.t }}</div>
          <div class="gs-desc">{{ s.d }}</div>
        </div>
      </div>
    </div>

    <div v-loading="loading" class="project-grid mt12">
      <div v-for="p in projects" :key="p.id" class="project-card" @click="router.push(`/projects/${p.id}`)">
        <div class="pc-head">
          <div class="pc-name">{{ p.name }}</div>
          <el-tag v-if="p.scan" size="small" :type="matchTag(p.scan.matchRate)">
            匹配 {{ p.scan.matchRate }}%
          </el-tag>
          <el-tag v-else size="small" type="info">未扫描</el-tag>
        </div>
        <div class="pc-desc">{{ p.description || '暂无描述' }}</div>
        <div class="pc-path" :title="p.codePath">{{ p.codePath || '未关联代码目录' }}</div>
        <div class="pc-metrics">
          <div><b>{{ p.interfaceCount }}</b><span>接口</span></div>
          <div><b>{{ p.scan?.groupCount || 0 }}</b><span>业务功能</span></div>
          <div><b>{{ p.flowCount }}</b><span>流程</span></div>
          <div><b :class="{ 'pc-bad': p.openBugs > 0 }">{{ p.openBugs }}</b><span>未关缺陷</span></div>
        </div>
        <div class="pc-foot">
          <span class="muted">{{ p.scan ? `扫描 ${p.scan.callCount} 调用 · ${p.scan.scannedFiles} 文件` : '尚未扫描源码' }}</span>
          <span class="muted">{{ fmt(p.updatedAt) }}</span>
        </div>
        <el-button class="pc-del" text size="small" type="danger" @click.stop="remove(p)">删除</el-button>
      </div>

      <div v-if="!loading && !projects.length" class="panel empty-panel">
        <div class="ep-ico">◐</div>
        <div class="ep-title">还没有项目</div>
        <div class="ep-desc">同一份 Apifox 文档可以服务多个前端项目。先建一个项目，把代码目录和接口关联起来。</div>
        <el-button type="primary" @click="openCreate">新建第一个项目</el-button>
      </div>
    </div>

    <el-dialog v-model="createVisible" title="新建项目" width="600px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="项目名称" required>
          <el-input v-model="form.name" placeholder="例如：稀有血型库前端" />
        </el-form-item>
        <el-form-item label="项目描述">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="这个项目负责哪些业务" />
        </el-form-item>
        <el-form-item label="代码目录">
          <div class="path-line">
            <el-input v-model="form.codePath" placeholder="点击右侧选择本机前端工程目录" />
            <el-button @click="pickerVisible = true">选择目录</el-button>
          </div>
          <div class="muted">只记录本机绝对路径，代码不会上传或复制。之后扫描、生成流程都读这个目录。</div>
        </el-form-item>
        <el-form-item label="被测服务地址">
          <el-input v-model="form.serviceBaseUrl" placeholder="例如：http://127.0.0.1:8080/api（可留空，取接口文档服务地址）" />
        </el-form-item>
        <el-form-item label="Apifox 项目 ID">
          <el-input v-model="form.apifoxProjectId" placeholder="留空则使用「数据导入」页已连接的项目" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建并配置接口</el-button>
      </template>
    </el-dialog>

    <FolderPicker v-model="pickerVisible" :path="form.codePath" @select="form.codePath = $event" />
  </div>
</template>

<style scoped>
.guide-panel { display: flex; gap: 10px; flex-wrap: wrap; }
.guide-step { display: flex; gap: 10px; align-items: flex-start; flex: 1; min-width: 190px; }
.gs-no {
  width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 50%;
  background: #ecf5ff; color: #409eff; font-size: 12px; font-weight: 700; flex-shrink: 0;
}
.gs-title { font-size: 13px; font-weight: 600; }
.gs-desc { font-size: 11px; color: #909399; margin-top: 2px; line-height: 1.5; }

.project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
.project-card {
  background: #fff; border-radius: 10px; padding: 16px; cursor: pointer; position: relative;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04); border: 1px solid transparent;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.project-card:hover { border-color: #c6e2ff; box-shadow: 0 4px 14px rgba(64, 158, 255, 0.12); }
.pc-head { display: flex; align-items: center; gap: 8px; }
.pc-name { font-size: 15px; font-weight: 700; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-desc { font-size: 12px; color: #909399; margin-top: 6px; min-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-path {
  font-family: Consolas, monospace; font-size: 11px; color: #8a94a6; background: #f5f7fa;
  border-radius: 4px; padding: 4px 8px; margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pc-metrics { display: flex; gap: 8px; margin-top: 12px; }
.pc-metrics > div { flex: 1; background: #f7f8fa; border-radius: 6px; padding: 6px; text-align: center; display: flex; flex-direction: column; }
.pc-metrics b { font-size: 17px; color: #303133; }
.pc-metrics b.pc-bad { color: #f56c6c; }
.pc-metrics span { font-size: 11px; color: #909399; }
.pc-foot { display: flex; justify-content: space-between; margin-top: 10px; }
.pc-del { position: absolute; right: 8px; bottom: 8px; opacity: 0; }
.project-card:hover .pc-del { opacity: 1; }
.empty-panel { grid-column: 1 / -1; text-align: center; padding: 46px 20px; }
.ep-ico { font-size: 38px; color: #c0c4cc; }
.ep-title { font-size: 16px; font-weight: 700; margin-top: 8px; }
.ep-desc { font-size: 12px; color: #909399; margin: 6px auto 16px; max-width: 460px; line-height: 1.7; }
.path-line { display: flex; gap: 8px; width: 100%; }
</style>
