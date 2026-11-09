import fs from 'node:fs'
import { HOST, PORT, FRONTEND_DIST } from './config.js'
import { createApp } from './app.js'
import { TOKEN_FILE } from './security/token.js'
import { seedIfEmpty } from './seed.js'

const { server, token } = createApp({ originPort: PORT })

// 首次启动写入演示流程
seedIfEmpty()

const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST
const base = `http://${shownHost}:${PORT}`

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。请关闭占用进程，或用 PORT=xxxx 换一个端口。`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, HOST, () => {
  console.log('==============================================')
  console.log('  黑百盒 · 黑白盒测试平台（单机版）')
  console.log(`  服务地址: ${base}`)
  console.log(`  健康检查: ${base}/api/health`)
  console.log(`  访问令牌: ${TOKEN_FILE}`)
  console.log('----------------------------------------------')
  console.log(`  首次打开请用带令牌的地址：`)
  console.log(`  ${base}/?token=${token}`)
  console.log('  （令牌已注入页面，之后直接访问即可）')
  console.log('==============================================')
  if (HOST !== '127.0.0.1') {
    console.warn(`⚠ 当前监听 ${HOST}，局域网内其他设备也能访问；请确保令牌未泄露。`)
  }
  if (!fs.existsSync(FRONTEND_DIST)) console.warn('未找到前端构建产物，仅提供 API。')
})
