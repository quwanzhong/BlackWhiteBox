import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import { Server } from 'socket.io'
import { PORT, FRONTEND_DIST } from './config.js'
import flowsRouter from './routes/flows.js'
import executionsRouter from './routes/executions.js'
import importRouter from './routes/import.js'
import apifoxRouter from './routes/apifox.js'
import projectsRouter from './routes/projects.js'
import bugsRouter from './routes/bugs.js'
import fsRouter from './routes/fs.js'
import statsRouter from './routes/stats.js'
import { seedIfEmpty } from './seed.js'

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json({ limit: '20mb' }))

// 把 io 注入请求，供执行引擎推送实时事件
app.use((req, _res, next) => {
  req.io = io
  next()
})

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

// WebSocket：执行事件房间
io.on('connection', (socket) => {
  socket.on('join', ({ room } = {}) => {
    if (room) socket.join(room)
  })
  socket.on('leave', ({ room } = {}) => {
    if (room) socket.leave(room)
  })
})

// 生产模式：托管前端构建产物（npm run build 之后生效）
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next()
    }
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
}

// 首次启动写入演示流程
seedIfEmpty()

server.listen(PORT, () => {
  console.log('==============================================')
  console.log('  黑百盒 · 黑白盒测试平台（单机版）')
  console.log(`  服务地址: http://localhost:${PORT}`)
  console.log(`  健康检查: http://localhost:${PORT}/api/health`)
  console.log('==============================================')
})
