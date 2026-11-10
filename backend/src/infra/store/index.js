import crypto from 'node:crypto'

function parse(json, fallback) {
  if (json === null || json === undefined || json === '') return fallback
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

function foldersOf(interfaces) {
  return [...new Set((interfaces || []).map((it) => it.folder).filter(Boolean))]
}

/** 与 projects/service.js 的 summarize() 保持同一份投影，供列表页直接使用 */
function scanSummaryOf(scan) {
  if (!scan) return null
  return {
    scannedAt: scan.scannedAt,
    scannedFiles: scan.scannedFiles,
    callCount: scan.callCount,
    matchedCalls: scan.matchedCalls,
    matchRate: scan.matchRate,
    matchedInterfaces: scan.matchedInterfaces,
    groupCount: scan.groups?.length || 0,
  }
}

/**
 * 用给定的 SQLite 连接创建 store（便于测试用 :memory:）。
 * 门面方法与 M1-1 之前的 JSON 版本完全一致，仅新增 listProjectSummaries()。
 */
export function createStore(db) {
  const s = {
    // ---------- 流程 ----------
    listFlows: db.prepare('SELECT graph_json FROM flows ORDER BY rowid DESC'),
    getFlow: db.prepare('SELECT graph_json FROM flows WHERE id = ?'),
    saveFlow: db.prepare(`
      INSERT INTO flows (id, project_id, name, type, business, graph_json, created_at, updated_at)
      VALUES (@id, @projectId, @name, @type, @business, @graphJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name       = excluded.name,
        type       = excluded.type,
        business   = excluded.business,
        graph_json = excluded.graph_json,
        updated_at = excluded.updated_at
    `),
    deleteFlow: db.prepare('DELETE FROM flows WHERE id = ?'),

    // ---------- 执行记录 ----------
    listExecutions: db.prepare(`
      SELECT id, flow_id, flow_name, flow_type, project_id, business,
             status, started_at, finished_at, summary_json, env_id, env_version,
             suite_run_id, failure_class, failure_reason
      FROM executions ORDER BY rowid DESC
    `),
    getExecutionRow: db.prepare('SELECT * FROM executions WHERE id = ?'),
    listExecutionsBySuiteRun: db.prepare(`
      SELECT id, flow_id, flow_name, flow_type, project_id, business,
             status, started_at, finished_at, summary_json, env_id, env_version,
             suite_run_id, failure_class, failure_reason
      FROM executions WHERE suite_run_id = ? ORDER BY started_at, rowid
    `),
    listExecutionsByFailureClass: db.prepare(`
      SELECT id, flow_id, flow_name, flow_type, project_id, business,
             status, started_at, finished_at, summary_json, env_id, env_version,
             suite_run_id, failure_class, failure_reason
      FROM executions WHERE failure_class = ? ORDER BY rowid DESC
    `),
    saveExecutionContext: db.prepare('UPDATE executions SET context_json = ?, updated_at = ? WHERE id = ?'),
    upsertStep: db.prepare(`
      INSERT INTO execution_steps (execution_id, seq, node_id, status, data_json)
      VALUES (@executionId, @seq, @nodeId, @status, @dataJson)
      ON CONFLICT(execution_id, seq) DO UPDATE SET
        node_id   = excluded.node_id,
        status    = excluded.status,
        data_json = excluded.data_json
    `),
    listSteps: db.prepare('SELECT data_json FROM execution_steps WHERE execution_id = ? ORDER BY seq'),
    deleteSteps: db.prepare('DELETE FROM execution_steps WHERE execution_id = ?'),
    listEvents: db.prepare(`
      SELECT seq, ts, type, payload_json FROM execution_events
      WHERE execution_id = ? ORDER BY seq
    `),
    insertEvent: db.prepare(`
      INSERT OR REPLACE INTO execution_events (execution_id, seq, ts, type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `),
    deleteEvents: db.prepare('DELETE FROM execution_events WHERE execution_id = ?'),
    getEventSeq: db.prepare('SELECT event_seq FROM executions WHERE id = ?'),
    setEventSeq: db.prepare('UPDATE executions SET event_seq = ?, updated_at = ? WHERE id = ?'),
    // M2-5：断线重放只取 after 之后的事件，避免把整段历史（几千条）读进内存
    listEventsAfter: db.prepare(`
      SELECT seq, ts, type, payload_json FROM execution_events
      WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `),
    // M2-5：会话恢复快照（已执行节点 / 待执行队列 / 变量 / 事件游标）
    saveResume: db.prepare('UPDATE executions SET resume_json = ?, updated_at = ? WHERE id = ?'),
    /** 进程重启时仍处于非终态的执行（需要重建会话） */
    listUnfinishedExecutions: db.prepare(`
      SELECT * FROM executions
      WHERE finished_at IS NULL AND status IN ('queued', 'running', 'paused')
      ORDER BY started_at
    `),
    saveExecutionMeta: db.prepare(`
      INSERT INTO executions (id, flow_id, flow_name, flow_type, project_id, business,
                              status, started_at, finished_at, summary_json,
                              env_id, env_version, suite_run_id,
                              failure_class, failure_reason, created_at, updated_at)
      VALUES (@id, @flowId, @flowName, @flowType, @projectId, @business,
              @status, @startedAt, @finishedAt, @summaryJson,
              @envId, @envVersion, @suiteRunId,
              @failureClass, @failureReason, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        flow_id      = COALESCE(excluded.flow_id, executions.flow_id),
        flow_name    = COALESCE(excluded.flow_name, executions.flow_name),
        flow_type    = COALESCE(excluded.flow_type, executions.flow_type),
        project_id   = COALESCE(excluded.project_id, executions.project_id),
        business     = COALESCE(excluded.business, executions.business),
        status       = COALESCE(excluded.status, executions.status),
        started_at   = COALESCE(excluded.started_at, executions.started_at),
        finished_at  = COALESCE(excluded.finished_at, executions.finished_at),
        summary_json = COALESCE(excluded.summary_json, executions.summary_json),
        env_id       = COALESCE(excluded.env_id, executions.env_id),
        env_version  = COALESCE(excluded.env_version, executions.env_version),
        suite_run_id = COALESCE(excluded.suite_run_id, executions.suite_run_id),
        failure_class  = COALESCE(excluded.failure_class, executions.failure_class),
        failure_reason = COALESCE(excluded.failure_reason, executions.failure_reason),
        updated_at   = excluded.updated_at
    `),

    // ---------- 项目 ----------
    listProjects: db.prepare('SELECT data_json FROM projects ORDER BY rowid DESC'),
    listProjectSummaries: db.prepare(`
      SELECT id, name, description, code_path, service_base_url, apifox_project_id,
             interface_count, folders_json, scan_summary_json, created_at, updated_at
      FROM projects ORDER BY rowid DESC
    `),
    getProject: db.prepare('SELECT data_json FROM projects WHERE id = ?'),
    saveProject: db.prepare(`
      INSERT INTO projects (id, name, description, code_path, service_base_url, apifox_project_id,
                            interface_count, folders_json, scan_summary_json, data_json,
                            created_at, updated_at)
      VALUES (@id, @name, @description, @codePath, @serviceBaseUrl, @apifoxProjectId,
              @interfaceCount, @foldersJson, @scanSummaryJson, @dataJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name              = excluded.name,
        description       = excluded.description,
        code_path         = excluded.code_path,
        service_base_url  = excluded.service_base_url,
        apifox_project_id = excluded.apifox_project_id,
        interface_count   = excluded.interface_count,
        folders_json      = excluded.folders_json,
        scan_summary_json = excluded.scan_summary_json,
        data_json         = excluded.data_json,
        updated_at        = excluded.updated_at
    `),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),

    // ---------- 应用元数据（迁移标记 / 目录白名单等） ----------
    getAppMeta: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
    setAppMeta: db.prepare(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),

    // ---------- 缺陷 ----------
    listBugs: db.prepare('SELECT data_json FROM bugs ORDER BY rowid DESC'),    getBug: db.prepare('SELECT data_json FROM bugs WHERE id = ?'),
    saveBug: db.prepare(`
      INSERT INTO bugs (id, project_id, flow_id, status, data_json, created_at, updated_at)
      VALUES (@id, @projectId, @flowId, @status, @dataJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        flow_id    = excluded.flow_id,
        status     = excluded.status,
        data_json  = excluded.data_json,
        updated_at = excluded.updated_at
    `),
    deleteBug: db.prepare('DELETE FROM bugs WHERE id = ?'),

    // ---------- 环境（M2-1）----------
    listEnvironmentRows: db.prepare(`
      SELECT id, project_id, name, base_url, variables_json, headers_json,
             settings_json, version, created_at, updated_at
      FROM environments ORDER BY rowid DESC
    `),
    getEnvironmentRow: db.prepare(`
      SELECT id, project_id, name, base_url, variables_json, headers_json,
             settings_json, version, created_at, updated_at
      FROM environments WHERE id = ?
    `),
    saveEnvironment: db.prepare(`
      INSERT INTO environments (id, project_id, name, base_url, variables_json, headers_json,
                                settings_json, version, created_at, updated_at)
      VALUES (@id, @projectId, @name, @baseUrl, @variablesJson, @headersJson,
              @settingsJson, @version, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        project_id     = excluded.project_id,
        name           = excluded.name,
        base_url       = excluded.base_url,
        variables_json = excluded.variables_json,
        headers_json   = excluded.headers_json,
        settings_json  = excluded.settings_json,
        version        = excluded.version,
        updated_at     = excluded.updated_at
    `),
    deleteEnvironmentRow: db.prepare('DELETE FROM environments WHERE id = ?'),
    listSecretRows: db.prepare(
      'SELECT key, value_blob FROM environment_secrets WHERE environment_id = ? ORDER BY key'
    ),
    listSecretKeys: db.prepare(
      'SELECT key FROM environment_secrets WHERE environment_id = ? ORDER BY key'
    ),
    getSecretRow: db.prepare(
      'SELECT value_blob FROM environment_secrets WHERE environment_id = ? AND key = ?'
    ),
    saveSecretRow: db.prepare(`
      INSERT INTO environment_secrets (environment_id, key, value_blob, created_at, updated_at)
      VALUES (@environmentId, @key, @valueBlob, @now, @now)
      ON CONFLICT(environment_id, key) DO UPDATE SET
        value_blob = excluded.value_blob,
        updated_at = excluded.updated_at
    `),
    deleteSecretRow: db.prepare(
      'DELETE FROM environment_secrets WHERE environment_id = ? AND key = ?'
    ),
    deleteSecrets: db.prepare('DELETE FROM environment_secrets WHERE environment_id = ?'),

    // ---------- 套件（M2-2） ----------
    listSuiteRows: db.prepare(`
      SELECT id, project_id, name, description, flow_ids_json, strategy_json,
             environment_id, created_at, updated_at
      FROM suites ORDER BY rowid DESC
    `),
    getSuiteRow: db.prepare('SELECT * FROM suites WHERE id = ?'),
    saveSuite: db.prepare(`
      INSERT INTO suites (id, project_id, name, description, flow_ids_json, strategy_json,
                          environment_id, created_at, updated_at)
      VALUES (@id, @projectId, @name, @description, @flowIdsJson, @strategyJson,
              @environmentId, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        project_id     = excluded.project_id,
        name           = excluded.name,
        description    = excluded.description,
        flow_ids_json  = excluded.flow_ids_json,
        strategy_json  = excluded.strategy_json,
        environment_id = excluded.environment_id,
        updated_at     = excluded.updated_at
    `),
    deleteSuite: db.prepare('DELETE FROM suites WHERE id = ?'),

    listSuiteRunRows: db.prepare(`
      SELECT id, suite_id, suite_name, project_id, status, strategy_json,
             env_id, env_version, summary_json, started_at, finished_at,
             created_at, updated_at
      FROM suite_runs ORDER BY rowid DESC
    `),
    listSuiteRunRowsBySuite: db.prepare(`
      SELECT id, suite_id, suite_name, project_id, status, strategy_json,
             env_id, env_version, summary_json, started_at, finished_at,
             created_at, updated_at
      FROM suite_runs WHERE suite_id = ? ORDER BY rowid DESC LIMIT ?
    `),
    getSuiteRunRow: db.prepare('SELECT * FROM suite_runs WHERE id = ?'),
    saveSuiteRun: db.prepare(`
      INSERT INTO suite_runs (id, suite_id, suite_name, project_id, status, strategy_json,
                              env_id, env_version, summary_json, started_at, finished_at,
                              created_at, updated_at)
      VALUES (@id, @suiteId, @suiteName, @projectId, @status, @strategyJson,
              @envId, @envVersion, @summaryJson, @startedAt, @finishedAt,
              @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        status        = excluded.status,
        summary_json  = COALESCE(excluded.summary_json, suite_runs.summary_json),
        started_at    = COALESCE(excluded.started_at, suite_runs.started_at),
        finished_at   = COALESCE(excluded.finished_at, suite_runs.finished_at),
        env_id        = COALESCE(excluded.env_id, suite_runs.env_id),
        env_version   = COALESCE(excluded.env_version, suite_runs.env_version),
        updated_at    = excluded.updated_at
    `),
    deleteSuiteRuns: db.prepare('DELETE FROM suite_runs WHERE suite_id = ?'),
    /** 进程重启时仍处于非终态的套件运行（M2-5 收敛为 stopped） */
    listUnfinishedSuiteRuns: db.prepare(`
      SELECT * FROM suite_runs
      WHERE finished_at IS NULL AND status IN ('queued', 'running')
      ORDER BY started_at
    `),

    // ---------- 覆盖率快照（M3-1） ----------
    getCoverageId: db.prepare('SELECT id FROM coverage WHERE execution_id = ? AND node_id = ?'),
    upsertCoverage: db.prepare(`
      INSERT INTO coverage (id, execution_id, node_id, source, mode, status,
                            exec_blob, result_json, error, captured_at, analyzed_at)
      VALUES (@id, @executionId, @nodeId, @source, @mode, @status,
              @execBlob, @resultJson, @error, @capturedAt, @analyzedAt)
      ON CONFLICT(execution_id, node_id) DO UPDATE SET
        source      = excluded.source,
        mode        = excluded.mode,
        status      = excluded.status,
        exec_blob   = excluded.exec_blob,
        result_json = excluded.result_json,
        error       = excluded.error,
        captured_at = excluded.captured_at,
        analyzed_at = excluded.analyzed_at
    `),
    // 列表只给投影 + blob 长度：前端面板不需要几百 KB 的原始证据
    listCoverage: db.prepare(`
      SELECT id, execution_id, node_id, source, mode, status,
             length(exec_blob) AS bytes, error, captured_at, analyzed_at
      FROM coverage WHERE execution_id = ? ORDER BY captured_at, rowid
    `),
    getCoverage: db.prepare('SELECT * FROM coverage WHERE id = ?'),
    updateCoverageResult: db.prepare(`
      UPDATE coverage SET status = ?, result_json = ?, error = ?, analyzed_at = ?
      WHERE id = ?
    `),
  }

  const flowRow = (row) => (row ? parse(row.graph_json, null) : null)
  const executionRow = (row) => {
    const summary = parse(row.summary_json, null)
    return {
      id: row.id,
      flowId: row.flow_id,
      flowName: row.flow_name,
      flowType: row.flow_type,
      projectId: row.project_id,
      business: row.business,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      envId: row.env_id || null,
      envVersion: row.env_version ?? null,
      suiteRunId: row.suite_run_id || null,
      // 投影列优先；仅 summary 有归类的历史行也能在列表展示
      failureClass: row.failure_class || summary?.failureClass || null,
      failureReason: row.failure_reason || summary?.failureReason || null,
      summary,
    }
  }
  const projectRow = (row) => (row ? parse(row.data_json, null) : null)
  const bugRow = (row) => (row ? parse(row.data_json, null) : null)
  const environmentRow = (row) =>
    row
      ? {
          id: row.id,
          projectId: row.project_id || null,
          name: row.name,
          baseUrl: row.base_url || '',
          variables: parse(row.variables_json, {}),
          headers: parse(row.headers_json, {}),
          settings: parse(row.settings_json, {}),
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null
  const coverageRow = (row, { withBlob = false } = {}) => {
    if (!row) return null
    const out = {
      id: row.id,
      executionId: row.execution_id,
      nodeId: row.node_id,
      source: row.source,
      mode: row.mode,
      status: row.status,
      error: row.error || null,
      capturedAt: row.captured_at,
      analyzedAt: row.analyzed_at ?? null,
      result: parse(row.result_json, null),
    }
    if (withBlob) {
      out.execBlob = row.exec_blob || null
      out.bytes = row.exec_blob?.length ?? 0
    } else {
      out.bytes = row.bytes ?? row.exec_blob?.length ?? 0
    }
    return out
  }
  const suiteRow = (row) =>
    row
      ? {
          id: row.id,
          projectId: row.project_id || null,
          name: row.name,
          description: row.description || '',
          flowIds: parse(row.flow_ids_json, []),
          strategy: parse(row.strategy_json, {}),
          environmentId: row.environment_id || null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null
  const suiteRunRow = (row) =>
    row
      ? {
          id: row.id,
          suiteId: row.suite_id,
          suiteName: row.suite_name || '',
          projectId: row.project_id || null,
          status: row.status,
          strategy: parse(row.strategy_json, {}),
          envId: row.env_id || null,
          envVersion: row.env_version ?? null,
          summary: parse(row.summary_json, null),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null

  /**
   * 批量追加事件。
   * M2-5：事件在 RunSession 里就分配好 seq（WebSocket 与落库必须同号），
   * 这里优先采用 evt.seq；只有老调用没带 seq 时才自增兜底。event_seq 只增不减。
   */
  const appendEvents = db.transaction((executionId, events) => {
    if (!events?.length) return 0
    let seq = s.getEventSeq.get(executionId)?.event_seq || 0
    for (const evt of events) {
      const explicit = Number.isInteger(evt?.seq) && evt.seq > 0 ? evt.seq : null
      seq = explicit ?? seq + 1
      s.insertEvent.run(executionId, seq, evt.ts ?? null, evt.type ?? null, JSON.stringify(evt.payload ?? null))
    }
    s.setEventSeq.run(seq, Date.now(), executionId)
    return events.length
  })

  /** 兼容旧调用：整份覆盖（只在测试/导入整段历史时使用，不在执行热路径） */
  const replaceDetail = db.transaction((exec) => {
    const now = Date.now()
    s.saveExecutionMeta.run({
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
      envId: exec.envId ?? null,
      envVersion: exec.envVersion ?? null,
      suiteRunId: exec.suiteRunId ?? null,
      failureClass: exec.failureClass ?? null,
      failureReason: exec.failureReason ?? null,
      createdAt: now,
      updatedAt: now,
    })
    s.saveExecutionContext.run(
      JSON.stringify({
        nodes: exec.nodes || [],
        edges: exec.edges || [],
        vars: exec.vars || {},
        environment: exec.environment || null,
      }),
      now,
      exec.id
    )
    s.deleteSteps.run(exec.id)
    s.deleteEvents.run(exec.id)
    s.setEventSeq.run(0, now, exec.id)
    ;(exec.steps || []).forEach((step, i) => {
      const { seq: stepSeq, ...data } = step
      s.upsertStep.run({
        executionId: exec.id,
        seq: stepSeq ?? i + 1,
        nodeId: step.nodeId ?? null,
        status: step.status ?? null,
        dataJson: JSON.stringify(data),
      })
    })
    appendEvents(exec.id, exec.events || [])
  })

  const store = {
    // ---------- 流程 ----------
    listFlows() {
      return s.listFlows.all().map(flowRow)
    },
    getFlow(id) {
      return flowRow(s.getFlow.get(id))
    },
    saveFlow(flow) {
      if (!flow.id) flow.id = crypto.randomUUID()
      const now = Date.now()
      flow.updatedAt = now
      if (!s.getFlow.get(flow.id)) flow.createdAt = now
      s.saveFlow.run({
        id: flow.id,
        projectId: flow.projectId ?? null,
        name: flow.name ?? null,
        type: flow.type ?? null,
        business: flow.business ?? null,
        graphJson: JSON.stringify(flow),
        createdAt: flow.createdAt ?? now,
        updatedAt: now,
      })
      return flow
    },
    deleteFlow(id) {
      s.deleteFlow.run(id)
    },

    // ---------- 执行记录 ----------
    listExecutions() {
      return s.listExecutions.all().map(executionRow)
    },
    saveExecutionMeta(meta) {
      const now = Date.now()
      s.saveExecutionMeta.run({
        id: meta.id,
        flowId: meta.flowId ?? null,
        flowName: meta.flowName ?? null,
        flowType: meta.flowType ?? null,
        projectId: meta.projectId ?? null,
        business: meta.business ?? null,
        status: meta.status ?? null,
        startedAt: meta.startedAt ?? null,
        finishedAt: meta.finishedAt ?? null,
        summaryJson: meta.summary ? JSON.stringify(meta.summary) : null,
        envId: meta.envId ?? null,
        envVersion: meta.envVersion ?? null,
        suiteRunId: meta.suiteRunId ?? null,
        failureClass: meta.failureClass ?? null,
        failureReason: meta.failureReason ?? null,
        createdAt: now,
        updatedAt: now,
      })
    },
    saveExecutionDetail(exec) {
      replaceDetail(exec)
    },
    /** 执行上下文（nodes/edges/vars/环境快照）每次执行只写一次，避免每节点重写 */
    saveExecutionContext(executionId, context) {
      return s.saveExecutionContext.run(
        JSON.stringify({
          nodes: context?.nodes || [],
          edges: context?.edges || [],
          vars: context?.vars || {},
          environment: context?.environment || null,
        }),
        Date.now(),
        executionId
      ).changes
    },
    /** 节点开始 / 状态变化 / 结束都只写自己这一行（UPSERT by seq） */
    saveExecutionStep(executionId, step) {
      if (!Number.isInteger(step?.seq) || step.seq <= 0) throw new Error('saveExecutionStep 需要正整数 seq')
      const { seq, ...data } = step
      s.upsertStep.run({
        executionId,
        seq,
        nodeId: step.nodeId ?? null,
        status: step.status ?? null,
        dataJson: JSON.stringify(data),
      })
      return seq
    },
    /** 事件批量提交；seq 自增，天然支持断线重放（M2-5） */
    appendExecutionEvents(executionId, events) {
      return appendEvents(executionId, events)
    },
    /** M2-5：当前事件游标（新建会话时从库里续上，避免重启后 seq 归零） */
    getEventSeq(executionId) {
      return s.getEventSeq.get(executionId)?.event_seq ?? 0
    },
    /** M2-5：保存会话恢复快照（节点边界时调用，每次覆盖） */
    saveExecutionResume(executionId, resume) {
      s.saveResume.run(JSON.stringify(resume ?? null), Date.now(), executionId)
      return resume
    },
    /** M2-5：读取恢复快照 + 事件游标（重建会话用） */
    getExecutionResume(id) {
      const row = s.getExecutionRow.get(id)
      if (!row) return null
      return {
        resume: parse(row.resume_json, null),
        lastSeq: row.event_seq ?? 0,
      }
    },
    /** M2-5：断线重放 —— after 之后的事件（含 lastSeq，供前端判断是否有缺口） */
    listExecutionEvents(id, { after = 0, limit = 1000 } = {}) {
      const row = s.getExecutionRow.get(id)
      if (!row) return null
      const safeAfter = Number.isInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0
      const safeLimit = Math.min(Math.max(Number.isInteger(Number(limit)) ? Number(limit) : 1000, 1), 5000)
      const events = s.listEventsAfter.all(id, safeAfter, safeLimit).map((r) => ({
        v: 2,
        executionId: id,
        seq: r.seq,
        ts: r.ts,
        type: r.type,
        payload: parse(r.payload_json, null),
      }))
      return { id, lastSeq: row.event_seq ?? 0, events }
    },
    /** M2-5：进程重启后需要重建会话的执行（meta 行；明细由调用方逐条取） */
    listUnfinishedExecutions() {
      return s.listUnfinishedExecutions.all().map(executionRow)
    },
    /** M2-5：进程重启后仍非终态的套件运行（收敛为 stopped，子执行单独恢复） */
    listUnfinishedSuiteRuns() {
      return s.listUnfinishedSuiteRuns.all().map(suiteRunRow)
    },

    // ---------- 覆盖率快照（M3-1） ----------
    /**
     * 保存一个节点的覆盖率原始证据（同一 execution+node 覆盖写，重跑是新执行不覆盖历史）。
     * @param {{executionId:string,nodeId:string,source?:string,mode?:string,status?:string,
     *          execBlob?:Buffer|null,error?:string|null}} input
     */
    saveCoverage(input) {
      const { executionId, nodeId } = input
      const id = s.getCoverageId.get(executionId, nodeId)?.id || crypto.randomUUID()
      s.upsertCoverage.run({
        id,
        executionId,
        nodeId,
        source: input.source || 'jacoco',
        mode: input.mode || 'per-node',
        status: input.status || 'captured',
        execBlob: input.execBlob || null,
        resultJson: input.result ? JSON.stringify(input.result) : null,
        error: input.error || null,
        capturedAt: input.capturedAt || Date.now(),
        analyzedAt: input.analyzedAt || null,
      })
      return coverageRow(s.getCoverage.get(id), { withBlob: true })
    },
    /** M3-1：执行是否存在（覆盖率路由的 404 判定，避免为一次校验读整份详情） */
    hasExecution(id) {
      return Boolean(s.getExecutionRow.get(id))
    },
    /** M3-1：执行的全部覆盖率快照投影（不含原始 blob，只给 bytes） */
    listExecutionCoverage(executionId) {
      return s.listCoverage.all(executionId).map((row) => coverageRow(row))
    },
    getCoverage(id) {
      return coverageRow(s.getCoverage.get(id), { withBlob: true })
    },
    /** M3-2：写回解析结果（原始 exec_blob 不动） */
    updateCoverageResult(id, { status = 'analyzed', result = null, error = null } = {}) {
      s.updateCoverageResult.run(status, result ? JSON.stringify(result) : null, error, Date.now(), id)
      return coverageRow(s.getCoverage.get(id), { withBlob: true })
    },
    getExecutionDetail(id) {
      const row = s.getExecutionRow.get(id)
      if (!row) return null
      const context = parse(row.context_json, null) || parse(row.detail_json, null) || {}
      const steps = s.listSteps
        .all(id)
        .map((r) => parse(r.data_json, null))
        .filter(Boolean)
      const events = s.listEvents.all(id).map((r) => ({
        // M2-5：事件信封统一带 v/seq（WS、重放接口、详情页三处同一形状）
        v: 2,
        executionId: id,
        seq: r.seq,
        type: r.type,
        payload: parse(r.payload_json, null),
        ts: r.ts,
      }))
      return {
        id: row.id,
        flowId: row.flow_id,
        flowName: row.flow_name,
        flowType: row.flow_type,
        projectId: row.project_id,
        business: row.business,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        envId: row.env_id || null,
        envVersion: row.env_version ?? null,
        suiteRunId: row.suite_run_id || null,
        failureClass: row.failure_class || null,
        failureReason: row.failure_reason || null,
        summary: parse(row.summary_json, null),
        nodes: context.nodes || [],
        edges: context.edges || [],
        steps,
        events,
        vars: context.vars || {},
        environment: context.environment || null,
      }
    },

    // ---------- 应用元数据 ----------
    getAppMeta(key) {
      const row = s.getAppMeta.get(String(key))
      return row ? row.value : null
    },
    setAppMeta(key, value) {
      s.setAppMeta.run(String(key), String(value))
      return value
    },

    // ---------- 项目 ----------
    listProjects() {
      return s.listProjects.all().map(projectRow)
    },
    /** 新增：列表页投影，避免把 3.4 MB 的 interfaces 读进内存 */
    listProjectSummaries() {
      return s.listProjectSummaries.all().map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description || '',
        codePath: row.code_path || '',
        serviceBaseUrl: row.service_base_url || '',
        apifoxProjectId: row.apifox_project_id || '',
        interfaceCount: row.interface_count || 0,
        folders: parse(row.folders_json, []),
        scan: parse(row.scan_summary_json, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    },
    getProject(id) {
      return projectRow(s.getProject.get(id))
    },
    saveProject(project) {
      if (!project.id) project.id = crypto.randomUUID()
      const now = Date.now()
      project.updatedAt = now
      if (!s.getProject.get(project.id)) project.createdAt = now
      const interfaces = project.interfaces || []
      s.saveProject.run({
        id: project.id,
        name: project.name || '未命名项目',
        description: project.description || '',
        codePath: project.codePath || '',
        serviceBaseUrl: project.serviceBaseUrl || '',
        apifoxProjectId: project.apifox?.projectId || '',
        interfaceCount: project.interfaceIds?.length || 0,
        foldersJson: JSON.stringify(foldersOf(interfaces)),
        scanSummaryJson: project.scan ? JSON.stringify(scanSummaryOf(project.scan)) : null,
        dataJson: JSON.stringify(project),
        createdAt: project.createdAt ?? now,
        updatedAt: now,
      })
      return project
    },
    deleteProject(id) {
      s.deleteProject.run(id)
    },

    // ---------- 缺陷 ----------
    listBugs() {
      return s.listBugs.all().map(bugRow)
    },
    saveBug(bug) {
      if (!bug.id) bug.id = crypto.randomUUID()
      const now = Date.now()
      bug.updatedAt = now
      if (!s.getBug.get(bug.id)) bug.createdAt = now
      s.saveBug.run({
        id: bug.id,
        projectId: bug.projectId ?? null,
        flowId: bug.flowId ?? null,
        status: bug.status ?? null,
        dataJson: JSON.stringify(bug),
        createdAt: bug.createdAt ?? now,
        updatedAt: now,
      })
      return bug
    },
    deleteBug(id) {
      s.deleteBug.run(id)
    },

    // ---------- 环境（M2-1） ----------
    listEnvironmentRows() {
      return s.listEnvironmentRows.all().map(environmentRow)
    },
    getEnvironmentRow(id) {
      return environmentRow(s.getEnvironmentRow.get(id))
    },
    saveEnvironment(env) {
      s.saveEnvironment.run({
        id: env.id,
        projectId: env.projectId ?? null,
        name: env.name,
        baseUrl: env.baseUrl || '',
        variablesJson: JSON.stringify(env.variables || {}),
        headersJson: JSON.stringify(env.headers || {}),
        settingsJson: JSON.stringify(env.settings || {}),
        version: env.version || 1,
        createdAt: env.createdAt ?? Date.now(),
        updatedAt: env.updatedAt ?? Date.now(),
      })
      return env
    },
    /** 删除环境时一并清空密钥行（SQLite 未开启外键，需要显式级联） */
    deleteEnvironment(id) {
      s.deleteSecrets.run(id)
      s.deleteEnvironmentRow.run(id)
    },
    listSecretRows(environmentId) {
      return s.listSecretRows.all(environmentId).map((row) => ({
        key: row.key,
        valueBlob: row.value_blob,
      }))
    },
    listSecretKeys(environmentId) {
      return s.listSecretKeys.all(environmentId).map((row) => row.key)
    },
    getSecretRow(environmentId, key) {
      const row = s.getSecretRow.get(environmentId, key)
      return row ? { key, valueBlob: row.value_blob } : null
    },
    saveSecretRow(environmentId, key, valueBlob) {
      s.saveSecretRow.run({ environmentId, key, valueBlob, now: Date.now() })
      return key
    },
    deleteSecretRow(environmentId, key) {
      return s.deleteSecretRow.run(environmentId, key).changes > 0
    },

    // ---------- 套件（M2-2） ----------
    listSuites() {
      return s.listSuiteRows.all().map(suiteRow)
    },
    getSuite(id) {
      return suiteRow(s.getSuiteRow.get(id))
    },
    saveSuite(suite) {
      if (!suite.id) suite.id = crypto.randomUUID()
      const now = Date.now()
      if (!s.getSuiteRow.get(suite.id)) suite.createdAt = now
      suite.updatedAt = now
      s.saveSuite.run({
        id: suite.id,
        projectId: suite.projectId ?? null,
        name: suite.name ?? '未命名套件',
        description: suite.description || '',
        flowIdsJson: JSON.stringify(suite.flowIds || []),
        strategyJson: JSON.stringify(suite.strategy || {}),
        environmentId: suite.environmentId ?? null,
        createdAt: suite.createdAt,
        updatedAt: now,
      })
      return suite
    },
    /** 删除套件定义与执行历史；流程执行记录（executions）保留，作为测试证据 */
    deleteSuite(id) {
      s.deleteSuiteRuns.run(id)
      s.deleteSuite.run(id)
    },
    listSuiteRuns({ suiteId, limit = 20 } = {}) {
      const n = Math.max(1, Math.min(Number(limit) || 20, 200))
      const rows = suiteId ? s.listSuiteRunRowsBySuite.all(suiteId, n) : s.listSuiteRunRows.all().slice(0, n)
      return rows.map(suiteRunRow)
    },
    getSuiteRun(id) {
      return suiteRunRow(s.getSuiteRunRow.get(id))
    },
    saveSuiteRun(run) {
      const now = Date.now()
      s.saveSuiteRun.run({
        id: run.id,
        suiteId: run.suiteId,
        suiteName: run.suiteName ?? null,
        projectId: run.projectId ?? null,
        status: run.status,
        strategyJson: JSON.stringify(run.strategy || {}),
        envId: run.envId ?? null,
        envVersion: run.envVersion ?? null,
        summaryJson: run.summary ? JSON.stringify(run.summary) : null,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        createdAt: run.createdAt ?? now,
        updatedAt: now,
      })
      return run
    },
    listExecutionsBySuiteRun(suiteRunId) {
      return s.listExecutionsBySuiteRun.all(suiteRunId).map(executionRow)
    },
    /** M2-3：按失败归类过滤（老数据未落库，路由层会先回填再过滤，见 routes/executions.js） */
    listExecutionsByFailureClass(failureClass) {
      return s.listExecutionsByFailureClass.all(failureClass).map(executionRow)
    },
  }

  return store
}
