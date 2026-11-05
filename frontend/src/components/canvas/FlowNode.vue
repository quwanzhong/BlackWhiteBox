<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useExecStore } from '../../stores/execution'

const props = defineProps<{ node: any }>()
const exec = useExecStore()
const data = ref<any>(props.node?.getData?.() || {})

onMounted(() => {
  props.node?.on?.('change:data', () => {
    data.value = props.node.getData()
  })
})

const status = computed(() => exec.nodeStates[props.node.id] || data.value.status || 'pending')
const method = computed(() => String(data.value.method || '').toUpperCase())

const methodColor = computed(
  () =>
    ({
      GET: '#67c23a',
      POST: '#e6a23c',
      PUT: '#409eff',
      PATCH: '#909399',
      DELETE: '#f56c6c',
    })[method.value] || '#909399'
)

const typeLabel = computed(() => {
  if (method.value) return method.value
  if (data.value.nodeType === 'manual') return data.value.kind || '人工'
  return data.value.nodeType || '步骤'
})

const statusIcon = computed(
  () =>
    ({
      running: '●',
      waiting: '❚❚',
      passed: '✔',
      failed: '✘',
      skipped: '–',
    })[status.value] || ''
)
</script>

<template>
  <div class="flow-node" :class="[`st-${status}`, { 'is-manual': data.nodeType === 'manual' }]">
    <div class="fn-top">
      <span class="fn-method" :style="{ background: methodColor }">{{ typeLabel }}</span>
      <span class="fn-status" :class="`fs-${status}`">{{ statusIcon }}</span>
    </div>
    <div class="fn-name" :title="data.name">{{ data.name }}</div>
  </div>
</template>
