/**
 * 把 M1-1 留在 `executions.detail_json` 里的整份明细，展开成
 * `context_json` + `execution_steps` + `execution_events` 行。
 *
 * 幂等：只处理 context_json 为空 / 尚无步骤行的执行记录，重复调用无副作用。
 * 为什么放在 JS 而不是 002 的 SQL 里：JSON→行的展开逻辑在"升级老库"和
 * "首次从 JSON 文件迁移"两条路径上都要跑，抽成函数只维护一份。
 */
export function backfillExecutionRows(db, log = console) {
  // 需要回填的判据：有 detail_json 但 context_json 仍为空。
  // 回填在单个事务内完成，所以不存在"context 写了、步骤没写"的中间态，重复调用零开销。
  const pending = db
    .prepare('SELECT COUNT(*) AS n FROM executions WHERE detail_json IS NOT NULL AND context_json IS NULL')
    .get().n
  if (!pending) return { executions: 0, steps: 0, events: 0 }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE executions
      SET context_json = json_object(
            'nodes', json_extract(detail_json, '$.nodes'),
            'edges', json_extract(detail_json, '$.edges'),
            'vars',  json_extract(detail_json, '$.vars')
          )
      WHERE detail_json IS NOT NULL AND context_json IS NULL
    `).run()

    const steps = db.prepare(`
      INSERT OR IGNORE INTO execution_steps (execution_id, seq, node_id, status, data_json)
      SELECT e.id,
             CAST(je.key AS INTEGER) + 1,
             json_extract(je.value, '$.nodeId'),
             json_extract(je.value, '$.status'),
             je.value
      FROM executions e, json_each(e.detail_json, '$.steps') je
      WHERE e.detail_json IS NOT NULL
    `).run().changes

    const events = db.prepare(`
      INSERT OR IGNORE INTO execution_events (execution_id, seq, ts, type, payload_json)
      SELECT e.id,
             CAST(je.key AS INTEGER) + 1,
             json_extract(je.value, '$.ts'),
             json_extract(je.value, '$.type'),
             json_extract(je.value, '$.payload')
      FROM executions e, json_each(e.detail_json, '$.events') je
      WHERE e.detail_json IS NOT NULL
    `).run().changes

    db.prepare(`
      UPDATE executions
      SET event_seq = (SELECT COUNT(*) FROM execution_events ev WHERE ev.execution_id = executions.id)
      WHERE detail_json IS NOT NULL
    `).run()

    return { executions: pending, steps, events }
  })

  const result = tx()
  log?.info?.(
    `[store] 回填历史执行明细：${result.executions} 条执行 / ${result.steps} 步 / ${result.events} 事件`
  )
  return result
}
