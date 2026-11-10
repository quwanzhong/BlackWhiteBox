<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

/** 与后端 environments/service.js 保持同一口径，先在本地给可读提示，服务端仍会二次校验 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/

const environments = ref<any[]>([])
const projects = ref<any[]>([])
const loading = ref(false)
const projectFilter = ref('')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const activeTab = ref('variables')
const form = reactive({ name: '', projectId: '', baseUrl: '' })

const variables = ref<Array<{ key: string; value: string }>>([])
const headers = ref<Array<{ key: string; value: string }>>([])
const secretKeys = ref<string[]>([])
const removedSecretKeys = ref<string[]>([])
const pendingSecrets = ref<Record<string, string>>({})
const newSecretKey = ref('')
const newSecretValue = ref('')

const previewVisible = ref(false)
const preview = ref<any>(null)

async function load() {
  loading.value = true
  try {
    environments.value = await api.listEnvironments(projectFilter.value || undefined)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '加载环境失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  try {
    projects.value = await api.listProjects()
  } catch {
    projects.value = []
  }
})

const projectName = (id?: string | null) =>
  id ? projects.value.find((p) => p.id === id)?.name || id.slice(0, 8) : '全局'

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')

const varCount = (env: any) => Object.keys(env.variables || {}).length

/** 保存时把字符串转回 JSON 字面量：数字/布尔/对象/数组，其余保持字符串 */
function coerce(raw: string) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) || ['true', 'false', 'null'].includes(text) || /^[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return raw
    }
  }
  return raw
}

function stringifyValue(value: any) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 行编辑 → 对象。空键名跳过；重复键后写覆盖先写（与后端对象语义一致）。
 * @param rows 行数据
 * @param kind variables | headers
 */
function rowsToObject(rows: Array<{ key: string; value: string }>, kind: 'variables' | 'headers') {
  const out: Record<string, any> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    const valid = kind === 'variables' ? KEY_RE.test(key) : HEADER_RE.test(key)
    if (!valid) {
      throw new Error(
        kind === 'variables'
          ? `变量名「${key}」不合法：须以字母/下划线开头，仅含字母、数字、下划线，最长 64 字符`
          : `Header 名「${key}」不合法：只允许 RFC 7230 token 字符`
      )
    }
    if (seen.has(key)) throw new Error(`键名「${key}」重复，请合并后再保存`)
    seen.add(key)
    if (kind === 'variables') {
      out[key] = coerce(row.value)
    } else {
      const text = String(row.value ?? '')
      if (/[\r\n]/.test(text)) throw new Error(`Header「${key}」的值不允许包含换行`)
      out[key] = text
    }
  }
  return out
}

function openCreate() {
  editingId.value = null
  form.name = ''
  form.projectId = projectFilter.value || ''
  form.baseUrl = ''
  variables.value = [{ key: 'basePath', value: '/api' }]
  headers.value = []
  secretKeys.value = []
  removedSecretKeys.value = []
  pendingSecrets.value = {}
  newSecretKey.value = ''
  newSecretValue.value = ''
  activeTab.value = 'variables'
  dialogVisible.value = true
}

function openEdit(env: any) {
  editingId.value = env.id
  form.name = env.name
  form.projectId = env.projectId || ''
  form.baseUrl = env.baseUrl || ''
  variables.value = Object.entries(env.variables || {}).map(([key, value]) => ({
    key,
    value: stringifyValue(value),
  }))
  headers.value = Object.entries(env.headers || {}).map(([key, value]) => ({ key, value: String(value) }))
  secretKeys.value = [...(env.secretKeys || [])]
  removedSecretKeys.value = []
  pendingSecrets.value = {}
  newSecretKey.value = ''
  newSecretValue.value = ''
  activeTab.value = 'variables'
  dialogVisible.value = true
}

function stageSecret() {
  const key = newSecretKey.value.trim()
  if (!key) return ElMessage.warning('请填写密钥名')
  if (!KEY_RE.test(key)) return ElMessage.warning('密钥名须以字母/下划线开头，仅含字母、数字、下划线')
  if (!newSecretValue.value) return ElMessage.warning('请填写密钥值')
  pendingSecrets.value[key] = newSecretValue.value
  newSecretKey.value = ''
  newSecretValue.value = ''
}

function unstageSecret(key: string) {
  delete pendingSecrets.value[key]
}

function removeSecret(key: string) {
  secretKeys.value = secretKeys.value.filter((k) => k !== key)
  removedSecretKeys.value = [...removedSecretKeys.value, key]
}

async function save() {
  if (!form.name.trim()) return ElMessage.warning('请填写环境名称')
  let variablesObj: Record<string, any>
  let headersObj: Record<string, string>
  try {
    variablesObj = rowsToObject(variables.value, 'variables')
    headersObj = rowsToObject(headers.value, 'headers')
  } catch (err: any) {
    return ElMessage.warning(err?.message || '变量/请求头填写有误')
  }

  const clash = Object.keys(variablesObj).filter(
    (key) => secretKeys.value.includes(key) || Object.hasOwn(pendingSecrets.value, key)
  )
  if (clash.length) {
    return ElMessage.warning(`变量与密钥键名冲突：${clash.join('、')}（请改名或删除其中一个）`)
  }

  const payload = {
    name: form.name.trim(),
    projectId: form.projectId || null,
    baseUrl: form.baseUrl.trim(),
    variables: variablesObj,
    headers: headersObj,
  }

  saving.value = true
  try {
    let env = editingId.value
      ? await api.updateEnvironment(editingId.value, payload)
      : await api.createEnvironment(payload)
    for (const key of removedSecretKeys.value) {
      try {
        env = await api.deleteEnvironmentSecret(env.id, key)
      } catch (err: any) {
        if (err?.response?.status !== 404) throw err
      }
    }
    for (const [key, value] of Object.entries(pendingSecrets.value)) {
      env = await api.setEnvironmentSecret(env.id, key, value)
    }
    dialogVisible.value = false
    ElMessage.success(editingId.value ? '环境已更新' : '环境已创建')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(env: any) {
  try {
    await ElMessageBox.confirm(
      `确认删除环境「${env.name}」？该环境下的密钥会一并删除，已产生的执行记录保留。`,
      '删除环境',
      { type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await api.deleteEnvironment(env.id)
    ElMessage.success('已删除')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

async function openPreview(env: any) {
  try {
    preview.value = await api.resolveEnvironment(env.id)
    previewVisible.value = true
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '预览失败')
  }
}

const isSecret = (key: string) => (preview.value?.secretKeys || []).includes(key)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">环境管理</div>
        <div class="page-sub">
          一个环境 = 服务地址 + 普通变量 + 全局请求头 + 加密密钥。执行流程时选择环境，即可切换被测地址与凭据。
        </div>
      </div>
      <div class="page-actions">
        <el-select
          v-model="projectFilter"
          class="filter-select"
          clearable
          placeholder="全部项目"
          @change="load"
        >
          <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-button type="primary" @click="openCreate">+ 新建环境</el-button>
      </div>
    </div>

    <div class="panel tip-panel">
      <div>
        <b>变量优先级（低 → 高）</b>：流程变量 → 环境变量/密钥 → 执行时传入 → 运行中 extract。
      </div>
      <div>
        <b>密钥（secrets）</b>：AES-256-GCM 加密落库，接口只回显键名；执行记录与事件流里按明文掩码为
        <code>***</code>。
      </div>
      <div>
        <b>请求头</b>：环境头作为默认值，节点同名头覆盖；头部值里同样支持 <code v-pre>{{ var }}</code> 插值。
      </div>
    </div>

    <div class="panel mt12">
      <el-table v-loading="loading" :data="environments" empty-text="还没有环境，先新建一个">
        <el-table-column label="名称" min-width="180">
          <template #default="{ row }">
            <div class="env-name">{{ row.name }}</div>
            <el-tag size="small" type="info">v{{ row.version }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="项目" min-width="120">
          <template #default="{ row }">{{ projectName(row.projectId) }}</template>
        </el-table-column>
        <el-table-column label="baseUrl" min-width="220">
          <template #default="{ row }">
            <span class="mono">{{ row.baseUrl || '未设置（节点需写全地址）' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="变量 / 密钥" min-width="150">
          <template #default="{ row }">
            <span class="muted">{{ varCount(row) }} 变量</span>
            <span class="muted"> · {{ row.secretKeys?.length || 0 }} 密钥</span>
            <div class="key-tags">
              <el-tag v-for="key in row.secretKeys" :key="key" size="small" type="warning" effect="plain">
                {{ key }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }"><span class="muted">{{ fmt(row.updatedAt) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button text size="small" @click="openPreview(row)">预览</el-button>
            <el-button text size="small" type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button text size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑环境' : '新建环境'"
      width="780px"
      top="6vh"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="96px">
        <el-form-item label="环境名称" required>
          <el-input v-model="form.name" maxlength="60" placeholder="例如：开发 / 测试 / 预发" />
        </el-form-item>
        <el-form-item label="所属项目">
          <el-select v-model="form.projectId" clearable placeholder="全局（所有项目可用）" class="full">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="baseUrl">
          <el-input v-model="form.baseUrl" placeholder="例如：http://127.0.0.1:8080" />
          <div class="muted">节点写相对路径时会拼到这里；留空则节点必须写完整地址。</div>
        </el-form-item>
      </el-form>

      <el-tabs v-model="activeTab" class="env-tabs">
        <el-tab-pane :label="`变量 (${variables.length})`" name="variables">
          <div class="kv-row kv-head"><span>键名</span><span>值</span><span /></div>
          <div v-for="(row, idx) in variables" :key="`v-${idx}`" class="kv-row">
            <el-input v-model="row.key" placeholder="region" />
            <el-input v-model="row.value" placeholder="cn（数字/布尔/JSON 按字面量保存）" />
            <el-button text type="danger" @click="variables.splice(idx, 1)">删除</el-button>
          </div>
          <el-button text type="primary" @click="variables.push({ key: '', value: '' })">
            + 添加变量
          </el-button>
          <div class="muted">
            执行时用 <code v-pre>{{ var }}</code> 引用；与密钥同名的变量会被拒绝，避免取值歧义。
          </div>
        </el-tab-pane>

        <el-tab-pane :label="`请求头 (${headers.length})`" name="headers">
          <div class="kv-row kv-head"><span>Header</span><span>值</span><span /></div>
          <div v-for="(row, idx) in headers" :key="`h-${idx}`" class="kv-row">
            <el-input v-model="row.key" placeholder="Content-Type" />
            <el-input v-model="row.value" placeholder="application/json 或 Bearer {{apiKey}}" />
            <el-button text type="danger" @click="headers.splice(idx, 1)">删除</el-button>
          </div>
          <el-button text type="primary" @click="headers.push({ key: '', value: '' })">
            + 添加请求头
          </el-button>
        </el-tab-pane>

        <el-tab-pane label="密钥" name="secrets">
          <div v-for="key in secretKeys" :key="`s-${key}`" class="secret-row">
            <el-tag type="warning" effect="plain">{{ key }}</el-tag>
            <span class="muted">已加密存储（值不可回显）</span>
            <el-button text type="danger" size="small" @click="removeSecret(key)">删除</el-button>
          </div>
          <div v-for="(value, key) in pendingSecrets" :key="`p-${key}`" class="secret-row">
            <el-tag type="warning">{{ key }}</el-tag>
            <span class="muted">待保存（已输入 {{ value.length }} 字符，不显示明文）</span>
            <el-button text type="danger" size="small" @click="unstageSecret(String(key))">移除</el-button>
          </div>
          <div class="kv-row">
            <el-input v-model="newSecretKey" placeholder="密钥名，例如 apiKey" />
            <el-input
              v-model="newSecretValue"
              type="password"
              show-password
              placeholder="密钥值（保存后不回显）"
            />
            <el-button @click="stageSecret">加入</el-button>
          </div>
          <div class="muted">
            密钥只在执行时于内存解密，用于替换 <code v-pre>{{ key }}</code>；不落明文、不进事件与执行详情。
          </div>
        </el-tab-pane>
      </el-tabs>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="环境预览" width="720px" top="8vh">
      <template v-if="preview">
        <div class="preview-line">
          <span class="muted">baseUrl</span>
          <span class="mono">{{ preview.resolved?.baseUrl || '未设置' }}</span>
        </div>
        <div class="preview-line">
          <span class="muted">版本</span>
          <span>v{{ preview.version }} · {{ projectName(preview.projectId) }}</span>
        </div>
        <el-divider content-position="left">合并后的变量（密钥已打码）</el-divider>
        <el-table :data="Object.entries(preview.resolved?.variables || {})" size="small" max-height="260">
          <el-table-column label="键名" width="200">
            <template #default="{ row }">
              <span class="mono">{{ row[0] }}</span>
              <el-tag v-if="isSecret(row[0])" size="small" type="warning">secret</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="值">
            <template #default="{ row }"><span class="mono">{{ row[1] }}</span></template>
          </el-table-column>
        </el-table>
        <el-divider content-position="left">全局请求头</el-divider>
        <el-table :data="Object.entries(preview.resolved?.headers || {})" size="small" max-height="180">
          <el-table-column label="Header" width="200">
            <template #default="{ row }"><span class="mono">{{ row[0] }}</span></template>
          </el-table-column>
          <el-table-column label="值">
            <template #default="{ row }"><span class="mono">{{ row[1] }}</span></template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button type="primary" @click="previewVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tip-panel { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #606266; line-height: 1.7; }
.tip-panel code { background: #f4f6f8; border-radius: 3px; padding: 1px 4px; }
.filter-select { width: 190px; }
.env-name { font-weight: 600; margin-bottom: 4px; }
.key-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.mono { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; }
.full { width: 100%; }
.env-tabs { margin-top: 4px; }
.kv-row { display: grid; grid-template-columns: 220px 1fr 56px; gap: 8px; align-items: center; margin-bottom: 8px; }
.kv-head { font-size: 12px; color: #909399; margin-bottom: 4px; }
.secret-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.preview-line { display: flex; gap: 12px; font-size: 13px; margin-bottom: 6px; }
</style>
