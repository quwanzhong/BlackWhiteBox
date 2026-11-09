/**
 * 本地访问令牌（S3）。
 *
 * 单机版没有账号体系，但「没有鉴权」意味着任意网页都能读写本机数据：
 * 一个恶意页面只要 fetch('http://127.0.0.1:3310/api/flows') 就能拿到全部测试数据，
 * 还能通过 /api/fs/list 探测磁盘、通过执行接口对内网发起请求。
 *
 * 方案：启动时生成 32 字节随机 token（或读 HEIBAIHE_TOKEN），写入 data/.token（权限 600），
 * 所有 /api 请求与 WebSocket 握手都校验它。浏览器端由后端在 index.html 里注入，
 * 开发者无需手工粘贴；CLI/脚本用 Authorization: Bearer。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

export const TOKEN_FILE = path.join(DATA_DIR, '.token')

/** 令牌至少 16 字符，避免有人用 "1" 当密码 */
const MIN_LENGTH = 16

function isValid(token) {
  return typeof token === 'string' && token.length >= MIN_LENGTH
}

/**
 * 读取或创建令牌。优先级：HEIBAIHE_TOKEN > data/.token > 新建。
 * 只在启动时调用一次，之后由调用方持有。
 */
export function loadOrCreateToken(log = console) {
  const fromEnv = String(process.env.HEIBAIHE_TOKEN || '').trim()
  if (fromEnv) {
    if (!isValid(fromEnv)) log?.warn?.('[security] HEIBAIHE_TOKEN 太短（至少 16 字符），已拒绝使用')
    else return fromEnv
  }

  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (isValid(existing)) return existing
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.warn?.(`[security] 读取令牌失败：${err.message}`)
  }

  const token = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 })
    // Windows 上 mode 不生效，显式再 chmod 一次（NTFS 下是 no-op，不报错）
    try {
      fs.chmodSync(TOKEN_FILE, 0o600)
    } catch {
      /* ignore */
    }
  } catch (err) {
    // 写不进去（只读目录/打包环境）就只保留在内存里，进程退出后失效
    log?.warn?.(`[security] 令牌无法落盘，仅本次进程有效：${err.message}`)
  }
  return token
}

/** 从请求里取令牌：Authorization: Bearer / x-heibaihe-token / ?token=（仅用于首屏跳转） */
export function readToken(req) {
  const headers = req?.headers || {}
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''))
  if (bearer) return bearer[1].trim()
  const custom = headers['x-heibaihe-token']
  if (custom) return String(custom).trim()
  if (req?.query?.token) return String(req.query.token).trim()
  return ''
}

/** 定长比较，避免按字符比较泄漏长度/内容（token 是十六进制，长度恒定） */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/** WebSocket 握手鉴权：从 auth.token / query.token / header 取 */
export function socketToken(socket) {
  const auth = socket?.handshake?.auth || {}
  if (auth.token) return String(auth.token)
  const query = socket?.handshake?.query || {}
  if (query.token) return String(query.token)
  return String(socket?.handshake?.headers?.['x-heibaihe-token'] || '')
}
