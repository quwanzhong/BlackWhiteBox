<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{ logs: { time: number; level: string; message: string }[] }>()
const box = ref<HTMLElement>()

watch(
  () => props.logs.length,
  async () => {
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
)

const fmt = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
</script>

<template>
  <div class="console-panel">
    <div class="cp-title">
      <span>执行日志</span>
      <span class="cp-count">{{ logs.length }}</span>
    </div>
    <div ref="box" class="cp-body">
      <div v-if="!logs.length" class="cp-empty">暂无日志。点击「执行流程」后，这里会实时输出每一步的执行情况。</div>
      <div v-for="(l, i) in logs" :key="i" class="cp-line" :class="'cl-' + l.level">
        <span class="cp-time">{{ fmt(l.time) }}</span>
        <span>{{ l.message }}</span>
      </div>
    </div>
  </div>
</template>
