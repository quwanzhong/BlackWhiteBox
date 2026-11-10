import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** backend 根目录 */
export const ROOT = path.resolve(__dirname, '..')
/** 数据目录（流程 / 执行记录，单机版零配置；M1-1 起主存储为 SQLite） */
export const DATA_DIR = process.env.HEIBAIHE_DATA_DIR || path.join(ROOT, 'data')
/** SQLite 主库（WAL 模式）。测试可用 HEIBAIHE_DB 指向临时文件。 */
export const DB_FILE = process.env.HEIBAIHE_DB || path.join(DATA_DIR, 'heibaihe.db')
/** 以下为 M1-1 之前的历史 JSON 路径，仅用于一次性迁移与兜底 */
export const EXEC_DIR = path.join(DATA_DIR, 'executions')
export const FLOWS_FILE = path.join(DATA_DIR, 'flows.json')
export const EXEC_INDEX_FILE = path.join(EXEC_DIR, 'index.json')
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')
export const BUGS_FILE = path.join(DATA_DIR, 'bugs.json')
/** 服务端口 */
export const PORT = Number(process.env.PORT || 3310)
/**
 * 监听地址（S1）。默认只绑本机回环，避免同一局域网内的其他机器直接访问测试数据。
 * 需要容器/远程调试时显式设置 HEIBAIHE_HOST=0.0.0.0，并自行承担鉴权风险。
 */
export const HOST = process.env.HEIBAIHE_HOST || '127.0.0.1'
/** 前端构建产物目录（生产模式下由后端托管） */
export const FRONTEND_DIST = path.resolve(ROOT, '..', 'frontend', 'dist')
/**
 * 环境密钥主密钥文件（S7，M2-1）。优先级见 security/keystore.js：
 * 环境变量 HEIBAIHE_MASTER_KEY > 本文件 > 自动生成（权限尽量 0600）。
 */
export const MASTER_KEY_FILE = process.env.HEIBAIHE_MASTER_KEY_FILE || path.join(DATA_DIR, '.master.key')

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(EXEC_DIR, { recursive: true })
}
