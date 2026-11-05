<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const props = defineProps<{ modelValue: boolean; path?: string }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'select', path: string): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const current = ref('')
const parent = ref<string | null>(null)
const dirs = ref<any[]>([])
const roots = ref<any[]>([])
const currentInfo = ref<any>(null)
const loading = ref(false)
const manual = ref('')
const picked = ref('')

async function load(dir = '') {
  loading.value = true
  try {
    const data = await api.fsList(dir)
    current.value = data.path || ''
    parent.value = data.parent ?? null
    dirs.value = data.dirs || []
    currentInfo.value = data.current || null
    manual.value = data.path || ''
    if (!dir && data.dirs?.length) roots.value = data.dirs
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '读取目录失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      picked.value = props.path || ''
      load(props.path || '')
    }
  },
  { immediate: true }
)

function go(dir: string) {
  load(dir)
}

async function goManual() {
  const p = manual.value.trim()
  if (!p) return
  const check = await api.fsCheck(p)
  if (!check.ok) return ElMessage.error(check.error || '目录不可用')
  load(check.path)
}

function choose() {
  const path = picked.value || current.value
  if (!path) return ElMessage.warning('请先进入并选择工程目录')
  emit('select', path)
  visible.value = false
}

const projectTip = computed(() => {
  const info = currentInfo.value
  if (!info) return ''
  if (!info.isProject) return '当前目录未检测到 package.json / src，建议选择前端工程根目录'
  return `检测到前端工程：${(info.hints || []).join(' · ')}`
})
</script>

<template>
  <el-dialog v-model="visible" title="选择项目代码目录" width="720px" append-to-body>
    <div class="folder-picker">
      <div class="fp-bar">
        <el-button size="small" :disabled="!parent" @click="parent && go(parent)">↑ 上一级</el-button>
        <el-input v-model="manual" size="small" placeholder="也可以直接粘贴绝对路径，如 C:\work\my-app" @keyup.enter="goManual" />
        <el-button size="small" @click="goManual">前往</el-button>
      </div>

      <div v-if="!current" class="fp-roots">
        <div class="fp-hint">选择磁盘 / 起始目录</div>
        <div class="fp-dir-list">
          <div v-for="r in dirs" :key="r.path" class="fp-dir" @click="go(r.path)">
            <span class="fp-ico">🖴</span><span class="fp-name">{{ r.name }}</span>
            <span class="fp-path">{{ r.path }}</span>
          </div>
        </div>
      </div>

      <template v-else>
        <div class="fp-current">
          <span class="fp-ico">📁</span>
          <span class="fp-cur-path">{{ current }}</span>
          <el-tag v-if="currentInfo?.isProject" size="small" type="success">前端工程</el-tag>
        </div>
        <div class="fp-hint" :class="{ 'fp-warn': currentInfo && !currentInfo.isProject }">{{ projectTip }}</div>

        <div v-loading="loading" class="fp-dir-list">
          <div v-if="!dirs.length" class="fp-empty">该目录下没有子文件夹</div>
          <div
            v-for="d in dirs"
            :key="d.path"
            class="fp-dir"
            :class="{ 'is-project': d.isProject, 'is-picked': picked === d.path }"
            @click="picked = d.path"
            @dblclick="go(d.path)"
          >
            <span class="fp-ico">{{ d.isProject ? '📦' : '📁' }}</span>
            <span class="fp-name">{{ d.name }}</span>
            <span v-if="d.isProject" class="fp-badge">工程</span>
            <span class="fp-path">{{ d.path }}</span>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <span class="fp-selected">已选：{{ picked || '（未选择，默认使用当前目录）' }}</span>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="choose">使用该目录</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.folder-picker { display: flex; flex-direction: column; gap: 8px; }
.fp-bar { display: flex; gap: 8px; align-items: center; }
.fp-current {
  display: flex; align-items: center; gap: 8px; background: #f5f7fa;
  border: 1px solid #ebeef5; border-radius: 6px; padding: 8px 10px;
}
.fp-cur-path { font-family: Consolas, monospace; font-size: 12px; color: #303133; word-break: break-all; flex: 1; }
.fp-hint { font-size: 12px; color: #909399; }
.fp-hint.fp-warn { color: #e6a23c; }
.fp-dir-list { height: 320px; overflow: auto; border: 1px solid #ebeef5; border-radius: 8px; }
.fp-dir {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer;
  border-bottom: 1px dashed #f0f2f5; font-size: 13px;
}
.fp-dir:hover { background: #f5f7fa; }
.fp-dir.is-project { background: #f0f9eb; }
.fp-dir.is-picked { background: #ecf5ff; box-shadow: inset 3px 0 0 #409eff; }
.fp-ico { width: 18px; text-align: center; }
.fp-name { font-weight: 600; color: #303133; flex-shrink: 0; }
.fp-badge {
  font-size: 10px; color: #529b2e; background: #e1f3d8; border-radius: 4px; padding: 0 5px;
}
.fp-path { margin-left: auto; font-size: 11px; color: #b0b6bf; font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-empty { padding: 30px; text-align: center; color: #b0b6bf; font-size: 13px; }
.fp-roots .fp-dir-list { height: 300px; }
.fp-selected { float: left; font-size: 12px; color: #909399; line-height: 32px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
