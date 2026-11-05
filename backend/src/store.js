import fs from 'node:fs'
import path from 'node:path'
import { FLOWS_FILE, EXEC_DIR, EXEC_INDEX_FILE, ensureDirs } from './config.js'

ensureDirs()

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function execFilePath(id) {
  return path.join(EXEC_DIR, `${id}.json`)
}

/**
 * 单机版 JSON 文件存储层。
 * 后续推广换成 SQLite/PostgreSQL 时，只需替换本文件的实现，其余代码不动。
 */
export const store = {
  // ---------- 流程 ----------
  listFlows() {
    return readJson(FLOWS_FILE, [])
  },
  getFlow(id) {
    return this.listFlows().find((f) => f.id === id) || null
  },
  saveFlow(flow) {
    const flows = this.listFlows()
    const i = flows.findIndex((f) => f.id === flow.id)
    flow.updatedAt = Date.now()
    if (i >= 0) flows[i] = flow
    else {
      flow.createdAt = Date.now()
      flows.unshift(flow)
    }
    writeJson(FLOWS_FILE, flows)
    return flow
  },
  deleteFlow(id) {
    writeJson(FLOWS_FILE, this.listFlows().filter((f) => f.id !== id))
  },

  // ---------- 执行记录 ----------
  listExecutions() {
    // index.json 里是概要（新执行的排前面）
    return readJson(EXEC_INDEX_FILE, [])
  },
  saveExecutionMeta(meta) {
    const list = this.listExecutions()
    const i = list.findIndex((e) => e.id === meta.id)
    if (i >= 0) list[i] = { ...list[i], ...meta }
    else list.unshift(meta)
    writeJson(EXEC_INDEX_FILE, list)
  },
  saveExecutionDetail(exec) {
    writeJson(execFilePath(exec.id), exec)
  },
  getExecutionDetail(id) {
    return readJson(execFilePath(id), null)
  },
}
