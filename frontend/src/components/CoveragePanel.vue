<script setup lang="ts">
/**
 * 覆盖率面板（M3-3）
 *
 * 左侧文件列表（未覆盖行多的在前），右侧源码视图：
 *   - 绿色行 = 本节点命中，红色行 = 该节点执行时没走到；
 *   - 打开即定位到第一处未覆盖行，支持前后跳转；
 *   - 「复制位置」给 `path:line`，方便贴到 IDE/缺陷单里直接跳。
 * 源码由后端按执行时的 sourcefiles 快照读取，前端不拼路径。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { coverageBadge, fileRows, firstUncovered, fmtPct, stepUncovered } from '../utils/coverage'

const props = defineProps<{
  modelValue: boolean
  executionId: string
  row: any
  nodeName?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const files = computed(() => fileRows(props.row?.result))
const badge = computed(() => coverageBadge(props.row))
const activePath = ref('')
const source = ref<any>(null)
const loading = ref(false)
const error = ref('')
const currentLine = ref(1)
const codeRef = ref<HTMLElement>()
/** 防止快速切文件时旧请求后到，把新文件内容覆盖掉 */
let loadSeq = 0

const statusText = computed(() => {
  if (!props.row) return '无记录'
  if (props.row.status === 'analyzed') return '已分析'
  if (props.row.status === 'unavailable') return '无证据'
  if (props.row.error) return '分析失败'
  return '待分析'
})

function resetToFirstFile() {
  activePath.value = files.value[0]?.path || ''
  source.value = null
  error.value = ''
  currentLine.value = 1
}

watch(
  () => [props.modelValue, props.row?.nodeId] as const,
  ([open]) => {
    if (!open) return
    const nextPath = files.value[0]?.path || ''
    const changed = nextPath !== activePath.value
    resetToFirstFile()
    // activePath 变化会由下面的 watch 触发 load；没变（同一节点重开）则直接读
    if (!changed) load()
  },
  { immediate: true }
)

watch(activePath, (value) => {
  if (props.modelValue && value) load()
})

async function load() {
  if (!props.row || !activePath.value) {
    source.value = null
    return
  }
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const data = await api.getCoverageSource(props.executionId, props.row.nodeId, activePath.value)
    if (seq !== loadSeq) return
    source.value = data
    currentLine.value = firstUncovered(data)
    await nextTick()
    if (seq === loadSeq) scrollTo(currentLine.value, false)
  } catch (err: any) {
    if (seq !== loadSeq) return
    source.value = null
    error.value = err?.response?.data?.error || '源码读取失败'
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function scrollTo(nr: number, smooth = true) {
  await nextTick()
  const el = codeRef.value?.querySelector(`[data-nr="${nr}"]`)
  if (el) el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  currentLine.value = nr
}

function jump(direction: 1 | -1) {
  const next = stepUncovered(source.value?.missed || [], currentLine.value, direction)
  if (next !== null) scrollTo(next)
}

async function copyPath() {
  const target = `${activePath.value}:${currentLine.value}`
  try {
    await navigator.clipboard.writeText(target)
    ElMessage.success(`已复制 ${target}`)
  } catch {
    ElMessage.warning(`复制失败，可手动复制：${target}`)
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`覆盖率 · ${nodeName || row?.nodeId || ''}`"
    width="1040px"
    top="6vh"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="row">
      <div class="cov-summary">
        <span class="cov-chip">状态 <b>{{ statusText }}</b></span>
        <span class="cov-chip">节点命中 <b>{{ badge.text || '—' }}</b></span>
        <span v-if="row.result?.totals" class="cov-chip">
          行覆盖 <b>{{ fmtPct(row.result.totals.lineRate) }}</b>
          （{{ row.result.totals.covered }}/{{ row.result.totals.total }} 行）
        </span>
        <span v-if="row.result?.totals" class="cov-chip">文件 <b>{{ row.result.totals.files }}</b></span>
        <span v-if="row.analyzedAt" class="cov-chip">分析于 <b>{{ new Date(row.analyzedAt).toLocaleString('zh-CN', { hour12: false }) }}</b></span>
      </div>

      <el-alert
        v-if="row.error"
        :title="row.error"
        type="error"
        :closable="false"
        show-icon
        style="margin-bottom: 10px"
      />

      <div v-if="!files.length" class="cov-empty">
        该节点没有可查看的源码文件（{{ statusText }}）。
        <template v-if="row.status === 'captured' && !row.error">
          环境配置 `settings.coverage.classfiles` 后，执行结束会自动分析。
        </template>
      </div>

      <div v-else class="cov-body">
        <div class="cov-files">
          <div
            v-for="file in files"
            :key="file.path"
            class="cov-file"
            :class="{ active: file.path === activePath }"
            @click="activePath = file.path"
          >
            <div class="cov-file-path">{{ file.short }}</div>
            <div class="cov-file-meta">
              <span>{{ file.covered }}/{{ file.total }} 行</span>
              <span>未覆盖 {{ file.missed }}</span>
              <span>{{ fmtPct(file.lineRate) }}</span>
            </div>
          </div>
        </div>

        <div class="cov-code-wrap">
          <div class="cov-toolbar">
            <span class="path">{{ activePath }}<span v-if="currentLine">:{{ currentLine }}</span></span>
            <el-button size="small" :disabled="!source?.missed?.length" @click="jump(-1)">上一处未覆盖</el-button>
            <el-button size="small" :disabled="!source?.missed?.length" @click="jump(1)">下一处未覆盖</el-button>
            <el-button size="small" text @click="copyPath">复制位置</el-button>
          </div>
          <div v-if="loading" class="cov-empty">读取源码…</div>
          <div v-else-if="error" class="cov-empty">{{ error }}</div>
          <div v-else-if="source" ref="codeRef" class="cov-code">
            <div
              v-for="line in source.lines"
              :key="line.nr"
              class="cov-line"
              :class="{ covered: line.hit === 1, missed: line.hit === 0 }"
              :data-nr="line.nr"
              @click="currentLine = line.nr"
            >
              <span class="cov-nr">{{ line.nr }}</span>
              <span class="cov-code-text">{{ line.text || ' ' }}</span>
            </div>
          </div>
          <div v-if="source?.truncated" class="cov-note">
            文件超过 512 KB，仅展示前半部分；未覆盖行可能没有全部显示。
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>
