import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * 开发模式注入访问令牌（S3）。
 * 生产模式由后端在 index.html 里注入；Vite dev server 不走后端，所以这里读
 * backend/data/.token（后端启动时生成）并塞进模板，开发者不用手工粘贴。
 */
function heibaiheToken(): Plugin {
  const files = [process.env.HEIBAIHE_TOKEN_FILE, path.resolve(root, '../backend/data/.token')].filter(
    Boolean
  ) as string[]

  return {
    name: 'heibaihe-token',
    // 只在 dev server 注入；生产由后端读 index.html 时注入，构建产物绝不能带令牌
    apply: 'serve',
    transformIndexHtml(html) {
      let token = (process.env.HEIBAIHE_TOKEN || '').trim()
      if (!token) {
        for (const file of files) {
          try {
            token = fs.readFileSync(file, 'utf8').trim()
            break
          } catch {
            /* 后端还没启动过，继续找下一个 */
          }
        }
      }
      if (!token) return html
      const tag = `<script>window.__HEIBAIHE_TOKEN__=${JSON.stringify(token)}</script>`
      return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
    },
  }
}

export default defineConfig({
  plugins: [vue(), heibaiheToken()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // 后端只监听 IPv4 回环（S1），这里必须写 127.0.0.1：localhost 可能解析到 ::1
      '/api': 'http://127.0.0.1:3310',
      '/socket.io': { target: 'http://127.0.0.1:3310', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
