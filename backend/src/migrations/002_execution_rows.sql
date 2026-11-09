-- 002_execution_rows.sql · M1-2：执行明细按行写入
--
-- 背景：M1-1 把 executions 汇总到一行，但 detail_json 仍要"每节点整份重写"，
--       执行中的写入成本随 steps/events 数量线性增长（D1 未清干净）。
--
-- 本迁移只建结构：
--   1) executions 增加 context_json（nodes/edges/vars，每次执行只写一次）；
--   2) 新增 execution_steps / execution_events，节点结束只 INSERT 自己那一行。
--
-- 历史 detail_json 的回填不在 SQL 里做：同样的展开逻辑在"升级老库"（openDatabase）
-- 和"首次 JSON 导入"（migrateLegacyJson）两条路径上都要跑，统一收敛到
-- infra/store/backfill.js 的 backfillExecutionRows()，只维护一份。
--
-- 设计取舍：step 的字段目前只被"整对象读取"，故用 data_json 存全量 + 少量投影列
-- （node_id/status）供筛选与统计；不按每个字段拆列，避免 M2 新增字段时反复改表。
-- 事件按 (execution_id, seq) 主键去重，支持断线重放（M2-5）。

PRAGMA user_version = 2;

ALTER TABLE executions ADD COLUMN context_json TEXT;
ALTER TABLE executions ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS execution_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,        -- 执行内顺序，从 1 开始
  node_id      TEXT,
  status       TEXT,
  data_json    TEXT NOT NULL,           -- 完整 step 对象（request/actual/checks/...）
  UNIQUE (execution_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_steps_exec ON execution_steps(execution_id, seq);
CREATE INDEX IF NOT EXISTS idx_steps_node ON execution_steps(node_id);

CREATE TABLE IF NOT EXISTS execution_events (
  execution_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,        -- 执行内严格自增，从 1 开始（docs/02 §5.1）
  ts           INTEGER,
  type         TEXT,
  payload_json TEXT,
  PRIMARY KEY (execution_id, seq)
);

