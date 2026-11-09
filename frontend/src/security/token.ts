/**
 * 访问令牌（S3）：后端在 index.html 里注入 window.__HEIBAIHE_TOKEN__。
 * 兼容三种来源：注入 > URL ?token=（启动时打印的地址）> sessionStorage（刷新后用）。
 * 注意注入值永远最新：后端重启换了令牌，刷新页面即可恢复。
 */
const STORAGE_KEY = 'heibaihe.token'

let cached = ''

declare global {
  interface Window {
    __HEIBAIHE_TOKEN__?: string
  }
}

export function getToken(): string {
  if (cached) return cached

  const injected = window.__HEIBAIHE_TOKEN__
  if (typeof injected === 'string' && injected) {
    cached = injected
    try {
      sessionStorage.setItem(STORAGE_KEY, cached)
    } catch {
      /* 隐私模式可能禁用 sessionStorage */
    }
    return cached
  }

  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    cached = fromUrl
    try {
      sessionStorage.setItem(STORAGE_KEY, cached)
    } catch {
      /* ignore */
    }
    url.searchParams.delete('token')
    const search = url.searchParams.toString()
    window.history.replaceState({}, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`)
    return cached
  }

  try {
    cached = sessionStorage.getItem(STORAGE_KEY) || ''
  } catch {
    cached = ''
  }
  return cached
}

export function resetToken(): void {
  cached = ''
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
