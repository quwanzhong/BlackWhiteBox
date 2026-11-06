<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useApifoxStore } from '../stores/apifox'
import type { FlowDsl } from '../types/flow'

const router = useRouter()
const apifox = useApifoxStore()

// ---------------- Apifox MCP 自动拉取（全局单例） ----------------
const showAdvanced = ref(false)

const testing = ref(false)
const pulling = ref(false)
const importing = ref(false)
const loadingCache = ref(false)

const interfaces = computed(() => apifox.interfaces)
const info = computed(() =>
  apifox.title
    ? {
        title: apifox.title,
        version: apifox.version,
        interfaceCount: apifox.interfaces.length,
        baseUrl: apifox.docBaseUrl,
      }
    : null
)
const fetchedAt = computed(() => apifox.fetchedAt)
const hasServerToken = computed(() => apifox.hasEnvToken || apifox.hasRuntimeToken)
const selectedIds = ref<string[]>([])

const keyword = ref('')
const methodFilter = ref('')
const flowName = ref('')
const targetBaseUrl = ref('')
const tableRef = ref<any>()

const filteredInterfaces = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return interfaces.value.filter((it) => {
    if (methodFilter.value && it.method !== methodFilter.value) return false
    if (!kw) return true
    return [it.path, it.name, it.folder, it.status, it.method]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(kw))
  })
})

/** 首次拿到文档信息时给表单填默认值 */
function syncDocDefaults() {
  if (!flowName.value && apifox.title) flowName.value = `${apifox.title} 黑盒流程`
  if (!targetBaseUrl.value) targetBaseUrl.value = apifox.docBaseUrl
}

function checkConnectionFields() {
  if (!apifox.configured) {
    ElMessage.warning('请填写 Apifox 项目 ID（或在线文档 site-id）')
    return false
  }
  if (apifox.projectId && !apifox.ready) {
    ElMessage.warning('请填写 Apifox 访问令牌（APIFOX_ACCESS_TOKEN）')
    return false
  }
  return true
}

async function testConnection() {
  if (!checkConnectionFields()) return
  testing.value = true
  try {
    const res = await apifox.test()
    syncDocDefaults()
    ElMessage.success(
      `连接成功：${res.title || '未命名项目'}${res.version ? `（v${res.version}）` : ''}，识别到 ${res.interfaceCount} 个接口`
    )
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || '连接失败')
  } finally {
    testing.value = false
  }
}

async function pullInterfaces() {
  if (!checkConnectionFields()) return
  pulling.value = true
  try {
    const res = await apifox.pull(true)
    selectedIds.value = []
    tableRef.value?.clearSelection?.()
    syncDocDefaults()
    ElMessage.success(`已拉取 ${res.interfaces?.length || 0} 个接口（来自「${res.title || 'Apifox'}」）`)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || '拉取接口失败')
  } finally {
    pulling.value = false
  }
}

async function loadCachedInterfaces() {
  loadingCache.value = true
  try {
    await apifox.ensureLoaded()
    syncDocDefaults()
  } finally {
    loadingCache.value = false
  }
}

function onSelectionChange(rows: any[]) {
  selectedIds.value = rows.map((r) => r.id)
}

function selectAllFiltered() {
  const current = new Set(selectedIds.value)
  for (const it of filteredInterfaces.value) current.add(it.id)
  selectedIds.value = [...current]
  // 通过行数据同步给表格
  const rows = interfaces.value.filter((it) => current.has(it.id))
  tableRef.value?.clearSelection?.()
  for (const row of rows) tableRef.value?.toggleRowSelection?.(row, true)
}

function clearSelection() {
  selectedIds.value = []
  tableRef.value?.clearSelection?.()
}

async function generateFlow() {
  if (!selectedIds.value.length) return ElMessage.warning('请先勾选要生成流程的接口')
  importing.value = true
  try {
    const { flows } = await api.apifoxImport({
      ...apifox.connPayload(),
      ids: selectedIds.value,
      name: flowName.value.trim() || undefined,
      baseUrl: targetBaseUrl.value.trim() || undefined,
      refresh: false,
    })
    ElMessage.success(`已生成黑盒流程（${flows?.[0]?.nodes?.length || 0} 个节点）`)
    if (flows?.[0]?.id) router.push(`/flows/${flows[0].id}`)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || '生成流程失败')
  } finally {
    importing.value = false
  }
}

function methodTagType(method: string) {
  switch (method) {
    case 'GET':
      return 'primary'
    case 'POST':
      return 'success'
    case 'PUT':
      return 'warning'
    case 'PATCH':
      return 'warning'
    case 'DELETE':
      return 'danger'
    default:
      return 'info'
  }
}

function formatTime(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(async () => {
  // 全局单例：配置与缓存只加载一次，项目页 / 黑盒页共用
  await loadCachedInterfaces()
})

// ---------------- 备用：手动 OpenAPI 导入 ----------------
const openApiText = ref('')
const openApiName = ref('')
const openApiParsing = ref(false)
const openApiFlow = ref<FlowDsl | null>(null)
const fileInput = ref<HTMLInputElement>()
const fallback = ref<string>('')

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement)?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    openApiText.value = String(reader.result || '')
    if (!openApiName.value) openApiName.value = file.name.replace(/\.json$/i, '')
  }
  reader.readAsText(file, 'utf-8')
}

async function parseOpenApi() {
  let spec: any
  try {
    spec = JSON.parse(openApiText.value)
  } catch {
    return ElMessage.error('内容不是合法 JSON，请粘贴 Apifox 导出的 OpenAPI JSON')
  }
  openApiParsing.value = true
  try {
    const { flow } = await api.importOpenApi(spec, openApiName.value.trim() || undefined)
    openApiFlow.value = flow
    openApiName.value = flow.name
    ElMessage.success(`解析成功：${flow.nodes.length} 个接口节点`)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '解析失败')
  } finally {
    openApiParsing.value = false
  }
}

async function saveOpenApiFlow() {
  if (!openApiFlow.value) return
  const flow = await api.createFlow({ ...openApiFlow.value, name: openApiName.value.trim() || openApiFlow.value.name })
  ElMessage.success('已保存，正在打开流程画布')
  router.push(`/flows/${flow.id}`)
}

// ---------------- 白盒调用链导入 ----------------
const whiteboxText = ref('')
const whiteboxSaving = ref(false)

async function importWhitebox() {
  let data: any
  try {
    data = JSON.parse(whiteboxText.value)
  } catch {
    return ElMessage.error('内容不是合法 JSON，请粘贴 java-analyzer 输出的调用链 JSON')
  }
  whiteboxSaving.value = true
  try {
    const { flows } = await api.importWhitebox(data)
    ElMessage.success(`已导入 ${flows.length} 条白盒调用链`)
    if (flows.length) router.push(`/flows/${flows[0].id}`)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || '导入失败')
  } finally {
    whiteboxSaving.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">数据导入</div>
        <div class="page-sub">
          全局 Apifox 连接只配置一次，黑盒导入与项目绑定接口共用；黑盒：勾选接口生成流程，白盒：从 Java 分析器生成调用链流程
        </div>
      </div>
    </div>

    <!-- Apifox MCP 主通道 -->
    <div class="import-card mcp-card">
      <div class="mcp-head">
        <div>
          <h3>⬛ 全局 Apifox 连接（MCP 自动拉取 · 推荐）</h3>
          <div class="desc" style="margin-bottom: 0">
            后端通过官方 <code>apifox-mcp-server</code> 直连你的 Apifox 项目，实时读取接口文档，
            无需每次导出 JSON。<b>全局只需配置一次</b>：黑盒导入与项目绑定接口共用同一份连接和接口列表。
            令牌仅用于本次连接，不写入配置文件。
          </div>
        </div>
        <el-tag v-if="hasServerToken && !apifox.token" type="success" effect="plain">后端已配置令牌</el-tag>
      </div>

      <div class="mcp-form">
        <div class="field">
          <label>项目 ID <span class="req">*</span></label>
          <el-input v-model="apifox.projectId" placeholder="Apifox → 项目设置 → 基本设置 → 项目 ID" clearable />
        </div>
        <div class="field">
          <label>访问令牌 <span class="req">*</span></label>
          <el-input
            v-model="apifox.token"
            type="password"
            show-password
            placeholder="Apifox → 账号设置 → API 访问令牌"
            clearable
          />
        </div>
        <div class="field field-actions">
          <el-button type="primary" :loading="testing" @click="testConnection">测试连接</el-button>
          <el-button type="success" :loading="pulling" @click="pullInterfaces">拉取接口列表</el-button>
        </div>
      </div>

      <div class="mcp-extra">
        <el-button link type="primary" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起高级选项' : '高级选项（私有化部署 / 在线文档 / 分支）' }}
        </el-button>
        <el-checkbox v-model="apifox.rememberToken" style="margin-left: 8px" @change="apifox.persistLocal()">
          记住令牌（仅本机浏览器 localStorage）
        </el-checkbox>
        <span v-if="loadingCache" class="muted" style="margin-left: 8px">正在读取本机缓存…</span>
      </div>

      <el-collapse-transition>
        <div v-show="showAdvanced" class="mcp-advanced">
          <div class="field">
            <label>在线文档 site-id</label>
            <el-input v-model="apifox.siteId" placeholder="公开在线文档模式：填 site-id，可留空令牌" clearable />
          </div>
          <div class="field">
            <label>迭代分支 ID</label>
            <el-input v-model="apifox.branchId" placeholder="可选，读取指定迭代分支" clearable />
          </div>
          <div class="field">
            <label>私有化 API 地址</label>
            <el-input v-model="apifox.baseUrl" placeholder="可选，如 https://apifox.mycompany.com" clearable />
          </div>
        </div>
      </el-collapse-transition>

      <el-alert
        v-if="info?.title"
        type="success"
        :closable="false"
        class="mcp-info"
        :title="`已连接：${info.title}${info.version ? `（v${info.version}）` : ''}`"
        :description="`接口数：${interfaces.length || info.interfaceCount || 0}${info.baseUrl ? ` · 服务地址：${info.baseUrl}` : ''}${fetchedAt ? ` · 拉取时间：${formatTime(fetchedAt)}` : ''}`"
      />

      <template v-if="interfaces.length">
        <div class="iface-toolbar">
          <el-input v-model="keyword" placeholder="搜索路径 / 名称 / 目录" clearable style="width: 240px" />
          <el-select v-model="methodFilter" placeholder="全部方法" clearable style="width: 130px">
            <el-option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']" :key="m" :label="m" :value="m" />
          </el-select>
          <el-button size="small" @click="selectAllFiltered">全选当前筛选</el-button>
          <el-button size="small" @click="clearSelection">清空选择</el-button>
          <span class="muted">
            已选 <b>{{ selectedIds.length }}</b> / {{ interfaces.length }}，当前筛选 {{ filteredInterfaces.length }} 个
          </span>
        </div>

        <el-table
          ref="tableRef"
          :data="filteredInterfaces"
          row-key="id"
          size="small"
          border
          max-height="360"
          class="preview-table"
          @selection-change="onSelectionChange"
        >
          <el-table-column type="selection" width="42" reserve-selection />
          <el-table-column label="方法" width="86">
            <template #default="{ row }">
              <el-tag :type="methodTagType(row.method)" size="small" effect="dark">{{ row.method }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="path" label="路径" min-width="190" show-overflow-tooltip />
          <el-table-column prop="name" label="接口名称" min-width="170" show-overflow-tooltip />
          <el-table-column prop="folder" label="目录" width="110" show-overflow-tooltip />
          <el-table-column prop="status" label="状态" width="90" />
        </el-table>

        <div class="mcp-generate">
          <div class="field">
            <label>流程名称</label>
            <el-input v-model="flowName" placeholder="生成的黑盒流程名称" style="width: 260px" />
          </div>
          <div class="field">
            <label>被测服务地址（baseUrl）</label>
            <el-input v-model="targetBaseUrl" placeholder="留空则使用文档中的 servers 地址" style="width: 340px" clearable />
          </div>
          <el-button type="primary" :loading="importing" @click="generateFlow">
            用选中的 {{ selectedIds.length }} 个接口生成黑盒流程
          </el-button>
        </div>
      </template>
      <div v-else class="mcp-empty">
        填写项目 ID 与令牌后点击「测试连接」，再点「拉取接口列表」。首次拉取会从 Apifox 下载最新接口文档。
      </div>
    </div>

    <!-- 备用通道 -->
    <el-collapse v-model="fallback" class="fallback-collapse">
      <el-collapse-item name="fallback">
        <template #title>
          <span class="fallback-title">备用导入通道（手动 JSON 导入）</span>
        </template>
        <div class="import-grid">
          <!-- OpenAPI -->
          <div class="import-card">
            <h3>⬛ Apifox / OpenAPI 文件导入（黑盒）</h3>
            <div class="desc">
              仅在无法直连 MCP 时使用：<b>项目设置 → 导出数据 → OpenAPI(Swagger)</b>，导出 JSON 后粘贴或上传。
              解析后每个接口生成一个黑盒流程节点，可在画布上继续编排与配置理想输出。
            </div>
            <div class="upload-line">
              <input ref="fileInput" type="file" accept=".json" style="display: none" @change="onFileChange" />
              <el-button @click="fileInput?.click()">选择 JSON 文件</el-button>
              <span class="muted">或直接粘贴到下方文本框</span>
            </div>
            <el-input v-model="openApiText" type="textarea" :rows="8" placeholder='粘贴 OpenAPI JSON，例如 { "openapi": "3.0.1", "paths": { ... } }' />
            <div class="upload-line" style="margin-top: 10px">
              <el-input v-model="openApiName" style="width: 220px" placeholder="流程名称" />
              <el-button type="primary" :loading="openApiParsing" @click="parseOpenApi">解析预览</el-button>
            </div>

            <template v-if="openApiFlow">
              <el-alert type="success" :closable="false" style="margin-top: 6px">
                解析出 {{ openApiFlow.nodes.length }} 个接口节点（baseUrl：{{ openApiFlow.variables?.baseUrl || '未配置' }}）
              </el-alert>
              <el-table :data="openApiFlow.nodes" size="small" border class="preview-table" max-height="240">
                <el-table-column prop="name" label="接口" min-width="150" />
                <el-table-column prop="action.method" label="方法" width="80" />
                <el-table-column prop="action.url" label="路径" min-width="180" show-overflow-tooltip />
              </el-table>
              <el-button type="primary" style="margin-top: 10px" @click="saveOpenApiFlow">保存为黑盒流程并打开画布</el-button>
            </template>
          </div>

          <!-- 白盒 -->
          <div class="import-card">
            <h3>⬜ 白盒调用链导入（Java）</h3>
            <div class="desc">
              使用项目自带的 <code>analyzers/java-analyzer</code> 分析 Java 工程生成调用链 JSON（用法见 README），
              把输出的 JSON 粘贴到下面，即可生成白盒流程（人工逐步确认模式）。
            </div>
            <el-input v-model="whiteboxText" type="textarea" :rows="12" placeholder='粘贴 java-analyzer 输出，例如 { "flows": [ { "entry": "OrderController#create", "nodes": [...], "edges": [...] } ] }' />
            <el-button type="primary" style="margin-top: 10px" :loading="whiteboxSaving" @click="importWhitebox">
              解析并保存为白盒流程
            </el-button>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<style scoped>
.mcp-card {
  border: 1px solid #d9ecff;
  box-shadow: 0 2px 10px rgba(64, 158, 255, 0.08);
}
.mcp-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.mcp-head h3 {
  margin: 0 0 6px;
}
.mcp-form {
  display: grid;
  grid-template-columns: 1fr 1.3fr auto;
  gap: 12px;
  align-items: end;
  margin-top: 14px;
}
@media (max-width: 1100px) {
  .mcp-form {
    grid-template-columns: 1fr;
  }
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field label {
  font-size: 12px;
  color: #606266;
  font-weight: 600;
}
.req {
  color: #f56c6c;
}
.field-actions {
  flex-direction: row;
  gap: 8px;
}
.mcp-extra {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 8px;
}
.mcp-advanced {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  padding: 12px;
  margin-top: 8px;
  background: #f7f9fc;
  border-radius: 8px;
}
@media (max-width: 1100px) {
  .mcp-advanced {
    grid-template-columns: 1fr;
  }
}
.mcp-info {
  margin: 12px 0 0;
}
.iface-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.mcp-generate {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #ebeef5;
}
.mcp-empty {
  margin-top: 12px;
  padding: 14px;
  background: #f7f9fc;
  border-radius: 8px;
  color: #909399;
  font-size: 12px;
  line-height: 1.7;
}
.fallback-collapse {
  margin-top: 14px;
  background: #fff;
  border-radius: 10px;
  padding: 0 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
.fallback-title {
  font-size: 13px;
  font-weight: 600;
  color: #606266;
}
</style>
