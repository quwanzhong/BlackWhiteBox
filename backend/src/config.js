import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** backend 根目录 */
export const ROOT = path.resolve(__dirname, '..')
/** 数据目录（流程 / 执行记录，JSON 文件存储，单机版零配置） */
export const DATA_DIR = path.join(ROOT, 'data')
export const EXEC_DIR = path.join(DATA_DIR, 'executions')
export const FLOWS_FILE = path.join(DATA_DIR, 'flows.json')
export const EXEC_INDEX_FILE = path.join(EXEC_DIR, 'index.json')
/** 服务端口 */
export const PORT = Number(process.env.PORT || 3310)
/** 前端构建产物目录（生产模式下由后端托管） */
export const FRONTEND_DIST = path.resolve(ROOT, '..', 'frontend', 'dist')

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(EXEC_DIR, { recursive: true })
}
