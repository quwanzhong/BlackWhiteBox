<script setup lang="ts">
import { useRoute } from 'vue-router'
const route = useRoute()
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
      <el-menu router :default-active="route.path" class="app-menu">
        <el-menu-item index="/">
          <span class="menu-ico">▦</span><span>项目总览</span>
        </el-menu-item>
        <el-menu-item index="/flows">
          <span class="menu-ico">⇄</span><span>流程管理</span>
        </el-menu-item>
        <el-menu-item index="/reports">
          <span class="menu-ico">▤</span><span>执行报告</span>
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
