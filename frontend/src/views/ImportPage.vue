<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { FlowDsl } from '../types/flow'

const router = useRouter()

// ---------------- OpenAPI / Apifox 导入 ----------------
const openApiText = ref('')
const openApiName = ref('')
const openApiParsing = ref(false)
const openApiFlow = ref<FlowDsl | null>(null)
const fileInput = ref<HTMLInputElement>()

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
        <div class="page-sub">黑盒：从 Apifox/OpenAPI 生成接口流程；白盒：从 Java 分析器生成调用链流程</div>
      </div>
    </div>

    <div class="import-grid">
      <!-- OpenAPI -->
      <div class="import-card">
        <h3>⬛ Apifox / OpenAPI 导入（黑盒）</h3>
        <div class="desc">
          在 Apifox 中：<b>项目设置 → 导出数据 → OpenAPI(Swagger) 格式</b>，导出 JSON 后粘贴或上传到下面。
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
  </div>
</template>
