/**
 * 调用图旁路存储（M3'-2）。
 *
 * 全量图（2000 文件级别的 nodes/edges）不进 SQLite 的 `data_json`：
 * 项目读路径本来就要载整份接口快照，再塞几 MB 图会把详情接口拖死。
 * 所以库里只存「摘要」，图本身落到 `data/codegraph/<projectId>.json`，
 * 与 apifox 的 `oas-cache.json` 同一套「可重建的本机缓存」语义。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

function dir() {
  return path.join(process.env.HEIBAIHE_DATA_DIR || DATA_DIR, 'codegraph')
}

function graphFile(projectId) {
  return path.join(dir(), `${String(projectId).replace(/[^\w-]/g, '_')}.json`)
}

export function saveGraph(projectId, graph) {
  const file = graphFile(projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const json = JSON.stringify(graph)
  fs.writeFileSync(file, json, 'utf8')
  return { file, bytes: Buffer.byteLength(json) }
}

export function loadGraph(projectId) {
  try {
    const raw = fs.readFileSync(graphFile(projectId), 'utf8')
    const graph = JSON.parse(raw)
    return graph && typeof graph === 'object' ? graph : null
  } catch {
    return null
  }
}

export function removeGraph(projectId) {
  try {
    fs.rmSync(graphFile(projectId), { force: true })
    return true
  } catch {
    return false
  }
}
