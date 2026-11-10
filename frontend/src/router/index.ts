import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('../views/Dashboard.vue'), meta: { title: '项目总览' } },
    { path: '/projects', name: 'projects', component: () => import('../views/ProjectsPage.vue'), meta: { title: '项目管理' } },
    { path: '/projects/:id', name: 'project-detail', component: () => import('../views/ProjectDetail.vue'), meta: { title: '项目详情' } },
    { path: '/flows', name: 'flows', component: () => import('../views/FlowList.vue'), meta: { title: '流程管理' } },
    { path: '/flows/:id', name: 'flow-canvas', component: () => import('../views/FlowCanvas.vue'), meta: { title: '流程画布' } },
    { path: '/environments', name: 'environments', component: () => import('../views/EnvironmentsPage.vue'), meta: { title: '环境管理' } },
    { path: '/suites', name: 'suites', component: () => import('../views/SuitesPage.vue'), meta: { title: '套件执行' } },
    { path: '/reports', name: 'reports', component: () => import('../views/ReportList.vue'), meta: { title: '执行报告' } },
    { path: '/reports/:id', name: 'report-detail', component: () => import('../views/ReportDetail.vue'), meta: { title: '报告详情' } },
    { path: '/bugs', name: 'bugs', component: () => import('../views/BugsPage.vue'), meta: { title: '缺陷反馈' } },
    { path: '/import', name: 'import', component: () => import('../views/ImportPage.vue'), meta: { title: '数据导入' } },
  ],
})

router.afterEach((to) => {
  document.title = `${to.meta.title || ''} · 黑百盒`
})

export default router
