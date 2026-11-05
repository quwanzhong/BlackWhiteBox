import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { FLOWS_FILE, EXEC_DIR, EXEC_INDEX_FILE, PROJECTS_FILE, BUGS_FILE, ensureDirs } from './config.js'

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
    if (!flow.id) flow.id = crypto.randomUUID()
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

  // ---------- 项目（一个前端工程 → 一组 Apifox 接口） ----------
  listProjects() {
    return readJson(PROJECTS_FILE, [])
  },
  getProject(id) {
    return this.listProjects().find((p) => p.id === id) || null
  },
  saveProject(project) {
    const list = this.listProjects()
    const i = list.findIndex((p) => p.id === project.id)
    project.updatedAt = Date.now()
    if (i >= 0) list[i] = project
    else {
      project.createdAt = Date.now()
      list.unshift(project)
    }
    writeJson(PROJECTS_FILE, list)
    return project
  },
  deleteProject(id) {
    writeJson(PROJECTS_FILE, this.listProjects().filter((p) => p.id !== id))
  },

  // ---------- 缺陷反馈 ----------
  listBugs() {
    return readJson(BUGS_FILE, [])
  },
  saveBug(bug) {
    const list = this.listBugs()
    const i = list.findIndex((b) => b.id === bug.id)
    bug.updatedAt = Date.now()
    if (i >= 0) list[i] = bug
    else {
      bug.createdAt = Date.now()
      list.unshift(bug)
    }
    writeJson(BUGS_FILE, list)
    return bug
  },
  deleteBug(id) {
    writeJson(BUGS_FILE, this.listBugs().filter((b) => b.id !== id))
  },
}
