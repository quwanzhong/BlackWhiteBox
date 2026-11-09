-- 001_init.sql · M1-1：JSON 文件 → SQLite（WAL）
--
-- 原则：本阶段只替换存储实现，不改上层契约（store 门面方法签名全部保留）。
-- 1) flows / projects / bugs 保留"整对象 JSON"列，保证无损还原；其余列只为查询与列表投影。
-- 2) executions 的 meta 拆成列（列表页不再读明细），明细暂存 detail_json；
--    M1-2 再把 steps / checks / events 拆成行（见 docs/02 §7.1）。

PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 流程：整图读写，不拆 nodes/edges（docs/02 §7.2）
CREATE TABLE IF NOT EXISTS flows (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  name       TEXT,
  type       TEXT,
  business   TEXT,
  graph_json TEXT NOT NULL,        -- 整条 Flow（含 id/时间戳），用于无损还原
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_project ON flows(project_id);

-- 执行记录：meta 列供列表/统计，detail_json 供详情页
CREATE TABLE IF NOT EXISTS executions (
  id           TEXT PRIMARY KEY,
  flow_id      TEXT,
  flow_name    TEXT,
  flow_type    TEXT,
  project_id   TEXT,
  business     TEXT,
  status       TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  summary_json TEXT,
  detail_json  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_flow ON executions(flow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at DESC);

-- 项目：接口快照（1737 条）只在该行内读写，不再重写整份 projects.json
CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  code_path          TEXT,
  service_base_url   TEXT,
  apifox_project_id  TEXT,
  interface_count    INTEGER NOT NULL DEFAULT 0,
  folders_json       TEXT NOT NULL DEFAULT '[]',
  scan_summary_json  TEXT,
  data_json          TEXT NOT NULL,   -- 完整项目对象（含 interfaces / scan）
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 缺陷
CREATE TABLE IF NOT EXISTS bugs (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  flow_id    TEXT,
  status     TEXT,
  data_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_bugs_flow ON bugs(flow_id);
