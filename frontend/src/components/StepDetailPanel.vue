<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FlowNode } from '../types/flow'
import { coverageBadge, fmtPct } from '../utils/coverage'

const props = defineProps<{
  node: FlowNode | null
  step: any | null
  waiting?: boolean
  /** M3-3：该节点的覆盖率证据投影（没有就是 undefined） */
  coverage?: any
}>()

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'remove'): void
  (e: 'confirm-manual', pass: boolean, note: string): void
  (e: 'coverage'): void
}>()

const note = ref('')

const pretty = (v: any) => {
  if (v === undefined) return '—'
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

const checks = computed(() => props.step?.checks?.results || [])
const isManual = computed(() => props.node?.action?.type === 'manual')
const covBadge = computed(() => coverageBadge(props.coverage || null))
const covTotals = computed(() => props.coverage?.result?.totals || null)
const statusText: Record<string, string> = {
  pending: '待执行', running: '执行中', waiting: '等待人工确认',
  passed: '通过', failed: '未通过', skipped: '已跳过',
}
</script>

<template>
  <div class="step-panel">
    <div v-if="!node" class="sp-empty">
      点击画布中的节点<br />查看请求配置、理想输出与实际输出匹对
    </div>

    <template v-else>
      <div class="sp-head">
        <div class="sp-name">{{ node.name }}</div>
        <el-tag
          size="small"
          :type="step?.status === 'passed' ? 'success' : step?.status === 'failed' ? 'danger' : step?.status === 'running' ? 'primary' : step?.status === 'waiting' ? 'warning' : 'info'"
        >
          {{ statusText[step?.status || 'pending'] }}
        </el-tag>
      </div>
      <div class="sp-id">{{ node.id }} · {{ isManual ? '人工确认步骤' : 'HTTP 接口步骤' }}</div>
      <div class="page-actions" style="gap: 6px">
        <el-button size="small" @click="emit('edit')">编辑节点</el-button>
        <el-button size="small" type="danger" plain @click="emit('remove')">删除节点</el-button>
      </div>

      <!-- 请求配置 -->
      <div class="sp-section-title">请求配置</div>
      <template v-if="!isManual">
        <div class="sp-kv"><b>{{ node.action.method }}</b> <span class="sp-url">{{ node.action.url }}</span></div>
        <div v-if="node.action.headers && Object.keys(node.action.headers).length" class="sp-kv" style="margin-top: 4px">
          请求头：<span class="sp-url">{{ JSON.stringify(node.action.headers) }}</span>
        </div>
        <pre v-if="node.action.body != null" class="json-block">{{ pretty(node.action.body) }}</pre>
        <div v-if="node.input" class="sp-kv" style="margin-top: 4px">期望输入：</div>
        <pre v-if="node.input" class="json-block">{{ pretty(node.input) }}</pre>
      </template>
      <template v-else>
        <div class="sp-tip">{{ node.action.hint || '请人工确认该步骤结果' }}</div>
        <div v-if="node.input" class="sp-kv" style="margin-top: 6px">代码位置：{{ node.input.file }}{{ node.input.line ? ':' + node.input.line : '' }}</div>
      </template>

      <!-- 理想输出 -->
      <div class="sp-section-title">理想输出（校验标准）</div>
      <template v-if="!isManual">
        <div class="sp-kv">期望状态码：<b>{{ node.expected?.status ?? 200 }}</b></div>
        <div v-if="node.expected?.checks?.length" style="margin-top: 4px">
          <div class="sp-kv">断言列表：</div>
          <div v-for="(c, i) in node.expected.checks" :key="i" class="sp-check-row">
            <el-tag size="small" type="info">{{ c.type === 'body_contains' ? '包含' : 'JSONPath' }}</el-tag>
            <span>{{ c.label || c.path }}</span>
            <span class="muted">期望 {{ c.op }} {{ JSON.stringify(c.value) }}</span>
          </div>
        </div>
        <div v-else class="muted">未配置额外断言，仅校验状态码</div>
      </template>
      <template v-else>
        <div class="sp-kv">{{ node.expected?.manualNote || '人工确认代码逻辑符合预期' }}</div>
      </template>

      <!-- 变量提取 -->
      <template v-if="node.extract && Object.keys(node.extract).length">
        <div class="sp-section-title">变量提取</div>
        <div v-for="(path, name) in node.extract" :key="name" class="sp-kv">
          <code>{{ name }}</code> ← {{ path }}
          <span v-if="step?.extracted && name in step.extracted" class="diff-ok">（已提取：{{ JSON.stringify(step.extracted[name]) }}）</span>
        </div>
      </template>

      <!-- 实际输出 -->
      <div class="sp-section-title">实际输出</div>
      <div v-if="!step" class="muted">未执行</div>
      <template v-else>
        <div class="sp-kv">
          状态：<b>{{ step.status }}</b>
          <span v-if="step.durationMs != null"> · 耗时 {{ step.durationMs }} ms</span>
        </div>
        <div v-if="step.request" class="sp-kv" style="margin-top: 4px">实际请求：{{ step.request.method }} {{ step.request.url }}</div>
        <div v-if="step.error" class="sp-tip" style="background: #fef0f0; border-color: #fde2e2; color: #c45656">
          {{ step.error }}
        </div>
        <template v-if="step.actual">
          <div v-if="step.actual.status !== undefined" class="sp-kv" style="margin-top: 4px">
            响应状态码：<b>{{ step.actual.status }}</b>
          </div>
          <pre v-if="step.actual.data !== undefined" class="json-block">{{ pretty(step.actual.data) }}</pre>
          <pre v-else-if="step.actual.note !== undefined" class="json-block">{{ pretty(step.actual) }}</pre>
        </template>
      </template>

      <!-- 校验结果 -->
      <template v-if="step?.checks">
        <div class="sp-section-title">输入输出匹对校验</div>
        <div v-for="(c, i) in checks" :key="i" class="sp-check-row">
          <span :class="c.passed ? 'sp-check-pass' : 'sp-check-fail'">{{ c.passed ? '✔' : '✘' }}</span>
          <div>
            <div>{{ c.label || c.path || c.type }}</div>
            <div class="muted" style="font-size: 11px">{{ c.message }}</div>
          </div>
        </div>
        <div class="sp-verdict" :class="step.checks.matched ? 'diff-ok' : 'diff-bad'">
          {{ step.checks.matched ? '✅ 实际输出符合该步骤的理想输出' : '❌ 实际输出与理想输出不一致' }}
        </div>
      </template>

      <!-- 运行时覆盖率（M3-3）：四种无数字状态各有说明，不当 0% 展示 -->
      <template v-if="coverage">
        <div class="sp-section-title">运行时覆盖率</div>
        <div class="sp-kv" style="align-items: center; gap: 8px; display: flex; flex-wrap: wrap">
          <el-tag size="small" effect="plain" :type="covBadge.tone === 'ok' ? 'success' : covBadge.tone === 'warn' ? 'warning' : covBadge.tone === 'bad' || covBadge.tone === 'error' ? 'danger' : 'info'">
            {{ covBadge.text || '—' }}
          </el-tag>
          <span v-if="covTotals" class="muted">
            行覆盖 {{ fmtPct(covTotals.lineRate) }}（{{ covTotals.covered }}/{{ covTotals.total }} 行）
          </span>
          <span v-else class="muted">{{ covBadge.title }}</span>
        </div>
        <el-button size="small" plain style="margin-top: 6px" @click="emit('coverage')">
          查看未覆盖行 / 源码
        </el-button>
      </template>

      <!-- 人工确认 -->
      <div v-if="waiting" class="sp-manual-box">
        <div style="font-size: 13px; font-weight: 700; color: #7c3aed">该步骤等待人工确认</div>
        <el-input v-model="note" type="textarea" :rows="2" placeholder="备注（可选）：例如检查结论 / 不通过原因" style="margin-top: 8px" />
        <div class="sp-manual-actions">
          <el-button type="success" size="small" @click="emit('confirm-manual', true, note)">通过</el-button>
          <el-button type="danger" size="small" @click="emit('confirm-manual', false, note)">不通过</el-button>
        </div>
      </div>
    </template>
  </div>
</template>
