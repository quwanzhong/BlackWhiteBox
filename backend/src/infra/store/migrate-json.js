import fs from 'node:fs'
import path from 'node:path'
import { backfillExecutionRows } from './backfill.js'

const FLAG = 'legacy_json_migrated'

function readArray(file, log) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.warn?.(`[store] 跳过无法解析的 ${file}：${err.message}`)
    return []
  }
}

function readJson(file, log) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.warn?.(`[store] 跳过无法解析的 ${file}：${err.message}`)
    return null
  }
}

/**
 * 一次性把旧的 JSON 文件导入 SQLite。
 *
 * - 幂等：完成后写 app_meta；之后的启动直接跳过。
 * - 无损：只读旧文件，不删除、不改名，出问题可以随时回退。
 * - 顺序：旧数组是"新在前"，倒序插入让 rowid DESC 的列表顺序与原行为一致。
 */
export function migrateLegacyJson(db, paths = {}, log = console) {
  const done = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(FLAG)
  if (done) return { skipped: true, ...JSON.parse(done.value) }

  const counts = { flows: 0, projects: 0, bugs: 0, executions: 0, details: 0 }
  const now = Date.now()

  const insertFlow = db.prepare(`
    INSERT OR IGNORE INTO flows (id, project_id, name, type, business, graph_json, created_at, updated_at)
    VALUES (@id, @projectId, @name, @type, @business, @graphJson, @createdAt, @updatedAt)
  `)
  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, code_path, service_base_url, apifox_project_id,
                                    interface_count, folders_json, scan_summary_json, data_json,
                                    created_at, updated_at)
    VALUES (@id, @name, @description, @codePath, @serviceBaseUrl, @apifoxProjectId,
            @interfaceCount, @foldersJson, @scanSummaryJson, @dataJson, @createdAt, @updatedAt)
  `)
  const insertBug = db.prepare(`
    INSERT OR IGNORE INTO bugs (id, project_id, flow_id, status, data_json, created_at, updated_at)
    VALUES (@id, @projectId, @flowId, @status, @dataJson, @createdAt, @updatedAt)
  `)
  const insertExecution = db.prepare(`
    INSERT OR IGNORE INTO executions (id, flow_id, flow_name, flow_type, project_id, business,
                                      status, started_at, finished_at, summary_json, detail_json,
                                      created_at, updated_at)
    VALUES (@id, @flowId, @flowName, @flowType, @projectId, @business,
            @status, @startedAt, @finishedAt, @summaryJson, @detailJson, @createdAt, @updatedAt)
  `)
  const updateDetail = db.prepare('UPDATE executions SET detail_json = ? WHERE id = ?')

  const execRow = (exec, detail = null) => ({
    id: exec.id,
    flowId: exec.flowId ?? null,
    flowName: exec.flowName ?? null,
    flowType: exec.flowType ?? null,
    projectId: exec.projectId ?? null,
    business: exec.business ?? null,
    status: exec.status ?? null,
    startedAt: exec.startedAt ?? null,
    finishedAt: exec.finishedAt ?? null,
    summaryJson: exec.summary ? JSON.stringify(exec.summary) : null,
    detailJson: detail ? JSON.stringify(detail) : null,
    createdAt: exec.startedAt || exec.createdAt || now,
    updatedAt: exec.finishedAt || exec.startedAt || now,
  })

  const projectSummary = (scan) =>
    scan
      ? JSON.stringify({
          scannedAt: scan.scannedAt,
          scannedFiles: scan.scannedFiles,
          callCount: scan.callCount,
          matchedCalls: scan.matchedCalls,
          matchRate: scan.matchRate,
          matchedInterfaces: scan.matchedInterfaces,
          groupCount: scan.groups?.length || 0,
        })
      : null

  const tx = db.transaction(() => {
    for (const flow of readArray(paths.flowsFile, log).reverse()) {
      if (!flow?.id) continue
      counts.flows += insertFlow.run({
        id: flow.id,
        projectId: flow.projectId ?? null,
        name: flow.name ?? null,
        type: flow.type ?? null,
        business: flow.business ?? null,
        graphJson: JSON.stringify(flow),
        createdAt: flow.createdAt || now,
        updatedAt: flow.updatedAt || flow.createdAt || now,
      }).changes
    }

    for (const project of readArray(paths.projectsFile, log).reverse()) {
      if (!project?.id) continue
      const interfaces = project.interfaces || []
      counts.projects += insertProject.run({
        id: project.id,
        name: project.name || '未命名项目',
        description: project.description || '',
        codePath: project.codePath || '',
        serviceBaseUrl: project.serviceBaseUrl || '',
        apifoxProjectId: project.apifox?.projectId || '',
        interfaceCount: project.interfaceIds?.length || 0,
        foldersJson: JSON.stringify([...new Set(interfaces.map((it) => it.folder).filter(Boolean))]),
        scanSummaryJson: projectSummary(project.scan),
        dataJson: JSON.stringify(project),
        createdAt: project.createdAt || now,
        updatedAt: project.updatedAt || project.createdAt || now,
      }).changes
    }

    for (const bug of readArray(paths.bugsFile, log).reverse()) {
      if (!bug?.id) continue
      counts.bugs += insertBug.run({
        id: bug.id,
        projectId: bug.projectId ?? null,
        flowId: bug.flowId ?? null,
        status: bug.status ?? null,
        dataJson: JSON.stringify(bug),
        createdAt: bug.createdAt || now,
        updatedAt: bug.updatedAt || bug.createdAt || now,
      }).changes
    }

    const index = readArray(paths.execIndexFile, log)
    const seen = new Set()
    for (const meta of [...index].reverse()) {
      if (!meta?.id) continue
      seen.add(meta.id)
      counts.executions += insertExecution.run(execRow(meta)).changes
    }

    // 详情文件：既补 index 里的条目，也兜住"有详情没索引"的孤儿
    if (paths.execDir && fs.existsSync(paths.execDir)) {
      for (const name of fs.readdirSync(paths.execDir)) {
        if (!name.endsWith('.json') || name === 'index.json') continue
        const detail = readJson(path.join(paths.execDir, name), log)
        if (!detail?.id) continue
        if (!seen.has(detail.id)) {
          counts.executions += insertExecution.run(execRow(detail, detail)).changes
          seen.add(detail.id)
        } else {
          counts.details += updateDetail.run(JSON.stringify(detail), detail.id).changes
        }
      }
    }
  })

  tx()
  // 导入的 detail_json 同样要展开成行（与"老库升级"共用一份逻辑，见 backfill.js）
  backfillExecutionRows(db, log)
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    FLAG,
    JSON.stringify({ at: now, ...counts })
  )
  const total = counts.flows + counts.projects + counts.bugs + counts.executions
  if (total || counts.details) {
    log?.info?.(
      `[store] 已从 JSON 迁移：flows=${counts.flows} projects=${counts.projects} bugs=${counts.bugs} ` +
        `executions=${counts.executions} details=${counts.details}`
    )
  }
  return counts
}
