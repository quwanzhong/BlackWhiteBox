<script setup lang="ts">
/**
 * 接口调用链面板（M3'-2 · W1）
 *
 * 回答「这个接口被哪些页面/操作触发？规则写在哪个函数？」：
 *   接口 ← 调用点 ← 函数调用/组件使用 ← 页面入口
 * 每个节点可下钻到源码行（后端只允许读图内文件，且只回行窗口）。
 *
 * 诚实性：未构建/扫描变化显式提示；断链标「低置信度待关联」，绝不写成「无调用方」。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import {
  alertType,
  chainView,
  endpointRows,
  gapSections,
  graphStateView,
  graphStatRows,
  noEntryRows,
  orphanRows,
  tagType,
  truncationReasons,
  type EndpointFilter,
} from '../utils/codegraph'

const props = defineProps<{ projectId: string; hasScan?: boolean }>()
const emit = defineEmits<{ (e: 'go-scan'): void }>()

const status = ref<any>(null)
const all = ref<any>(null)
const gaps = ref<any>(null)
const loading = ref(false)
const building = ref(false)

const pane = ref<'endpoints' | 'gaps'>('endpoints')
const keyword = ref('')
const filter = ref<EndpointFilter>('all')
const selectedId = ref('')
const chains = ref<any[]>([])
const selectedFiles = ref<any[]>([])
const chainLoading = ref(false)

const sourceVisible = ref(false)
const sourceLoading = ref(false)
const source = ref<any>(null)
const sourceTitle = ref('')

const stateView = computed(() => graphStateView(status.value))
const statRows = computed(() => graphStatRows(status.value?.summary))
const truncations = computed(() => truncationReasons(status.value?.summary))
const rows = computed(() => endpointRows(all.value, { keyword: keyword.value, filter: filter.value }))
const selectedEndpoint = computed<any>(() => (all.value?.endpoints || []).find((e: any) => e.interfaceId === selectedId.value) || null)
const chainCards = computed(() => chains.value.map((raw) => ({ raw, view: chainView(raw) })))
const noEntryList = computed(() => noEntryRows(gaps.value))
const sections = computed(() => gapSections(gaps.value))
const orphans = computed(() => orphanRows(all.value))
const gapCount = computed(
  () => noEntryList.value.length + sections.value.reduce((sum, s) => sum + s.rows.length, 0) + orphans.value.length
)

const methodType: Record<string, string> = {
  GET: 'success', POST: 'primary', PUT: 'warning', PATCH: 'warning', DELETE: 'danger',
}
const kindText: Record<string, string> = {
  page: '页面', component: '组件', api: '接口', store: '状态', router: '路由', other: '其他',
}

async function loadAll() {
  if (!props.projectId) return
  loading.value = true
  try {
    status.value = await api.projectCodegraph(props.projectId)
    if (!stateView.value.canQuery) {
      all.value = null
      gaps.value = null
      chains.value = []
      selectedFiles.value = []
      return
    }
    const [list, gap] = await Promise.all([
      api.projectCodegraphChains(props.projectId),
      api.projectCodegraphGaps(props.projectId),
    ])
    all.value = list
    gaps.value = gap
    if (!rows.value.some((r: any) => r.interfaceId === selectedId.value)) {
      selectedId.value = rows.value[0]?.interfaceId || ''
    }
    if (selectedId.value) await openEndpoint(selectedId.value)
    else chains.value = []
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '加载调用链失败')
  } finally {
    loading.value = false
  }
}

async function build() {
  if (!props.hasScan) return ElMessage.warning('请先完成代码扫描')
  building.value = true
  const startedAt = performance.now()
  try {
    const summary = await api.projectCodegraphBuild(props.projectId)
    const cost = Math.round(performance.now() - startedAt)
    ElMessage.success(
      `调用链已构建：${summary.stats?.callsWithEntry ?? 0} 个调用点有入口 · ${summary.stats?.endpointCount ?? 0} 个接口 · ${cost} ms`
    )
    await loadAll()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '构建调用链失败')
  } finally {
    building.value = false
  }
}

async function openEndpoint(interfaceId: string) {
  selectedId.value = interfaceId
  chainLoading.value = true
  selectedFiles.value = []
  try {
    const data = await api.projectCodegraphChains(props.projectId, { interfaceId, limit: 20 })
    chains.value = data.chains || []
    selectedFiles.value = data.files || []
  } catch (err: any) {
    chains.value = []
    selectedFiles.value = []
    ElMessage.error(err?.response?.data?.error || '读取链路失败')
  } finally {
    chainLoading.value = false
  }
}

async function openSource(target: any) {
  if (!target?.file) return
  sourceTitle.value = `${target.name || '源码'} · ${target.file}:${target.line}`
  source.value = null
  sourceVisible.value = true
  sourceLoading.value = true
  try {
    source.value = await api.projectCodegraphSource(props.projectId, {
      file: target.file,
      line: target.line || 1,
      radius: 10,
    })
  } catch (err: any) {
    sourceVisible.value = false
    ElMessage.error(err?.response?.data?.error || '读取源码失败')
  } finally {
    sourceLoading.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 ${text}`)
  } catch {
    ElMessage.warning(`复制失败，可手动复制：${text}`)
  }
}

onMounted(loadAll)
watch(() => props.projectId, loadAll)
</script>

<template>
  <div v-loading="loading" class="cg">
    <div class="cg-head">
      <div>
        <div class="cg-title">接口调用链</div>
        <div class="muted">
          接口 ← 调用点 ← 函数调用/组件使用 ← 页面入口。断链单独标注并降级为低置信度，<b>不写成「无调用方」</b>。
        </div>
      </div>
      <div class="cg-actions">
        <el-tag :type="tagType(stateView.tone)" effect="plain">{{ stateView.text }}</el-tag>
        <el-button size="small" @click="loadAll">刷新</el-button>
        <el-button type="primary" :loading="building" :disabled="!hasScan" @click="build">
          {{ status?.summary ? '重建调用链' : '构建调用链' }}
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="stateView.notice"
      class="mt12"
      :title="stateView.notice"
      :type="alertType(stateView.tone)"
      :closable="false"
      show-icon
    >
      <template v-if="stateView.text === '未扫描'">
        <el-button link type="primary" @click="emit('go-scan')">去扫描代码 →</el-button>
      </template>
    </el-alert>

    <div v-if="statRows.length" class="cg-stats mt12">
      <div v-for="row in statRows" :key="row.label" class="cg-stat">
        <span class="cg-stat-label">{{ row.label }}</span>
        <b :class="row.tone ? `t-${row.tone}` : ''">{{ row.value }}</b>
        <span v-if="row.hint" class="cg-stat-hint">{{ row.hint }}</span>
      </div>
    </div>

    <el-alert
      v-if="truncations.length"
      class="mt12"
      type="warning"
      :closable="false"
      show-icon
      title="本次结果是截断的（不是全量证据）"
    >
      <div v-for="reason in truncations" :key="reason" class="cg-trunc">{{ reason }}</div>
    </el-alert>

    <el-tabs v-model="pane" class="mt12">
      <el-tab-pane name="endpoints">
        <template #label>接口链路 <span v-if="all?.endpoints" class="cg-count">{{ all.endpoints.length }}</span></template>

        <div v-if="!status?.summary && stateView.canQuery === false" class="cg-empty">
          {{ stateView.text === '未构建' ? '还没有调用链。点右上角「构建调用链」生成。' : '暂无可展示的调用链。' }}
        </div>

        <div v-else class="cg-wrap">
          <div class="cg-list">
            <div class="cg-list-tools">
              <el-input v-model="keyword" size="small" clearable placeholder="搜索路径 / 名称" />
              <el-radio-group v-model="filter" size="small">
                <el-radio-button value="all">全部</el-radio-button>
                <el-radio-button value="entry">有入口</el-radio-button>
                <el-radio-button value="broken">断链</el-radio-button>
              </el-radio-group>
            </div>
            <div class="cg-ep-scroll">
              <div
                v-for="row in rows"
                :key="row.interfaceId"
                class="cg-ep"
                :class="{ on: row.interfaceId === selectedId }"
                @click="openEndpoint(row.interfaceId)"
              >
                <el-tag size="small" :type="(methodType[row.method] as any) || 'info'" effect="dark">{{ row.method || '??' }}</el-tag>
                <div class="cg-ep-main">
                  <div class="cg-ep-name">{{ row.name || row.path || row.interfaceId }}</div>
                  <div class="mono cg-ep-path">{{ row.path || row.interfaceId }}</div>
                  <div class="cg-ep-meta">
                    <span>{{ row.callSiteCount }} 处调用</span>
                    <span>{{ row.chainCount }} 条链路</span>
                  </div>
                </div>
                <el-tag size="small" :type="row.hasEntry ? 'success' : 'warning'" effect="plain">
                  {{ row.hasEntry ? '有入口' : '断链' }}
                </el-tag>
              </div>
              <div v-if="!rows.length" class="cg-empty">没有符合条件的接口</div>
            </div>
          </div>

          <div class="cg-detail">
            <div v-if="!selectedEndpoint" class="cg-empty">左侧选择一个接口，查看它被哪些页面/操作触发。</div>
            <template v-else>
              <div class="cg-detail-head">
                <el-tag size="small" :type="(methodType[selectedEndpoint.method] as any) || 'info'" effect="dark">
                  {{ selectedEndpoint.method || '??' }}
                </el-tag>
                <span class="mono cg-detail-path">{{ selectedEndpoint.path || selectedEndpoint.interfaceId }}</span>
                <el-tag size="small" :type="selectedEndpoint.hasEntry ? 'success' : 'warning'" effect="plain">
                  {{ selectedEndpoint.hasEntry ? '可回溯到入口' : '未回溯到入口' }}
                </el-tag>
              </div>
              <div class="muted cg-detail-meta">
                调用点 {{ selectedEndpoint.callSiteCount }} · 链路 {{ selectedEndpoint.chainCount }} ·
                最佳置信度 {{ selectedEndpoint.confidence }}
                <span v-if="selectedEndpoint.truncated" class="cg-warn">（链路数触顶，已截断）</span>
              </div>

              <div v-if="selectedFiles.length" class="cg-files">
                <span class="muted">涉及文件：</span>
                <el-tag
                  v-for="f in selectedFiles.slice(0, 12)"
                  :key="f.file"
                  size="small"
                  type="info"
                  effect="plain"
                  class="cg-file"
                  @click="openSource({ file: f.file, line: 1, name: f.file })"
                >
                  {{ f.file }}
                </el-tag>
                <span v-if="selectedFiles.length > 12" class="muted">等 {{ selectedFiles.length }} 个</span>
              </div>

              <div v-if="chainLoading" class="cg-empty">读取链路…</div>
              <div v-else class="cg-chains">
                <div
                  v-for="(card, index) in chainCards"
                  :key="`${card.raw.callSiteId || 'chain'}-${index}`"
                  class="cg-chain"
                  :class="{ broken: card.view.broken }"
                >
                  <div class="cg-chain-head">
                    <span class="cg-chain-no">链路 {{ index + 1 }}</span>
                    <el-tag size="small" :type="card.view.confidenceTone">{{ card.view.confidence }}</el-tag>
                    <span class="muted">{{ card.view.hops }} 跳</span>
                    <span class="cg-chain-entry">{{ card.view.entryText }}</span>
                  </div>
                  <div class="cg-chain-reason" :class="{ warn: card.view.broken }">{{ card.view.reasonText }}</div>

                  <div class="cg-nodes">
                    <div v-for="(node, idx) in card.raw.nodes" :key="node.id || idx" class="cg-node">
                      <span class="cg-node-idx">{{ idx + 1 }}</span>
                      <div class="cg-node-main" @click="openSource(node)">
                        <span class="cg-node-name">{{ node.name || '(anonymous)' }}</span>
                        <span class="cg-kind" :class="`k-${node.kind}`">{{ kindText[node.kind] || node.kind }}</span>
                        <span class="mono cg-node-where">{{ node.file || '—' }}:{{ node.line || 0 }}</span>
                      </div>
                    </div>
                  </div>

                  <div
                    v-if="card.raw.callSite"
                    class="cg-callsite mono"
                    :title="card.raw.callSite.snippet || ''"
                    @click="openSource(card.raw.callSite)"
                  >
                    调用点 {{ card.raw.callSite.file }}:{{ card.raw.callSite.line }} · {{ card.raw.callSite.method }} {{ card.raw.callSite.path }}
                  </div>
                </div>

                <div v-if="!chainCards.length" class="cg-empty">
                  该接口没有链路记录。
                  <template v-if="!selectedEndpoint.hasEntry">
                    它可能只有「文档定义」没有代码调用，或调用点没被扫描到——请到「断链与孤儿」页签核对。
                  </template>
                </div>
              </div>
            </template>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane name="gaps">
        <template #label>断链与孤儿 <span v-if="gapCount" class="cg-count warn">{{ gapCount }}</span></template>

        <div class="cg-gaps">
          <div class="cg-gap-block">
            <div class="cg-gap-title">
              无入口调用点
              <span class="cg-gap-hint">有调用点、回溯不到入口；callerCount=0 才是工程内无调用方</span>
            </div>
            <el-table v-if="noEntryList.length" :data="noEntryList" size="small" border max-height="280">
              <el-table-column prop="where" label="源码位置" min-width="220">
                <template #default="{ row }"><span class="mono">{{ row.where }}</span></template>
              </el-table-column>
              <el-table-column prop="interfaceId" label="接口" min-width="220" />
              <el-table-column label="归类" min-width="230">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.tone" effect="plain">{{ row.callerText }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="置信度" width="96">
                <template #default="{ row }"><el-tag size="small" type="warning">{{ row.confidence }}</el-tag></template>
              </el-table-column>
            </el-table>
            <div v-else class="cg-empty">{{ gaps?.state === 'fresh' ? '没有无入口调用点。' : '调用链尚未构建，无法给出断链清单。' }}</div>
          </div>

          <div v-for="section in sections" :key="section.key" class="cg-gap-block">
            <div class="cg-gap-title">
              {{ section.title }} <span class="cg-count warn">{{ section.rows.length }}</span>
              <span class="cg-gap-hint">{{ section.hint }}</span>
            </div>
            <div v-if="section.rows.length" class="cg-gap-rows">
              <div v-for="item in section.rows.slice(0, 100)" :key="item.key" class="cg-gap-row">
                <span class="mono cg-gap-where">{{ item.where }}</span>
                <span class="cg-gap-detail">{{ item.detail }}</span>
              </div>
              <div v-if="section.rows.length > 100" class="muted">仅显示前 100 条，共 {{ section.rows.length }} 条。</div>
            </div>
            <div v-else class="cg-empty">无</div>
          </div>

          <div class="cg-gap-block">
            <div class="cg-gap-title">
              孤儿接口 <span class="cg-count">{{ orphans.length }}</span>
              <span class="cg-gap-hint">文档里有、代码里没有任何调用点——与「无入口调用点」不是一回事</span>
            </div>
            <div v-if="orphans.length" class="cg-gap-rows">
              <div v-for="item in orphans.slice(0, 100)" :key="item.key" class="cg-gap-row">
                <span class="mono cg-gap-where">{{ item.key }}</span>
                <span class="cg-gap-detail">{{ item.name }} · {{ item.detail }}</span>
              </div>
              <div v-if="orphans.length > 100" class="muted">仅显示前 100 个，共 {{ orphans.length }} 个。</div>
            </div>
            <div v-else class="cg-empty">无</div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="sourceVisible" :title="sourceTitle" width="920px" top="7vh" destroy-on-close>
      <div v-if="sourceLoading" class="cg-empty">读取源码…</div>
      <div v-else-if="source">
        <div class="cg-src-bar">
          <span class="mono">{{ source.file }}:{{ source.line }}</span>
          <span class="muted">第 {{ source.startLine }}–{{ source.endLine }} 行 / 共 {{ source.totalLines }} 行</span>
          <el-button size="small" text @click="copy(`${source.absolutePath}:${source.line}`)">复制绝对位置</el-button>
        </div>
        <div class="cg-src-code">
          <div v-for="line in source.lines" :key="line.nr" class="cg-src-line" :class="{ hit: line.nr === source.line }">
            <span class="cg-src-nr">{{ line.nr }}</span>
            <span class="cg-src-text">{{ line.text || ' ' }}</span>
          </div>
        </div>
      </div>
      <div v-else class="cg-empty">没有可展示的源码。</div>
    </el-dialog>
  </div>
</template>

<style scoped>
.cg { font-size: 13px; }
.cg-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.cg-title { font-size: 14px; font-weight: 700; }
.cg-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cg-count { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 9px; background: #ecf5ff; color: #409eff; font-size: 11px; }
.cg-count.warn { background: #fdf6ec; color: #e6a23c; }
.cg-stats { display: flex; gap: 8px; flex-wrap: wrap; }
.cg-stat { flex: 1; min-width: 128px; background: #f7f8fa; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.cg-stat-label { font-size: 11px; color: #909399; }
.cg-stat b { font-size: 18px; }
.cg-stat b.t-ok { color: #67c23a; }
.cg-stat b.t-warn { color: #e6a23c; }
.cg-stat-hint { font-size: 11px; color: #8a94a6; }
.cg-trunc { font-size: 12px; }
.cg-wrap { display: flex; gap: 12px; min-height: 420px; }
.cg-list { width: 420px; flex: none; border: 1px solid #ebeef5; border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; }
.cg-list-tools { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid #ebeef5; align-items: center; flex-wrap: wrap; }
.cg-ep-scroll { flex: 1; max-height: 560px; overflow: auto; }
.cg-ep { display: flex; gap: 8px; align-items: flex-start; padding: 9px 10px; border-bottom: 1px dashed #f0f2f5; cursor: pointer; }
.cg-ep:hover { background: #f5f7fa; }
.cg-ep.on { background: #ecf5ff; box-shadow: inset 3px 0 0 #409eff; }
.cg-ep-main { flex: 1; min-width: 0; }
.cg-ep-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cg-ep-path { font-size: 11px; color: #8a94a6; word-break: break-all; }
.cg-ep-meta { display: flex; gap: 10px; font-size: 11px; color: #909399; margin-top: 3px; }
.cg-detail { flex: 1; min-width: 0; border: 1px solid #ebeef5; border-radius: 8px; padding: 10px 12px; max-height: 600px; overflow: auto; }
.cg-detail-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cg-detail-path { font-size: 13px; font-weight: 600; word-break: break-all; }
.cg-detail-meta { margin: 6px 0 8px; }
.cg-warn { color: #e6a23c; }
.cg-files { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.cg-file { cursor: pointer; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.cg-chains { display: flex; flex-direction: column; gap: 10px; }
.cg-chain { border: 1px solid #ebeef5; border-left: 3px solid #67c23a; border-radius: 8px; padding: 8px 10px; }
.cg-chain.broken { border-left-color: #e6a23c; }
.cg-chain-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cg-chain-no { font-weight: 700; font-size: 12px; }
.cg-chain-entry { font-size: 12px; color: #409eff; word-break: break-all; }
.cg-chain-reason { font-size: 11px; color: #909399; margin: 3px 0 6px; }
.cg-chain-reason.warn { color: #b88230; }
.cg-nodes { display: flex; flex-direction: column; gap: 2px; }
.cg-node { display: flex; gap: 8px; align-items: flex-start; }
.cg-node-idx { width: 18px; height: 18px; flex: none; border-radius: 50%; background: #f2f3f5; color: #909399; font-size: 11px; text-align: center; line-height: 18px; margin-top: 2px; }
.cg-node-main { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; cursor: pointer; padding: 2px 4px; border-radius: 4px; min-width: 0; }
.cg-node-main:hover { background: #f5f7fa; }
.cg-node-name { font-weight: 600; font-size: 12px; }
.cg-kind { font-size: 10px; padding: 0 5px; border-radius: 4px; background: #f2f3f5; color: #606266; }
.cg-kind.k-page { background: #ecf5ff; color: #409eff; }
.cg-kind.k-component { background: #f4f4f5; color: #909399; }
.cg-kind.k-api { background: #f0f9eb; color: #67c23a; }
.cg-kind.k-router { background: #fdf6ec; color: #e6a23c; }
.cg-node-where { font-size: 11px; color: #8a94a6; word-break: break-all; }
.cg-callsite { margin-top: 6px; font-size: 11px; color: #606266; cursor: pointer; word-break: break-all; }
.cg-callsite:hover { color: #409eff; }
.cg-gaps { display: flex; flex-direction: column; gap: 12px; }
.cg-gap-block { border: 1px solid #ebeef5; border-radius: 8px; padding: 10px 12px; }
.cg-gap-title { font-weight: 700; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.cg-gap-hint { font-weight: 400; font-size: 11px; color: #909399; }
.cg-gap-rows { display: flex; flex-direction: column; }
.cg-gap-row { display: flex; gap: 10px; padding: 5px 0; border-bottom: 1px dashed #f0f2f5; font-size: 12px; flex-wrap: wrap; }
.cg-gap-where { color: #606266; min-width: 220px; }
.cg-gap-detail { color: #909399; word-break: break-all; }
.cg-empty { text-align: center; color: #909399; padding: 26px 10px; font-size: 13px; line-height: 1.9; }
.cg-src-bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.cg-src-code { max-height: 62vh; overflow: auto; background: #fafafa; border: 1px solid #ebeef5; border-radius: 6px; padding: 6px 0; }
.cg-src-line { display: flex; gap: 10px; padding: 0 8px; font-family: Consolas, 'Courier New', monospace; font-size: 12px; line-height: 1.65; white-space: pre; }
.cg-src-line.hit { background: #fdf6ec; box-shadow: inset 3px 0 0 #e6a23c; }
.cg-src-nr { width: 46px; flex: none; text-align: right; color: #b0b6bf; user-select: none; }
.cg-src-text { color: #303133; }
.mono { font-family: Consolas, 'Courier New', monospace; }
.mt12 { margin-top: 12px; }
</style>
