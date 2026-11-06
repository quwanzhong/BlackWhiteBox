<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useApifoxStore } from '../stores/apifox'
import FolderPicker from '../components/FolderPicker.vue'

const route = useRoute()
const router = useRouter()
const id = route.params.id as string
const apifox = useApifoxStore()

const project = ref<any>(null)
const loading = ref(false)
const activeTab = ref('interfaces')

// 接口绑定
const available = ref<any>(null)
const selectedIds = ref<string[]>([])
const keyword = ref('')
const folderFilter = ref('')
const savingBind = ref(false)
const pulling = ref(false)

// 代码分析
const pickerVisible = ref(false)
const pickerTarget = ref<'scan' | 'edit'>('scan')
const scanPath = ref('')
const scanBase = ref('')
const scanning = ref(false)
const showUnmatchedOnly = ref(false)
const mappingCall = ref<any>(null)
const mappingId = ref('')
const mappingVisible = ref(false)

// 业务功能
const selectedGroups = ref<string[]>([])
const generating = ref(false)

// 设置
const editVisible = ref(false)
const editForm = reactive({ name: '', description: '', codePath: '', serviceBaseUrl: '' })

const interfaces = computed<any[]>(() => available.value?.interfaces || [])
const folders = computed(() => [...new Set(interfaces.value.map((i) => i.folder).filter(Boolean))])
const filteredInterfaces = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return interfaces.value.filter((i) => {
    if (folderFilter.value && i.folder !== folderFilter.value) return false
    if (!kw) return true
    return `${i.method} ${i.path} ${i.name} ${i.folder}`.toLowerCase().includes(kw)
  })
})
const scan = computed(() => project.value?.scan || null)
const calls = computed<any[]>(() => {
  const list = scan.value?.calls || []
  return showUnmatchedOnly.value ? list.filter((c) => !c.matched) : list
})
const groups = computed(() => scan.value?.groups || [])
const flows = computed(() => project.value?.flows || [])
const methodType: Record<string, string> = {
  GET: 'success', POST: 'primary', PUT: 'warning', PATCH: 'warning', DELETE: 'danger',
}
const groupSourceText: Record<string, string> = {
  'apifox-folder': 'Apifox 目录', 'path-segment': '接口路径', 'code-dir': '代码目录',
}

async function load() {
  loading.value = true
  try {
    await apifox.ensureLoaded()
    project.value = await api.getProject(id)
    selectedIds.value = [...(project.value.interfaceIds || [])]
    scanPath.value = project.value.codePath || ''
    scanBase.value = project.value.serviceBaseUrl || ''
    await loadAvailable()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '加载项目失败')
  } finally {
    loading.value = false
  }
}

async function loadAvailable() {
  try {
    available.value = await api.projectAvailable(id)
  } catch {
    available.value = null
  }
}

onMounted(load)

/** 当前文档里实际存在的接口 ID（用于识别刷新后失效的绑定） */
const availableIdSet = computed(() => new Set((available.value?.interfaces || []).map((i: any) => i.id)))
const staleIds = computed(() =>
  available.value ? selectedIds.value.filter((x) => !availableIdSet.value.has(x)) : []
)

function keepAvailableOnly() {
  const removed = staleIds.value.length
  selectedIds.value = selectedIds.value.filter((x) => availableIdSet.value.has(x))
  ElMessage.success(`已移除 ${removed} 个当前文档中不存在的接口，记得点「保存勾选」`)
}

function toggleAll(checked: boolean) {
  const visible = filteredInterfaces.value.map((i) => i.id)
  if (checked) selectedIds.value = [...new Set([...selectedIds.value, ...visible])]
  else selectedIds.value = selectedIds.value.filter((x) => !visible.includes(x))
}

async function saveBind() {
  savingBind.value = true
  try {
    project.value = { ...project.value, ...(await api.projectBind(id, selectedIds.value)) }
    ElMessage.success(`已保存 ${selectedIds.value.length} 个接口到项目`)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '保存失败')
  } finally {
    savingBind.value = false
  }
}

async function pull() {
  if (!apifox.configured) {
    ElMessage.warning('请先在「数据导入」页完成全局 Apifox 连接')
    router.push('/import')
    return
  }
  pulling.value = true
  try {
    await apifox.pull(true)
    ElMessage.success(`已刷新 ${apifox.interfaces.length} 个接口（全局连接）`)
    await loadAvailable()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || err.message || '拉取接口失败')
  } finally {
    pulling.value = false
  }
}

async function doScan() {
  if (!scanPath.value.trim()) return ElMessage.warning('请选择代码目录')
  scanning.value = true
  try {
    const updated = await api.projectScan(id, { codePath: scanPath.value.trim(), serviceBaseUrl: scanBase.value.trim() })
    project.value = { ...project.value, ...updated }
    selectedGroups.value = groups.value.filter((g) => g.nodeCount > 0).map((g) => g.key)
    activeTab.value = 'business'
    ElMessage.success(`扫描完成：${updated.scan.scannedFiles} 个文件 / ${updated.scan.callCount} 个调用点 / 匹配率 ${updated.scan.matchRate}%`)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '扫描失败')
  } finally {
    scanning.value = false
  }
}

function openMapping(call: any) {
  mappingCall.value = call
  mappingId.value = call.matchedInterfaceId || ''
  mappingVisible.value = true
}

async function saveMapping() {
  if (!mappingCall.value) return
  try {
    const updated = await api.projectMap(id, { callId: mappingCall.value.id, interfaceId: mappingId.value })
    project.value = { ...project.value, ...updated }
    mappingVisible.value = false
    ElMessage.success(mappingId.value ? '已关联接口' : '已取消关联')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '关联失败')
  }
}

async function generate(all = false) {
  if (!all && !selectedGroups.value.length) return ElMessage.warning('请至少勾选一个业务功能')
  generating.value = true
  try {
    const data = await api.projectGenerate(id, all ? { all: true } : { groupKeys: selectedGroups.value })
    ElMessage.success(`已生成 ${data.flows.length} 条流程`)
    await load()
    activeTab.value = 'business'
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '生成流程失败')
  } finally {
    generating.value = false
  }
}

function openEdit() {
  editForm.name = project.value.name
  editForm.description = project.value.description || ''
  editForm.codePath = project.value.codePath || ''
  editForm.serviceBaseUrl = project.value.serviceBaseUrl || ''
  editVisible.value = true
}

function openPicker(target: 'scan' | 'edit') {
  pickerTarget.value = target
  pickerVisible.value = true
}

function onFolderPicked(path: string) {
  if (pickerTarget.value === 'edit') editForm.codePath = path
  else scanPath.value = path
}

function toggleGroup(key: string, checked: boolean) {
  if (checked) {
    if (!selectedGroups.value.includes(key)) selectedGroups.value.push(key)
  } else {
    selectedGroups.value = selectedGroups.value.filter((k) => k !== key)
  }
}

async function saveEdit() {
  try {
    const updated = await api.updateProject(id, {
      name: editForm.name,
      description: editForm.description,
      codePath: editForm.codePath,
      serviceBaseUrl: editForm.serviceBaseUrl,
    })
    project.value = { ...project.value, ...updated }
    scanPath.value = updated.codePath || ''
    scanBase.value = updated.serviceBaseUrl || ''
    editVisible.value = false
    ElMessage.success('已保存')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '保存失败')
  }
}

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
const matchTag = (rate?: number) => (rate >= 90 ? 'success' : rate >= 60 ? 'warning' : 'danger')
</script>

<template>
  <div v-loading="loading">
    <template v-if="project">
      <div class="page-header">
        <div>
          <div class="pd-title-line">
            <el-button text @click="router.push('/projects')">← 项目</el-button>
            <span class="page-title">{{ project.name }}</span>
            <el-tag v-if="scan" size="small" :type="matchTag(scan.matchRate)">调用匹配 {{ scan.matchRate }}%</el-tag>
          </div>
          <div class="page-sub">{{ project.description || '暂无描述' }} · 更新于 {{ fmt(project.updatedAt) }}</div>
        </div>
        <div class="page-actions">
          <el-button @click="openEdit">项目设置</el-button>
          <el-button @click="router.push('/flows')">流程管理</el-button>
        </div>
      </div>

      <div class="panel pd-brief">
        <div class="pdb-item">
          <span class="pdb-label">代码目录</span>
          <span class="pdb-value mono" :title="project.codePath">{{ project.codePath || '未关联' }}</span>
        </div>
        <div class="pdb-item">
          <span class="pdb-label">被测服务</span>
          <span class="pdb-value mono" :title="project.serviceBaseUrl">{{ project.serviceBaseUrl || '取接口文档地址' }}</span>
        </div>
        <div class="pdb-item">
          <span class="pdb-label">Apifox</span>
          <span class="pdb-value" :title="apifox.title">
            {{ apifox.configured ? `全局 · ${apifox.title || apifox.projectId || apifox.siteId}` : '未配置（去数据导入页设置）' }}
          </span>
        </div>
        <div class="pdb-item">
          <span class="pdb-label">已绑定接口</span>
          <span class="pdb-value">{{ project.interfaceIds?.length || 0 }} 个</span>
        </div>
      </div>

      <el-tabs v-model="activeTab" class="mt12 pd-tabs">
        <!-- ============ 1. 接口绑定 ============ -->
        <el-tab-pane label="① 绑定 Apifox 接口" name="interfaces">
          <div class="panel">
            <div class="bind-toolbar">
              <div class="bt-left">
                <el-select v-model="folderFilter" clearable placeholder="全部目录" style="width: 170px">
                  <el-option v-for="f in folders" :key="f" :label="f" :value="f" />
                </el-select>
                <el-input v-model="keyword" clearable placeholder="搜索路径 / 名称" style="width: 240px" />
                <el-checkbox
                  :model-value="filteredInterfaces.length > 0 && filteredInterfaces.every((i) => selectedIds.includes(i.id))"
                  @change="toggleAll(Boolean($event))"
                >全选当前列表</el-checkbox>
              </div>
              <div class="bt-right">
                <span class="muted">已选 {{ selectedIds.length }} / {{ interfaces.length }}</span>
                <span v-if="staleIds.length" class="stale-hint">
                  {{ staleIds.length }} 个已不在当前文档
                  <el-button link type="primary" @click="keepAvailableOnly">仅保留现有</el-button>
                </span>
                <el-button :loading="pulling" @click="pull">拉取 / 刷新接口</el-button>
                <el-button type="primary" :loading="savingBind" @click="saveBind">保存勾选</el-button>
              </div>
            </div>

            <div v-if="!available" class="pd-empty">
              <div>还没有可用的 Apifox 接口。</div>
              <div class="muted">接口来自<b>全局 Apifox 连接</b>，在「数据导入」页配置一次即可，所有项目共用。</div>
              <el-button type="primary" class="mt12" @click="router.push('/import')">去配置全局 Apifox</el-button>
            </div>

            <div v-else>
              <div class="bind-source muted">
                来源：{{ available.source === 'cache' ? '全局 Apifox 缓存' : '项目接口快照' }}
                · 全局连接：{{ apifox.title || apifox.projectId || apifox.siteId || '未配置' }}
                · 拉取时间 {{ fmt(available.fetchedAt) }}
                <span v-if="available.baseUrl"> · 服务地址 {{ available.baseUrl }}</span>
              </div>

              <el-checkbox-group v-model="selectedIds" class="iface-list">
                <div v-for="it in filteredInterfaces" :key="it.id" class="iface-row" :class="{ on: selectedIds.includes(it.id) }">
                  <el-checkbox :value="it.id" class="iface-check" />
                  <el-tag size="small" :type="(methodType[it.method] as any) || 'info'" class="iface-method">{{ it.method }}</el-tag>
                  <div class="iface-main">
                    <div class="iface-name">{{ it.name }}</div>
                    <div class="iface-path mono">{{ it.path }}</div>
                  </div>
                  <el-tag v-if="it.folder" size="small" type="info" effect="plain">{{ it.folder }}</el-tag>
                  <el-tag v-if="it.status === '已废弃' || it.deprecated" size="small" type="warning" effect="plain">已废弃</el-tag>
                </div>
                <div v-if="!filteredInterfaces.length" class="pd-empty">没有符合条件的接口</div>
              </el-checkbox-group>
            </div>

            <div class="muted mt12 global-hint">
              全局 Apifox 连接：
              <b>{{ apifox.configured ? apifox.title || apifox.projectId || apifox.siteId : '未配置' }}</b>
              · 连接参数只在「数据导入」页维护一次，所有项目共用同一份接口文档。
              <el-button link type="primary" @click="router.push('/import')">去配置 / 刷新</el-button>
            </div>
          </div>
        </el-tab-pane>

        <!-- ============ 2. 代码分析 ============ -->
        <el-tab-pane label="② 扫描代码调用流程" name="scan">
          <div class="panel">
            <div class="scan-line">
              <el-input v-model="scanPath" placeholder="本机前端工程绝对路径" />
              <el-button @click="openPicker('scan')">选择目录</el-button>
              <el-input v-model="scanBase" placeholder="被测服务地址（可留空）" style="width: 280px" />
              <el-button type="primary" :loading="scanning" @click="doScan">开始扫描</el-button>
            </div>
            <div class="muted mt12">只读本机目录做静态分析，不上传代码。扫描 axios / request / fetch 等 HTTP 调用点，并按路径匹配已绑定接口。</div>

            <template v-if="scan">
              <div class="scan-stats mt12">
                <div class="ss-item"><b>{{ scan.scannedFiles }}</b><span>扫描文件</span></div>
                <div class="ss-item"><b>{{ scan.callCount }}</b><span>调用点</span></div>
                <div class="ss-item"><b class="ok">{{ scan.matchedCalls }}</b><span>已匹配</span></div>
                <div class="ss-item"><b :class="{ bad: scan.unmatchedCalls > 0 }">{{ scan.unmatchedCalls }}</b><span>未匹配</span></div>
                <div class="ss-item"><b :class="matchTag(scan.matchRate) === 'success' ? 'ok' : 'bad'">{{ scan.matchRate }}%</b><span>匹配率</span></div>
                <div class="ss-item"><b>{{ scan.groups?.length || 0 }}</b><span>业务功能</span></div>
              </div>

              <div class="calls-head">
                <div class="ch-title">接口调用点（按源码文件 / 行号顺序）</div>
                <div class="ch-actions">
                  <el-checkbox v-model="showUnmatchedOnly">只看未匹配</el-checkbox>
                  <el-button size="small" @click="activeTab = 'business'">下一步：业务功能 →</el-button>
                </div>
              </div>

              <el-table :data="calls" size="small" height="440" border>
                <el-table-column label="调用" min-width="300">
                  <template #default="{ row }">
                    <div class="call-line">
                      <el-tag size="small" :type="(methodType[row.method] as any) || 'info'" effect="dark">{{ row.method || '??' }}</el-tag>
                      <span class="mono call-path">{{ row.path }}</span>
                    </div>
                    <div class="call-raw mono">{{ row.rawPath }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="源码位置" min-width="220">
                  <template #default="{ row }">
                    <div class="mono call-file">{{ row.file }}:{{ row.line }}</div>
                    <div class="muted">{{ row.functionName || '（文件顶层）' }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="匹配接口" min-width="240">
                  <template #default="{ row }">
                    <template v-if="row.matched">
                      <div class="call-matched">{{ row.matchedInterfaceName }}</div>
                      <div class="muted mono">{{ row.matchedInterfaceId }}</div>
                    </template>
                    <el-tag v-else size="small" type="danger" effect="plain">未匹配</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="置信度" width="110">
                  <template #default="{ row }">
                    <el-tag v-if="row.matched" size="small" :type="row.confidence === 'high' ? 'success' : row.confidence === 'manual' ? 'primary' : 'warning'">
                      {{ row.confidence === 'manual' ? '手动' : `${row.score}%` }}
                    </el-tag>
                    <span v-else class="muted">{{ row.score ? `${row.score}%` : '-' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="80" fixed="right">
                  <template #default="{ row }">
                    <el-button link type="primary" size="small" @click="openMapping(row)">关联</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </template>

            <div v-else class="pd-empty">
              <div>还没有扫描结果</div>
              <div class="muted">先绑定接口，再选择本机前端工程目录开始扫描。</div>
            </div>
          </div>
        </el-tab-pane>

        <!-- ============ 3. 业务功能与流程 ============ -->
        <el-tab-pane label="③ 业务功能闭环" name="business">
          <div class="panel">
            <div class="gen-head">
              <div>
                <div class="gen-title">业务功能划分</div>
                <div class="muted">优先按 Apifox 目录划分；没有目录时按接口路径首段 / 代码目录兜底。</div>
              </div>
              <div class="page-actions">
                <el-button :disabled="!scan" @click="generate(true)" :loading="generating">生成全量流程</el-button>
                <el-button type="primary" :disabled="!selectedGroups.length" :loading="generating" @click="generate(false)">
                  生成选中功能流程
                </el-button>
              </div>
            </div>

            <div v-if="groups.length" class="group-list mt12">
              <div v-for="g in groups" :key="g.key" class="group-card">
                <el-checkbox :model-value="selectedGroups.includes(g.key)" :disabled="!g.nodeCount" @change="(v: any) => toggleGroup(g.key, Boolean(v))" />
                <div class="gc-main">
                  <div class="gc-name">
                    {{ g.name }}
                    <el-tag size="small" effect="plain">{{ groupSourceText[g.source] || g.source }}</el-tag>
                  </div>
                  <div class="gc-files mono">{{ (g.files || []).slice(0, 3).join(' · ') }}{{ g.files?.length > 3 ? ' …' : '' }}</div>
                </div>
                <div class="gc-metrics">
                  <span><b>{{ g.nodeCount }}</b> 接口</span>
                  <span><b>{{ g.callCount }}</b> 调用</span>
                  <span><b>{{ g.fileCount }}</b> 文件</span>
                </div>
                <el-tag v-if="!g.nodeCount" size="small" type="warning" effect="plain">无可生成接口</el-tag>
              </div>
            </div>
            <div v-else class="pd-empty">
              <div>还没有业务功能划分</div>
              <div class="muted">先完成代码扫描。</div>
            </div>
          </div>

          <div class="panel mt12">
            <div class="gen-head">
              <div>
                <div class="gen-title">已生成流程</div>
                <div class="muted">流程节点按源码调用顺序排列，可直接执行做整体验收。</div>
              </div>
              <el-button @click="router.push('/flows')">全部流程</el-button>
            </div>
            <div v-if="flows.length" class="flow-list mt12">
              <div v-for="f in flows" :key="f.id" class="flow-row" @click="router.push(`/flows/${f.id}`)">
                <span class="fr-biz">{{ f.business || '未分类' }}</span>
                <span class="fr-name">{{ f.name }}</span>
                <span class="muted">{{ f.nodeCount }} 节点</span>
                <span class="muted">{{ fmt(f.updatedAt) }}</span>
                <el-button link type="primary">打开流程 →</el-button>
              </div>
            </div>
            <div v-else class="pd-empty">还没有生成流程，勾选上面的业务功能后生成。</div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <FolderPicker
        v-model="pickerVisible"
        :path="pickerTarget === 'edit' ? editForm.codePath : scanPath"
        @select="onFolderPicked"
      />

      <el-dialog v-model="mappingVisible" title="手动关联接口" width="520px">
        <div v-if="mappingCall" class="map-box">
          <div class="mono">{{ mappingCall.method }} {{ mappingCall.path }}</div>
          <div class="muted">{{ mappingCall.file }}:{{ mappingCall.line }}</div>
          <el-select v-model="mappingId" clearable filterable placeholder="选择要关联的接口（清空=取消关联）" class="mt12" style="width: 100%">
            <el-option v-for="it in interfaces" :key="it.id" :label="`${it.method} ${it.path}`" :value="it.id">
              <span>{{ it.method }} {{ it.path }}</span>
            </el-option>
          </el-select>
        </div>
        <template #footer>
          <el-button @click="mappingVisible = false">取消</el-button>
          <el-button type="primary" @click="saveMapping">保存关联</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="editVisible" title="项目设置" width="600px">
        <el-form :model="editForm" label-width="110px">
          <el-form-item label="项目名称"><el-input v-model="editForm.name" /></el-form-item>
          <el-form-item label="项目描述"><el-input v-model="editForm.description" type="textarea" :rows="2" /></el-form-item>
          <el-form-item label="代码目录">
            <div class="path-line">
              <el-input v-model="editForm.codePath" placeholder="本机前端工程绝对路径" />
              <el-button @click="openPicker('edit')">选择</el-button>
            </div>
          </el-form-item>
          <el-form-item label="被测服务地址"><el-input v-model="editForm.serviceBaseUrl" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="editVisible = false">取消</el-button>
          <el-button type="primary" @click="saveEdit">保存</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.pd-title-line { display: flex; align-items: center; gap: 10px; }
.pd-brief { display: flex; gap: 20px; flex-wrap: wrap; }
.pdb-item { display: flex; flex-direction: column; gap: 3px; min-width: 160px; flex: 1; }
.pdb-label { font-size: 11px; color: #909399; }
.pdb-value { font-size: 12px; color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: Consolas, 'Courier New', monospace; }
.pd-tabs :deep(.el-tabs__header) { margin-bottom: 12px; }
.bind-toolbar { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
.bt-left, .bt-right { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.stale-hint { color: #e6a23c; font-size: 12px; }
.bind-source { margin: 10px 0 6px; }
.iface-list { max-height: 460px; overflow: auto; border: 1px solid #ebeef5; border-radius: 8px; }
.iface-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 12px;
  border-bottom: 1px dashed #f0f2f5; font-size: 13px; cursor: pointer;
}
.iface-row:hover { background: #f5f7fa; }
.iface-row.on { background: #ecf5ff; box-shadow: inset 3px 0 0 #409eff; }
.iface-check { margin-right: 0; }
.iface-method { width: 62px; text-align: center; }
.iface-main { flex: 1; min-width: 0; }
.iface-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iface-path { font-size: 11px; color: #8a94a6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-empty { text-align: center; color: #909399; padding: 34px 10px; font-size: 13px; line-height: 1.9; }
.scan-line { display: flex; gap: 8px; flex-wrap: wrap; }
.scan-line > .el-input:first-child { flex: 1; min-width: 280px; }
.scan-stats { display: flex; gap: 10px; flex-wrap: wrap; }
.ss-item { flex: 1; min-width: 90px; background: #f7f8fa; border-radius: 8px; padding: 8px; text-align: center; display: flex; flex-direction: column; }
.ss-item b { font-size: 19px; }
.ss-item b.ok { color: #67c23a; }
.ss-item b.bad { color: #f56c6c; }
.ss-item span { font-size: 11px; color: #909399; }
.calls-head { display: flex; justify-content: space-between; align-items: center; margin: 14px 0 8px; gap: 10px; flex-wrap: wrap; }
.ch-title { font-size: 13px; font-weight: 700; }
.ch-actions { display: flex; gap: 10px; align-items: center; }
.call-line { display: flex; gap: 8px; align-items: center; }
.call-path { font-size: 12px; word-break: break-all; }
.call-raw { font-size: 11px; color: #b0b6bf; margin-top: 3px; }
.call-file { font-size: 11px; }
.call-matched { font-size: 12px; font-weight: 600; }
.gen-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.gen-title { font-size: 14px; font-weight: 700; }
.group-list { display: flex; flex-direction: column; gap: 8px; }
.group-card {
  display: flex; align-items: center; gap: 12px; border: 1px solid #ebeef5;
  border-radius: 8px; padding: 10px 12px;
}
.gc-main { flex: 1; min-width: 0; }
.gc-name { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.gc-files { font-size: 11px; color: #909399; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-metrics { display: flex; gap: 12px; font-size: 12px; color: #606266; }
.gc-metrics b { color: #303133; }
.flow-list { display: flex; flex-direction: column; }
.flow-row {
  display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px dashed #f0f2f5;
  font-size: 13px; cursor: pointer;
}
.flow-row:hover { background: #f5f7fa; }
.fr-biz { font-size: 11px; color: #409eff; background: #ecf5ff; border-radius: 4px; padding: 1px 8px; }
.fr-name { flex: 1; font-weight: 600; }
.map-box { font-size: 13px; }
.path-line { display: flex; gap: 8px; width: 100%; }
</style>
