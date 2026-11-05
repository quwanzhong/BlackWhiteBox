<script setup lang="ts">
import { reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FlowNode } from '../types/flow'

const props = defineProps<{ modelValue: boolean; node: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', node: FlowNode): void
}>()

const form = reactive<any>({
  id: '', name: '', actionType: 'http', method: 'GET', url: '', timeout: 15000,
  headersText: '', bodyText: '', hint: '', inputText: '',
  expectedStatus: 200, checks: [] as any[], extractRows: [] as any[],
  position: { x: 100, y: 100 },
})

function resetForm(n: any) {
  form.id = n.id
  form.name = n.name || ''
  form.actionType = n.action?.type || 'http'
  form.method = n.action?.method || 'GET'
  form.url = n.action?.url || ''
  form.timeout = n.action?.timeout || 15000
  form.headersText = JSON.stringify(n.action?.headers || {}, null, 2)
  form.bodyText = n.action?.body == null ? '' : JSON.stringify(n.action.body, null, 2)
  form.hint = n.action?.hint || ''
  form.inputText = n.input ? JSON.stringify(n.input, null, 2) : ''
  form.expectedStatus = n.expected?.status ?? 200
  form.checks = JSON.parse(JSON.stringify(n.expected?.checks || []))
  form.extractRows = Object.entries(n.extract || {}).map(([name, path]) => ({ name, path }))
  form.position = n.position || { x: 100, y: 100 }
}

watch(
  () => props.modelValue,
  (v) => { if (v && props.node) resetForm(props.node) }
)

function parseValueInput(raw: any) {
  if (typeof raw !== 'string') return raw
  const t = raw.trim()
  if (t === '') return ''
  try {
    const v = JSON.parse(t)
    if (typeof v === 'number' || typeof v === 'boolean' || v === null || typeof v === 'object') return v
  } catch { /* 保持字符串 */ }
  return raw
}

function addCheck() {
  form.checks.push({ type: 'json_path', label: '', path: '$.', op: 'eq', value: '' })
}
function removeCheck(i: number) {
  form.checks.splice(i, 1)
}
function addExtract() {
  form.extractRows.push({ name: '', path: '$.data.' })
}
function removeExtract(i: number) {
  form.extractRows.splice(i, 1)
}

function confirm() {
  if (!form.name.trim()) return ElMessage.warning('请填写节点名称')
  let headers: any = {}
  let body: any = null
  let input: any = null
  try { headers = form.headersText.trim() ? JSON.parse(form.headersText) : {} } catch { return ElMessage.error('请求头不是合法 JSON') }
  try { body = form.bodyText.trim() ? JSON.parse(form.bodyText) : null } catch { return ElMessage.error('请求体不是合法 JSON') }
  try { input = form.inputText.trim() ? JSON.parse(form.inputText) : null } catch { return ElMessage.error('期望输入不是合法 JSON') }

  const extract: Record<string, string> = {}
  for (const row of form.extractRows) {
    if (row.name && row.path) extract[row.name] = row.path
  }

  const node: FlowNode = {
    id: form.id,
    name: form.name.trim(),
    action:
      form.actionType === 'manual'
        ? { type: 'manual', hint: form.hint }
        : {
            type: 'http',
            method: form.method,
            url: form.url,
            headers,
            body,
            timeout: Number(form.timeout) || 15000,
          },
    input,
    expected: {
      status: Number(form.expectedStatus) || 200,
      checks: form.checks.map((c: any) => ({
        type: c.type || 'json_path',
        label: c.label || '',
        path: c.path || '',
        op: c.op || 'eq',
        value: parseValueInput(c.value),
      })),
    },
    extract,
    position: form.position,
  }
  emit('confirm', node)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="编辑节点"
    size="520px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-form label-width="90px" label-position="left">
      <el-form-item label="节点名称" required>
        <el-input v-model="form.name" placeholder="例如：用户登录" />
      </el-form-item>

      <el-form-item label="执行类型">
        <el-radio-group v-model="form.actionType">
          <el-radio-button value="http">HTTP 接口</el-radio-button>
          <el-radio-button value="manual">人工确认（白盒）</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="form.actionType === 'http'">
        <el-form-item label="请求方法">
          <el-select v-model="form.method" style="width: 140px">
            <el-option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']" :key="m" :label="m" :value="m" />
          </el-select>
          <span style="margin-left: 10px; font-size: 12px; color: #909399">超时</span>
          <el-input-number v-model="form.timeout" :min="1000" :step="1000" style="width: 130px; margin-left: 6px" />
          <span style="font-size: 12px; color: #909399; margin-left: 4px">ms</span>
        </el-form-item>
        <el-form-item label="请求地址">
          <el-input v-model="form.url" placeholder="https://api.example.com/order 或 {{baseUrl}}/order" />
        </el-form-item>
        <el-form-item label="请求头">
          <el-input v-model="form.headersText" type="textarea" :rows="3" placeholder="JSON 格式，例如 {&quot;Content-Type&quot;: &quot;application/json&quot;}" />
        </el-form-item>
        <el-form-item label="请求体">
          <el-input v-model="form.bodyText" type="textarea" :rows="5" placeholder="JSON 格式；GET 可留空。支持 {{变量名}}" />
        </el-form-item>
      </template>

      <el-form-item v-else label="检查提示">
        <el-input v-model="form.hint" type="textarea" :rows="3" placeholder="提示测试人员该步骤要检查哪些代码逻辑" />
      </el-form-item>

      <el-form-item label="期望输入">
        <el-input v-model="form.inputText" type="textarea" :rows="3" placeholder="JSON 格式，展示用（可选）" />
      </el-form-item>

      <template v-if="form.actionType === 'http'">
        <el-form-item label="期望状态码">
          <el-input-number v-model="form.expectedStatus" :min="100" :max="599" />
        </el-form-item>

        <el-form-item label="输出断言">
          <div style="width: 100%">
            <div v-for="(c, i) in form.checks" :key="i" class="check-editor-row">
              <el-select v-model="c.type" style="width: 108px" size="small">
                <el-option label="JSONPath" value="json_path" />
                <el-option label="响应包含" value="body_contains" />
              </el-select>
              <el-input v-if="c.type !== 'body_contains'" v-model="c.path" size="small" style="width: 130px" placeholder="$.data.id" />
              <el-select v-model="c.op" size="small" style="width: 96px">
                <el-option label="等于 eq" value="eq" />
                <el-option label="不等于 ne" value="ne" />
                <el-option label="存在 exists" value="exists" />
                <el-option label="正则 regex" value="regex" />
                <el-option label="大于 gt" value="gt" />
                <el-option label="小于 lt" value="lt" />
                <el-option label="包含 contains" value="contains" />
                <el-option label="类型 type" value="type" />
              </el-select>
              <el-input v-if="c.op !== 'exists'" v-model="c.value" size="small" style="width: 110px" placeholder="期望值" />
              <el-input v-model="c.label" size="small" style="width: 110px" placeholder="说明" />
              <el-button size="small" type="danger" plain @click="removeCheck(i)">删</el-button>
            </div>
            <el-button size="small" @click="addCheck">＋ 添加断言</el-button>
          </div>
        </el-form-item>
      </template>

      <el-form-item label="变量提取">
        <div style="width: 100%">
          <div v-for="(row, i) in form.extractRows" :key="i" class="check-editor-row">
            <el-input v-model="row.name" size="small" style="width: 120px" placeholder="变量名" />
            <span style="font-size: 12px; color: #909399">←</span>
            <el-input v-model="row.path" size="small" style="width: 190px" placeholder="$.data.token" />
            <el-button size="small" type="danger" plain @click="removeExtract(i)">删</el-button>
          </div>
          <el-button size="small" @click="addExtract">＋ 添加提取</el-button>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="confirm">确定</el-button>
    </template>
  </el-drawer>
</template>
