<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
const route = useRoute()

const activeMenu = computed(() => {
  const p = route.path
  if (p === '/') return '/'
  if (p.startsWith('/projects')) return '/projects'
  if (p.startsWith('/flows')) return '/flows'
  if (p.startsWith('/environments')) return '/environments'
  if (p.startsWith('/reports')) return '/reports'
  if (p.startsWith('/bugs')) return '/bugs'
  if (p.startsWith('/import')) return '/import'
  return p
})
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="210px" class="app-aside">
      <div class="app-logo" @click="$router.push('/')">
        <span class="logo-mark">◐</span>
        <div>
          <div class="logo-text">黑百盒</div>
          <div class="logo-sub">黑白盒测试平台</div>
        </div>
      </div>
      <el-menu router :default-active="activeMenu" class="app-menu">
        <el-menu-item index="/">
          <span class="menu-ico">▦</span><span>项目总览</span>
        </el-menu-item>
        <el-menu-item index="/projects">
          <span class="menu-ico">◎</span><span>项目管理</span>
        </el-menu-item>
        <el-menu-item index="/flows">
          <span class="menu-ico">⇄</span><span>流程管理</span>
        </el-menu-item>
        <el-menu-item index="/environments">
          <span class="menu-ico">⚙</span><span>环境管理</span>
        </el-menu-item>
        <el-menu-item index="/reports">
          <span class="menu-ico">▤</span><span>执行报告</span>
        </el-menu-item>
        <el-menu-item index="/bugs">
          <span class="menu-ico">⚑</span><span>缺陷反馈</span>
        </el-menu-item>
        <el-menu-item index="/import">
          <span class="menu-ico">⇩</span><span>数据导入</span>
        </el-menu-item>
      </el-menu>
      <div class="app-aside-foot">
        <div>本地单机版 v0.1</div>
        <div class="foot-dim">Vue3 · Node.js · SQLite/JSON</div>
      </div>
    </el-aside>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>
