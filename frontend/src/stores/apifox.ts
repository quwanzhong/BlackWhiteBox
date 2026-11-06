import { defineStore } from 'pinia'
import { api } from '../api'

const STORAGE_KEY = 'heibaihe.apifox.connection'

export interface ApifoxInterfaceItem {
  id: string
  method: string
  path: string
  name: string
  operationId?: string
  folder?: string
  status?: string
  tags?: string[]
  deprecated?: boolean
}

/** 全局单例的初始化 Promise：保证「加载配置 + 读缓存」整个应用只跑一次 */
let initPromise: Promise<void> | null = null

/**
 * Apifox 全局单例连接仓库。
 *
 * 黑盒（数据导入页）与白盒（项目绑定接口）共用同一份连接配置和接口列表：
 * 只需在「数据导入」页配置一次项目 ID / 令牌，之后所有页面直接复用，
 * 不再各自填写连接参数、不再重复拉取。
 */
export const useApifoxStore = defineStore('apifox', {
  state: () => ({
    // 连接参数（令牌只在内存 / 本机 localStorage，不进后端配置文件）
    projectId: '',
    siteId: '',
    branchId: '',
    baseUrl: '',
    token: '',
    rememberToken: true,
    hasEnvToken: false,
    hasRuntimeToken: false,
    // 文档概要与接口列表（来自后端本机缓存或最近一次拉取）
    title: '',
    version: '',
    docProjectId: '',
    docBaseUrl: '',
    fetchedAt: 0,
    interfaces: [] as ApifoxInterfaceItem[],
    loaded: false,
  }),
  getters: {
    /** 是否已配置项目标识（项目 ID 或在线文档 site-id） */
    configured(state): boolean {
      return Boolean(state.projectId || state.siteId)
    },
    /** 是否具备发起请求的条件 */
    ready(state): boolean {
      if (!state.projectId && !state.siteId) return false
      return Boolean(state.token || state.hasEnvToken || state.hasRuntimeToken || state.siteId)
    },
  },
  actions: {
    /** 请求参数：全局单例连接 + 当前令牌 */
    connPayload() {
      return {
        projectId: this.projectId,
        siteId: this.siteId,
        branchId: this.branchId,
        baseUrl: this.baseUrl,
        token: this.token,
      }
    },
    applyPayload(data: any) {
      this.interfaces = data?.interfaces || []
      this.title = data?.title || ''
      this.version = data?.version || ''
      this.docProjectId = data?.projectId || ''
      this.docBaseUrl = data?.baseUrl || ''
      this.fetchedAt = data?.fetchedAt || 0
    },
    persistLocal() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            projectId: this.projectId,
            siteId: this.siteId,
            branchId: this.branchId,
            baseUrl: this.baseUrl,
            token: this.rememberToken ? this.token : '',
          })
        )
      } catch {
        /* localStorage 不可用时忽略 */
      }
    },
    restoreLocal() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return
        const saved = JSON.parse(raw)
        if (!this.projectId) this.projectId = saved.projectId || ''
        if (!this.siteId) this.siteId = saved.siteId || ''
        if (!this.branchId) this.branchId = saved.branchId || ''
        if (!this.baseUrl) this.baseUrl = saved.baseUrl || ''
        if (saved.token) this.token = saved.token
        else this.rememberToken = false
      } catch {
        /* 忽略损坏的本地配置 */
      }
    },
    /** 全局加载：只执行一次，之后所有页面直接复用结果 */
    ensureLoaded(): Promise<void> {
      if (this.loaded) return Promise.resolve()
      if (!initPromise) {
        initPromise = (async () => {
          this.restoreLocal()
          try {
            const cfg = await api.apifoxGetConfig()
            this.hasEnvToken = Boolean(cfg.hasEnvToken)
            this.hasRuntimeToken = Boolean(cfg.hasRuntimeToken)
            if (!this.projectId) this.projectId = cfg.projectId || ''
            if (!this.siteId) this.siteId = cfg.siteId || ''
            if (!this.branchId) this.branchId = cfg.branchId || ''
            if (!this.baseUrl) this.baseUrl = cfg.baseUrl || ''
          } catch {
            /* 后端未就绪时忽略 */
          }
          try {
            this.applyPayload(await api.apifoxCachedInterfaces())
          } catch {
            /* 没有缓存时静默 */
          }
          this.loaded = true
        })().finally(() => {
          initPromise = null
        })
      }
      return initPromise
    },
    /** 校验全局连接（成功后后端会把令牌放入内存单例） */
    async test() {
      if (!this.configured) throw new Error('请先填写 Apifox 项目 ID（或在线文档 site-id）')
      if (this.projectId && !this.token && !this.hasEnvToken && !this.hasRuntimeToken) {
        throw new Error('请填写 Apifox 访问令牌（APIFOX_ACCESS_TOKEN）')
      }
      const res = await api.apifoxTest(this.connPayload())
      this.hasEnvToken = true
      this.persistLocal()
      return res
    },
    /** 全局拉取 / 刷新接口列表（后端同步更新本机缓存） */
    async pull(refresh = true) {
      if (!this.configured) throw new Error('请先填写 Apifox 项目 ID（或在线文档 site-id）')
      if (this.projectId && !this.token && !this.hasEnvToken && !this.hasRuntimeToken) {
        throw new Error('请填写 Apifox 访问令牌（APIFOX_ACCESS_TOKEN）')
      }
      const res = await api.apifoxInterfaces({ ...this.connPayload(), refresh })
      this.applyPayload(res)
      this.persistLocal()
      return res
    },
    /** 读取后端本机缓存（通常由 ensureLoaded 完成，这里供手动刷新） */
    async loadCache() {
      const res = await api.apifoxCachedInterfaces()
      this.applyPayload(res)
      return res
    },
  },
})
