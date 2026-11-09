/**
 * HTTP / WebSocket 装配（M1-3 安全基线 S1~S6 的落点）。
 *
 * 拆出 createApp() 是为了能在测试里起一个真实端口，验证 401 / 403 / 413 这些
 * 只有走完整中间件链才能暴露的行为；index.js 只负责监听与打印启动信息。
 */
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import { Server } from 'socket.io'
import { FRONTEND_DIST } from './config.js'
import { loadOrCreateToken, readToken, safeEqual, socketToken } from './security/token.js'
import flowsRouter from './routes/flows.js'
import executionsRouter from './routes/executions.js'
import importRouter from './routes/import.js'
import apifoxRouter from './routes/apifox.js'
import projectsRouter from './routes/projects.js'
import bugsRouter from './routes/bugs.js'
import fsRouter from './routes/fs.js'
import statsRouter from './routes/stats.js'

/** S6：请求体上限从 20 MB 收到 5 MB（1737 条接口的 OpenAPI 约 3.4 MB，留出余量） */
export const BODY_LIMIT = '5mb'

const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Heibaihe-Token']
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']

/** S2：只放行本机页面（含 Vite 开发/预览端口与 Tauri 自定义协议） */
export function buildAllowedOrigins(port) {
  const set = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
    'tauri://localhost',
    'https://tauri.localhost',
  ])
  for (const item of String(process.env.HEIBAIHE_ALLOWED_ORIGINS || '').split(',')) {
    const origin = item.trim()
    if (origin) set.add(origin)
  }
  return set
}

function tokenScript(token) {
  // 注入到 <head>，避免业务代码去猜 token 从哪来；转义 < 防止提前闭合 script
  return `<script>window.__HEIBAIHE_TOKEN__=${JSON.stringify(token).replace(/</g, '\\u003c')}</script>`
}

function renderIndex(token) {
  const html = fs.readFileSync(path.join(FRONTEND_DIST, 'index.html'), 'utf8')
  return html.includes('</head>') ? html.replace('</head>', `${tokenScript(token)}</head>`) : tokenScript(token) + html
}

export function createApp({ token = loadOrCreateToken(), originPort = Number(process.env.PORT || 3310), log = console } = {}) {
  const app = express()
  const server = http.createServer(app)
  const origins = buildAllowedOrigins(originPort)
  const io = new Server(server, {
    cors: { origin: [...origins], methods: ['GET', 'POST'] },
  })

  app.disable('etag')
  app.disable('x-powered-by')

  // ---------- S2：来源校验 ----------
  // CORS 只是浏览器约定，服务端仍会执行请求；这里直接 403，让「跨域被拒」可以测出来。
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && !origins.has(origin)) {
      return res.status(403).json({ error: '请求来源不被允许', code: 'ORIGIN_DENIED' })
    }
    next()
  })
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
      methods: ALLOWED_METHODS,
      allowedHeaders: ALLOWED_HEADERS,
      maxAge: 600,
    })
  )

  // ---------- S3：鉴权 ----------
  // 放在 body 解析之前：未授权的请求连 5 MB 都不给解析；/api/health 保持公开供探活。
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next()
    if (safeEqual(readToken(req), token)) return next()
    res.status(401).json({ error: '缺少或无效的访问令牌', code: 'UNAUTHORIZED' })
  })

  // ---------- S6：请求体上限 + 只接受 JSON ----------
  app.use(express.json({ limit: BODY_LIMIT }))

  // 接口响应不参与浏览器缓存：否则 GET 会返回 304（空 body），
  // axios 只认 2xx，会把 304 当成错误，页面就会误显示“没有数据”。
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  // 把 io 注入请求，供执行引擎推送实时事件
  app.use((req, _res, next) => {
    req.io = io
    next()
  })

  // 静态资源（JS/CSS/图片）先于页面：这些是构建产物，不含令牌
  // 注意：index.html 必须走下面的注入逻辑，不能被 static 原样返回
  if (fs.existsSync(FRONTEND_DIST)) {
    app.get('/index.html', (_req, res) => {
      try {
        res.set('Cache-Control', 'no-store').type('html').send(renderIndex(token))
      } catch (err) {
        res.status(500).json({ error: '前端构建产物不可读', code: 'FRONTEND_UNAVAILABLE' })
      }
    })
    app.use(express.static(FRONTEND_DIST, { index: false, etag: false }))
  }

  app.use('/api/flows', flowsRouter)
  app.use('/api/executions', executionsRouter)
  app.use('/api/import', importRouter)
  app.use('/api/apifox', apifoxRouter)
  app.use('/api/projects', projectsRouter)
  app.use('/api/bugs', bugsRouter)
  app.use('/api/fs', fsRouter)
  app.use('/api/stats', statsRouter)

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: '黑百盒测试平台', time: Date.now() })
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' })
  })

  // 生产模式：托管前端构建产物，并把令牌注入 index.html（浏览器无需手工粘贴）
  if (fs.existsSync(FRONTEND_DIST)) {
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
        return next()
      }
      try {
        res.set('Cache-Control', 'no-store').type('html').send(renderIndex(token))
      } catch (err) {
        next(err)
      }
    })
  }

  // 统一错误出口：不把内部堆栈/路径回给客户端
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: `请求体超过 ${BODY_LIMIT} 上限`, code: 'BODY_TOO_LARGE' })
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON', code: 'BODY_PARSE_ERROR' })
    }
    log?.error?.('[http] 未处理异常:', err)
    res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL' })
  })

  // ---------- WebSocket 鉴权 ----------
  io.use((socket, next) => {
    if (safeEqual(socketToken(socket), token)) return next()
    next(new Error('unauthorized'))
  })

  io.on('connection', (socket) => {
    // 房间名限定为 exec:<uuid>，避免客户端订阅任意房间
    socket.on('join', ({ room } = {}) => {
      if (typeof room === 'string' && /^exec:[\w-]{1,64}$/.test(room)) socket.join(room)
    })
    socket.on('leave', ({ room } = {}) => {
      if (typeof room === 'string' && room) socket.leave(room)
    })
  })

  return { app, server, io, token, origins }
}
